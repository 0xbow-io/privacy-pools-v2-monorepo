pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

include "./helpers/KeystoreLeaf.circom";
include "@zk-kit/binary-merkle-root.circom/src/binary-merkle-root.circom";
include "./helpers/NoteCommitment.circom";
include "./helpers/ValueConservation.circom";

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
    // ======================== CONSTANTS ========================

    // Domain-separation tag for commitment leaves in the state tree.
    // Poseidon("privacy_pools_note")  (UTF-8 → big-endian uint256)
    // Mirrored in packages/contracts/src/utils/Constants.sol and
    // packages/core-sdk/src/constant/WitnessPreparationService.ts — keep in sync.
    var COMMITMENT_LEAF_TAG = 3791694183000795315792098099581407680958131641292811872617553086713867485913;

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

    // ===== TOKEN ID RANGE CHECKS =====
    // SECURITY: tokenId and tokenIdOut represent EVM addresses (160 bits)
    // onchain. Range-check in-circuit so a 256-bit field element with dirty upper
    // bytes cannot diverge from the contract-side canonical (lower-160-bit) form.
    component tokenIdRangeCheck = Num2Bits(160);
    tokenIdRangeCheck.in <== tokenId;

    component tokenIdOutRangeCheck = Num2Bits(160);
    tokenIdOutRangeCheck.in <== tokenIdOut;

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

        // 3.5 Hash commitment with domain tag and timestamp to get state tree leaf
        //     Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)
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
    // Note: amountOut is range-checked to fit in 128 bits inside ValueConservation.
    // The per-input and per-output Num2Bits(128) above remain as
    // defense in depth and to bound the witness ranges at point of use.
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
