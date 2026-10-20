import type {
    BuildDepositWitnessInputs,
    BuildRagequitWitnessInputs,
    BuildTransactWitnessInputs,
    DepositCircuitInputs,
    RagequitWitness,
    TransactCircuitInputs,
} from "../internal.js";

/**
 * Interface for the WitnessPreparationService.
 * Transforms raw domain inputs into structured witnesses ready for proof generation.
 * This is the only place in the SDK that understands circuit input structure.
 */
export interface IWitnessPreparationService {
    /**
     * Validates and returns the deposit circuit inputs.
     * @param inputs - The deposit witness inputs (noteAddressHash, tokenId, value, context, depositSecret).
     * @returns The validated deposit circuit inputs ready for ProofService.
     * @throws {WitnessPreparationServiceError} If the inputs fail validation.
     */
    buildDepositWitness(inputs: BuildDepositWitnessInputs): Promise<DepositCircuitInputs>;

    /**
     * Builds the complete witness for the transact circuit.
     * Generates merkle proofs against state, keystore, and association set trees.
     * @param inputs - The transact witness inputs.
     * @returns The transact circuit inputs ready for proof generation.
     * @throws {WitnessPreparationServiceError} If the inputs fail validation or witness construction fails.
     */
    buildTransactWitness(inputs: BuildTransactWitnessInputs): Promise<TransactCircuitInputs>;

    /**
     * Builds the witness for the ragequit circuit.
     * Computes the nullifier and generates a merkle proof against the keystore tree.
     * No ASP proof is needed.
     * @param inputs - The ragequit witness inputs.
     * @returns The ragequit witness with circuit inputs, nullifier hash, and commitment.
     * @throws {WitnessPreparationServiceError} If the inputs fail validation or witness construction fails.
     */
    buildRagequitWitness(inputs: BuildRagequitWitnessInputs): Promise<RagequitWitness>;
}
