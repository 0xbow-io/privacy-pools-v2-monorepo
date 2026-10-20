# PPv2 - Cryptography Glossary

This glossary defines all cryptographic, protocol-specific, and zero-knowledge terminology used throughout the Privacy Pools v2 circuit specifications. It serves as a reference for any person onboarding to the project.

## Cryptographic Primitives

### BN128 Scalar Field

**Definition**: The prime field used by the `BN128` elliptic curve, with prime `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617` (~254 bits). All circuit arithmetic operates in this field. All signals must be valid field elements.

### Field Element

A number in the range $[0, p-1]$ where $p$ is the `BN128` scalar field prime. All circuit signals (inputs, outputs, intermediate values) must be valid field elements.

### Poseidon Hash

A SNARK-friendly hash function optimized for zero-knowledge circuits. Used exclusively throughout Privacy Pools v2 for all hashing operations. 

### Groth16

A zero-knowledge proof system that produces short, constant-size proofs with fast verification. The proving system used by all Privacy Pools v2 circuits for on-chain verification.

### Constraint

A mathematical equation that must hold in a zero-knowledge circuit. Circuit efficiency is measured by constraint count. Fewer constraints = faster proving.

## Zero-Knowledge Circuit Terms

### Public Signal / Public Input

Circuit inputs and outputs that are visible to verifiers and recorded on-chain. Includes values like `tokenId`, `value`, `merkleRoot`, `nullifier`. Cannot be hidden.

### Private Signal / Witness

Circuit inputs that are only known to the prover and hidden from verifiers. Includes secrets like `noteSecret`, `depositSecret`, `ownerAddress`. Enables privacy.

### Signal

A variable in a Circom circuit that holds a field element value. Can be input, output, or intermediate. Must be properly constrained.

### Template

A reusable circuit component in Circom, similar to a function in programming. Examples: `Poseidon(2)`, `LeanIMTInclusionProof(32)`, `Deposit()`.

### Component

An instantiation of a template within a circuit. Example: `component hasher = Poseidon(2);` creates a Poseidon hasher component.

## Privacy Pools v2 Core Concepts

### Note

A UTXO-like structure representing ownership of funds in the privacy pool. Contains `ownerAddress`, `value`, `tokenId`, and cryptographic binding secrets. Never revealed publicly.

### Commitment

A cryptographic hash that represents a note without revealing its contents. The final hash `Poseidon(precommitment, label)` that gets inserted into the commitment tree.

### Label

A unique, non-fungible lineage identifier derived from each deposit. Computed as `Poseidon(precommitment, depositSecret)`. Required for ASP compliance.

### Nullifier

A unique value that prevents double-spending of notes. Computed as `nullifierHash = Poseidon(privateNullifyingKey, commitment)`. When a note is spent, the protocol inserts a **timestamped nullifier leaf** `Poseidon(NULLIFIER_LEAF_TAG, nullifierHash, timestamp)` into the shared state tree. Duplicate-leaf rejection by the tree gives double-spend prevention without a separate nullifier mapping.

### Precommitment

An intermediate hash in the commitment construction. `Poseidon(noteAddressHash, tokenId, value)` - binds economic properties to ownership.

### noteAddressHash

The first layer of the commitment structure. `Poseidon(ownerAddress, noteSecret)` - binds note to owner with private secret.

## Privacy Pools v2 Secrets

### `ownerAddress`

The Ethereum address that owns a note. PRIVATE input in circuits (never revealed on-chain). Recipients must know this to spend notes.

### `noteSecret`

A random value that obfuscates the owner's address in the commitment. Chosen by either recipient (preferred) or sender. Required to spend the note.

### `depositSecret`

A random value used to compute the label privately. NEVER shared with recipients. Enables sender privacy by preventing label tracing.

### `privateNullifyingKey`

A private key used to derive nullifiers. Must correspond to a registered key in the keystore. Required for spending notes.

## Protocol Components

### ASP (Association Set Provider)

