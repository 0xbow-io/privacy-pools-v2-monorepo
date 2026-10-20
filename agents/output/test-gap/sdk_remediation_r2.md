# Test-gap — SDK remediation, round 2

| | |
|---|---|
| **Range reviewed** | `a98eb1e7..03b15c1e` on branch `review/artem-remediation` — i.e. Artem's `36e5f048` plus this review's round-2 commits. |
| **Re-confirmed at** | `03b15c1e`. The lens was re-run after every subsequent commit; findings raised by that re-run are marked *(confirming pass)* below. |
| **Scope** | `packages/sdk` — the remediation diff `a98eb1e7..HEAD` |
| **Verdict** | **DONE-WITH-GAPS** — seven gaps found; six closed and mutation-verified, one (TG-2, Medium) filed open. A verdict of DONE requires a clean pass, and TG-2 is not clean. |

Every guard below was verified by **mutation, not by reading** — the guard was broken and the test
confirmed to fail. Reading the suite has produced a wrong answer on this codebase before, including a
fabricated finding in a shipped report, so it is not used as evidence here.

## §2 No-mock-only sweep (TEST-7) — the one that found the real gap

Enumerating every mocked stand-in across the five remediated behaviours and asking, for each, whether
a **real** (non-mocked) test exercises the same path:

| Behaviour | Mocked where | Real counterpart | Verdict |
|---|---|---|---|
| #1070 receipt-log decode | `PoolSessionWithdrawAndSwap`/`Reshield` tests use a fake `core` | `TransactOrchestrator.test.ts` builds **real** `Transacted` logs with viem `encodeEventTopics`/`encodeAbiParameters` against the real ABI, decoded by a real `PoolVaultInteractor` | COVERED |
| #281/#360 AEAD + AAD | — | `EncryptedStorageService.test.ts` and `AtRestSealing.test.ts` run **real** XChaCha20-Poly1305 and real scrypt; the cross-key transplant test is a genuine crypto round-trip | COVERED |
| #600 expiry **logic** | storage adapter only | `isExpired` and the sender guard are the real units under test | COVERED |
| #600 expiry **wiring** (`generatePaymentRequest`) | `paymentRequestService` mocked wholesale in every unit test | none in CI — the real-session checks exist but no workflow runs them | **OPEN GAP** (TG-2) |
| #501 authoritative spend read | `getNullifierTimestamp` mocked | none — a real read needs anvil | **KNOWN GAP** (below) |
| #540 root anchoring | mocked at **every** layer | none — **was a real gap** | **WAS A GAP → CLOSED** |

### TG-1 · Medium · #540's root verification was mock-only at every layer — FIXED (`861e727d`)

Root verification *is* the #540 fix: corroboration was moved off the raw `getLeaves()` endpoint onto
`getAssociationSetLeaves()` precisely so the second read is anchored on something the ASP does not
serve. But the chain was mocked end to end:

- discovery tests mock `aspClient.getAssociationSetLeaves`
- `ASPClient` tests mock `merkleService.computeRoot` — **the mock decides whether the leaves match**,
  which re-serves the ASP's own answer, the exact thing the fix exists to stop trusting
- `MerkleService`'s own tests use a `MockHashService` that concatenates hex instead of hashing

So no real LeanIMT-over-Poseidon root was ever computed and compared to an on-chain root.

The primitive itself is sound — seven real-proof integration suites compute roots that circuits and
contracts then accept, so a drifted hashing convention would break those. What had no coverage was
the **assembly**: leaves → real root → compare against the chain.

Closed with three real-crypto cases (real `PoseidonHashService` + real `MerkleService`): honest set
accepted, tampered set rejected, and the same leaves **reordered** rejected — ordering is load-bearing
in a LeanIMT, and a reconstruction that sorted would pass the first two.

**Evidence the mocks were blind rather than merely redundant:** mutating `MerkleService.computeRoot`
to sort its leaves fails **exactly one** test — the new reordering case — while all 27 mocked cases
pass. Neutering the root comparison in `ASPClient` fails 8.

## §5 Error-path parity

| Guard | Was | Now | Mutation |
|---|---|---|---|
| `if (!verification)` runtime branch | untested — the round-1 comment called it untestable because the required parameter makes omission a compile error, but it is reachable exactly as the code itself says (plain JS, `as any`, a stale `.d.ts`) and testable via a cast | covered | delete branch → 1 failed |
| `isNullifierSpentOnChain` fail-closed catch | untested; direction asserted by comment only | covered | `true`→`false` → 1 failed |
| `requestExpiryMs` ctor validation | untested | one case per rejected shape (Infinity, NaN, fractional, zero, negative, beyond safe-integer) + both accepting boundaries | delete guard → 6 failed |
| Sender-side exact expiry instant | tested only at `now-1` and `now+1h` | both boundaries | `>`→`>=` → 1 failed |
| `expiresAt` reaches the shareable payload | untested; fixture and assertion shared the omission | round-trip test feeds `generatePaymentRequest` output into the sender guard | drop propagation → 2 failed |
| Recipient scan grace | n/a (new) | both boundaries of `expiresAt + grace` | remove grace → 2 failed |
| Bounded fan-out | n/a (new) | cap **and** completeness | unbounded → 1 failed; first-batch-only → 1 failed |

## §4 CI-selection check

All added tests live under `test/unit/**` and `test/unit/services/**`, matched by the vitest `include`
glob and run by `pnpm --filter sdk test`, which is gated in `ci-sdk.yml`. Confirmed by the file counts
in the full run (103 files, 101 passed, 2 skipped). No test was added that CI will not select.

