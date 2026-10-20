import type { Address } from "./Address.js";
import type { Hash } from "./Hash.js";
import type { Hex } from "./Hex.js";
import type { NoteStatus } from "./NoteStatus.js";

// ---------------------------------------------------------------------------
// Public ASP feeds (caller-independent bulk data)
// ---------------------------------------------------------------------------

/**
 * One observation of a yield share's assets-per-share, from the ASP's
 * `GET /:chainId/public/ppusdc-rate-history?asset=<share>` feed.
 */
export interface YieldRateObservation {
    /** Unix seconds of the observation (`observationTimestamp`). */
    timestamp: number;
    /**
     * `PPYieldToken.exchangeRate()` at that block: underlying per `10**shareDecimals` shares,
     * scaled to `assetDecimals`. Net of the protocol yield fee.
     */
    exchangeRate: bigint;
    /** Block the rate was read at (`observationBlock`). */
    block: bigint;
}

/** The whole rate history of one share, every page drained, ascending by time. */
export interface YieldRateSeries {
    /** The share token the observations were read from (lowercased on the wire). */
    share: Address;
    /** Decimals of the share token (18 for every current wrapper). */
    shareDecimals: number;
    /** Decimals of the underlying the rate is scaled to (USDC = 6, ETH = 18). */
    assetDecimals: number;
    /** Observations in ascending `timestamp` order. */
    observations: readonly YieldRateObservation[];
}

/**
 * One yield deposit as the ASP indexed it (`GET /:chainId/public/yield-deposits`): the
 * `PPRouter.Deposited` correlated with the same-tx `PoolVault.Deposited`, keyed by the output
 * commitment. The exact cost basis of an own deposit, in the depositor's underlying.
 */
export interface YieldDepositFact {
    /** Commitment of the deposited note. Canonical padded hex (the wire carries decimal). */
    outputCommitment: Hex;
    /** The share token minted (lowercased on the wire). */
    asset: Address;
    /** Transaction hash of the deposit. */
    txHash: Hash;
    /** Underlying the depositor paid, raw units of the underlying. */
    grossUnderlying: bigint;
    /** Shares credited to the note, raw share units. */
    noteShares: bigint;
    /** Every share the deposit minted: note + vetting fee, raw share units. */
    totalSharesMinted: bigint;
    /** Shares that went to the vetting fee (`totalSharesMinted - noteShares`). */
    vettingFeeShares: bigint;
    /** Unix seconds of the deposit block. */
    blockTimestamp: number;
}

// ---------------------------------------------------------------------------
// Pool events (the snapshot discovery already fetches, reduced to what earned needs)
// ---------------------------------------------------------------------------

/** A `Deposited` event, reduced to its commitment: the mark of an OWN deposit's origin. */
export interface YieldDepositEvent {
    /** Commitment of the deposited note. */
    commitment: Hex;
}

/** A `Transacted` event: nullifiers consumed, commitments produced, value withdrawn. */
export interface YieldSpendEvent {
    /** Transaction hash, when the source carried one. */
    txHash: Hash | null;
    /** Unix seconds of the block, or `null` when the source carried no usable timestamp. */
    at: number | null;
    /** Nullifier hashes consumed. */
    nullifierHashes: readonly Hex[];
    /** Output commitments produced. */
    outputCommitments: readonly Hex[];
    /**
     * Shares that left the pool through the processor (`withdrawnValue`), or `null` when the
     * source carried none. Splits a spend into its `withdrawn` and `sent` legs; the total that
     * left the user's hands does not depend on it.
     */
    withdrawnShares: bigint | null;
}

/** A `Ragequit` event: one commitment exited whole. */
export interface YieldRagequitEvent {
    /** Transaction hash, when the source carried one. */
    txHash: Hash | null;
    /** Unix seconds of the block, or `null` when the source carried no usable timestamp. */
    at: number | null;
    /** The exited commitment. */
    commitment: Hex;
}

