# Standards Audit (Full) — Batch Withdrawal Feature

**Standard:** `docs/FEATURE_BEST_PRACTICES.md` (rules A1..G1)
**Agent:** `feature-standards-auditor`
**Feature:** "withdraw entire single-asset balance in one tx" — `relayBatch` (contract) + SDK batch orchestrator/session + relayer batch quote/relay paths.
**Scope:** branch `feat/batch-transactions` @ HEAD `f261bfe2` (includes the per-item fee rework `b005af23` and the fast quote→relay flow spec `f261bfe2`).
**Method:** read-only trace + **ran** SDK/relayer/contract suites, **built** the SDK and enumerated runtime exports, traced ABI/const single-sourcing. Supersedes the earlier-state `docs/AUDIT_batch_standards.md` (pre-rework snapshot).

---

## Verdict: DONE-WITH-GAPS

The feature is soundly built and lands across all layers with a source-of-truth design doc (now at
v0.4.0, accurately reflecting the per-item-fee rework). Contract + SDK are strongly covered (20
contract tests incl. 3 real-proof; 38 SDK batch tests), the security invariants the prior audit
traced still hold, and the quote→relay seam is genuinely closed by a real-EIP-712 in-process spec
(`evm.batch.quote-flow.spec.ts`). **No Critical/High finding.** But the audit found **the same
classes of gap the team already fixed once, recurring elsewhere**: a *second* batch of type-only
runtime-export traps (all six batch **error classes** are `undefined` at runtime), three
consumer-facing seams whose only coverage is the non-fast docker e2e (SDK-serialized batch request ↔
relayer zod schema; the SDK orchestrator's real-proof path; the relayer `assertBatchFitsRootHistory`
fail-fast), and a duplicated (not single-sourced) PayoutRouting ABI. These are reachability/test
gaps, not code defects — the shipped code paths read correct and pass what tests exist.

---

## Rule table

| Rule | Result | One-line evidence |
|------|--------|-------------------|
| SPEC-1 | PASS | Design doc marks feature **Extension**, no circuit change (`batch-withdrawal.md:3,27`). |
| SPEC-2 | PASS (Low caveat) | Source-of-truth doc w/ Version History (4 rows), shared-snapshot-root invariant §2, sigs/errors/event §3.3; SDK surface only summarized in §5 (no `docs/tech-design/sdk/` doc) — see GAP-6. |
| SPEC-3 | PASS | Doc cites `PoolVault.sol:345-347`, `RootBufferUpgradeable.sol:64-92`, `ChainConfigRegistry.sol` — real source. |
| LAYER-1 | PASS | Contract + interface + SDK + relayer + docs all in the diff. |
| LAYER-2 | **GAP (Medium)** | Primary values OK at runtime (orchestrator/session/`computeBatchFees`/`selectNotesForFullWithdraw`/`MAX_BATCH`/`PAYOUT_ROUTING_ABI` all `function`/value). But **all six batch error classes are `undefined` at runtime** — GAP-1. |
| LAYER-3 | PASS (Nit) | Design doc bumped to 0.4.0, matches shipped fee model; historical audit doc stale re `allocateBatchFee` — GAP-7. |
| TEST-1 | PASS | Contract batch unit 17 (0/1/9/10/MAX+1 boundaries now present), SDK 38, relayer 23 batch tests; guard-per-negative coverage in `evm.relay.service.batch.spec.ts`. |
| TEST-2 | PASS (Low caveat) | `BatchTransact.t.sol` 3 real-proof on-chain tests (ran: 3 passed). But the **SDK orchestrator** real-proof path is mock-only in fast suites — GAP-4. |
| TEST-3 | **GAP (Medium, unverifiable)** | `batch.e2e.ts` authored; observed passing once via fresh-local-deploy scratch harness (per `AUDIT_batch_standards.md`), **does not run in fast suites**; the SDK↔relayer wire-shape it exercises has no fast substitute — GAP-3. |
| TEST-4 | PASS | `assertFeeCommitmentLive` uses ms; quote-flow spec signs `Date.now()+…` ms expiry and the real verify path honors it. |
| TEST-5 | PASS | `MAX_BATCH` cap documented; no silent batch skips. |
| DRIFT-1 | **GAP (Low)** | `MAX_BATCH` single-sourced + runtime cross-checked (good). But PayoutRouting **ABI is duplicated** (SDK `PAYOUT_ROUTING_ABI` vs relayer `fee_abi.ts feeSplitParams`), relayer production uses its own copy, no cross-check — GAP-5. |
| DRIFT-2 | PASS | `computeBatchFees` is one shared pure fn the relayer imports (`evm.quote.service.ts:34`); selection runs once and is passed through. |
| DRIFT-3 | PASS | `_distribute` extracted from `relay`; single-relay tests stay green (24 in `PrivacyPoolRelay`). |
| SEC-1..SEC-6 | PASS | Unchanged from prior audit; relayer rebuilds `transactParams` from its own signed `PayoutRouting[]` (`evm.relay.service.ts:169-179`), per-item + aggregate caps enforced (`:158-202`), atomic batch. |
| CONV-1 | PASS | Full `///` NatSpec on `relayBatch`/`_distribute`/`MAX_BATCH`/errors/`RelayedBatch` (`PrivacyPoolRelay.sol`, `IPrivacyPoolRelay.sol`). |
| CONV-2 | PASS | 2-layer JSDoc verified: interface base-error `@throws` (`IBatchWithdrawOrchestrator.ts:25,38`), impl specific `@throws` (`PoolSession.ts:295,310`); barrel imports OK (2 documented `batch-fee` CJS exceptions). |
| CONV-3 | PASS | validation pipe → zod → service → chain.service; Swagger `@ApiOperation`/`@ApiBody`/`@ApiOkResponse` on both `/batch` endpoints (`relay.controller.ts:83-89`, `quote.controller.ts:109-115`). |
| HON-1 | PASS | This report distinguishes authored-vs-passing and names what was not run (e2e). |

