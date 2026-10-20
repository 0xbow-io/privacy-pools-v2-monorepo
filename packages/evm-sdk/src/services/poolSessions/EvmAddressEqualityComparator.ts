import type { Address, IAddressEqualityComparator } from "../../internal.js";

/**
 * EVM implementation of {@link IAddressEqualityComparator} — case-insensitive comparison,
 * since EIP-55 checksum casing is cosmetic and two differently-cased strings can name the same
 * address.
 */
export class EvmAddressEqualityComparator implements IAddressEqualityComparator {
    /** @inheritdoc IAddressEqualityComparator.equals */
    equals(a: Address, b: Address): boolean {
        return a.toLowerCase() === b.toLowerCase();
    }
}
