import { authorizeEntry, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

import {
    buildKeyDerivationTransaction,
    FreighterWalletInteractorConfig,
    Hex,
    IStellarWalletInteractor,
    StellarWalletInteractorBaseError,
    StellarWalletNetworkMismatch,
    StellarWalletNoAccountsError,
    StellarWalletNotAvailable,
    StellarWalletSignTransactionFailed,
} from "../../internal.js";

/**
 * {@link IStellarWalletInteractor} implementation backed by a browser-extension wallet (e.g.
 * Freighter) via an injected {@link StellarWalletProvider} — mirrors `EIP1193WalletInteractor`'s
 * "wrap any provider matching this minimal shape" design. Use {@link createFreighterProvider}
 * for a verified `StellarWalletProvider` backed by the real `@stellar/freighter-api` package.
 *
 * `classifySignError` sniffs message substrings rather than typed error codes because
 * `StellarWalletProvider` is wallet-agnostic — a provider backing a different extension may
 * throw anything. Even for Freighter specifically, its actual error wording lives in the
 * extension, not the `@stellar/freighter-api` npm package, so it can't be pinned from source
 * either; substring matching is a best-effort heuristic on both counts, not a verified contract.
 */
export class FreighterWalletInteractor implements IStellarWalletInteractor {
    private readonly config: FreighterWalletInteractorConfig;

    constructor(config: FreighterWalletInteractorConfig) {
        this.config = config;
    }

    /**
     * @inheritdoc IStellarWalletInteractor.sendTransaction
     * @throws {StellarWalletNetworkMismatch} If the wallet's active network doesn't match.
     * @throws {StellarWalletNotAvailable} If the wallet extension isn't available.
     * @throws {StellarWalletSignTransactionFailed} If signing fails for any other reason
     *   (including the user declining the popup).
     */
    async sendTransaction(unsignedXdr: string): Promise<Hex> {
        const activeNetwork = await this.config.provider.getNetworkPassphrase();
        if (activeNetwork !== this.config.networkPassphrase) {
            throw new StellarWalletNetworkMismatch(this.config.networkPassphrase, activeNetwork);
        }

        try {
            const signedXdr = await this.config.provider.signTransaction(unsignedXdr, {
                networkPassphrase: this.config.networkPassphrase,
            });
            return await this.config.rpcInteractor.submitTransaction(signedXdr);
        } catch (error) {
            throw this.classifySignError(error);
        }
    }

    /**
     * @inheritdoc IStellarWalletInteractor.getAccounts
     * @throws {StellarWalletNoAccountsError} If the wallet returns no address.
     * @throws {StellarWalletNotAvailable} If the wallet extension isn't available.
     */
    async getAccounts(): Promise<string[]> {
        try {
            const address = await this.config.provider.getAddress();
            if (!address) throw new StellarWalletNoAccountsError();
            return [address];
        } catch (error) {
            if (error instanceof StellarWalletInteractorBaseError) throw error;
            throw new StellarWalletNotAvailable(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /** @inheritdoc IStellarWalletInteractor.getNetworkPassphrase */
    async getNetworkPassphrase(): Promise<string> {
        return this.config.provider.getNetworkPassphrase();
    }

    /**
     * @inheritdoc IStellarWalletInteractor.signKeyDerivationMessage
     * @throws {StellarWalletNetworkMismatch} If the wallet's active network doesn't match.
     * @throws {StellarWalletNotAvailable} If the wallet extension isn't available.
     * @throws {StellarWalletSignTransactionFailed} If signing fails for any other reason
     *   (including the user declining the popup, or the wallet returning no signature).
     */
    async signKeyDerivationMessage(ownerAddress: string): Promise<Hex> {
        const activeNetwork = await this.config.provider.getNetworkPassphrase();
        if (activeNetwork !== this.config.networkPassphrase) {
            throw new StellarWalletNetworkMismatch(this.config.networkPassphrase, activeNetwork);
        }

        try {
            const unsignedXdr = buildKeyDerivationTransaction(
                ownerAddress,
                this.config.networkPassphrase,
            ).toXDR();
            const signedXdr = await this.config.provider.signTransaction(unsignedXdr, {
                networkPassphrase: this.config.networkPassphrase,
            });
            const signedTx = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase);
            if (!("signatures" in signedTx) || signedTx.signatures.length === 0) {
                throw new StellarWalletSignTransactionFailed(
                    "wallet returned a transaction with no signature",
                );
            }
            return `0x${signedTx.signatures[0].signature().toString("hex")}` as Hex;
        } catch (error) {
            throw this.classifySignError(error);
        }
    }

    /**
     * @inheritdoc IStellarWalletInteractor.signAuthEntry
     *
     * The wallet signs the entry's authorization preimage (Freighter's `signAuthEntry`); the
     * signature is attached to the entry here.
     * @throws {StellarWalletNetworkMismatch} If the wallet is on another network.
     * @throws {StellarWalletNotAvailable} If the wallet cannot sign auth entries.
     * @throws {StellarWalletSignTransactionFailed} If signing fails or is rejected.
     */
    async signAuthEntry(entryXdr: string, validUntilLedger: number): Promise<string> {
        const activeNetwork = await this.config.provider.getNetworkPassphrase();
        if (activeNetwork !== this.config.networkPassphrase) {
            throw new StellarWalletNetworkMismatch(this.config.networkPassphrase, activeNetwork);
        }
        const signPreimage = this.config.provider.signAuthEntry;
        if (!signPreimage) {
            throw new StellarWalletNotAvailable("this wallet provider cannot sign Soroban authorization entries");
        }
        try {
            const [address] = await this.getAccounts();
            const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
            const signed = await authorizeEntry(
                entry,
                async (preimage) =>
                    Buffer.from(
                        await signPreimage(preimage.toXDR("base64"), {
                            networkPassphrase: this.config.networkPassphrase,
                            address: address!,
                        }),
                        "base64",
                    ),
                validUntilLedger,
                this.config.networkPassphrase,
            );
            return signed.toXDR("base64");
        } catch (error) {
            throw this.classifySignError(error);
        }
    }

    private classifySignError(error: unknown): StellarWalletInteractorBaseError {
        const message = error instanceof Error ? error.message : String(error);
        const lower = message.toLowerCase();
        if (/network/.test(lower) && /mismatch/.test(lower)) {
            return new StellarWalletNetworkMismatch(this.config.networkPassphrase, "unknown");
        }
        if (/not installed|not available|extension/.test(lower)) {
            return new StellarWalletNotAvailable(message);
        }
        return new StellarWalletSignTransactionFailed(message);
    }
}