/** Every pool event the computation reads, from the ASP event snapshot (or an equivalent bulk source). */
export interface YieldEarnedEvents {
    deposits: readonly YieldDepositEvent[];
    spends: readonly YieldSpendEvent[];
    ragequits: readonly YieldRagequitEvent[];
    /**
     * True when the snapshot these came from dropped rows from `transacts` or `ragequits`
     * (`EventSnapshot.drops`). A dropped spend is missing state, not absent state: without
     * this the computation would see the note as never spent and value those shares at the
     * live rate, reporting yield on a position the user no longer holds. Set, it makes the
     * whole answer `unavailable` instead.
     */
    incomplete?: boolean;
}

// ---------------------------------------------------------------------------
// Pure computation input
// ---------------------------------------------------------------------------

/** An own note of the share, reduced to what the computation reads. Built by the session glue. */
export interface YieldEarnedNote {
    /** Commitment (any hex spelling; keys are normalised inside). */
    commitment: Hex;
    /** `Poseidon(privateNullifyingKey, commitment)`: how the note is found among spends. */
    nullifier: Hex;
    /** Note value, raw share units. */
    shares: bigint;
    /** Local lifecycle status. Events win over it where the two disagree. */
    status: NoteStatus;
    /**
     * Unix seconds the commitment was inserted (`Note.createdAtBlock`), or `null` when the stored
     * value cannot be a timestamp (a legacy export carrying a block number, see `Note`).
     */
    createdAt: number | null;
    /** True when this wallet originated the note's lineage (`depositSecret` present). */
    originatedHere: boolean;
}

