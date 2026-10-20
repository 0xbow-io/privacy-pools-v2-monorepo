# Security Audit — Swaps PR #333, SDK + Relayer Orchestration (off-chain half)

- **Commit:** `7a0b764e` (branch `review/swaps-333`)
- **Scope:** SDK swap pool-sessions (`PoolSessionWithdrawAndSwap`, `PoolSessionReshield`,
  `PoolSessionSwapDeposit`), `LiFiSwapQuoteProvider`, shared `RelaySwapRouting` decode, swap
  types/schemas/errors; relayer quote (`quoteSwap` / `createRelaySwapFeeCommitment`), relay
  (`relaySwap`), swap-routing ABI, EIP-712 signing/verify, schemas, contract-service wire.
  **Out of scope (separate auditor):** `RelaySwaps.sol`.
- **What I ran:** static read of all in-scope files + direct deps and design docs
  (`docs/tech-design/sdk/withdraw-and-swap.md`, `lifi-swap-quote-provider.md`). Per the task,
  I did NOT run the test suite (deps may be absent); I read code + the referenced tests' shape.
- **Method:** traced the decode-and-verify path field-by-field in every flow at both validation
  tiers (prepare-time RPC-backed / relay-time offline), then adversarially tried to defeat each
  assertion. This is an independent audit (I did not rely on prior "Finding A"/"H3" conclusions).

## Verdict

The proof-binding model is **substantially sound**. Every value-affecting routing field except
`feeRecipient` is asserted against caller intent before the calldata is bound into the proof, at
both the prepare-time and relay-time tiers; cross-chain zero-recipient invariants
(`recipient==0`, `minOutputAmount==0`, `nativeGas==0`, `fallbackAddress` required) are enforced
redundantly across the SDK (prepare + relay), the relayer zod schema, the relayer relay-time
re-decode, and on-chain; fee caps are enforced at quote time, relay time, and on-chain; the
`nativeGas` ceiling is enforced at quote time and re-capped at relay time; and the gross/net
`amount` accounting (`amountSent == amount + feeAmount`, `amountOut == amountSent`) is internally
consistent and cannot be exploited to over-withdraw.

**No Critical or High finding in the off-chain half.** I state that plainly rather than inflate
severity. The findings below are one Medium value-leak and several Low/Info hardening gaps.

---

## M-1 (Medium) — Reshield input dust routes to the relayer by default, and is unbounded

**Files:** `PoolSessionReshield.ts` L190 (`effectiveDustRecipient = dustRecipient ?? relayerInfo.address`),
L486-493 (`assertLifiBudget`), L138-143 (`estimateReshieldAmount` 1% safety buffer); design doc
`withdraw-and-swap.md` L88, L144, L164.

**Mechanism.** Reshield gets its LiFi quote via `getSwapAndDepositQuote()` (contractCalls,
**fixed output** = `totalDepositCost`), so LiFi returns whatever input `lifiQuote.fromAmount` it
needs. The contract forwards `net = amountSent − feeAmount` to the swap target and **sweeps the
leftover `net − lifiFromAmount` to `dustRecipient`** (design doc "Sweep dust to dustRecipient" /
"Partial input consumption leaves dust"). The SDK's only budget check is
`assertLifiBudget`: `lifiFromAmount <= net` — a *lower* bound only. There is **no upper bound on
`net − lifiFromAmount`**, and for reshield `dustRecipient` **defaults to the relayer** (L190; the
SDK then asserts the signed routing matches that relayer default).

**Why it leaks value.** The dust is *input token withdrawn from the user's own pool balance*.
Two compounding effects push value into it:
1. `estimateReshieldAmount` deliberately under-sizes the note by 1% (`safeMinOutput =
   estimatedMinOutput * 99n / 100n`, L138-139) so the deposit clears; that ~1%+ slack becomes
   dust, not a change note.
2. A relayer that **under-quotes `feeAmount`** raises `net` (= amount − fee) and therefore raises
   dust — shifting value from the *capped, SDK-checked* `feeAmount` (bounded by `maxRelayFee`,
   asserted `routing.feeAmount === quote.feeAmount`) into *uncapped, unchecked* dust it collects
   as `dustRecipient`. The SDK treats a lower fee as strictly good and has no invariant tying
   `net` to `lifiFromAmount`.

Contrast: withdraw-and-swap quotes LiFi with `amountType:"from", amount: netSwapAmount`
(**fixed input**, `PoolSessionWithdrawAndSwap.ts` L133-144), so `fromAmount == net` and its dust
defaults to the *user* (`recipientAddress`) — no leak. The exposure is reshield-specific.

