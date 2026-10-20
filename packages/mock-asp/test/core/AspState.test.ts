import type { Hex } from "@privacy-pools-v2/core-sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { AspState } from "../../src/internal.js";
import { createReference } from "./helpers.js";

const LABEL_A = "0x1111" as Hex;
const LABEL_B = "0x2222" as Hex;

describe("AspState", () => {
    let reference: Awaited<ReturnType<typeof createReference>>;
    let state: AspState;

    beforeAll(async () => {
        reference = await createReference();
    });

    it("plan an approval whose root matches an independent Merkle computation", async () => {
        state = await AspState.create();
        const plan = await state.planApprove(LABEL_A);

        expect(plan.leaf).toBe(reference.leafFor(LABEL_A));
        expect(plan.leaves).toEqual([reference.leafFor(LABEL_A)]);
        expect(plan.root).toBe(await reference.rootOf([reference.leafFor(LABEL_A)]));
    });

    it("leave state untouched until a plan is committed", async () => {
        state = await AspState.create();
        await state.planApprove(LABEL_A);

        expect(state.leaves).toEqual([]);
        expect(state.publishedRoot).toBe(0n);
    });

    it("commit a published plan and record the new root", async () => {
        state = await AspState.create();
        const plan = await state.planApprove(LABEL_A);
        state.commit(plan, true);

        expect(state.leaves).toEqual([plan.leaf]);
        expect(state.publishedRoot).toBe(plan.root);
        expect(state.hasLeaf(plan.leaf)).toBe(true);
    });

    it("keep the published root behind the leaves when a plan is committed unpublished", async () => {
        state = await AspState.create();
        const first = await state.planApprove(LABEL_A);
        state.commit(first, true);
        const second = await state.planApprove(LABEL_B);
        state.commit(second, false);

        expect(state.leaves).toHaveLength(2);
        expect(state.publishedRoot).toBe(first.root);
    });

    it("not duplicate a leaf when the same label is approved twice", async () => {
        state = await AspState.create();
        state.commit(await state.planApprove(LABEL_A), true);
        const again = await state.planApprove(LABEL_A);

        expect(again.leaves).toHaveLength(1);
    });

    it("report the root before the latest one as the previous published root", async () => {
        state = await AspState.create();
        const first = await state.planApprove(LABEL_A);
        state.commit(first, true);
        state.commit(await state.planApprove(LABEL_B), true);

        expect(state.previousPublishedRoot).toBe(first.root);
    });

    it("plan a revocation without the revoked leaf", async () => {
        state = await AspState.create();
        state.commit(await state.planApprove(LABEL_A), true);
        state.commit(await state.planApprove(LABEL_B), true);
        const plan = await state.planRevoke(LABEL_A);

        expect(plan?.leaves).toEqual([reference.leafFor(LABEL_B)]);
        expect(plan?.root).toBe(await reference.rootOf([reference.leafFor(LABEL_B)]));
    });

    it("return null when revoking a label that was never approved", async () => {
        state = await AspState.create();

        expect(await state.planRevoke(LABEL_A)).toBeNull();
    });

    it("derive pending, approved, and overridden statuses", async () => {
        state = await AspState.create();
        const plan = await state.planApprove(LABEL_A);
        const decimal = BigInt(plan.leaf).toString();

        expect(state.statusOf(decimal)).toEqual({ status: "pending" });
        state.commit(plan, true);
        expect(state.statusOf(decimal)).toEqual({ status: "approved" });
        state.setStatusOverride(plan.leaf, { status: "poi_required" });
        expect(state.statusOf(decimal)).toEqual({ status: "poi_required" });
        state.clearOverrides();
        expect(state.statusOf(decimal)).toEqual({ status: "approved" });
    });

    it("treat an empty set as root zero", async () => {
        state = await AspState.create();
        const plan = await state.planApprove(LABEL_A);
        state.commit(plan, true);
        const revoke = await state.planRevoke(LABEL_A);

        expect(revoke?.root).toBe(0n);
    });
});
