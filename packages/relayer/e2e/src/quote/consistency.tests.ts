import request from "supertest";
import { it, expect } from "vitest";
import type { QuoteContext } from "./context";

export function consistencyTests(ctx: QuoteContext) {
    it("send quote: amountSent == requested amount, amountReceived < amountSent", async () => {
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

        expect(res.body.amountSent).toBe(ctx.ethAmount);
        expect(BigInt(res.body.amountReceived)).toBeLessThan(BigInt(res.body.amountSent));
    });

    it("receive quote: amountReceived == requested amount, amountSent > amountReceived", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/receive`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        expect(res.body.amountReceived).toBe(ctx.ethAmount);
        expect(BigInt(res.body.amountSent)).toBeGreaterThan(BigInt(res.body.amountReceived));
    });

    it("transfer quote returns no amountSent/amountReceived fields", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/transfer`)
            .send({
                asset: ctx.ethAddress,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        expect(res.body.amountSent).toBeUndefined();
        expect(res.body.amountReceived).toBeUndefined();
    });
}
