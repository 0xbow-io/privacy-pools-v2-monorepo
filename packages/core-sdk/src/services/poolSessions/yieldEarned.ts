import type {
    ComputeYieldEarnedArgs,
    EventSnapshot,
    Hex,
    YieldDepositFact,
    YieldEarned,
    YieldEarnedBasisSource,
    YieldEarnedEvents,
    YieldEarnedFlow,
    YieldEarnedFlowKind,
    YieldEarnedNote,
    YieldEarnedUnavailableReason,
    YieldRagequitEvent,
    YieldRateSeries,
    YieldSpendEvent,
} from "../../internal.js";
import { bigintToHex, NoteStatus } from "../../internal.js";

/**
 * Yield earned on one share position. PURE: no I/O, no clock, no randomness; every input is a
 * parameter, so the function is exhaustively testable and can never put a request on the wire.
 *
 * Flow accounting, not lot accounting. Shares are fungible and value is linear in shares, so
 * FIFO versus proportional does not arise:
 *
 *     valueIn   = sum(own deposits: grossUnderlying * noteShares / totalSharesMinted)
 *               + sum(received notes: shares * rate(t_receipt))
 *     valueOut  = sum(exits: sharesOut * rate(t_exit))        // sent, withdrawn, ragequit
 *     valueHeld = sum(held notes: shares * exchangeRateNow)
 *     earned    = valueOut + valueHeld - valueIn
 *
 * Per `Transacted` event in which the wallet's nullifiers appear, `sharesOut` is
 * `sum(inputs) - sum(owned outputs)`, exact in share units, so change notes are internal: no
 * basis, no rate. A received note counts growth SINCE RECEIPT: the sender realised the growth up
 * to the transfer, the recipient earns it after, and the two sum to the vault's growth on those
 * shares with no gap and no double count.
 *
 * Rates. The series is hourly and the true rate at a flow's instant is not observed, so every
 * rate-based figure uses the CONSERVATIVE end of the bracket formed by the observations around
 * that instant (the rate never decreases: an ERC-4626 wrapper over a supply market accrues; the
 * protocol fee only slows it, and the series is checked for monotonicity): inflows take the
 * later observation, outflows the earlier one. Before the first observation the bracket's low
 * end is the wrapper's inception rate (one underlying per whole share); after the last it is
 * the live `exchangeRateNow`. Each bracket's width, times the shares, is the most that flow can
 * understate earned; the sum is `maxUnderstatement`, which the consumer compares against its
 * display precision. No threshold lives here.
 *
 * Fails closed. Any note whose origin, time or exit cannot be established from the inputs makes
 * the result `unavailable`; never a green zero, never a red number.
 *
 * @param args - Notes, feeds, events and the live rate, already fetched.
 * @returns The earned figure, or the reason none can be given.
 */