**Failure scenario.** User reshields, doesn't override `dustRecipient`. Relayer quotes a fee well
under `maxRelayFee`. `net` inflates; LiFi still needs only `lifiFromAmount` for the target
deposit; `net − lifiFromAmount` (buffer slack + the fee the relayer "gave up") is swept to the
relayer. Repeatable, per-tx, invisible to the current SDK checks.

**Mitigations already present / caveats (per Directive 0):** the caller *can* pass an explicit
`dustRecipient` (e.g. their own source-chain address) to reclaim it; the relayer default is a
deliberate privacy choice (avoids a source-chain linkage to the user, doc L144); and magnitude
scales with over-provisioning, so a tightly-sized `amount` limits it. It is a value/privacy
tradeoff, not a proof-binding break.

**Fix.** Bound the dust in `prepareReshieldQuote`: assert `net − lifiFromAmount <= tolerance`
(reject grossly oversized `amount`), and/or surface the computed dust amount on
`PreparedReshieldQuote` so callers see what they forfeit; consider defaulting reshield
`dustRecipient` to a user-controlled sink when privacy allows. Confidence: high on the mechanism
(pending confirmation of the exact contract sweep semantics from the `RelaySwaps.sol` auditor).

---

## L-1 (Low) — LiFi echo cross-check is self-reported; no defense against a *malicious* LiFi, and cross-chain recipient is never verified

**Files:** `PoolSessionWithdrawAndSwap.ts` L427-456 / `PoolSessionReshield.ts` L501-530
(`assertSwapQuoteMatchesRequest`); `LiFiSwapQuoteProvider.ts` L221-224, L255-258
(echo fields sourced from `step.action.*`).

`assertSwapQuoteMatchesRequest` compares the request against
`step.action.fromToken/toToken/fromChainId/toChainId` — **LiFi's own echo of what it says it
routed**. It never parses the opaque `transactionData` bytes that are actually proof-bound. A
*compromised/malicious* LiFi can echo the requested tokens/chains in `step.action` while embedding
calldata that swaps to a different token or ships output to an attacker; the SDK would bind it.

Defense-in-depth by flow:
- **Same-chain:** protected independently on-chain (recipient balance-delta on `outputToken`),
  so a redirected calldata reverts atomically — the echo check is not load-bearing here.
- **Reshield:** protected by the embedded `Entrypoint.deposit()` reverting on insufficient/wrong
  output — *provided the calldata actually contains the deposit call*; a malicious LiFi that omits
  it is not caught by the SDK (calldata not parsed).
- **Cross-chain:** **not protected.** `routing.recipient == 0`; the real recipient lives *only*
  inside the un-parsed calldata `toAddress`, and there is no recipient echo field to cross-check.
  A malicious LiFi can redirect cross-chain output undetectably.

This is within the documented "trust LiFi's calldata" boundary, so I rate it Low, but the
Security-Properties table claim that "a mis-routed quote can never be committed into a ZK proof"
holds only for *accidental* mis-routing — it does not hold against an adversarial LiFi. **Fix /
doc:** state the limitation precisely, and (optional hardening) decode the LiFi calldata's
`toAddress` for cross-chain and assert it equals `recipientAddress` before hashing.

---

## L-2 (Low) — `feeRecipient` (tuple field 5 of 11) is never asserted SDK-side in any flow

**Files:** `PoolSessionWithdrawAndSwap.ts` `assertSwapRouting` L466-531;
`PoolSessionReshield.ts` `assertReshieldRouting` L540-596 (neither reads `routing.feeRecipient`).

