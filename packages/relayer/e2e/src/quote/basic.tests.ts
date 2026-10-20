import request from "supertest";
import { it, expect } from "vitest";
import type { QuoteContext } from "./context";
import { RELAYER_SIGNER_ADDRESS, SEPOLIA_CONTRACTS } from "../proofs/config";

export function basicTests(ctx: QuoteContext) {
    it("returns a withdrawal quote (non-exact)", async () => {
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

        expect(res.body).toHaveProperty("txCost");
        expect(res.body).toHaveProperty("gasPrice");
        expect(res.body).toHaveProperty("feeAmount");
        expect(res.body).toHaveProperty("amountSent");
        expect(res.body).toHaveProperty("amountReceived");
        // Default processor only: the quote takes no processorAddress, so a yield withdrawal
        // relayed via an allowlisted PPRouter binds that router instead of this value.
        expect(res.body.processor.toLowerCase()).toBe(SEPOLIA_CONTRACTS.relayContract.toLowerCase());

        const amountSent = BigInt(res.body.amountSent);
        const amountReceived = BigInt(res.body.amountReceived);
        expect(amountReceived).toBeLessThan(amountSent);
    });

    it("returns a withdrawal quote (exact)", async () => {
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

        expect(res.body).toHaveProperty("txCost");
        expect(res.body).toHaveProperty("gasPrice");
        expect(res.body).toHaveProperty("feeAmount");
        expect(res.body).toHaveProperty("amountSent");
        expect(res.body).toHaveProperty("amountReceived");

        const amountSent = BigInt(res.body.amountSent);
        const amountReceived = BigInt(res.body.amountReceived);
        expect(amountSent).toBeGreaterThan(amountReceived);
    });

    it("returns a signed fee commitment when commit=true", async () => {
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

        expect(res.body).toHaveProperty("feeCommitment");
        expect(res.body.feeCommitment).toHaveProperty("signedRelayerCommitment");
        expect(res.body.feeCommitment).toHaveProperty("data");
        expect(res.body.feeCommitment).toHaveProperty("asset");
        expect(res.body.feeCommitment).toHaveProperty("expiration");
        expect(res.body.feeCommitment).toHaveProperty("feeAmount");
        expect(res.body.feeCommitment).toHaveProperty("recipient");
    });

    it("includes extra gas fields when extraGas=true", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/send`)
            .send({
                asset: ctx.ethAddress,
                amount: ctx.ethAmount,
                extraGas: true,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        expect(res.body).toHaveProperty("extraGasTxCost");
        expect(res.body).toHaveProperty("extraGasFundAmount");
    });

    it("returns a transfer quote", async () => {
        const res = await request(ctx.baseUrl)
            .post(`${ctx.quoteEndpoint}/transfer`)
            .send({
                asset: ctx.ethAddress,
                commit: false,
            })
            .set("Content-Type", "application/json")
            .expect(201);

        expect(res.body).toHaveProperty("txCost");
        expect(res.body).toHaveProperty("gasPrice");
        expect(res.body).toHaveProperty("feeAmount");
        expect(res.body.processor.toLowerCase()).toBe(RELAYER_SIGNER_ADDRESS.toLowerCase());
    });
}
