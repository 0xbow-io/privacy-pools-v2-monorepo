# Yield Feature — Full Adversarial Security Audit (r1)

**Commit (HEAD at audit):** `b7910a6cffbfddd2f3594c7203ec0686cb3cea1c`
**Branch:** `v2.0-features`  **Date:** 2026-07-10
**Package:** `packages/contracts` (Foundry, forge 1.4.1) + `packages/sdk` + relayer (`relay/evm`)
**Prior audit built on:** `agents/output/audit/contracts_r1.md` (HEAD `71858e7`) — its yield conclusions re-verified below on current HEAD.

## Scope
Contracts: `PPYieldToken`, `PPYieldTokenZap`, `PPYieldTokenFactory`, `PPYieldTokenZapFactory`, `PPRouter`, `PPRouterFactory` + interfaces + `abstracts/FeeCalculator.sol`. SDK: `PoolSessionYield{Deposit,Withdraw}`, `payoutRoutingGuard`, `PPRouterInteractor`/`PPYieldTokenInteractor`, relayer yield routing (`withdrawToUnderlying`, `minUnderlyingOut`, `isAllowedProcessor`).

## What I ran
- Read all 6 in-scope contracts + interfaces + `FeeCalculator` in full; traced every value-moving path.
- `forge test --match-contract "PPYieldToken|PPYieldTokenZap|PPRouter|PPYieldTokenFactory|InvariantYield|PPUSDCYieldMock"` → **213 passed, 0 failed** (14 suites; excludes the RPC-gated fork suite).
- Delegated the SDK/relayer surface to a focused sub-audit (traced `PoolSessionYieldWithdraw` → `RelayerInteractor` → relayer `evm.relay.service`/`evm.chain.service` → on-chain `PPRouter.withdrawToUnderlying`).
- Re-verified the prior audit's H-1 / L-6 / M-3 on current HEAD (git diff + import graph + deploy scripts).

## VERDICT: NO CRITICAL / HIGH / MEDIUM FINDINGS.
The yield accounting is sound; the ERC-4626 core rounds in the vault's favor everywhere, the inflation attack is neutralized twice over (10^12 decimals offset **and** a factory dead-share seed), the zap's balance-delta accounting (C-7) defeats donation griefing, and the router's fund routing is proof-context-bound so a relayer cannot redirect or skim. Three prior gaps are now **RESOLVED / addressed** on this HEAD (see below). Residual items are all **Low / informational**.

---

## RE-VERIFICATION OF PRIOR (contracts_r1.md) YIELD FINDINGS ON HEAD b7910a6

| Prior | Status on HEAD | Evidence |
|---|---|---|
| **H-1** yield real-proof integration tests exercise VENDORED forks, not `src/` (zero E2E coverage of deployed source) | **RESOLVED** | The vendored `test/integration/helpers/ppusdc/{PPRouter,PPYieldToken,PPYieldTokenZap}.sol` copies are deleted; only `MockAavePool.sol` (a mock of the *external* Aave dependency) remains. `PPUSDCYieldMock.t.sol:16-18` now imports the real `contracts/PPRouter.sol`, `contracts/PPYieldToken.sol`, `contracts/PPYieldTokenZap.sol`. Correct posture: mock the external protocol, exercise the deployed source. |
| **L-6** `DeployYieldFork` deploys `PPYieldToken` directly, bypassing the factory dead-share seed | **RESOLVED** | `DeployYieldFork.s.sol:40-43` now `new PPYieldTokenFactory(...)` + `factory.createWrapper(...)` (seeded). Direct `new PPYieldToken` remains only in `DeployLocalYield.s.sol` (throwaway local mock harness — accepted, unchanged). |
| **M-3** no invariant/fuzz handler coverage for the yield path | **ADDRESSED** | `test/invariant/InvariantYield.t.sol` defines 5 fund-conservation invariants (YIELD-1 backing ≥ redeemable, YIELD-2 zap statelessness with an `assertEq` that catches the C-7 sweep mutation, YIELD-3 no-free-value, YIELD-4 dead-shares locked, YIELD-5 share conservation) driven by a real `HandlerYield` with `zapDeposit`/`buyFixedYieldToken`/`zapRedeem`/`donateAToken` actions — a non-mock adversarial handler including a donation actor. |
| **L-4** trusted-owner surface (fee cap, rescue scope, rewardsController, totalAssets clamp) | **Re-confirmed benign** | See admin-surface analysis below. Unchanged. |
| **L-5 / INTL-04** `PPYieldTokenZap` no reentrancy guard | **Re-confirmed accepted risk** | Zap is genuinely stateless (all amounts via in-call `balanceOf` deltas); deployed only over hook-free (USDC, Aave aToken) pairs; downstream `PPYieldToken` is itself `ReentrancyGuardTransient`; `PPRouter` is `nonReentrant`. No re-entry path found. |

