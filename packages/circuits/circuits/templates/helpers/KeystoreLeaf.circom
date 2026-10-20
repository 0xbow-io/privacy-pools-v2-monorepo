pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";

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
