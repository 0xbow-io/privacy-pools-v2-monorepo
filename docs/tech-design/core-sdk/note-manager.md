# NoteManager

NoteManager is the stateful core of the SDK's note lifecycle. It owns the canonical set of all notes belonging to the account—every deposit, every incoming transfer, every change note—and tracks each note through its lifecycle. The valid state transitions are:

- **INACTIVE** → PENDING | EXITED
- **PENDING** → ACTIVE | REJECTED | EXITED
- **ACTIVE** → SPENT | REJECTED | EXITED
- **REJECTED** → ACTIVE | SPENT | EXITED
- **SPENT** — terminal state
- **EXITED** — terminal state

The normal flow is INACTIVE → PENDING → ACTIVE → SPENT. Any non-terminal note (INACTIVE, PENDING, ACTIVE, or REJECTED) can transition to EXITED via ragequit, which serves as the ultimate failsafe for fund recovery — including notes rejected by the ASP, whose owners may still ragequit on-chain. No other service reads or writes note state directly; all note mutations flow through NoteManager.

**REJECTED is not terminal.** ASP label-status is reversible, so a note demoted to REJECTED when its label was revoked can be legitimately re-approved on a later scan. Two guarded recovery edges leave REJECTED, both driven only by `PoolSessionNoteDiscovery.syncNotesStatus` and only *after* on-chain spend reconciliation has run: `REJECTED → SPENT` lets the reconciliation demote a rejected note that was nonetheless spent on-chain, and `REJECTED → ACTIVE` re-activates a note whose label is approved again. Re-activation is gated on the note's nullifier being confirmed *not* spent on-chain — reconciliation resolves any spent note to SPENT first — so an already-spent note can never be double-counted back into the spendable balance (RC-04 #501/#540). The demotion into REJECTED is itself corroborated against the ASP association set before it is applied, so a single unverified "rejected" response cannot strand a spendable note.

Both guards read from sources the ASP cannot forge, which is what makes them guards rather than restatements of the ASP's own claim:

- **Corroboration** uses `IASPClient.getAssociationSetLeaves()`, which reconstructs the LeanIMT root from the returned leaves and asserts it against the on-chain `latestASPRoot` — *not* the raw `IASPDataProvider.getLeaves()` HTTP endpoint, which performs no verification. The ASP is trusted infrastructure, so this is not an anti-malice measure — it is a freshness and consistency one. Label status and leaves are separate reads that can disagree (a lagging replica, a snapshot served mid-rebuild, a cache holding a superseded set), so corroborating a rejection against an unverified leaf set from the same service can simply confirm a stale view of itself. Root-checking against the chain is what makes the second read independent evidence. A leaf set that fails root verification is treated as unavailable: the demotion is deferred to a later scan rather than applied.
- **The spend check** confirms against `PoolVault.spentNullifiers` (via `getNullifierTimestamp`) before re-activating. The reconciled event-derived nullifier set is only a first filter: it is built from the ASP snapshot plus a chain tail, so a snapshot that lags the chain can omit a recent spend, and when the snapshot fetch fails the chain scan resumes from the sync cursor rather than deployment, leaving older spends invisible. The on-chain read fails **closed** — an RPC error defers recovery, which is safe because the note simply stays REJECTED and is retried next scan. The reads are issued in bounded batches (8 in flight) rather than all at once: a mass revocation is exactly when there are hundreds to check and exactly when an unbounded burst of `eth_call`s gets rate-limited, and since each rejection fails closed a throttled burst would recover nothing at all.

Beyond raw storage, NoteManager maintains lineage relationships. Every note traces back to a deposit via its label. When a deposit creates a note, that note begins a lineage. When that note is spent in a transfer, the resulting change note and recipient note inherit the same label. Lineage is a flat collection of all notes sharing the same label—there is no parent-child tree structure. NoteManager groups notes by label so the SDK can answer questions like "show me all notes from this deposit" or "what is the total balance under this label."

