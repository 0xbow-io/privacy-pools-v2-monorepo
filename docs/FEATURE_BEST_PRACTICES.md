# New-Feature Best Practices & Audit Standard

The canonical standard a new feature is audited against by the
`feature-standards-auditor` agent (`.claude/agents/feature-standards-auditor.md`).
It is the "definition of done" for any cross-cutting change (contracts + SDK + relayer).

Each item has an **ID** the auditor cites, a **check** (how to verify), and the
**evidence** an author should be able to point to. Rules are battle-tested — most were
written after a real gap slipped through; the parenthetical notes the origin so the intent
survives.

## A. Spec alignment (before code)

- **SPEC-1 — Classify against the spec.** Every feature is ALIGNED / CONTRADICTION /
  EXTENSION vs `docs/tech-design/` (root `CLAUDE.md` Spec Guardian). CONTRADICTION/EXTENSION
  require explicit user sign-off *before* implementation.
- **SPEC-2 — Design doc first.** An EXTENSION gets a source-of-truth design doc under
  `docs/tech-design/<package>/` with a Version History table, the invariant it relies on,
  and the exact new signatures/errors/events. Code traces back to it.
- **SPEC-3 — Reference the source of truth, not a sibling.** Cite specific
  files/functions/lines in `v2-monorepo`; never copy a pattern from a downstream port.

## B. Cross-layer completeness

- **LAYER-1 — All affected layers land together.** A user-facing capability usually spans
  contract + SDK + relayer + docs. A feature that stops at one layer is incomplete.
- **LAYER-2 — Consumer reachability (dogfood).** The feature must be reachable through the
  *public* API a real consumer uses — not just an internal class. Verify:
  - runtime exports are **value** exports, not `export type` (a `export type *` barrel makes
    a class `undefined` at runtime while still type-checking). (batch: orchestrator was
    type-only-exported → unusable.)
  - the ergonomic entry exists (e.g. a `PoolSession` method + factory wiring), mirroring the
    sibling capability (withdraw ↔ batch-withdraw).
  - prove it: `node -e "require('dist').Thing"` is a `function`, or an end-to-end test that
    imports only the public surface.
- **LAYER-3 — Post-change doc sync.** Update every doc the change invalidates and bump the
  Version History (root `CLAUDE.md` §2).
- **LAYER-4 — Enumerate ALL new runtime value exports, exhaustively.** When a feature adds
  public value symbols (classes incl. **error classes**,
  functions, consts, ABIs, schemas the consumer needs at runtime), don't spot-check the headline
  export — build the package and enumerate: for every new value symbol, assert
  `typeof require('./dist/index.cjs').X !== "undefined"`. A `export type *` barrel silently makes
  every value-and-type symbol type-only unless it is *also* value-exported. (batch: three separate
  traps in one feature — `BatchWithdrawOrchestrator`, then `PAYOUT_ROUTING_ABI`/`_ARRAY_ABI`, then
  all six `BatchWithdraw` error classes — each found only when the next consumer hit an
  `instanceof … is not callable` at runtime. Surfaced by `agents/output/audit/AUDIT_batch_full.md` GAP-1.)
  (cross-chain swap: `NativeDestinationDepositUnsupported` shipped type-only, so a frontend's
  `instanceof` was always false and evm-sdk's `.rejects.toThrow(X)` assertions passed on any
  error, `X` being `undefined`. Error classes now have an exhaustive guard: core-sdk's
  `publicBarrel.test.ts` fails on any class under `src/errors/` that is not a runtime export.)

## C. Testing (the bar, per `CLAUDE.md` + `docs/TESTING_GUIDE.md`)

- **TEST-1 — Unit coverage per function:** happy path, one test per error/revert, access
  control, boundaries (0, 1, MAX-1, MAX). Verb-first `it()` names (SDK convention §6).
- **TEST-2 — Real-proof integration.** Anything touching proofs/circuits has a test with
  **real** Groth16 proofs on-chain (Foundry integration / artifact-gated SDK test), not just
  mocks. (batch: `BatchTransact.t.sol` proved the shared-snapshot-root claim.)
- **TEST-3 — Full-stack e2e.** A relayer/SDK feature has an e2e through the running stack
  (SDK → relayer HTTP → chain), asserting real balances. If it can't run locally, say so
  explicitly and confirm it runs in the CI harness — never claim an unobserved pass.
- **TEST-4 — Tests must exercise production units.** Fixtures must match production
  encodings/units. A test that passes because *both* it and the guard share a wrong unit is
  a false negative. (batch: expiry fixtures used seconds while the relayer emits ms → the
  guard was a live no-op yet tests were green.)
- **TEST-5 — No silent caps / skips.** If a suite skips or bounds coverage, it is logged and
  justified, not hidden.
