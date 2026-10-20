import type {
    Address,
    RelayerChainDetails,
    IKeystoreManager,
    INoteComputationService,
    INoteManager,
    IPoolSessionDeposit,
    IPoolSessionYieldDeposit,
    IPoolSessionYieldEarned,
    IPoolSessionYieldWithdraw,
    IPPRouterInteractor,
    IPPYieldTokenInteractor,
    ITransactOrchestrator,
    PoolSessionConfig,
} from "../internal.js";

/**
 * Configuration for one Aave-yield (ppUSDC) deployment: the combined `PPRouter`, the ERC-4626
 * share wrapper (`ppUSDC` / `PPYieldToken`) that is the shielded asset, and the underlying ERC-20
 * (e.g. USDC) the user actually holds.
 *
 * Privacy Pools shields the *shares* (ppUSDC); the user deposits/withdraws the *underlying* (USDC).
 * The router bridges the two on the way in and out — see {@link IPPRouterInteractor}.
 */
export interface YieldDeployment {
    /** Combined router that wraps USDC<->ppUSDC and shields/unshields via the pool. */
    ppRouter: Address;
    /** Use the payable native deposit entry. Supplied by configuration, not relayer details. */
    nativeMode?: boolean;
    /**
     * `PPYieldTokenZap` — the stateless wrap/unwrap helper. Optional: only the loose-ppShare→underlying
     * exit (`PPYieldTokenZapInteractor.encodeRedeemToUnderlying`, e.g. after a ragequit) needs it; the
     * shield/unshield deposit/withdraw flows route through `ppRouter`.
     */
    zap?: Address;
    /** ERC-4626-style yield-bearing wrapper share token (the shielded asset). */
    ppUSDC: Address;
    /** Decimals of the ppUSDC share token (always 18 for the current wrapper). */
    ppUSDCDecimals: number;
    /** Underlying ERC-20 the user holds/approves (the Aave-supplied asset, e.g. USDC). */
    underlying: Address;
    /** Underlying decimals (USDC = 6). */
    underlyingDecimals: number;
    /** Human label for the underlying (e.g. "USDC"). */
    underlyingSymbol: string;
    /** Optional headline APY source for UI display (informational only, e.g. "Aave"). */
    apyLabel?: string;
}

/**
 * `createEvmPoolSession`'s config: core-sdk's generic {@link PoolSessionConfig}, plus the
 * Aave-yield deployment(s) — dropped from core-sdk's own config type since yield is a specific EVM
 * smart-contract product feature, not a general chain capability (see
 * `PoolSessionConfig.buildChainExtensions`'s own doc). One namespace is built per deployment;
 * `yieldDeployment` (single) stays supported and comes first, `yieldDeployments` adds the rest —
 * the same share configured twice (by address) is a configuration error, not a silent override.
 */
export type EvmPoolSessionConfig = PoolSessionConfig & {
    /** A single Aave-yield (ppUSDC) deployment to expose as `session.yield`. */
    yieldDeployment?: YieldDeployment;
    /** Additional Aave-yield deployments, each its own {@link YieldSessions} entry in `session.yields`. */
    yieldDeployments?: YieldDeployment[];
    /**
     * Share targets from the DESTINATION chain's session (`destinationSession.yields`): lets a
     * cross-chain reshield fund a yield-share output there. Each must be bound to
     * `destinationChainId`, else construction throws.
     */
    destinationYieldDepositTargets?: YieldDepositTarget[];
    /** `/v1/details` answers already fetched (`PoolSessionBuilder.withRelayerDetails`); seeds the cross-chain reshield's relayer-cap check. */
    relayerChainDetails?: RelayerChainDetails[];
};

/**
 * The optional yield namespace exposed on a {@link PoolSession} when a `yieldDeployment` is
 * configured: the two yield sessions plus the underlying interactors (for note valuation and the
 * direct aUSDC redeem).
 */
export interface YieldSessions {
    /** Chain the deployment lives on: a swap flow accepts a share target only from its own chain
     *  (the DESTINATION chain for a cross-chain reshield). */
    chainId: number;
    /** The deployment these sessions serve; the key {@link PoolSession.yieldFor} matches on. */
    deployment: YieldDeployment;
    /** Deposit flow: USDC -> ppUSDC + shield. */
    deposit: IPoolSessionYieldDeposit;
    /** Withdraw flow: shielded ppUSDC -> USDC to a recipient. */
    withdraw: IPoolSessionYieldWithdraw;
    /**
     * Yield earned on this share position, from the two public ASP feeds the consumer fetches
     * on its own cadence (see {@link IYieldFeedProvider}) plus the live `exchangeRate()`.
     */
    earned: IPoolSessionYieldEarned;
    /** ppUSDC ERC-4626 interactor (reads + `encodeRedeem` aUSDC exit). */
    token: IPPYieldTokenInteractor;
    /** Router interactor (sizing quotes). */
    router: IPPRouterInteractor;
}

/** A configured share target with deposit sizing bound to its chain. Accepts a session.yields entry. */
export type YieldDepositTarget = Pick<YieldSessions, "chainId" | "deployment" | "deposit">;

/** Configuration for {@link EvmPoolSessionYieldDeposit} construction. */
export interface EvmPoolSessionYieldDepositConfig {
    /** The yield deployment (router, ppUSDC, and underlying addresses). */
    deployment: YieldDeployment;
    /** Base deposit session used to build the standard ppUSDC deposit proof. */
    deposit: IPoolSessionDeposit;
    /** Router interactor used to size the deposit spend cap. */
    router: IPPRouterInteractor;
    /**
     * Reads the owner's current underlying allowance for `spender`, so `prepareDeposit` can
     * plan a zero reset on a residual (vuln-mining #28). Optional: without it the allowance
     * is assumed zero and a single `approve(router, maxUnderlyingIn)` is emitted, as before.
     */
    allowanceOf?: (spender: Address) => Promise<bigint>;
    /** ppUSDC interactor used to estimate shares from an underlying budget. */
    yieldToken: IPPYieldTokenInteractor;
}

/** Configuration for {@link EvmPoolSessionYieldWithdraw} construction. */
export interface EvmPoolSessionYieldWithdrawConfig {
    /** The yield deployment (router, ppUSDC, and underlying addresses). */
    deployment: YieldDeployment;
    /** Transact orchestrator used to build the standard withdraw (PoolVault.transact) proof. */
    orchestrator: ITransactOrchestrator;
    /** Router interactor used to size the recipient slippage floor. */
    router: IPPRouterInteractor;
}

/** Configuration for {@link EvmPoolSessionYieldEarned} construction. */
export interface EvmPoolSessionYieldEarnedConfig {
    /** The yield deployment whose share is valued. */
    deployment: YieldDeployment;
    /** Source of the wallet's notes. */
    noteManager: INoteManager;
    /** Source of the nullifying key that finds the wallet's spends among the events. */
    keystoreManager: IKeystoreManager;
    /** Computes nullifiers. */
    noteComputationService: INoteComputationService;
    /** Reads the live `exchangeRate()`. The only request `compute` makes. */
    yieldToken: IPPYieldTokenInteractor;
}

/** Configuration for {@link EvmYieldRouterCodec} construction. */
export interface EvmYieldRouterCodecConfig {
    /** Use the payable native deposit entry (`depositExactSharesNative`, cap sent as `msg.value`). */
    nativeMode?: boolean;
    /**
     * Reads the owner's current underlying allowance for `spender`, so funding can plan a zero
     * reset on a residual (vuln-mining #28). Without it the allowance is assumed zero.
     */
    allowanceOf?: (spender: Address) => Promise<bigint>;
}
