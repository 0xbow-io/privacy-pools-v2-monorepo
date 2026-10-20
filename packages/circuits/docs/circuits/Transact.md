# Transact Circuit

## Overview

The `Transact` circuit is the primary spending mechanism for Privacy Pools, enabling both private transfers and public withdrawals. This circuit spends input notes and creates output notes while enforcing:

1. **Authorization Verification:** User must be registered in the keystore
2. **Note Existence:** All input notes must exist in the state tree
3. **ASP Compliance:** All input labels must exist in the ASP association set
4. **Nullifier Generation:** Unique nullifiers for double-spend prevention
5. **Output Construction:** Valid output note commitments
6. **Value Conservation:** Global and per-label economic correctness
7. **Withdrawal State Enforcement:** Context binding for proof integrity

## Signal Specification

### Parameters

| Parameter | Description |
|-----------|-------------|
| `nInputs` | Number of input notes (variable: 1, 2, N for different verifiers) |
| `mOutputs` | Number of output notes (fixed at 2 in practice) |
| `stateMaxDepth` | Maximum State Merkle tree depth (22 for ~4.2M leaves, shared across commitment + nullifier leaves) |
| `keystoreMaxDepth` | Maximum Keystore Merkle tree depth (18 for ~262k keystore entries) |
| `associationSetMaxDepth` | Maximum association set Merkle tree depth (18 for ~262k labels) |

### Public Input Signals

| Signal | Type | Description |
|--------|------|-------------|
| `stateRoot` | Field element | Commitment tree root |
| `keystoreRoot` | Field element | Keystore tree root |
| `associationSetRoot` | Field element | ASP association set tree root |
| `amountOut` | Field element (< 2^128, implicit) | Public withdrawal amount (0 for pure transfer). No explicit range check — bounded implicitly by value conservation (see §6). |
| `tokenIdOut` | Field element (range-checked `< 2^160`, Num2Bits, INS-1) | Token being withdrawn (`uint256(address(0))` for pure transfer). Constrained to EVM address width so proof-side and contract-side canonical values cannot diverge. |
| `context` | Field element | Pre-computed commitment to withdrawal details

### Public Output Signals

| Signal | Type | Description |
|--------|------|-------------|
| `nullifierHashes[nInputs]` | Field element array | Nullifiers for double-spend prevention |
| `outputCommitments[mOutputs]` | Field element array | Output note commitments |

### Private Input Signals - Authorization

| Signal | Type | Description |
|--------|------|-------------|
| `ownerAddress` | Field element | User's Ethereum address |
| `privateNullifyingKey` | Field element | Nullifying key for nullifier generation |
| `privateRevocableKey` | Field element | Revocable authorization key |
| `keystoreLeafIndex` | Field element | Position in keystore tree |
| `keystoreSiblings[keystoreMaxDepth]` | Field element array | Merkle path for keystore |
| `keystoreTreeDepth` | Field element | Current keystore tree depth |

### Private Input Signals - Per Input Note

| Signal | Type | Description |
|--------|------|-------------|
| `noteSecret[nInputs]` | Field element array | Note secret for each input |
| `value[nInputs]` | Field element array (< 2^128) | Value of each input |
| `tokenId` | Field element (range-checked `< 2^160`, Num2Bits, INS-1) | Token ID (single token per tx). Constrained to EVM address width so proof-side and contract-side canonical values cannot diverge. |
| `label[nInputs]` | Field element array | Label of each input |
| `stateLeafIndex[nInputs]` | Field element array | Position in state tree |
| `stateSiblings[nInputs][stateMaxDepth]` | 2D Field element array | State Merkle paths |
| `stateTreeDepth[nInputs]` | Field element array | State tree proof depth per input (variable cause LeanIMT produces different proof lengths depending on leaf position) |
| `associationSetLeafIndex[nInputs]` | Field element array | Position in association set tree |
| `associationSetSiblings[nInputs][associationSetMaxDepth]` | 2D Field element array | Association set Merkle paths |
| `associationSetTreeDepth[nInputs]` | Field element array | Association set tree proof depth per input (variable, same rationale as stateTreeDepth) |
| `timestamp[nInputs]` | Field element array | Block timestamp when each commitment was inserted into the state tree. Used to compute the actual state tree leaf: `Poseidon(commitment, timestamp)`. |

