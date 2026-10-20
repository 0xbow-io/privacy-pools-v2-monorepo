# Code review — SDK remediation, round 2

| | |
|---|---|
| **Range reviewed** | `a98eb1e7..03b15c1e` on branch `review/artem-remediation` — i.e. Artem's `36e5f048` plus this review's round-2 commits. |
| **Re-confirmed at** | `03b15c1e`. The lens was re-run after every subsequent commit; findings raised by that re-run are marked *(confirming pass)* below. |
| **Scope** | `packages/sdk` — the remediation diff `a98eb1e7..HEAD` |
| **Oracle** | `packages/sdk/CLAUDE.md`, confirmed present and unchanged at `v2.0` (`git cat-file -e v2.0:packages/sdk/CLAUDE.md`) → trustworthy as the style reference, per the lens's pin-to-base rule |
| **Verdict** | **DONE** — conventions clean; one correctness bug found and fixed, one recurring-defect check fired |

## Conventions (`packages/sdk/CLAUDE.md`)

| Rule | Result |
|---|---|
| §1 imports via `internal.ts` | PASS — one deliberate exception, `test/unit/publicBarrel.test.ts`, which must import `external.js` because asserting the public barrel is its entire purpose. Documented in-code as §1 requires. |
| §2 public-above-private, caller-before-callee | PASS — no reordering; `isNullifierSpentOnChain` stays below its caller. |
| §3 DI via one typed config object | PASS — `aspClient` added to the existing `PoolSessionNoteDiscoveryConfig`, no new loose params. |
| §4 two-layer JSDoc | PASS — `PaymentRequestExpired` documented on the impl with a specific `@throws`; interface keeps the base error. |
| §5 `Hex` at public boundaries | PASS — `expiresAt` is `Hex`, not `number`/`bigint`, matching `createdAt`. |
| §6 `it()` verb-first, never "should" | PASS — all 26 added tests. |
| Errors: one file per domain, `this.name` set | PASS. |
| Zod schema mirrors the type | PASS — see below. |

Mechanical checks run rather than reasoned about: `tsc --noEmit` PASS, `eslint` PASS,
`prettier --check` PASS.

## Recurring-defect checks

**Type ⟺ schema parity.** `PaymentRequest.expiresAt` (type) ⟺ `PaymentRequestSchema.expiresAt`
(`HexSchema.optional()`) ⟺ `StoredPaymentRequestRecordSchema` (inherits via `.extend`). Declared, not
`.passthrough`. Traced the full persistence round trip — `generate → dehydrate → saveState`, and
`importState → PaymentRequestServiceStateSchema → hydrate` — and the field survives both. **No F-1
defect.** `hydrate`/`dehydrate` both use rest-spread, so neither can drop a future field either.

**Single-source derivation across a boundary.** `DEFAULT_REQUEST_EXPIRY_MS` and
`SCAN_EXPIRY_GRACE_MS` now live in `constant/PaymentRequest.ts` and are imported by both the service
and its tests. Before this, the test restated the window as a literal; the grace would have been the
second such literal. One source, no drift (DRIFT-1).

## Findings

### CR-1 · High · `generatePaymentRequest` dropped `expiresAt` — FIXED (`9e784cb3`)

`PoolSessionTransfer.ts:230` hand-built the shareable payload field by field and omitted
`record.expiresAt`. Because `expiresAt?` is optional the omission type-checked, and because the test's
fixture and its `toEqual` shared the same omission it passed. Net effect: the entire sender-visible
expiry feature was inert in production.

This is the **explicit-field-list** defect class. I swept the SDK for siblings — any function
narrowing a rich record to a public payload by listing fields — and `generatePaymentRequest` was the
only one; `hydrate`, `dehydrate`, and `exportState` all rest-spread. The class is contained.

Fix: conditional spread, so a legacy unstamped record still yields no key rather than an explicit
`undefined` that would survive into the QR/link encoding. Mutation-verified.

### CR-2 · Low · Unbounded fan-out in `recoverRejectedNotes` — FIXED (`3ea424b8`)

Efficiency/robustness rather than security. One `Promise.all` over every candidate, justified in-code
by the mass-recovery case — which is precisely the case that gets rate-limited, and since every
rejection maps to fail-closed a throttled burst recovers nothing. Self-defeating under its own stated
scenario. Now 8 in flight; test asserts both the cap and that no candidate is dropped.

### CR-3 · Nit · Stale comment — FIXED (`3ea424b8`)

`recoverRejectedNotes`'s doc said "One read per note that is genuinely recovering, which is rare",
which is wrong in exactly the case the code optimises for. Reworded.

### CR-4 · Nit · *(confirming pass)* Two stale expiry comments in the type surface — FIXED (`89367893`)

`requestExpiryMs` was documented as "an age relative to `createdAt` after which a request stops being
returned", and the `PaymentRequestStatus` header said the scan set is bounded by "`createdAt` expiry".
Both describe the pre-`36e5f048` design: expiry is applied once at generation, which is the whole
mechanism preventing retroactive drops. A comment describing an older design is worse than none — it
is the version a reader trusts. Found by re-reading the type surface rather than the diff.

### CR-5 · Nit · *(confirming pass)* Malformed code span in new JSDoc — FIXED (`f90d8786`)

`` `expiresAt + ` ``{@link …} rendered as a code span with a trailing operator. Reworded.

## Not findings (checked, refuted)

- **`Promise.all` ordering.** `spentOnChain[i]` is index-matched to `candidates[i]`. Preserved by the
  chunked rewrite (`push(...await Promise.all(batch))` appends in batch order). Test with 20
  candidates across 3 batches asserts every one is recovered.
- **`BigInt(paymentRequest.expiresAt)` throwing on a malformed value.** The field is validated by
  `HexSchema` inside `FulfillPaymentRequestParamsSchema` *before* the expiry branch runs, so a
  malformed value throws `InvalidTransactParams`, not a bare `SyntaxError`.
- **Clock skew.** `isExpired`'s old `nowMs <= createdAtMs` future-guard is gone, but it was guarding a
  subtraction that no longer happens; the comparison is now a direct one against a stored stamp, where
  a skewed clock can only make a request look longer-lived, never shorter.
