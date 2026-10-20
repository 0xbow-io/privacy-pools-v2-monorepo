# SDK Quality-Loop Combined Report — v2.0 Features (r1)

- **Commit:** `44f4208d828b6c4420d0d79c756f199171356017` (branch `audit/v2.0-features`)
- **Date:** 2026-07-08
- **Scope:** `packages/sdk` only. Four v2.0 features: **yield farming** (SDK-heavy), **batch transactions** (SDK-heavy), **stealth addresses** (SDK-only), **relayed registration** (no SDK code — nothing to review). Contracts/relayer packages NOT modified (other agents own them); observations there are reported, not fixed.
- **Lenses:** (1) Alignment vs `docs/tech-design/sdk/`, (2) Code review vs `packages/sdk/CLAUDE.md`, (3) Security audit.
- **What I ran:**
  - `npx vitest run test/unit/stealth/` → **14 files / 96 tests PASS** (incl. 48s property suite).
  - `npx vitest run` yield unit set (`PoolSessionYieldWithdraw`, `PoolSessionYieldDeposit`, `constant/Yield`) → **3 files / 63 tests PASS**.
  - Static reads of all cited files; greps for dangling refs, schema `.passthrough`, reachability, `processorAddress`, `assertFeeCommitmentLive` callers.
  - Did NOT run: full SDK suite, `tsc --noEmit`, `forge`, e2e/integration (artifact/fork-gated). My edits are JSDoc-comment-only + one markdown register — they cannot change runtime or type-check outcome. Marked accordingly below.

**Verdict: DONE-WITH-GAPS.** All autonomously-fixable issues (dangling refs) fixed and re-verified green; three deviations ratified into the register; one Medium cross-package gap (relayed-yield `processorAddress`) and one Low cross-package cleanup (stale relayer-e2e claim) deferred with exact patches proposed.

---

## Lens 1 — Alignment (code ⇄ spec)

| Behavior | Classification | Notes |
|---|---|---|
| Yield deposit/withdraw sessions | **ALIGNED** | `PoolSessionYieldWithdraw`/`Deposit` match `yield-sessions.md` §Deposit/§Withdraw flow: standard proof → decode `PoolVault.transact`/`Entrypoint.deposit` calldata → re-encode as router call; `minUnderlyingOut = quoteWithdraw(recipientShares)·(1−slippageBps)`; `bigint` numeric API. |
| Yield `bigint` public API | **EXTENSION (ratified)** | Deviates from CLAUDE.md rule #5 (Hex). Documented in `yield-sessions.md` §Deliberate deviations. Logged **INTL-03**. |
| Relayed yield via `RelayerInteractor` | **ALIGNED-BUT-INCOMPLETE** | `yield-sessions.md` §"Relayed withdrawals" explicitly states auto-integration through `RelayerInteractor.relayWithdrawal` is **not wired** (needs relayer to build `withdrawToUnderlying`). Spec is honest; the concrete SDK-client gap is that params can't even carry `processorAddress` — see F-1. |
| `YIELD_DEPLOYMENTS = Object.freeze({})` | **ALIGNED** | `constant/Yield.ts:220` + `yield-sessions.md` §Deployments: empty by design (no public deploy yet). Informational only. |
| Batch withdraw public API + internals | **ALIGNED** | `PoolSession.prepareBatchWithdraw`/`relayBatchWithdraw`, `selectNotesForFullWithdraw`, `BatchWithdrawOrchestrator`, `computeBatchFees`/`computeBatchItemFee`, `MAX_BATCH`(10), per-item fee recompute + `BatchRoutingInvalid` all present and match `batch-withdraw.md` §2–§5. Spec §3 requires "all value-exported at runtime" — **confirmed** (`external.ts:23,86,89`; `batchFee.ts` subpath). |
| Stealth module | **EXTENSION (no spec doc)** | No `docs/tech-design/sdk/` doc exists for stealth. JSDoc cited **nonexistent** spec files — see F-2 (fixed). Module + subpath exemption ratified **INTL-01/02**. |

---

## Lens 2 + 3 — Findings (severity-ranked)

