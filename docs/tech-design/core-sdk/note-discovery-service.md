# NoteDiscoveryService

NoteDiscoveryService is responsible for finding notes that belong to the account by scanning on-chain events and attempting cryptographic decryption. It implements both discovery strategies defined by the protocol: targeted discovery for known contacts and catch-all discovery for anonymous senders.

For targeted discovery, the service computes a shared secret with each known contact via ECDH(viewingPrivKey, contactViewingPubKey), derives the expected tag from that shared secret, and filters on-chain events by tag. This is O(k) where k is the number of contacts—only events matching a known tag are processed.

For catch-all discovery, the service fetches all Transact events emitted with `tag = bytes32(0)` (the anonymous marker) and attempts ECDH(viewingPrivKey, ephemeralPubKey) against each event. If decryption produces a valid note structure, the note belongs to this account. This is O(N) where N is the total number of anonymous transfers and should be used sparingly.

> ECDH curve is whatever the injected `ICryptoService` implementation uses — X25519 (Curve25519), 32-byte public keys, for the EVM `CryptoService`; secp256k1 for `StellarCryptoService`. See [crypto-service.md](crypto-service.md) for the shared contract and the per-chain docs it links to.

NoteDiscoveryService manages incremental sync via a persisted block cursor (`lastSyncedBlock`). On each scan it only fetches events from the last synced block forward, making repeated syncs efficient. Full history scans only happen on explicit account import/recovery.

The service receives an `IStorageAdapter` so the integrator controls where the block cursor and cached discovery data are stored (e.g. wallet extension local storage, IndexedDB, filesystem). The SDK does not prescribe a storage backend—it only requires the adapter to persist the cursor and any cached notes between sessions. This follows the same trust model as storing an encrypted seed in a wallet extension.

> **Package scope.** `NoteDiscoveryService` (this page) is the chain-agnostic base class in `packages/core-sdk`, covering `scanTargeted` / `scanCatchAll` / sync-cursor management. `EvmNoteDiscoveryService` (`packages/evm-sdk`) extends it with one EVM-only addition, `scanStealthDeposits` — scanning for ERC-5564/secp256k1 stealth-owned deposit notes (used by the cross-chain-reshield stealth dust-rescue flow) — which has no equivalent on this base class or in `packages/stellar-sdk`. See [evm-sdk/stealth.md](../evm-sdk/stealth.md) for the stealth derivation/scanning primitives `scanStealthDeposits` builds on.

# Dependencies

| Dependency | Why |
| --- | --- |
| **DataService** | Fetches on-chain events (Deposit, Transact, Ragequit) from the RPC provider. NoteDiscoveryService needs raw event data to scan for incoming notes. |
| **CryptoService** | Performs ECDH to compute shared secrets with senders, and decrypt to recover note payloads from encrypted event data. Both discovery strategies require these two operations. HashService (via CryptoService) is kept for tag computation only. |
| **NoteComputationService** | Handles commitment computation from decrypted payloads and RLP NotePayload decoding. After decryption yields an RLP-encoded NotePayload, NoteComputationService decodes it into structured fields (noteSecret, value, tokenId, label) and recomputes the commitment to verify note ownership. |
| **IStorageAdapter** | Injected interface for persisting the sync block cursor and cached discovered notes. Integrators provide their own implementation (e.g. wallet extension local storage, IndexedDB). The SDK defines the interface, not the backend. |

# Methods

---

**`scanTargeted(events, contacts, viewingPrivKey) → DiscoveredNote[]`**

Scans a set of Transact events for notes sent by known contacts. For each contact, computes the shared secret via CryptoService.ecdh(viewingPrivKey, contactViewingPubKey), derives the expected tag, filters events matching that tag, and decrypts matching payloads. Each `encryptedPayload` contains an RLP-encoded NotePayload after decryption, which is decoded via NoteComputationService.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `events` | `TransactEvent[]` | Array of on-chain Transact events to scan. Each event contains: tag, ephemeralPubKey, encryptedPayload, outputCommitments. |
| `contacts` | `Contact[]` | Known contacts with their viewing public keys. A shared secret is computed for each. |
| `viewingPrivKey` | `Secret` | The account's viewing private key for ECDH computation. |

