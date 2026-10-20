import { describe, expect, it } from "vitest";

import type { EventSnapshot, Hex } from "../../../src/internal.js";
import { bigintToHex, parseEventSnapshotTolerant } from "../../../src/internal.js";

const decimalToHex = (decimal: string): Hex => bigintToHex(BigInt(decimal));

/** Parse helper for the assertions that only care about the normalized payload. */
const parseSnapshot = (raw: unknown): EventSnapshot => parseEventSnapshotTolerant(raw).snapshot;

const baseDeposit = {
    txHash: "0xa4dc425189ce55badcf529de9fac412ee7e539ed27b9a1c1b8b20fe8b2a8c330",
    logIndex: 549,
    depositAddress: "0xeca5cca87fdf2cb3f3a5d795699ceaa561c4b19d",
    outputCommitment:
        "3145240848825626818468375836268610207015293568903619700382970660053705100345",
    depositedValue: "10000000000000000",
    fee: "0",
    blockNumber: "10758126",
    blockTimestamp: "2026-04-29T21:41:12.000Z",
    asset: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};

const baseTransact = {
    txHash: "0xbd92fd2bc7fc0515b31231b2aee4a10c161f82183cc585e00d72229be37d9628",
    logIndex: 1045,
    outputCommitments: [
        "18974181399266434802938965814722540469172284377421543393251205349473892705749",
    ],
    nullifierHashes: [
        "5434172241102116709945255120486875995653294865156952104789336892594009640421",
    ],
    caller: "0xce551cec9dc9643dc5d7ff8f3015602ef38f2761",
    withdrawnValue: "622650521000",
    encryptedPayload: null,
    blockNumber: "10792213",
    blockTimestamp: "2026-05-05T02:58:12.000Z",
    asset: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};

const baseRagequit = {
    txHash: "0x213c9184ed4f8edd3f254d806a8aa92b3af0384d78e062dcbffa375c543f240c",
    logIndex: 50,
    ragequitter: "0xe907104f230f8acd39bea89e62492101f71b25ee",
    withdrawnValue: "10000000000000000",
    commitment: "1519498112296769774998764556120695598142464845444192242537151971802811295056",
    nullifierHash: "1922627022997197501516740113848708440998869639354493502886434219512693069802",
    label: "8162526392317521015469916848509513646195520937975098466058521452083812492350",
    blockNumber: "10761947",
    blockTimestamp: "2026-04-30T11:47:24.000Z",
    asset: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};

const baseLeaf = {
    leaf: "4489325540010727076799496123608341943383639016474780939469201156448503446052",
    leafIndex: "0",
    root: "4489325540010727076799496123608341943383639016474780939469201156448503446052",
    blockNumber: "10758126",
    blockTimestamp: "1777498872",
    eventType: "inserted",
};

const baseSnapshot = {
    chainId: "11155111",
    snapshotBlockNumber: "10801767",
    generatedAt: "2026-05-06T14:28:58.748Z",
    deposits: [baseDeposit],
    transacts: [baseTransact],
    ragequits: [baseRagequit],
    leaves: [baseLeaf],
    keystoreLeaves: [baseLeaf],
};