## §6 Schema→wire survival (TEST-8)

`expiresAt` crosses the Zod boundary twice — `PaymentRequestSchema` on fulfilment and
`StoredPaymentRequestRecordSchema` on persistence/import. Both declare it, and the round-trip is
asserted post-schema (`service.list()` after `loadFromStorage`), not merely type-shaped.

## Known gaps — filed, not closed

### ★ TG-2 · Medium · The #600 payment-request feature has NO CI-gated real-stack coverage

This is the structural reason N-1 survived, so it matters more than the individual test it explains.

- The unit tests mock `paymentRequestService` wholesale, so `generatePaymentRequest` never runs
  against a real `PaymentRequestService` — which is why a dropped `expiresAt` passed every one of
  them.
- `apps/sample/checks/paymentRequest/{generatePaymentRequest,fulfillPaymentRequest,storage}.ts` DO
  drive a real `PoolSession`, and are the natural real counterpart — but they are manual `tsx`
  scripts. **No workflow invokes them** (`grep check:generatePaymentRequest .github/workflows/` is
  empty).
- The CI-gated real-stack suite is `pnpm --filter sample test:integration`, whose config only
  collects `tests/integration/scenarios/**`. Those seven scenarios cover register/deposit/ragequit,
  transfers, withdraw, and note discovery — **none covers payment requests**
  (`grep -rl PaymentRequest tests/integration/scenarios/` is empty).

So the whole feature is mock-only in CI. That is a TEST-7 gap over an entire user flow, not one
assertion.

**Done — authored, then moved off this branch.** `checks/paymentRequest/generatePaymentRequest.ts`
asserts the stamp against a real session and stays. The full scenario was written and then removed
again (`b66105f3`): it is the right test in the wrong place, and leaving an unrunnable test in the
audit branch overstates coverage to the re-auditor. It is preserved in history —
`git show 09c0a1f6:apps/sample/tests/integration/scenarios/08-payment-request.test.ts` — and carried
on the test-infrastructure track, whose correct target is `packages/relayer/e2e` (anvil fork +
containerised relayer, already PR-gated) rather than the Sepolia suite. What it covered: a live `expiresAt` from the REAL service, no secrets in the shareable
payload, sender-side refusal of a lapsed request, `hint == tag` binding on fulfil, and recipient
discovery with the secret injected from the local slot map. That is the pass which would have caught
the defect on the introducing PR.

**NOT done, and not claimed: it has never been executed.** These scenarios run against **live
Sepolia** with a funded faucet (`global-setup` demands ≥ 0.15 ETH) plus a relayer; this environment
has neither. Authored and typechecked only. Per TEST-3 / Directive 0 — authored ≠ passing — TG-2
stays **open** until someone runs it with credentials. Typecheck evidence: `tsc -p tsconfig.test.json`
total is unchanged at its pre-existing 60, so the new file contributes 0.

### TG-3 · Medium · *(confirming pass)* Nothing typechecks `apps/sample/tests/**` — it has drifted 60 errors

Found while verifying TG-2's own fix, and it is the mechanism behind TG-2 as much as the missing
scenario was.

`tsc -p tsconfig.test.json` reports **60 pre-existing errors** across the integration helpers —
`exportAccount()` is awaited nowhere though it returns a `Promise`, `PrepareDepositResult.receipt` /
`PrepareTransferResult.recipientReceipt` / `changeReceipt` no longer exist, `NoteEvent.tag` is gone.
The helpers were written against an older SDK and never updated.

Nothing catches it:
- `apps/sample`'s only typecheck script is `tsc --noEmit`, whose project includes **`src/` and
  `checks/` only** — `tests/` is excluded. (This bit me directly: my first `tsc --noEmit` returned 0
  on a file with 10 errors in it.)
- No workflow typechecks the sample tests; `integration-tests.yml` only runs `test:integration`.
- vitest transpiles with esbuild, which does not typecheck.

So the one suite that exercises the real stack is also the one suite no gate type-checks.

**Fix:** add a `typecheck` script to `apps/sample` pointing at `tsconfig.test.json` and gate it, then
repair the 60. Not attempted here — unrelated to the remediation and a large, separate diff.

**Do NOT delete this suite** (an earlier draft of this report floated it; that was wrong). It was
added deliberately — `2a684fc4`, 2026-04-01, PR #137 "integration tests using real testnet
interaction" — and maintained across 7 commits by four people. It is also **not replaceable by the
anvil e2e**, which forks at a *pinned* block (`10783261`) and runs a relayer *built from source*: a
frozen synthetic stack. Only the Sepolia suite exercises the actually-deployed contracts and the
actually-running relayer, which is the class of failure — deployment/config drift — where a pinned
fork stays green while production is broken. The two are different altitudes, not competitors:
anvil = per-PR regression barrier; Sepolia = pre-release smoke against the live deployment. It was
never meant to be a PR gate (hence `workflow_dispatch`); the defect is that it rotted **silently**,
which the typecheck gate is what fixes.

## Known gap — #501's authoritative read

**#501's authoritative read has no real counterpart.** `poolVaultInteractor.getNullifierTimestamp` is
mocked in every discovery test. A genuine test would need an anvil node with a deployed `PoolVault` and
a real spent nullifier, which this environment cannot run. Per TEST-3/Directive 0 this is recorded as
an open gap rather than claimed as covered. Mitigating: the interactor's own encode/decode path is
shared with the other `PoolVault` reads that the real-proof integration suites do exercise, so what is
untested is narrowly the discovery-side wiring, not the read itself.
