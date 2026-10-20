import { Hex } from "../internal.js";

/**
 * Interface for the HashService.
 * The HashService is responsible for hashing inputs.
 */
export interface IHashService {
    /**
     * Hashes the given inputs using hash function.
     * @param inputs - The inputs to hash as an array of hex strings.
     * @returns The hash of the inputs as a hex string.
     * @throws {HashServiceBaseError} If the inputs are invalid or hashing fails.
     */
    hash(inputs: Hex[]): Hex;
}
