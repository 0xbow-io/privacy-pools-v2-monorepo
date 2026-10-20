# NoteComputationService

### NoteComputationService

NoteComputationService is a stateless service that centralizes the shared Poseidon hash chain computations, the RLP-based NotePayload codec, and NoteData generation (encode + encrypt + wrap). It is the single source of truth for how shared protocol-specific hashes are computed (noteAddressHash, precommitment, label, fullCommitment, authDigest) and how note payloads are serialized, encrypted, and packaged into the on-chain `NoteData` tuple.

Previously all hash computations were private methods inside WitnessPreparationService. The shared ones have been extracted into NoteComputationService so multiple consumers can reuse them without duplication: WitnessPreparationService (witness construction), PoolSessionTransact (output note hashing), PoolSessionKeystore (key registration hashing), and NoteDiscoveryService (commitment recomputation and payload decoding during note discovery). Hash computations that are only used by a single consumer remain private in that consumer: commitment, nullifier, keystoreLeaf, timestampedLeaf, and labelHash are private helpers in WitnessPreparationService; nullifyingKeyHash is a private helper in PoolSessionKeystore.

NoteComputationService has no state and no side effects. Every method is a pure function of its inputs (aside from the ephemeral key generation inside `generateNoteData`, which delegates to CryptoService).

# Dependencies

| Dependency | Why |
| --- | --- |
| **HashService** | All hash chain methods delegate to `HashService.poseidon()` for the underlying Poseidon hash computation. NoteComputationService defines *what* to hash (the protocol-specific input ordering and chaining); HashService defines *how* to hash (the Poseidon permutation). |
| **CryptoService** | Used by `generateNoteData` to generate an ephemeral key pair, compute an ECDH shared secret with the recipient's viewing public key, and encrypt the RLP-encoded NotePayload. |

# Methods

---

## Hash Chain Methods

**`computeNoteAddressHash(ownerAddressField, noteSecret) -> Hash`**

Computes `Poseidon(ownerAddressField, noteSecret)`. Binds a note to its owner without revealing the owner's address on-chain.

| Param | Type | Description |
| --- | --- | --- |
| `ownerAddressField` | `Hex` | The note owner's address, already converted to a field-sized value (see `IAddressFieldConverter`). For EVM, this is the same 20-byte address as-is — `Address` and `Hex` are the same underlying type — so an EVM caller's conversion is an identity function. A future non-EVM chain whose address type isn't itself field-sized (e.g. Stellar's StrKey) converts it before calling. |
| `noteSecret` | `Secret` | Random secret binding the note to its owner. |

**Returns:** `Hash` — The note address hash.

---

**`computePrecommitment(noteAddressHash, tokenIdField, value) -> Hash`**

Computes `Poseidon(noteAddressHash, tokenIdField, value, METADATA_STANDARD)`. Binds the note to its token and value.

| Param | Type | Description |
| --- | --- | --- |
| `noteAddressHash` | `Hash` | Output of `computeNoteAddressHash`. |
| `tokenIdField` | `Hex` | Token identifier, already converted to a field-sized value (see `IAddressFieldConverter`). For EVM, identical to the raw ERC-20/native-asset address. |
| `value` | `Hex` | Amount in smallest unit. |

**Returns:** `Hash` — The precommitment hash.

---

**`computeLabel(precommitment, depositSecret) -> Hash`**

Computes `Poseidon(precommitment, depositSecret)`. Derives the label that ties a note to its deposit lineage and ASP association set entry.

| Param | Type | Description |
| --- | --- | --- |
| `precommitment` | `Hash` | Output of `computePrecommitment`. |
| `depositSecret` | `Secret` | Random secret for private label computation. |

**Returns:** `Hash` — The label.

---

**`computeFullCommitment({ noteAddressHash, tokenId, value, label }) -> Hash`**

Computes the full commitment in one call: internally derives `precommitment = Poseidon(noteAddressHash, tokenId, value, METADATA_STANDARD)` then returns `Poseidon(precommitment, label)`. Convenience method for callers that have all four fields but do not need the intermediate precommitment.

| Param | Type | Description |
| --- | --- | --- |
| `noteAddressHash` | `Hash` | Output of `computeNoteAddressHash`. |
| `tokenId` | `Hex` | Token identifier, already converted to a field-sized value (see `IAddressFieldConverter`). Field name is unchanged; only the type widened from `Address` to `Hex`. For EVM, identical to the raw ERC-20/native-asset address. |
| `value` | `Hex` | Amount in smallest unit. |
| `label` | `Hash` | The note's label. |

**Returns:** `Hash` — The commitment hash.

---

**`computeAuthDigest(privateRevocableKey) -> Hash`**

Computes `Poseidon(AUTH_TYPE_DIRECT_KEY, privateRevocableKey)`. Stored on-chain in the key registry to verify spending authorization inside the circuit.

| Param | Type | Description |
| --- | --- | --- |
| `privateRevocableKey` | `Secret` | The owner's revocable private key. |

**Returns:** `Hash` — The authorizer digest.

---

## NotePayload Codec Methods