**Returns: `DiscoveredNote[]`**

Array of discovered notes. Each contains the decrypted note data (noteSecret, value, tokenId, label) and the contact that sent it.

---

**`scanCatchAll(events, viewingPrivKey) → DiscoveredNote[]`**

Scans anonymous Transact events (tag = bytes32(0)) by attempting ECDH + decrypt against every event. For each event, computes ECDH(viewingPrivKey, event.ephemeralPubKey) and attempts to decrypt the payload. If decryption yields a valid RLP-encoded NotePayload, NoteComputationService decodes it and recomputes the commitment to verify the note belongs to this account.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `events` | `TransactEvent[]` | Array of anonymous Transact events (filtered to tag = bytes32(0)). |
| `viewingPrivKey` | `Secret` | The account's viewing private key. Attempted against every event's ephemeralPubKey. |

**Returns: `DiscoveredNote[]`**

Array of discovered notes. No contact metadata since senders are anonymous.

---

### Sync Cursor Management

**`getLastSyncedBlock(chainId) → Promise<number>`**

Returns the last synced block number for a given chain from the storage adapter. Returns `0` if no cursor exists (fresh account).

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `chainId` | `number` | The chain ID to get the cursor for. |

**Returns:** `number` — The block number to resume scanning from.

---

**`updateLastSyncedBlock(chainId, blockNumber) → Promise<void>`**

Persists the latest synced block number via the storage adapter. Called after a successful scan completes.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `chainId` | `number` | The chain ID. |
| `blockNumber` | `number` | The block number to persist as the new cursor. |

---

# Payload Encoding

Newly-emitted Note payloads use RLP wire version `0x02` with a `kind` byte selecting the field-set. This is the format produced by `NoteComputationService.encodeNotePayload()` / `encodePaymentRequestNotePayload()` before encryption and expected by the matching decoders after decryption. `decodeNotePayload` additionally accepts the legacy v1 layout (`RLP([0x01, noteSecret, value, tokenId, label])`, no kind byte) for backward compatibility with notes already on-chain.

**RLP format:**

```
RLP([0x02, kind, ...fields])
```

| Index | Field | Encoding |
| --- | --- | --- |
| 0 | `version` | `0x02` for newly-emitted payloads; `0x01` (legacy) is decode-only |
| 1 | `kind` | `0x01` = `KIND_FULL`; `0x02` = `KIND_BLIND` |
| 2 | `noteSecret` (full) / `noteAddressHash` (blind) | 32 bytes |
| 3 | `value` | Variable-length (no zero-padding) |
| 4 | `tokenId` | 20 bytes |
| 5 | `label` | 32 bytes |

- **Kind dispatch**: callers pick the encoder/decoder per use case; each decoder asserts its expected kind and throws on the other. A cross-kind event surfaces as "not mine" in the silent-skip path.
- **Typical size**: ~92 bytes (small value) to ~124 bytes (32-byte value).

**Blind kind (payment-request notes):** carries `noteAddressHash` instead of `noteSecret`. Payment-request discovery (`scanPaymentRequests`) decodes via `decodePaymentRequestNotePayload`, checks the decoded `noteAddressHash` for membership in the request's local slot map, then **injects the spendable `noteSecret` from that local map** into the discovered note — the secret never travels on-chain. See [note-computation-service.md](./note-computation-service.md) for the rationale (payment-request deanonymization). The wire-kind `blind` is distinct from `ResolvedTransferRecipient.blind` (no Note event at all).

**Payment-request scan set (decoupled from fulfillment status).** The discovery orchestrator scans `PaymentRequestService.getScannableRequests()`, **not** the request's display status. A request's public payload (`tag`, `paymentPubKey`, `noteAddressHashes`, `tokenId`) is by design shareable, so any holder can craft a decryptable matching Note event. Gating the scan on a `FULFILLED` flip would let a cheap dust phantom drive the request terminal and suppress the genuine sender's later payment note (finding #600). Instead:

