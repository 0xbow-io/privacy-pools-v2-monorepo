import type {
    Address,
    DepositForRecipient,
    EVMProof,
    Hash,
    Hex,
    IAddressEqualityComparator,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    INoteManager,
    IPayoutRoutingCodec,
    IPoolSessionDeposit,
    ITransactOrchestrator,
    IYieldRouterCodec,
    IYieldRouterInteractor,
    IYieldTokenInteractor,
    Note,
    PendingNote,
    PreparedTransaction,
    TxLog,
    WithdrawalFeeCommitment,
    WithdrawalRelayParams,
} from "../internal.js";

/**
 * The chain-neutral view of one yield deployment the core yield sessions work from: a router that
 * shields/unshields a non-rebasing share token, and the underlying asset the user holds.
 *
 * Privacy Pools shields the SHARES; the user deposits and withdraws the UNDERLYING, and the router
 * bridges the two in one call each way. Each chain sdk keeps its own public deployment type (e.g.
 * evm-sdk's `YieldDeployment`, whose field names predate this split) and maps it onto this one.
 */
export interface YieldDeploymentConfig<TAddress = Address> {
    /** The router: yield deposits target it, and it is the transact processor for yield withdrawals. */
    router: TAddress;
    /** The share token — the shielded asset, and the `tokenId` of every yield note. */
    shareToken: TAddress;
    /** Decimals of the share token. */
    shareDecimals: number;
    /** The underlying asset the user holds and receives. */
    underlying: TAddress;
    /** Decimals of the underlying. */
    underlyingDecimals: number;
    /** Human label for the underlying (e.g. "USDC", "XLM"). */
    underlyingSymbol: string;
}

/** Sizing a deposit from a target share `value`: see {@link IYieldRouterInteractor.quote}. */
export interface YieldQuote {
    /** Underlying the router pulls for `total` shares, including any venue supply buffer. */
    underlyingNeeded: bigint;
    /** Total shares minted: the requested value plus floor(value × vettingFeeBPS / 10000). */
    total: bigint;
}

/** Parameters for a single yield deposit. */
export interface YieldDepositParams {
    /** Executor funding emits no wallet approvals. Defaults to wallet funding. */
    fundingSource?: "wallet" | "executor";
    /**
     * Exact shares to mint and shield, as a raw integer in the share token's smallest unit. From
     * an all-in budget use
     * {@link IPoolSessionYieldDeposit.sizeSharesForBudget} and pass BOTH fields it returns; from a
     * mint principal, {@link IPoolSessionYieldDeposit.sharesForUnderlying}.
     */
    value: bigint;
    /**
     * Optional spend cap: the most underlying the router may pull, bound into the router's
     * exact-shares deposit (and, where the chain needs one, approved beforehand). Must be at least
     * the router's quoted `underlyingNeeded`. Defaults to `underlyingNeeded` plus
     * {@link DEPOSIT_RATE_HEADROOM_PPM} (floored at one unit).
     */
    maxUnderlyingIn?: bigint;
}

/**
 * A prepared yield deposit: the transactions to submit in order (any approvals, then the deposit)
 * plus the note to persist and the sizing that was applied.
 */
export interface PreparedYieldDeposit<TTx = PreparedTransaction, TAddress = Address> {
    /** The deposit note to persist once the deposit transaction is included. */
    pendingNote: PendingNote<TAddress>;
    /**
     * Every underlying approval to submit, in order, before `depositTx`. Empty when none is needed
     * — always on chains with invocation-scoped token authorization (Stellar), and on EVM when the
     * current allowance already covers `maxUnderlyingIn`.
     */
    approvalTxs: TTx[];
    /** The last of `approvalTxs`, or null when no approval is needed — kept for single-approval callers. */
    approvalTx: TTx | null;
    /** The router's exact-shares deposit — submit after any approval confirms. */
    depositTx: TTx;
    /** The exact shares being minted (echo of the request `value`). */
    sharesValue: bigint;
    /** Router quote for the shares: underlying for value + vetting-fee shares, plus the venue supply buffer. */
    underlyingNeeded: bigint;
    /** Spend cap bound into `depositTx`: the caller's, else quoted underlying + headroom. */
    maxUnderlyingIn: bigint;
    /**
     * Present only when `prepareYieldDepositFor`'s `discoveryData.evmAddress` recipient had no
     * registered viewing key and `allowOutOfBandFallback` was set — no on-chain announcement was
     * published. The caller MUST deliver this to the recipient out-of-band; losing it strands the
     * deposited shares permanently. Mirrors `PrepareDepositResult.noteSecret`.
     */
    noteSecret?: Hex;
}

