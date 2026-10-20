/**
 * Interface for loading circuit artifacts from any source (filesystem, URL, bundled, etc.).
 * ProofService delegates all artifact loading to this interface.
 */
export interface ICircuitArtifacts {
    /**
     * Returns the compiled WASM for the given circuit.
     * @param circuitName - The name of the circuit (e.g. "deposit", "transact_2x3").
     * @returns The WASM binary.
     * @throws {Error} If the artifact cannot be loaded from the underlying source.
     */
    getWasm(circuitName: string): Promise<Uint8Array>;

    /**
     * Returns the proving key (zkey) for the given circuit.
     * @param circuitName - The name of the circuit.
     * @returns The proving key binary.
     * @throws {Error} If the artifact cannot be loaded from the underlying source.
     */
    getProvingKey(circuitName: string): Promise<Uint8Array>;

    /**
     * Returns the verification key for the given circuit.
     * @param circuitName - The name of the circuit.
     * @returns The verification key as a UTF-8 encoded JSON Uint8Array.
     * @throws {Error} If the artifact cannot be loaded from the underlying source.
     */
    getVerificationKey(circuitName: string): Promise<Uint8Array>;
}
