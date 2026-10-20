import request from "supertest";
import { it, expect } from "vitest";
import type { QuoteContext } from "./context";

export function assetsTests(ctx: QuoteContext) {
    it("returns a quote for each configured asset (ETH, USDC, USDT)", async () => {
        for (const asset of [ctx.ethAddress, ctx.usdcAddress, ctx.usdtAddress]) {
            const res = await request(ctx.baseUrl)
                .post(`${ctx.quoteEndpoint}/send`)
                .send({
                    asset,
                    amount: asset === ctx.ethAddress ? ctx.ethAmount : ctx.stablecoinAmount,
                    extraGas: false,
                    commit: false,
                })
                .set("Content-Type", "application/json")
                .expect(201);

            expect(res.body).toHaveProperty("feeAmount");
            expect(res.body).toHaveProperty("amountSent");
            expect(res.body).toHaveProperty("amountReceived");
        }
    });

    it("assets with feeBPS produce different fee than flat-fee-only assets", async () => {
        const [ethRes, usdcRes] = await Promise.all([
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
                    asset: ctx.usdcAddress,
                    amount: ctx.stablecoinAmount,
                    extraGas: false,
                    commit: false,
                })
                .set("Content-Type", "application/json")
                .expect(201),
        ]);

        expect(ethRes.body.feeAmount).not.toBe(usdcRes.body.feeAmount);
    });

    it("non-native asset quotes (USDC/USDT) involve rate conversion — fee differs from ETH quote", async () => {
        const [ethRes, usdcRes, usdtRes] = await Promise.all([
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
                    asset: ctx.usdcAddress,
                    amount: ctx.stablecoinAmount,
                    extraGas: false,
                    commit: false,
                })
                .set("Content-Type", "application/json")
                .expect(201),
            request(ctx.baseUrl)
                .post(`${ctx.quoteEndpoint}/send`)
                .send({
                    asset: ctx.usdtAddress,
                    amount: ctx.stablecoinAmount,
                    extraGas: false,
                    commit: false,
                })
                .set("Content-Type", "application/json")
                .expect(201),
        ]);

        const ethFee = BigInt(ethRes.body.feeAmount);
        const usdcFee = BigInt(usdcRes.body.feeAmount);
        const usdtFee = BigInt(usdtRes.body.feeAmount);

        expect(usdcFee).not.toBe(ethFee);
        expect(usdtFee).not.toBe(ethFee);
    });
}
