# WitnessPreparationService

### WitnessPreparationService

WitnessPreparationService encapsulates all protocol-specific computation that transforms raw inputs into structured witnesses ready for proof generation. A witness is the complete set of private inputs that a ZK circuit needs to generate a proof. This service knows the protocol's hash chains (noteAddressHash → precommitment → label → commitment), the nullifier derivation formula, and the merkle proof requirements for each circuit type.

WitnessPreparationService is the only place in the SDK that understands the internal structure of circuit inputs. PoolSession does not know how to compute a commitment—it passes raw values (ownerAddress, tokenId, value, keys) to WitnessPreparationService and receives a fully formed witness. ProofService does not know what a commitment is—it receives the witness and feeds it to the circuit.

This separation means that if the protocol changes (e.g. a new field is added to the commitment hash chain, or the nullifier derivation changes), only WitnessPreparationService needs to be updated.

# Dependencies

| Dependency | Why |
| --- | --- |
| **NoteComputationService** | Shared Poseidon hash chain computations are delegated to NoteComputationService: noteAddressHash, precommitment, label, fullCommitment, and authDigest. |
| **HashService** | Used directly by private helper methods for hash computations that are only needed inside WitnessPreparationService: commitment, nullifier, keystoreLeaf, timestampedLeaf, and labelHash. These were previously on NoteComputationService but moved here as private methods since WitnessPreparationService is their sole consumer. |
| **CryptoService** | Generates random secrets for noteSecret and depositSecret via CryptoService.generateSecret(). |
| **MerkleService** | Every circuit requires merkle inclusion proofs. The deposit circuit needs a proof against the commitments tree. The transact circuit needs proofs against three trees (commitments, key registry, association set). WitnessPreparationService calls MerkleService.generateMerkleProof() to build these from the leaves fetched by PoolSession. |

# Public Methods

---

