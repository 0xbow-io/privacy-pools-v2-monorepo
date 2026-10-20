import type {
    Address,
    AssetConfig,
    EVMProof,
    Hash,
    Hex,
    NoteData,
    PreparedTransaction,
} from "../internal.js";
import type { IContractInteractor } from "./IContractInteractor.js";

/**
 * Interactions with the Entrypoint contract, generic over the chain's prepared-transaction type
 * `TTx`, address type `TAddress`, and on-chain proof type `TProof` (all default to their EVM
 * shapes, so existing code typing against `IEntrypointInteractor` with no type arguments is
 * unaffected).
 */
export interface IEntrypointInteractor<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
> extends IContractInteractor<TAddress> {
    /**
     * Reads the PoolVault address from the Entrypoint immutable.
     *
     * @returns The PoolVault contract address.
     * @throws {ContractInteractorBaseError}
     */
    getPoolVaultAddress(): Promise<TAddress>;

    /**
     * Reads the ASPRegistry address from the Entrypoint immutable.
     *
     * @returns The ASPRegistry contract address.
     * @throws {ContractInteractorBaseError}
     */
    getASPRegistryAddress(): Promise<TAddress>;

    /**
     * Reads the asset configuration for a given token.
     *
     * @param asset - The token contract address (address(0) for native ETH).
     * @returns The on-chain asset configuration.
     * @throws {ContractInteractorBaseError}
     */
    getAssetConfig(asset: TAddress): Promise<AssetConfig>;

    /**
     * Reads the ERC20 allowance granted by an owner to a spender.
     *
     * @param token - The ERC20 token contract address.
     * @param owner - The address that owns the tokens.
     * @param spender - The address approved to spend tokens.
     * @returns The approved allowance amount.
     * @throws {ContractInteractorBaseError}
     */
    getAllowance(token: TAddress, owner: TAddress, spender: TAddress): Promise<Hash>;

    /**
     * Encodes a deposit transaction without sending.
     *
     * @param proof - On-chain-formatted Groth16 proof.
     * @param noteData - Note discovery data (hint + encrypted payload).
     * @param aspCiphertext - ASP-encrypted deposit metadata.
     * @param msgValue - ETH value to attach (hex-encoded wei).
     * @param asset - The asset being deposited (ignored on a single-asset-per-deployment chain).
     * @returns A prepared transaction ready for submission.
     */
    encodeDeposit(
        proof: TProof,
        noteData: NoteData,
        aspCiphertext: Hex,
        msgValue: Hex,
        asset: TAddress,
    ): Promise<TTx>;

    /**
     * Encodes an ERC-20 approve transaction without sending.
     *
     * @param token - ERC-20 token contract address.
     * @param amount - Amount to approve (hex-encoded).
     * @returns A prepared transaction ready for submission.
     */
    encodeApprove(token: TAddress, amount: Hex): Promise<TTx>;

    /**
     * Sends a prepared transaction through the attached wallet.
     *
     * @param tx - The prepared transaction (to, data, value).
     * @returns The transaction hash.
     * @throws {ContractInteractorBaseError}
     */
    submitTransaction(tx: TTx): Promise<Hex>;
}