A service provider that maintains compliance rules and approves labels. Users must register their labels with an ASP before spending notes. Can revoke compliance.

### Ragequit

An emergency withdrawal mechanism that bypasses ASP compliance. Allows users to recover funds by sacrificing privacy. Prevents permanent fund freezing.

### LeanIMT (Lean Incremental Merkle Tree)

An optimized Merkle tree that grows dynamically and only validates actual depth. Used for commitment trees. More efficient than binary trees (40-60% constraint savings).

### State Tree

The single LeanIMT used by Privacy Pools v2 to hold all state. It stores **two leaf types** under a shared `Poseidon(Field × Field × Field)` hash:

- **Commitment leaf** = `Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)` — inserted on every deposit and on every output of a Transact.
- **Nullifier leaf** = `Poseidon(NULLIFIER_LEAF_TAG, nullifierHash, timestamp)` — inserted on every spend.

The domain-separation tags keep the two leaf types from colliding in the shared hash domain (M-0 fix). The tree exposes one root (`stateRoot`) that proves either type of membership without distinguishing them. Capacity is shared across both leaf types and bounded by the state tree's max depth.

### Commitment Tree

Legacy term. The original v2 design used a separate commitment tree plus a nullifier mapping. Post M-0/M-1 there is a single **State Tree** (see above) that holds both timestamped commitment leaves and timestamped nullifier leaves. References to "commitment tree" in older docs should be read as "state tree filtered to commitment leaves".

### Keystore

A registry mapping addresses to cryptographic keys and verification methods. Required for authorization. Supports key rotation and multiple signature schemes.

---

## State Tree Domain-Separation Tags

### `COMMITMENT_LEAF_TAG`

Hardcoded compile-time constant tagging timestamped commitment leaves in the state tree (M-0 fix).

- **Value**: `3791694183000795315792098099581407680958131641292811872617553086713867485913`
- **Derivation**: `Poseidon(BigInt(Buffer.from("privacy_pools_note", "utf-8")))`
- **Mirrored in**:
  - `packages/circuits/circuits/templates/Transact.circom` (as a `var` constant)
  - `packages/contracts/src/utils/Constants.sol`
  - `packages/core-sdk/src/constant/WitnessPreparationService.ts`

Every commitment-leaf insertion uses this as the first Poseidon input: `Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)`. All three layers must stay in sync.

### `NULLIFIER_LEAF_TAG`

Hardcoded compile-time constant tagging timestamped nullifier leaves in the state tree (M-0 fix).

- **Value**: `1480564842420020354887207755615370381236762558448265256256653429412951563031`
- **Derivation**: `Poseidon(BigInt(Buffer.from("privacy_pools_nullifier", "utf-8")))`
- **Mirrored in**:
  - `packages/contracts/src/utils/Constants.sol`
  - `packages/core-sdk/src/constant/WitnessPreparationService.ts`
  - (Not used directly in any circuit today — circuits only reconstruct commitment leaves; nullifier-leaf insertion is contract-side.)

Every nullifier-leaf insertion uses this as the first Poseidon input: `Poseidon(NULLIFIER_LEAF_TAG, nullifierHash, timestamp)`. The two tags must be distinct field elements; collision would re-open the M-0 forgery class.

## Token and Asset Terms

### `tokenId`

A unique identifier for each asset type in the protocol. (`keccak256(abi.encode(token_address, chainId, [nftId])) % SNARK_SCALAR_FIELD`)

### `value`

The amount of tokens in a note. Must be positive and fit in 128 bits to prevent overflow in multi-note transactions.

### `chainId`

The network identifier. Included in `tokenId` computation to prevent cross-chain collision attacks.

## Circuit-Specific Terms

### Merkle Proof

Cryptographic proof that a leaf exists in a Merkle tree. Uses sibling hashes and path indices to reconstruct tree root for verification.

### leafIndex

The position of a leaf in a Merkle tree (0-indexed from left). Used in LeanIMT to determine the path through the tree.

