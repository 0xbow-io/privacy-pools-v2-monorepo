import type { Address, Hex, IAddressFieldConverter } from "../../internal.js";

/**
 * EVM implementation of {@link IAddressFieldConverter} — an identity conversion. An EVM address
 * is already a valid BN254 field element (160 bits, well under the field's ~254-bit width), so
 * no real transformation is needed; this class exists to give the seam an explicit, injectable
 * home rather than leaving `TAddress` values cast through `Address` ad hoc at each call site.
 */
export class EvmAddressFieldConverter implements IAddressFieldConverter {
    /** @inheritdoc IAddressFieldConverter.toField */
    toField(address: Address): Hex {
        return address;
    }

    /** @inheritdoc IAddressFieldConverter.toTokenIdField */
    toTokenIdField(tokenId: Address): Hex {
        return tokenId;
    }
}