---

## Findings

### GAP-1 (Medium) — All six batch error classes are type-only exports (undefined at runtime)
**Rule:** LAYER-2. **Confidence:** High — ran it.
**Location:** `packages/sdk/src/external.ts` (value-export block omits `errors/BatchWithdraw.js`); classes in `packages/sdk/src/errors/BatchWithdraw.ts`.
**Observed (ran):** built SDK, then
`node -e "const m=require('./dist/index.cjs'); [...].forEach(...)"` →
```
undefined  BatchWithdrawBaseError
undefined  EmptyBatchSelection
undefined  BatchTooLarge
undefined  InfeasibleBatchFee
undefined  BatchRoutingMismatch
undefined  BatchRoutingInvalid
```
Each is `declare class …` in `dist/index.d.ts` (lines 8296-8331) yet `undefined` in `dist/index.cjs`.
They reach the public surface only through `export type * from "./internal.js"` (`external.ts:80`),
which is types-only. This is the **exact LAYER-2 trap** already fixed twice in this feature
(`BatchWithdrawOrchestrator`, then `PAYOUT_ROUTING_ABI`/`_ARRAY_ABI` in `94ba9717`). These errors are
thrown across the public batch API (`prepareBatchWithdraw` throws `BatchTooLarge`,
`EmptyBatchSelection`, `InfeasibleBatchFee`, `BatchRoutingInvalid`), so a consumer doing
`catch (e) { if (e instanceof BatchRoutingInvalid) … }` gets `TypeError: Right-hand side of
'instanceof' is not callable`. (They still carry `.name`, so a string fallback works — hence Medium,
not High.)
**Impact:** A consumer cannot branch on batch failure types at runtime — the ergonomic catch the
feature's own error taxonomy is designed for is unusable.
**Fix (minimal):** add to `external.ts` a value export, mirroring the two families already exported:
`export { BatchWithdrawBaseError, EmptyBatchSelection, BatchTooLarge, InfeasibleBatchFee, BatchRoutingMismatch, BatchRoutingInvalid } from "./errors/BatchWithdraw.js";`
then re-run the enumeration to confirm all six are `function`.