---

## POSITIVE VERIFICATIONS (attack surface worked through — confirmed NOT findings)

### ERC-4626 share accounting (`PPYieldToken`)
- **First-depositor / share inflation:** neutralized twice. `_decimalsOffset = 18 − assetDecimals` = **12** for USDC → 10^12 virtual shares makes inflation require an attacker to donate `> V·10^12` underlying to grief a victim depositing `V` (economically infeasible) *independently* of the seed; the factory additionally seeds `_DEAD` with the full post-supply aToken balance (`PPYieldTokenFactory.sol:91-96`). Direct `new PPYieldToken(...)` is possible (public constructor) and the factories do **not** validate that a vault came from `PPYieldTokenFactory` — but wiring a zap/router over an unseeded vault is `onlyOwner` self-harm, and the offset alone defeats the attack. Informational only.
- **Rounding direction:** inherited OZ ERC4626 rounds every conversion in the vault's favor (deposit→shares floor, mint→assets ceil, withdraw→shares ceil, redeem→assets floor). No override changes this. `_deposit`/`_withdraw` add a `_shares != 0` / `_assets != 0` dust guard so a round-to-zero op reverts rather than minting/burning for free.
- **Fee never touches principal:** `_pendingFees` charges `feeBps` of `(balance − lastCheckpointBalance)` only when balance rose (`PPYieldToken.sol:282-286`); principal is captured into `lastCheckpointBalance` at deposit time (`:254`), so the fee base is strictly yield + donations. `MAX_FEE_BPS = 2000` (20%) hard cap at construction and in `setFeeBps`.
- **Checkpoint does not shift `totalAssets`:** `totalAssets()` already subtracts `_currentFees = accumulatedFees + pendingFees` (`:216-220`), so moving pending→accumulated inside `_checkpoint()` leaves the conversion base unchanged. The transient double-count window between `_checkpoint()` and the caller's `lastCheckpointBalance =` write is unobservable (`nonReentrant` + hook-free aToken). Verified across `_deposit`, `_withdraw`, `claimFees`, `setFeeBps` with worked numeric traces.
- **Donation via `balanceOf`:** a direct aToken donation is treated as yield (fee taken on it, remainder lifts the rate for existing holders) — a gift to the vault, never a theft. Offset + seed prevent it being weaponized against a first depositor.

### `PPYieldTokenZap` (C-7 balance-delta)
- All three entrypoints credit only the **delta** their own Aave/vault call produced (`_aReceived = balanceOf(after) − balanceOf(before)`), never the absolute balance, so a pre-donated aToken/share balance can neither be swept into a caller's credit nor satisfy the `buyFixedYieldToken` wrap check (`PPYieldTokenZap.sol:78-80,104-106,128-130`). Donations are inertly stranded (donor loses; no rescue path — permanent self-grief only). Confirmed by `test_*_IgnoresDonatedATokens_NoGriefing` (3 passing) + invariant YIELD-2.
- **`buyFixedYieldToken` exactness:** `_aNeeded = previewMint(_shares)` and OZ `mint` re-reads `previewMint(_shares)` in the same tx over unchanged vault state, so the approval (`_aNeeded`) exactly covers what `mint` pulls; the 2-wei `_SUPPLY_ROUNDING_BUFFER` absorbs Aave's scaled-balance round-trip and is the only value forfeited per exact mint (forwarded dust returned to receiver).

