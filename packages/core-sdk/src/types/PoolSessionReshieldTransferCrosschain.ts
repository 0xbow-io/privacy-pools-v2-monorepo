import type {
    Address,
    IAddressEqualityComparator,
    ILogger,
    IPoolSessionReshieldCrosschain,
    PreparedTransaction,
    ReshieldCrosschainParams,
    TxLog,
    YieldDepositForRecipient,
    YieldSwapDepositTarget,
} from "../internal.js";

/**
 * Configuration for PoolSessionReshieldTransferCrosschain construction, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, and raw receipt-log type `TLog`.
 */
export interface PoolSessionReshieldTransferCrosschainConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
> {
    /**
     * The underlying cross-chain reshield session this wraps. Its estimate/quote/relay steps
     * (including the `dustRescue` opt-in) are already fully recipient-agnostic, so they are
     * reused verbatim rather than reimplemented; only the deposit-building step is new here.
     * Pass the same instance `PoolSessionReshieldCrosschain` is built with, not a fresh one.
     */
    reshieldCrosschainDelegate: IPoolSessionReshieldCrosschain<TTx, TAddress, TLog>;
    /**
     * Share targets from a **destination-chain-scoped** session (i.e. built by a `PoolSession`
     * for `toChainId`, not this session's own source chain) — required, unlike the optional
     * field of the same name on plain `PoolSessionReshieldCrosschainConfig`, because every
     * reshield-and-transfer deposit must resolve to one. Each target's `deposit` is already a
     * `PoolSessionYieldDeposit` wired with a destination-chain-scoped `PoolSessionDeposit`
     * (its own `keystoreInteractor`, pointed at the destination chain's keystore contract) —
     * this session needs no keystore/crypto dependency of its own, same as the same-chain
     * session, because recipient resolution already happens two layers down, inside code this
     * session never touches.
     */
    destinationYieldDepositTargets: YieldSwapDepositTarget<TTx, TAddress>[];
    /**
     * Compares two **destination-chain** `TAddress` values for equality (chain-specific
     * canonicalization rules), used to resolve `outputToken` against
     * `destinationYieldDepositTargets`.
     */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
}

/** Dependencies for PoolSessionReshieldTransferCrosschain construction. */
export interface PoolSessionReshieldTransferCrosschainDependencies {
    logger?: ILogger;
}

/**
 * Parameters for the reshield-and-transfer-crosschain deposit leg: sizes and builds the
 * yield-share deposit-for proof, against the **destination** chain's Entrypoint, on behalf of
 * the given recipient, generic over the chain's address type `TAddress`. Recipient identity
 * mirrors `DepositForParams`/`YieldDepositForRecipient` directly — a reshield-and-transfer
 * deposit is exactly one output note, so there is nothing to key by a `noteSecretsMap`-style Map
 * the way a multi-note transfer needs.
 */
export type PrepareReshieldTransferCrosschainDepositParams<TAddress = Address> = YieldDepositForRecipient<TAddress> & {
    /** The desired output token (destination chain) — must resolve to a configured yield deposit target. */
    outputToken: TAddress;
    /** Budget for the deposit (destination-chain underlying-token units), from `ReshieldCrosschainEstimate.totalDepositCost`. */
    totalDepositCost: string;
};

/**
 * Reshield-and-transfer-crosschain relay parameters — identical to `ReshieldCrosschainParams`
 * except it never carries a `depositNote`: the sender must never persist a note it doesn't own.
 */
export type ReshieldTransferCrosschainParams<TAddress = Address> = Omit<
    ReshieldCrosschainParams<TAddress>,
    "depositNote"
>;