/** Input of {@link computeYieldEarned}. Everything is already fetched; the function does no I/O. */
export interface ComputeYieldEarnedArgs {
    /** The share token being valued. */
    share: Address;
    /** Decimals of the share token. Scales `shares * rate` down to underlying units. */
    shareDecimals: number;
    /** The wallet's own notes of `share`, every status. */
    notes: readonly YieldEarnedNote[];
    /** Every deposit fact of the chain, or `null` when the feed is not served. */
    depositFacts: readonly YieldDepositFact[] | null;
    /** The share's full rate history, or `null` when the feed is not served. */
    rateSeries: YieldRateSeries | null;
    /** Pool events (see {@link yieldEarnedEventsFromSnapshot}). */
    events: YieldEarnedEvents;
    /** `PPYieldToken.exchangeRate()` read now, with no argument. */
    exchangeRateNow: bigint;
    /** Unix seconds "now": the time `exchangeRateNow` stands for. */
    now: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** What moved value into or out of the position. Change notes are internal and never appear. */
export type YieldEarnedFlowKind =
    /** An own deposit; basis from the deposit fact. */
    | "deposit"
    /** A note another wallet sent us; basis at the rate when it arrived. */
    | "received"
    /** Shares that left in a transact and did not go through the processor: transfers out and in-pool fee notes. */
    | "sent"
    /** Shares that left through the processor (`withdrawnValue`): withdrawals, including any relayer fee leg. */
    | "withdrawn"
    /** Shares that left in a transact whose `withdrawnValue` the source did not carry: `sent` or `withdrawn`, unknown which. */
    | "spent"
    /** A ragequit exit. */
    | "ragequit";

/** Where a flow's underlying figure came from. */
export type YieldEarnedBasisSource =
    /** Exact: `grossUnderlying * noteShares / totalSharesMinted` from the deposit fact. */
    | "deposit-facts"
    /** Bracketed by two observations of the rate series around the flow's time. */
    | "rate-series"
    /** Before the first observation: the series was clamped, see `maxUnderstatement`. */
    | "rate-series-clamped"
    /** After the last observation: bracketed by the live `exchangeRateNow`. */
    | "exchange-rate-now";

/** One value movement, in share units and in underlying at the time it happened. */
export interface YieldEarnedFlow {
    kind: YieldEarnedFlowKind;
    /** Transaction hash, when known. */
    txHash: Hash | null;
    /** Unix seconds of the movement. */
    at: number;
    /** Shares moved, raw share units. */
    shares: bigint;
    /**
     * Underlying value at `at`, raw underlying units. Rounded so `earnedTotal` is never
     * overstated: inflows round up, outflows round down.
     */
    underlying: bigint;
    basisSource: YieldEarnedBasisSource;
    /**
     * The most this flow's rounding and rate bracketing can UNDERSTATE earned, raw underlying
     * units. Zero for a deposit-fact basis.
     */
    understatementBound: bigint;
}

/** Why no figure is returned. Every reason is fail-closed: no number is better than a wrong one. */
export type YieldEarnedUnavailableReason =
    /** The rate feed is not served for this share (404) or came back empty. */
    | "no-rate-series"
    /** The deposit-facts feed is not served on this chain (404). */
    | "no-deposit-facts"
    /**
     * An own deposit has no fact. Never fall back to the rate series for it: a lagging indexer is
     * the likely cause, and with a non-zero vetting fee the two bases differ.
     */
    | "deposit-fact-missing"
    /** A note is neither a known deposit nor the output of any known transact. */
    | "unresolved-origin"
    /** A received note needs its arrival time and `createdAtBlock` does not hold a timestamp. */
    | "note-timestamp-missing"
    /** A spent or exited note has no dated event yet. `spentAtBlock` is not used: it is a cursor fallback. */
    | "exit-timestamp-missing"
    /** A flow is dated after `now`, so no rate can bracket it. */
    | "rate-coverage-gap"
    /** The inputs contradict each other: shares do not conserve, the rate series is not monotone, or the result is negative beyond its own bound. */
    | "inconsistent";

/** The result of {@link computeYieldEarned}. */
export type YieldEarned =
    | {
          status: "ok";
          /** The share token valued. */
          share: Address;
          /** Shares the wallet still holds in the pool (no spend or ragequit event consumed them). */
          heldShares: bigint;
          /** `heldShares` at `exchangeRateNow`, raw underlying units, rounded down. */
          heldUnderlyingNow: bigint;
          /** Underlying that entered: own deposits at their fact basis, received notes at the rate on arrival. */
          valueIn: bigint;
          /** Underlying that left: sends, withdrawals and ragequits at the rate when they happened. */
          valueOut: bigint;
          /** `valueOut + heldUnderlyingNow - valueIn`. May be slightly negative within `maxUnderstatement`. */
          earnedTotal: bigint;
          /** The part of `earnedTotal` on shares that left, at the position's average basis. */
          earnedRealized: bigint;
          /** The part of `earnedTotal` on shares still held; `earnedRealized + earnedUnrealized === earnedTotal`. */
          earnedUnrealized: bigint;
          /**
           * The most `earnedTotal` can understate the true figure, raw underlying units: the sum
           * of every flow's bracketing width plus one unit of rounding per figure. Show the
           * figure only when this rounds to zero at the display precision; the SDK sets no
           * threshold.
           */
          maxUnderstatement: bigint;
          /** Every value movement, ascending by time. */
          flows: readonly YieldEarnedFlow[];
          asOf: {
              exchangeRateNow: bigint;
              /** Newest observation of the series. */
              latestObservation: YieldRateObservation;
              now: number;
          };
      }
    | {
          status: "unavailable";
          reason: YieldEarnedUnavailableReason;
          /** Counts and kinds only. Never a commitment, nullifier, label or amount. */
          detail?: string;
      };

// ---------------------------------------------------------------------------
// Session glue
// ---------------------------------------------------------------------------

/** The already-fetched feed data {@link IPoolSessionYieldEarned.compute} works from. */
export interface YieldEarnedInput {
    /** From {@link IYieldFeedProvider.getYieldDepositFacts}; `null` when the feed answered 404. */
    depositFacts: readonly YieldDepositFact[] | null;
    /** From {@link IYieldFeedProvider.getYieldRateSeries}; `null` when the feed answered 404. */
    rateSeries: YieldRateSeries | null;
    /** From {@link yieldEarnedEventsFromSnapshot} over the event snapshot discovery already fetched. */
    events: YieldEarnedEvents;
    /** Unix seconds; defaults to the wall clock. */
    now?: number;
}
