import { z } from "zod";

import type {
    EventSnapshot,
    EventSnapshotDrops,
    Hex,
    SnapshotArrayDrops,
    SnapshotArrayName,
} from "../internal.js";
import { bigintToHex } from "../internal.js";
import { AddressSchema, DecimalRepresentationToHexSchema, HexSchema } from "./common.js";

/**
 * Wraps a field whose value the SDK's snapshot consumers either never read, or
 * read through a documented fallback: an unusable value degrades to `null`
 * instead of taking the row — and the state that row carries — down with it.
 *
 * The distinction matters most on `transacts.blockNumber`. A spend row is
 * identified by its nullifiers; the block is only the `spentAtBlock` stamp, and
 * `PoolSessionNoteDiscovery.processTransactEvents` has always fallen back to the
 * scan's own `fromBlock` for it (`transact.blockNumber || fromBlockNumber`).
 * Requiring it made that fallback unreachable and turned a cosmetic defect into a
 * lost spend: the note stays ACTIVE, the user is invited to spend it twice, and —
 * because the unreadable field is the very one that locates the gap — coverage
 * collapses and every later sync rescans from the cursor.
 */
function tolerantField<S extends z.ZodType>(schema: S): z.ZodCatch<z.ZodNullable<S>> {
    return schema.nullable().catch(null);
}

const SnapshotDepositSchema = z.object({
    txHash: HexSchema,
    logIndex: z.number().int().nonnegative(),
    depositAddress: AddressSchema,
    outputCommitment: DecimalRepresentationToHexSchema,
    depositedValue: DecimalRepresentationToHexSchema,
    fee: DecimalRepresentationToHexSchema,
    blockNumber: DecimalRepresentationToHexSchema,
    blockTimestamp: z.string(),
    asset: AddressSchema,
});

const SnapshotTransactSchema = z.object({
    txHash: HexSchema,
    logIndex: z.number().int().nonnegative(),
    outputCommitments: z.array(DecimalRepresentationToHexSchema),
    nullifierHashes: z.array(DecimalRepresentationToHexSchema),
    caller: AddressSchema,
    withdrawnValue: DecimalRepresentationToHexSchema,
    encryptedPayload: HexSchema.nullable(),
    blockNumber: DecimalRepresentationToHexSchema,
    blockTimestamp: z.string(),
    asset: AddressSchema,
});

const SnapshotRagequitSchema = z.object({
    txHash: HexSchema,
    logIndex: z.number().int().nonnegative(),
    ragequitter: AddressSchema,
    withdrawnValue: DecimalRepresentationToHexSchema,
    commitment: DecimalRepresentationToHexSchema,
    nullifierHash: DecimalRepresentationToHexSchema,
    label: DecimalRepresentationToHexSchema,
    blockNumber: DecimalRepresentationToHexSchema,
    blockTimestamp: z.string(),
    asset: AddressSchema,
});

/**
 * Row variants used when the strict shape above fails. Whatever a variant does
 * *not* relax is the row's load-bearing set — lose one of those and the row
 * genuinely cannot be applied, so it is dropped and coverage narrows:
 *
 * - `deposits` → `outputCommitment` (the only field the phantom purge reads)
 * - `transacts` → `outputCommitments`, `nullifierHashes` (decide note status)
 * - `ragequits` → `commitment` (identifies the exited note), `blockNumber` (the
 *   block corroboration reads; a row without one can never be confirmed)
 * - `leaves` / `keystoreLeaves` → nothing; no SDK consumer reads them
 *
 * A malformed *element* inside an essential array is still fatal to the row: a
 * missing nullifier is a missed spend, and narrowing coverage so the chain rescan
 * re-reads that range is the only safe answer.
 */
const TolerantSnapshotDepositSchema = SnapshotDepositSchema.extend({
    txHash: tolerantField(HexSchema),
    logIndex: tolerantField(z.number().int().nonnegative()),
    depositAddress: tolerantField(AddressSchema),
    depositedValue: tolerantField(DecimalRepresentationToHexSchema),
    fee: tolerantField(DecimalRepresentationToHexSchema),
    blockNumber: tolerantField(DecimalRepresentationToHexSchema),
    blockTimestamp: tolerantField(z.string()),
    asset: tolerantField(AddressSchema),
});

