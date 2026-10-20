import type {
    CircuitInputs,
    DepositProof,
    EVMProof,
    ProofResult,
    RagequitProof,
    TransactProof,
} from "../internal.js";

/**
 * Interface for the ProofService, generic over the chain's on-chain-verifier proof format
 * `TProof` (defaults to EVM's {@link EVMProof}).
 * Generates and verifies Groth16 ZK proofs for Privacy Pools circuits.
 * Has no protocol knowledge — receives a witness (opaque bag of field elements)
 * and a circuit name, and delegates to snarkjs.
 */
export interface IProofService<TProof = EVMProof> {
    /**
     * Generates a proof for the deposit circuit.
     * @param witness - The circuit witness inputs.
     * @returns The proof and public signals.
     * @throws {ProofServiceBaseError} If the witness is invalid, artifacts cannot be loaded, or proof generation fails.
     */
    proveDeposit(witness: CircuitInputs): Promise<DepositProof>;

    /**
     * Generates a proof for a transact circuit variant.
     * @param witness - The circuit witness inputs.
     * @param nInputs - Number of input notes (1-5).
     * @param mOutputs - Number of output notes (1-5).
     * @returns The proof and public signals.
     * @throws {ProofServiceBaseError} If dimensions are invalid, the witness is invalid, artifacts cannot be loaded, or proof generation fails.
     */
    proveTransact(
        witness: CircuitInputs,
        nInputs: number,
        mOutputs: number,
    ): Promise<TransactProof>;

    /**
     * Generates a proof for the ragequit circuit.
     * @param witness - The circuit witness inputs.
     * @returns The proof and public signals.
     * @throws {ProofServiceBaseError} If the witness is invalid, artifacts cannot be loaded, or proof generation fails.
     */
    proveRagequit(witness: CircuitInputs): Promise<RagequitProof>;

    /**
     * Verifies a deposit proof.
     * @param proof - The proof result to verify.
     * @returns True if the proof is valid.
     * @throws {ProofServiceBaseError} If the proof is invalid, verification key cannot be loaded, or verification fails.
     */
    verifyDeposit(proof: DepositProof): Promise<boolean>;

    /**
     * Verifies a transact proof.
     * @param proof - The proof result to verify.
     * @param nInputs - Number of input notes (1-5).
     * @param mOutputs - Number of output notes (1-5).
     * @returns True if the proof is valid.
     * @throws {ProofServiceBaseError} If dimensions are invalid, the proof is invalid, verification key cannot be loaded, or verification fails.
     */
    verifyTransact(proof: TransactProof, nInputs: number, mOutputs: number): Promise<boolean>;

    /**
     * Verifies a ragequit proof.
     * @param proof - The proof result to verify.
     * @returns True if the proof is valid.
     * @throws {ProofServiceBaseError} If the proof is invalid, verification key cannot be loaded, or verification fails.
     */
    verifyRagequit(proof: RagequitProof): Promise<boolean>;

    /**
     * Eagerly loads and caches circuit artifacts (WASM + proving key).
     * @param circuitName - The name of the circuit to load.
     * @throws {ProofServiceBaseError} If the artifacts cannot be loaded.
     */
    loadCircuit(circuitName: string): Promise<void>;

    /**
     * Converts a snarkjs proof result into a struct ready for this chain's on-chain verifier
     * encoding — e.g. EVM's `ProofService` transposes pB's inner coordinates (snarkjs format →
     * EVM format) and converts all hex strings to bigint; a Stellar extender reshapes into the
     * `{a,b,c}` ScVal bytes map its Soroban verifier expects. Chains differ enough here that
     * there is no shared implementation, only the shared method name.
     *
     * @param proofResult - The raw proof output from a prove* method.
     * @returns A proof formatted for this chain's on-chain verifier.
     */
    formatForChain(proofResult: ProofResult): TProof;
}
