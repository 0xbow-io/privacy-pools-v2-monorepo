import { getAddress } from "viem";
import { YieldDiscoveryService } from "./yield-discovery.service";

// Mock only createPublicClient; keep parseAbi / http / getAddress real (same as yield_zap_registry.spec).
const readContract = jest.fn();
jest.mock("viem", () => ({
    ...jest.requireActual("viem"),
    createPublicClient: () => ({ readContract }),
}));

const USDC = getAddress("0x0000000000000000000000000000000000000011");
const PP_USDC = getAddress("0x0000000000000000000000000000000000000022");
const ZAP = getAddress("0x0000000000000000000000000000000000000033");
const ROUTER = getAddress("0x0000000000000000000000000000000000000044");
const USDT = getAddress("0x0000000000000000000000000000000000000055");
const PP_USDT = getAddress("0x0000000000000000000000000000000000000066");
const ROUTER_2 = getAddress("0x0000000000000000000000000000000000000077");

interface FakeAsset { address: string; ticker: string; quoter: string; underlying?: string }
// Raw config shape (snake_case) — production code now wraps this itself via
// `new EvmChainConfigWrapper(c)` (Chain<T>.allConfigs() returns raw configs, not wrappers).
function fakeChain(id: number, assets: FakeAsset[], routers: string[]) {
    return {
        id,
        name: `chain-${id}`,
        rpc_url: "http://localhost:8545",
        allowed_processors: routers,
        supported_assets: assets,
    };
}
// Reassigned fresh by buildService() on every call — tests read it back to
// assert on logger.turbo's arguments (e.g. dedupKey).
let logger = { info: jest.fn(), warn: jest.fn(), turbo: jest.fn(), error: jest.fn() };

function buildService(chains: ReturnType<typeof fakeChain>[]): YieldDiscoveryService {
    const relayerConfig = { chain: () => ({ allConfigs: () => chains }) };
    logger = { info: jest.fn(), warn: jest.fn(), turbo: jest.fn(), error: jest.fn() };
    return new YieldDiscoveryService(relayerConfig as never, logger as never);
}
/** On-chain view of two routers: ROUTER wraps USDC->ppUSDC, ROUTER_2 wraps USDT->ppUSDT. */
function stubReads(overrides: Partial<Record<string, unknown>> = {}) {
    const byRouter: Record<string, { VAULT: string; UNDERLYING: string; ZAP: string }> = {
        [ROUTER]: { VAULT: PP_USDC, UNDERLYING: USDC, ZAP },
        [ROUTER_2]: { VAULT: PP_USDT, UNDERLYING: USDT, ZAP },
    };
    const meta: Record<string, { decimals: number; symbol: string }> = {
        [PP_USDC]: { decimals: 18, symbol: "ppUSDC" },
        [USDC]: { decimals: 6, symbol: "USDC" },
        [PP_USDT]: { decimals: 18, symbol: "ppUSDT" },
        [USDT]: { decimals: 6, symbol: "USDT" },
    };
    readContract.mockImplementation(({ address, functionName }: { address: string; functionName: string }) => {
        const key = `${getAddress(address)}:${functionName}`;
        if (key in overrides) return Promise.resolve(overrides[key]);
        const r = byRouter[getAddress(address)];
        if (r && functionName in r) return Promise.resolve(r[functionName as keyof typeof r]);
        const m = meta[getAddress(address)];
        if (m && functionName in m) return Promise.resolve(m[functionName as keyof typeof m]);
        return Promise.reject(new Error(`unexpected read ${key}`));
    });
}
const USDC_ASSET = { address: USDC, ticker: "USDC", quoter: "Cowswap" };
const PP_USDC_ASSET = { address: PP_USDC, ticker: "ppUSDC", quoter: "Underlying", underlying: USDC };
const USDT_ASSET = { address: USDT, ticker: "USDT", quoter: "Cowswap" };
const PP_USDT_ASSET = { address: PP_USDT, ticker: "ppUSDT", quoter: "Underlying", underlying: USDT };

