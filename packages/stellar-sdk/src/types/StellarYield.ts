import type {
    IPoolSessionYieldDeposit,
    IPoolSessionYieldEarned,
    IPoolSessionYieldWithdraw,
    IStellarRPCInteractor,
    IStellarWalletInteractor,
    StellarAddress,
    StellarYieldRouterInteractor,
    StellarYieldTokenInteractor,
    YieldDeploymentConfig,
} from "../internal.js";

/**
 * One Stellar yield deployment: the `yield-router`, its `yield-token` share (the shielded asset,
 * registered as a pool asset) and the underlying the Blend reserve lends. core-sdk's neutral
 * {@link YieldDeploymentConfig}, used as-is — Stellar has no pre-split field names to keep.
 */
export type StellarYieldDeployment = YieldDeploymentConfig<StellarAddress>;

/** The yield sessions and interactors for one {@link StellarYieldDeployment}. */
export interface StellarYieldSessions {
    /** The deployment these sessions serve; the key {@link StellarPoolSession.yieldFor} matches on. */
    deployment: StellarYieldDeployment;
    /** Deposit flow: underlying -> shares + shield, in one router call. */
    deposit: IPoolSessionYieldDeposit<string, StellarAddress>;
    /** Withdraw flow: shielded shares -> underlying to a recipient (self-submitted or relayed). */
    withdraw: IPoolSessionYieldWithdraw<string, StellarAddress>;
    /** Yield earned on this share position. */
    earned: IPoolSessionYieldEarned;
    /** Share-token reads (rate, previews, adapter). */
    token: StellarYieldTokenInteractor;
    /** Router sizing quotes. */
    router: StellarYieldRouterInteractor;
}

/** Stellar's chain extensions, read by {@link StellarPoolSession}. */
export interface StellarChainExtensions {
    yield?: StellarYieldSessions;
    yields?: StellarYieldSessions[];
}

/**
 * What `createStellarPoolSession` needs to build the yield namespace — the reads and writes the
 * generic `PoolSessionConfig` does not carry for Stellar.
 */
export interface StellarYieldSessionConfig {
    /** One namespace per deployment; the same share twice is a configuration error. */
    deployments: StellarYieldDeployment[];
    /** Soroban RPC for the yield reads and for building the router calls. */
    rpcInteractor: IStellarRPCInteractor;
    /** Any existing account, used as the source of read-only simulations. */
    readSourcePublicKey: string;
    /** The privacy pool (its asset config for the share token carries the vetting fee). */
    poolContractId: string;
    /** The ASP registry the pool registers deposit labels with. */
    aspRegistryContractId: string;
    /** Signs the yield deposit (the depositor authorizes the underlying pull). */
    walletInteractor?: IStellarWalletInteractor;
}

/** Configuration for {@link StellarYieldRouterCodec}. */
export interface StellarYieldRouterCodecConfig {
    /** Builds (and simulates) the router calls. */
    rpcInteractor: IStellarRPCInteractor;
    /** The network passphrase the parsed pool calls were built against. */
    networkPassphrase: string;
}

/** Configuration for {@link StellarRelayBatchCodec}. */
export interface StellarRelayBatchCodecConfig {
    /** Builds (and simulates) the `relay_batch` call. */
    rpcInteractor: IStellarRPCInteractor;
    /** The self-submitting account: the batch's `relayer`, and the transaction source. */
    sourceAddress: StellarAddress;
}
