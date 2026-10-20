# Privacy Pools v2 - Circuits Overview

Privacy Pools v2 uses three circuits implemented in Circom 2 with Groth16 for on-chain verification.

## Circuit Summary

| Circuit | Purpose | Spending? |
| --- | --- | --- |
| [`deposit`](./Deposit.md) | Creates a shielded note from a public deposit | No |
| [`transact`](./Transact.md) | Private transfers and public withdrawals (M inputs → N outputs) | Yes |
| [`ragequit`](./Ragequit.md) | Emergency withdrawal bypassing ASP compliance | Yes |

## Helper Components

All circuits use shared helper components for common operations:

| Helper | Purpose |
| --- | --- |
| [`NoteCommitment`](./helpers/NoteCommitment.md) | Computes note commitments binding ownership, value, and lineage |
| [`KeystoreLeaf`](./helpers/KeystoreLeaf.md) | Computes keystore leaves for user registration |
| [`ValueConservation`](./helpers/ValueConservation.md) | Enforces global and per-label value conservation |

External dependencies:
- `BinaryMerkleRoot` from [`@zk-kit/binary-merkle-root.circom`](https://www.npmjs.com/package/@zk-kit/binary-merkle-root.circom) - Verifies Merkle tree inclusion

## Tree Depth Limits

| Tree | Max Depth | Capacity |
| --- | --- | --- |
| State tree | 22 | 4,194,304 leaves (shared across commitment + nullifier leaves) |
| Keystore tree | 18 | 262,144 leaves |
| ASP tree | 18 | 262,144 leaves |

Depths were raised from the original `18 / 14 / 14` as part of the M-1 fix to push back the cost of the tree-fill griefing vector flagged in the internal review. The state tree holds two leaf types under one root — see "State Tree Leaf Construction" in [`circuits-tech-design.md`](../../../../docs/tech-design/circuits/circuits-tech-design.md) for the domain-separation scheme.

## Circuit Parameters

The `transact` circuit is parameterized by input/output counts:
- `nInputs`: Number of input notes (1-5)
- `mOutputs`: Number of output notes (1-5)

Pre-compiled configurations are available for all combinations from 1x1 to 5x5.

## Security Model

- **Proof System**: Groth16, with keys from a multi-party phase-2 trusted-setup ceremony over the PSE perpetual powers of tau (see [CEREMONY.md](../../CEREMONY.md))
- **Field**: BN254 scalar field
- **Value Range**: All values constrained to < 2^128 to prevent overflow

For detailed documentation on each circuit, see the linked markdown files above.
