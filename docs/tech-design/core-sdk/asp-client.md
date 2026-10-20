# ASPClient

ASPClient is the stateless service for ASP data fetching. It retrieves association set roots, leaves, merkle proofs, label statuses, and the ASP's public key. Pure data access—encryption for the ASP is handled at the orchestration level.

### IPFS Fallback

The ASP publishes association set labels for each root to IPFS on every contract posting. When the ASP API is unavailable, ASPClient transparently falls back to fetching association set data from IPFS using the CID referenced on-chain. This ensures the SDK can always reconstruct the association set and generate Merkle proofs even if the ASP API is down. The fallback is automatic—methods like `getAssociationSetLeaves` and `getMerkleProof` first attempt the ASP API, and on failure, resolve the data from IPFS.

### Integrity guarantees

Off-chain ASP data goes through two layered checks before any caller sees it:

1. **Leaves vs. on-chain root.** `getAssociationSetLeaves` recomputes the LeanIMT root over whatever leaves the active provider returned and compares it to `ASPRegistry.latestASPRoot` read from the chain. A mismatch throws `ASPLeavesRootMismatch` (subclass of `ASPUnavailable`), and the existing `tryProviders` fan-out advances to the next provider. The on-chain root is cached for `ASP_ROOT_CACHE_TTL_MS` (30s) inside `ASPClient` to keep RPC pressure linear under burst. Applies to **all** providers (HTTP and IPFS) — the check is transport-agnostic.
2. **IPFS CID multihash.** `IpfsASPDataProvider` parses the on-chain CID (`multiformats`), recomputes SHA-256 of the bytes returned by the gateway, and verifies the digest matches the multihash embedded in the CID. Mismatch throws `IPFSFetchFailed`; a malformed or unsupported-multihash CID throws `InvalidASPCID`. Both subclass `ASPUnavailable` so the fan-out keeps the same fall-through semantics.

A compromised IPFS gateway or off-chain ASP that returns tampered leaves now fails one of these checks at the boundary, before the leaves reach Merkle-proof generation or the witness builder. CIDs whose multihash is not SHA-256 are rejected outright — we never fetch content we cannot content-verify.

### Event-snapshot validation is per row

`HttpASPDataProvider.getEventSnapshot` validates the payload one row at a time (`parseEventSnapshotTolerant`), not all-or-nothing:

- **The envelope stays strict.** `chainId`, `snapshotBlockNumber`, `generatedAt` and the presence of all five row arrays are required — `snapshotBlockNumber` is the coverage claim every consumer reasons about, and a *missing* array is a claim ("nothing was spent"), not a gap. Any envelope failure throws `ASPUnavailable`.
- **A malformed row is dropped, not fatal.** The arrays are independent: an unparseable `keystoreLeaves` row costs note-status sync nothing, since that sync reads only `transacts` and `ragequits`. Under all-or-nothing validation, one drifted field on one ASP version (a column that turns nullable, a widened enum) cost every client its snapshot at once and pushed each of them onto a full chain-history scan.
- **Only a field a consumer needs can cost a row.** Each row is validated twice: the strict shape first, then a tolerant variant in which every field the SDK does not read — or reads through a documented fallback — degrades to `null`. A row salvaged by the second pass is kept, reported as `degraded`, and costs no coverage, because nothing a consumer reads was lost. The fields the tolerant variant does *not* relax are the load-bearing set: `outputCommitment` for `deposits`, `outputCommitments` + `nullifierHashes` for `transacts`, `commitment` for `ragequits`, and nothing at all for `leaves` / `keystoreLeaves`. A malformed *element* inside one of those arrays is still fatal to the row — a missing nullifier is a missed spend.

  This split is load-bearing itself. A spend row is identified by its nullifiers; `blockNumber` is only the `spentAtBlock` stamp, and `processTransactEvents` has always fallen back to the scan's own `fromBlock` for it (`transact.blockNumber || fromBlockNumber`). Requiring it made that fallback unreachable and turned a cosmetic defect into a lost spend: the note stays `ACTIVE`, the user is invited to spend it twice, and — since the unreadable field is the very one that locates the gap — coverage collapses to nothing and every later sync rescans the whole requested range.
