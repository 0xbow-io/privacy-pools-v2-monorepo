import request from "supertest";
import { it, expect } from "vitest";
import type { RelayContext } from "./context";

export function transferMultiTests(ctx: RelayContext) {
    it("1x3 multi-recipient (2 recipients + 1 change)", async () => {
        const p = ctx.payloads.get("t-multi-1x3")!;
        const res = await request(ctx.baseUrl)
            .post(`${ctx.relayEndpoint}/transfer`)
            .send({
                proof: p.proof,
                inputNullifierNumber: p.inputNullifierNumber,
                outputCommitmentNumber: p.outputCommitmentNumber,
                noteData: p.noteData,
                signedFeeCommitment: p.signedFeeCommitment,
            })
            .set("Content-Type", "application/json");

        if (res.status !== 202) console.error("t-multi-1x3 error:", res.body);
        expect(res.status).toBe(202);
        expect(res.body.txHash).toBeDefined();
        expect(res.body.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }, 30_000);

    it("1x5 multi-recipient (4 recipients + 1 change)", async () => {
        const p = ctx.payloads.get("t-multi-1x5")!;
        const res = await request(ctx.baseUrl)
            .post(`${ctx.relayEndpoint}/transfer`)
            .send({
                proof: p.proof,
                inputNullifierNumber: p.inputNullifierNumber,
                outputCommitmentNumber: p.outputCommitmentNumber,
                noteData: p.noteData,
                signedFeeCommitment: p.signedFeeCommitment,
            })
            .set("Content-Type", "application/json");

        if (res.status !== 202) console.error("t-multi-1x5 error:", res.body);
        expect(res.status).toBe(202);
        expect(res.body.txHash).toBeDefined();
        expect(res.body.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }, 30_000);

    it("2x5 multi-recipient (3 recipients + 2 change)", async () => {
        const p = ctx.payloads.get("t-multi-2x5")!;
        const res = await request(ctx.baseUrl)
            .post(`${ctx.relayEndpoint}/transfer`)
            .send({
                proof: p.proof,
                inputNullifierNumber: p.inputNullifierNumber,
                outputCommitmentNumber: p.outputCommitmentNumber,
                noteData: p.noteData,
                signedFeeCommitment: p.signedFeeCommitment,
            })
            .set("Content-Type", "application/json");

        if (res.status !== 202) console.error("t-multi-2x5 error:", res.body);
        expect(res.status).toBe(202);
        expect(res.body.txHash).toBeDefined();
        expect(res.body.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }, 30_000);
}