NoteManager does **not** fetch events or run ECDH scans itself. Discovery is orchestrated by `PoolSessionNoteDiscovery`, which fetches `NoteEvent`s via the PoolVault interactor, delegates scanning to `NoteDiscoveryService`, and then hands the resulting notes back to `NoteManager.addNote()`. What NoteManager does own is the **sync cursor** — the last processed block — exposed via `getSyncCursor()` / `setSyncCursor()` so the orchestrator can resume incremental scans.

Balance aggregation is a read-side concern handled entirely within NoteManager. It filters ACTIVE notes, groups by tokenId or label as requested, and sums values. No external service is needed because all note data lives here.

# **Dependencies**

NoteManager depends on `INoteStorageAdapter` for optional persistence (`flush()` / `loadFromStorage()`) but has no other runtime dependencies — it is deliberately kept free of network or crypto responsibilities.

# **Methods**

---

**`addNote(note) → void`**

Inserts a new note into the internal state and groups it into its label's lineage. If no lineage exists for the note's label yet, a new one is created. The label used for lineage grouping is taken from `note.label`.

`addNote` is conflict-aware. The commitment is identity. If a note with the same commitment is already stored, `addNote` compares the two for identical identity — `noteAddressHash`, `tokenId`, `value`, `label`, `ownerAddress`, `noteSecret`, all via `BigInt` so hex padding and case do not matter. An identical re-add (e.g. a reorg re-delivering the same note) is a no-op: the **stored** note is kept, so a `SPENT` or `EXITED` note is never downgraded back to the incoming status. A commitment shared by two notes with different identity fields means one is forged or inconsistent, so `addNote` throws `NoteConflictError`. This closes a prior bug where re-adding a commitment double-pushed it into the lineage and double-counted its value in `totalValue`.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `note` | `Note` | The note object containing: commitment (commitment hash), value, tokenId, label, ownerAddress, noteSecret, isOwned, status, createdAtBlock, txHash. |

**Returns:** void

---

**`updateNoteStatus(**commitment**, status) → void**`

Transitions a note to a new lifecycle status. Validates the transition is legal (e.g. cannot go from SPENT back to ACTIVE). Records the block number for terminal transitions (SPENT, EXITED).

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `commitment` | `Hash` | Commitment hash identifying the note to update. |
| `status` | `NoteStatus` | New status: INACTIVE, PENDING, ACTIVE, SPENT, or EXITED. |

**Returns:** void

---

**`getNotes(filters?) → Note[]`**

Returns all notes matching the given filters. If no filters are provided, returns all notes regardless of status.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `status` | `NoteStatus?` | Filter by lifecycle status. |
| `label` | `Hash?` | Filter by label. Returns only notes within a specific deposit lineage. |
| `tokenId` | `Address?` | Filter by token identifier. |

**Returns: `Note[]`**

Array of Note objects matching all provided filters (AND logic). Each Note contains: `commitment`, `value`, `tokenId`, `label`, `status`, `ownerAddress`, `noteSecret`, `isOwned`, `createdAtBlock`, `spentAtBlock?`, `txHash`.

---

**`getNote(**commitment**) → Note**`

Returns a single note by its commitment hash. Throws if the note does not exist.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `commitment` | `Hash` | Commitment hash identifying the note. |

**Returns: `Note`**

The full Note object with all fields.

---

**`getNoteLineage(label) → NoteLineage`**

Returns the complete lineage for a given label. The lineage is a flat collection of all notes sharing that label.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `label` | `Hash` | The label identifying the deposit lineage to retrieve. |

**Returns: `NoteLineage`**

| Field | Type | Description |
| --- | --- | --- |
| `label` | `Hash` | The label this lineage belongs to. |
| `tokenId` | `Address` | Token identifier for all notes in this lineage. |
| `depositSecret` | `Secret?` | The secret bound into `label = Poseidon(precommitment, depositSecret)` at deposit time. Present only when the current wallet originated this lineage via deposit; `undefined` on lineages received via transfer, payment request, or note discovery (the original depositor was the only party to ever hold this value). |
| `notes` | `Note[]` | All notes in this lineage, ordered by discovery time. |
| `activeNotes` | `Note[]` | All notes in this lineage with ACTIVE status. |
| `totalValue` | `Hex` | Sum of all ACTIVE note values in this lineage. |