describe("YieldDiscoveryService", () => {
    beforeEach(() => readContract.mockReset());

    it("derives one wrapper per allowlisted router from the router's own immutables", async () => {
        stubReads();
        const service = buildService([
            fakeChain(1, [USDC_ASSET, PP_USDC_ASSET, USDT_ASSET, PP_USDT_ASSET], [ROUTER, ROUTER_2]),
        ]);

        await service.onApplicationBootstrap();

        expect(service.wrappersFor(1)).toEqual([
            { ppToken: PP_USDC, underlying: USDC, router: ROUTER, zap: ZAP, ppDecimals: 18, underlyingDecimals: 6, underlyingSymbol: "USDC" },
            { ppToken: PP_USDT, underlying: USDT, router: ROUTER_2, zap: ZAP, ppDecimals: 18, underlyingDecimals: 6, underlyingSymbol: "USDT" },
        ]);
    });

    it("publishes [] for a chain with no routers and no shares, without touching the RPC", async () => {
        const service = buildService([fakeChain(11155111, [USDC_ASSET], [])]);

        await service.onApplicationBootstrap();

        expect(service.wrappersFor(11155111)).toEqual([]);
        expect(service.wrappersFor(999)).toEqual([]);
        expect(readContract).not.toHaveBeenCalled();
    });

    it("refuses to boot when a share is configured but no router is allowlisted", async () => {
        const service = buildService([fakeChain(1, [USDC_ASSET, PP_USDC_ASSET], [])]);

        await expect(service.onApplicationBootstrap()).rejects.toThrow(/no allowed_processors/);
    });

    it("refuses to boot when a router wraps a share that is not a configured asset", async () => {
        stubReads();
        const service = buildService([fakeChain(1, [USDC_ASSET], [ROUTER])]);

        await expect(service.onApplicationBootstrap()).rejects.toThrow(/not a configured asset/);
    });

    it("refuses to boot when the router's share is configured with a non-Underlying quoter", async () => {
        stubReads();
        const service = buildService([fakeChain(1, [USDC_ASSET, { ...PP_USDC_ASSET, quoter: "Curve" }], [ROUTER])]);

        await expect(service.onApplicationBootstrap()).rejects.toThrow(/quoter "Curve" instead of "Underlying"/);
    });

    it("refuses to boot when the configured underlying disagrees with the router's UNDERLYING()", async () => {
        stubReads({ [`${ROUTER}:UNDERLYING`]: USDT });
        const service = buildService([fakeChain(1, [USDC_ASSET, PP_USDC_ASSET], [ROUTER])]);

        await expect(service.onApplicationBootstrap()).rejects.toThrow(/does not match PPRouter/);
    });

    it("refuses to boot when a share has no router in allowed_processors", async () => {
        stubReads();
        const service = buildService([fakeChain(1, [USDC_ASSET, PP_USDC_ASSET, USDT_ASSET, PP_USDT_ASSET], [ROUTER])]);

        await expect(service.onApplicationBootstrap()).rejects.toThrow(/ppUSDT .* have no PPRouter/);
    });

    it("refuses to boot when two routers wrap the same share", async () => {
        stubReads({ [`${ROUTER_2}:VAULT`]: PP_USDC, [`${ROUTER_2}:UNDERLYING`]: USDC });
        const service = buildService([fakeChain(1, [USDC_ASSET, PP_USDC_ASSET], [ROUTER, ROUTER_2])]);

        await expect(service.onApplicationBootstrap()).rejects.toThrow(/wrap the same share/);
    });

    it("surfaces an RPC read failure as a boot error naming the router", async () => {
        readContract.mockRejectedValue(new Error("connection refused"));
        const service = buildService([fakeChain(1, [USDC_ASSET, PP_USDC_ASSET], [ROUTER])]);

        await expect(service.onApplicationBootstrap()).rejects.toThrow(/boot read failed for router .* connection refused/);
        expect(logger.turbo.mock.calls[0][1]).toMatchObject({ dedupKey: "relayer.yieldDiscovery.1" });
    });
});