Every newly-emitted NotePayload uses wire version `0x02`. A `kind` byte immediately follows the version and selects the field-set: `KIND_FULL` (`0x01`) carries the spend material (`noteSecret`); `KIND_BLIND` (`0x02`) carries only the pre-committed `noteAddressHash`. `decodeNotePayload` also accepts the **legacy v1 layout** (`RLP([0x01, noteSecret, value, tokenId, label])`, no kind byte) for backward compatibility with notes already on-chain; there is no v1 encoder.

**`encodeNotePayload(payload) -> Uint8Array`**

Encodes a NotePayload into the unified RLP binary format: `RLP([0x02, KIND_FULL, noteSecret, value, tokenId, label])`. Used by deposit, sender change, withdraw output, and ordinary discoverable transfers. The `value` field is variable-length (no zero-padding), so typical encoded size ranges from ~92 bytes (small value) to ~124 bytes (32-byte value). Uses viem's `toRlp` internally. The output is passed to `CryptoService.encrypt()` before being included in on-chain events.

| Param | Type | Description |
| --- | --- | --- |
| `payload` | `NotePayload` | Object with `noteSecret`, `value`, `tokenId`, and `label` fields. |

**Returns:** `Uint8Array` — RLP-encoded payload (variable-length, typically ~92-124 bytes).

---

**`decodeNotePayload(data) -> NotePayload`**

Decodes an RLP-encoded NotePayload (output of `CryptoService.decrypt()`). Dispatches on the version byte:

- `0x01` (legacy v1, **decode-only** — kept for backward compatibility with notes already on-chain): `RLP([0x01, noteSecret, value, tokenId, label])`. No kind byte.
- `0x02` (current): `RLP([0x02, kind, ...])` — asserts `kind === KIND_FULL`, rejects `KIND_BLIND` (payment-request payload) by throwing `PayloadDecodeError`. The silent-skip path in discovery treats a thrown decode as "not mine."

Any other version is rejected. New payloads are always emitted at `0x02` via `encodeNotePayload`; there is no v1 encoder. Uses viem's `fromRlp` internally.

| Param | Type | Description |
| --- | --- | --- |
| `data` | `Uint8Array` | The RLP-encoded payload after decryption. |

**Returns: `NotePayload`**

| Field | Type | Description |
| --- | --- | --- |
| `noteSecret` | `Secret` | The note's random secret. |
| `value` | `Hex` | Token amount in smallest unit. |
| `tokenId` | `Address` | Token identifier. |
| `label` | `Hash` | The note's label. |

---

**`encodePaymentRequestNotePayload(payload) -> Uint8Array`** / **`decodePaymentRequestNotePayload(data) -> PaymentRequestNotePayload`**

The blind-kind codec used exclusively for **payment-request notes**: `RLP([0x02, KIND_BLIND, noteAddressHash, value, tokenId, label])`. It carries the pre-committed `noteAddressHash` instead of the `noteSecret` — because the payment-request recipient already holds the matching secret locally (on its `PaymentRequestRecord`), the secret never travels to the sender or onto the chain. At discovery the recipient decodes this payload, confirms the `noteAddressHash` is one of its slots, and looks the spendable secret up from its local map. `decodePaymentRequestNotePayload` asserts version `0x02` and kind `KIND_BLIND`; `decodeNotePayload` asserts kind `KIND_FULL`, so the two kinds never cross-decode.

> The wire-kind name `blind` (no `noteSecret` in the payload) is independent of the `ResolvedTransferRecipient.blind` variant (which means "no on-chain Note event is emitted at all"). Different layers, same English word — context disambiguates.

| Field | Type | Description |
| --- | --- | --- |
| `noteAddressHash` | `Hash` | The recipient's pre-committed `Poseidon(recipientAddress, noteSecret)` slot. |
| `value` | `Hex` | Token amount in smallest unit. |
| `tokenId` | `Address` | Token identifier. |
| `label` | `Hash` | The note's label. |

---

## NoteData Generation

**`generateNoteData(payload, recipientViewingPubKey) -> NoteData`**

End-to-end helper that produces the on-chain `NoteData` tuple from a NotePayload and a recipient's viewing public key. Internally it: (1) RLP-encodes the payload via `encodeNotePayload`, (2) generates an ephemeral key pair via `CryptoService`, (3) computes an ECDH shared secret between the ephemeral private key and `recipientViewingPubKey`, (4) encrypts the encoded payload with the shared secret, and (5) returns the `{ hint, data }` tuple where `hint` is derived from the ephemeral public key and `data` is the encrypted ciphertext. This method was previously duplicated in PoolSessionDeposit and PoolSessionTransact; both now delegate here.

| Param | Type | Description |
| --- | --- | --- |
| `payload` | `NotePayload` | The note payload to encode and encrypt (noteSecret, value, tokenId, label). |
| `recipientViewingPubKey` | `PublicKey` | The recipient's viewing public key, used for ECDH key agreement. |

**Returns: `NoteData`**

