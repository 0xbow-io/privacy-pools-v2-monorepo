import request from "supertest";
import { describe, it, expect } from "vitest";
import { getDetailsEndpoint } from "../utils";
import { detailsNegativeTests } from "./negative.tests";

const BASE_URL = process.env.RELAYER_URL!;

const CHAIN_ID = process.env.TEST_CHAIN_ID!;
const CHAIN_TYPE = process.env.TEST_CHAIN_TYPE!;
const V = process.env.API_VERSION!;

const DETAILS_ENDPOINT = getDetailsEndpoint(V);
const DETAILS_ENDPOINT_CHAIN = getDetailsEndpoint(V, { type: CHAIN_TYPE, id: CHAIN_ID });

export function detailsTests() {
    describe("GET /v1/details", () => {
        it("returns all supported chains", async () => {
            const res = await request(BASE_URL).get(DETAILS_ENDPOINT).expect(200);

            expect(res.body).toHaveProperty("chains");
            expect(res.body.chains).toBeInstanceOf(Array);
            expect(res.body.chains.length).toBeGreaterThan(0);

            const chain = res.body.chains[0];
            expect(chain).toHaveProperty("id");
            expect(chain).toHaveProperty("name");
            expect(chain).toHaveProperty("type");
            expect(chain).toHaveProperty("assets");
            expect(chain.assets).toBeInstanceOf(Array);
            expect(chain.assets.length).toBeGreaterThan(0);

            const asset = chain.assets[0];
            expect(asset).toHaveProperty("address");
            expect(asset).toHaveProperty("ticker");
            expect(asset).toHaveProperty("fixedFeeAmount");
        });
    });

    describe("GET /v1/details/evm/:chainId", () => {
        it("returns chain details for a valid chain", async () => {
            const res = await request(BASE_URL).get(DETAILS_ENDPOINT_CHAIN).expect(200);

            expect(res.body).toHaveProperty("id");
            expect(res.body).toHaveProperty("name");
            expect(res.body).toHaveProperty("type", "evm");
            expect(res.body).toHaveProperty("assets");
            expect(res.body.assets).toBeInstanceOf(Array);
            expect(res.body.assets.length).toBeGreaterThan(0);

            for (const asset of res.body.assets) {
                expect(asset).toHaveProperty("address");
                expect(asset).toHaveProperty("ticker");
                expect(asset).toHaveProperty("fixedFeeAmount");
            }
        });
    });

    describe("GET /v1/details/evm/:chainId/:asset", () => {
        it("returns asset details for a valid asset", async () => {
            // First fetch the chain to get a valid asset address
            const chainRes = await request(BASE_URL).get(DETAILS_ENDPOINT_CHAIN).expect(200);

            const assetAddress = chainRes.body.assets[0].address;

            const res = await request(BASE_URL).get(`${DETAILS_ENDPOINT_CHAIN}/${assetAddress}`).expect(200);

            expect(res.body).toHaveProperty("address", assetAddress);
            expect(res.body).toHaveProperty("ticker");
            expect(typeof res.body.ticker).toBe("string");
            expect(res.body).toHaveProperty("fixedFeeAmount");
        });
    });

    describe("negative cases", detailsNegativeTests);
}