const TolerantSnapshotTransactSchema = SnapshotTransactSchema.extend({
    txHash: tolerantField(HexSchema),
    logIndex: tolerantField(z.number().int().nonnegative()),
    caller: tolerantField(AddressSchema),
    withdrawnValue: tolerantField(DecimalRepresentationToHexSchema),
    encryptedPayload: tolerantField(HexSchema),
    blockNumber: tolerantField(DecimalRepresentationToHexSchema),
    blockTimestamp: tolerantField(z.string()),
    asset: tolerantField(AddressSchema),
});

const TolerantSnapshotRagequitSchema = SnapshotRagequitSchema.extend({
    txHash: tolerantField(HexSchema),
    logIndex: tolerantField(z.number().int().nonnegative()),
    ragequitter: tolerantField(AddressSchema),
    withdrawnValue: tolerantField(DecimalRepresentationToHexSchema),
    nullifierHash: tolerantField(DecimalRepresentationToHexSchema),
    label: tolerantField(DecimalRepresentationToHexSchema),
    // NOT tolerant, unlike its siblings. `blockNumber` became load-bearing when
    // ragequit rows stopped being applied on trust: corroboration reads the chain
    // AT this block, so a row without one can never be confirmed. Degrading it to
    // null would keep the row, credit the ASP with full coverage, and leave a
    // genuine exit permanently uncorroborable and silently so. Dropping the row
    // instead narrows coverage, which is what makes the chain rescan that range.
    blockNumber: DecimalRepresentationToHexSchema,
    blockTimestamp: tolerantField(z.string()),
    asset: tolerantField(AddressSchema),
});

// `blockTimestamp` is `string` (not Hex) by design — the API mixes ISO-8601
// (keystoreLeaves) and unix-seconds-as-string (leaves), and the SDK type
// already passes it through opaquely.
const SnapshotLeafSchema = z.object({
    leaf: DecimalRepresentationToHexSchema,
    leafIndex: DecimalRepresentationToHexSchema,
    root: DecimalRepresentationToHexSchema,
    blockNumber: DecimalRepresentationToHexSchema,
    blockTimestamp: z.string(),
    eventType: z.string(),
});

const TolerantSnapshotLeafSchema = SnapshotLeafSchema.extend({
    leaf: tolerantField(DecimalRepresentationToHexSchema),
    leafIndex: tolerantField(DecimalRepresentationToHexSchema),
    root: tolerantField(DecimalRepresentationToHexSchema),
    blockNumber: tolerantField(DecimalRepresentationToHexSchema),
    blockTimestamp: tolerantField(z.string()),
    eventType: tolerantField(z.string()),
});

/**
 * Envelope validation for the `/{chainId}/public/event-snapshot/payload`
 * response from an ASP, with the row arrays left unchecked.
 *
 * The header fields stay strict: `snapshotBlockNumber` is the coverage claim
 * every consumer reasons about, so an unusable one must reject the whole
 * payload rather than have callers guess how much of the chain it stands for.
 * The arrays must be present for the same reason — a missing `transacts` reads
 * as "nothing was spent", which is a claim, not a gap. Their *rows* are
 * validated one at a time by {@link parseEventSnapshotTolerant}.
 */
const EventSnapshotEnvelopeSchema = z.object({
    chainId: DecimalRepresentationToHexSchema,
    snapshotBlockNumber: DecimalRepresentationToHexSchema,
    generatedAt: z.string(),
    deposits: z.array(z.unknown()),
    transacts: z.array(z.unknown()),
    ragequits: z.array(z.unknown()),
    leaves: z.array(z.unknown()),
    keystoreLeaves: z.array(z.unknown()),
});

/**
 * One dropped row, reduced to what is safe to log: where it sat and how its
 * shape disagreed with the schema — never the row's own values. Snapshot rows
 * carry commitments, nullifiers, labels and addresses, and SDK logs are the
 * integrator's to ship wherever they like, so no field value ever reaches one.
 * Zod's messages describe the *expected* type or pattern, not the input.
 */
