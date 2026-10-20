import type { Keypair } from "@stellar/stellar-sdk";

import type { IStellarRPCInteractor } from "../interfaces/IStellarRPCInteractor.js";

/**
 * Minimal surface a browser-extension Stellar wallet must expose to back
 * {@link FreighterWalletInteractor} — deliberately not typed directly against any specific
 * wallet package's own return shapes, so any wallet exposing this bare-value/throwing contract
 * works, same as `EIP1193Provider`'s "any EIP-1193-compatible provider" framing on the EVM side.
 * `createFreighterProvider` (in `services/walletInteractors/FreighterProvider.ts`) is the
 * SDK-shipped, verified adapter from the real `@stellar/freighter-api` package's actual shape
 * (`{...payload, error?}`, nothing thrown) to this contract; a consumer wiring a different
 * Stellar wallet extension adapts its own return shape the same way.
 */
export interface StellarWalletProvider {
    /** Signs `xdr` and returns the signed transaction, XDR-encoded. */
    signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string>;
    /** Returns the wallet's currently active StrKey public key ("G..."). */
    getAddress(): Promise<string>;
    /** Returns the network passphrase the wallet is currently configured for. */
    getNetworkPassphrase(): Promise<string>;
    /**
     * Signs a Soroban authorization preimage (`HashIdPreimage`, base64 XDR) and returns the
     * signature, base64. Optional: without it the wallet cannot authorize a relayed registration.
     */
    signAuthEntry?(preimageXdr: string, opts: { networkPassphrase: string; address: string }): Promise<string>;
}

/** Configuration for {@link FreighterWalletInteractor}. */
export interface FreighterWalletInteractorConfig {
    /** The browser-extension wallet provider to sign through. */
    provider: StellarWalletProvider;
    /** Broadcasts the signed transaction and reports its hash. */
    rpcInteractor: IStellarRPCInteractor;
    /** The session's configured network — verified against the wallet's own before signing. */
    networkPassphrase: string;
}

/** Configuration for {@link KeypairWalletInteractor}. */
export interface KeypairWalletInteractorConfig {
    /** The keypair to sign with — for relayer/service-account/test use, not end-user wallets. */
    keypair: Keypair;
    /** The network transactions are signed for. */
    networkPassphrase: string;
    /** Broadcasts the signed transaction and reports its hash. */
    rpcInteractor: IStellarRPCInteractor;
}
