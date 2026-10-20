import type { Account, Chain, Transport, WalletClient } from "viem";

import type {
    Address,
    Eip712TypedData,
    Hex,
    IWalletInteractor,
    PreparedTransaction,
    ViemWalletInteractorConfig,
} from "../../internal.js";
import {
    SignatureSchema,
    TxHashSchema,
    WalletChainMismatch,
    WalletInteractorBaseError,
    WalletSendTransactionFailed,
    WalletSignTypedDataFailed,
} from "../../internal.js";

/**
 * {@link IWalletInteractor} implementation backed by a viem WalletClient.
 *
 * Uses `walletClient.sendTransaction()` which handles local signing
 * for private key accounts and wallet popups for injected providers.
 */
export class ViemWalletInteractor implements IWalletInteractor {
    private readonly walletClient: WalletClient<Transport, Chain, Account>;
    private readonly expectedChainId?: number;

    constructor(config: ViemWalletInteractorConfig) {
        this.walletClient = config.walletClient;
        this.expectedChainId = config.expectedChainId;
    }

    /**
     * @inheritdoc IWalletInteractor.sendTransaction
     * @throws {WalletSendTransactionFailed} When the wallet rejects or the transaction fails.
     */
    async sendTransaction(tx: PreparedTransaction): Promise<Hex> {
        try {
            await this.assertExpectedChain();
            const hash = await this.walletClient.sendTransaction({
                to: tx.to as `0x${string}`,
                data: tx.data as `0x${string}`,
                value: BigInt(tx.value),
                chain: this.walletClient.chain,
                account: this.walletClient.account,
            });

            const parsed = TxHashSchema.safeParse(hash);
            if (!parsed.success) {
                throw new WalletSendTransactionFailed(
                    "Invalid transaction hash returned by wallet client",
                );
            }

            return parsed.data;
        } catch (error) {
            if (error instanceof WalletInteractorBaseError) throw error;
            throw new WalletSendTransactionFailed(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /**
     * Re-reads the wallet's active chain and refuses to send when it is not the chain this
     * interactor was built for. No-op when no chain was configured.
     *
     * A session checks the chain once at build time, but the wallet's network moves
     * independently afterwards and a contract address is the same string on every chain,
     * so the send is what has to be checked.
     *
     * Both chains are checked, because they can differ: a local (private key) account signs
     * against `walletClient.chain`, which is configured locally and never re-read, while
     * `getChainId()` asks the transport what the node is actually serving. A client
     * configured for one chain but pointed at another node would sign for one and broadcast
     * to the other.
     *
     * @throws {WalletChainMismatch} When either chain differs from the expected one.
     */
    private async assertExpectedChain(): Promise<void> {
        if (this.expectedChainId === undefined) return;
        const configuredChainId = this.walletClient.chain?.id;
        if (configuredChainId !== undefined && configuredChainId !== this.expectedChainId) {
            throw new WalletChainMismatch(configuredChainId, this.expectedChainId);
        }
        const chainId = await this.getChainId();
        if (chainId !== this.expectedChainId) {
            throw new WalletChainMismatch(chainId, this.expectedChainId);
        }
    }

    /**
     * @inheritdoc IWalletInteractor.signTypedData
     * @throws {WalletSignTypedDataFailed} When the wallet rejects or returns an invalid signature.
     */
    async signTypedData(typedData: Eip712TypedData): Promise<Hex> {
        try {
            const signature = await this.walletClient.signTypedData({
                account: this.walletClient.account,
                domain: typedData.domain,
                types: typedData.types,
                primaryType: typedData.primaryType,
                message: typedData.message,
            });

            // Validate as a full 65-byte ECDSA signature, not merely well-formed
            // hex. A short-hex return would otherwise be accepted here and only
            // fail later in relayed registration / key-derivation paths.
            const parsed = SignatureSchema.safeParse(signature);
            if (!parsed.success) {
                throw new WalletSignTypedDataFailed("Invalid signature returned by wallet client");
            }

            return parsed.data;
        } catch (error) {
            if (error instanceof WalletInteractorBaseError) throw error;
            throw new WalletSignTypedDataFailed(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /**
     * @inheritdoc IWalletInteractor.getAccounts
     */
    async getAccounts(): Promise<Address[]> {
        const addresses = await this.walletClient.getAddresses();
        return addresses;
    }

    /**
     * @inheritdoc IWalletInteractor.getChainId
     */
    async getChainId(): Promise<number> {
        const chainId = await this.walletClient.getChainId();
        return chainId;
    }
}