### GAP-2 (Medium) — `assertBatchFitsRootHistory` fail-fast has zero test coverage
**Rule:** TEST-1 / DRIFT-1 (dead-assertion class). **Confidence:** High — grepped every `.spec.ts`.
**Location:** `packages/relayer/relayer/src/chain.service/evm.chain.service.ts:485-519`.
**Observed (ran):** grep across all relayer specs for `assertBatchFitsRootHistory` / `rootHistorySize`
/ `contractMaxBatch` / "Batch disabled" → **no matches**. The two reject branches — `MAX_BATCH >=
historySize` (`:498-499`) and the SDK↔contract drift cross-check `contractMaxBatch !== MAX_BATCH`
(`:516-517`) — are **never exercised**. This is the on-chain-margin / drift fail-fast the design doc
§2.1 and review QUALITY-1 rely on; the earlier audit (`AUDIT_batch_standards.md` "Concrete missing
tests" → `[Low] assertBatchFitsRootHistory`) flagged it and it was **not** added.
**Impact:** The relayer's only guard against a deploy where `MAX_BATCH ≥ rootHistorySize` (near-max
batches would revert on-chain with `PoolVault_UnknownStateRoot`) and against contract/SDK `MAX_BATCH`
drift is untested; a regression silently disabling either check would pass CI.
**Fix (specific test):** add to `evm.chain.service.batch.spec.ts` two cases mocking `readContract`:
(a) `rootHistorySize → 10` (== MAX_BATCH) asserts the batch is rejected; (b) `MAX_BATCH() → 9`
asserts the drift rejection. Also a happy case (`rootHistorySize → 16`) asserts it proceeds.

### GAP-3 (Medium, unverifiable-in-fast-suite) — No fast test parses an SDK-serialized batch request against the relayer zod schema
**Rule:** TEST-3 / LAYER-2 (consumer reachability across the wire). **Confidence:** High.
**Location:** SDK `RelayerInteractor.relayBatchWithdrawal` (`services/RelayerInteractor.ts:302-344`,
esp. the per-item proof reshape `:322-331`) and `getBatchWithdrawalQuote` (`:171-211`); relayer
`BatchWithdrawalRelayParamsSchema` / DTOs.
**Observed (ran/grepped):** `RelayerInteractor.test.ts` exists but has **no** batch cases
(grep `getBatchWithdrawalQuote|relayBatchWithdrawal|batch` → none). SDK PoolSession/orchestrator
tests **mock** `RelayerInteractor` entirely (`relayBatchWithdrawal: vi.fn(async () => "0xtx")`). The
relayer `evm.relay.service.batch.spec.ts` **hand-builds** the *post-zod* `EvmRelayBatchRequest`
shape; `evm.batch.quote-flow.spec.ts` also builds parsed objects and never invokes the zod
`.parse()` pipe. So the **byte-shape contract** between the SDK's serialized `/relay/.../batch` body
(the `{...params, items: items.map(i => ({...i, proof:{...i.proof.proof, publicSignals}}))}`
flattening) and the relayer's zod schema is exercised **only** by `batch.e2e.ts`, which does not run
in the fast suites (observed passing once via a fresh-local-deploy scratch harness, per
`AUDIT_batch_standards.md` — not reproducible here, no docker). This is precisely the seam class that
historically hid the LAYER-2 and TEST-4 bugs.
**Impact:** A drift between the SDK's request reshape and the relayer's `BatchWithdrawalRelayItemSchema`
(field name/nesting) would be caught only in e2e/production, not in CI.
**Fix (specific test):** (a) a relayer spec that imports the relayer batch relay zod schema and calls
`.parse()` on a body produced by the SDK's real serialization (or a fixture captured from it),
asserting it validates; (b) a `RelayerInteractor.test.ts` batch case with a stub `IHTTPClient`
capturing the POST body, asserting the item/proof shape and endpoint path. (Converting GAP-3 fully to
PASS still needs `batch.e2e.ts` run in CI — record the observed pass there.)

### GAP-4 (Low) — SDK orchestrator real-proof path covered only by the non-fast e2e
**Rule:** TEST-2. **Confidence:** High.
**Location:** `packages/sdk/test/unit/services/BatchWithdrawOrchestrator.test.ts`.
**Observed (ran/read):** the orchestrator test injects `prepareTransact: vi.fn(...)` — proof
generation is **mocked**. The real N-proofs-against-the-shared-snapshot-root path
(`BatchWithdrawOrchestrator.prepareBatchWithdraw` → real `Groth16Prover`) runs only in `batch.e2e.ts`
(non-fast) and, at the proof level, in the contract's `BatchTransact.t.sol` — but that generates
proofs via the Foundry `proof.service`, not the SDK orchestrator. The SDK already has an
artifact-gated real-proof pattern (`test/services/ProofService.integration.test.ts`); no batch analog
exists.
**Impact:** The claim that "N SDK-orchestrated proofs share one pre-batch snapshot root and each binds
its own `transactParams`" is not proven by any fast, SDK-level test.
**Fix (specific test):** add an artifact-gated `BatchWithdrawOrchestrator.integration.test.ts` that
runs `prepareBatchWithdraw` with the real prover over ≥2 single-label groups and asserts each proof's
`stateRoot` equals the shared snapshot and `transactParams[i].data` decodes to the expected routing —
or explicitly document (TEST-5 style) that this is e2e-only and why.

