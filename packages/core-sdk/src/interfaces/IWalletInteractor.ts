import type { Address, Eip712TypedData, Hex, PreparedTransaction } from "../internal.js";

/**
 * Abstraction for wallet-based transaction sending, generic over the chain's prepared-transaction
 * type `TTx` and address type `TAddress` (both default to their EVM shapes).
 *
 * Implementations adapt any wallet provider (EIP-1193, viem WalletClient,
 * ethers Signer, etc.) to a uniform interface the SDK can consume.
 */
export interface IWalletInteractor<TTx = PreparedTransaction, TAddress = Address> {
    /**
     * Sends a prepared transaction through the first wallet from getAccounts.
     *
     * @param tx - The prepared transaction.
     * @returns The transaction hash.
     * @throws {WalletInteractorBaseError}
     */
    sendTransaction(tx: TTx): Promise<Hex>;

    /**
     * Signs an EIP-712 typed-data payload with the first wallet account. Used by
     * the relayed keystore-registration path, where the account authorizes
     * `setAuthPolicyWithSig` off-chain and a relayer submits it on-chain.
     *
     * Always EVM-shaped (EIP-712) regardless of this interface's `TTx`/`TAddress` — a Stellar
     * wallet interactor would need an entirely different signing scheme, not just a cast, matching
     * the same boundary as {@link IPoolSessionKeystore.buildSetAuthPolicyTypedData}.
     *
     * @param typedData - The resolved EIP-712 payload (domain, types, primaryType, message).
     * @returns The 65-byte signature as 0x-prefixed hex.
     * @throws {WalletInteractorBaseError}
     */
    signTypedData(typedData: Eip712TypedData): Promise<Hex>;

    /**
     * Returns the accounts exposed by the connected wallet.
     *
     * @returns An array of account addresses.
     * @throws {WalletInteractorBaseError}
     */
    getAccounts(): Promise<TAddress[]>;

    /**
     * Returns the chain id the wallet is currently connected to. Used by the
     * builder to verify the wallet matches the session's configured chainId
     * before any state-changing call goes out (M-3 / line 238).
     *
     * @returns Active chain id as a positive integer.
     * @throws {WalletInteractorBaseError}
     */
    getChainId(): Promise<number>;
}
