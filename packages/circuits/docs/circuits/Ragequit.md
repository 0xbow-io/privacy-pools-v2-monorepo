# Ragequit Circuit - Technical Design

## Overview

The Ragequit circuit is an **emergency withdrawal mechanism** that allows users to recover funds when ASP compliance has failed or the ASP has censored their label. This circuit intentionally **bypasses ASP compliance checks** and forces a public withdrawal to the note's owner address.

Unlike the Transact circuit which maintains privacy through flexible recipient control, Ragequit exposes the owner address and value publicly to enable trustless fund recovery.

## Key Differences from Transact

| Aspect | Ragequit | Transact |
|--------|----------|----------|
| **Inputs** | 1 (fixed) | M (variable) |
| **Outputs** | 0 (emergency withdrawal) | 2 (fixed) |
| **ASP Verification** | **BYPASSED** | Required |
| **Commitment Tree Proof** | **External** (contract/off-chain) | In-circuit |
| **Recipient Control** | Owner only (public) | Flexible (private) |
| **Value Visibility** | Public | Private |
| **Privacy Level** | Low (public withdrawal) | High |

## Signal Specification

### Input Signals (Public)

| Signal | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `keystoreRoot` | Field element | None | Keystore tree root |
| `ownerAddress` | Field element | None | Forced withdrawal recipient (must match note owner) |
| `value` | Field element (< 2^128, implicit) | None | Note amount (publicly exposed). No explicit range check, bounded implicitly by Deposit (see design note below). |
| `tokenId` | Field element | Range-checked `< 2^160` (Num2Bits, INS-1) | Token identifier. Constrained to EVM address width so proof-side and contract-side canonical values cannot diverge. |
| `label` | Field element | None | Lineage identifier for ASP tracking |

### Input Signals (Private)

| Signal | Type | Description |
|--------|------|-------------|
| `noteSecret` | Field element | Secret from deposit |
| `metadata` | Field element | Note metadata (0 for standard notes in v2.0) |
| `privateNullifyingKey` | Field element | Key for nullifier derivation |
| `privateRevocableKey` | Field element | Revocable key for auth (authType=0) |
| `keystoreLeafIndex` | Field element | Position in keystore |
| `keystoreSiblings[maxDepth]` | Field element array | Merkle path for keystore (maxDepth=18) |
| `keystoreTreeDepth` | Field element | Keystore tree depth (constrained ≤ maxDepth) |

### Output Signals (Public)

| Signal | Type | Description |
|--------|------|-------------|
| `nullifierHash` | Field element | Prevents double-spending |
| `commitment` | Field element | Reconstructed commitment (verified externally) |

### Intermediate Signals

| Signal | Description |
|--------|-------------|
| `authDigest` | Poseidon(0, privateRevocableKey) |
| `keystoreLeaf` | KeystoreLeaf(ownerAddress, privateNullifyingKey, authDigest) |
| `noteAddressHash` | Poseidon(ownerAddress, noteSecret) |

## Circuit Logic

### Algorithm

The Ragequit circuit performs 3 verification steps:

1. **Authorization Verification:**
   ```
   // Validate depth to prevent BinaryMerkleRoot exploit
   keystoreTreeDepth <= maxDepth

   authDigest = Poseidon(0, privateRevocableKey)
   keystoreLeaf = KeystoreLeaf(ownerAddress, privateNullifyingKey, authDigest)
   BinaryMerkleRoot(keystoreLeaf, keystoreLeafIndex, keystoreSiblings, keystoreTreeDepth) === keystoreRoot
   ```
   Proves user is registered in the keystore with the claimed owner address.

2. **Note Commitment Reconstruction:**
   ```
   noteAddressHash = Poseidon(ownerAddress, noteSecret)
   commitment = NoteCommitment(noteAddressHash, tokenId, value, metadata, label)
   ```
   Proves knowledge of note secrets. **Commitment tree inclusion is verified externally** (contract or off-chain).

   > **Design note:** `value` has no explicit `Num2Bits(128)` range check in the Ragequit circuit. This is intentional, all committed values originate from Deposit (which enforces `value < 2^128`). The value must reconstruct the exact commitment stored in the state tree; a mismatched value would produce a different commitment, failing external verification.

3. **Nullifier Generation:**
   ```
   nullifierHash = Poseidon(privateNullifyingKey, commitment)
   ```
   Prevents double-spending of the same note.

## Implementation Details

### Constraint Count

Compiled with `circom 2.2.3` for `bn128`:
- **Total constraints**: 13,440
  - Non-linear constraints: 6,410
  - Linear constraints: 7,030
- **Template instances**: 295
- **Wires**: 13,464
- **Labels**: 20,117
- **Public inputs**: 5 (keystoreRoot, ownerAddress, value, tokenId, label)
- **Private inputs**: 24 (noteSecret, metadata, privateNullifyingKey, privateRevocableKey, keystoreLeafIndex, keystoreSiblings[18], keystoreTreeDepth)
- **Public outputs**: 2 (nullifierHash, commitment)

See [Config E benchmark](../../../docs/tech-design/circuits/circuits-benchmark.md) for proving / verification times and zkey sizes.

### Components Used

- **Poseidon(2)**: Used 3 times (authDigest, noteAddressHash, nullifierHash)
- **KeystoreLeaf**: Used 1 time
- **NoteCommitment**: Used 1 time
- **BinaryMerkleRoot(18)**: Used 1 time (authorization proof only)
- **Num2Bits(6)**: Used 1 time (keystoreTreeDepth range validation)
- **Num2Bits(160)**: Used 1 time (`tokenId` range check, INS-1)
- **LessEqThan(6)**: Used 1 time (depth validation)

## Integration Guide

### Usage Pattern

The Ragequit circuit is called when a user needs emergency fund recovery:

```typescript
// Off-chain: User retrieves their note data
const { noteSecret, label, privateNullifyingKey, privateRevocableKey } = userSecrets;
const { keystoreLeafIndex, keystoreSiblings, keystoreTreeDepth } = getKeystoreProof(ownerAddress);

// Off-chain: Generate proof
const inputs = {
  // Public inputs
  keystoreRoot: currentKeystoreRoot,
  ownerAddress: BigInt(ownerAddress),
  value: noteValue,
  tokenId: BigInt(tokenAddress),
  label,
  // Private inputs
  noteSecret,
  metadata: 0n,
  privateNullifyingKey,
  privateRevocableKey,
  keystoreLeafIndex,
  keystoreSiblings,
  keystoreTreeDepth,
};
const { proof, publicSignals } = await generateProof("ragequit", inputs);

// On-chain: Submit proof
// publicSignals = [keystoreRoot, ownerAddress, value, tokenId, label, nullifierHash, commitment]
await pool.ragequit(proof, publicSignals);
```

### Contract Verification

The Pool contract MUST verify:
1. Proof is valid (Groth16 verification)
2. `keystoreRoot` matches current keystore
3. `commitment` exists in the commitment tree (external check)
4. `nullifierHash` hasn't been used before
5. Transfer `value` of `tokenId` to `ownerAddress`

## Testing

### Running Tests

```bash
# Run all Ragequit tests
pnpm test -- --grep "Ragequit"

# Compile circuit (circuit development only: can invalidate the committed ceremony keys)
pnpm circomkit compile ragequit

# Dev-only proving/verification keys: overwrites the ceremony keys, never commit them
ALLOW_DEV_KEYS=1 pnpm run setup ragequit
```

The committed keys come from the trusted-setup ceremony; see [CEREMONY.md](../../CEREMONY.md) to verify them.
