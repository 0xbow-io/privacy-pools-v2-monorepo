import { getAddress } from "viem";
import { YieldZapRegistry } from "./yield_zap_registry";
import { RateProvider } from "./rate_types";

// Mock only createPublicClient; keep parseAbi / http / getAddress real.
const readContract = jest.fn();
jest.mock("viem", () => ({
    ...jest.requireActual("viem"),
    createPublicClient: () => ({ readContract }),
}));

const USDC = getAddress("0x0000000000000000000000000000000000000011");
const PP_USDC = getAddress("0x0000000000000000000000000000000000000022");
const ZAP = getAddress("0x0000000000000000000000000000000000000033");
const RELAY_SWAPS = getAddress("0x0000000000000000000000000000000000000044");

interface FakeAsset {
    address: string;
    ticker: string;
    quoter: RateProvider;
    underlying?: string;
    zap?: string;
}

// Raw config shape (snake_case) — production code now wraps this itself via
// `new EvmChainConfigWrapper(c)` (Chain<T>.allConfigs() returns raw configs, not wrappers).
function fakeChain(id: number, assets: FakeAsset[], relaySwaps?: string) {
    return {
        id,
        name: `chain-${id}`,
        supported_assets: assets,
        rpc_url: "http://localhost:8545",
        relay_swaps_contract: relaySwaps,
    };
}

// Reassigned fresh by buildRegistry() on every call — tests read it back to
// assert on logger.turbo's arguments (e.g. dedupKey).
let logger = { info: jest.fn(), warn: jest.fn(), turbo: jest.fn(), error: jest.fn() };

function buildRegistry(chains: ReturnType<typeof fakeChain>[]): YieldZapRegistry {
    const relayerConfig = { chain: () => ({ allConfigs: () => chains }) };
    logger = { info: jest.fn(), warn: jest.fn(), turbo: jest.fn(), error: jest.fn() };
    return new YieldZapRegistry(
        relayerConfig as never,
        logger as never
    );
}

// approvedZapList() -> [ZAP]; ZAP.VAULT() -> PP_USDC; ZAP.UNDERLYING() -> USDC
function stubHealthyReads(overrides: { vault?: string; underlying?: string } = {}) {
    readContract.mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === "approvedZapList") return Promise.resolve([ZAP]);
        if (functionName === "VAULT") return Promise.resolve(overrides.vault ?? PP_USDC);
        if (functionName === "UNDERLYING") return Promise.resolve(overrides.underlying ?? USDC);
        throw new Error(`unexpected read ${functionName}`);
    });
}

