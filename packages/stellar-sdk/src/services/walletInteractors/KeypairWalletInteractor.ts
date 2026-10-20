import { authorizeEntry, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

import {
    buildKeyDerivationTransaction,
    Hex,
    IStellarWalletInteractor,
    KeypairWalletInteractorConfig,
    StellarRPCInteractorBaseError,
    StellarWalletInteractorBaseError,
    StellarWalletSignTransactionFailed,
    WalletSendTransactionFailed,
} from "../../internal.js";

/**
 * {@link IStellarWalletInteractor} implementation backed by a raw `Keypair` — for
 * relayer/service-account/test use, not end-user wallets (see {@link FreighterWalletInteractor}
 * for the browser-extension counterpart). Ports the signing step from
 * `StellarContractInteractor.mjs`'s `writeContract` (`preparedTx.sign(this.#sourceKeypair)`).
 */
export class KeypairWalletInteractor implements IStellarWalletInteractor {
    private readonly config: KeypairWalletInteractorConfig;

    constructor(config: KeypairWalletInteractorConfig) {
        this.config = config;
    }

    /**
     * @inheritdoc IStellarWalletInteractor.sendTransaction
     * @throws {StellarWalletSignTransactionFailed} If building or signing the transaction fails.
     * @throws {WalletSendTransactionFailed} If the network rejects the signed transaction (e.g.
     *   insufficient balance) — core-sdk's chain-agnostic "submission failed" signal, the same one
     *   every chain's wallet interactor throws for this case (see `ViemWalletInteractor`'s EVM
     *   counterpart), not a `StellarWalletInteractorBaseError` subtype.
     */
    async sendTransaction(unsignedXdr: string): Promise<Hex> {
        let signedXdr: string;
        try {
            const tx = TransactionBuilder.fromXDR(unsignedXdr, this.config.networkPassphrase);
            tx.sign(this.config.keypair);
            signedXdr = tx.toXDR();
        } catch (error) {
            if (error instanceof StellarWalletInteractorBaseError) throw error;
            throw new StellarWalletSignTransactionFailed(
                error instanceof Error ? error.message : String(error),
            );
        }
        try {
            return await this.config.rpcInteractor.submitTransaction(signedXdr);
        } catch (error) {
            if (error instanceof StellarRPCInteractorBaseError) {
                throw new WalletSendTransactionFailed(error.message);
            }
            throw new WalletSendTransactionFailed(error instanceof Error ? error.message : String(error));
        }
    }

    /** @inheritdoc IStellarWalletInteractor.getAccounts */
    async getAccounts(): Promise<string[]> {
        return [this.config.keypair.publicKey()];
    }

    /** @inheritdoc IStellarWalletInteractor.getNetworkPassphrase */
    async getNetworkPassphrase(): Promise<string> {
        return this.config.networkPassphrase;
    }

    /**
     * @inheritdoc IStellarWalletInteractor.signKeyDerivationMessage
     * @throws {StellarWalletSignTransactionFailed} If signing fails.
     */
    async signKeyDerivationMessage(ownerAddress: string): Promise<Hex> {
        try {
            const tx = buildKeyDerivationTransaction(ownerAddress, this.config.networkPassphrase);
            tx.sign(this.config.keypair);
            return `0x${tx.signatures[0].signature().toString("hex")}` as Hex;
        } catch (error) {
            if (error instanceof StellarWalletInteractorBaseError) throw error;
            throw new StellarWalletSignTransactionFailed(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /**
     * @inheritdoc IStellarWalletInteractor.signAuthEntry
     * @throws {StellarWalletSignTransactionFailed} If the entry cannot be parsed or signed.
     */
    async signAuthEntry(entryXdr: string, validUntilLedger: number): Promise<string> {
        try {
            const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
            const signed = await authorizeEntry(entry, this.config.keypair, validUntilLedger, this.config.networkPassphrase);
            return signed.toXDR("base64");
        } catch (error) {
            throw new StellarWalletSignTransactionFailed(error instanceof Error ? error.message : String(error));
        }
    }
}