### Aave integration
- **Supply cap (error 51) / any Aave revert:** propagates → whole tx reverts atomically → funds safe (liveness-only). Router/zap correctly do not swallow it.
- **`rewardsController` (owner-settable external call):** reachable only via `claimRewards`, which is `onlyOwner nonReentrant`; by Aave semantics `claimAllRewards` can move only reward tokens the vault accrued — never its aUSDC/ppUSDC — and executes in the controller's own context (the vault grants it no approval). A malicious controller cannot re-enter any `nonReentrant` fn (OZ's guard is contract-wide). Trusted-admin risk only.
- **Reentrancy from the Aave leg:** none — aTokens and USDC have no transfer hooks (the factories restrict wrapping to one trusted pool's aTokens), and every stateful entrypoint is `nonReentrant`.
- **aToken rebasing vs the non-rebasing wrapper:** the wrapper reads the live `asset.balanceOf(this)` (never stored) so rebasing is reflected in `totalAssets`; the fee mechanism captures the appreciation. `withdraw(asset, _aReceived, to)` passes the aToken delta (1:1 with underlying via index) as the underlying amount — correct.

### `PPRouter`
- **`withdrawToUnderlying`:** `tokenIdOut == VAULT`, `processor == this`, `recipient != 0`, `msg.value == nativeGas`, `feeAmount <= maxRelayFee`, `sharesOut >= feeAmount` all enforced (`PPRouter.sol:166-179`); the `PayoutRouting` (recipient / feeRecipient / feeAmount / nativeGas) is decoded from `_transactParams.data`, which is bound into the proof `context`, so a submitting relayer cannot tamper with any of it. `sendValue` to the recipient is the final action (CEI) and the fn is `nonReentrant`.
- **Dust-fee waiver ordering is revert-safe:** the fee leg redeems *after* the recipient leg; a redeem strictly preserves-or-raises the exchange rate (vault-favor rounding), so `previewRedeem(feeAmount) != 0` checked up front (`:187`) still holds at the later fee redeem — no round-to-zero revert can be induced by the intervening recipient redeem. Verified analytically.
- **`_fee`/`FeeCalculator`:** both floor `value*bps/10_000`; `_quote`'s `_total = value + fee` equals exactly what `ENTRYPOINT.deposit` pulls (single-source quote drives both `quote` and `depositExactShares`, so quoted == executed).

### Admin / trust surface
- Admin **cannot seize principal** (fee base is yield-only, capped 20%; `rescueToken` reverts on `asset()` so backing is untouchable — `PPYieldToken.sol:149`), **cannot freeze redemptions** (`pause` gates only `deposit`/`mint` via `maxDeposit`/`maxMint → 0`; `withdraw`/`redeem`/`claimFees` are never pausable — ragequit/exit always open), and **cannot renounce** (`renounceOwnership` reverts `PPYieldToken_RenounceDisabled`). Role handoff is 2-step (`Ownable2Step`).

### SDK / relayer (delegated sub-audit — full trace)
- **`minUnderlyingOut` is sized from caller intent, not a relayer field:** `PoolSessionYieldWithdraw` computes it from the owner's own `quoteWithdraw(recipientShares) × (1 − slippageBps)`, explicitly **not** from the relayer's unverified `signedFeeCommitment.amountReceived`. (See L-1 for the residual.)
- **Processor is doubly gated:** relayer config allowlist (`allowed_processors`) **and** the on-chain `processor == address(this)` bound in the proof context. An attacker cannot register a processor (deploy-time config) nor substitute one (invalidates the proof).
- **No relayer-authoritative value:** the relayer verifies the EIP-712 commitment, `asset == proofAsset`, `proofAmountOut == amountSent`, `amountOut >= feeAmount`; `amountReceived` is recomputed, never trusted. `payoutRoutingGuard` validates recipient/feeAmount/nativeGas against the exact `data` that becomes the proof-bound `transactParams.data`; `feeRecipient` is intentionally unchecked (relayer's own destination, cannot harm the user). No `.passthrough()` request-schema leak.
- **No relayed yield-deposit path exists** — deposits are self-submitted with a locally-sized `maxUnderlyingIn` cap, so there is no relayer trust surface on the way in.

---

## RESIDUAL FINDINGS (all Low / informational)

### LOW

**L-1 — `minUnderlyingOut` lives outside the proof context, so the submitting relayer can strip it to 0.**
`PPRouter.withdrawToUnderlying`'s `_minUnderlyingOut` is a plain calldata arg (`PPRouter.sol:160,203`), unlike recipient/fee/nativeGas which are context-bound. The relayer's service defaults a missing value to `0` and can override the client's value. **Why Low, not Medium:** the exit redeem is `pp-share → aToken → underlying`, all deterministic and ~1:1 with **no AMM / oracle** in the path, so there is no sandwich/price-manipulation vector to exploit a stripped floor — a relayer stripping it yields no profit. It becomes exploitable only if the yield backend ever gains AMM-priced redemption. **Fix (defense-in-depth):** clamp on-chain to `quoteWithdraw(recipientShares) × (1 − maxSlippage)`, or bind the floor into the proof context. (Matches the prior `minUnderlyingOut = 0` deferral in `deviations.md`.) Confidence: high.

**L-2 — Fee over-charges on the recovery leg after an Aave loss event.** `PPYieldToken.sol:282-286`.
If Aave suffers a balance decrease (bad debt) and a checkpoint (any deposit/withdraw/claim/setFeeBps) resets `lastCheckpointBalance` to the post-loss low, the subsequent recovery back toward the prior high is treated as fresh "yield" and charged `feeBps` — even though it is merely recouping a loss holders already bore. **Impact:** the admin collects fee on the recovery; economically negligible and confined to an extraordinary Aave-loss scenario (holders are already impaired). Not a principal-seizure vector in normal operation. **Fix (optional):** high-water-mark the fee baseline (only charge above the all-time-high balance). Confidence: medium (scenario is real; severity is low).

**L-3 — A degenerate tiny withdrawal whose recipient leg redeems to 0 assets reverts the whole withdrawal.** `PPRouter.sol:199-201` → `PPYieldToken._withdraw` `require(_assets != 0)`.
The router waives a *dust fee* but not a dust *recipient* leg; if `_recipientShares` rounds to 0 underlying, `ZAP.redeemToUnderlying` reverts and the entire `withdrawToUnderlying` reverts. **Impact:** liveness only, and only for a nonsensically small withdrawal a note owner would never create; funds are safe (atomic revert, nullifiers not consumed, proof re-usable). No fix required. Confidence: high.

### INFORMATIONAL
- **Direct-deploy provenance.** `PPYieldToken`'s constructor is public and neither `PPYieldTokenZapFactory` nor `PPRouterFactory` validates that the supplied `_vault` originated from `PPYieldTokenFactory` (they check only `aToken.POOL() == POOL`). Wiring a zap/router over an unseeded vault is `onlyOwner` self-harm and the 10^12 offset neutralizes inflation regardless, so this is not exploitable — but a `wrapperFor[aToken] == _vault` cross-check would make the seed invariant enforceable rather than conventional.
- **`DeployLocalYield.s.sol`** still deploys `PPYieldToken` directly and imports `test/` mocks — by design (local mock-Aave harness), unchanged and accepted.

---

## Honesty note (Directive 0)
Everything marked RESOLVED / passing was verified on HEAD `b7910a6` (git import graph, deploy-script source, and a green `forge test` run of 213 yield tests — the RPC-gated fork suite was **not** run here and is excluded from that count). No source files were modified (read-only audit). The three Low findings are genuine residuals, not restatements of fixed items; I could not construct a concrete fund-loss exploit for any of them, which is why none is rated Medium+.
