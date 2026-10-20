import type { IAddressEqualityComparator, StellarAddress } from "../../internal.js";

/**
 * Stellar implementation of {@link IAddressEqualityComparator} — plain equality. Unlike EVM's
 * optional EIP-55 checksum casing, a Stellar StrKey has exactly one canonical encoding (its
 * base32 alphabet isn't case-foldable the way hex is), so no normalization step is needed or
 * correct here.
 */
export class StellarAddressEqualityComparator implements IAddressEqualityComparator<StellarAddress> {
    /** @inheritdoc IAddressEqualityComparator.equals */
    equals(a: StellarAddress, b: StellarAddress): boolean {
        return a === b;
    }
}