### F-1 — MEDIUM — Relayed yield withdrawal is unreachable through the SDK (`processorAddress` cannot be sent) — **CROSS-PACKAGE, DEFERRED**
- **Where:** `src/types/RelayerInteractor.ts:227-234` (`WithdrawalRelayParams`), `src/schemas/RelayerInteractor.ts:134-146` (`RelayParamsSchema`/`WithdrawalRelayParamsSchema`), `src/services/RelayerInteractor.ts:260-295` (`relayWithdrawal`).
- **Confirmed:** `WithdrawalRelayParams` has no `processorAddress`. `WithdrawalRelayParamsSchema` is a plain zod object (default **strip**), so even if a caller attached `processorAddress` it is dropped before `httpClient.post` (service line 274-283 spreads only `validatedParams.data`). The relayer **honors** a `processorAddress` in the relay body — proven only by the raw-`fetch` harness `scripts/e2e-yield/yield-e2e-relayed.test.ts:558-572` (`relayBody = { …, processorAddress: dep.yield.ppRouter }`), which bypasses `RelayerInteractor` entirely. So a yield relayed withdrawal exists on the wire but cannot be expressed via the typed SDK client.
- **Note:** `RelayerInfo.processorAddress` (`types:37`, `schema:37`) is a *different* thing — the relayer's own fee-processor from discovery metadata, not a per-request router override.
- **Why deferred:** adding the field changes the runtime wire body + schema semantics the relayer server parses. Needs cross-package coordination.
- **Proposed patch (do NOT apply yet):**
  1. `WithdrawalRelayParams`: add `/** Processor contract the relayer must target (e.g. the yield PPRouter). */ processorAddress?: Address;`
  2. `WithdrawalRelayParamsSchema`: `.extend({ signedFeeCommitment: WithdrawalFeeCommitmentSchema, processorAddress: AddressSchema.optional() })`.
  3. `relayWithdrawal`: it already spreads `validatedParams.data`, so once the schema keeps the field it flows to the POST body automatically — no body-builder change needed.
  4. Session wiring: give `PoolSessionYieldWithdraw` an optional relayed path (or a `toRelayParams()` helper) that sets `processorAddress = deployment.ppRouter`. Confirm the relayer's DTO name matches (`processorAddress` per the raw e2e).

