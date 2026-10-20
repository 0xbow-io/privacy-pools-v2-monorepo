import request from "supertest";
import { it, expect } from "vitest";
import type { RelayContext } from "./context";

export function transfer4xMTests(ctx: RelayContext) {
    it("4x4 happy path", async () => {
        const p = ctx.payloads.get("t-4x4")!;
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

        if (res.status !== 202) console.error("t-4x4 error:", res.body);
        expect(res.status).toBe(202);
        expect(res.body.txHash).toBeDefined();
        expect(res.body.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }, 30_000);

    it("4x5 happy path", async () => {
        const p = ctx.payloads.get("t-4x5")!;
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

        if (res.status !== 202) console.error("t-4x5 error:", res.body);
        expect(res.status).toBe(202);
        expect(res.body.txHash).toBeDefined();
        expect(res.body.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }, 30_000);
}
