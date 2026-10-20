import type { Address, Hex } from "../internal.js";

/** The decoded PayoutRouting fields, generic over the chain's address type `TAddress`. */
export interface DecodedPayoutRouting<TAddress = Address> {
    recipient: TAddress;
    feeRecipient: TAddress;
    feeAmount: bigint;
    nativeGas: bigint;
}

/**
 * Encodes/decodes the `PayoutRouting` tuple carried in `TransactParams.data`, generic over the
 * chain's address type `TAddress`. Chains differ enough here (ABI encode/decode vs. ScVal) that
 * there is no shared implementation between chains — a plain interface with one independent
 * implementation per chain, not an abstract base, matching {@link IContextHashService}.
 */
export interface IPayoutRoutingCodec<TAddress = Address> {
    /**
     * Encodes the PayoutRouting tuple into `TransactParams.data`. Layout matches
     * `IPrivacyPoolRelay.PayoutRouting` (recipient, feeRecipient, feeAmount, nativeGas) so the
     * relay contract can decode it.
     *
     * @param routing - The payout routing fields.
     * @returns The encoded routing data.
     */
    encode(routing: DecodedPayoutRouting<TAddress>): Hex;

    /**
     * Decodes a relayer-signed `PayoutRouting` tuple from `TransactParams.data`.
     *
     * @param data - The ABI/ScVal-encoded PayoutRouting tuple.
     * @returns The decoded routing fields.
     */
    decode(data: Hex): DecodedPayoutRouting<TAddress>;

    /**
     * Decodes a relayer-signed `PayoutRouting[]` array from a batch fee commitment's `data`
     * (one routing per note group in a full-balance batch withdrawal).
     *
     * @param data - The ABI/ScVal-encoded PayoutRouting array.
     * @returns The decoded routing fields, one per array element.
     */
    decodeArray(data: Hex): DecodedPayoutRouting<TAddress>[];
}
