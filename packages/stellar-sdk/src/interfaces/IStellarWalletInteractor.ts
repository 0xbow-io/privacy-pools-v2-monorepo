import type { Hex } from "../internal.js";

/**
 * Signing + submission for Stellar transactions — mirrors `IWalletInteractor.sendTransaction`'s
 * shape exactly (sign, broadcast, return the hash, all in one call) rather than the milestone's
 * earlier "wallet signs only, RPC submits" sketch. Confirmed against `EvmPoolVaultChainAdapter
 * .submit`, which delegates to `this.walletInteractor.sendTransaction(tx)` — the wallet
 * interactor owns the full lifecycle, `IRPCInteractor` never has a submit method of its own.
 *
 * Two concrete implementations are expected: a browser-extension wallet (Freighter) that prompts
 * the user, and a raw `Keypair`-backed one for relayer/service-account/test use — both delegate
 * the actual broadcast to `IStellarRPCInteractor.submitTransaction`.
 */
export interface IStellarWalletInteractor {
    /**
     * Signs `unsignedXdr` and submits it, returning the resulting transaction hash.
     *
     * @param unsignedXdr - Unsigned transaction XDR, as produced by
     *   `IStellarRPCInteractor.buildTransaction`.
     * @returns The transaction hash.
     * @throws {StellarWalletInteractorBaseError} If building or signing the transaction fails.
     * @throws {WalletSendTransactionFailed} If the network rejects the signed transaction — the
     *   same core-sdk chain-agnostic class every chain's wallet interactor throws for this case,
     *   not a `StellarWalletInteractorBaseError` subtype.
     */
    sendTransaction(unsignedXdr: string): Promise<Hex>;

    /**
     * Lists the accounts (StrKey public keys) available for signing.
     *
     * @throws {StellarWalletNoAccountsError} If no accounts are available.
     * @throws {StellarWalletNotAvailable} If the wallet provider isn't available at all.
     */
    getAccounts(): Promise<string[]>;

    /** The network passphrase the wallet is currently configured for. */
    getNetworkPassphrase(): Promise<string>;

    /**
     * Signs the fixed key-derivation transaction (`buildKeyDerivationTransaction`) and returns
     * the raw 64-byte ed25519 signature — never submits it. Feed the result into
     * `StellarCryptoService.deriveKeysFromSignature`'s `config.signature`.
     *
     * @param ownerAddress - The signer's StrKey account address.
     * @returns The raw signature, 0x-prefixed.
     * @throws {StellarWalletInteractorBaseError}
     */
    signKeyDerivationMessage(ownerAddress: string): Promise<Hex>;

    /**
     * Signs a Soroban authorization entry for the wallet's account — the owner's half of an
     * invocation someone else submits (a relayed `register_and_relay`'s nested
     * `keystore.set_auth_policy`). The entry's nonce and invocation are kept; the signature expires
     * at `validUntilLedger`.
     *
     * @param entryXdr - The unsigned `SorobanAuthorizationEntry`, base64 XDR.
     * @param validUntilLedger - The last ledger the signature is valid for.
     * @returns The signed entry, base64 XDR.
     * @throws {StellarWalletInteractorBaseError}
     */
    signAuthEntry(entryXdr: string, validUntilLedger: number): Promise<string>;
}
