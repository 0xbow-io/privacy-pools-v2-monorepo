# Security audit — SDK remediation, round 2

| | |
|---|---|
| **Range reviewed** | `a98eb1e7..03b15c1e` on branch `review/artem-remediation` — i.e. Artem's `36e5f048` plus this review's round-2 commits. |
| **Re-confirmed at** | `03b15c1e`. The lens was re-run after every subsequent commit; findings raised by that re-run are marked *(confirming pass)* below. |
| **Scope** | `packages/sdk` — the remediation diff `a98eb1e7..HEAD` |
| **What I ran** | full SDK suite (1688 passed / 8 skipped), `tsc --noEmit`, `eslint`, `prettier --check`, seven targeted mutations, a `dist/index.cjs` runtime-export enumeration |
| **Verdict** | **DONE** — no exploitable finding. One overstated security claim corrected; two DoS surfaces bounded. |

Per the lens's method, every candidate below was adversarially self-refuted before being written down,
and items I could not construct a failure for are recorded under "Refuted" rather than dressed up.

## Findings

### AUD-1 · Low · The sender-side expiry guard was described as something it is not — FIXED (`f98e06df`)

Not a code defect; a **claim** defect, which is the class this whole re-review exists to catch (D-9).

The docs framed `prepareFulfillPaymentRequest`'s refusal as "the SDK is the layer that can actually
refuse to spend". The shareable `PaymentRequest` carries **no signature** — nothing binds `expiresAt`,
`tag`, or `paymentPubKey` to the recipient who issued it. So the guard is a **staleness control**, not
a security one.

*Self-refutation attempt:* is this exploitable? An attacker rewriting `expiresAt` in transit can
induce a doomed payment. But the same attacker can rewrite `tag` and `paymentPubKey` and redirect the
payment to themselves outright, which strictly dominates. So the field adds no attack surface, and the
finding is a documentation one, not an exploit. Fixed by stating the boundary explicitly rather than
leaving the re-auditor to find the gap between the prose and the threat model.

### AUD-2 · Low · Unbounded RPC fan-out — FIXED (`3ea424b8`)

`recoverRejectedNotes` issued one `eth_call` per candidate concurrently. The candidate set is bounded
by the user's own note count, so this is self-inflicted rather than attacker-amplified — which is why
it is Low and not Medium. Bounded at 8 in flight.

*Self-refutation attempt:* can a hostile ASP amplify it? It can mark many labels rejected and later
re-approve them, driving candidates up — but only across notes the user already owns, and the ASP
cannot create notes. No amplification factor. Confirmed Low.

### AUD-3 · Informational · The at-rest "no migration needed" argument was resting on a false premise — FIXED (`6dfabfd4`)

The stated justification was "the SDK is unreleased (`0.0.0`)". `sdk-pre-release.yml` publishes
versioned GitHub prerelease tarballs on every push to `dev` touching `packages/sdk/**`, and at least
five exist (latest `18620ac3`, 2026-07-27). The SDK **is** distributed; the version string just never
moves.

The conclusion survives on a narrower and stronger fact: `AtRestSealing.ts` is on neither `origin/dev`
nor `origin/v2.0`, so no distributed artifact has ever contained the code that writes ciphertext. **The
argument expires the moment this branch lands on `dev` without the AAD change** — recorded as such.

### AUD-4 · Low · *(confirming pass)* `PaymentRequestExpired`'s message was made false by our own fix — FIXED (`03b15c1e`)

Same class as AUD-1, this time self-inflicted. The message read "the recipient is no longer scanning
for it". True when written; `01238c20` made it false by adding the 24h recipient-side grace. The error
told the user their funds were definitively unreachable during a window in which they are fine.

Caught only by re-reading the final state — no test asserts the string (they assert `instanceof`),
which is exactly why it survived the suite. Reworded to "stops scanning for it shortly after, so a
payment may not be discovered", with the reason for the hedge recorded in the JSDoc.

## Checklist results (TypeScript / SDK section)

| Check | Result |
|---|---|
| Unauthenticated expensive work / DoS bounds | PASS after AUD-2. `getAssociationSetLeaves` already caps leaf count **before** `computeRoot`, so a hostile provider cannot force an O(n) LeanIMT build on an oversized array — verified by an existing test asserting `computeRoot` is never called. |
| Wire-format trust | PASS. `expiresAt` is declared in the Zod schema (not `.passthrough`); its trust boundary is now documented (AUD-1). |
| Secrets / log redaction | PASS. New log lines carry `commitment` and `txHash` only, matching the existing pattern. No key material. |
| AAD contents | PASS. `atRestRecordAad` folds in the storage key, which is **authenticated but not encrypted** — correct, since the key is already plaintext in the backing store. No new disclosure. |
| Expiry units on both sides | PASS (SEC-4). Milliseconds on both sender and recipient. The two *bounds* differ deliberately (recipient = `expiresAt + 24h`), which is not the SEC-4 failure mode — that rule targets a **unit** mismatch, the class that made a live guard a silent no-op in the batch feature. Unit parity is pinned by tests on both sides. |
| Fail-open / fail-closed direction | PASS, and now pinned. `isNullifierSpentOnChain` fails closed; `receiptConfirmsSpentNullifiers` fails closed; a missing `verification` fails closed. Each direction is asserted by a test, and each was mutation-verified — previously all three were asserted only by comments. |
| Terminal-state safety | PASS. `SPENT` is terminal and unrecoverable by discovery, which is exactly why `verification` was made required; a missed call site is now a compile error rather than silent corruption. |

## Refuted (checked, not findings)

- **AAD version pinning could brick an existing store.** `#recordAad` folds in the compile-time
  `ENCRYPTED_STORAGE_VERSION`, which would change every record's AAD on a bump. Guarded:
  `#assertHeader` rejects a version mismatch up front with a message naming the real cause, so the
  failure mode is a clear error rather than an auth failure indistinguishable from a wrong passphrase.
  Covered by a test.
- **`managedNonce(xchacha20poly1305)(key, aad)` might silently ignore the AAD.** If it did, the
  cross-key transplant test would decrypt cleanly and pass. It rejects. AAD is genuinely bound.
- **Grace period widens an attack window.** The grace only widens *the recipient's own scan set*,
  which can surface no notes other than the user's. It does not extend what a sender will pay.
- **Boundary-millisecond disagreement between the two expiry checks.** Both use strict `>`, and both
  boundaries are now pinned by tests on both sides, so the pair cannot drift apart silently.
