pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";

/**
 * @title NoteCommitment
 * @notice Computes a commitment for notes in Privacy Pools v2
 * @dev precommitment = Poseidon(noteAddressHash, tokenId, value, metadata)
 *      commitment = Poseidon(precommitment, label)
 *
 *      Caller responsibility: this helper does not range-check any of its
 *      inputs. In particular, `tokenId` is consumed bit-width-indifferent
 *      here. The calling top-level circuit (Deposit, Transact, Ragequit) is
 *      responsible for the `Num2Bits(160)` range check on tokenId (INS-1)
 *      and the `Num2Bits(128)` range check on value (AW-M-01 pattern). See
 *      Deposit.circom / Transact.circom / Ragequit.circom for the
 *      enforcement points.
 */
template NoteCommitment() {
    // ======================== INPUT SIGNALS ========================

    signal input noteAddressHash;  // Poseidon(ownerAddressHash, noteSecret)
    signal input tokenId;          // uint256(tokenAddress) - ERC20 token address (caller range-checks to 160 bits)
    signal input value;            // Token amount (caller range-checks to 128 bits)
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
