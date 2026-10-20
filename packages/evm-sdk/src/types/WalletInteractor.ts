import { Account, Chain, Transport, WalletClient } from "viem";

// NOTE (evm-sdk split): core-sdk only keeps the chain-agnostic IWalletInteractor interface —
// these EVM-concrete provider/config shapes (EIP1193Provider, and the viem WalletClient-backed
// configs) live here instead, alongside EIP1193WalletInteractor / ViemWalletInteractor.

/** Minimal EIP-1193 provider interface for sending transactions. */
export interface EIP1193Provider {
    request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
}

/** Configuration for the {@link EIP1193WalletInteractor} service. */
export interface EIP1193WalletInteractorConfig {
    /** An EIP-1193-compatible provider (e.g., MetaMask, WalletConnect). */
    provider: EIP1193Provider;
    /**
     * Optional. The chain every transaction from this interactor must go out on.
     *
     * A provider's active network changes whenever the user switches it, so a session that
     * checked the chain once at build time can still send to the same address on a different
     * chain. When set, the chain is re-read immediately before each send and the transaction
     * is refused on a mismatch. When omitted, behaviour is unchanged.
     */
    expectedChainId?: number;
}

/** Configuration for {@link ViemWalletInteractor}. */
export interface ViemWalletInteractorConfig {
    /** A viem WalletClient with an account attached. */
    walletClient: WalletClient<Transport, Chain, Account>;
    /**
     * Optional. The chain every transaction from this interactor must go out on — see
     * {@link EIP1193WalletInteractorConfig.expectedChainId}. Both the chain configured on the
     * client (which is what a local account signs against) and the chain the client's
     * transport reports are checked before each send. When omitted, behaviour is unchanged.
     */
    expectedChainId?: number;
}