export function computeYieldEarned(args: ComputeYieldEarnedArgs): YieldEarned {
    const { share, shareDecimals, notes, depositFacts, rateSeries, events, exchangeRateNow, now } =
        args;

    if (rateSeries === null || rateSeries.observations.length === 0) {
        return unavailable("no-rate-series");
    }
    if (depositFacts === null) {
        return unavailable("no-deposit-facts");
    }
    // The snapshot lost spend rows, so "this note is unspent" is not something these
    // events can establish. Valuing it as held would report yield on shares the user may
    // have already sent away.
    if (events.incomplete === true) {
        return unavailable("inconsistent", "the event snapshot dropped spend rows");
    }
    if (exchangeRateNow <= 0n) {
        return unavailable("inconsistent", "exchangeRateNow is not positive");
    }
    // The series must be THIS share's. Nothing downstream would notice otherwise: the
    // arithmetic is happy to price ppUSDC's notes with ppUSDT's rates, and because both
    // wrappers sit near 1.0 with the same decimals the monotonicity and live-rate checks
    // pass about half the time. The natural consumer loop — map over the account's shares
    // calling compute with one feed bundle — is exactly how the wrong series arrives, and
    // a measured case returned 12.42 USDC of "earned" where the truth was 0.30.
    if (rateSeries.share.toLowerCase() !== share.toLowerCase()) {
        return unavailable("inconsistent", `rate series is for ${rateSeries.share}, not ${share}`);
    }
    // Same trap one level down: a deployment whose share decimals disagree with the
    // series' would rescale every flow by 10^delta and still answer ok.
    if (rateSeries.shareDecimals !== shareDecimals) {
        return unavailable(
            "inconsistent",
            `rate series shareDecimals ${rateSeries.shareDecimals} differ from the deployment's ${shareDecimals}`,
        );
    }
    const seriesIssue = rateSeriesIssue(rateSeries, exchangeRateNow, now);
    if (seriesIssue !== null) {
        return unavailable("inconsistent", seriesIssue);
    }
    if (!Number.isInteger(shareDecimals) || shareDecimals < 0) {
        return unavailable("inconsistent", "shareDecimals is not a non-negative integer");
    }

    const shareUnit = 10n ** BigInt(shareDecimals);
    const inceptionRate = 10n ** BigInt(rateSeries.assetDecimals);
    const rateAt = (t: number): RateBracket | null =>
        bracketRate(rateSeries, inceptionRate, t, exchangeRateNow, now);
    const index = indexInputs(share, notes, depositFacts, events);
    if (typeof index === "string") {
        return unavailable("inconsistent", index);
    }

    const flows: YieldEarnedFlow[] = [];
    let valueIn = 0n;
    let sharesIn = 0n;
    let valueOut = 0n;
    let sharesOut = 0n;
    let heldShares = 0n;

    // 1. Origins and inflows: every note is an own deposit, a received note, or change.
    for (const note of notes) {
        const commitment = keyOf(note.commitment);
        const fact = index.factByCommitment.get(commitment);
        if (fact !== undefined) {
            const flow = depositFlow(note, fact);
            if (typeof flow === "string") return unavailable("inconsistent", flow);
            flows.push(flow);
            valueIn += flow.underlying;
            sharesIn += flow.shares;
            continue;
        }
        if (note.originatedHere || index.depositEventSet.has(commitment)) {
            // An own deposit the facts feed has not indexed yet. Never priced off the rate
            // series: with a non-zero vetting fee the two bases differ, and the likely cause is a
            // lagging indexer that will catch up.
            return unavailable("deposit-fact-missing");
        }
        const origin = index.spendByOutput.get(commitment);
        if (origin === undefined) {
            return unavailable("unresolved-origin");
        }
        if (index.ourSpends.has(origin)) {
            continue; // change from our own spend: internal, no basis, no rate
        }
        if (note.createdAt === null) {
            return unavailable("note-timestamp-missing");
        }
        const bracket = rateAt(note.createdAt);
        if (bracket === null) return unavailable("rate-coverage-gap");
        const flow = rateFlow("received", origin.txHash, note.createdAt, note.shares, bracket, {
            shareUnit,
            direction: "in",
        });
        flows.push(flow);
        valueIn += flow.underlying;
        sharesIn += flow.shares;
    }

    // 2. Exits through transacts: shares that left the wallet's hands, exact in share units.
    for (const spend of events.spends) {
        if (!index.ourSpends.has(spend)) continue;
        let inputShares = 0n;
        for (const nullifier of spend.nullifierHashes) {
            const note = index.noteByNullifier.get(keyOf(nullifier));
            if (note !== undefined) inputShares += note.shares;
        }
        let ownedOutputShares = 0n;
        for (const commitment of spend.outputCommitments) {
            const note = index.noteByCommitment.get(keyOf(commitment));
            if (note !== undefined) ownedOutputShares += note.shares;
        }
        const out = inputShares - ownedOutputShares;
        if (out < 0n) {
            return unavailable(
                "inconsistent",
                "a spend produced more owned shares than it consumed",
            );
        }
        if (out === 0n) continue; // a self-transfer or consolidation: nothing left
        // `withdrawn + owned outputs > inputs` is a conservation break the transact circuit
        // forbids, so it is not weak evidence, it is a contradiction. Clamping it to `out`
        // would answer with a number drawn from data that cannot be right.
        if (spend.withdrawnShares !== null && spend.withdrawnShares > out) {
            return unavailable("inconsistent", "a spend withdrew more shares than it consumed");
        }
        if (spend.at === null) return unavailable("exit-timestamp-missing");
        const bracket = rateAt(spend.at);
        if (bracket === null) return unavailable("rate-coverage-gap");
        for (const leg of splitExit(out, spend.withdrawnShares)) {
            const flow = rateFlow(leg.kind, spend.txHash, spend.at, leg.shares, bracket, {
                shareUnit,
                direction: "out",
            });
            flows.push(flow);
            valueOut += flow.underlying;
            sharesOut += flow.shares;
        }
    }

    // 3. Ragequits and what is still held. Events win over the local status: a note the events
    //    consumed is gone whatever the store says; a note the store calls gone but no event shows
    //    is not yet accountable.
    for (const note of notes) {
        if (index.consumedBySpend.has(note)) continue;
        const commitment = keyOf(note.commitment);
        const ragequit = index.ragequitByCommitment.get(commitment);
        if (ragequit !== undefined) {
            if (ragequit.at === null) return unavailable("exit-timestamp-missing");
            const bracket = rateAt(ragequit.at);
            if (bracket === null) return unavailable("rate-coverage-gap");
            const flow = rateFlow("ragequit", ragequit.txHash, ragequit.at, note.shares, bracket, {
                shareUnit,
                direction: "out",
            });
            flows.push(flow);
            valueOut += flow.underlying;
            sharesOut += flow.shares;
            continue;
        }
        if (
            note.status === NoteStatus.SPENT ||
            note.status === NoteStatus.EXITED ||
            note.status === NoteStatus.EXIT_PENDING
        ) {
            return unavailable("exit-timestamp-missing");
        }
        heldShares += note.shares;
    }

    // 4. Shares must conserve: deposits + received = spent out + ragequit + held. Anything else
    //    means a note the inputs do not account for, and no figure can be trusted.
    if (sharesIn !== sharesOut + heldShares) {
        return unavailable(
            "inconsistent",
            `shares do not conserve across ${notes.length} notes and ${flows.length} flows`,
        );
    }

    const heldNow = heldShares * exchangeRateNow;
    const heldUnderlyingNow = heldNow / shareUnit;
    const heldRoundingLoss = heldNow % shareUnit === 0n ? 0n : 1n;

    const earnedTotal = valueOut + heldUnderlyingNow - valueIn;
    const maxUnderstatement =
        flows.reduce((sum, flow) => sum + flow.understatementBound, 0n) + heldRoundingLoss;
    if (earnedTotal < -maxUnderstatement) {
        return unavailable("inconsistent", "earned is negative beyond its own bound");
    }

    // Realised / unrealised split at the position's average basis. Shares are fungible, so the
    // basis that left is the proportional share of everything that entered. The split is an
    // allocation of `earnedTotal`, which is the conservative figure; the two parts always sum
    // to it exactly.
    const basisOut = sharesIn === 0n ? 0n : ceilDiv(valueIn * sharesOut, sharesIn);
    const earnedRealized = valueOut - basisOut;
    const earnedUnrealized = earnedTotal - earnedRealized;

    flows.sort(compareFlows);

    return {
        status: "ok",
        share,
        heldShares,
        heldUnderlyingNow,
        valueIn,
        valueOut,
        earnedTotal,
        earnedRealized,
        earnedUnrealized,
        maxUnderstatement,
        flows,
        asOf: {
            exchangeRateNow,
            latestObservation: rateSeries.observations[rateSeries.observations.length - 1]!,
            now,
        },
    };
}