> **Design note on `timestamp`:** The timestamp is intentionally **not** part of the note commitment. It is a separate private input used only for state tree leaf computation: `stateLeaf = Poseidon(commitment, timestamp)`. By keeping the timestamp outside the commitment, the contract can enforce it directly. The contract uses `block.timestamp` when inserting the leaf into the state tree, ensuring the timestamp is trustworthy without relying on user-provided values. If the timestamp were inside the commitment, the contract would have no way to verify or enforce it. As a side benefit, identical commitments inserted at different block timestamps produce distinct state leaves, providing collision resistance at the state tree level.

### Private Input Signals - Per Output Note

| Signal | Type | Description |
|--------|------|-------------|
| `outputNoteAddressHash[mOutputs]` | Field element array | Poseidon(ownerAddress, noteSecret) |
| `outputValue[mOutputs]` | Field element array (< 2^128) | Output value |
| `outputLabel[mOutputs]` | Field element array | Output label |

> **Note:** Output metadata is hardcoded to 0 (standard spendable notes).

## Circuit Logic

### 1. Authorization Verification

Verifies the user is registered in the keystore with valid keys.

```
1.1 Compute authDigest = Poseidon(0, privateRevocableKey)  // authType = 0
1.2 Compute keystoreLeaf using KeystoreLeaf helper
1.3 Verify BinaryMerkleRoot(keystoreLeaf, keystoreRoot)
```

**Constraint:** `authorizationProof.out === keystoreRoot`

### 2. Input Note Verification (per input)

For each input note, reconstruct the commitment and verify existence.

```
2.1 Range check: value[i] < 2^128 (via Num2Bits(128))
2.2 Compute noteAddressHash = Poseidon(ownerAddress, noteSecret[i])
2.3 Compute commitment using NoteCommitment helper
2.4 Compute timestampedLeaf = Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp[i])
2.5 Verify BinaryMerkleRoot(timestampedLeaf, stateRoot)
```

> **Note (M-0 fix):** the state tree holds both timestamped commitment leaves and timestamped nullifier leaves under a shared Poseidon hash. Each leaf type carries a distinct domain-separation tag as the first Poseidon input — `COMMITMENT_LEAF_TAG` for commitments, `NULLIFIER_LEAF_TAG` for nullifiers — so a planted nullifier can never collide with a forged commitment. The tag is a compile-time constant in the circuit and mirrored in `packages/contracts/src/utils/Constants.sol` and `packages/sdk/src/constant/WitnessPreparationService.ts`.

### 3. ASP Compliance Verification (per input)

Verifies each input label exists in the ASP association set.

```
3.1 Compute labelHash = Poseidon(label[i])
3.2 Verify BinaryMerkleRoot(labelHash, associationSetRoot)
```

**Constraint:** `associationSetProofs[i].out === associationSetRoot`

### 4. Nullifier Generation (per input)

Generates unique nullifiers for double-spend prevention.

```
4.1 Compute nullifier = Poseidon(privateNullifyingKey, commitment[i])
```

**Output:** `nullifierHashes[i] <== nullifier`

### 5. Output Note Construction (per output)

Constructs output note commitments.

```
5.1 Range check: outputValue[j] < 2^128 (via Num2Bits(128))
5.2 Compute commitment using NoteCommitment helper
```

**Output:** `outputCommitments[j] <== commitment`

### 6. Value Conservation

Enforces global and per-label value conservation using ValueConservation helper.

```
6.1 Global: Σ(inputValues) === Σ(outputValues) + amountOut
6.2 Per-label: For each label L, Σ(inputs with L) >= Σ(outputs with L)
```

> **Design note:** `amountOut` has no explicit `Num2Bits(128)` range check in the circuit. This is intentional, all value in the system originates from Deposit (which enforces `value < 2^128`), and both input and output values are independently range-checked. Since `amountOut = totalIn - outputSum`, it is implicitly bounded by the conservation constraint. A field-wrapped `amountOut` would violate `totalIn === totalOut`.

