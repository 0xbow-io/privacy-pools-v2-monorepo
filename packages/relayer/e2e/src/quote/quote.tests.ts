import { describe } from "vitest";
import { getQuoteEndpoint } from "../utils";
import { WITHDRAWAL_RECIPIENTS } from "../test-addresses";
import { basicTests } from "./basic.tests";
import { assetsTests } from "./assets.tests";
import { commitmentTests } from "./commitment.tests";
import { consistencyTests } from "./consistency.tests";
import { negativeTests } from "./negative.tests";
import { edgeCaseTests } from "./edge-cases.tests";
import type { QuoteContext } from "./context";

const BASE_URL = process.env.RELAYER_URL!;
const CHAIN_ID = process.env.TEST_CHAIN_ID!;
const CHAIN_TYPE = process.env.TEST_CHAIN_TYPE!;
const V = process.env.API_VERSION!;

const ctx: QuoteContext = {
    baseUrl: BASE_URL,
    quoteEndpoint: getQuoteEndpoint(V, CHAIN_TYPE, CHAIN_ID),
    getQuoteEndpoint,
    version: V,
    chainType: CHAIN_TYPE,
    chainId: CHAIN_ID,
    ethAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    usdtAddress: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0",
    ethAmount: "1000000000000000000", // 1 ETH
    stablecoinAmount: "1000000000", // 1000 USDC/USDT (6 decimals)
    recipient: WITHDRAWAL_RECIPIENTS[0],
};

export function quoteTests() {
    describe("basic", () => basicTests(ctx));
    describe("per-asset", () => assetsTests(ctx));
    describe("fee commitment", () => commitmentTests(ctx));
    describe("cross-endpoint consistency", () => consistencyTests(ctx));
    describe("negative cases", () => negativeTests(ctx));
    describe("edge cases", () => edgeCaseTests(ctx));
}
