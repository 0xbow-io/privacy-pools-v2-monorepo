import type { Address } from "../internal.js";

/** A single EIP-712 struct field: a name paired with its Solidity type. */
export interface Eip712Field {
    /** Field name, matching the struct member. */
    name: string;
    /** Solidity type (e.g. `"address"`, `"uint256"`). */
    type: string;
}

/**
 * EIP-712 domain separator. Binds a signature to a specific contract on a
 * specific chain, so a signature is not replayable across chains or contracts.
 */
export interface Eip712Domain {
    /** Human-readable signing domain (contract-defined). */
    name: string;
    /** Domain version (contract-defined). */
    version: string;
    /** Chain the signature is valid on. */
    chainId: number;
    /** Address of the contract that will verify the signature. */
    verifyingContract: Address;
}

/** A resolved EIP-712 message value. `uint256` fields are carried as `bigint`. */
export type Eip712MessageValue = string | number | bigint;

/**
 * A fully-resolved EIP-712 typed-data payload ready to sign. Shaped to match
 * viem's `signTypedData` argument (`domain`/`types`/`primaryType`/`message`) and
 * the EIP-1193 `eth_signTypedData_v4` JSON envelope. The `types` map intentionally
 * omits the `EIP712Domain` entry — viem derives it, and the EIP-1193 adapter adds
 * it at sign time.
 */
export interface Eip712TypedData {
    /** Domain separator fields. */
    domain: Eip712Domain;
    /** Struct type definitions, keyed by struct name (excludes `EIP712Domain`). */
    types: Record<string, readonly Eip712Field[]>;
    /** The struct being signed (a key of `types`). */
    primaryType: string;
    /** The message values, keyed by field name. */
    message: Record<string, Eip712MessageValue>;
}
