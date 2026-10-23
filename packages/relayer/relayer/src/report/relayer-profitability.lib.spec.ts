import { nativeUsd, NATIVE_PRICE_TTL_MS, type ProfitabilityChainConfig } from "./relayer-profitability.lib";

// Mutable feed answer, read by the mocked viem client below. 8 decimals, like Chainlink's ETH/USD.
let feedUsd = 2_000;
const readContract = jest.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "latestRoundData") return [0n, BigInt(feedUsd) * 10n ** 8n, 0n, 0n, 0n];
    return 8;
});

jest.mock("viem", () => ({
    ...jest.requireActual("viem"),
    createPublicClient: () => ({ readContract }),
}));

const ETH_CHAIN = { id: 1, name: "Mainnet" } as unknown as ProfitabilityChainConfig;
const byChainId = new Map<number, ProfitabilityChainConfig>([[1, ETH_CHAIN]]);

// The price cache is module-level and outlives each test, so the mocked clock only ever moves forward.
// Resetting it per test would make a stale entry from an earlier test look fresh.
let now = 1_000_000_000_000;

describe("nativeUsd — native price freshness across reports", () => {
    beforeEach(() => {
        jest.spyOn(Date, "now").mockImplementation(() => now);
        readContract.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("refetches the feed once the TTL has passed, so a later report sees the new price", async () => {
        feedUsd = 2_000;
        expect(await nativeUsd(ETH_CHAIN, byChainId)).toBe(2_000);

        // Feed moves while the process keeps running. Still inside the TTL: the price is reused.
        feedUsd = 3_000;
        now += NATIVE_PRICE_TTL_MS - 1;
        expect(await nativeUsd(ETH_CHAIN, byChainId)).toBe(2_000);

        // Past the TTL, the second report must read the live feed, not the first report's price.
        now += 2;
        expect(await nativeUsd(ETH_CHAIN, byChainId)).toBe(3_000);
    });

    it("keeps one price for everything inside a single TTL window (consistent within a report)", async () => {
        // Start past the previous test's cached entry so this test begins from a cache miss.
        now += NATIVE_PRICE_TTL_MS + 1;
        feedUsd = 2_000;
        await nativeUsd(ETH_CHAIN, byChainId);
        feedUsd = 2_500;
        expect(await nativeUsd(ETH_CHAIN, byChainId)).toBe(2_000);
        expect(readContract).toHaveBeenCalledTimes(2); // latestRoundData + decimals, once
    });
});
