import request from "supertest";
import { it, expect } from "vitest";
import type { QuoteContext } from "./context";

export function edgeCaseTests(ctx: QuoteContext) {
    it("rejects very small amount (1 wei) — fee exceeds withdrawal amount", async () => {
        await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: "1",
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("handles very large amount", async () => {
        const largeAmount = (10n ** 30n).toString(); // 1 trillion ETH
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: largeAmount,
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        const amountSent = BigInt(res.body.amountSent);
        const amountReceived = BigInt(res.body.amountReceived);
        expect(amountReceived).toBeLessThan(amountSent);
        expect(amountReceived).toBeGreaterThan(0n);
    });

    it("send vs receive quote for same amount — amountSent should differ", async () => {
        const [sendRes, receiveRes] = await Promise.all([
            request(ctx.baseUrl)
                .post(`${ctx.quoteEndpoint}/send`)
                .send({
                    asset: ctx.ethAddress,
                    amount: ctx.ethAmount,
                    extraGas: false,
                    commit: false,
                })
                .set("Content-Type", "application/json")
                .expect(201),
            request(ctx.baseUrl)
                .post(`${ctx.quoteEndpoint}/receive`)
                .send({
                    asset: ctx.ethAddress,
                    amount: ctx.ethAmount,
                    extraGas: false,
                    commit: false,
                })
                .set("Content-Type", "application/json")
                .expect(201),
        ]);

        const sendAmountSent = BigInt(sendRes.body.amountSent);
        const receiveAmountSent = BigInt(receiveRes.body.amountSent);

        // send: amountSent == requested amount
        expect(sendAmountSent).toBe(BigInt(ctx.ethAmount));
        // receive: amountSent > requested amount (includes fee on top)
        expect(receiveAmountSent).toBeGreaterThan(BigInt(ctx.ethAmount));
    });

    it("fee should be higher with extraGas than without", async () => {
        const [withoutRes, withRes] = await Promise.all([
            request(ctx.baseUrl)
                .post(`${ctx.quoteEndpoint}/send`)
                .send({
                    asset: ctx.ethAddress,
                    amount: ctx.ethAmount,
                    extraGas: false,
                    commit: false,
                })
                .set("Content-Type", "application/json")
                .expect(201),
            request(ctx.baseUrl)
                .post(`${ctx.quoteEndpoint}/send`)
                .send({
                    asset: ctx.ethAddress,
                    amount: ctx.ethAmount,
                    extraGas: true,
                    commit: false,
                })
                .set("Content-Type", "application/json")
                .expect(201),
        ]);

        const feeWithout = BigInt(withoutRes.body.feeAmount);
        const feeWith = BigInt(withRes.body.feeAmount);
        expect(feeWith).toBeGreaterThan(feeWithout);
    });

    it("same request twice returns consistent quotes", async () => {
        const payload = {
            asset: ctx.ethAddress,
            amount: ctx.ethAmount,
            extraGas: false,
            commit: false,
        };

        const [res1, res2] = await Promise.all([
            request(ctx.baseUrl)
                .post(`${ctx.quoteEndpoint}/send`)
                .send(payload)
                .set("Content-Type", "application/json")
                .expect(201),
            request(ctx.baseUrl)
                .post(`${ctx.quoteEndpoint}/send`)
                .send(payload)
                .set("Content-Type", "application/json")
                .expect(201),
        ]);

        expect(res1.body.feeAmount).toBe(res2.body.feeAmount);
        expect(res1.body.amountSent).toBe(res2.body.amountSent);
        expect(res1.body.amountReceived).toBe(res2.body.amountReceived);
    });
}
