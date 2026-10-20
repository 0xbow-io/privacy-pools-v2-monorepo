import request from "supertest";
import { it } from "vitest";
import type { QuoteContext } from "./context";

export function negativeTests(ctx: QuoteContext) {
    it("rejects missing asset field", async () => {
        await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                amount: ctx.ethAmount,
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects missing amount field", async () => {
        await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects invalid asset address format", async () => {
        await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: "EeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
                amount: ctx.ethAmount,
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects nonexistent asset (valid address but not configured)", async () => {
        await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeE123",
                amount: ctx.ethAmount,
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects invalid chain type", async () => {
        const invalidEndpoint = ctx.getQuoteEndpoint(ctx.version, "asdfadsf", ctx.chainId);
        await request(ctx.baseUrl)
            .post(`${invalidEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects nonexistent chain ID", async () => {
        const invalidEndpoint = ctx.getQuoteEndpoint(ctx.version, ctx.chainType, "88888");
        await request(ctx.baseUrl)
            .post(`${invalidEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects amount of 0", async () => {
        await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: "0",
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects non-numeric amount string", async () => {
        await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: "false",
                extraGas: false,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects commit: true without recipient", async () => {
        await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                commit: true,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects invalid recipient address format", async () => {
        await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: false,
                commit: true,
                recipient: "sadfasdfasd",
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects extraGas as a non-boolean value", async () => {
        await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: "egg",
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(400);
    });
}