Ten of the eleven routing fields are validated field-by-field; `feeRecipient` is the sole
omission, despite the doc's "validated field-by-field" claim and the two-tier completeness goal.
**Not user-exploitable:** `feeRecipient` only designates who receives the relayer fee the user has
already agreed to pay, and the relayer self-checks it at relay time
(`evm.relay.service.ts` L379-384: must equal the relayer's own fee address). No value impact to the
user, but it contradicts the stated invariant. **Fix:** either assert it (against a caller/relayer
expectation) or document it as intentionally relayer-owned.

---

## L-3 (Low) — Relay-time same-chain `nativeGas` is unvalidated in the hand-built path

**Files:** `PoolSessionWithdrawAndSwap.ts` L309 (`nativeGas: isCrossChain ? 0n : undefined` → skipped
same-chain), `assertSwapRouting` L510-514; `types/PoolSessionWithdrawAndSwap.ts`
`ExecuteWithdrawAndSwapRelayerParams` carries no `nativeGas`.

`relayWithdrawAndSwap` is the offline "defense-in-depth" tier for hand-built params, yet for
same-chain it passes `nativeGas: undefined`, so the signed routing's `nativeGas` is not checked
there. Bounded/contained by: `routing.feeAmount === quote.feeAmount` and `amountSent === amount +
feeAmount` are both asserted (and the fee already folds in the nativeGas reimbursement), the
relayer caps and re-caps `nativeGas`, and the native gas is delivered to the user's *own*
recipient — so there is no theft path, only that the offline tier can't independently confirm the
signed same-chain `nativeGas`. **Fix:** thread `nativeGas` into
`ExecuteWithdrawAndSwapRelayerParams` and assert it same-chain too, for tier parity.

---

## L-4 (Low / Info) — Relayer `relaySwap` does not re-check `feeAmount <= maxRelayFee` at relay time

**File:** `evm.relay.service.ts` `relaySwap` L335-423.

The batch path re-checks `feeAmount > maxRelayFee` per item (L264-268) and the swap **quote** path
checks it (`evm.quote.service.ts` L328-330), but relay-time `relaySwap` re-validates fee only via
`amountOut >= c.feeAmount` (fee doesn't consume the whole amount) — it does not re-read the
Entrypoint `maxRelayFee`. A commitment signed before `maxRelayFee` was lowered would pass the
relayer and revert only on-chain (`RelaySwaps` enforces it), wasting the relayer's own gas. **No
user-fund impact** (the user's SDK checks `maxRelayFee` at prepare time; on-chain enforces it).
Defense-in-depth gap only; add the re-check to mirror the batch/quote paths.

---

## Info / verified-safe (recorded so a human sees what was checked)

- **All 11 tuple fields bound + checked** except `feeRecipient` (L-2). `swapCalldata` byte-compared
  (`assertSwapCalldataMatches`), `swapTarget`/`approvalAddress` asserted `=== lifiQuote.transactionTo
  / approvalAddress` (prepare) and `=== params.*` (relay).
- **Cross-chain invariants** enforced at four layers: SDK prepare (L90-101, L201-211), SDK relay
  (L257-312), relayer schema (`evm.schemas.ts` superRefine L139-157), relayer relay-time re-decode
  (`evm.relay.service.ts` L393-400) — plus on-chain. A `toChainId` mismatch between prepare and
  relay fails *safe* (recipient sentinel mismatch throws), not open.
- **Fee-consumes-whole-amount guard** present even when `maxRelayFee == 0` (`assertFeeWithinBounds`
  L408-419 / L467-478: `fee >= amount` always throws; relayer `amount < feeAmount` L332-336).
- **nativeGas ceiling** enforced at quote time (`evm.quote.service.ts` L319-323) *and* re-capped at
  relay time (`evm.relay.service.ts` L406-411); cost folded into `feeAmount` so the user pre-pays.
- **Gross/net accounting**: `prepareSwapQuote` pins `amountSent === amount(gross)` (L193-197);
  `netAmount = amountSent − feeAmount`; relay pins `amountSent === amount(net) + feeAmount`;
  `amountOut = amountSent`. No over-withdraw. Reshield identical.
- **EIP-712** `RelaySwapCommitment` signs `{data, asset, expiration, amountSent}`; every
  security-critical field lives inside `data` (the routing blob) so it is signature-covered. The
  unsigned top-level `c.feeAmount`/`c.recipient` are non-authoritative (on-chain uses the decoded
  `routing.*`); a client tampering them can only fail the relayer's own sanity checks, not change
  execution. Domain binds `chainId` + `verifyingContract`.
- **Expiry units** consistent (ms): relayer `Number(new Date()) + ExpirationTime`, SDK
  `assertFeeCommitmentLive` uses `Date.now()`, relayer verify uses `Date.now() > expiration`.
- **Schema→wire**: swap quote validated by `zEvmSwapQuoteRequest` via `SwapQuoteValidationPipe`;
  relay by `zEvmRelaySwapRequest` via `SwapValidationPipe`. No `.passthrough()` — unknown keys
  stripped. All routing fields ride inside the signed `data` blob, forwarded verbatim to the chain
  call (`sdkRelaySwap` → `simulateAndWriteRelaySwap`, `value: routing.nativeGas`).
- **PoolSessionSwapDeposit** (direct, non-relayed): cross-chain unsupported; approval scoped to
  `fromAmount` (not unlimited); `assertApprovalTx` guards a tampered result object (spender must
  equal the quote's `approvalAddress`). Trusts LiFi's `transactionTo`/`approvalAddress` — inherent
  to any DEX-aggregator EOA flow (no proof to bind), acceptable.
- **Minor Info:** `zEvmSwapQuoteRequest` accepts `dustRecipient == 0` at quote time (rejected later
  by relay-time `evm.relay.service.ts` L386-388 and on-chain; SDK always sets non-zero). No impact.