export interface SnapshotRowIssue {
    /**
     * `dropped` — the row was discarded because a field a consumer needs was
     * unusable, and coverage narrows around it. `degraded` — the row was kept with
     * an unusable non-essential field nulled; no state was lost and coverage is
     * unaffected, but the ASP is emitting something the schema did not expect.
     */
    kind: "dropped" | "degraded";
    /** Array the row came from. */
    array: SnapshotArrayName;
    /** Position of the row within that array. */
    index: number;
    /** Dotted path of the offending field, or `"(row)"` for a whole-row failure. */
    field: string;
    /** Zod issue code, e.g. `invalid_type`. */
    code: string;
    /** Zod's shape-only description of what was expected. */
    message: string;
}

/**
 * Cap on reported issues, applied **per array**. The counts in
 * {@link EventSnapshotDrops} stay exact; this only bounds the diagnostic detail,
 * so an ASP returning thousands of malformed rows can't turn one snapshot fetch
 * into an unbounded array. Per-array rather than one shared budget because the
 * arrays are parsed in order: a global cap spent on `deposits` would leave
 * `transacts` — the array note-status coverage depends on — with a nonzero drop
 * count and not one field path to explain it.
 */
const MAX_REPORTED_ROW_ISSUES_PER_ARRAY = 8;

/**
 * Validates an event-snapshot payload row by row: a row that fails validation
 * is dropped and reported instead of rejecting the entire payload.
 *
 * The arrays are independent — an unparseable `keystoreLeaves` row has nothing
 * to do with the `transacts` rows note-status sync reads — so all-or-nothing
 * validation turns any ASP-side schema drift (a field that becomes nullable, a
 * widened enum) into a total snapshot outage for every client at once, and the
 * consumers fall back to scanning chain history instead.
 *
 * Tolerance is not free, and the returned `drops` is what keeps it honest: a
 * dropped row is missing state, so consumers must shrink the block range they
 * treat the snapshot as covering (see
 * `PoolSessionNoteDiscovery.trustedSnapshotBlock`) rather than accept a
 * silently thinner payload. This addresses accidental loss, not a lying ASP —
 * snapshot rows are unauthenticated, so an ASP that wants a row unseen omits it
 * and claims full coverage; see `trustedSnapshotBlock` for what does catch that.
 *
 * `leaves` / `keystoreLeaves` are ordered tree data: dropping a row closes the
 * gap in the returned array, so a consumer that rebuilt a tree by appending them
 * in order would compute a wrong root. Read `leafIndex`, or check `drops`, before
 * treating either array as complete. No SDK consumer reads them today.
 *
 * @param raw - Decoded JSON body of the event-snapshot response.
 * @returns The snapshot (with `drops` set when rows were lost) and up to
 *   {@link MAX_REPORTED_ROW_ISSUES_PER_ARRAY} value-free issue descriptions per
 *   array, for logging.
 * @throws {z.ZodError} When the envelope itself fails validation.
 */