---

**`getAllLineages() → NoteLineage[]`**

Returns all lineages tracked by NoteManager. Each lineage corresponds to one deposit. No params.

**Returns: `NoteLineage[]`**

Array of all NoteLineage objects.

---

**`computeAggregates(lineage) → void`**

Recomputes cached aggregate values (totalValue, activeNotes) for a given lineage. Called internally after note mutations. Iterates the lineage's notes and sums ACTIVE note values.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `lineage` | `NoteLineage` | The lineage to recompute aggregates for. Modified in place. |

**Returns:** void

---

**`getSyncCursor() → Hex`**

Returns the last processed block (as a hex string). Used by `PoolSessionNoteDiscovery` to resume incremental event scans.

---

**`setSyncCursor(blockNumber) → void`**

Advances the sync cursor after a successful discovery run.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `blockNumber` | `Hex` | New sync cursor (hex-encoded block number). |

---

**`flush() → Promise<void>`**

Immediately persists all pending state via the injected `INoteStorageAdapter`. Call before process exit or page unload.

---

**`loadFromStorage() → Promise<void>`**

Loads previously persisted note state into memory. No-op when no storage adapter is configured. Must be called before using the NoteManager when persistence is desired.

---

**At-rest encryption (opt-in)**

By default the injected `IStorageService` backend (`FileStorageService` / `LocalStorageService`) persists note state — including note secrets and the full shielded-note graph — in **cleartext**. For at-rest secret protection (RC-03), the SDK ships `EncryptedStorageService`, a decorator that wraps any inner `IStorageService` and XChaCha20-Poly1305-encrypts every stored **value** under a key derived from a caller-supplied runtime passphrase via scrypt (RFC 7914). Keys pass through unchanged (only values are encrypted); the passphrase and raw derived key are never persisted. It is entirely opt-in and never the default — supply it via `PoolSessionBuilder.withEncryptedStorage({ inner, passphrase })` (or `.withStorageService(new EncryptedStorageService(...))`). Correspondingly, `PoolSession.exportAccount` returns cleartext secrets and must be sealed by the caller; `PoolSession.exportAccountSealed(passphrase)` / `importAccountSealed(sealed, passphrase)` provide an AEAD-sealed export/restore round-trip.

The at-rest errors are **value-exported for `instanceof`**: `EncryptedStorageBaseError` (base), `InvalidAtRestPassphrase`, `AtRestDecryptionError`, `InvalidEncryptedRecord`. A caller opening an encrypted store has to distinguish a wrong passphrase (retryable — prompt again) from a tampered or transplanted record (not retryable), which a type-only export makes impossible. Guarded by `test/unit/publicBarrel.test.ts`.

Each record is **bound to its storage key**. The record marker, format version, and the record's logical storage key are authenticated as AEAD associated data, so a ciphertext only opens at the key it was written to. Without that binding a record is authenticated by the derived key alone, and an attacker with **write** access to the backing store could transplant a valid record between keys — across owners, chains, or record kinds — and it would decrypt cleanly, substituting one account's state for another's. The plaintext storage key and the `m` marker are unauthenticated metadata on their own; folding them into the associated data is what makes them tamper-evident.

---

**`deleteNote(commitmentHash) → void`**

Removes a note from local state and its lineage. Reserved for the phantom-note purge path on `PoolSessionNoteDiscovery.purgePhantomNotes()` — it drops locally-persisted notes whose commitment was never inserted on-chain (decryption garbage written by earlier SDK builds during the alt-parity / Curve25519 transition). Not part of the normal note lifecycle, which is status-only. When the deleted note was the last in its lineage, the lineage is removed; otherwise lineage aggregates are recomputed.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `commitmentHash` | `Hash` | Commitment hash identifying the note to remove. |

**Returns:** void

---

**`updateNote(oldCommitment, newCommitment, newValue) → void`**

