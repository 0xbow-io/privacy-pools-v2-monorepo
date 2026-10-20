// ILogger / LeafCacheSeed are chain-agnostic and live in core-sdk now (not stellar-sdk's own
// interfaces/types) — imported directly from the dependency's package entry, matching evm-sdk's
// identical types/RPCInteractor.ts precedent.
import type { ILogger, LeafCacheSeed } from "@privacy-pools-v2/core-sdk";
import type { IStellarRPCInteractor } from "../interfaces/IStellarRPCInteractor.js";
import type { IStellarWalletInteractor } from "../interfaces/IStellarWalletInteractor.js";
import type { StellarYieldTokenInteractor } from "../services/contractInteractors/StellarYieldTokenInteractor.js";

/** Configuration for a Stellar contract chain adapter. */
export interface StellarContractInteractorConfig {
    /** Read-only Soroban RPC interactor for contract calls. */
    rpcInteractor: IStellarRPCInteractor;
    /** The Soroban contract ID this adapter is bound to. */
    contractId: string;
    /**
     * Any existing account used as the source of read-only simulation transactions — Soroban
     * requires a valid source account to build any call, including pure reads, unlike EVM's
     * `eth_call` which needs no account at all.
     */
    readSourcePublicKey: string;
    /** Earliest ledger to scan for contract events. When omitted, `getEvents`'s own recent-window fallback applies. */
    deploymentLedger?: bigint;
}

/** Configuration for {@link StellarEntrypointChainAdapter} — the pool contract handles deposit
 * directly on Stellar (no separate Entrypoint contract was ported), so `contractId` here is the
 * same pool contract ID `StellarPoolVaultChainAdapter` is bound to. The ASP registry has no
 * on-chain accessor on the Stellar pool contract (unlike EVM's `Entrypoint.aspRegistry()`), so
 * it's supplied directly from deployment config instead of being read on-chain.
 */
export type StellarEntrypointInteractorConfig = StellarContractInteractorConfig & {
    /** The ASP registry contract ID — not readable from the pool contract itself. */
    aspRegistryContractId: string;
    /**
     * Whether `encodeDeposit` simulates (and so fully prepares) the deposit. Defaults to `true`.
     * `false` builds an unsimulated envelope for a codec to re-target — the yield deposit, whose
     * share-token transfer cannot simulate before the router mints the shares. Needs
     * `networkPassphrase`.
     */
    simulateDeposits?: boolean;
    /** The network passphrase; required when `simulateDeposits` is `false`. */
    networkPassphrase?: string;
};

/** Configuration for {@link StellarYieldRouterInteractor}. */
export type StellarYieldRouterInteractorConfig = StellarContractInteractorConfig & {
    /** The privacy pool, whose asset config for the share token carries the vetting fee. */
    poolContractId: string;
    /** The router's share token (`vault`). */
    yieldToken: StellarYieldTokenInteractor;
};

/** Optional write dependencies for a Stellar contract chain adapter. */
export interface StellarContractInteractorWriteDependencies {
    walletInteractor?: IStellarWalletInteractor;
}

/** Optional dependencies for StellarPoolVaultInteractor. */
export interface StellarPoolVaultInteractorDependencies {
    logger?: ILogger;
    walletInteractor?: IStellarWalletInteractor;
    /** Pre-populates the state-tree leaf cache — see {@link LeafCacheSeed}. */
    seed?: LeafCacheSeed;
}

/** Optional dependencies for StellarKeystoreInteractor. */
export type StellarKeystoreInteractorDependencies = StellarContractInteractorWriteDependencies & {
    /** Pre-populates the keystore leaf cache — see {@link LeafCacheSeed}. */
    seed?: LeafCacheSeed;
};