export function parseEventSnapshotTolerant(raw: unknown): {
    snapshot: EventSnapshot;
    issues: SnapshotRowIssue[];
    degraded: Partial<Record<SnapshotArrayName, number>>;
} {
    const envelope = EventSnapshotEnvelopeSchema.parse(raw);
    const issues: SnapshotRowIssue[] = [];

    const deposits = parseSnapshotRows(
        envelope.deposits,
        SnapshotDepositSchema,
        TolerantSnapshotDepositSchema,
        "deposits",
        issues,
    );
    const transacts = parseSnapshotRows(
        envelope.transacts,
        SnapshotTransactSchema,
        TolerantSnapshotTransactSchema,
        "transacts",
        issues,
    );
    const ragequits = parseSnapshotRows(
        envelope.ragequits,
        SnapshotRagequitSchema,
        TolerantSnapshotRagequitSchema,
        "ragequits",
        issues,
    );
    const leaves = parseSnapshotRows(
        envelope.leaves,
        SnapshotLeafSchema,
        TolerantSnapshotLeafSchema,
        "leaves",
        issues,
    );
    const keystoreLeaves = parseSnapshotRows(
        envelope.keystoreLeaves,
        SnapshotLeafSchema,
        TolerantSnapshotLeafSchema,
        "keystoreLeaves",
        issues,
    );

    const drops: EventSnapshotDrops = {};
    if (deposits.drops) drops.deposits = deposits.drops;
    if (transacts.drops) drops.transacts = transacts.drops;
    if (ragequits.drops) drops.ragequits = ragequits.drops;
    if (leaves.drops) drops.leaves = leaves.drops;
    if (keystoreLeaves.drops) drops.keystoreLeaves = keystoreLeaves.drops;

    // Kept out of `snapshot.drops` on purpose: `drops` means "state is missing", and
    // consumers narrow coverage off it. A degraded row lost nothing a consumer reads,
    // so folding it in there would shrink coverage for no reason.
    const degraded: Partial<Record<SnapshotArrayName, number>> = {};
    if (deposits.degraded) degraded.deposits = deposits.degraded;
    if (transacts.degraded) degraded.transacts = transacts.degraded;
    if (ragequits.degraded) degraded.ragequits = ragequits.degraded;
    if (leaves.degraded) degraded.leaves = leaves.degraded;
    if (keystoreLeaves.degraded) degraded.keystoreLeaves = keystoreLeaves.degraded;

    const snapshot: EventSnapshot = {
        chainId: envelope.chainId,
        snapshotBlockNumber: envelope.snapshotBlockNumber,
        generatedAt: envelope.generatedAt,
        deposits: deposits.rows,
        transacts: transacts.rows,
        ragequits: ragequits.rows,
        leaves: leaves.rows,
        keystoreLeaves: keystoreLeaves.rows,
    };
    if (Object.keys(drops).length > 0) snapshot.drops = drops;

    return { snapshot, issues, degraded };
}

/**
 * Validates one snapshot array row by row: strict shape first, then the tolerant
 * variant, and only a row that fails both is dropped. A row salvaged by the second
 * pass is reported as `degraded` and costs no coverage — nothing a consumer reads
 * was lost.
 *
 * `earliestDroppedBlock` is read from the dropped row's own `blockNumber` — the one
 * field needed to bound the resulting gap. A row whose `blockNumber` is itself
 * unusable makes the gap unlocatable, collapsing the array's coverage to `null`;
 * that is now reachable only for a row already unusable on an essential field,
 * since an unusable `blockNumber` alone no longer drops anything.
 */
function parseSnapshotRows<S extends z.ZodType, T extends z.ZodType>(
    rows: unknown[],
    schema: S,
    tolerantSchema: T,
    array: SnapshotArrayName,
    issues: SnapshotRowIssue[],
): { rows: (z.output<S> | z.output<T>)[]; drops?: SnapshotArrayDrops; degraded: number } {
    const kept: (z.output<S> | z.output<T>)[] = [];
    let degraded = 0;
    let dropped = 0;
    let reported = 0;
    let earliest: bigint | null = null;
    let unlocatable = false;

    rows.forEach((row, index) => {
        const parsed = schema.safeParse(row);
        if (parsed.success) {
            kept.push(parsed.data);
            return;
        }

        const salvaged = tolerantSchema.safeParse(row);
        for (const issue of parsed.error.issues) {
            if (reported >= MAX_REPORTED_ROW_ISSUES_PER_ARRAY) break;
            reported += 1;
            issues.push({
                kind: salvaged.success ? "degraded" : "dropped",
                array,
                index,
                field: issue.path.join(".") || "(row)",
                code: issue.code,
                message: issue.message,
            });
        }

        if (salvaged.success) {
            degraded += 1;
            kept.push(salvaged.data);
            return;
        }

        dropped += 1;
        const block = droppedRowBlock(row);
        if (block === null) unlocatable = true;
        else if (earliest === null || block < earliest) earliest = block;
    });

    if (dropped === 0) return { rows: kept, degraded };
    return {
        rows: kept,
        degraded,
        drops: {
            dropped,
            earliestDroppedBlock: unlocatable || earliest === null ? null : bigintToHex(earliest),
        },
    };
}

/** Block height of a dropped row, or `null` when its `blockNumber` is unusable. */
function droppedRowBlock(row: unknown): bigint | null {
    const value = (row as { blockNumber?: unknown } | null)?.blockNumber;
    const parsed = DecimalRepresentationToHexSchema.safeParse(value);
    return parsed.success ? BigInt(parsed.data as Hex) : null;
}