describe("parseEventSnapshotTolerant", () => {
    it("parse a representative wire-format snapshot", () => {
        expect(() => parseSnapshot(baseSnapshot)).not.toThrow();
    });

    it("normalize top-level decimal fields to hex", () => {
        const parsed = parseSnapshot(baseSnapshot);
        expect(parsed.chainId).toBe(decimalToHex("11155111"));
        expect(parsed.snapshotBlockNumber).toBe(decimalToHex("10801767"));
        expect(parsed.generatedAt).toBe("2026-05-06T14:28:58.748Z");
    });

    it("normalize deposit hash and value fields to padded hex", () => {
        const parsed = parseSnapshot(baseSnapshot);
        const deposit = parsed.deposits[0]!;
        expect(deposit.outputCommitment).toBe(decimalToHex(baseDeposit.outputCommitment));
        expect(deposit.depositedValue).toBe(decimalToHex(baseDeposit.depositedValue));
        expect(deposit.fee).toBe(decimalToHex("0"));
        expect(deposit.blockNumber).toBe(decimalToHex("10758126"));
    });

    it("pass deposit txHash and addresses through unchanged", () => {
        const parsed = parseSnapshot(baseSnapshot);
        const deposit = parsed.deposits[0]!;
        expect(deposit.txHash).toBe(baseDeposit.txHash);
        expect(deposit.depositAddress).toBe(baseDeposit.depositAddress);
        expect(deposit.asset).toBe(baseDeposit.asset);
    });

    it("normalize transact array fields to padded hex", () => {
        const parsed = parseSnapshot(baseSnapshot);
        const transact = parsed.transacts[0]!;
        expect(transact.outputCommitments).toEqual(
            baseTransact.outputCommitments.map(decimalToHex),
        );
        expect(transact.nullifierHashes).toEqual(baseTransact.nullifierHashes.map(decimalToHex));
        expect(transact.encryptedPayload).toBeNull();
    });

    it("preserve nullable encryptedPayload when populated as hex", () => {
        const withPayload = {
            ...baseSnapshot,
            transacts: [{ ...baseTransact, encryptedPayload: "0xdeadbeef" }],
        };
        const parsed = parseSnapshot(withPayload);
        expect(parsed.transacts[0]!.encryptedPayload).toBe("0xdeadbeef");
    });

    it("normalize ragequit hash fields to padded hex", () => {
        const parsed = parseSnapshot(baseSnapshot);
        const rq = parsed.ragequits[0]!;
        expect(rq.commitment).toBe(decimalToHex(baseRagequit.commitment));
        expect(rq.nullifierHash).toBe(decimalToHex(baseRagequit.nullifierHash));
        expect(rq.label).toBe(decimalToHex(baseRagequit.label));
    });

    it("normalize leaf and keystoreLeaf entries", () => {
        const parsed = parseSnapshot(baseSnapshot);
        const leaf = parsed.leaves[0]!;
        expect(leaf.leaf).toBe(decimalToHex(baseLeaf.leaf));
        expect(leaf.leafIndex).toBe(decimalToHex("0"));
        expect(leaf.root).toBe(decimalToHex(baseLeaf.root));
        expect(parsed.keystoreLeaves[0]!.leaf).toBe(decimalToHex(baseLeaf.leaf));
    });

    it("ignore unknown top-level keys (e.g. privateTransfers)", () => {
        const withExtra = { ...baseSnapshot, privateTransfers: [] };
        expect(() => parseSnapshot(withExtra)).not.toThrow();
    });

    it("reject snapshot missing required arrays", () => {
        const { deposits: _, ...rest } = baseSnapshot;
        void _;
        expect(() => parseSnapshot(rest)).toThrow();
    });

    it("drop a deposit whose outputCommitment is unusable", () => {
        // `outputCommitment` is the only field the phantom purge reads, so losing it
        // makes the row unusable — the one case that costs coverage.
        const broken = {
            ...baseSnapshot,
            deposits: [{ ...baseDeposit, outputCommitment: "not-a-number" }],
        };

        const { snapshot } = parseEventSnapshotTolerant(broken);

        expect(snapshot.deposits).toHaveLength(0);
        // The other arrays are untouched — they had nothing to do with the bad row.
        expect(snapshot.transacts).toHaveLength(1);
        expect(snapshot.ragequits).toHaveLength(1);
        expect(snapshot.drops).toEqual({
            deposits: { dropped: 1, earliestDroppedBlock: decimalToHex("10758126") },
        });
    });

    it("keep a deposit whose only defect is a field no consumer reads", () => {
        const broken = {
            ...baseSnapshot,
            deposits: [{ ...baseDeposit, depositAddress: "not-an-address" }],
        };

        const { snapshot, issues } = parseEventSnapshotTolerant(broken);

        expect(snapshot.deposits).toHaveLength(1);
        expect(snapshot.deposits[0]!.depositAddress).toBeNull();
        expect(snapshot.deposits[0]!.outputCommitment).toBe(
            decimalToHex(baseDeposit.outputCommitment),
        );
        // Nothing was lost, so nothing narrows.
        expect(snapshot.drops).toBeUndefined();
        expect(issues.every((issue) => issue.kind === "degraded")).toBe(true);
    });

    it("report the offending field path without echoing the row's values", () => {
        const broken = {
            ...baseSnapshot,
            deposits: [{ ...baseDeposit, depositAddress: "not-an-address" }],
        };

        const { issues } = parseEventSnapshotTolerant(broken);

        // One bad field can trip several checks (pattern, then bigint-parseability);
        // every issue must point at the row and field that failed.
        expect(issues.length).toBeGreaterThan(0);
        expect(issues.map((issue) => `${issue.array}[${issue.index}].${issue.field}`)).toEqual(
            issues.map(() => "deposits[0].depositAddress"),
        );
        // Zod messages describe the expected shape; no field value may ride along.
        const serialized = JSON.stringify(issues);
        expect(serialized).not.toContain("not-an-address");
        expect(serialized).not.toContain(baseDeposit.outputCommitment);
    });

    it("cap reported issues per array while keeping the dropped count exact", () => {
        const broken = {
            ...baseSnapshot,
            transacts: Array.from({ length: 40 }, (_, index) => ({
                ...baseTransact,
                blockNumber: String(1000 + index),
                nullifierHashes: ["not-a-number"],
            })),
        };

        const { snapshot, issues } = parseEventSnapshotTolerant(broken);

        expect(snapshot.drops?.transacts).toEqual({
            dropped: 40,
            earliestDroppedBlock: decimalToHex("1000"),
        });
        expect(issues).toHaveLength(8);
    });

    it("report field paths for a later array even when an earlier one is full of drops", () => {
        // Arrays are parsed in order, so a shared issue budget spent on `deposits`
        // would leave `transacts` with a drop count and no field path to explain it.
        const broken = {
            ...baseSnapshot,
            deposits: Array.from({ length: 40 }, () => ({
                ...baseDeposit,
                outputCommitment: "not-a-number",
            })),
            transacts: [{ ...baseTransact, nullifierHashes: ["not-a-number"] }],
        };

        const { snapshot, issues } = parseEventSnapshotTolerant(broken);

        expect(snapshot.drops?.deposits?.dropped).toBe(40);
        expect(snapshot.drops?.transacts?.dropped).toBe(1);
        expect(issues.filter((issue) => issue.array === "transacts")).toEqual([
            expect.objectContaining({ index: 0, field: "nullifierHashes.0" }),
        ]);
    });

    it("reject the payload when the envelope block number is unusable", () => {
        const broken = { ...baseSnapshot, snapshotBlockNumber: "not-a-number" };
        expect(() => parseEventSnapshotTolerant(broken)).toThrow();
    });

    it("leave drops unset when every row validates", () => {
        expect(parseSnapshot(baseSnapshot).drops).toBeUndefined();
    });
});
