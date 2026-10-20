import { Poseidon } from "circomlibjs";

import type { ILogger } from "../internal.js";

/**
 * Type to extract the call signature of a function.
 * @param T - The type to extract the call signature from.
 * @returns The call signature of the type.
 */

type CallSignature<T> = T extends (...args: infer A) => infer R ? (...args: A) => R : never;

/**
 * Type to represent the Poseidon instance.
 * @param T - The type to represent the Poseidon instance.
 * @returns The Poseidon instance.
 */
export type PoseidonInstance = CallSignature<Poseidon> & {
    F: {
        toObject(value: Uint8Array): bigint;
    };
};

/**
 * Dependencies for the PoseidonHashService.
 */
export interface PoseidonHashServiceDependencies {
    logger?: ILogger;
}
