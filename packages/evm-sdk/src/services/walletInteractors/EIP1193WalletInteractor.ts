import type {
    Address,
    Eip712TypedData,
    EIP1193Provider,
    EIP1193WalletInteractorConfig,
    Hex,
    IWalletInteractor,
    PreparedTransaction,
} from "../../internal.js";
import {
    SignatureSchema,
    TxHashSchema,
    WalletChainMismatch,
    WalletInteractorBaseError,
    WalletNoAccountsError,
    WalletSendTransactionFailed,
    WalletSignTypedDataFailed,
} from "../../internal.js";
import { GetAccountsResultSchema } from "../../schemas/WalletInteractor.js";

/** Standard EIP-712 domain type array, required in the `eth_signTypedData_v4` envelope. */
const EIP712_DOMAIN_TYPE = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
] as const;

/**
 * {@link IWalletInteractor} implementation backed by an EIP-1193 provider.
 *
 * Wraps any EIP-1193-compatible provider (MetaMask, WalletConnect, viem,
 * ethers BrowserProvider, etc.) into the SDK's wallet interface.
 */
export class EIP1193WalletInteractor implements IWalletInteractor {
    private readonly provider: EIP1193Provider;
    private readonly expectedChainId?: number;

    constructor(config: EIP1193WalletInteractorConfig) {
        this.provider = config.provider;
        this.expectedChainId = config.expectedChainId;
    }

    /**
     * @inheritdoc IWalletInteractor.sendTransaction
     * @throws {WalletSendTransactionFailed} When the provider rejects or returns an invalid hash.
     */
    async sendTransaction(tx: PreparedTransaction): Promise<Hex> {
        try {
            const [account] = await this.getAccounts();
            // AFTER the accounts call, never before: `eth_requestAccounts` can open the
            // wallet's own interactive prompt, and the user can switch networks in it. A
            // chain read taken earlier would describe the network the wallet was on before
            // that prompt, not the one this send will go out on.
            await this.assertExpectedChain();

            const result = await this.provider.request({
                method: "eth_sendTransaction",
                params: [
                    {
                        from: account,
                        to: tx.to,
                        data: tx.data,
                        value: tx.value,
                    },
                ],
            });

            const parsed = TxHashSchema.safeParse(result);
            if (!parsed.success) {
                throw new WalletSendTransactionFailed(
                    "Invalid transaction hash returned by provider",
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
     * Re-reads the provider's active chain and refuses to send when it is not the chain
     * this interactor was built for. No-op when no chain was configured.
     *
     * The check belongs immediately before the send rather than once at session build:
     * the provider is the user's wallet and its network moves underneath a built session.
     * A prepared transaction names an address and never a chain, so a deposit prepared for
     * the pool chain would otherwise go out unchanged to whatever occupies that address on
     * the chain the wallet moved to.
     *
     * @throws {WalletChainMismatch} When the provider reports a different chain.
     */
    private async assertExpectedChain(): Promise<void> {
        if (this.expectedChainId === undefined) return;
        const chainId = await this.getChainId();
        if (chainId !== this.expectedChainId) {
            throw new WalletChainMismatch(chainId, this.expectedChainId);
        }
    }

    /**
     * @inheritdoc IWalletInteractor.signTypedData
     * @throws {WalletSignTypedDataFailed} When the provider rejects or returns an invalid signature.
     */
    async signTypedData(typedData: Eip712TypedData): Promise<Hex> {
        try {
            const [account] = await this.getAccounts();

            // eth_signTypedData_v4 requires the EIP712Domain type entry and a JSON string
            // whose uint256 values are decimal strings (bigint is not JSON-serializable).
            const envelope = {
                domain: typedData.domain,
                types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...typedData.types },
                primaryType: typedData.primaryType,
                message: typedData.message,
            };
            const json = JSON.stringify(envelope, (_key, value) =>
                 
                typeof value === "bigint" ? value.toString() : value,
            );

            const result = await this.provider.request({
                method: "eth_signTypedData_v4",
                params: [account, json],
            });

            // Validate as a full 65-byte signature, not just well-formed hex — a wallet
            // returning short hex would otherwise be accepted here and fail later in
            // relayed-registration / key-derivation paths (cubic finding [9], sibling of Viem).
            const parsed = SignatureSchema.safeParse(result);
            if (!parsed.success) {
                throw new WalletSignTypedDataFailed("Invalid signature returned by provider");
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
     * @throws {WalletNoAccountsError} When the provider returns no accounts.
     */
    async getAccounts(): Promise<Address[]> {
        try {
            const accounts = await this.provider.request({
                method: "eth_requestAccounts",
            });

            const validatedAccounts = GetAccountsResultSchema.safeParse(accounts);

            if (!validatedAccounts.success) {
                throw new WalletNoAccountsError();
            }

            return validatedAccounts.data;
        } catch (error) {
            if (error instanceof WalletInteractorBaseError) throw error;
            throw new WalletNoAccountsError();
        }
    }

    /**
     * @inheritdoc IWalletInteractor.getChainId
     * @throws {WalletSendTransactionFailed} When the provider rejects or
     *   returns an invalid chain id.
     */
    async getChainId(): Promise<number> {
        try {
            const raw = await this.provider.request({ method: "eth_chainId" });
            if (typeof raw !== "string") {
                throw new WalletSendTransactionFailed(
                    `eth_chainId returned ${typeof raw}, expected hex string`,
                );
            }
            const chainId = Number(BigInt(raw));
            if (!Number.isInteger(chainId) || chainId <= 0) {
                throw new WalletSendTransactionFailed(`eth_chainId returned invalid value ${raw}`);
            }
            return chainId;
        } catch (error) {
            if (error instanceof WalletInteractorBaseError) throw error;
            throw new WalletSendTransactionFailed(
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}
