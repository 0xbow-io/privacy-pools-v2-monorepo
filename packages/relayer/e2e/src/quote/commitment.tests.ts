import request from "supertest";
import { it, expect } from "vitest";
import type { QuoteContext } from "./context";

export function commitmentTests(ctx: QuoteContext) {
    it("commitment has valid expiration in the future", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                recipient: ctx.recipient,
                commit: true,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        const expiration = res.body.feeCommitment.expiration;
        expect(expiration).toBeGreaterThan(Date.now());
    });

    it("commitment asset matches the requested asset", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                recipient: ctx.recipient,
                commit: true,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        expect(res.body.feeCommitment.asset.toLowerCase()).toBe(ctx.ethAddress.toLowerCase());
    });

    it("commitment recipient matches the requested recipient", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                recipient: ctx.recipient,
                commit: true,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        expect(res.body.feeCommitment.recipient.toLowerCase()).toBe(ctx.recipient.toLowerCase());
    });

    it("commitment amountSent and amountReceived are consistent with the quote response", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                recipient: ctx.recipient,
                commit: true,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        const { feeCommitment, amountSent, amountReceived, feeAmount } = res.body;
        expect(feeCommitment.amountSent).toBe(amountSent);
        expect(feeCommitment.amountReceived).toBe(amountReceived);
        expect(BigInt(amountSent) - BigInt(amountReceived)).toBe(BigInt(feeAmount));
    });

    it("commitment signedRelayerCommitment is a valid hex string", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                recipient: ctx.recipient,
                commit: true,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        const sig = res.body.feeCommitment.signedRelayerCommitment;
        expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
    });

    it("transfer quote with commit: true returns a signed commitment", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/transfer`)
            .send({
                asset: ctx.ethAddress,
                commit: true,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        expect(res.body).toHaveProperty("feeCommitment");
        expect(res.body.feeCommitment).toHaveProperty("signedRelayerCommitment");
        expect(res.body.feeCommitment).toHaveProperty("data");
        expect(res.body.feeCommitment).toHaveProperty("asset");
        expect(res.body.feeCommitment).toHaveProperty("expiration");
    });

    it("transfer quote with commit: false has no feeCommitment", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/transfer`)
            .send({
                asset: ctx.ethAddress,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        expect(res.body.feeCommitment).toBeUndefined();
    });

    it("withdrawal quote with commit: false has no feeCommitment", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        expect(res.body.feeCommitment).toBeUndefined();
    });
}