describe("YieldZapRegistry", () => {
    beforeEach(() => readContract.mockReset());

    it("skips a chain with no Underlying assets without any RPC call", async () => {
        const registry = buildRegistry([
            fakeChain(1, [{ address: USDC, ticker: "USDC", quoter: RateProvider.CURVE }], RELAY_SWAPS),
        ]);
        await registry.onApplicationBootstrap();
        expect(readContract).not.toHaveBeenCalled();
    });

    it("derives share -> zap from approvedZapList() and the zap's own VAULT()", async () => {
        stubHealthyReads();
        const registry = buildRegistry([
            fakeChain(
                1,
                [
                    { address: USDC, ticker: "USDC", quoter: RateProvider.CURVE },
                    { address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC },
                ],
                RELAY_SWAPS
            ),
        ]);
        await registry.onApplicationBootstrap();
        expect(registry.zapForShare(1, PP_USDC)).toBe(ZAP);
        expect(registry.zapForShare(1, PP_USDC.toLowerCase())).toBe(ZAP);
        expect(registry.zapForShare(1, USDC)).toBeUndefined();
    });

    it("accepts a config zap that matches the on-chain one", async () => {
        stubHealthyReads();
        const registry = buildRegistry([
            fakeChain(
                1,
                [
                    { address: USDC, ticker: "USDC", quoter: RateProvider.CURVE },
                    { address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC, zap: ZAP },
                ],
                RELAY_SWAPS
            ),
        ]);
        await expect(registry.onApplicationBootstrap()).resolves.not.toThrow();
        expect(registry.zapForShare(1, PP_USDC)).toBe(ZAP);
    });

    it("fails boot when the RelaySwaps list read throws", async () => {
        readContract.mockRejectedValue(new Error("RPC down"));
        const registry = buildRegistry([
            fakeChain(
                1,
                [{ address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC }],
                RELAY_SWAPS
            ),
        ]);
        await expect(registry.onApplicationBootstrap()).rejects.toThrow(/boot read failed/);
        expect(logger.turbo.mock.calls[0][1]).toMatchObject({ dedupKey: "relayer.yieldZapRegistry.1" });
    });

    it("fails boot when a configured Underlying asset has no allowlisted zap", async () => {
        readContract.mockImplementation(({ functionName }: { functionName: string }) => {
            if (functionName === "approvedZapList") return Promise.resolve([]);
            throw new Error(`unexpected read ${functionName}`);
        });
        const registry = buildRegistry([
            fakeChain(
                1,
                [{ address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC }],
                RELAY_SWAPS
            ),
        ]);
        await expect(registry.onApplicationBootstrap()).rejects.toThrow(/has no allowlisted zap/);
    });

    it("fails boot when a config zap disagrees with the on-chain zap", async () => {
        stubHealthyReads();
        const OTHER = getAddress("0x0000000000000000000000000000000000000099");
        const registry = buildRegistry([
            fakeChain(
                1,
                [
                    { address: USDC, ticker: "USDC", quoter: RateProvider.CURVE },
                    { address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC, zap: OTHER },
                ],
                RELAY_SWAPS
            ),
        ]);
        await expect(registry.onApplicationBootstrap()).rejects.toThrow(/disagrees with the on-chain/);
    });

    it("fails boot when the zap's on-chain underlying disagrees with config", async () => {
        stubHealthyReads({ underlying: getAddress("0x00000000000000000000000000000000000000AA") });
        const registry = buildRegistry([
            fakeChain(
                1,
                [
                    { address: USDC, ticker: "USDC", quoter: RateProvider.CURVE },
                    { address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC },
                ],
                RELAY_SWAPS
            ),
        ]);
        await expect(registry.onApplicationBootstrap()).rejects.toThrow(/redeems into/);
    });

    it("only warns for an on-chain zap whose share is not a configured asset", async () => {
        // approvedZapList has ZAP (share PP_USDC), but config only prices a DIFFERENT share.
        const OTHER_SHARE = getAddress("0x00000000000000000000000000000000000000bb");
        const OTHER_ZAP = getAddress("0x00000000000000000000000000000000000000cc");
        readContract.mockImplementation(({ address, functionName }: { address: string; functionName: string }) => {
            if (functionName === "approvedZapList") return Promise.resolve([ZAP, OTHER_ZAP]);
            if (functionName === "VAULT") {
                return Promise.resolve(address.toLowerCase() === ZAP.toLowerCase() ? OTHER_SHARE : PP_USDC);
            }
            if (functionName === "UNDERLYING") return Promise.resolve(USDC);
            throw new Error(`unexpected read ${functionName}`);
        });
        const registry = buildRegistry([
            fakeChain(
                1,
                [
                    { address: USDC, ticker: "USDC", quoter: RateProvider.CURVE },
                    { address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC },
                ],
                RELAY_SWAPS
            ),
        ]);
        await expect(registry.onApplicationBootstrap()).resolves.not.toThrow();
        expect(registry.zapForShare(1, PP_USDC)).toBe(OTHER_ZAP);
    });

    it("skips an Underlying asset's chain with no relay_swaps_contract without failing boot", async () => {
        const registry = buildRegistry([
            fakeChain(1, [
                { address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC },
            ]),
        ]);
        await expect(registry.onApplicationBootstrap()).resolves.not.toThrow();
        expect(readContract).not.toHaveBeenCalled();
        expect(registry.zapForShare(1, PP_USDC)).toBeUndefined();
    });
});