> **Note:** Shared hash chain methods (`computeNoteAddressHash`, `computePrecommitment`, `computeLabel`, `computeFullCommitment`, `computeAuthDigest`) are delegated to [NoteComputationService](note-computation-service.md). Single-consumer hash computations (`computeCommitment`, `computeNullifier`, `computeKeystoreLeaf`, `computeTimestampedLeaf`, `computeLabelHash`) are private helpers on WitnessPreparationService using HashService directly. See the [Internal Helpers](#internal-helpers) section below for the full list.

**`buildDepositWitness(inputs) → DepositWitness`**

Builds the complete witness for the deposit circuit. Receives noteSecret and depositSecret as parameters, computes the full hash chain (noteAddressHash → precommitment → label → commitment), and structures everything into the format expected by ProofService.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `inputs.ownerAddress` | `Address` | The depositor's Ethereum address. |
| `inputs.tokenId` | `Address` | Token being deposited. |
| `inputs.value` | `Hex` | Amount being deposited. |
| `inputs.context` | `Hex` | Commitment to deposit details. |
| `inputs.noteSecret` | `Secret` | Random secret binding the note to its owner. |
| `inputs.depositSecret` | `Secret` | Random secret used for private label computation. |

**Returns: `DepositWitness`**

| Field | Type | Description |
| --- | --- | --- |
| `witness` | `CircuitInputs` | The structured private inputs for the deposit circuit. |
| `commitment` | `Hex` | The computed commitment to be inserted on-chain. |
| `label` | `Hex` | The computed label for ASP registration. |

---

**`buildDepositForWitness(inputs) → DepositWitness`**

Builds the deposit witness using a pre-computed `noteAddressHash` (cold start flow). Skips the `noteAddressHash = Poseidon(ownerAddress, noteSecret)` computation step and uses the provided value directly. Internally delegates to the same shared logic as `buildDepositWitness` for the remaining hash chain (precommitment -> label -> commitment).

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `inputs.noteAddressHash` | `Hex` | Pre-computed `Poseidon(recipientAddress, noteSecret)`. |
| `inputs.tokenId` | `Address` | Token being deposited. |
| `inputs.value` | `Hex` | Amount being deposited. |
| `inputs.context` | `Hex` | Commitment to deposit details. |
| `inputs.depositSecret` | `Secret` | Random secret used for private label computation. |

**Returns: `DepositWitness`** (same as `buildDepositWitness`)

---

**`buildTransactWitness(inputs) → TransactWitness`**

Builds the complete witness for the transact circuit (used for both transfers and withdrawals). Computes nullifiers for each input note, output commitments for recipient and change notes, and generates merkle proofs against all three trees (commitments, key registry, association set).

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `inputs.inputNotes` | `Note[]` | The input notes being spent. Full note data including secrets. Each note includes `createdAtBlock` (used as the timestamp for computing timestamped state leaves). |
| `inputs.outputNoteParams` | `OutputNoteParams[]` | Output note parameters: `noteAddressHash`, `value`, `label` for each output. |
| `inputs.privateNullifyingKey` | `Secret` | For nullifier computation. |
| `inputs.privateRevocableKey` | `Secret` | For authorizerDigest recomputation inside the circuit. |
| `inputs.ownerAddress` | `Address` | The sender's address. |
| `inputs.tokenId` | `Address` | Token identifier. Must match all input notes. |
| `inputs.amountOut` | `Hex` | Public withdrawal amount. `0x0` for pure transfers. |
| `inputs.tokenIdOut` | `Address` | Token exiting the pool. `address(0)` for pure transfers, must match `tokenId` for withdrawals. |
| `inputs.context` | `Hex` | Commitment to transaction details (computed via `computeTransactContext`). |
| `inputs.stateLeaves` | `Hash[]` | All leaves of the commitments merkle tree. |
| `inputs.keystoreLeaves` | `Hash[]` | All leaves of the key registry merkle tree. |
| `inputs.aspLeaves` | `Hash[]` | All leaves of the association set merkle tree. |
| `inputs.appendPredictedKeystoreLeaf` | `boolean` _(optional)_ | When `true`, appends this owner's computed keystore leaf to `keystoreLeaves` before deriving the keystore root, so the proof anchors to the *predicted* post-registration root. Used by the relayed register-and-withdraw flow, where the leaf insert and the transact land in one on-chain transaction. Defaults to `false`. |

**Returns: `TransactWitness`**

| Field | Type | Description |
| --- | --- | --- |
| `witness` | `CircuitInputs` | The structured private inputs for the transact circuit. |
| `outputCommitments` | `Hash[]` | Computed commitments for all output notes. |
| `nullifiers` | `Hash[]` | Computed nullifier hashes for all input notes. |

**Throws:** `WitnessPreparationFailed` wrapping the merkle `LeafNotFound` when the owner's keystore leaf (computed from `ownerAddress`, `privateNullifyingKey`, `privateRevocableKey`) is absent from `inputs.keystoreLeaves`. The plain "owner never registered a keystore" case is intercepted **upstream**: `TransactOrchestrator.prepareTransact` calls `assertKeystoreRegistered` for the session owner before any leaves are fetched and throws `KeystoreNotRegistered` (a `PoolSessionKeystoreBaseError`) — see [pool-session.md](pool-session.md#keystore-registration-precheck). What can still reach this method is the *registered-but-wrong/rotated-keys* case: the owner is on-chain, but the session's keys produce a leaf that is not in the tree. That is deliberately not reported as "not registered". The check is skipped when `pendingKeystoreRegistration` is set (`appendPredictedKeystoreLeaf`), because the predicted leaf is appended locally.

---

**`buildRagequitWitness(inputs) → RagequitWitness`**

Builds the witness for the ragequit circuit. 1-in, 0-out. No ASP proof needed. Computes the nullifier and generates merkle proofs against the commitments and key registry trees only.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `inputs.note` | `Note` | The note being exited. Full note data. |
| `inputs.privateNullifyingKey` | `Secret` | For nullifier computation. |
| `inputs.privateRevocableKey` | `Secret` | For authorizerDigest recomputation. |
| `inputs.ownerAddress` | `Address` | The owner's address (forced as recipient by the circuit). |
| `inputs.stateLeaves` | `Hash[]` | Commitments tree leaves. |
| `inputs.keystoreLeaves` | `Hash[]` | Key registry tree leaves. |

**Returns: `RagequitWitness`**

| Field | Type | Description |
| --- | --- | --- |
| `witness` | `CircuitInputs` | The structured private inputs for the ragequit circuit. |
| `nullifierHash` | `Hash` | The computed nullifier hash. |

**Throws:** `WitnessPreparationFailed` wrapping the merkle `LeafNotFound` when the keystore leaf is absent from `inputs.keystoreLeaves`. The keystore leaf is built from the **note's owner address** (`note.ownerAddress`), so the never-registered case is intercepted upstream by `PoolSessionRagequit.prepareRageQuit` (`assertKeystoreRegistered` for the note owner → `KeystoreNotRegistered`, see [pool-session.md](pool-session.md#keystore-registration-precheck)); what remains here is the registered-but-wrong/rotated-keys case.

---

# Internal Helpers

## Delegated to NoteComputationService

The shared hash chain computations are delegated to [NoteComputationService](note-computation-service.md):

| Delegated Method | Computation |
| --- | --- |
| `computeNoteAddressHash(ownerAddress, noteSecret)` | `Poseidon(ownerAddress, noteSecret)` |
| `computePrecommitment(noteAddressHash, tokenId, value)` | `Poseidon(noteAddressHash, tokenId, value, METADATA_STANDARD)` |
| `computeLabel(precommitment, depositSecret)` | `Poseidon(precommitment, depositSecret)` |
| `computeFullCommitment({ noteAddressHash, tokenId, value, label })` | `Poseidon(precommitment, label)` (derives precommitment internally) |
| `computeAuthDigest(privateRevocableKey)` | `Poseidon(AUTH_TYPE_DIRECT_KEY, privateRevocableKey)` |

## Private helpers (using HashService directly)

The following computations are private methods on WitnessPreparationService, using the injected HashService directly. They were moved here from NoteComputationService because WitnessPreparationService is their sole consumer:

| Private Method | Computation |
| --- | --- |
| `computeCommitment(precommitment, label)` | `Poseidon(precommitment, label)` |
| `computeNullifier(privateNullifyingKey, commitment)` | `Poseidon(privateNullifyingKey, commitment)` |
| `computeKeystoreLeaf(ownerAddress, privateNullifyingKey, authDigest)` | `Poseidon(ownerAddress, Poseidon(privateNullifyingKey), authDigest)` |
| `computeTimestampedLeaf(commitment, timestamp)` | `Poseidon(commitment, timestamp)` |
| `computeLabelHash(label)` | `Poseidon(label)` |

---

**Version History**

| Version | Change |
| --- | --- |
| 1.0.1 | 2026-09-24 — Doc-only. `buildTransactWitness` / `buildRagequitWitness` now document that a missing keystore leaf surfaces as `WitnessPreparationFailed` wrapping merkle `LeafNotFound`, and that the never-registered case is intercepted upstream by the session (`KeystoreNotRegistered` via `assertKeystoreRegistered`), leaving only the registered-but-wrong/rotated-keys case here. No behavior change in this service. |