### GAP-5 (Low) — PayoutRouting ABI duplicated, not single-sourced
**Rule:** DRIFT-1. **Confidence:** High.
**Location:** SDK `constant/PoolSessionTransact.ts` (`PAYOUT_ROUTING_ABI` / `PAYOUT_ROUTING_ARRAY_ABI`)
vs relayer `relay/evm/fee_abi.ts` (`feeSplitParams` / `feeSplitArrayParams`).
**Observed (read/grepped):** the two tuple ABIs are currently **byte-identical** (same field names,
order, types), but they are **independent definitions**. The relayer's **production** code
encodes/decodes with its own `fee_abi.ts` copy (`encodeWithdrawalFeeSplit`, `decodeBatchFeeSplit`);
only `batch.e2e.ts` and `e2e/.../proof.service.ts` import the SDK's `PAYOUT_ROUTING_ABI`. No test
asserts the two encode identical bytes for the same routing. The team explicitly value-exported the
SDK ABI "needed by external consumers that decode the relayer's signed data" — yet the relayer itself
does not consume it. This mirrors `MAX_BATCH` (which *was* single-sourced + cross-checked) but the ABI
was not.
**Impact:** A future field addition/reorder to `PayoutRouting` on one side silently diverges — a
mis-encoded `transactParams.data` would surface only as an on-chain `PoolVault_ProofContextMismatch`.
**Fix (either):** relayer imports `PAYOUT_ROUTING_ABI`/`_ARRAY_ABI` from `@privacy-pools-v2/sdk` in
`fee_abi.ts`; or add a test asserting `encodeWithdrawalFeeSplit(...) === encodeAbiParameters(SDK
PAYOUT_ROUTING_ABI, ...)` for a sample routing (and the array form).

### GAP-6 (Low) — No dedicated SDK design/usage doc for the batch feature
**Rule:** SPEC-2 / LAYER-3. **Confidence:** High.
**Observed:** the source-of-truth doc is `docs/tech-design/contracts/batch-withdrawal.md`; its §5
summarizes the SDK+relayer surface, but there is **no** `docs/tech-design/sdk/` batch doc and **no**
README/usage mention of `PoolSession.prepareBatchWithdraw` / `relayBatchWithdraw` (grep across
`docs/tech-design/sdk/` and READMEs → none). Per root `CLAUDE.md` package-pairing, `packages/sdk`
pairs with `docs/tech-design/sdk/`.
**Impact:** An SDK consumer has no package-paired doc for a major new public API; they must read the
contracts doc's summary.
**Fix:** add a short `docs/tech-design/sdk/` batch-withdrawal usage note (or a cross-link from the SDK
spec index to the contracts doc) documenting the `prepareBatchWithdraw` → `relayBatchWithdraw` flow
and the error taxonomy; or record the decision that §5 is authoritative for the SDK surface.

### GAP-7 (Nit) — Superseded audit doc references retired `allocateBatchFee` as live
**Rule:** LAYER-3 (doc sync). **Confidence:** High.
**Observed:** `docs/AUDIT_batch_standards.md` cites `allocateBatchFee` as a live runtime export /
shared fn in its LAYER-2, DRIFT-2, CONV-3 rows and "What I ran" table. That symbol was **retired** to
`computeBatchFees`/`computeBatchItemFee` in `b005af23`. The **source-of-truth** design doc is correct
(only mentions `allocateBatchFee` in Version-History transition rows 0.2.0/0.4.0). `docs/REVIEW_*` and
`docs/AUDIT_batch_withdrawal.md` are pre-rework snapshots.
**Impact:** Cosmetic — a reader of the old audit sees stale symbol names.
**Fix:** add a "superseded by `docs/AUDIT_batch_full.md`" banner to `AUDIT_batch_standards.md` (this
report is that supersession).

---

## Concrete deliverables (missing tests + doc gaps)

