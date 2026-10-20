import type { Address, AssetConfig, EVMProof, Hex, NoteData } from "../internal.js";

/**
 * Chain-specific mechanics for `EntrypointInteractor<TTx, TAddress, TProof>`: raw reads,
 * calldata/XDR encoding, and transaction submission. See `IPoolVaultChainAdapter`'s doc comment
 * for the split rationale and the `TTx`/`TAddress`/`TProof` generics — same pattern, thinner
 * payoff here since `EntrypointInteractor` has no leaf-cache to share.
 */
export interface IEntrypointChainAdapter<TTx, TAddress = Address, TProof = EVMProof> {
    /** The on-chain Entrypoint contract address this adapter is bound to. */
    getAddress(): TAddress;

    getPoolVaultAddressRaw(): Promise<TAddress>;
    getASPRegistryAddressRaw(): Promise<TAddress>;
    getAssetConfigRaw(asset: TAddress): Promise<AssetConfig>;
    getAllowanceRaw(token: TAddress, owner: TAddress, spender: TAddress): Promise<bigint>;

    /**
     * @param asset - The asset being deposited — EVM's Entrypoint is single-asset-per-deployment
     *   and ignores this; a multi-asset chain (Stellar) needs it as an explicit call argument.
     */
    encodeDeposit(
        proof: TProof,
        noteData: NoteData,
        aspCiphertext: Hex,
        msgValue: Hex,
        asset: TAddress,
    ): Promise<TTx>;
    encodeApprove(token: TAddress, amount: Hex): Promise<TTx>;

    /** Submits a prepared transaction through the attached wallet. */
    submit(tx: TTx): Promise<Hex>;
}