### 7. Token Consistency

Ensures withdrawal token matches the notes' token (only for withdrawals).

```
7.1 If amountOut != 0: enforce tokenId === tokenIdOut
7.2 If amountOut == 0 (pure transfer): skip check
```

**Implementation:** `(tokenId - tokenIdOut) * (1 - IsZero(amountOut)) === 0`

### 8. Public Input Binding

Binds public inputs to the proof via non-linear constraints.

```
8.1 contextSquared <== context * context
```

> **Design note:** The `context * context` constraint forces `context` into the R1CS witness and public inputs, binding the proof to a specific withdrawal context. The contract guarantees `context` is never zero, even for pure transfers (no withdrawal), `context` is set to the hash of empty bytes. This ensures the quadratic constraint is always non-trivial and the binding is effective.

## Implementation Details

### Constraint Count

Compiled with `circom 2.2.3` for `bn128`:

| Configuration | Constraints | Public Inputs | Private Inputs |
|--------------|-------------|---------------|----------------|
| Transact(1, 2, 22, 18, 18) | TBD | 6 | ~119 |
| Transact(2, 2, 22, 18, 18) | TBD | 6 | ~158 |

**Scaling Pattern:**
- Each additional input adds ~14,000 constraints (Merkle proof + ASP proof + nullifier)
- Fixed overhead: Authorization (~7,500), outputs (~2,000), value conservation (~300)

### Components Used

| Component | Count | Purpose |
|-----------|-------|---------|
| `KeystoreLeaf` | 1 | Compute keystore leaf |
| `BinaryMerkleRoot(*)` | 1 + 2×nInputs | Keystore (keystoreMaxDepth) + state (stateMaxDepth) + association set proofs (associationSetMaxDepth) |
| `NoteCommitment` | nInputs + mOutputs | Input reconstruction + output construction |
| `ValueConservation(nInputs, mOutputs)` | 1 | Economic correctness |
| `Poseidon(2)` | 1 + nInputs + nInputs | Auth digest + noteAddressHash + nullifiers |
| `Poseidon(3)` | nInputs | Timestamped commitment leaf (`Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)`) |
| `Poseidon(1)` | nInputs | Label hashes |
| `Num2Bits(128)` | nInputs + mOutputs | Value range checks |
| `Num2Bits(160)` | 2 | `tokenId` and `tokenIdOut` range checks (INS-1) |
| `Num2Bits(6)` | 1 + 2×nInputs | Depth range checks (keystore + per-input state + per-input ASP) |
| `LessEqThan(6)` | 1 + 2×nInputs | Depth bound checks (keystore + per-input state + per-input ASP) |
| `IsZero` | 1 | Conditional token check |

## Integration Guide

### Example Usage

```circom
pragma circom 2.2.3;

include "templates/Transact.circom";

// Single-input transaction verifier
// Parameters: nInputs=1, mOutputs=2, stateMaxDepth=22, keystoreMaxDepth=18, associationSetMaxDepth=18
component main {public [
    stateRoot,
    keystoreRoot,
    associationSetRoot,
    amountOut,
    tokenIdOut,
    context
]} = Transact(1, 2, 22, 18, 18);
```

### TypeScript Reference

Key helper functions from `test/common/index.ts`:

```typescript
// Calculate note address hash
export async function calculateNoteAddressHash(
  ownerAddress: bigint,
  noteSecret: bigint,
): Promise<bigint> {
  return await poseidon([ownerAddress, noteSecret]);
}

// Calculate nullifier hash
export async function calculateNullifierHash(
  privateNullifyingKey: bigint,
  commitment: bigint,
): Promise<bigint> {
  return await poseidon([privateNullifyingKey, commitment]);
}

// Calculate label hash for association set tree
export async function calculateLabelHash(label: bigint): Promise<bigint> {
  return await poseidon([label]);
}
```

## Tests

### Running Tests

```bash
# Run all Transact tests
pnpm test -- --grep "Transact"

# Compile specific configuration
pnpm circomkit compile transact
```