**Missing fast tests**
1. `evm.chain.service.batch.spec.ts`: `assertBatchFitsRootHistory` — reject when `rootHistorySize == MAX_BATCH`; reject when `contract MAX_BATCH() != SDK MAX_BATCH`; proceed when `rootHistorySize > MAX_BATCH`. (GAP-2)
2. Relayer spec: zod `BatchWithdrawalRelayParamsSchema.parse()` over an SDK-serialized `/relay/.../batch` body (real reshape) — asserts the wire shape validates; a bad-nesting fixture is rejected. (GAP-3)
3. `RelayerInteractor.test.ts`: batch cases with a capturing stub `IHTTPClient` — assert `getBatchWithdrawalQuote`/`relayBatchWithdrawal` POST to the `/batch` path with the flattened item/proof shape; assert `assertFeeCommitmentLive` fires on expired commitment. (GAP-3)
4. Artifact-gated `BatchWithdrawOrchestrator.integration.test.ts`: real prover over ≥2 groups; assert shared `stateRoot` + per-item `transactParams` binding. (GAP-4)
5. Byte-equality test: SDK `PAYOUT_ROUTING_ABI` vs relayer `encodeWithdrawalFeeSplit` encode identical bytes (single + array). (GAP-5)

**Missing docs**
6. `docs/tech-design/sdk/` batch-withdrawal usage note (or spec-index cross-link). (GAP-6)
7. "Superseded" banner on `docs/AUDIT_batch_standards.md`. (GAP-7)

**Runtime-export fix (code, one-liner)**
8. Value-export the six batch error classes from `external.ts`. (GAP-1)

---

## What I ran (observed results)

| Check | Command | Result |
|-------|---------|--------|
| SDK build | `pnpm build` (packages/sdk) | success; `dist/index.cjs` + `dist/batchFee.cjs` emitted. |
| Runtime export enumeration | `node -e "require('./dist/index.cjs')…"` over batch symbols + broad `declare class/const/function` sweep vs cjs | orchestrator/session/`computeBatchFees`/`computeBatchItemFee`/`selectNotesForFullWithdraw` = `function`; `MAX_BATCH`=10; `PAYOUT_ROUTING_ABI`/`_ARRAY_ABI`=object; **6 batch error classes = `undefined`** (GAP-1). |
| SDK batch unit | `vitest run` (4 batch files) | **38 passed / 0 failed** (orchestrator 12, session 10, computeBatchFees 10, select 6). |
| Relayer batch | `jest` (relay.service.batch + batch.quote-flow + chain.service.batch) | **23 passed / 0 failed**. |
| Contracts batch | `forge test --match-contract "PrivacyPoolRelayBatch\|BatchTransact"` | **20 passed / 0 failed** — unit 17, real-proof integration 3. |
| Single-source / drift traces | grep across relayer + SDK | `computeBatchFees`/`MAX_BATCH` single-sourced (relayer imports `@privacy-pools-v2/sdk/batch-fee`); `assertBatchFitsRootHistory` untested (GAP-2); PayoutRouting ABI duplicated (GAP-5). |

**Not run:** `packages/relayer/e2e/src/relay/batch.e2e.ts` (no docker; not part of fast suites) —
TEST-3 unverifiable here; treated as authored + observed-once, not a standing fast pass.

---

## Standard changes (PROPOSED — flagged for human ratification)

This feature produced **three** distinct type-only-runtime-export traps in a single feature
(`BatchWithdrawOrchestrator` → `PAYOUT_ROUTING_ABI`/`_ARRAY_ABI` → now six error classes). Each was
fixed reactively when the *next* consumer hit it. The existing LAYER-2 rule already names the
`export type *` trap, but its check ("prove it: `node -e require('dist').Thing`") is a **spot check on
the headline symbol** — which is why the error classes slipped after the orchestrator/ABI were fixed.
The durable lesson: the runtime-export proof must be **exhaustive over every new public value symbol**,
not spot-checked. Appended to `docs/FEATURE_BEST_PRACTICES.md` under Section B:

> **LAYER-4 (PROPOSED) — Enumerate ALL new runtime value exports, exhaustively.** When a feature adds
> public value symbols (classes incl. **error classes**, functions, consts, ABIs, schemas the
> consumer needs at runtime), don't spot-check the headline export — build the package and
> enumerate: for every new value symbol, assert `typeof require('./dist/index.cjs').X !== "undefined"`.
> A `export type *` barrel silently makes every value-and-type symbol type-only unless it is *also*
> value-exported. (batch: three separate traps in one feature — orchestrator, then
> `PAYOUT_ROUTING_ABI`, then all six `BatchWithdraw` error classes — each found only when the next
> consumer hit an `instanceof … is not callable` at runtime.)

Rationale: converts LAYER-2's per-symbol proof into a whole-surface enumeration, which is the only
form that would have caught GAP-1 pre-emptively. Do not ratify without human sign-off.