/**
 * Reduces an ASP event snapshot to the pool events {@link computeYieldEarned} reads. ISO
 * timestamps become unix seconds; a row without a usable one keeps `at: null`, so a spend it
 * describes is still recognised (and reported as `exit-timestamp-missing`) rather than treated
 * as never having happened.
 *
 * @param snapshot - The snapshot (or the three arrays of one) discovery already fetched.
 * @returns The reduced events.
 */
export function yieldEarnedEventsFromSnapshot(
    snapshot: Pick<EventSnapshot, "deposits" | "transacts" | "ragequits"> &
        Partial<Pick<EventSnapshot, "drops">>,
): YieldEarnedEvents {
    // A dropped transact or ragequit row is MISSING state, not absent state. Discovery
    // already narrows its coverage off `drops`; earned has to as well, or a spend the
    // parser lost reads as "still held" and those shares get valued at the live rate.
    // Dropped DEPOSIT rows are harmless here: a missing fact is caught per note as
    // `deposit-fact-missing` rather than being silently priced off the series.
    const lostSpends = (snapshot.drops?.transacts?.dropped ?? 0) > 0;
    const lostRagequits = (snapshot.drops?.ragequits?.dropped ?? 0) > 0;
    return {
        ...(lostSpends || lostRagequits ? { incomplete: true } : {}),
        deposits: snapshot.deposits.map((row) => ({ commitment: row.outputCommitment })),
        spends: snapshot.transacts.map((row) => ({
            txHash: row.txHash,
            at: isoToSeconds(row.blockTimestamp),
            nullifierHashes: row.nullifierHashes,
            outputCommitments: row.outputCommitments,
            withdrawnShares: row.withdrawnValue === null ? null : BigInt(row.withdrawnValue),
        })),
        ragequits: snapshot.ragequits.map((row) => ({
            txHash: row.txHash,
            at: isoToSeconds(row.blockTimestamp),
            commitment: row.commitment,
        })),
    };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The rate at an instant lies in `[floor, ceil]`. */
interface RateBracket { floor: bigint; ceil: bigint; source: YieldEarnedBasisSource }

interface IndexedInputs {
    factByCommitment: Map<Hex, YieldDepositFact>;
    depositEventSet: Set<Hex>;
    spendByOutput: Map<Hex, YieldSpendEvent>;
    ragequitByCommitment: Map<Hex, YieldRagequitEvent>;
    noteByNullifier: Map<Hex, YieldEarnedNote>;
    noteByCommitment: Map<Hex, YieldEarnedNote>;
    /** Spends that consumed at least one of the wallet's notes. */
    ourSpends: Set<YieldSpendEvent>;
    /** Notes one of `ourSpends` consumed. */
    consumedBySpend: Set<YieldEarnedNote>;
}

const FLOW_ORDER: Record<YieldEarnedFlowKind, number> = {
    deposit: 0,
    received: 1,
    withdrawn: 2,
    sent: 3,
    spent: 4,
    ragequit: 5,
};

function unavailable(reason: YieldEarnedUnavailableReason, detail?: string): YieldEarned {
    return detail === undefined
        ? { status: "unavailable", reason }
        : { status: "unavailable", reason, detail };
}

/** Canonical key for a commitment or nullifier whatever its hex spelling (padded, decimal-derived, short). */
function keyOf(value: Hex): Hex {
    return bigintToHex(BigInt(value));
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
    return (numerator + denominator - 1n) / denominator;
}

function isoToSeconds(value: string | null): number | null {
    if (value === null) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Why the series cannot be used, or `null` when it is ascending, monotone and below the live rate. */
function rateSeriesIssue(
    series: YieldRateSeries,
    exchangeRateNow: bigint,
    now: number,
): string | null {
    if (!Number.isInteger(series.assetDecimals) || series.assetDecimals < 0) {
        return "rate series assetDecimals is not a non-negative integer";
    }
    const inceptionRate = 10n ** BigInt(series.assetDecimals);
    let previous = series.observations[0]!;
    if (previous.exchangeRate < inceptionRate) {
        return "rate series starts below the inception rate";
    }
    for (const observation of series.observations.slice(1)) {
        if (observation.timestamp < previous.timestamp) return "rate series is not ascending";
        if (observation.exchangeRate < previous.exchangeRate) {
            return "rate series is not monotone";
        }
        previous = observation;
    }
    // Compare the live rate only with observations at or before `now`: the client clock can
    // trail the ASP by minutes, and an observation stamped a little after `now` may legitimately
    // read higher than a chain read made "now".
    const latestBeforeNow = [...series.observations].reverse().find((o) => o.timestamp <= now);
    if (latestBeforeNow !== undefined && exchangeRateNow < latestBeforeNow.exchangeRate) {
        return "exchangeRateNow is below the latest observation at or before now";
    }
    return null;
}

/**
 * Brackets the rate at `t`: the last observation at or before `t` and the first at or after it.
 * Before the series the low end is the inception rate; after it, the live rate. `null` when `t`
 * is after `now`, which nothing can bracket.
 */
function bracketRate(
    series: YieldRateSeries,
    inceptionRate: bigint,
    t: number,
    exchangeRateNow: bigint,
    now: number,
): RateBracket | null {
    if (t > now) return null;
    const observations = series.observations;
    // First observation with timestamp >= t.
    let lo = 0;
    let hi = observations.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (observations[mid]!.timestamp < t) lo = mid + 1;
        else hi = mid;
    }
    const ceilObservation = observations[lo];
    const floorObservation =
        ceilObservation !== undefined && ceilObservation.timestamp === t
            ? ceilObservation
            : observations[lo - 1];

    if (floorObservation === undefined) {
        return {
            floor: inceptionRate,
            ceil: ceilObservation!.exchangeRate,
            source: "rate-series-clamped",
        };
    }
    if (ceilObservation === undefined) {
        return {
            floor: floorObservation.exchangeRate,
            ceil: exchangeRateNow,
            source: "exchange-rate-now",
        };
    }
    return {
        floor: floorObservation.exchangeRate,
        ceil: ceilObservation.exchangeRate,
        source: "rate-series",
    };
}

/** Indexes notes, facts and events by canonical key. Returns a message when the notes contradict each other. */
function indexInputs(
    share: Hex,
    notes: readonly YieldEarnedNote[],
    depositFacts: readonly YieldDepositFact[],
    events: YieldEarnedEvents,
): IndexedInputs | string {
    const shareKey = share.toLowerCase();
    const factByCommitment = new Map<Hex, YieldDepositFact>();
    for (const fact of depositFacts) {
        if (fact.asset.toLowerCase() !== shareKey) continue;
        factByCommitment.set(keyOf(fact.outputCommitment), fact);
    }
    const depositEventSet = new Set<Hex>(events.deposits.map((d) => keyOf(d.commitment)));

    const spendByNullifier = new Map<Hex, YieldSpendEvent>();
    const spendByOutput = new Map<Hex, YieldSpendEvent>();
    for (const spend of events.spends) {
        for (const nullifier of spend.nullifierHashes)
            spendByNullifier.set(keyOf(nullifier), spend);
        for (const commitment of spend.outputCommitments) {
            spendByOutput.set(keyOf(commitment), spend);
        }
    }
    const ragequitByCommitment = new Map<Hex, YieldRagequitEvent>();
    for (const ragequit of events.ragequits) {
        ragequitByCommitment.set(keyOf(ragequit.commitment), ragequit);
    }

    const noteByNullifier = new Map<Hex, YieldEarnedNote>();
    const noteByCommitment = new Map<Hex, YieldEarnedNote>();
    const ourSpends = new Set<YieldSpendEvent>();
    const consumedBySpend = new Set<YieldEarnedNote>();
    for (const note of notes) {
        if (note.shares < 0n) return "a note has negative shares";
        const commitment = keyOf(note.commitment);
        if (noteByCommitment.has(commitment)) return "two notes share a commitment";
        noteByCommitment.set(commitment, note);
        noteByNullifier.set(keyOf(note.nullifier), note);
        const spend = spendByNullifier.get(keyOf(note.nullifier));
        if (spend !== undefined) {
            ourSpends.add(spend);
            consumedBySpend.add(note);
        }
    }

    return {
        factByCommitment,
        depositEventSet,
        spendByOutput,
        ragequitByCommitment,
        noteByNullifier,
        noteByCommitment,
        ourSpends,
        consumedBySpend,
    };
}

/** An own deposit at its exact fact basis, rounded up (a higher basis can only understate earned). */
/**
 * The zap's supply rounding buffer, in underlying units.
 *
 * `PPRouter.depositExactShares` buys through `PPYieldTokenZap.quoteBuy`, which returns
 * `previewMint(total) + _SUPPLY_ROUNDING_BUFFER` so the supply cannot come up short, and the
 * ASP stores that `_underlyingIn` verbatim as `gross_underlying`. So a deposit fact's basis
 * is systematically a couple of units ABOVE what the vault itself thinks those shares are
 * worth, and a position valued moments after it mines shows a small negative "earned".
 *
 * `valueIn` keeps the real figure — the user did pay it — but the bound has to admit it, or
 * honest data reads as corruption: before this, a fresh deposit returned `inconsistent`
 * until the position had earned about three units of yield, which is seconds for a $50
 * deposit and hours for a sub-dollar one.
 */
const DEPOSIT_BASIS_SLACK = 2n;

function depositFlow(note: YieldEarnedNote, fact: YieldDepositFact): YieldEarnedFlow | string {
    if (fact.noteShares !== note.shares) return "a deposit fact's shares differ from the note";
    if (fact.totalSharesMinted <= 0n || fact.noteShares > fact.totalSharesMinted) {
        return "a deposit fact's share split is malformed";
    }
    const numerator = fact.grossUnderlying * fact.noteShares;
    const underlying = ceilDiv(numerator, fact.totalSharesMinted);
    return {
        kind: "deposit",
        txHash: fact.txHash,
        at: fact.blockTimestamp,
        shares: note.shares,
        underlying,
        basisSource: "deposit-facts",
        understatementBound:
            (numerator % fact.totalSharesMinted === 0n ? 0n : 1n) + DEPOSIT_BASIS_SLACK,
    };
}

/**
 * A rate-priced flow. Inflows are valued at the bracket's high end rounded up, outflows at its
 * low end rounded down, so the result never overstates earned. The bound is the bracket's width
 * on these shares plus one unit when the division was inexact.
 */
function rateFlow(
    kind: YieldEarnedFlowKind,
    txHash: YieldEarnedFlow["txHash"],
    at: number,
    shares: bigint,
    bracket: RateBracket,
    opts: { shareUnit: bigint; direction: "in" | "out" },
): YieldEarnedFlow {
    const rate = opts.direction === "in" ? bracket.ceil : bracket.floor;
    const scaled = shares * rate;
    const exact = scaled % opts.shareUnit === 0n;
    const underlying =
        opts.direction === "in" ? ceilDiv(scaled, opts.shareUnit) : scaled / opts.shareUnit;
    const width = ceilDiv(shares * (bracket.ceil - bracket.floor), opts.shareUnit);
    return {
        kind,
        txHash,
        at,
        shares,
        underlying,
        basisSource: bracket.source,
        understatementBound: width + (exact ? 0n : 1n),
    };
}

/**
 * Splits the shares that left in one transact into what went through the processor
 * (`withdrawn`) and what did not (`sent`). Without a `withdrawnValue` the split is unknown and
 * the whole amount is `spent`; the value that left does not depend on the split.
 */
function splitExit(
    out: bigint,
    withdrawnShares: bigint | null,
): { kind: YieldEarnedFlowKind; shares: bigint }[] {
    if (withdrawnShares === null) return [{ kind: "spent", shares: out }];
    const withdrawn = withdrawnShares < out ? withdrawnShares : out;
    const legs: { kind: YieldEarnedFlowKind; shares: bigint }[] = [];
    if (withdrawn > 0n) legs.push({ kind: "withdrawn", shares: withdrawn });
    if (out - withdrawn > 0n) legs.push({ kind: "sent", shares: out - withdrawn });
    return legs;
}

function compareFlows(a: YieldEarnedFlow, b: YieldEarnedFlow): number {
    if (a.at !== b.at) return a.at - b.at;
    if (FLOW_ORDER[a.kind] !== FLOW_ORDER[b.kind]) return FLOW_ORDER[a.kind] - FLOW_ORDER[b.kind];
    return a.shares < b.shares ? -1 : a.shares > b.shares ? 1 : 0;
}
