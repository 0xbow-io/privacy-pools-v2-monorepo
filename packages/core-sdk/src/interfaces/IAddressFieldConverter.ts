import type { Address, Hex } from "../internal.js";

/**
 * Converts a chain's address type `TAddress` into the field-sized `Hex` the Poseidon-hash layer
 * (`INoteComputationService`, keystore leaf hashing) expects, generic over `TAddress`. An EVM
 * address already fits as a BN254 field element (160 bits), so {@link EvmAddressFieldConverter}
 * is an identity function; a non-hex `TAddress` (e.g. Stellar's StrKey) needs a real conversion
 * step (`keccak256(address) % SNARK_SCALAR_FIELD`) here instead of an unsafe cast — and the
 * on-chain contract must independently reproduce the exact same conversion, so it needs to be an
 * explicit, nameable, auditable function rather than an implicit side effect of hashing.
 *
 * The return type matches `INoteComputationService`'s current EVM-shaped `Address` parameters
 * (that interface is not yet generic — a separate, already-made scope decision). A future
 * `StellarAddressFieldConverter` will need `INoteComputationService`'s signature widened to
 * accept the full-width `Hex` this produces alongside it.
 */
export interface IAddressFieldConverter<TAddress = Address> {
    /**
     * Converts an owner/recipient address into its field-sized `Hex` representation.
     *
     * @param address - The address to convert.
     * @returns The field-sized `Hex` representation.
     */
    toField(address: TAddress): Hex;

    /**
     * Converts a token/asset identifier into its field-sized `Hex` representation for the
     * `tokenId`/`tokenIdOut` circuit signals specifically — NOT the same conversion as
     * {@link toField}. The shared Deposit/Transact circuits range-check `tokenId < 2^160`
     * (mirroring an EVM address's bit width); owner/recipient addresses carry no such
     * constraint. An EVM address already satisfies both, so {@link EvmAddressFieldConverter}
     * gives this the same identity behavior as `toField`; a non-EVM `TAddress` (e.g. Stellar's
     * StrKey, whose general field conversion spans the full ~254-bit BN254 field) needs a
     * distinct, narrower conversion here — the on-chain contract must independently reproduce
     * whatever this does, so it needs to be an explicit, nameable function, not an implicit
     * truncation.
     *
     * @param tokenId - The token/asset identifier to convert.
     * @returns The field-sized `Hex` representation, guaranteed `< 2^160`.
     */
    toTokenIdField(tokenId: TAddress): Hex;
}
