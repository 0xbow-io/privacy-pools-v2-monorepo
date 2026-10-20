# Phase 0 — Build & Test-Selection Findings

**Commit audited:** `d91112f2` (v2.0 HEAD) → fixed on `audit/v2.0-features`.
**Date:** 2026-07-08. **Verdict:** NOT-DONE as merged → **fixed** (see commit `727cf5ae`).
**What I ran:** `forge build`; `forge test --match-contract BatchTransactIntegration -vv`
(archive fork RPC); `forge test --match-contract 'PPUSDCRouterWithdraw.*Integration|IntegrationPPYieldToken'`;
`forge test --match-contract UnitPPRouter`.

## F-0.1 — Batch & yield real-proof integration tests did not compile (CRITICAL, process/correctness)
`test/integration/BatchTransact.t.sol`, `PPUSDCYieldMock.t.sol`, `PPUSDCYieldFork.t.sol` **never
compiled against base `72886c12` as merged**. `forge build` failed on all three. Causes:
1. Imported shared helpers from `./helpers/…` (i.e. `test/integration/helpers/…`) which were moved
   to `test/helpers/…` in `32f22e9f`. → repointed to `test/helpers/…` (the path every working
   integration test uses).
2. Referenced harness symbols absent on this base: `_defaultDepositContext` (no such var — deposit
   context is an inline `keccak(abi.encode(noteData)) % SNARK_SCALAR_FIELD` everywhere else),
   `_verifyTransactPostconditions(...)` (no such fn — mapped to `_assertProofWasSpent` + an inlined
   state-root equality copied verbatim from `_submitTransact`), a `_buildTransactProof(...)` call
   with nonexistent `_params:`/`_payload:` named args, and a 1-arg `_registerInASP(note)` (real
   signature is 2-arg `(Note, uint256 metadata)`). → each mapped to the real helper, no assertion
   weakened.

**Impact.** The `AUDIT_batch_full.md` / `AUDIT_yield.md` reports both reached **DONE-WITH-GAPS**
citing these as the feature's real-proof coverage. They could not have been passing — they did not
build. This is exactly the *authored ≠ passing* gap the standard's HON-1 exists to catch, and it
slipped through. Any future "green suite" claim must be backed by a fresh `forge build` + run.

**After fix (verified):** `BatchTransactIntegration` 3/3 real Groth16 (ERC20 multi-note, ETH,
single-item); yield integration 24 pass; `forge build` exits 0.

## F-0.2 — 42 PPRouter unit tests excluded from CI (HIGH, test-selection)
`test/unit/PPRouter.t.sol` test contracts were `PPRouterDepositTest` / `PPRouterWithdrawTest` /
`PPRouterFactoryTest` — no `Unit` prefix, so `pnpm test:unit` (`--match-contract Unit`) never ran
them. 42 tests silently uncovered in CI. → renamed `UnitPPRouter{Deposit,Withdraw,Factory}`.
Verified 42/42 pass once selected.

## F-0.3 — 4 yield router integration tests excluded from CI (HIGH, test-selection)
`PPUSDCRouterWithdraw{Conservation,Yield}Test` and `PPUSDCForkRouterWithdraw{Conservation,Yield}Test`
lacked `Integration`, so `pnpm test:integration` (`--match-contract Integration`) skipped them.
→ renamed `…Integration`. (These still test *vendored copies* under `test/integration/helpers/ppusdc/`,
not `src/` — tracked separately as a Phase 2/3 finding; the selection miss is fixed here.)

## F-0.4 — 2 pre-existing Entrypoint deposit fuzz failures (MEDIUM, base — not audit-introduced)
Baseline unit run: **439 pass / 2 fail / 441 total**. Failures:
`UnitEntrypoint.test_Deposit_GivenMsgValueMatchesAmountPlusFees` and
`…test_Deposit_WhenCiphertextIsEmpty` (both fuzz, fail deterministically at `runs: 0`, with or
without the fork). **Not introduced by this audit:** `git log 72886c12..d91112f2 -- Entrypoint.sol
Entrypoint.t.sol FeeCalculator.sol` is empty — the deposit path is untouched by all four v2.0
features, and my changes never touched it. So this reproduces on base `d91112f2`.

**Root cause (from `-vvvv` trace):** the test mocks `mockPoolVault.deposit` keyed on `msg.value ==
_value` (`_mockAndExpect(mockPoolVault, _value, …)`), but `Entrypoint.deposit` recomputes the fee
from the received `msg.value` and forwards a fee-adjusted amount that diverges from the original
`_value` for large amounts (fee round-trip asymmetry: `amountPlusFees = _value + fee(_value)` but the
contract derives `_value' = msg.value − fee(msg.value)`). The forwarded value then misses the
value-keyed mock, Foundry falls through to a real call, and the codeless mock reverts
`call to non-contract address`. Local `forge 1.4.1`; CI pins `foundry-toolchain@v1 version: stable`
— fuzz input generation differs, which is the likely reason CI is green.

**Delegated:** the contract audit agent must root-cause whether this is (a) a test-harness bug
(mock the actual forwarded value / bound `_value` away from the divergence) or (b) a genuine fee
round-trip asymmetry in `Entrypoint`/`FeeCalculator`, and reconcile against CI's pinned Foundry.
Until resolved, the honest baseline is **439/441 unit**, not "all green".

## Environment note (honesty)
Mainnet-fork integration tests require an archive `MAINNET_RPC` (pinned block 25_089_274), exactly
as the repo's `integration-mainnet` CI job requires a secret. Run locally with a `.env` archive
endpoint (git-ignored). Without it these tests fail in `setUp` with
`environment variable MAINNET_RPC not found` — an env gate, not a code failure.
