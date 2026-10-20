import type {
    Address,
    DepositForParams,
    Hex,
    IAddressEqualityComparator,
    ILogger,
    IPoolSessionReshield,
    PrepareDepositResult,
    PreparedTransaction,
    ReshieldParams,
    TxLog,
    YieldDepositForRecipient,
    YieldSwapDepositTarget,
} from "../internal.js";

/**
 * Configuration for PoolSessionReshieldTransfer construction, generic over the chain's prepared-
 * transaction type `TTx`, address type `TAddress`, and raw receipt-log type `TLog`.
 */
export interface PoolSessionReshieldTransferConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
> {
    /**
     * The underlying reshield session this wraps. Same-chain reshield's estimate/quote/relay
     * steps are already fully recipient-agnostic (the deposit's `noteAddressHash` is chosen
     * client-side before proof generation, and the whole LiFi payload — deposit call included —
     * is proof-bound), so they are reused verbatim rather than reimplemented; only the
     * deposit-building step is new here. Pass the same instance `PoolSessionReshield` is built
     * with, not a fresh one — avoids duplicating its router-allowlist/routing-layout caches.
     */
    reshieldDelegate: IPoolSessionReshield<TTx, TAddress, TLog>;
    /**
     * Configured yield-share targets. An `outputToken` that resolves to one is deposited as that
     * yield share. May be empty when {@link depositDelegate} serves plain outputs; with neither, no
     * output resolves and every call throws `YieldTargetNotConfigured`.
     */
    yieldDepositTargets: YieldSwapDepositTarget<TTx, TAddress>[];
    /**
     * Plain-output deposit builder. When set, an `outputToken` that is NOT a configured yield-share
     * target is deposited as a plain pool note for the recipient, built with this delegate's
     * `prepareDepositFor` (the same recipient forms and viewing-key resolution as a plain
     * deposit-for). Pass the same instance the pool session's `deposit` delegate is. Omit to keep
     * the session yield-share-only.
     */
    depositDelegate?: {
        prepareDepositFor(params: DepositForParams<TAddress>): Promise<PrepareDepositResult<TTx, TAddress>>;
    };
    /** Compares two `TAddress` values for equality (chain-specific canonicalization rules), used to resolve `outputToken` against `yieldDepositTargets`. */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
}

/** Dependencies for PoolSessionReshieldTransfer construction. */
export interface PoolSessionReshieldTransferDependencies {
    logger?: ILogger;
}

/**
 * Parameters for the reshield-and-transfer deposit leg: sizes and builds the deposit-for proof on
 * behalf of the given recipient (a yield share, or a plain pool note when the session has a
 * `depositDelegate`), generic over the chain's address type `TAddress`.
 *
 * Recipient identity mirrors `DepositForParams`'s union directly (via
 * {@link YieldDepositForRecipient}) rather than Internal Transfer's `RecipientDiscoveryData` —
 * a reshield-and-transfer deposit produces exactly one output note, so there is nothing to key
 * by a `noteSecretsMap`-style Map the way a multi-note transfer needs; a plain field pair is the
 * whole API, matching the same reasoning `PrepareDepositResult.noteSecret` was corrected to
 * (see withdraw-and-swap.md's reshield-and-transfer section).
 */
export type PrepareReshieldTransferDepositParams<TAddress = Address> = YieldDepositForRecipient<TAddress> & {
    /**
     * The desired output token — a configured yield deposit target, or (when the session has a
     * `depositDelegate`) a plain pool asset.
     */
    outputToken: TAddress;
    /** Budget for the deposit (underlying-token units), from `ReshieldEstimate.totalDepositCost`. */
    totalDepositCost: string;
    /**
     * The note value to deposit, from `ReshieldEstimate.noteValue`. Required for a plain output
     * (the deposit is for exactly this value; the vetting fee is charged on top and is already in
     * `totalDepositCost`). Ignored for a yield share, which is sized from `totalDepositCost`.
     */
    noteValue?: Hex;
};

/**
 * Reshield-and-transfer relay parameters — identical to `ReshieldParams` except it never carries
 * a `depositNote`: the sender must never persist a note it doesn't own. Omitting the field from
 * the type (rather than accepting and ignoring it) makes a type-safe caller's mistake impossible,
 * not just discouraged.
 */
export type ReshieldTransferParams<TAddress = Address> = Omit<ReshieldParams<TAddress>, "depositNote">;
