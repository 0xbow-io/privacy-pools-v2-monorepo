# Circuits - Tech Design

## Background

Privacy Pools v2 uses three circuits. The circuits are implemented in Circom 2 and use the Groth16 proving system for on-chain verification.

# General

This document explains the role of each circuit in the system, how they integrate with the smart contracts, and the design principles guiding their implementation. As an overview, we will have the following three circuits:

| Circuit | Purpose | Spending? |
| --- | --- | --- |
| `deposit` | Creates a shielded note from a public deposit | No |
| `transact` | Private transfers and public withdrawals (M inputs → N outputs) | Yes |
| `ragequit` | Emergency withdrawal bypassing ASP compliance | Yes |

All circuits use shared helper components for common operations, such as `NoteCommitment` (computes note commitments), `KeystoreLeaf` (computes keystore leaves), `BinaryMerkleRoot` from [`@zk-kit/binary-merkle-root.circom`](https://www.npmjs.com/package/@zk-kit/binary-merkle-root.circom) (verifies Merkle tree inclusion) and `ValueConservation` (enforces economic correctness at global level and per-label level).

If you are unsure about certain terms, check the [PPv2 - Cryptography Glossary](cryptography-glossary.md).

> 🚨 A [Failure Mode Analysis (FMA)](circuits-failure-modes-and-recovery.md) was conducted to define action steps in the event of a loss of circuit soundness.

> 🪴 A [benchmark](circuits-benchmark.md) of the circuits was conducted to understand proof size, proving time, constraint count, and verification costs. 

> ⚠️ **Design Note about Tree Depth Limits**: The current implementation uses the following tree depth limits, trading proving time against capacity. Depths were raised from the original `18 / 14 / 14` as part of the M-1 fix to push back the cost of the tree-fill griefing vector flagged in the internal review:
> - **State tree**: 22 max depth (2^22 = 4,194,304 leaves)
> - **Keystore tree**: 18 max depth (2^18 = 262,144 leaves)
> - **ASP tree**: 18 max depth (2^18 = 262,144 leaves)
> Note: the state tree holds **timestamped commitment leaves AND timestamped nullifier leaves** (one shared structure). Capacity is shared across both leaf types. See "State Tree Leaf Construction" below for the domain-separation scheme that keeps the two leaf types distinct in-circuit.
> These limits represent a deliberate trade-off between capacity and performance. As the protocol scales and proving technology improves, these trees can be upgraded further.

> 🛡️ **State Tree Leaf Construction** (M-0 fix): The state tree holds two kinds of leaves that share the same Poseidon(`Field × Field`) hash domain. To prevent the M-0 forgery class (planting a nullifier whose inner value equals a fake commitment), every leaf is computed with a **domain-separation tag** as the first Poseidon input:
> - **Commitment leaf**: `Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)`
> - **Nullifier leaf**: `Poseidon(NULLIFIER_LEAF_TAG, nullifierHash, timestamp)`
>
> The tags are hardcoded compile-time constants in the circuits and mirrored in `packages/contracts/src/utils/Constants.sol` and `packages/core-sdk/src/constant/WitnessPreparationService.ts`. Their values must stay in sync across all three layers. See the Cryptography Glossary entry for `COMMITMENT_LEAF_TAG` / `NULLIFIER_LEAF_TAG` for the exact field values and their derivation.

## **Requirements**

Each one of them addresses a specific requirement:

1. `deposit`: initialize a new note and label, introducing funds into the pool. Its key features are:
    1. Compute label privately.
    2. Create initial commitment that binds note properties.
    3. Single-output design (one note per deposit)
    
    It is called via `deposit()` on the Pool contract after tokens are received. A contract verifies the proof and inserts the output commitment into the commitment tree. The checks that must happen are (a) the commitment is correctly constructed from private inputs, and (b) the deposited amount equals the value created in the commitment, both in `tokenId` and `amount`.
    
2. `transact`: its purpose is to spend input notes and create output notes, supporting both private transfers and withdrawals. The main features are:
    1. Verify input notes exists in commitment tree.
    2. M-input, N-output design (variable outputs, variable inputs)
    3. Unified circuit for transfers and withdrawals.
    4. Enforces per-label value conservation.
    5. Verifies ASP compliance for all inputs labels.
    
    It is called via `transact()`. The contract verifies the proof, checks nullifier uniqueness, records nullifiers as spent, verifies output commitments don't already exist, inserts output commitments, handles public withdrawals, and transfers fees to the relayer.
    
3. `ragequit`: this is the emergency withdrawal opting out of ASP compliance. Its main features are:
    1. Intentionally bypasses ASP compliance check.
    2. Forces withdrawal to the note's owner address.
    3. Outputs nullifier to prevent double-spending.
    4. Outputs reconstructed commitment for external verification.
    5. Label is a public input for ASP tracking.
    
    It is called by `ragequit()`. The contract verifies the proof, records the nullifier, and transfer funds to the owner address. This is a public withdrawal that sacrifices privacy to preserve ownership of your assets.
    
# In-Depth

Below, you'll find detailed documentation for each circuit and the shared helper components they use:

## 1. Helpers

### `NoteCommitment`

### Purpose

Computes the cryptographic commitment for a note in the Privacy Pools v2 system. This commitment scheme binds ownership, value, and lineage information into a single hash that can be stored in the commitment tree.

### Properties

- Each commitment is unique.
- Each commitment is unique.
- A commitment cryptographically binds all note properties.

### Signal Table

| Signal | Type | Field Element Conversion | Description |
| --- | --- | --- | --- |
| `noteAddressHash` | input | Already a field element (Poseidon output) | Pre-computed hash of owner address and note secret |
| `tokenId` | input | For ETH: `uint256(0xEeE)`
For ERC-20:
`uint256(tokenAddress)` | Asset identifier |
| `value` | input | Direct value (must be < 2^128) | Amount of tokens |
| `metadata` | input | Direct value (field element) | Note type identifier (0 for standard notes in v2.0) |
| `label` | input | Already a field element (Poseidon output) | Lineage identifier |
| `commitment` | output | Field element output | Final note commitment |

### Logic & Constraints

The commitment calculation follows these steps:

1. **Compute Precommitment:**
    - Combines the note address hash, token identifier, value, and metadata
    - `precommitment = Poseidon(noteAddressHash, tokenId, value, metadata)`
2. **Compute Final Commitment:**
    - Combines the precommitment with the lineage label
    - **Constraint:** `commitment === Poseidon(precommitment, label)`

This two-stage hashing enables efficient verification of note properties without revealing the label to parties who only need to verify ownership or value.

> 📌 **Design Note: Note-Level Polymorphism**: The `metadata` field enables different note types to coexist in the same Merkle tree (see ‣ ). 

### Thoughts

- For the first iteration of v2, we assume `metadata = 0` for all cases. That's why each circuit individually sets `metadata = 0` when calculating the precommitment. Given this, is it acceptable to not constrain the metadata in this circuit? The rationale is that it's already hardcoded in the other circuits. When we migrate later, we'll only need to add the signal to `deposit`, `ragequit`, `transact`, and `registerLabel`, without changing the `NoteCommitment` template.

### Implementation

```circom
/**
 * @title NoteCommitment
 * @notice Computes a commitment for notes in Privacy Pools v2
 * @dev precommitment = Poseidon(noteAddressHash, tokenId, value, metadata)
 *      commitment = Poseidon(precommitment, label)
 */
template NoteCommitment() {
    // ======================== INPUT SIGNALS ========================

    signal input noteAddressHash;  // Poseidon(ownerAddressHash, noteSecret)
    signal input tokenId;          // uint256(tokenAddress) - ERC20 token address
    signal input value;            // Token amount
    signal input metadata;         // Extra information
    signal input label;            // Lineage identifier

    // ======================== OUTPUT SIGNALS ========================

    signal output commitment;      // Final note commitment

    // ======================== INTERMEDIATE SIGNALS ========================

    signal precommitment;

    // ======================== CONSTRAINT LOGIC ========================

    // 1. Compute precommitment
    // Binds noteAddressHash, value, tokenId and metadata
    component precommitmentHasher = Poseidon(4);
    precommitmentHasher.inputs[0] <== noteAddressHash;
    precommitmentHasher.inputs[1] <== tokenId;
    precommitmentHasher.inputs[2] <== value;
    precommitmentHasher.inputs[3] <== metadata;
    precommitment <== precommitmentHasher.out;

    // 2. Compute final commitment
    // Binds precommitment with lineage label
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== precommitment;
    commitmentHasher.inputs[1] <== label;
    commitment <== commitmentHasher.out;
}
```

### `KeystoreLeaf`

### Purpose

Computes a user's keystore leaf from their public address and private keys. This leaf is stored in the keystore tree and verified during transactions to prove user registration.

### Properties

- **Key Binding**: Leaf cryptographically binds all user keys
- **Authorization Extensibility**: The `authDigest` supports multiple authorization methods via `authType`
- **Revocability**: Includes revocable key for potential rotation

### Signal Table

| Signal | Type | Field Element Conversion | Description |
| --- | --- | --- | --- |
| `ownerAddress` | input | `uint256(address)` | User's EVM address |
| `privateNullifyingKey` | input | Already a field element (random value in field) | Immutable nullifying key |
| `authDigest` | input | Already a field element (random value in field) | Computed by caller based on `authType`. |
| `keystoreLeaf` | output | Field element output | Computed keystore leaf |

### Logic & Constraints

A leaf of this tree is computed as `Poseidon(ownerAddress, nullifyingKeyHash, authDigest)`. The calculation follows these steps:

1. **Compute Nullifying Key Hash:**
    - `nullifyingKeyHash = Poseidon(privateNullifyingKey)`
2. Receive `authDigest`: (see [**Key Architectural Concepts**](../key-architectural-concepts.md#37-note-level-polymorphism-via-reserved-metadata))
    - `authType = 0`: `authDigest = Poseidon(0, privateRevocableKey)`. The circuit verifies knowledge of `privateNullifyingKey` via hash preimage.
3. **Compute Final Leaf.**
    - The `keystoreLeaf` is computed from the combination of the previously computed hashes:`keystoreLeaf === Poseidon(ownerAddress, nullifyingKeyHash, authDigest)`

### Implementation

```circom
/**
 * @title KeystoreLeaf
 * @notice Computes keystore leaf from owner address, nullifying key, and auth digest
 * @dev Generic template that works with any authType. The authDigest is computed
 *      externally by the caller based on the specific authType.
 *      This template performs 2 steps:
 *      1. nullifyingKeyHash = Poseidon(privateNullifyingKey)
 *      2. keystoreLeaf = Poseidon(ownerAddress, nullifyingKeyHash, authDigest)
 */
template KeystoreLeaf() {
    // ======================== INPUT SIGNALS ========================

    signal input ownerAddress;           // uint256(ownerAddress)
    signal input privateNullifyingKey;   // Immutable nullifying key
    signal input authDigest;             // Pre-computed by caller based on authType

    // ======================== OUTPUT SIGNALS ========================

    signal output keystoreLeaf;       // Final leaf for keystore tree

    // ======================== INTERMEDIATE SIGNALS ========================

    signal nullifyingKeyHash;

    // ======================== CONSTRAINT LOGIC ========================

    // 1. Hash nullifying key
    component nullifyingKeyHasher = Poseidon(1);
    nullifyingKeyHasher.inputs[0] <== privateNullifyingKey;
    nullifyingKeyHash <== nullifyingKeyHasher.out;

    // 2. Compute final leaf
    component leafHasher = Poseidon(3);
    leafHasher.inputs[0] <== ownerAddress;
    leafHasher.inputs[1] <== nullifyingKeyHash;
    leafHasher.inputs[2] <== authDigest;
    keystoreLeaf <== leafHasher.out;
}
```

### `ValueConservation`

### Purpose

Enforces per-label and global value conservation across transaction inputs and outputs. This is critical for maintaining lineage separation (taint containment) while ensuring economic correctness.

### Parameters

- `nInputs`: Number of input notes
- `mOutputs`: Number of output notes

### Signal Table

| Signal | Type | Description |
| --- | --- | --- |
| `inputValues[nInputs]` | input array | Values of input notes |
| `inputLabels[nInputs]` | input array | Labels of input notes |
| `outputValues[mOutputs]` | input array | Values of output notes |
| `outputLabels[mOutputs]` | input array | Labels of output notes |
| `amountOut` | input | Public withdrawal amount (0 for pure transfer) |

### Logic & Constraints

Value conservation operates at two levels:

1. **Global Value Conservation:**
    - Sum all input values.
    - Sum all output values and public withdrawal.
    - **Constraint:** `Σ(inputValues) === Σ(outputValues) + amountOut`.
2. **Per-Label Value Conservation:**
    - For each unique label L appearing in inputs or outputs:
    - **Constraint:** `Σ(inputValues where label=L) ≥ Σ(outputValues where label=L)`.
    - The sum of input values for each label must be greater than or equal to the sum of output values for that label.

The per-label conservation requires conditional accumulation logic based on label matching across inputs and outputs.

### Implementation

```rust
/**
 * @title ValueConservation
 * @notice Enforces per-label AND global value conservation in transactions
 * @dev Two levels of conservation:
 *      1. Global: sum(inputValues) === sum(outputValues) + amountOut
 *      2. Per-Label: For each label L, sum(inputValues[L]) >= sum(outputValues[L])
 *
 * This is a pure constraint template with no output signals.
 *
 * @param nInputs Number of input notes (must be >= 1)
 * @param mOutputs Number of output notes (must be >= 1, typically 2)
 */
template ValueConservation(nInputs, mOutputs) {
    // Parameter validation
    assert(nInputs >= 1);
    assert(mOutputs >= 1);

    // ======================== INPUT SIGNALS ========================

    signal input inputValues[nInputs];      // Values of input notes
    signal input inputLabels[nInputs];      // Labels of input notes
    signal input outputValues[mOutputs];    // Values of output notes
    signal input outputLabels[mOutputs];    // Labels of output notes
    signal input amountOut;                 // Withdrawal amount (0 for pure transfer)

    // ======================== INTERMEDIATE SIGNALS ========================

    // Global conservation signals
    signal inputSum[nInputs];               // Cumulative input sums
    signal outputSum[mOutputs];             // Cumulative output sums
    signal totalIn;                         // Total input value
    signal totalOut;                        // Total output value (includes amountOut)

    // Per-label conservation signals (for each output label)
    signal inputAccum[mOutputs][nInputs + 1];    // Accumulator for matching inputs per output label
    signal outputAccum[mOutputs][mOutputs + 1];  // Accumulator for matching outputs per output label

    // ======================== COMPONENTS ========================

    component labelMatches[mOutputs][nInputs];          // Check if input label matches output label
    component outputLabelMatches[mOutputs][mOutputs];   // Check if output labels match each other
    component conservationChecks[mOutputs];              // Verify inputs >= outputs per label

    // ======================== CONSTRAINT LOGIC ========================

    // ===== GLOBAL VALUE CONSERVATION =====

    // Sum all input values
    inputSum[0] <== inputValues[0];
    for (var i = 1; i < nInputs; i++) {
        inputSum[i] <== inputSum[i-1] + inputValues[i];
    }
    totalIn <== inputSum[nInputs - 1];

    // Sum all output values
    outputSum[0] <== outputValues[0];
    for (var i = 1; i < mOutputs; i++) {
        outputSum[i] <== outputSum[i-1] + outputValues[i];
    }
    totalOut <== outputSum[mOutputs - 1] + amountOut;

    // No value creation or destruction allowed
    totalIn === totalOut;

    // ===== PER-LABEL VALUE CONSERVATION =====

    // For each output label, verify that sum of inputs with that label >= sum of ALL outputs with that label
    // Note: This redundantly checks the same label multiple times if outputs share labels,
    //       but all checks will produce the same result, ensuring correctness.
    for (var outIdx = 0; outIdx < mOutputs; outIdx++) {
        // Initialize accumulator for inputs with this output's label
        inputAccum[outIdx][0] <== 0;

        // Sum all inputs that have the same label as this output
        for (var inIdx = 0; inIdx < nInputs; inIdx++) {
            // Check if input label matches this output's label
            labelMatches[outIdx][inIdx] = IsEqual();
            labelMatches[outIdx][inIdx].in[0] <== inputLabels[inIdx];
            labelMatches[outIdx][inIdx].in[1] <== outputLabels[outIdx];

            // If labels match (out=1): add inputValues[inIdx]
            // If labels don't match (out=0): add 0
            // This is safe because IsEqual.out is constrained to be boolean
            inputAccum[outIdx][inIdx + 1] <== inputAccum[outIdx][inIdx] +
                                               inputValues[inIdx] * labelMatches[outIdx][inIdx].out;
        }

        // Initialize accumulator for outputs with this output's label
        outputAccum[outIdx][0] <== 0;

        // Sum ALL outputs that have the same label as this output (including itself)
        for (var otherOutIdx = 0; otherOutIdx < mOutputs; otherOutIdx++) {
            // Check if other output's label matches this output's label
            outputLabelMatches[outIdx][otherOutIdx] = IsEqual();
            outputLabelMatches[outIdx][otherOutIdx].in[0] <== outputLabels[otherOutIdx];
            outputLabelMatches[outIdx][otherOutIdx].in[1] <== outputLabels[outIdx];

            // If labels match (out=1): add outputValues[otherOutIdx]
            // If labels don't match (out=0): add 0
            outputAccum[outIdx][otherOutIdx + 1] <== outputAccum[outIdx][otherOutIdx] +
                                                      outputValues[otherOutIdx] * outputLabelMatches[outIdx][otherOutIdx].out;
        }

        // Verify: inputSum >= outputSum for this label
        // This ensures no value creation within a label
        conservationChecks[outIdx] = LessEqThan(128);
        conservationChecks[outIdx].in[0] <== outputAccum[outIdx][mOutputs];  // sum of ALL outputs with this label
        conservationChecks[outIdx].in[1] <== inputAccum[outIdx][nInputs];    // sum of ALL inputs with this label

        conservationChecks[outIdx].out === 1;
    }
}
```

## 2. Deposit

### Purpose

The `deposit` circuit is a single output commitment circuit that proves a commitment was correctly constructed from a set of public and private inputs according to the protocol's commitment scheme. The circuit computes the label using a private `depositSecret`, ensuring that when the note is later transferred, the recipient cannot reverse-engineer the label to discover the original deposit. This is the entry point for all funds into the Privacy Pool.

The `deposit` circuit creates exactly one note. Multi-output deposits would require value splitting logic in the circuit, so it is not an option. Users who need multiple notes can execute multiple deposits.

### Properties

The deposit circuit maintains the following properties:

1. **Label Privacy**: External observers cannot identify which deposit a label originated from, as the label is computed privately within the circuit using the depositor's secret
2. **Value Conservation**: The deposited value matches the value embedded in the commitment.

> 📎 **Preconditions**
> - **Token/Amount Matching**: The on-chain contract must verify that the `tokenId` and `value` in the proof match the actual tokens being deposited.
> Note that other checks like *Note Existence* and *Commitment Uniqueness* are enforced on-chain rather than in this circuit. The contract must verify the commitment doesn't already exist in the tree before insertion.

### Signals

> 📎 Consider that $\forall \space \text{input} \in \mathbb{F}_p$

| Signal | Type | Visibility | Field Element Conversion | Description |
| --- | --- | --- | --- | --- |
| `tokenId` | input | public | For ETH: `uint256(0xEeE)`

For ERC-20:
`uint256(tokenAddress)` | Asset identifier |
| `value` | input | public | Direct value (must be < 2^128) | Amount being deposited |
| `context` | input | public | Already a field element (hash output) | Commitment to deposit details |
| `noteAddressHash` | input | private | `Poseidon(ownerAddress, noteSecret)` | Computed outside the circuit. |
| `depositSecret` | input | private | Random field element | Secret for label computation |
| `outputCommitment` | output | public | Field element output | Final commitment for tree insertion |

### Logic and Constraints

1. Range Check Value: The `value` signal must be constrained to be less than $2^{128}$ to prevent overflow attacks. This is done using `Num2Bits(128)`.
2. Compute precommitment: bind `tokenId`, `value`, and `metadata` to `noteAddressHash`. This is computed as `precommitment = Poseidon(noteAddressHash, tokenId, value, 0)`
    
> 📌 Note that the precommitment structure is formed by hashing `noteAddressHash, tokenId, value, metadata`. For this first iteration, metadata is hardcoded to `0`.
        
3. Compute label: create a unique lineage identifier that is private from public observers by computing `label = Poseidon(precommitment, depositSecret)`

The `depositSecret` ensures that the label cannot be linked back to the deposit without knowledge of this secret.  ****

> 📌 **Design Note: Why Label computation must happen in the circuit?**: If label computation happened on-chain, as we did in version 1, (e.g. `label = Poseidon(msg.sender, nonce)`), the label would be publicly observable and permanently linked to the depositor's address. By moving this computation into the private circuit:
> 1. External observers cannot see the label in the contract nor in the events.
> 2. Recipients receive the label but cannot trace it back
> The current design also allows the ASP to verify label authenticity during registration without publicly exposing the deposit-to-label link.

4. Compute commitment: create the final commitment that will be published on-chain doing `commitment = Poseidon(precommitment, label)`.
5. Context binding: bind the `context` public input to the proof via a non-linear constraint `contextSquared = context * context`. This forces `context` into the R1CS witness and public inputs, preventing proof malleability. The contract guarantees `context` is never 0.
6. Constrain the computed commitment to match the public output signal, `outputCommitment == commitment`.

### Implementation

```circom
/**
 * @title Deposit
 * @notice Creates a note commitment with private label computation
 * @dev Entry point for funds into Privacy Pools
 *      - Computes label privately using depositSecret
 *      - There is only one note per deposit
 *      - Value must be < 2^128
 */
template Deposit() {
    // ======================== INPUT SIGNALS ========================

    // Public inputs
    signal input tokenId;        // uint256(tokenAddress)
    signal input value;          // Amount being deposited
    signal input context;        // Commitment to deposit details

    // Private inputs
    signal input noteAddressHash;    // Poseidon(ownerAddress, noteSecret)
    signal input depositSecret;      // Random secret for private label computation

    // ======================== OUTPUT SIGNALS ========================

    signal output outputCommitment;  // Final commitment for tree insertion

    // ======================== INTERMEDIATE SIGNALS ========================

    signal precommitment;
    signal label;
    signal commitment;

    // ======================== CONSTRAINT LOGIC ========================

    // 1. Range check: value < 2^128
    component valueRangeCheck = Num2Bits(128);
    valueRangeCheck.in <== value;

    // 2. Compute precommitment = Poseidon(noteAddressHash, tokenId, value, metadata)
    // Note that metadata is for future features, for now it is hardcoded to 0.
    component precommitmentHasher = Poseidon(4);
    precommitmentHasher.inputs[0] <== noteAddressHash;
    precommitmentHasher.inputs[1] <== tokenId;
    precommitmentHasher.inputs[2] <== value;
    precommitmentHasher.inputs[3] <== 0;  // metadata = 0
    precommitment <== precommitmentHasher.out;

    // 3. Compute label = Poseidon(precommitment, depositSecret)
    component labelHasher = Poseidon(2);
    labelHasher.inputs[0] <== precommitment;
    labelHasher.inputs[1] <== depositSecret;
    label <== labelHasher.out;

    // 4. Compute final commitment = Poseidon(precommitment, label)
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== precommitment;
    commitmentHasher.inputs[1] <== label;
    commitment <== commitmentHasher.out;

    // 5. Context binding
    // Forces context into the R1CS witness and public inputs.
    signal contextSquared;
    contextSquared <== context * context;

    // 6. Output constraint
    outputCommitment <== commitment;
}
```

## 3. RageQuit

### Purpose

The ragequit circuit provides an emergency withdrawal mechanism that allows users to recover funds even when compliance has failed or the ASP has censored their label. This circuit bypasses all ASP compliance checks and forces a public withdrawal to the note's owner address, ensuring user funds can never be permanently frozen.

### Checks and properties

The ragequit circuit checks authorization Integrity, meaning that the spender must prove ownership through valid key registry membership.

And the following properties should be enforced:

1. **Forced Recipient**: Withdrawal recipient must match note's `ownerAddress`
2. **Value Integrity**: Withdrawal amount exactly matches the note's value

The circuit intentionally bypasses ASP Compliance.

### Circuit Spec

The `ragequit` circuit follows a 1-input spending design:

> 📎 Consider that $\forall \space \text{input} \in \mathbb{F}_p$

### Signals

| Signal | Type | Visibility | Field Element Conversion | Description |
| --- | --- | --- | --- | --- |
| `keystoreRoot` | input | public | Already a field element (tree root) | Current keystore root |
| `ownerAddress` | input | public | `uint256(ownerAddress)` | Forced withdrawal recipient |
| `value` | input | public | Direct value (must be < 2^128) | Note amount |
| `tokenId` | input | public | For ETH: `uint256(0xEeE)`

For ERC-20:
`uint256(tokenAddress)` | Asset identifier |
| `label` | input | public | Already a field element | Lineage identifier (received in transfer) |
| `privateNullifyingKey` | input | private | Random field element | Key for nullifier |
| `noteSecret` | input | private | Random field element | Secret from deposit |
| `metadata` | input | private | Direct value (field element) | Note type identifier (0 for standard notes in v2.0) |
| `privateRevocableKey` | input | private | Random field element | Revocable authorization key |
| `keystoreLeafIndex` | input | private | Direct index (< 2^maxDepth) | Position in keystore |
| `keystoreSiblings\[maxDepth\]` | input array | private | Field elements (hashes or zeros) | Merkle path for keystore |
| `keystoreTreeDepth` | input | private | Direct value (≤ maxDepth) | Keystore tree depth |
| `nullifierHash` | output | public | Field element output | Nullifier to prevent double-spending |

### Logic and Constraints

The ragequit circuit follows these steps:

1. **User Authorization:** Verifies the user is registered in the keystore and owns valid authorization keys. This is done by:
2. Validating `keystoreTreeDepth <= maxDepth`
3. Computing `authDigest = Poseidon(0, privateRevocableKey)` for `authType = 0`
4. Computing keystore leaf using `KeystoreLeaf` helper (which computes `nullifyingKeyHash` and final leaf)
5. Verifying `BinaryMerkleRoot(keystoreLeaf, keystoreLeafIndex, keystoreSiblings, keystoreTreeDepth).out === keystoreRoot`
6. **Reconstruct Note Commitment:** Proves knowledge of all the secrets that comprise the note using the `NoteCommitment` helper:
7. Compute `noteAddressHash = Poseidon(ownerAddress, noteSecret)`
8. Use `NoteCommitment` helper with `noteAddressHash`, `tokenId`, `value`, `metadata`, and `label`
9. Output the reconstructed `commitment` for external verification
10. **Generate Nullifier:** Computes unique nullifier to prevent double-spending by computing `nullifierHash = Poseidon(privateNullifyingKey, commitment)`
1. **Output Label Hash:** Exposes the label hash (`labelHash = Poseidon(label)`)

### Implementation

```circom
/**
 * @title Ragequit
 * @notice Emergency withdrawal circuit that bypasses ASP compliance.
 * @dev Allows users to recover funds when compliance has failed or the ASP
 *      has censored their label or something works wrong on the system.
 *      This circuit intentionally bypasses ASP compliance checks and forces a
 *      public withdrawal to the note's owner address, ensuring user funds can
 *      never be permanently frozen.
 * @param maxDepth Maximum keystore Merkle tree depth (18 for ~262k keystore entries)
 */
template Ragequit(maxDepth) {
    // ======================== PUBLIC INPUT SIGNALS ========================

    signal input keystoreRoot;            // Keystore tree root
    signal input ownerAddress;            // Forced withdrawal recipient (must match note owner)
    signal input value;                   // Total note value (full amount is withdrawn)
    signal input tokenId;                 // uint256(tokenAddress)
    signal input label;                   // Lineage identifier for ASP tracking

    // ======================== PUBLIC OUTPUT SIGNALS ========================

    signal output nullifierHash;          // Nullifier for double-spend prevention
    signal output commitment;             // Reconstructed commitment (verified externally)

    // ======================== PRIVATE INPUT SIGNALS - NOTE ========================

    signal input noteSecret;              // Secret from deposit
    signal input metadata;            // Note metadata (0 for standard notes in v2.0)

    // ======================== PRIVATE INPUT SIGNALS - AUTHORIZATION ========================

    signal input privateNullifyingKey;    // Key for nullifier derivation
    signal input privateRevocableKey;     // Revocable key for auth (authType=0)
    signal input keystoreLeafIndex;            // Position in keystore
    signal input keystoreSiblings[maxDepth];     // Merkle path for keystore
    signal input keystoreTreeDepth;        // Keystore tree depth

    // ======================== CONSTRAINT LOGIC ========================

    // ===== AUTHORIZATION VERIFICATION =====
    // Verify the user is registered in the keystore with valid keys

    // 1. Validate keystoreTreeDepth <= maxDepth
    // SECURITY: Range check depth BEFORE comparison to prevent field-wrap bypass.
    // LessEqThan(n) uses Num2Bits internally on a computed value, which can wrap.
    // By constraining the input to fit in 6 bits first, we ensure valid comparison.
    component keystoreDepthRange = Num2Bits(6);
    keystoreDepthRange.in <== keystoreTreeDepth;

    component keystoreDepthCheck = LessEqThan(6);
    keystoreDepthCheck.in[0] <== keystoreTreeDepth;
    keystoreDepthCheck.in[1] <== maxDepth;
    keystoreDepthCheck.out === 1;

    // 2. Compute authDigest for authType = 0
    component authDigestHasher = Poseidon(2);
    authDigestHasher.inputs[0] <== 0;  // AUTH_TYPE.DIRECT_KEY
    authDigestHasher.inputs[1] <== privateRevocableKey;

    // 3. Compute keystore leaf using helper
    component keyLeaf = KeystoreLeaf();
    keyLeaf.ownerAddress <== ownerAddress;
    keyLeaf.privateNullifyingKey <== privateNullifyingKey;
    keyLeaf.authDigest <== authDigestHasher.out;

    // 4. Verify keystore inclusion
    component authorizationProof = BinaryMerkleRoot(maxDepth);
    authorizationProof.leaf <== keyLeaf.keystoreLeaf;
    authorizationProof.index <== keystoreLeafIndex;
    authorizationProof.depth <== keystoreTreeDepth;
    for (var i = 0; i < maxDepth; i++) {
        authorizationProof.siblings[i] <== keystoreSiblings[i];
    }
    authorizationProof.out === keystoreRoot;

    // ===== NOTE COMMITMENT RECONSTRUCTION =====
    // Prove knowledge of all secrets comprising the note

    // 1. Compute noteAddressHash = Poseidon(ownerAddress, noteSecret)
    component noteAddrHasher = Poseidon(2);
    noteAddrHasher.inputs[0] <== ownerAddress;
    noteAddrHasher.inputs[1] <== noteSecret;

    // 2. Reconstruct commitment using NoteCommitment
    // Note: value has no explicit Num2Bits(128) range check. The value must reconstruct
    // a valid commitment that exists in the state tree, and all committed values
    // originate from Deposit (which enforces value < 2^128). A mismatched value would produce
    // a different commitment, failing external state tree verification.
    component noteCommitment = NoteCommitment();
    noteCommitment.noteAddressHash <== noteAddrHasher.out;
    noteCommitment.tokenId <== tokenId;
    noteCommitment.value <== value;
    noteCommitment.metadata <== metadata;
    noteCommitment.label <== label;

    // 3. Output commitment for external verification
    commitment <== noteCommitment.commitment;

    // ===== NULLIFIER GENERATION =====
    // Generate unique nullifier

    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== privateNullifyingKey;
    nullifierHasher.inputs[1] <== noteCommitment.commitment;
    nullifierHash <== nullifierHasher.out;

}
```

## 4. Transact

### Purpose

The transact circuit is the primary spending mechanism in Privacy Pools v2, enabling both private transfers and public withdrawals. This circuit spends input notes and creates output notes while enforcing three critical purposes: ASP compliance verification, value conservation (per-label and global), and authorization through key registry membership.

There are three architectural approaches for implementing the circuit:

- Approach A: Monolithic Circuit, a single circuit that verifies authorization, compliance, and value conservation together. One proof per transaction.
- Approach B: Three separate circuits, each handling one concern (auth, compliance, value). Three proofs per transaction, but each can be upgraded independently.
- Approach C: Hybrid Approach, two-circuit design combining compliance+value with separate authorization.

> 🤔 **Status**: Active Discussion. This section documents an ongoing architectural decision between two approaches: a single monolithic verification circuit vs. multiple specialized circuits. The current recommendation is unified/monolithic, but benchmarking and further analysis may inform the final decision.

Some of the trade offs are:

- Gas cost: Each Groth16 proof verification costs ~200k gas. Three proofs = ~600k gas vs ~200k for unified. This 3x gas penalty applies to every transaction, forever.
- Proving time: Mobile and browser wallet constraints are real. Three proofs could push proving time to 30-90 seconds on mobile devices.
- Attack surface: Split verifiers must coordinate (same commitment, same nullifier, same public inputs). This coordination logic is additional attack surface.
- Upgrade granularity: Split allows updating auth logic without touching value logic. However, auth, compliance, and value all operate on the same commitment structure—the coupling is inherent to the data model.

For now, **the protocol will start with a unified verifier architecture**. The `authType` mechanism allows deploying split verifiers as a future opt-in upgrade if the modularity proves valuable. Starting unified doesn't close doors, it defers the complexity cost until proven necessary.

> ⏱️ **Benchmarking** Before finalizing this decision, we will benchmark proving time for both architectures to understand the actual performance impact on target devices (mobile, browser extensions). Key metrics: constraint counts, proving time on iPhone/Android, proving time in browser WASM.

Note that this specification focuses on approach A, as approaches B and C follow the same logic but with separate circuits.

### Properties and Checks

The `transact` circuit checks the following:

- Authorization Integrity: Proves ownership of input notes, verifying that the user knows the preimage of a keystore leaf that exists in the current `keystoreRoot` and generating unique nullifiers for each input.
- Note Existence: All input notes exist in the commitment tree.
- ASP Compliance: Verifies that each input note's label exists in the ASP's `associationSetRoot` tree, ensuring all spent notes have been registered and approved for compliance.
- Nullifier Uniqueness: Each input generates a unique nullifier via `Poseidon(privateNullifyingKey, commitment)`, which is later checked for uniqueness by the contract.
- Value Conservation: Enforces two levels:
    - Per-Label Conservation: For each unique label, input values must equal output values for that label (prevents mixing different lineages).
    - Global Conservation: Total input value equals total output value plus public withdrawal.

### Circuit Spec

Note that the protocol will need to deploy separate verifier contracts for different input counts (1-input verifier, 2-input verifier, N-input verifiers) to avoid the constraint overhead of dummy input notes. All verifiers use **2 fixed outputs**. Transactions using fewer outputs employ zero-value dummy notes to fill remaining slots. 

### Signals

| Signal | Type | **Visibility** | Field Element Conversion | Description |
| --- | --- | --- | --- | --- |
| `stateRoot` | input | public | Already a field element (tree root) | Commitment tree root |
| `keystoreRoot` | input | public | Already a field element (tree root) | Keystore root |
| `associationSetRoot` | input | public | Already a field element (tree root) | ASP tree root |
| `amountOut` | input | public | Direct value (must be < 2^128) | Public withdrawal amount (0 for pure transfer) |
| `tokenIdOut` | input | public | For ETH: `uint256(0xEeE)`

For ERC-20:
`uint256(tokenAddress)` | Token being withdrawn (uint256(address(0)) for pure transfer) |
| `context` | input | public | Already a field element (hash output) | Commitment to withdrawal details. |
| `outputCommitments[mOutputs]` | output array | public | Field element output | Output note commitments |
| `nullifierHashes[nInputs]` | output array | public | Field element output | Nullifiers for double-spend prevention |

**Authorization (Once Per Transaction):**

| **Signal** | **Type** | **Visibility** | **Description** |
| --- | --- | --- | --- |
| `ownerAddress` | input | private | `uint256(ownerAddress)` |
| `privateNullifyingKey` | input | private | Nullifying key |
| `privateRevocableKey` | input | private | Revocable authorization key |
| `keystoreLeafIndex` | input | private | Position in keystore |
| `keystoreSiblings[keystoreMaxDepth]` | input array | private | Keystore Merkle path |
| `keystoreTreeDepth` | input | private | Keystore tree depth |

**Per Input Note (Arrays of Size nInputs):**

| Signal | Type | **Visibility** | Description |
| --- | --- | --- | --- |
| `noteSecret[i]` | input array | private | Note secret for input i |
| `value[i]` | input array | private | Value of input i |
| `tokenId` | input | private | Token ID (shared across all inputs) |
| `label[i]` | input array | private | Label of input i |
| `stateLeafIndex[nInputs]` | input array | private | Position in state tree |
| `stateSiblings[nInputs][stateMaxDepth]` | input 2D array | private | State Merkle path |
| `stateTreeDepth[nInputs]` | input array | private | State tree depth per input |
| `associationSetLeafIndex[nInputs]` | input array | private | Position in association set tree |
| `associationSetSiblings[nInputs][associationSetMaxDepth]` | input 2D array | private | Association set Merkle path |
| `associationSetTreeDepth[nInputs]` | input array | private | Association set tree depth per input |

**Per Output Note (Arrays of Size 2):**

| Signal | Type | **Visibility** | Description |
| --- | --- | --- | --- |
| `outputNoteAddressHash[j]` | input array | private | `Poseidon(ownerAddress, noteSecret)` |
| `outputValue[j]` | input array | private | Output value |
| `outputLabel[j]` | input array | private | Output label |

### Logic & Constraints

The circuit follows these steps:

1. Authorization Verification: Prove the user has registered their keys and is authorized to spend notes.
2. Compute `authDigest = Poseidon(0, privateRevocableKey)` for `authType = 0`
3. Compute keystore leaf using `KeystoreLeaf` helper (which computes `nullifyingKeyHash` and final leaf)
4. Verify inclusion: `BinaryMerkleRoot(keyLeaf, keystoreLeafIndex, keystoreSiblings, keystoreTreeDepth).out === keystoreRoot`
5. Input Note Verification: for each input note (repeated nInputs times). In order to do that, it reconstruct Input commitment:
    1. Compute note address hash: `noteAddressHash[i] = Poseidon(ownerAddress, noteSecret[i])`
    2. Compute commitment using `NoteCommitment` helper with `metadata = 0`
    3. Verify commitment exists: `BinaryMerkleRoot(stateLeaf, stateLeafIndex[i], stateSiblings[i], stateTreeDepth[i]).out === stateRoot`
    4. Verify ASP Compliance by computing `labelHash[i] = Poseidon(label[i])` and verifying `BinaryMerkleRoot(labelHash[i], associationSetLeafIndex[i], associationSetSiblings[i], associationSetTreeDepth[i]).out === associationSetRoot`
    5. Generate nullifier: `nullifierHash[i] = Poseidon(privateNullifyingKey, commitment[i])`
6. Output Note Construction: for each output note (repeated 2 times), construct the output commitment using the pre-computed recipient commitment:
    1. Range check output value: `Num2Bits(128).in <== outputValue[j]`
    2. Compute output commitment using `NoteCommitment` helper with:
        1. `noteAddressHash = outputNoteAddressHash[j]` (pre-computed by recipient)
        2. `tokenId = tokenId` (shared)
        3. `value = outputValue[j]`
        4. `metadata = outputMetadata[j]`
        5. `label = outputLabel[j]`
7. **Value Conservation:** Uses `ValueConservation(nInputs, mOutputs)` helper which enforces
    1. Global Conservation: `Σ(value[i]) === Σ(outputValue[j]) + amountOut`
    2. Per-Label Conservation: For each label L: `Σ(value[i] where label[i]=L) ≥ Σ(outputValue[j] where outputLabel[j]=L)`
8. **Token Consistency:** Ensure withdrawal token matches the notes' token: `tokenId === tokenIdOut`
9. **Public Input Binding:** Bind encrypted payload and context to prevent tampering:
    1. `payloadSquared = encryptedPayloadHash * encryptedPayloadHash`
    2. `contextSquared = context * context`

> 📌 Design Note: The `context` signal is a public input that is pre-computed by the client. Its binding to the withdrawal details is checked by the on-chain contract. To prevent malleability attacks on the proof itself, this public input is constrained non-linearly within the circuit.

### Implementation

```circom
/**
 * @title Transact
 * @notice Enables private transfers and public withdrawals.
 * @dev Enables private transfers and public withdrawals while enforcing:
 *      - Authorization verification via keystore
 *      - Input note existence in state tree
 *      - ASP compliance for all input labels
 *      - Nullifier generation
 *      - Output note construction
 *      - Value conservation
 *      - Context binding for transaction details
 * @param nInputs Number of input notes
 * @param mOutputs Number of output notes
 * @param stateMaxDepth Maximum State Merkle tree depth
 * @param keystoreMaxDepth Maximum Keystore Merkle tree depth
 * @param associationSetMaxDepth Maximum association set Merkle tree depth
 */
template Transact(nInputs, mOutputs, stateMaxDepth, keystoreMaxDepth, associationSetMaxDepth) {
    // ======================== PUBLIC INPUT SIGNALS ========================

    signal input stateRoot;               // Commitment tree root
    signal input keystoreRoot;            // Keystore tree root
    signal input associationSetRoot;      // ASP association set tree root
    signal input amountOut;               // Public withdrawal amount (0 for pure transfer)
    signal input tokenIdOut;              // Token being withdrawn (uint256(address(0)) for pure transfer
    signal input context;                 // Commitment to withdrawal details

    // ======================== PUBLIC OUTPUT SIGNALS ========================

    signal output nullifierHashes[nInputs];       // Nullifiers
    signal output outputCommitments[mOutputs];    // Output note commitments

    // ======================== PRIVATE INPUT SIGNALS - AUTHORIZATION ========================

    signal input ownerAddress;                    // uint256(ownerAddress)
    signal input privateNullifyingKey;            // Nullifying key for nullifier generation
    signal input privateRevocableKey;             // Revocable authorization key
    signal input keystoreLeafIndex;                // Position in keystore tree
    signal input keystoreSiblings[keystoreMaxDepth];   // Merkle path for keystore
    signal input keystoreTreeDepth;            // Current keystore tree depth

    // ======================== PRIVATE INPUT SIGNALS - PER INPUT NOTE ========================

    signal input noteSecret[nInputs];                       // Note secret for each input
    signal input value[nInputs];                            // Value of each input
    signal input label[nInputs];                            // Label of each input
    signal input tokenId;                                   // uint256(tokenAddress)
    signal input stateLeafIndex[nInputs];              // Position in state tree
    signal input stateSiblings[nInputs][stateMaxDepth];     // State Merkle paths
    signal input stateTreeDepth[nInputs];                // State tree depth per input
    signal input associationSetLeafIndex[nInputs];                     // Position in association set tree
    signal input associationSetSiblings[nInputs][associationSetMaxDepth];            // Association set Merkle paths
    signal input associationSetTreeDepth[nInputs];                  // Association set tree depth per input
    signal input timestamp[nInputs]; // The block timestamp when the commitment was inserted into the state tree.

    // ======================== PRIVATE INPUT SIGNALS - PER OUTPUT NOTE ========================

    signal input outputNoteAddressHash[mOutputs];   // Poseidon(ownerAddress, noteSecret)
    signal input outputValue[mOutputs];             // Output value
    signal input outputLabel[mOutputs];             // Output label

    // ======================== CONSTRAINT LOGIC ========================

    // ===== AUTHORIZATION VERIFICATION =====
    // Verify the user is registered in the keystore with valid keys

    // 1. Compute authDigest for authType = 0
    component authDigestHasher = Poseidon(2);
    authDigestHasher.inputs[0] <== 0;  // AUTH_TYPE.DIRECT_KEY
    authDigestHasher.inputs[1] <== privateRevocableKey;

    // 2. Compute keystore leaf using helper
    component keyLeaf = KeystoreLeaf();
    keyLeaf.ownerAddress <== ownerAddress;
    keyLeaf.privateNullifyingKey <== privateNullifyingKey;
    keyLeaf.authDigest <== authDigestHasher.out;

    // 3. Verify keystore inclusion
    component authorizationProof = BinaryMerkleRoot(keystoreMaxDepth);
    authorizationProof.leaf <== keyLeaf.keystoreLeaf;
    authorizationProof.index <== keystoreLeafIndex;
    authorizationProof.depth <== keystoreTreeDepth;
    for (var i = 0; i < keystoreMaxDepth; i++) {
        authorizationProof.siblings[i] <== keystoreSiblings[i];
    }
    authorizationProof.out === keystoreRoot;

    // ===== TREE DEPTH VALIDATION =====
    // BinaryMerkleRoot outputs 0 for depth > MAX_DEPTH, so we must validate.
    // See: https://github.com/privacy-scaling-explorations/zk-kit.circom/blob/main/packages/binary-merkle-root/src/binary-merkle-root.circom
    //
    // SECURITY: Range check depths BEFORE comparison to prevent field-wrap bypass.
    // LessEqThan(n) uses Num2Bits internally on a computed value, which can wrap
    // if the input is a large field element (e.g., p-1). By constraining inputs
    // to fit in 6 bits first, we ensure valid comparison.

    component keystoreDepthRange = Num2Bits(6);
    keystoreDepthRange.in <== keystoreTreeDepth;

    component keystoreDepthCheck = LessEqThan(6);
    keystoreDepthCheck.in[0] <== keystoreTreeDepth;
    keystoreDepthCheck.in[1] <== keystoreMaxDepth;
    keystoreDepthCheck.out === 1;

    // Per-input depth validation is performed inside the input loop below.
    // Each input may have a different proof depth due to LeanIMT's variable-depth proofs.
    component stateDepthRange[nInputs];
    component stateDepthCheck[nInputs];
    component associationSetDepthRange[nInputs];
    component associationSetDepthCheck[nInputs];

    // ===== INPUT NOTE VERIFICATION =====
    // For each input note: reconstruct commitment, verify existence, verify ASP compliance

    signal inputCommitments[nInputs];
    signal labelHashes[nInputs];
    component valueRangeChecks[nInputs];
    component noteAddrHashers[nInputs];
    component inputNoteCommitments[nInputs];
    component inputMerkleProofs[nInputs];
    component labelHashers[nInputs];
    component associationSetProofs[nInputs];
    component nullifierHashers[nInputs];
    component timestampedLeafHashers[nInputs];

    for (var i = 0; i < nInputs; i++) {
        // 0. Validate tree depths for this input
        stateDepthRange[i] = Num2Bits(6);
        stateDepthRange[i].in <== stateTreeDepth[i];

        stateDepthCheck[i] = LessEqThan(6);
        stateDepthCheck[i].in[0] <== stateTreeDepth[i];
        stateDepthCheck[i].in[1] <== stateMaxDepth;
        stateDepthCheck[i].out === 1;

        associationSetDepthRange[i] = Num2Bits(6);
        associationSetDepthRange[i].in <== associationSetTreeDepth[i];

        associationSetDepthCheck[i] = LessEqThan(6);
        associationSetDepthCheck[i].in[0] <== associationSetTreeDepth[i];
        associationSetDepthCheck[i].in[1] <== associationSetMaxDepth;
        associationSetDepthCheck[i].out === 1;

        // 1. Range check for input value (must be < 2^128)
        valueRangeChecks[i] = Num2Bits(128);
        valueRangeChecks[i].in <== value[i];

        // 2. Compute noteAddressHash = Poseidon(ownerAddress, noteSecret)
        noteAddrHashers[i] = Poseidon(2);
        noteAddrHashers[i].inputs[0] <== ownerAddress;
        noteAddrHashers[i].inputs[1] <== noteSecret[i];

        // 3. Reconstruct input commitment using NoteCommitment
        inputNoteCommitments[i] = NoteCommitment();
        inputNoteCommitments[i].noteAddressHash <== noteAddrHashers[i].out;
        inputNoteCommitments[i].tokenId <== tokenId;
        inputNoteCommitments[i].value <== value[i];
        inputNoteCommitments[i].metadata <== 0;  // EMPTY_METADATA
        inputNoteCommitments[i].label <== label[i];
        inputCommitments[i] <== inputNoteCommitments[i].commitment;

        // 3.5 Hash commitment with domain tag and timestamp to get state tree leaf:
        //     stateLeaf = Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)
        // The domain tag separates commitment leaves from nullifier leaves (which
        // share the same tree) and closes the M-0 forgery class. See
        // "State Tree Leaf Construction" below and the Cryptography Glossary entry
        // for COMMITMENT_LEAF_TAG / NULLIFIER_LEAF_TAG.
        timestampedLeafHashers[i] = Poseidon(3);
        timestampedLeafHashers[i].inputs[0] <== COMMITMENT_LEAF_TAG;
        timestampedLeafHashers[i].inputs[1] <== inputCommitments[i];
        timestampedLeafHashers[i].inputs[2] <== timestamp[i];

        // 4. Verify commitment exists in state tree
        inputMerkleProofs[i] = BinaryMerkleRoot(stateMaxDepth);
        inputMerkleProofs[i].leaf <== timestampedLeafHashers[i].out;
        inputMerkleProofs[i].index <== stateLeafIndex[i];
        inputMerkleProofs[i].depth <== stateTreeDepth[i];
        for (var j = 0; j < stateMaxDepth; j++) {
            inputMerkleProofs[i].siblings[j] <== stateSiblings[i][j];
        }
        inputMerkleProofs[i].out === stateRoot;

        // ===== ASP COMPLIANCE VERIFICATION =====
        // Verify each input label exists in the ASP association set tree

        // 1. Compute label hash = Poseidon(label)
        labelHashers[i] = Poseidon(1);
        labelHashers[i].inputs[0] <== label[i];
        labelHashes[i] <== labelHashers[i].out;

        // 2. Verify label hash exists in association set tree
        associationSetProofs[i] = BinaryMerkleRoot(associationSetMaxDepth);
        associationSetProofs[i].leaf <== labelHashes[i];
        associationSetProofs[i].index <== associationSetLeafIndex[i];
        associationSetProofs[i].depth <== associationSetTreeDepth[i];
        for (var j = 0; j < associationSetMaxDepth; j++) {
            associationSetProofs[i].siblings[j] <== associationSetSiblings[i][j];
        }
        associationSetProofs[i].out === associationSetRoot;

        // ===== NULLIFIER GENERATION =====
        // Generate unique nullifier for double-spend prevention

        // 1. Compute nullifier = Poseidon(privateNullifyingKey, commitment)
        nullifierHashers[i] = Poseidon(2);
        nullifierHashers[i].inputs[0] <== privateNullifyingKey;
        nullifierHashers[i].inputs[1] <== inputCommitments[i];
        nullifierHashes[i] <== nullifierHashers[i].out;
    }

    // ===== OUTPUT NOTE CONSTRUCTION =====
    // Construct output note commitments

    component outputValueRangeChecks[mOutputs];
    component outputNoteCommitments[mOutputs];

    for (var j = 0; j < mOutputs; j++) {
        // 1. Range check for output value (must be < 2^128)
        outputValueRangeChecks[j] = Num2Bits(128);
        outputValueRangeChecks[j].in <== outputValue[j];

        // 2. Compute output commitment using NoteCommitment helper
        outputNoteCommitments[j] = NoteCommitment();
        outputNoteCommitments[j].noteAddressHash <== outputNoteAddressHash[j];
        outputNoteCommitments[j].tokenId <== tokenId;
        outputNoteCommitments[j].value <== outputValue[j];
        outputNoteCommitments[j].metadata <== 0;  // EMPTY_METADATA
        outputNoteCommitments[j].label <== outputLabel[j];
        outputCommitments[j] <== outputNoteCommitments[j].commitment;
    }

    // ===== 6. VALUE CONSERVATION =====
    // Enforce global and per-label value conservation

    component conservation = ValueConservation(nInputs, mOutputs);
    conservation.inputValues <== value;
    conservation.inputLabels <== label;
    conservation.outputValues <== outputValue;
    conservation.outputLabels <== outputLabel;
    conservation.amountOut <== amountOut;

    // ===== TOKEN CONSISTENCY =====
    // Ensure withdrawal token matches the notes' token (only for withdrawals)
    component amountOutIsZero = IsZero();
    amountOutIsZero.in <== amountOut;
    // If amountOut != 0, enforce tokenId === tokenIdOut
    // If amountOut == 0 (pure transfer), skip check
    // Note: amountOut has no explicit Num2Bits(128) range check.
    // As all value originates from Deposit (which enforces value < 2^128), and ValueConservation
    // enforces totalIn === outputSum + amountOut and since both totalIn and outputSum are sums of
    // range-checked values, amountOut is implicitly bounded. A field-wrapped value would fail conservation.
    (tokenId - tokenIdOut) * (1 - amountOutIsZero.out) === 0;

    // ===== PUBLIC INPUT BINDING =====
    // Bind context to prevent proof malleability.
    // Note: The `context * context` constraint forces `context` into the R1CS witness and public inputs.
    // When context != 0, this creates a non-trivial constraint binding the proof to the specific context.
    // The contract guarantees context is never 0, even in the null case (pure transfer),
    // context is set to the hash of empty bytes, ensuring the binding is always effective.
    signal contextSquared;
    contextSquared <== context * context;
}
```