- **`leaves` / `keystoreLeaves` can come back index-holed.** Those two arrays are ordered tree data, and since no SDK consumer reads any of their fields, a row is only ever degraded rather than dropped — but a dropped row (a shape failure the tolerant variant cannot absorb, e.g. a non-object entry) closes the gap and shifts the remainder down: a consumer that rebuilt a LeanIMT by appending them in order would compute a wrong root and every proof from it would fail. Read `leafIndex`, or check `drops`, before treating either array as complete. No SDK consumer reads them today — this is a constraint on the next one.
- **Drops are reported, never silent.** `EventSnapshot.drops` records, per array, how many rows were lost and the lowest `blockNumber` among them (`null` when a dropped row's own `blockNumber` was unusable, i.e. the gap cannot be located). Consumers must shrink the range they treat the snapshot as covering accordingly — see "Note-status sync and snapshot coverage" in [pool-session.md](pool-session.md). This is protection against *accidental* loss (ASP-side schema drift, a partially-indexed array), not against a lying ASP: unlike association-set leaves, snapshot rows are unauthenticated — nothing is checked against an on-chain root — so an ASP that wants a row unseen simply omits it and claims full coverage, and the `blockNumber` the bound is read from sits on the malformed row itself. What catches a lying ASP is elsewhere: note discovery gap-fills from RPC, the phantom purge re-checks every candidate on-chain, and spending an already-spent note fails at proof or submission time.
- **Degraded rows are reported too.** They cost no state and no coverage, but they are the earliest visible sign the ASP payload has drifted; staying silent means discovering it later from a `null` somewhere downstream. Counts are exact per array and separate from `drops`, which continues to mean "state is missing" and is the only input to coverage narrowing.
- **Warnings carry no ASP data.** The single aggregated `warn` names counts, array names, field paths and Zod's shape-only messages. Snapshot rows carry commitments, nullifiers, labels and addresses, and where SDK logs end up is the integrator's decision, so no field value is ever logged to make a parse error readable. Reported issues are capped per array (8) while the dropped counts stay exact — a shared budget would let drops in `deposits` leave `transacts` with a drop count and no field path to explain it.

The same tolerance deliberately does **not** extend to `getNoteEvents`: a dropped note event is a note the user never discovers, and the sync cursor would advance past it. There, one malformed event still fails the batch and note discovery falls back to RPC for that same bounded range. (The pre-existing exception — events whose `encryptedPayload` is empty — carries nothing to decrypt and so loses nothing.)

# Dependencies

| Dependency | Why |
| --- | --- |
| **IASPAdapter** | Injected interface for HTTP communication with ASP APIs. ASPClient calls the adapter methods to fetch association set data and label information. The abstraction allows any HTTP client to be used. |
| **IIPFSAdapter** | Injected interface for fetching data from IPFS. Used as a fallback when the ASP API is unreachable. The adapter resolves CIDs to association set data. Integrators can provide any IPFS gateway or client implementation. |

**Pool scoping.** An ASP can serve several pools on one chain (e.g. an abandoned
deployment next to the live one). `HttpASPDataProvider` therefore requires the
pool's `entrypointAddress` in its config and appends `entrypoint=<address>` to
every chain-scoped request (association-set root and leaves, event snapshot,
note events). Without it the ASP rejects ambiguous queries with HTTP 400, and
the note-events stream could mix events from a stale deployment into note
discovery. `PoolSessionBuilder` supplies the address from the resolved
`DeploymentAddresses`.

# Methods

---

**`getAssociationSetRoot(chainId) → Promise<Hash>`**

Fetches the current association set root for a given chain.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `chainId` | `number` | The chain ID to fetch the association set root for. |

**Returns:** `Hash` — The current association set merkle root.

---

**`getAssociationSetLeaves(chainId) → Promise<Hash[]>`**

Fetches all leaves of the association set merkle tree for a given chain.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `chainId` | `number` | The chain ID to fetch leaves for. |

**Returns:** `Hash[]` — Array of association set leaf hashes (Poseidon(label) values).

---

**`getMerkleProof(chainId, labelHash) → Promise<MerkleProof>`**

Fetches a merkle proof for a specific label hash in the association set.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `chainId` | `number` | The chain ID. |
| `labelHash` | `Hash` | The Poseidon(label) to generate a proof for. |

**Returns: `MerkleProof`**

| Field | Type | Description |
| --- | --- | --- |
| `root` | `Hash` | The association set merkle root. |
| `siblings` | `Hash[]` | Sibling hashes along the path. |
| `pathIndices` | `number[]` | Path indices (0/1) for proof verification. |

---

**`getLabelStatus(label) → Promise<LabelStatus>`**

Checks the status of a label with the ASP.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `label` | `Hash` | The label to check. |

**Returns: `LabelStatus`**

| Field | Type | Description |
| --- | --- | --- |
| `status` | `string` | One of: `"pending"`, `"approved"`, `"rejected"`, `"unknown"`. |
| `timestamp` | `number?` | Unix timestamp of the status update (if available). |

---

**`getASPPublicKey() → Promise<PublicKey>`**

Fetches the ASP's public viewing key used for encrypting label registration payloads. The `HttpASPDataProvider` implementation validates the response shape via `ASPPublicKeyResponseSchema` before returning, so a misconfigured ASP returning a missing / null / non-hex `publicKey` field surfaces a typed `ASPUnavailable` error at the API boundary instead of corrupting downstream ECDH. No params.

**Returns:** `PublicKey` — The ASP's public key for ECDH encryption.

---

**`encryptForASP(payload) → Promise<Hex>`**

Encrypts a payload for the ASP using the ASP's public key. Helper method that internally fetches the ASP public key, generates a **fresh ephemeral X25519 keypair per call**, performs ECDH(ephemeralPrivate, aspPublic), and encrypts. The ciphertext is prefixed with the ephemeral public key — never the depositor's long-term registered viewing key — so on-chain `LabelRegistered` events cannot be joined with `Keystore.setViewingKey` registrations to deanonymize the depositor. This mirrors the ephemeral-key pattern already used by note-discovery encryption.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `payload` | `object` | The data to encrypt, typically `{label, depositCommitment}`. Consumed by the ASP off-chain after decoding `LabelRegistered` events. |

**Returns:** `Hex` — The encrypted ciphertext.

---

# **Version History**

| Version | Date | Description |
| --- | --- | --- |
| 1.0 | — | Initial version. |
| 1.1 | 2026-05-22 | Add cryptographic integrity layer. `getAssociationSetLeaves` now cross-checks the LeanIMT root of provider-returned leaves against on-chain `latestASPRoot` (cached 30s) for both HTTP and IPFS providers — throws `ASPLeavesRootMismatch` on mismatch and falls through to the next provider. `IpfsASPDataProvider` parses CIDs via `multiformats` and verifies the SHA-256 multihash embedded in the CID against the fetched bytes; malformed or non-SHA-256 CIDs are rejected with `InvalidASPCID`. |
| 1.2 | 2026-06-05 | Pool scoping: `HttpASPDataProvider` config gains a required `entrypointAddress`, sent as `entrypoint=<address>` on all chain-scoped endpoints (association-set root/leaves, event snapshot, note events). Required since the ASP serves multiple pools per chain; `PoolSessionBuilder` passes `deployment.entrypointAddress`. |
| 1.4 | 2026-08-20 | Per-row validation is now two-pass: strict shape, then a tolerant variant that degrades every field no consumer reads (or that has a documented fallback) to `null`, so only a load-bearing field can cost a row. Fixes the case where a `transacts` row with an unusable `blockNumber` was dropped — losing the spend, leaving the note `ACTIVE`, and collapsing coverage — even though `processTransactEvents` already falls back to the scan's `fromBlock`. Snapshot row types gain `| null` on the non-essential fields; `parseEventSnapshotTolerant` returns exact per-array `degraded` counts, reported alongside drops in the boundary warning. |
| 1.3 | 2026-08-20 | Event-snapshot payloads are validated per row instead of all-or-nothing (`parseEventSnapshotTolerant` replaces `EventSnapshotSchema` at the boundary): the envelope stays strict, a malformed row is dropped, and `EventSnapshot.drops` reports per-array counts plus the earliest dropped block so consumers shrink their trusted coverage instead of silently accepting a thinner payload (see "Event-snapshot validation is per row" and [pool-session.md](pool-session.md) 1.19.5). Drop warnings carry field paths and shape-only messages, never row values. `getNoteEvents` keeps all-or-nothing validation by design. |