### siblings

Array of sibling hashes along the path from leaf to root. In LeanIMT, may contain zeros for levels beyond actual tree depth.

### actualDepth

The current depth of a LeanIMT tree. Dynamic value that grows as more leaves are added. Optimizes constraint usage.

### maxDepth

The maximum supported depth of a Merkle tree. Template parameter — determines the size of the sibling array passed to in-circuit Merkle proofs. Current deployment uses `22` for the state tree, `18` for the keystore tree, and `18` for the ASP tree (see "Design Note about Tree Depth Limits" in `circuits-tech-design.md`).

## Economic and Operational Terms

### Deposit

The process of introducing funds into the privacy pool. Creates a new note and commitment. Requires proof of correct commitment construction.

### Registration

The process of proving label authenticity to an ASP for compliance. Non-spending operation. Required before notes become spendable.

### Transact

The process of spending input notes and creating output notes. Unified operation supporting private transfers and public withdrawals.

### Public Withdrawal

Removing funds from the privacy pool to a public Ethereum address. Reveals recipient address and amount. Used in ragequit or voluntary withdrawals.

### Relayer

A service that submits transactions on behalf of users for gas and privacy. Users can use different relayers for different operations to enhance privacy.

## Security and Validation Terms

### Range Check

A constraint that ensures a value fits within a specified bit range. Prevents overflow attacks and validates Ethereum address formats.

### Under-constrained

A signal that is not properly constrained by circuit equations. Security vulnerability. All signals must be fully constrained to prevent malleability.

## Implementation Terms

### circomlib

The standard library for Circom circuits, providing cryptographic primitives. v2.0.5 used throughout Privacy Pools v2. Battle-tested in production protocols.

### snarkjs

JavaScript library for generating and verifying SNARK proofs. Used for client-side proof generation and verification key management.

### Powers of Tau

A trusted setup ceremony for SNARK systems. Required for Groth16. Phase 1 is universal and reused from an existing ceremony: Privacy Pools v2 uses the PSE perpetual powers of tau (`ppot_0080_18.ptau`). Phase 2 is circuit-specific: the `ppv2-ceremony` phase-2 ceremony produced the proving and verification keys of all 27 circuits (see [`packages/circuits/CEREMONY.md`](../../../packages/circuits/CEREMONY.md)).

### Verification Key

Public parameters used to verify proofs for a specific circuit. Deployed on-chain as smart contracts. Circuit-specific and immutable. Output of the circuit's phase-2 ceremony; each verifier contract embeds its verification key, so new keys mean new verifier contracts.

### Proving Key

Parameters used to generate proofs for a specific circuit. Used client-side. Must match verification key for proof compatibility. Output of the circuit's phase-2 ceremony.

## Compliance and Regulatory Terms

### Taint

The association of funds with illicit or sanctioned sources. Privacy Pools v2 prevents taint propagation through non-fungible labels.

### Compliance Check

Verification that a label has been approved by an ASP. Required for all spending operations except emergency ragequit.

### Lineage

The transaction history and provenance of funds through their label. Each label represents a unique lineage, preventing cross-contamination.

### Association Set

The set of labels that an ASP has approved for spending. Maintained off-chain by ASP, with tree root published on-chain.

### Censorship Resistance

The property that transactions cannot be indefinitely blocked. Ragequit provides ultimate censorship resistance for fund recovery.

## Error and Edge Case Terms

### Stale Root

An outdated Merkle tree root that no longer represents current state. Proofs with stale roots are rejected to prevent replay attacks.

### Invalid Field Element

A number outside the valid range [0, p-1] for the BN128 scalar field. Causes circuit failures. All inputs must be validated.

### Zero Note

A note with zero value, which may be invalid depending on protocol rules. Typically rejected to prevent spam and ensure economic incentives.

### Tree Depth Exceeded

Attempting to insert more leaves than tree capacity allows. LeanIMT handles this gracefully by increasing depth dynamically.