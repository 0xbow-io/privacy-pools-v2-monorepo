pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

include "./helpers/KeystoreLeaf.circom";
include "@zk-kit/binary-merkle-root.circom/src/binary-merkle-root.circom";
include "./helpers/NoteCommitment.circom";

/**
 * @title Ragequit
 * @notice Emergency withdrawal circuit that bypasses ASP compliance.
 * @dev Allows users to recover funds when compliance has failed or the ASP
 *      has censored their label or something works wrong on the system.
 *      This circuit intentionally bypasses ASP compliance checks and forces a
 *      public withdrawal to the note's owner address, ensuring user funds can
 *      never be permanently frozen.
 * @param maxDepth Maximum keystore Merkle tree depth (14 for ~16k keystore entries)
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

    // ===== TOKEN ID RANGE CHECK =====
    // SECURITY: tokenId < 2^160 (matches EVM address bit-width onchain).
    // Without this, a 256-bit field element with dirty upper bytes could be
    // committed in-circuit while the contract truncates to 160 bits, letting
    // proof-side and contract-side canonical values diverge.
    component tokenIdRangeCheck = Num2Bits(160);
    tokenIdRangeCheck.in <== tokenId;

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