- **`FULFILLED` is display state only** and never removes a request from the scan set. It is driven by consumed-slot accounting: `markFulfilled` advances fulfillment only when a match is genuine — a non-zero-value note landing on a request-owned, still-unused slot. A 0-value or duplicate-slot phantom is recorded in the audit trail (`fulfilledByCommitments`) but does not consume a slot (`consumedSlots`) or advance status.
- **The scan set is bounded only by the recipient or by time**, never by an attacker-craftable trigger. A request leaves the scan set when the recipient calls `archive(paymentId)` (terminal `ARCHIVED` status) or when it passes its expiry stamp. `getScannableRequests()` returns every live request — `OPEN` or `FULFILLED` — that is neither archived nor expired.

  **Expiry is stamped, not recomputed.** `generate` writes `expiresAt = createdAt + requestExpiryMs` (default 7 days) onto the record, and `isExpired` compares against that stamp. It is deliberately *not* derived from `createdAt` on each scan: doing so would apply the window **retroactively**, so introducing or shortening it would silently drop already-shared requests out of the scan set on upgrade — recreating the exact invisible-payment failure #600 exists to prevent. A persisted record carrying **no** `expiresAt` predates the policy and never expires.

  **Expiry is shared with the sender and enforced against them.** `expiresAt` is a field on the public, shareable `PaymentRequest` payload — not merely on the recipient's local record — and `PoolSession.prepareFulfillPaymentRequest` throws `PaymentRequestExpired` when it has passed, before any proof work. Both halves are required. Surfacing the deadline in a UI alone would not be sufficient: the SDK is the layer that can actually refuse to spend, and paying a lapsed request produces a note that is on-chain, valid, and — once the recipient's grace window has also passed — undiscoverable through this path (catch-all discovery is unaffected). A request carrying no `expiresAt` predates the policy and never lapses, so already-shared requests are never retro-voided. The field is optional in the wire format, so older QR/link payloads still parse. `generatePaymentRequest` — the only path that produces the shareable payload — must carry the stamp through; omitting it silently makes every issued request unexpirable to the sender while the recipient still drops it (shortly after `expiresAt`), which is the same invisible-payment loss.

  **Errors (all value-exported for `instanceof`).** `PaymentRequestBaseError` (base), `PaymentRequestExpired`, `InvalidPaymentRequestParams`, `PaymentRequestNotFoundError`, `InvalidPaymentRequestState`. Value-exported rather than type-only for the same reason the expiry check lives in the SDK at all: a caller has to be able to tell "this link lapsed, ask for a new one" apart from a validation failure, and under `export type *` alone every one of these is `undefined` at runtime and `instanceof` is always false. Guarded by `test/unit/publicBarrel.test.ts`. The two time bounds, `DEFAULT_REQUEST_EXPIRY_MS` and `SCAN_EXPIRY_GRACE_MS`, are value-exported alongside them so a UI can state both accurately.

  **What the sender-side check is, and is not.** The shareable `PaymentRequest` is **unauthenticated** — it carries no signature, so nothing binds `expiresAt` (or `tag`, or `paymentPubKey`) to the recipient who issued it. The sender's refusal is therefore a **staleness guard, not a security control**: it reliably stops an honest sender from paying a link the recipient has genuinely aged out, which is the #600 failure mode, but it cannot resist an attacker who rewrites the payload in transit. That is not a regression this field introduces — anyone able to rewrite `expiresAt` can rewrite `tag` and `paymentPubKey` and redirect the payment outright, which strictly dominates. Authenticating the payload end-to-end is the fix for *that* problem and is out of scope here; it should not be conflated with this one.

  **The recipient scans past the deadline; the sender does not.** `isExpired` compares against `expiresAt + SCAN_EXPIRY_GRACE_MS` (24h), while the sender-side guard refuses at `expiresAt` exactly. The two bounds are *meant* to disagree, with the recipient's strictly the later: a sender who passes their check moments before the deadline still has to prove, submit, and be included, and a scan set that closed at `expiresAt` exactly would leave that legitimate payment on-chain but unseen. The grace sits on the recipient side only — widening the scan set can only surface more of the user's own notes, whereas widening the sender's window would let it issue payments the recipient has genuinely stopped watching for. Both constants live in `src/constant/PaymentRequest.ts`; the bound stays time-based and finite, which is what #600 requires (bounded by the recipient or by time, never by an attacker-craftable flip).