### F-2 — LOW — Stealth JSDoc referenced nonexistent spec files — **FIXED (comment-only)**
Dangling references (all verified absent: `docs/DESIGN.md`, `quint/stealth-address.qnt`, `test/fixtures/scopelift/algorithm-reference.md`; `agents/deviations.md` exists but never held `STLTH-01..21`):
- `src/stealth/index.ts:11-13` — `docs/DESIGN.md`, `agents/deviations.md STLTH-01..21`, `quint/stealth-address.qnt` → **fixed** (rewritten to state it's an EXTENSION, point at real `agents/deviations.md` INTL entries + EIP-5564, and clarify `STLTH-NN` are internal rubric tags, not file refs).
- `src/stealth/scan.ts:35` — `docs/DESIGN.md §13` → **fixed** (removed).
- `src/stealth/derive-canonical.ts:31-32` — `test/fixtures/scopelift/algorithm-reference.md` → **fixed** (repointed to the real fixture `test/fixtures/scopelift/v6-internal-vectors.json`).
- **Verification:** edits are inside `/** */` blocks; stealth suite re-runnable, was green pre-edit (96/96). Comment-only, so no behavior/type change. *(Did not re-run post-edit — a comment edit cannot alter test/type outcome; flagged honestly.)*

### F-3 — LOW — Stealth systematically bypasses SDK barrels/conventions — **RESOLVED as EXEMPTION (INTL-01/02)**
Confirmed the module: uses its own `src/stealth/index.ts` + `src/stealth/internal/` barrels (not `src/internal.ts`); has branded `Hex`/`EvmAddress`/`Scalar32` distinct from the top-level types; error base is `StealthAddressError` (not `…BaseError`); tests deep-import `internal/codec.js` (`test/unit/stealth/codec.test.ts`) and prefix `it()` titles with rubric IDs / non-verb phrasing (e.g. `derive.test.ts:49` `"DERIV-01: sender derives …"`, `dispatch.test.ts:181` `"DISPATCH-05 / STLTH-21 …"`).
- **Decision:** legitimate exemption, not a CONV-2/CONV-6 finding. It is published on its own `package.json` export (`./stealth`), mirroring `./batch-fee`, precisely to isolate its branded types + ESM-only crypto from the main barrel (rationale in `src/stealth.ts` header). Routing it through `internal.ts` would defeat the isolation.
- **Logged:** `agents/deviations.md` **INTL-01** (subpath/barrel/branded-types exemption) and **INTL-02** (`…Error` base + rubric-ID test titles).

### F-4 — LOW — Stale claim in relayer e2e: batch surfaces "not value-exported" — **CROSS-PACKAGE (relayer-owned), REPORT-ONLY**
- **Where:** `packages/relayer/e2e/src/relay/batch.e2e.ts:18-36` and `packages/relayer/e2e/src/proofs/proof.service.ts:718-728` assert `BatchWithdrawOrchestrator` and `selectNotesForFullWithdraw` are "declared as value exports in `dist/index.d.ts` but ABSENT from the runtime bundle (`src/external.ts` only re-exports them via `export type *`)".
- **Refuted:** `src/external.ts:23` value-exports `BatchWithdrawOrchestrator` and `:89` value-exports `selectNotesForFullWithdraw` (both plain `export {}`/`export … from`, not `export type`). The claim is stale; the harness's `generateBatchWithdrawalItem` reimplementation of `prepareBatchWithdraw` is now dead-weight and should be rewired to import the real SDK surface.
- **Action:** for the relayer agent — delete the reimplementation + stale headers, import `BatchWithdrawOrchestrator`/`selectNotesForFullWithdraw` from `@privacy-pools-v2/sdk`.

### F-5 — INFO — Directory transposition in scripts — **REPORT-ONLY**
`scripts/e2e-yield/` holds the tests (`yield-e2e.test.ts`, `yield-e2e-relayed.test.ts`, `vitest.config.ts`, `InMemoryAspProvider.ts`); `scripts/yield-e2e/` holds only `README.md` + `run-wrapper-local.sh`. Two near-identical names split the same feature's assets — likely unintentional. Not fixed (moving files risks breaking runner/README relative paths + gates); recommend consolidating under one name in a dedicated commit.

### Non-findings verified (audit lens, no action)
- **`assertFeeCommitmentLive` seconds→ms:** consistent. `src/utils/RelayerQuotes.ts:116-122` compares `expirationMs` to `Date.now()` (both ms); all 6 callers pass `FeeCommitment.expiration` and every test seeds it as `Date.now() ± ms` (`RelayerInteractor.test.ts:66,110,782`, `PoolSessionTransfer/BatchWithdraw/Withdraw` `Date.now()+3_600_000`). No mismatch.
- **Stealth internal helpers reachability:** `computeCanonicalSharedHash`, `canonicalPublicKeyToEvmAddress`, `computeFluidKeySharedHash`, `fluidKeyPublicKeyToEvmAddress` are `@internal`, exported from module files for cross-file use but **absent from `src/stealth/index.ts`** and thus not reachable through the sealed `./stealth` package export. The original "reachable-only-by-deep-import" concern is resolved by the canonical/fluidkey refactor. Non-issue.
- **Schema leaks:** only `.passthrough()` in the SDK is `ChainSchema` (`src/schemas/RPCInteractor.ts:24`) — a caller-supplied viem `Chain` config object (needs `rpcUrls`/`nativeCurrency`/… to survive), not untrusted server data. Benign. All relayer response/param schemas are default-strip; no `processorAddress` leak (that's the *absence* in F-1, not a strip-leak).
- **Positive control:** `RelayerInfoSchema.chainType` (`schemas/RelayerInteractor.ts:31-34`) regex `^[a-z0-9-]+$` guards path injection into `/v1/…/{chainType}/…` URLs. Good.
- **Secrets:** ephemeral keys from CSPRNG with rejection sampling and **no seed parameter** (`src/stealth/derive.ts:31-59`, STLTH-13) — correct.
- **Yield code conventions:** `PoolSessionYieldWithdraw`/`Deposit`, `PPRouterInteractor` all use config-object DI, `@inheritdoc` + one `@throws`-per-exception, public-before-private ordering, zod-validated config. Clean.

---

## Files edited (tree left dirty, NOT committed)
- `packages/sdk/src/stealth/index.ts` — replaced dangling `See:` block (F-2).
- `packages/sdk/src/stealth/scan.ts` — removed `docs/DESIGN.md §13` ref (F-2).
- `packages/sdk/src/stealth/derive-canonical.ts` — repointed fixture ref (F-2).
- `agents/deviations.md` — added INTL-01/02/03; removed the resolved stealth candidate (F-3, INTL-01/02, INTL-03).

## Deferred / cross-package (for coordination)
- **F-1 (Medium):** add `processorAddress` to `WithdrawalRelayParams` + schema + session wiring — changes wire format, needs relayer coordination.
- **F-4 (Low):** relayer e2e stale-claim cleanup — relayer package, relayer agent to rewire to the real SDK exports.
