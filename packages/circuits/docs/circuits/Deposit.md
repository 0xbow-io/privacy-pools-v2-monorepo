# Deposit Circuit - Technical Design

## Overview

The Deposit circuit is the entry point for funds into Privacy Pools. It creates a single note commitment with **private label computation**, ensuring that the lineage identifier (label) cannot be publicly traced back to the deposit transaction.

By accepting a pre-computed `noteAddressHash` as input (rather than computing it internally), the circuit enables **private transfers from the public domain** - users can deposit directly to a recipient's noteAddressHash without knowing their ownerAddress/noteSecret.

## Signal Specification

### Input Signals (Public)

| Signal | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `tokenId` | input | Range-checked `< 2^160` (Num2Bits, INS-1) | Asset identifier (e.g. `uint256(0xEeE)` for ETH). Constrained to EVM address width so proof-side and contract-side canonical values cannot diverge. |
| `value` | input | < 2^128 | Amount being deposited |
| `context` | input | None | Commitment to deposit details (bound via quadratic constraint) |

### Input Signals (Private)

| Signal | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `noteAddressHash` | input | None | Pre-computed: Poseidon(ownerAddress, noteSecret) |
| `depositSecret` | input | None | Random field element for private label computation |

### Output Signals (Public)

| Signal | Type | Description |
|--------|------|-------------|
| `outputCommitment` | output | Final commitment for tree insertion |

### Intermediate Signals

| Signal | Description |
|--------|-------------|
| `precommitment` | Poseidon(noteAddressHash, tokenId, value, 0) |
| `label` | Poseidon(precommitment, depositSecret) |
| `commitment` | Poseidon(precommitment, label) |
| `contextSquared` | context * context (binding constraint) |

## Circuit Logic

### Algorithm

The Deposit circuit performs a computation of 4 steps:

1. **Compute Precommitment:**
   ```
   precommitment = Poseidon(noteAddressHash, tokenId, value, 0)
   ```
   Binds token type, value, and metadata (hardcoded to 0 for v2.0). The `noteAddressHash` is provided as input and represents `Poseidon(ownerAddress, noteSecret)`.

2. **Compute Label:**
   ```
   label = Poseidon(precommitment, depositSecret)
   ```
   Creates lineage identifier that cannot be derived from public data. The `depositSecret` ensures label privacy.

3. **Compute Final Commitment:**
   ```
   commitment = Poseidon(precommitment, label)
   ```
   Creates the final commitment that will be inserted into the commitment tree.

4. **Context Binding:**
   ```
   contextSquared = context * context
   ```
   Forces the `context` public input into the R1CS witness via a non-linear constraint, preventing proof malleability. The contract guarantees `context` is never 0, ensuring the binding is always effective.

## Implementation Details

### Constraint Count

Compiled with `circom 2.2.3` for `bn128`:
- **Total constraints**: 2,061
  - Non-linear constraints: 1,075
  - Linear constraints: 986
- **Template instances**: 147
- **Wires**: 2,065
- **Labels**: 3,002

See [Config E benchmark](../../../../docs/tech-design/circuits/circuits-benchmark.md) for proving / verification times and zkey sizes.

### Components Used

- **Poseidon(2)**: Used 2 times (label, commitment)
- **Poseidon(4)**: Used 1 time (precommitment)
- **Num2Bits(128)**: Used 1 time (value range check)
- **Num2Bits(160)**: Used 1 time (tokenId range check, INS-1)

### Notes about Constraints

**Value range check:**
```circom
valueRangeCheck.in <== value;
```
Ensures value < 2^128. Without this, overflow could occur in ValueConservation helper during multi-note transactions.

**Token ID range check (INS-1):**
```circom
tokenIdRangeCheck.in <== tokenId;
```
Ensures `tokenId < 2^160`, matching the EVM address bit-width the contract uses onchain. Without this, two distinct 256-bit field elements could be committed in-circuit while the contract truncates them to the same 160-bit address, letting proof-side and contract-side canonical values diverge.

**Metadata:**
```circom
precommitmentHasher.inputs[3] <== 0;  // metadata = 0
```
For v2.0, all notes use standard metadata (0). Future versions may add note polymorphism.

**Context binding:**
```circom
signal contextSquared;
contextSquared <== context * context;
```
Forces the `context` public input into the R1CS witness. This prevents proof malleability by binding the proof to a specific deposit context. The same pattern is used in the Transact circuit.

## Integration Guide

### Usage Pattern

The Deposit circuit is called via the Pool contract's `deposit()` function:

```typescript
// Off-chain: User generates secrets and computes noteAddressHash
const noteSecret = randomFieldElement();
const depositSecret = randomFieldElement();
const noteAddressHash = poseidon([BigInt(ownerAddress), noteSecret]);

// Off-chain: Generate proof
const inputs = {
  tokenId: BigInt(tokenAddress),
  value: depositAmount,
  context, // Commitment to deposit details
  noteAddressHash,
  depositSecret,
};
const { proof, publicSignals } = await generateProof("deposit", inputs);

// On-chain: Submit proof + public signals
await pool.deposit(
  tokenId,
  value,
  proof,
  publicSignals // [tokenId, value, context, outputCommitment]
);
```

### Private Transfer Pattern

To deposit directly to another user's address (without knowing their noteSecret):

```typescript
// Recipient shares their noteAddressHash publicly
const recipientNoteAddressHash = recipientPublicInfo.noteAddressHash;

// Sender creates deposit to recipient
const inputs = {
  tokenId: BigInt(tokenAddress),
  value: depositAmount,
  context, // Commitment to deposit details
  noteAddressHash: recipientNoteAddressHash, // Recipient's pre-computed hash
  depositSecret: randomFieldElement(),
};
const { proof, publicSignals } = await generateProof("deposit", inputs);
```

### Contract Verification

The Pool contract MUST verify:
1. Proof is valid (Groth16 verification)
2. `tokenId`, `value`, and `context` match proof public inputs
3. `outputCommitment` doesn't already exist in tree

## Testing
### Running Tests

```bash
# Run all Deposit tests
pnpm test -- --grep "Deposit"

# Compile circuit (circuit development only: can invalidate the committed ceremony keys)
pnpm compile deposit

# Dev-only proving/verification keys: overwrites the ceremony keys, never commit them
ALLOW_DEV_KEYS=1 pnpm run setup deposit
```

The committed keys come from the trusted-setup ceremony; see [CEREMONY.md](../../CEREMONY.md) to verify them.