Replaces a note's commitment and value, re-keying internal storage. Used when a note's value changes after initial insertion (e.g. fee adjustment during relay), which also changes its commitment.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `oldCommitment` | `Hash` | Current commitment hash identifying the note. |
| `newCommitment` | `Hash` | New commitment hash after value change. |
| `newValue` | `Hex` | Updated note value. |

---

**`exportState() → NoteManagerExport`**

Serializes all note state for account export. No params.

**Returns: `NoteManagerExport`**

| Field | Type | Description |
| --- | --- | --- |
| `notes` | `Note[]` | All notes with their current statuses. |
| `syncCursor` | `Hex` | Last synced block number. |

---

**`importState(data) → void`**

Restores note state from a previous export. Rebuilds the internal lineage groupings from the serialized data. If either `notes` or `syncCursor` is missing or malformed, **both** fields are reset together (empty notes + zero cursor) to force a full rescan. Decoupling them would allow a silent data-loss path where a retained cursor skips past the blocks that contain the wiped notes.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `data` | `NoteManagerExport` | Previously exported state from `exportState()`. |

**Returns:** void

---

# **Version History**

| Version | Date | Description |
| --- | --- | --- |
| 1.0 | — | Initial version. |
| 1.1 | 2026-04-16 | Flatten lineage structure: remove `parentCommitmentHash` from `Note` and `addNote`, replace tree-based `NoteLineageNode` with flat `notes: Note[]` in `NoteLineage`, update `exportState`/`importState` descriptions. |
| 1.2 | 2026-04-21 | Allow `REJECTED → EXITED` transition so ASP-rejected notes can still ragequit; `importState` now resets `notes` and `syncCursor` together when either is missing/malformed to prevent silent data loss. |
| 1.3 | 2026-04-23 | Align with shipped `INoteManager`: note discovery orchestration moved to `PoolSessionNoteDiscovery`; replace documented `sync` / `discoverTargeted` / `discoverCatchAll` methods with `getSyncCursor` / `setSyncCursor` / `flush` / `loadFromStorage` / `updateNote`; drop `NoteDiscoveryService` dependency. |
| 1.4 | 2026-05-12 | Add `deleteNote(commitmentHash)` for the phantom-note purge path on `PoolSessionNoteDiscovery.purgePhantomNotes()`. Removes notes whose commitment was never inserted on-chain (decryption garbage from earlier SDK builds). Not part of the normal lifecycle. |
| 1.5 | 2026-05-14 | Note that the public surface for integrator-broadcast registration is `PoolSession.addNote` (delegated to the new `PoolSessionNoteManager` facade), not direct `NoteManager.addNote` calls. The facade resolves `createdAtBlock` on-chain and inserts the note with `status = PENDING`; subsequent `discoverNotes()` promotes it to `ACTIVE`. Add `PoolSession.markNoteSpent` companion that wraps `updateNoteStatus(_, SPENT)` for the input-side bookkeeping required by transact / withdraw / ragequit external broadcast. (0XB-1135) |
| 1.6 | 2026-05-27 | Externally-broadcast bookkeeping surface is batch-shaped: `PoolSession.addNotes`, `markNotesSpent`, `markNotesExited`. `addNotes` rejects `pendingNote.isOwned === false` at the schema boundary so recipient outputs cannot pollute the sender's NoteManager; timestamps are resolved in parallel and validated before any mutation, with a single flush at the end. `markNotesExited` accepts `ACTIVE → EXITED` and `REJECTED → EXITED` (the failsafe path for ASP-rejected notes) and is the correct companion for ragequit broadcasts — `markNotesSpent` on a ragequit'd commitment would later wedge `discoverNotes` via the `SPENT → EXITED` invariant. `PoolSessionRagequit.executeRageQuit` now transitions `ACTIVE → EXITED` locally on successful receipt (gated on `txReceipt.status`), aligning the SDK-broadcast path with the spec step in `sdk-tech-design.md`; `PrepareRageQuitResult` gains `commitment: Hash` so `executeRageQuit` and `markNotesExited` can close the loop without out-of-band state. (0XB-1135) |
| 1.7 | 2026-05-27 | Addressed Auditware AW-L-05. `NoteLineage.depositSecret` is now optional (`Secret?`) and surfaces the real `depositSecret` from the deposit's `PendingNote` instead of the unrelated `noteSecret` value that `addNote` used to copy in. `PendingNote` carries a new optional `depositSecret` populated only by `PoolSessionDeposit.prepareDeposit` for the originating deposit; received notes (transfer / payment-request / discovery) leave it absent. `InternalLineage.depositSecret` is optional too, so `undefined` flows unchanged from the note through to the public `NoteLineage` — received-only lineages no longer expose a wrong value. |
| 1.8 | 2026-06-01 | `addNote` is now conflict-aware: when the commitment already maps to a note, it compares identity (`noteAddressHash`, `tokenId`, `value`, `label`, `ownerAddress`, `noteSecret` via `BigInt`). Identical identity is a no-op that keeps the **stored** note, never downgrading a `SPENT`/`EXITED` note back to the incoming status; differing identity throws the new `NoteConflictError`. Fixes a prior bug where re-adding a commitment double-pushed it into the lineage and double-counted its value in `totalValue`. |
| 1.9 | 2026-07-30 | Addressed ConsenSys RC-04 (#501/#540). `REJECTED` is no longer near-terminal: the transition matrix gains guarded `REJECTED → ACTIVE` and `REJECTED → SPENT` edges (also documented in the transition list above). ASP label-status is reversible, so `PoolSessionNoteDiscovery.syncNotesStatus` now recovers a rejected note to ACTIVE when its label is re-approved AND its nullifier is confirmed unspent on-chain — reconciliation resolves any spent note to SPENT first, guarding against double-counting a spent note back into the balance. The demotion into REJECTED is corroborated against the ASP association set before being applied, so one unverified "rejected" response can no longer strand a spendable note. |
| 1.10 | 2026-07-30 | Document opt-in AEAD-sealed at-rest storage (RC-03 #281/#360): `EncryptedStorageService` decorator over any `IStorageService` (scrypt-derived passphrase key, XChaCha20-Poly1305, values-only encryption), wired via `PoolSessionBuilder.withEncryptedStorage(...)`; flag `exportAccount` cleartext-secret risk and add sealed `exportAccountSealed` / `importAccountSealed`. Additive and non-default. |
| 1.11 | 2026-08-14 | Strengthen both RC-04 (#501/#540) guards, which were weaker than documented. Corroboration now reads `IASPClient.getAssociationSetLeaves()` (LeanIMT root re-derived and asserted against the on-chain `latestASPRoot`) instead of the unverified raw `IASPDataProvider.getLeaves()` — previously a stale or mid-rebuild snapshot from the same service could confirm the very rejection it was meant to corroborate, so the corroboration was not actually anchored on anything the ASP does not serve. The ASP is trusted, so the concern is freshness and consistency, not malice. `REJECTED → ACTIVE` recovery now confirms the nullifier against `PoolVault.spentNullifiers` directly rather than trusting the event-derived set (which a lagging snapshot can under-report, and which starts at the sync cursor when the snapshot fetch fails). Both fail closed: unverifiable state defers the transition rather than applying it. |
| 1.12 | 2026-08-14 | Bind each encrypted at-rest record to its storage key (RC-03 #281/#360 follow-up). The record marker, format version, and logical storage key are now authenticated as AEAD associated data, so a sealed record only opens at the key it was written to. Previously a record was authenticated by the derived key alone, letting anyone with write access to the backing store transplant a valid ciphertext between keys (across owners, chains, or record kinds) and have it decrypt cleanly. No migration path is required: the feature is opt-in, was introduced on this branch, and the SDK is unreleased, so no ciphertext exists in the wild. |
| 1.13 | 2026-08-15 | Bound the RC-04 (#501) recovery fan-out. The authoritative `PoolVault.spentNullifiers` reads were issued as one `Promise.all` over every candidate; the mass-revocation case that motivates batching is the same case that makes an unbounded burst harmful, since hundreds of simultaneous `eth_call`s are what providers rate-limit and every rejection is mapped to fail-closed — so a throttled burst would recover nothing. Now issued 8 at a time; every candidate is still checked. |