- **TEST-6 — Cover the validation function, not just the primitive it calls.** A green test over a
  shared crypto/encoding primitive (EIP-712 sign/verify, ABI round-trip) does NOT count as coverage
  of the endpoint/service function that *calls* it and layers the business guards (per-item +
  aggregate caps, cross-item consistency, Σ-equals-committed, length bounds). Each such guard needs
  its own negative unit test at the service layer. Evidence: a `…batchWithdrawal` service spec with
  one failing case per guard. (batch: `evm.chain.service.batch.spec` passed while
  `EvmRelayService.batchWithdrawal`'s entire cap/consistency loop had zero unit coverage — surfaced
  by the standards audit, `agents/output/audit/AUDIT_batch_standards.md` GAP-1.)

- **TEST-7 — No mock-only coverage.** Every behavior validated against a **mocked dependency**
  (Foundry `vm.mockCall`/`MockX` for verifier/keystore/pool/Aave; SDK `vi.fn()` fake core/interactors/
  relayer-HTTP; relayer `jest.fn()` fake SDK/chain/config) must ALSO be exercised by a **real**
  (non-mocked) test of the same path — a fork/integration test against the real dependency, an
  artifact-gated real-Groth16 test, a docker/anvil e2e, or (for a pure library) a real value/round-trip
  test. A behavior tested ONLY through a mock is a GAP regardless of unit count: it hides the class a
  mock silently gets wrong — a drifted ABI/selector, a real revert the mock can't reproduce, an
  allowlist/consistency check whose real matching logic never runs, real Aave index rounding a 1:1 mock
  can't produce, or a session method the mocked unit drives but the e2e hand-rolls (so the method never
  runs for real). Run the **no-mock-only sweep** (list every mocked dependency and check that each mocked behavior also has a real test) every loop. Evidence: a
  dedicated mock/real sweep found High-severity gaps every other lens missed — `prepareYieldWithdraw{,
  Relay}` had zero real-proof cover (the e2e hand-rolled them), `isAllowedProcessor`'s matching logic
  was untested, `relayBatch` at MAX_BATCH=10 never ran against a real root buffer, and
  `registerAndRelay`'s atomic-abort was mock-only — all since given real tests.

## D. Correctness & no-drift

- **DRIFT-1 — Single-source shared constants.** A value used on two sides (e.g. `MAX_BATCH`
  in contract + SDK + relayer) has one source; others import it. Where a compile-time
  constant mirrors on-chain state, add a runtime cross-check (SDK `MAX_BATCH ===
  relay.MAX_BATCH()`), and expose the getter that makes it possible.
- **DRIFT-2 — One computation, one order.** If two components must derive the same value
  (e.g. a fee split, a selection order), compute it once and pass it through, or share a
  deterministic pure function — don't re-derive across an async boundary (TOCTOU).
- **DRIFT-3 — Refactors are behavior-preserving.** When extracting shared logic from audited
  code, prove branch-by-branch equivalence and keep the original tests green.

## E. Security invariants (the adversarial pass)

- **SEC-1 — Cryptographic binding holds.** Any value the prover commits to (proof `context`)
  must be reconstructed identically by every consumer, or the tx hard-reverts. The relayer
  rebuilds params from its **own signed** data, never from unauthenticated client input.
- **SEC-2 — Value conservation & no trapped funds.** Aggregate accounting balances exactly
  (Σin = Σout); no dust left in intermediary contracts; no under/overflow; native and ERC-20
  branches both checked.
- **SEC-3 — Caps enforced per-item AND in aggregate.** Per-item limits (e.g. `fee ≤
  maxRelayFee`, `fee ≤ amountOut`) apply to *every* item incl. index 0; aggregate ceilings
  where a loop could multiply exposure.
- **SEC-4 — Replay / expiry / domain separation.** EIP-712 commitments bind chainId +
  `verifyingContract`; expiry enforced consistently in the correct unit on both sides.
- **SEC-5 — Bounded work before auth / DoS.** Array/loop inputs are length-capped (`.max`)
  and heavy work is bounded before signature/authorization checks.
- **SEC-6 — Reentrancy & atomicity.** Loops over external calls preserve the single-call
  guard's guarantees; partial execution can't strand funds; one failing item reverts cleanly.

## F. Conventions (per package `CLAUDE.md`)

- **CONV-1 — Contracts:** single-line `///` NatSpec in tag order, contract-prefixed custom
  errors + `require`, structs in interfaces, section headers, naming table.
- **CONV-2 — SDK:** all imports via `internal.js` (document any deliberate exception in-code),
  public-above-private method order, DI via one config object, `Hex` at boundaries, JSDoc
  2-layer (`@inheritdoc` + specific `@throws`; interface uses base error).
- **CONV-3 — Relayer:** mirror the single-flow patterns (validation pipe → zod schema →
  service → chain service); reuse SDK helpers rather than reimplementing wire/hash/fee logic.

## G. Honesty (Directive 0 — overrides all)

- **HON-1 — No unverified claims.** Report what was actually run and observed. Distinguish
  "authored" from "passing". Name what was skipped and why. A finding asserted as a bug must
  trace the exact code path.