> **`generatePaymentRequestNoteData(payload, recipientViewingPubKey, hint?)`** is the v2 counterpart: identical ephemeral-ECDH-encrypt-wrap pipeline (both share a private `encryptAndWrap` helper) but encodes a `PaymentRequestNotePayload` (no secret). Used by `TransactOrchestrator.buildNotesData` for the discoverable-without-secrets recipient.

| Field | Type | Description |
| --- | --- | --- |
| `hint` | `Hex` | Discovery hint derived from the ephemeral public key, allowing the recipient to identify incoming notes. |
| `data` | `Hex` | Encrypted RLP-encoded NotePayload. |

---

# NotePayload RLP Format

Every NotePayload **emitted** by the SDK uses version `0x02`. A `kind` byte
follows the version and selects which fields appear after it. `decodeNotePayload`
additionally accepts a legacy v1 layout (decode-only, no kind byte) so notes
already on-chain stay discoverable:

```
RLP([0x02, kind, ...fields])
```

| `kind` | constant | fields after `[version, kind]` | used by |
| --- | --- | --- | --- |
| `0x01` | `KIND_FULL` | `[noteSecret, value, tokenId, label]` | deposit, sender change, withdraw output, ordinary discoverable transfer |
| `0x02` | `KIND_BLIND` | `[noteAddressHash, value, tokenId, label]` | payment-request notes only |

Both kinds carry 4 trailing fields (6 RLP list items total). The encoders emit
the version+kind bytes directly; the decoders assert both and reject anything
else — there is no version `0x01` and no unrecognized kind on the wire.

| Index | Field | Encoding |
| --- | --- | --- |
| 0 | `version` | `0x02` (constant) |
| 1 | `kind` | `0x01` (`KIND_FULL`) or `0x02` (`KIND_BLIND`) |
| 2 | `noteSecret` (full) / `noteAddressHash` (blind) | 32 bytes |
| 3 | `value` | Variable-length (no zero-padding) |
| 4 | `tokenId` | 20 bytes |
| 5 | `label` | 32 bytes |

- **Kind dispatch**: callers pick the encoder/decoder per use case (`encodeNotePayload` ↔ `KIND_FULL`; `encodePaymentRequestNotePayload` ↔ `KIND_BLIND`). Each decoder asserts its expected kind and throws `PayloadDecodeError` on the other, so cross-kind events surface as "not mine" in discovery.
- **Legacy v1 (decode-only)**: `decodeNotePayload` also accepts `RLP([0x01, noteSecret, value, tokenId, label])` — no kind byte, 4 trailing fields. Used to keep notes already on-chain discoverable. The SDK has no v1 encoder; new payloads always go out at version `0x02`.
- **Typical size**: ~92 bytes (small value) to ~124 bytes (32-byte value), depending on the `value` field length.
- **Implementation**: Uses viem's `toRlp` / `fromRlp`.

The blind kind exists so a payment-request sender can publish a discoverable on-chain note **without ever holding the recipient's secret**: `noteAddressHash = Poseidon(recipientAddress, noteSecret)`, so co-locating the secret and the hash in the shareable request would let anyone confirm a candidate recipient address with a single Poseidon hash. The recipient keeps the secret local and reconstructs the spendable note at discovery by looking it up from its slot map.

## Version History

| Version | Change |
| --- | --- |
| 1.3.0 | 2026-09-08 — `computeNoteAddressHash`'s `ownerAddress` param and `computePrecommitment`'s `tokenId` param widened from concrete EVM `Address` to `Hex` (a value already converted to a field element via the new `IAddressFieldConverter` seam), renamed to `ownerAddressField` / `tokenIdField` to reflect this; `computeFullCommitment`'s `tokenId` field keeps its name but is likewise widened to `Hex`. Doc-only impact for EVM: `Address` and `Hex` are the same underlying type, so behavior and call sites are unchanged. This is prep infrastructure for a future non-EVM chain (e.g. Stellar) whose raw address type is not itself field-sized; no such chain is implemented yet. `NotePayload.tokenId` (the wire-format token identifier) is unaffected and stays concrete `Address`. |
| 1.2.0 | 2026-05-28 — New NotePayloads are emitted at wire version `0x02` with a `kind` byte selecting the field-set: `KIND_FULL` (`noteSecret` inline) and `KIND_BLIND` (`noteAddressHash` only, payment-request). The v1 (`0x01`) layout is decode-only — `decodeNotePayload` still accepts it for backward compatibility with notes already on-chain — but the SDK no longer emits it. Each v2 decoder asserts its expected kind; cross-kind events throw `PayloadDecodeError` and surface as "not mine" in discovery. API names unchanged (`encodeNotePayload` ↔ full, `encodePaymentRequestNotePayload` ↔ blind). |
| 1.1.0 | 2026-05-27 — Added the v2 payment-request codec (`encodePaymentRequestNotePayload` / `decodePaymentRequestNotePayload` / `generatePaymentRequestNoteData`) carrying `noteAddressHash` instead of `noteSecret`. Extracted the shared `encryptAndWrap` helper. v1 and v2 decoders reject each other's version byte. Closes the payment-request deanonymization vector where the shareable request co-located `(noteAddressHash, noteSecret)` pairs. |
| 1.0.0 | Initial spec. |
