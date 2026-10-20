import type { Address } from "../internal.js";

/**
 * Compares two values of the chain's address type `TAddress` for equality, generic over
 * `TAddress`. EVM addresses are case-insensitive (mixed-case is just optional EIP-55
 * checksumming of the same underlying value), so {@link EvmAddressEqualityComparator} folds
 * case before comparing; a case-sensitive `TAddress` (e.g. Stellar's StrKey, which has exactly
 * one canonical encoding) needs a plain equality check instead — an explicit, injectable seam
 * rather than a `.toLowerCase()` baked into each call site.
 */
export interface IAddressEqualityComparator<TAddress = Address> {
    /**
     * Returns whether `a` and `b` refer to the same address.
     *
     * @param a - The first address.
     * @param b - The second address.
     * @returns Whether the two addresses are equal.
     */
    equals(a: TAddress, b: TAddress): boolean;
}
