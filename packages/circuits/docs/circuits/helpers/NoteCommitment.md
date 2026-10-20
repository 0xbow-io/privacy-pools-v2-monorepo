# NoteCommitment Helper Circuit

## Overview

The `NoteCommitment` helper circuit computes cryptographic commitments for notes in Privacy Pools v2. This commitment scheme binds ownership, value, and lineage information into a single hash that can be stored in the commitment tree.

### Design

The circuit implements 2 steps for hashing that separates:
1. **Core Note Properties** (precommitment): `noteAddressHash`, `tokenId`, `value`, `metadata`
2. **Lineage Information** (final commitment): Binds precommitment with `label`

## Signal Specification

### Input Signals

| Signal | Type | Constraints | Field Element Conversion | Description |
|--------|------|-------------|--------------------------|-------------|
| `noteAddressHash` | Private | Field element (Poseidon output) | `Poseidon(ownerAddressHash, noteSecret)` | Pre-computed hash binding owner to note |
| `tokenId` | Private | Field element | ETH: `uint256(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE)`<br>ERC-20: `uint256(tokenAddress)` | Asset identifier |
| `value` | Private | Field element (< 2^128) | Direct value | Amount of tokens |
| `metadata` | Private | Field element | Direct value | Note type identifier |
| `label` | Private | Field element (Poseidon output) | Pre-computed label hash | Lineage identifier |


### Output Signals

| Signal | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `commitment` | Private | Field element (Poseidon output) | Final note commitment stored in commitment tree |

### Intermediate Signals

| Signal | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `precommitment` | Internal | Field element (Poseidon output) | Intermediate hash of core note properties |

## Circuit Logic

### Algorithm

The commitment is computed in two sequential stages:

#### Stage 1: Compute Precommitment
```
precommitment = Poseidon(noteAddressHash, tokenId, value, metadata)
```
Its purpose is to bind all core note properties into a single hash.

**Properties Bound:**
- `noteAddressHash`: Links note to owner (via `noteSecret`)
- `tokenId`: Asset type
- `value`: Amount
- `metadata`: Note type (future extensibility)

#### Stage 2: Compute Final Commitment
```
commitment = Poseidon(precommitment, label)
```
Its purpose is to bind precommitment with lineage information.

**Properties Bound:**
- `precommitment`: All core note data (owner, value, token, metadata)
- `label`: Lineage/taint tracking identifier

## Implementation Details

### Constraint Count

Compiled with circom 2.2.3 for `bn128`:

- **Non-linear constraints:** 543
- **Linear constraints:** 710
- **Total constraints:** 1,253
- **Template instances:** 145
- **Private inputs:** 5
- **Public outputs:** 1

### Components Used

- **Poseidon(4):** Used once (stage 1) to hash core note properties
- **Poseidon(2):** Used once (stage 2) to bind precommitment with label

### Notes about Constraints

**Line 37 (Precommitment binding):**
```circom
precommitment <== precommitmentHasher.out;
```
Ensures the intermediate precommitment is properly constrained to the output of the first Poseidon hash.

**Line 44 (Final commitment binding):**
```circom
commitment <== commitmentHasher.out;
```
Ensures the final commitment is properly constrained to the output of the second Poseidon hash, binding all components together.

## Integration Guide

### Example Usage

```circom
component noteCommit = NoteCommitment();
noteCommit.noteAddressHash <== noteAddressHash;
noteCommit.tokenId <== tokenId;
noteCommit.value <== value;
noteCommit.metadata <== metadata;
noteCommit.label <== label;

// Use the computed commitment for Merkle tree inclusion proof
component commitmentProof = BinaryMerkleRoot(maxDepth);
commitmentProof.leaf <== noteCommit.commitment;
// ... rest of inclusion proof (index, depth, siblings)
```

### TypeScript Reference

Corresponding TypeScript implementation from `test/common/index.ts`:

```typescript
export async function calculateNoteCommitment(
  noteAddressHash: bigint,
  tokenId: bigint,
  value: bigint,
  metadata: bigint,
  label: bigint,
): Promise<bigint> {
  // 1. Compute precommitment
  const precommitment = await poseidon([
    noteAddressHash,
    tokenId,
    value,
    metadata,
  ]);

  // 2. Compute final commitment
  const commitment = await poseidon([precommitment, label]);

  return commitment;
}
```

## Testing

### Running Tests

```bash
# Run all NoteCommitment tests
pnpm test -- --grep "NoteCommitment"

# Compile the circuit
circom circuits/test/NoteCommitment.circom --r1cs --wasm --sym \
  --output build/helpers/NoteCommitment -l node_modules
```