/**
 * A yield deposit's recipient identity — the yield-share equivalent of the union half of
 * {@link DepositForParams}, generic over the chain's address type `TAddress`. Either a
 * pre-computed `noteAddressHash` (blind, no announcement) or `discoveryData` (evmAddress
 * auto-resolved via the keystore, or a caller-supplied publicViewingKey) to enable on-chain
 * discovery for the recipient. Factored out on its own so callers that already have sizing
 * params in hand (e.g. `prepareYieldSwapDeposit`) can accept just the recipient half instead of
 * a full {@link YieldDepositForParams}. Same forms as {@link DepositForRecipient}, so a blind
 * recipient's `noteData` may be a `NoteDataBuilder` (needed when the SDK sizes the shares, as a
 * swap-and-deposit into a yield share does).
 */
export type YieldDepositForRecipient<TAddress = Address> = DepositForRecipient<TAddress>;

/**
 * Parameters for a yield deposit on behalf of a recipient — the yield-share equivalent of
 * {@link DepositForParams}, generic over the chain's address type `TAddress`.
 */
export type YieldDepositForParams<TAddress = Address> = YieldDepositParams & YieldDepositForRecipient<TAddress>;

/**
 * A deposit sized from an ALL-IN underlying budget ("deposit 100 USDC"), see
 * {@link IPoolSessionYieldDeposit.sizeSharesForBudget}.
 */
export interface BudgetSizedYieldDeposit {
    /** Committed shares (the note value), raw integer. */
    shares: bigint;
    /** Router quote for those shares now: value + vetting-fee shares, plus the supply buffer. */
    underlyingNeeded: bigint;
    /** The budget itself: pass it as {@link YieldDepositParams.maxUnderlyingIn}. */
    maxUnderlyingIn: bigint;
    /** Rate headroom reserved inside the budget (`DEPOSIT_RATE_HEADROOM_PPM` of it, at least one unit). */
    headroom: bigint;
}

/** Parameters for a single yield withdrawal (shielded shares -> underlying to a recipient). */
export interface YieldWithdrawParams<TAddress = Address> {
    /** Commitment hashes of the input notes to spend. All must be ACTIVE. */
    inputCommitments: Hash[];
    /** Value released from the pool (drives the change note), in raw shares. */
    amount: bigint;
    /** Total shares paid to the router (recipient leg + fee leg), in raw shares. */
    amountOut: bigint;
    /** Recipient of the unwrapped underlying. */
    recipient: TAddress;
    /** Fee recipient override (`PayoutRouting.feeRecipient`); defaults to `recipient`. */
    feeRecipient?: TAddress;
    /** Shares taken as the relayer fee leg, in raw shares. Defaults to `0n`. */
    feeAmount?: bigint;
    /** Native gas to forward via `PayoutRouting.nativeGas` (EVM only). Defaults to `0n`. */
    nativeGas?: bigint;
    /** Slippage floor in bps for the recipient leg; defaults to {@link WITHDRAW_SLIPPAGE_BPS}. */
    slippageBps?: bigint;
}

/** A prepared yield withdrawal: the single router transaction plus sizing and change notes. */
export interface PreparedYieldWithdraw<TTx = PreparedTransaction, TAddress = Address> {
    /** The router's withdraw-to-underlying call — the one transaction to submit. */
    withdrawTx: TTx;
    /** Change notes for the sender (remainder after the withdrawal), to persist on execution. */
    changePendingNotes: PendingNote<TAddress>[];
    /** Input notes to mark SPENT on execution. */
    spentNotes: Note<TAddress>[];
    /** Shares going to the recipient leg (`amountOut - feeAmount`). */
    recipientShares: bigint;
    /** Router-quoted underlying for the recipient shares, before the slippage floor. */
    quotedUnderlyingOut: bigint;
    /** Slippage floor bound into `withdrawTx` (recipient receives at least this). */
    minUnderlyingOut: bigint;
}

/**
 * Parameters for a RELAYED yield withdrawal. The proof context is bound to the relayer's signed
 * `PayoutRouting` (`signedFeeCommitment.data`), exactly as the plain relayed-withdraw path binds
 * `transactParams.data` to the quote commitment. The in-pool fee is `0`: the relayer's fee leg is
 * split from the withdrawn shares by the router after the exit.
 */
