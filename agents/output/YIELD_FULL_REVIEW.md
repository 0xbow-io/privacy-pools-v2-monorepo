# Yield (#315) — Full-Feature Review (synthesis)

Six-lens review of the complete yield feature on `v2.0-features` @ `b7910a6c`: code review + coherence,
user-flow matrix, security audit, test-gap (matched to flows), SDK comprehension. Four review agents +
hand-verification of the headline findings. Per-lens reports:
`agents/output/feature-check/yield_userflows_matrix.md`, `audit/yield_full_r1.md`,
`code-review/yield_full_r1.md`, `test-gap/yield_full_r1.md`.

## Verdict

**Security-clean and coherent.** Security audit: **no Critical/High/Medium** (213 tests pass; the 3 prior
gaps H-1/L-6/M-3 confirmed resolved; ERC-4626 rounds in the vault's favor, inflation neutralized twice,
fee base is yield-only capped 20%, admin can't seize/freeze/renounce, Aave leg atomic-reverts,
`minUnderlyingOut` sized from caller intent). Code-review/coherence: PASS-WITH-MINOR (the 6 contracts + 4
factories cohere; F-1 confirmed closed). Matrix: 41 flows, core surface fully SDK-reachable, relayed
yield-withdraw genuinely wired (no stealth-style bridge gap).

## Confirmed findings (verified by hand)

| ID | Sev | Lens | Finding |
|---|---|---|---|
| **Y-1** | Med | SDK-comprehension | No SDK interactor for `PPYieldTokenZap.redeemToUnderlying`. A holder of loose ppUSDC — **notably after ragequit** — cannot one-call exit to USDC through the SDK; the only exposed loose-share exit (`encodeRedeem`) yields aUSDC. Needs a `PPYieldTokenZapInteractor` + a `zap` address in the yield deployment/config. |
| **TG-2** | Med | test-gap | The **relayer receiving side** has no Zod parse-survival test for `processorAddress`/`minUnderlyingOut` (both `.optional()` in `zEvmRelayWithdrawalRequest`). The SDK sending side has it; the relayer doesn't — removing the schema lines would strip them with no failing relayer test. |
| **C1** | Low | simplification | `PPYieldToken._pendingFees` re-implements `(delta*bps)/10_000` inline instead of delegating to the shared `FeeCalculator.calcFee` (same class as the N-2 fix). |
| **C2** | Low | coherence/drift | The relayer re-vendors the PPRouter ABI (`sdk/pprouter.abi.ts`) though the SDK value-exports `PP_ROUTER_WITHDRAW_ABI`. This drift vector is the real residual behind test-gap TG-1 (the `withdrawToUnderlying` dispatch ARGS are already asserted in `evm.chain.service.processor.spec.ts`, but against the vendored copy, not the SDK-maintained ABI). |
| **C4** | nit | coherence | Chain-agnostic `IWithdrawalRelayRequest` declares `processorAddress?` but omits `minUnderlyingOut` (present in the concrete evm request/schema/DTO/service; interface inconsistency, no wire-drop). |
| **TG-3** | Low | test | `PPRouter_BelowMinUnderlying` is only tripped by the mock unit test, never on the real Aave fork. |

## Corrected severities (Directive 0 — verified against source)

- **TG-1 (agent rated High) → actually Low residual.** `evm.chain.service.processor.spec.ts:80-108` already
  asserts the `withdrawToUnderlying` branch's `functionName`, `address`, `args[3]=minUnderlyingOut`,
  `args[1].processor`, and the default `0n`. The uncovered part is only ABI-fragment-vs-real-contract in a
  default gate — closed by **C2** (import the SDK-maintained ABI, delete the vendored copy) + a golden
  selector check.

## Accepted Low / informational (documented, not fixed)

- **L-1 (audit):** `minUnderlyingOut` is outside the proof context + relayer-strippable to 0 — **unexploitable**
  (the exit redeem is deterministic ~1:1, no AMM/oracle to sandwich). Already an `agents/deviations.md`
  deferral. Optional on-chain clamp is a future hardening.
- **L-2 (audit):** fee over-charges on the recovery leg after an Aave loss (baseline resets post-loss).
  Negligible, bad-debt-only; a high-water-mark baseline is the fix, deferred to avoid adding complexity to
  the audited fee path for a rare case.
- **L-3 (audit):** a degenerate tiny withdrawal redeeming to 0 assets reverts the whole tx — liveness only,
  funds safe, proof not consumed.
- **Y-2:** register + yield-withdraw atomic variant — the already-documented INTL-05 deferral.
- **Y-3 / Y-4:** admin ops have no SDK encoder (deliberate ops/SDK split); the relayer example config must
  enable the PPRouter processor + ppUSDC (operator responsibility).
- **C3/C5 (nits):** `PPRouter.POOL` immutable unused (BACKLOG); zap `depositUnderlying` has no non-test
  caller (the router uses `buyFixedYieldToken`).

## Fix plan

1. **Y-1** — SDK `PPYieldTokenZapInteractor` (`encodeRedeemToUnderlying`) + a `zap` address in the yield
   deployment/config, so the loose-ppShare→USDC exit (esp. post-ragequit) is SDK-reachable.
2. **C2** — relayer imports `PP_ROUTER_WITHDRAW_ABI` from the SDK, deletes the vendored `pprouter.abi.ts`
   (closes the TG-1 drift vector); + a golden selector cross-check.
3. **TG-2** — relayer Zod parse-survival + malformed-rejection test for `processorAddress`/`minUnderlyingOut`.
4. **C1** — `PPYieldToken._pendingFees` delegates to `FeeCalculator.calcFee`.
5. **C4** — add `minUnderlyingOut` to `IWithdrawalRelayRequest`.
6. **TG-3** — env-gated fork test tripping `PPRouter_BelowMinUnderlying`.
7. Document L-1/L-2/L-3 + Y-2/Y-3/Y-4 in the register.
