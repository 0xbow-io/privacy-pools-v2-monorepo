# KeystoreLeaf Helper Circuit

## Overview

The `KeystoreLeaf` helper circuit computes a user's keystore leaf from their public address, private nullifying key, and pre-computed authorization digest. This leaf is stored in the keystore tree and binds the user's EVM address to their nullifying key and authorization method.

### Design

The circuit works with any authType. The `authDigest` is computed externally by the caller based on the specific authorization type.

### Computation Steps

1. Hash nullifying key: `nullifyingKeyHash = Poseidon(privateNullifyingKey)`
2. Combine into final leaf: `keystoreLeaf = Poseidon(ownerAddress, nullifyingKeyHash, authDigest)`

## Signal Specification

### Input Signals

| Signal | Type | Constraints | Field Element Conversion | Description |
|--------|------|-------------|--------------------------|-------------|
| `ownerAddress` | Private | Field element | `uint256(ownerAddress)` | User's EVM address cast to uint256 |
| `privateNullifyingKey` | Private | Field element | Random field element | Immutable key for nullifier generation |
| `authDigest` | Private | Field element | Poseidon hash | Pre-computed authorization digest (depends on authType) |

### Output Signals

| Signal | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `keystoreLeaf` | Private | Field element (Poseidon output) | Final leaf stored in keystore tree |

### Intermediate Signals

| Signal | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `nullifyingKeyHash` | Internal | Field element (Poseidon output) | Hash of private nullifying key |

## Circuit Logic

### Algorithm

The keystore leaf is computed in two sequential stages:

#### 1. Hash Nullifying Key
```
nullifyingKeyHash = Poseidon(privateNullifyingKey)
```
Commit to the immutable nullifying key.

#### 2. Compute Final Leaf
```
keystoreLeaf = Poseidon(ownerAddress, nullifyingKeyHash, authDigest)
```
It combines all components into the final leaf:
- `ownerAddress`: Links leaf to EVM address (uint256 cast)
- `nullifyingKeyHash`: Commits to nullifier generation capability
- `authDigest`: Commits to authorization method (computed externally)

### authDigest Computation

The caller is responsible for computing `authDigest` based on the user's authType:

```
// authType = 0 (Direct Key Authorization - v2.0)
authDigest = Poseidon(AUTH_TYPE.DIRECT_KEY, privateRevocableKey)

// authType = 1 (BabyJubJub - future)
authDigest = Poseidon(AUTH_TYPE.BJJ, bjjPublicKey)
```

## Implementation Details

### Constraint Count

Compiled with circom 2.2.3 for `bn128`:

- **Non-linear constraints:** 480
- **Linear constraints:** 540
- **Total constraints:** 1,020
- **Template instances:** 140
- **Wires:** 1,024
- **Labels:** 1,520
- **Private inputs:** 3
- **Public outputs:** 1

### Components Used

- **Poseidon(1)**: Used once (step 1) to hash nullifying key
- **Poseidon(3)**: Used once (step 2) for final leaf

## Integration Guide

### Example Usage (in main circuits)

```circom
// Compute authDigest for authType = 0 (Direct Key Authorization)
component authDigestHasher = Poseidon(2);
authDigestHasher.inputs[0] <== 0;  // AUTH_TYPE.DIRECT_KEY
authDigestHasher.inputs[1] <== privateRevocableKey;

// Use generic KeystoreLeaf helper
component keyLeaf = KeystoreLeaf();
keyLeaf.ownerAddress <== ownerAddress;
keyLeaf.privateNullifyingKey <== privateNullifyingKey;
keyLeaf.authDigest <== authDigestHasher.out;

// Use the computed leaf for Merkle tree inclusion proof
component keyProof = BinaryMerkleRoot(maxDepth);
keyProof.leaf <== keyLeaf.keystoreLeaf;
keyProof.index <== keyIndex;
keyProof.depth <== keyTreeDepth;
for (var i = 0; i < maxDepth; i++) {
    keyProof.siblings[i] <== keySiblings[i];
}
keyProof.out === keystoreRoot;
```

### TypeScript Reference

Corresponding TypeScript implementation from `test/common/index.ts`:

```typescript
import { AUTH_TYPE, poseidon } from "./common/index.js";

// Compute authDigest for Direct Key Authorization (authType = 0)
export async function computeAuthDigestDirectKey(
  privateRevocableKey: bigint
): Promise<bigint> {
  return await poseidon([AUTH_TYPE.DIRECT_KEY, privateRevocableKey]);
}

// Generic KeystoreLeaf computation
export async function calculateKeystoreLeaf(
  ownerAddress: bigint,
  privateNullifyingKey: bigint,
  authDigest: bigint
): Promise<bigint> {
  // 1. Hash nullifying key
  const nullifyingKeyHash = await poseidon([privateNullifyingKey]);

  // 2. Compute final leaf
  return await poseidon([ownerAddress, nullifyingKeyHash, authDigest]);
}
```

### Running Tests

```bash
# Run all KeystoreLeaf tests
pnpm test -- --grep "KeystoreLeaf"

# Compile the circuit
pnpm compile keystoreLeaf
```
