# Alignment — SDK remediation, round 2

| | |
|---|---|
| **Range reviewed** | `a98eb1e7..03b15c1e` on branch `review/artem-remediation`, off `audit/consensys-remediation` @ `36e5f048` |
| **Re-confirmed at** | `03b15c1e`. Re-run after every subsequent commit. |
| **Scope** | `packages/sdk`, plus one assertion in `apps/sample/checks/paymentRequest/`. No other package changed. |
| **Spec read** | `docs/tech-design/sdk/{pool-session,note-discovery-service,note-manager,batch-withdraw}.md` |
| **Verdict** | **DONE** — 0 open CONTRADICTIONs. One EXTENSION, signed off in the session plan before implementation. |

## Spec independence — read this before trusting anything below

Per `ALIGNMENT_AGENT.md` §"Features vs ports", spec-alignment only has teeth when the spec is
independent of the code. It is **not** here, and the check is mechanical:

| Spec | Lines at `v2.0` | Lines now | Commits on this branch touching it |
|---|---|---|---|
| `note-discovery-service.md` | 113 | 124 | 3 |
| `pool-session.md` | 1071 | 1087 | 5 |
| `note-manager.md` | 237 | 257 | 5 |

Every one of these was edited by the same commits as the code it describes. **Aligning the new
behaviour to these documents would be circular and would prove nothing.** So for the new behaviour the
reference used here is the pair the lens prescribes instead:

1. **Base-v2 invariants** — the pre-branch spec and `git show v2.0:packages/sdk/src/...`.
2. **Original finding intent** — the ConsenSys/Auditware findings themselves (#600, #501, #540,
   #1070, #281/#360). These are genuinely independent: authored before the branch existed and not
   editable by it. This is the reference with actual teeth, and it is what the table below uses.

## Behaviour ⇄ independent reference

| Behaviour | Reference | Code | Verdict |
|---|---|---|---|
| Relayed swap paths verify receipt logs before persisting SPENT | #1070 / AW-L-02 | `PoolSessionWithdrawAndSwap.ts:402`, `PoolSessionReshield.ts:428` | ALIGNED |
| `verification` required, so a missed call site is a compile error | #1070 root cause | `ITransactOrchestrator.ts:43`, `IBatchWithdrawOrchestrator.ts:68` | ALIGNED |
| Rejection corroborated against an on-chain-anchored set | #540 | `PoolSessionNoteDiscovery.ts:500` via `ASPClient.getAssociationSetLeaves` | ALIGNED |
| `REJECTED → ACTIVE` gated on an authoritative unspent check | #501 | `PoolSessionNoteDiscovery.ts` `isNullifierSpentOnChain` | ALIGNED |
| At-rest records bound to their storage key | #281/#360 | `AtRestSealing.ts` `atRestRecordAad`, `EncryptedStorageService.ts:109/127` | ALIGNED |
| Scan set bounded by recipient or time, never by an attacker-craftable flip | #600 (the actual invariant) | `PaymentRequestService.isExpired` + `getScannableRequests` | ALIGNED |
| Expiry never applied retroactively | #600 regression risk | `expiresAt` stamped at generation; unstamped ⇒ never expires | ALIGNED |
| Sender can see and is refused past the deadline | #600 (round-1 extension) | `PoolSessionTransfer.prepareFulfillPaymentRequest` | **Was CONTRADICTION — now ALIGNED** (see below) |
| Recipient keeps scanning past the sender's deadline | none — new | `SCAN_EXPIRY_GRACE_MS` in `isExpired` | **EXTENSION** (approved) |

### Resolved CONTRADICTION — the #600 sender-visible expiry did not exist in practice

`note-discovery-service.md` stated `expiresAt` "is a field on the public, shareable `PaymentRequest`
payload". `generatePaymentRequest` — the only code path that produces that payload — hand-built the
object and omitted it, so every request the SDK issued carried no stamp. Under the branch's own
grandfathering rule that reads as "never expires", making the sender-side guard unreachable while the
recipient still dropped the request at 7 days. The doc described a behaviour the code did not have.
Fixed in `9e784cb3`; mutation-verified.

### EXTENSION — recipient-side scan grace (`SCAN_EXPIRY_GRACE_MS`, 24h)

Not described by any pre-existing doc, so it is logged as an EXTENSION rather than silently absorbed.
It was raised as an EXTENSION in the session plan and approved before implementation, satisfying the
Spec-Guardian §1 gate. Spec updated in the same commit (`note-discovery-service.md`, `pool-session.md`
v1.18.1, `note-manager.md` v1.13).

## §4 Regression / no-harm-to-base

`git diff v2.0..HEAD -- packages/sdk/src`, every modified pre-existing symbol classified:

| Symbol | Class | Note |
|---|---|---|
| `external.ts` exports | BENIGN | Purely additive; verified against the built `dist/index.cjs`. |
| `DEFAULT_REQUEST_EXPIRY_MS` | BENIGN | Moved module-local → `constant/PaymentRequest.ts`. Same value. |
| `generatePaymentRequest` return | BEHAVIOR-CHANGE | Gains an optional `expiresAt`. Intended; pinned by a test both ways (stamped and legacy-unstamped). |
| `isExpired` / `getScannableRequests` | BEHAVIOR-CHANGE | Scan window +24h. Intended; pinned at both boundaries. |
| `recoverRejectedNotes` | BENIGN | Bounded fan-out; same set checked, same outcomes. Test asserts no candidate is dropped. |
| `ITransactOrchestrator.persistNoteUpdates` | **BREAKING** | `verification` optional → required (round 1). |
| `IBatchWithdrawOrchestrator.persistBatchNoteUpdates` | **BREAKING** | Same. |
| `PoolSessionNoteDiscoveryConfig` | **BREAKING** | `aspClient` is required (round 1). |
| `aeadEncrypt` / `aeadDecrypt` | not breaking | `AtRestSealing.ts` does not exist at `v2.0` — new surface, not a changed one. |
| `PaymentRequestService` ctor | BEHAVIOR-CHANGE | Now throws on an invalid `requestExpiryMs`. Covered one case per rejected shape. |
| `EncryptedStorageService` header check | BEHAVIOR-CHANGE | Now throws on a version mismatch. Covered. |

**On the three BREAKING items.** All are round-1 (`36e5f048`) and all are deliberate — the required
parameter is the mechanism that turns a missed call site into a compile error, which is the point of
the #1070 fix. The usual justification given for them ("the SDK is unreleased") is **not accurate**:
the package is `private: true` and absent from npm, but `sdk-pre-release.yml` publishes versioned
GitHub prerelease tarballs from `dev`, and five exist. The accurate statement is that these break
only consumers who both pin a prerelease **and** implement/call these interfaces directly; the
in-repo consumers are updated in the same commits, and the branch is unmerged. Recorded in
`REMEDIATION_SUMMARY.md` rather than left implicit.

Base-v2 test surface: green — full SDK suite 1688 passed / 8 skipped, typecheck / lint / format all
pass.
