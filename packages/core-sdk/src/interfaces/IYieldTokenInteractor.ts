import type { Address } from "../internal.js";

/**
 * Read-only interactions with a yield share token — a non-rebasing ERC-4626-style wrapper over a
 * lending position (EVM: `PPYieldToken` over Aave; Stellar: `yield-token` over Blend).
 *
 * Used to size deposits and to value shielded notes in underlying terms. All amounts are raw
 * on-chain integers: shares in the share token's decimals, assets in the underlying's.
 */
export interface IYieldTokenInteractor<TAddress = Address> {
    /**
     * Returns the share-token contract address this interactor is bound to.
     */
    getAddress(): TAddress;
    /**
     * Live underlying value of one whole share (`10 ** shareDecimals` share units), scaled to the
     * underlying decimals. Rises with venue yield, net of the protocol fee.
     *
     * @returns The exchange rate as a raw underlying-denominated integer.
     * @throws {ContractInteractorBaseError}
     */
    exchangeRate(): Promise<bigint>;
    /**
     * Shares minted for depositing `assets` of underlying, fee-exclusive.
     *
     * @param assets - Underlying amount, raw integer.
     * @returns The shares minted, raw integer.
     * @throws {ContractInteractorBaseError}
     */
    previewDeposit(assets: bigint): Promise<bigint>;
    /**
     * Underlying redeemable for `shares` — the value of a note.
     *
     * @param shares - Shares, raw integer.
     * @returns The underlying redeemable, raw integer.
     * @throws {ContractInteractorBaseError}
     */
    previewRedeem(shares: bigint): Promise<bigint>;
}