export interface YieldWithdrawRelayParams<TAddress = Address> {
    /** Commitment hashes of the input notes to spend. All must be ACTIVE. */
    inputCommitments: Hash[];
    /** Value released from the pool (drives the change note), in raw shares. */
    amount: bigint;
    /** Total shares paid to the router (recipient leg + fee leg), in raw shares. */
    amountOut: bigint;
    /** Recipient of the unwrapped underlying; bound into the proof context. */
    recipient: TAddress;
    /** The relayer's signed withdrawal fee commitment from the quote; binds the `PayoutRouting`. */
    signedFeeCommitment: WithdrawalFeeCommitment<TAddress>;
    /**
     * Whether the recipient gas top-up was requested from the relayer (the quote's `extraGas`,
     * EVM only). Pins only its PRESENCE in the signed routing. Defaults to `false`.
     */
    extraGas?: boolean;
    /** Slippage floor in bps for the recipient leg; defaults to {@link WITHDRAW_SLIPPAGE_BPS}. */
    slippageBps?: bigint;
}

/**
 * A prepared RELAYED yield withdrawal: the typed relayer params to submit via
 * `IRelayerInteractor.relayWithdrawal` plus sizing and change notes to persist on success.
 */
export interface PreparedYieldWithdrawRelay<TAddress = Address> {
    /** Carries `processorAddress` (the router) and `minUnderlyingOut`. */
    relayParams: WithdrawalRelayParams<TAddress>;
    /** Change notes for the sender (remainder after the withdrawal), to persist on execution. */
    changePendingNotes: PendingNote<TAddress>[];
    /** Input notes to mark SPENT on execution. */
    spentNotes: Note<TAddress>[];
    /** Shares going to the recipient leg (`amountOut - feeAmount`). */
    recipientShares: bigint;
    /** Router-quoted underlying for the recipient shares, before the slippage floor. */
    quotedUnderlyingOut: bigint;
    /** Slippage floor bound into `relayParams.minUnderlyingOut` (recipient receives at least this). */
    minUnderlyingOut: bigint;
}

/** Configuration for {@link PoolSessionYieldDeposit} construction. */
export interface PoolSessionYieldDepositConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** The yield deployment (router, share and underlying). */
    deployment: YieldDeploymentConfig<TAddress>;
    /** Base deposit session used to build the standard share-token deposit proof. */
    deposit: IPoolSessionDeposit<TTx, TAddress, TProof, TLog>;
    /** Router interactor used to size the deposit spend cap. */
    router: IYieldRouterInteractor<TAddress>;
    /** Share-token interactor used to estimate shares from an underlying budget. */
    yieldToken: IYieldTokenInteractor<TAddress>;
    /** Re-targets the standard deposit at the router and plans any funding approvals. */
    codec: IYieldRouterCodec<TTx, TAddress>;
}

/** Dependencies for {@link PoolSessionYieldDeposit} construction. */
export interface PoolSessionYieldDepositDependencies {
    logger?: ILogger;
}

/** Configuration for {@link PoolSessionYieldWithdraw} construction. */
export interface PoolSessionYieldWithdrawConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** The yield deployment (router, share and underlying). */
    deployment: YieldDeploymentConfig<TAddress>;
    /** Transact orchestrator used to build the standard withdraw proof with the router as processor. */
    orchestrator: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    /** Router interactor used to size the recipient slippage floor. */
    router: IYieldRouterInteractor<TAddress>;
    /** Re-targets the standard transact at the router's withdraw-to-underlying call. */
    codec: IYieldRouterCodec<TTx, TAddress>;
    /** Encodes/decodes the `PayoutRouting` bound into the proof context. */
    payoutRoutingCodec: IPayoutRoutingCodec<TAddress>;
    /** Compares chain addresses (EVM is case-insensitive, Stellar StrKeys are exact). */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    /** The chain's empty/zero address, rejected as a withdraw recipient. */
    emptyAddress: TAddress;
}

/** Dependencies for {@link PoolSessionYieldWithdraw} construction. */
export interface PoolSessionYieldWithdrawDependencies {
    logger?: ILogger;
}

/** Configuration for {@link PoolSessionYieldEarned} construction. */
export interface PoolSessionYieldEarnedConfig<TAddress = Address> {
    /** The yield deployment whose share is valued. */
    deployment: YieldDeploymentConfig<TAddress>;
    /** Source of the wallet's notes. */
    noteManager: INoteManager<TAddress>;
    /** Source of the nullifying key that finds the wallet's spends among the events. */
    keystoreManager: IKeystoreManager;
    /** Computes nullifiers. */
    noteComputationService: INoteComputationService;
    /** Reads the live `exchangeRate()`. The only request `compute` makes. */
    yieldToken: IYieldTokenInteractor<TAddress>;
}

/** Dependencies for {@link PoolSessionYieldEarned} construction. */
export interface PoolSessionYieldEarnedDependencies {
    logger?: ILogger;
}
