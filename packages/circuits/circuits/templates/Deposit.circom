pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

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

    // 1.5 Range check: tokenId < 2^160 (matches EVM address bit-width onchain).
    // SECURITY: without this, a 256-bit field element with dirty upper
    // bytes could be committed in-circuit while the contract truncates to
    // 160 bits, letting proof-side and contract-side canonical values diverge.
    component tokenIdRangeCheck = Num2Bits(160);
    tokenIdRangeCheck.in <== tokenId;

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
