import request from "supertest";
import { describe, it, expect } from "vitest";
import { getDetailsEndpoint } from "../utils";

const BASE_URL = process.env.RELAYER_URL!;

const CHAIN_ID = process.env.TEST_CHAIN_ID!;
const CHAIN_TYPE = process.env.TEST_CHAIN_TYPE!;
const V = process.env.API_VERSION!;

const DETAILS_ENDPOINT_CHAIN = getDetailsEndpoint(V, { type: CHAIN_TYPE, id: CHAIN_ID });

export function detailsNegativeTests() {
    describe("GET /v1/details/:chainType/:chainId", () => {
        it("rejects a nonexistent chain ID", async () => {
            const res = await request(BASE_URL).get(`/${V}/details/evm/999999`);

            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
        });

        it("rejects a non-numeric chain ID", async () => {
            const res = await request(BASE_URL).get("/v1/details/evm/abc");

            expect(res.status).toBe(400);
        });

        it("rejects an invalid chain type", async () => {
            const res = await request(BASE_URL).get(`/${V}/details/invalid-type/${CHAIN_ID}`);

            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
        });
    });

    describe("GET /v1/details/:chainType/:chainId/:asset", () => {
        it("rejects a nonexistent asset address", async () => {
            const res = await request(BASE_URL).get(
                `${DETAILS_ENDPOINT_CHAIN}/0x0000000000000000000000000000000000000000`
            );

            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
        });

        it("rejects an invalid address format", async () => {
            const res = await request(BASE_URL).get(`${DETAILS_ENDPOINT_CHAIN}/not-an-address`);

            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
        });
    });
}
