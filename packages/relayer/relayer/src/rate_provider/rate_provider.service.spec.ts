import type { Address } from "viem";
import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { OrderBookApi, OrderBookApiError } from "@cowprotocol/cow-sdk";
import type { OrderQuoteResponse } from "@cowprotocol/cow-sdk";
import { RateProviderService } from "./rate_provider.service";
import * as curve_parameters from "./curve/curve_quote_obtention";
import * as cowswap_parameters from "./cowswap/quote_obtention";
import * as mock_sepolia_parameters from "./mock_sepolia/mock_sepolia_quote";
import * as uniswap_v3_parameters from "./uniswap_v3/quote_obtention";
import * as curveUtilities from "./utilities";
import { TokenDescription, RateProvider, type RateProviderDescription } from "./rate_types";
import { ChainType } from "../config/enums";
import { createMockLogger, createMockLoggerProvider } from "../test/mocks";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// Permissive stand-in description: every test here quotes mainnet (chainId 1) assets, so
// this just needs to declare that chain supported — the `provider` field content is only
// used in error messages, not compared against anything.
const chainOneDescription: RateProviderDescription = {
    provider: RateProvider.CURVE,
    known_currencies: [{ chainType: ChainType.EVM, chainId: 1, assetId: "*" }],
};

import * as dotenv from "dotenv";

dotenv.config({ path: `./.env` });
if (existsSync("./.env")) {
    dotenv.config({ path: `./.env` });
}

const rpc_url: string = process.env.RPC_URL || (console.warn("Using default RPC_URL"), "http://localhost:8545");

async function isRpcAvailable(): Promise<boolean> {
    try {
        const res = await fetch(rpc_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "net_version", params: [], id: 1 }),
            signal: AbortSignal.timeout(2000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

// The CowSwap tests call the public CoW orderbook API as well as the RPC. They are opt-in: the CoW
// API rate-limits us and the tests are slow, so they must not run (or show as failures) in a
// default run. Set RUN_LIVE_COWSWAP_TESTS=1 to run them. Even then, a reachability probe skips them
// when the API is unreachable or rate-limited (HTTP 429), since both would otherwise hang or fail.
const LIVE_COWSWAP_ENABLED = process.env.RUN_LIVE_COWSWAP_TESTS === "1";
const COW_API_URL = "https://api.cow.fi/mainnet/api/v1/version";

async function isCowApiAvailable(): Promise<boolean> {
    try {
        const res = await fetch(COW_API_URL, { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch {
        return false;
    }
}

let rpcAvailable = false;
let cowApiAvailable = false;

beforeAll(async () => {
    [rpcAvailable, cowApiAvailable] = await Promise.all([
        isRpcAvailable(),
        LIVE_COWSWAP_ENABLED ? isCowApiAvailable() : Promise.resolve(false),
    ]);
    if (!rpcAvailable) {
        console.warn(`Skipping RateProviderService tests: RPC at ${rpc_url} is not reachable`);
    }
    if (!LIVE_COWSWAP_ENABLED) {
        console.warn("Skipping CowSwap live tests: opt-in, set RUN_LIVE_COWSWAP_TESTS=1 to run them");
    } else if (!cowApiAvailable) {
        console.warn(`Skipping CowSwap live tests: ${COW_API_URL} is unreachable or rate-limited`);
    }
});

// `rpcAvailable` is only known once `beforeAll` resolves, which happens during
// Jest's run phase — well after `describe` bodies (and any `it`/`it.skip` choice
// made at registration time) have already been evaluated during the collection
// phase. So the reachability check has to be enforced inside the test body
// (which runs during the run phase), not by picking `it` vs `it.skip` up front.
const itIfRpc = (name: string, fn: () => void | Promise<void>, timeout?: number) => {
    it(
        name,
        async () => {
            if (!rpcAvailable) {
                console.warn(`Skipping "${name}": RPC at ${rpc_url} is not reachable`);
                return;
            }
            await fn();
        },
        timeout,
    );
};

// CowSwap live tests. The opt-in flag is known at load time, so it is decided at registration:
// without it these cases are registered with it.skip and CTRF reports them as skipped (not passed).
// With it on, they also need the RPC and the CoW API reachable (checked in beforeAll), otherwise the
// body returns early.
const itIfCow = (name: string, fn: () => void | Promise<void>, timeout?: number) => {
    (LIVE_COWSWAP_ENABLED ? it : it.skip)(
        name,
        async () => {
            if (!rpcAvailable || !cowApiAvailable) {
                console.warn(`Skipping "${name}": RPC or CoW API not reachable`);
                return;
            }
            await fn();
        },
        timeout,
    );
};

// Loads the *actual* production descriptions (rather than the permissive chainOneDescription
// stand-in above) so the matrix below exercises the same chain-support declarations
// quote.module.ts registers with — catches a description/matrix drift, not just the queryRate
// logic in isolation.
function loadRateProviderDescription(relativePath: string): RateProviderDescription {
    return JSON.parse(readFileSync(resolve(__dirname, relativePath), "utf-8")) as RateProviderDescription;
}

const curveDescription = loadRateProviderDescription("./curve/rate_provider_description.json");
const cowswapDescription = loadRateProviderDescription("./cowswap/rate_provider_description.json");
const mockDescription = loadRateProviderDescription("./mock_sepolia/rate_provider_description.json");
const uniswapV3Description = loadRateProviderDescription("./uniswap_v3/rate_provider_description.json");

// Public RPCs, already used and verified reachable elsewhere in this session (see
// curve/oracle_addresses.md, cowswap/anchor_tokens.md). Fine for exercising the matrix below;
// a production deployment should use a paid provider per chain instead (RPC_URL_EVM_<chainId>
// still takes precedence when set, matching the app's own resolution order).
const PUBLIC_RPC_BY_CHAIN_ID: Record<number, string> = {
    42161: "https://arb1.arbitrum.io/rpc",
    100: "https://rpc.gnosischain.com",
    4114: "https://rpc.mainnet.citrea.xyz",
    5115: "https://rpc.testnet.citrea.xyz",
    10: "https://mainnet.optimism.io",
};

function rpcUrlForChain(chainId: number): string {
    return process.env[`RPC_URL_EVM_${chainId}`] || PUBLIC_RPC_BY_CHAIN_ID[chainId] || rpc_url;
}

interface MatrixCase {
    chainId: number;
    ticker: string;
    address: Address;
    decimals: number;
}

// Only chains/assets independently verified on-chain and cross-checked against a second
// source — see curve/oracle_addresses.md and cowswap/anchor_tokens.md. No guessed addresses.
// DAI deliberately excluded here: Curve's mainnet oracle returns a verified zero rate for
// DAI/WETH (this asset isn't in whatever pool set this specific oracle aggregates over) —
// a real gap in this oracle's coverage, not a bug, so it doesn't belong in a matrix of
// pairs Curve is expected to price successfully. CowSwap has no such gap for DAI.
const CURVE_MATRIX: MatrixCase[] = [
    { chainId: 1, ticker: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
    { chainId: 1, ticker: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    { chainId: 42161, ticker: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
];

const COWSWAP_MATRIX: MatrixCase[] = [
    { chainId: 1, ticker: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    { chainId: 1, ticker: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
    { chainId: 1, ticker: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18 },
    { chainId: 42161, ticker: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    { chainId: 100, ticker: "WXDAI", address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", decimals: 18 },
];

// JuiceSwap pools on Citrea, independently verified on-chain (real bytecode, nonzero
// liquidity, working 15-min TWAP) — see citrea/pool_addresses.md.
const CITREA_MATRIX: MatrixCase[] = [
    { chainId: 4114, ticker: "USDT.e", address: "0x9f3096Bac87e7F03DC09b0B416eB0DF837304dc4", decimals: 6 },
    { chainId: 4114, ticker: "USDC.e", address: "0xE045e6c36cF77FAA2CfB54466D71A3aEF7bbE839", decimals: 6 },
    { chainId: 4114, ticker: "ctUSD", address: "0x8D82c4E3c936C7B5724A382a9c5a4E6Eb7aB6d5D", decimals: 6 },
    { chainId: 5115, ticker: "USDC", address: "0x36c16eaC6B0Ba6c50f494914ff015fCa95B7835F", decimals: 6 },
    // Optimism mainnet — canonical Uniswap V3, WETH anchor (see citrea/pool_addresses.md).
    { chainId: 10, ticker: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
    { chainId: 10, ticker: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
];

describe("RateProviderService", () => {
    let service: RateProviderService;

    describe("Curve", () => {
        beforeEach(async () => {
            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    RateProviderService,
                    createMockLoggerProvider(),
                    {
                        provide: "RATE_GETTER_FUNCTION",
                        useValue: curve_parameters.queryRate,
                    },
                    {
                        provide: "RATE_PROVIDER_DESCRIPTION",
                        useValue: chainOneDescription,
                    },
                ],
            }).compile();

            service = module.get<RateProviderService>(RateProviderService);
        });

        itIfRpc("should be defined", () => {
            expect(service).toBeDefined();
        });

        itIfRpc("should be able to quote USDT against WETH.", async () => {
            const input_token: TokenDescription = {
                address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
                ticker: "USDT",
                quoter: RateProvider.CURVE,
                decimals: 6,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const output_token: TokenDescription = {
                address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                ticker: "WETH",
                quoter: RateProvider.CURVE,
                decimals: 18,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const response = await service.quote(input_token, output_token, ChainType.EVM, 1, rpc_url);

            // Rate is in 18 decimals. USDT/WETH should be a small number (1 USDT buys fraction of ETH).
            expect(response.num).toBeGreaterThan(0n);
            expect(response.token_out.ticker).toBe("WETH");
        });

        itIfRpc("Should be able to quote for an example asset vs native token.", async () => {
            const usdt_token: TokenDescription = {
                address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
                ticker: "USDT",
                quoter: RateProvider.CURVE,
                decimals: 6,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const native_wrapped_token: TokenDescription = {
                address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                ticker: "WETH",
                quoter: RateProvider.CURVE,
                decimals: 18,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const response_usdt = await service.quote(usdt_token, native_wrapped_token, ChainType.EVM, 1, rpc_url);
            const ratio_usdt = 10n ** 18n / response_usdt.num;

            const usdc_token: TokenDescription = {
                address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                ticker: "USDC",
                quoter: RateProvider.COWSWAP,
                decimals: 6,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const response_usdc = await service.quote(usdc_token, native_wrapped_token, ChainType.EVM, 1, rpc_url);
            const ratio_usdc = 10n ** 18n / response_usdc.num;

            // These two assets should both be almost a dollar, so the ratio should be close to 1.
            // Live on-chain rates, so allow for normal pool-imbalance/slippage noise rather than
            // asserting near-exact parity (mirrors the 5% band used for the equivalent CowSwap check).
            const ratios_ratio = Number(ratio_usdc) / Number(ratio_usdt);
            expect(ratios_ratio).toBeGreaterThan(0.95);
            expect(ratios_ratio).toBeLessThan(1.05);
        });
    });

    describe("Cowswap", () => {
        beforeEach(async () => {
            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    RateProviderService,
                    createMockLoggerProvider(),
                    {
                        provide: "RATE_GETTER_FUNCTION",
                        useValue: cowswap_parameters.queryRate,
                    },
                    {
                        provide: "RATE_PROVIDER_DESCRIPTION",
                        useValue: chainOneDescription,
                    },
                ],
            }).compile();

            service = module.get<RateProviderService>(RateProviderService);
        });

        itIfCow("should be defined", () => {
            expect(service).toBeDefined();
        });

        itIfCow("should return non-zero num and den for a valid quote", async () => {
            const usdc: TokenDescription = {
                address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                ticker: "USDC",
                quoter: RateProvider.COWSWAP,
                decimals: 6,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const dummy_output: TokenDescription = {
                address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                ticker: "ignored",
                quoter: RateProvider.COWSWAP,
                decimals: 6,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const response = await service.quote(usdc, dummy_output, ChainType.EVM, 1, rpc_url);

            expect(response.num).toBeGreaterThan(0n);
            expect(response.den).toBeGreaterThan(0n);
        }, 15_000);

        itIfCow("should always return WETH as output regardless of output_token param", async () => {
            const usdt: TokenDescription = {
                address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
                ticker: "USDT",
                quoter: RateProvider.COWSWAP,
                decimals: 6,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const fake_output: TokenDescription = {
                address: "0x6b175474e89094c44da98b954eedeac495271d0f",
                ticker: "DAI",
                quoter: RateProvider.COWSWAP,
                decimals: 18,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const response = await service.quote(usdt, fake_output, ChainType.EVM, 1, rpc_url);

            expect(response.token_out.ticker).toBe("WETH");
            expect(response.token_out.address).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
        }, 15_000);

        itIfCow("should return similar rates for USDC and USDT (both ~$1 stablecoins)", async () => {
            const usdc: TokenDescription = {
                address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                ticker: "USDC",
                quoter: RateProvider.COWSWAP,
                decimals: 6,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const usdt: TokenDescription = {
                address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
                ticker: "USDT",
                quoter: RateProvider.COWSWAP,
                decimals: 6,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const dummy_output: TokenDescription = {
                address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                ticker: "WETH",
                quoter: RateProvider.COWSWAP,
                decimals: 18,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const response_usdc = await service.quote(usdc, dummy_output, ChainType.EVM, 1, rpc_url);
            const response_usdt = await service.quote(usdt, dummy_output, ChainType.EVM, 1, rpc_url);

            // Both are $1 stablecoins, so num/den ratios should be within 5% of each other
            const rate_usdc = Number(response_usdc.num) / Number(response_usdc.den);
            const rate_usdt = Number(response_usdt.num) / Number(response_usdt.den);
            const ratio = rate_usdc / rate_usdt;
            expect(ratio).toBeGreaterThan(0.95);
            expect(ratio).toBeLessThan(1.05);
        }, 30_000);

        itIfCow("should preserve token_in from the input", async () => {
            const dai: TokenDescription = {
                address: "0x6b175474e89094c44da98b954eedeac495271d0f",
                ticker: "DAI",
                quoter: RateProvider.COWSWAP,
                decimals: 18,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const dummy_output: TokenDescription = {
                address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                ticker: "WETH",
                quoter: RateProvider.COWSWAP,
                decimals: 18,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const response = await service.quote(dai, dummy_output, ChainType.EVM, 1, rpc_url);

            expect(response.token_in.address).toBe(dai.address);
            expect(response.token_in.ticker).toBe("DAI");
            expect(response.source).toBe(RateProvider.COWSWAP);
        }, 15_000);
    });

    describe("Cross-provider", () => {
        let curveService: RateProviderService;
        let cowswapService: RateProviderService;

        beforeEach(async () => {
            const curveModule = await Test.createTestingModule({
                providers: [
                    RateProviderService,
                    createMockLoggerProvider(),
                    { provide: "RATE_GETTER_FUNCTION", useValue: curve_parameters.queryRate },
                    { provide: "RATE_PROVIDER_DESCRIPTION", useValue: chainOneDescription },
                ],
            }).compile();
            curveService = curveModule.get<RateProviderService>(RateProviderService);

            const cowswapModule = await Test.createTestingModule({
                providers: [
                    RateProviderService,
                    createMockLoggerProvider(),
                    { provide: "RATE_GETTER_FUNCTION", useValue: cowswap_parameters.queryRate },
                    { provide: "RATE_PROVIDER_DESCRIPTION", useValue: chainOneDescription },
                ],
            }).compile();
            cowswapService = cowswapModule.get<RateProviderService>(RateProviderService);
        });

        itIfCow("Curve and CowSwap should return rates within 10% for USDC/WETH", async () => {
            const usdc: TokenDescription = {
                address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                ticker: "USDC",
                quoter: RateProvider.CURVE,
                decimals: 6,
                chainType: ChainType.EVM,
                chainId: 1,
            };
            const weth: TokenDescription = {
                address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                ticker: "WETH",
                quoter: RateProvider.CURVE,
                decimals: 18,
                chainType: ChainType.EVM,
                chainId: 1,
            };

            const curveResponse = await curveService.quote(usdc, weth, ChainType.EVM, 1, rpc_url);
            const cowswapResponse = await cowswapService.quote(usdc, weth, ChainType.EVM, 1, rpc_url);

            // Both providers now share the Quote convention (num/den = whole-output per
            // whole-input x1e18), so the rates compare directly with no per-provider
            // renormalization — that's the invariant this test exists to police.
            const curveRate = Number(curveResponse.num) / Number(curveResponse.den);
            const cowswapRate = Number(cowswapResponse.num) / Number(cowswapResponse.den);

            const ratio = curveRate / cowswapRate;
            expect(ratio).toBeGreaterThan(0.9);
            expect(ratio).toBeLessThan(1.1);
        }, 30_000);
    });

    // Correctness across every verified (chainId, asset) pair each provider supports, plus a
    // free response-time benchmark: each case gets its own test name, so ctrf's per-test
    // `duration` (see ctrf/ctrf-report.json after a run) already gives a timing breakdown by
    // chain/asset without any bespoke stopwatch code here.
    describe("Matrix (chainId x asset)", () => {
        describe("Curve", () => {
            let matrixService: RateProviderService;

            beforeEach(async () => {
                const module: TestingModule = await Test.createTestingModule({
                    providers: [
                        RateProviderService,
                        createMockLoggerProvider(),
                        { provide: "RATE_GETTER_FUNCTION", useValue: curve_parameters.queryRate },
                        { provide: "RATE_PROVIDER_DESCRIPTION", useValue: curveDescription },
                    ],
                }).compile();
                matrixService = module.get<RateProviderService>(RateProviderService);
            });

            it.each(CURVE_MATRIX)(
                "quotes $ticker on chainId $chainId",
                async ({ chainId, ticker, address, decimals }) => {
                    if (!rpcAvailable) {
                        console.warn(`Skipping Curve matrix case ${ticker}@${chainId}: RPC not reachable`);
                        return;
                    }
                    const token: TokenDescription = {
                        address,
                        ticker,
                        quoter: RateProvider.CURVE,
                        decimals,
                        chainType: ChainType.EVM,
                        chainId,
                    };
                    const response = await matrixService.quote(token, token, ChainType.EVM, chainId, rpcUrlForChain(chainId));
                    expect(response.num).toBeGreaterThan(0n);
                },
                15_000,
            );
        });

        describe("Cowswap", () => {
            let matrixService: RateProviderService;

            beforeEach(async () => {
                const module: TestingModule = await Test.createTestingModule({
                    providers: [
                        RateProviderService,
                        createMockLoggerProvider(),
                        { provide: "RATE_GETTER_FUNCTION", useValue: cowswap_parameters.queryRate },
                        { provide: "RATE_PROVIDER_DESCRIPTION", useValue: cowswapDescription },
                    ],
                }).compile();
                matrixService = module.get<RateProviderService>(RateProviderService);
            });

            (LIVE_COWSWAP_ENABLED ? it.each : it.skip.each)(COWSWAP_MATRIX)(
                "quotes $ticker on chainId $chainId",
                async ({ chainId, ticker, address, decimals }) => {
                    if (!rpcAvailable || !cowApiAvailable) {
                        console.warn(`Skipping Cowswap matrix case ${ticker}@${chainId}: RPC or CoW API not reachable`);
                        return;
                    }
                    const token: TokenDescription = {
                        address,
                        ticker,
                        quoter: RateProvider.COWSWAP,
                        decimals,
                        chainType: ChainType.EVM,
                        chainId,
                    };
                    const response = await matrixService.quote(token, token, ChainType.EVM, chainId, rpcUrlForChain(chainId));
                    expect(response.num).toBeGreaterThan(0n);
                    expect(response.den).toBeGreaterThan(0n);
                },
                20_000,
            );
        });

        describe("Citrea (JuiceSwap)", () => {
            let matrixService: RateProviderService;

            beforeEach(async () => {
                const module: TestingModule = await Test.createTestingModule({
                    providers: [
                        RateProviderService,
                        createMockLoggerProvider(),
                        { provide: "RATE_GETTER_FUNCTION", useValue: uniswap_v3_parameters.queryRate },
                        { provide: "RATE_PROVIDER_DESCRIPTION", useValue: uniswapV3Description },
                    ],
                }).compile();
                matrixService = module.get<RateProviderService>(RateProviderService);
            });

            it.each(CITREA_MATRIX)(
                "quotes $ticker on chainId $chainId",
                async ({ chainId, ticker, address, decimals }) => {
                    if (!rpcAvailable) {
                        console.warn(`Skipping Citrea matrix case ${ticker}@${chainId}: RPC not reachable`);
                        return;
                    }
                    const token: TokenDescription = {
                        address,
                        ticker,
                        quoter: RateProvider.UNISWAP,
                        decimals,
                        chainType: ChainType.EVM,
                        chainId,
                    };
                    const response = await matrixService.quote(token, token, ChainType.EVM, chainId, rpcUrlForChain(chainId));
                    expect(response.num).toBeGreaterThan(0n);
                    expect(response.den).toBeGreaterThan(0n);
                },
                20_000,
            );
        });
    });

    // Mocked — no live network/RPC needed, so these run unconditionally (not gated by
    // itIfRpc). Regression coverage for the zero/degenerate-rate guards added to both
    // providers, plus CowSwap's fee-floor retry, none of which had a dedicated test before
    // (only manually verified against live services while investigating the DAI/mainnet gap
    // and the CowSwap latency regression).
    describe("Defensive guards (mocked)", () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        it("pages the operator (alert, per-provider and per-chain dedupKey) when the rate getter fails", async () => {
            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    RateProviderService,
                    createMockLoggerProvider(),
                    { provide: "RATE_GETTER_FUNCTION", useValue: jest.fn().mockRejectedValue(new Error("upstream down")) },
                    { provide: "RATE_PROVIDER_DESCRIPTION", useValue: chainOneDescription },
                ],
            }).compile();
            const mockedService = module.get<RateProviderService>(RateProviderService);
            const logger = module.get(FATLoggerService) as unknown as ReturnType<typeof createMockLogger>;
            const usdc = { address: "0x0000000000000000000000000000000000000001", ticker: "USDC", quoter: RateProvider.CURVE, decimals: 6, chainType: ChainType.EVM, chainId: 1 };

            await expect(mockedService.quote(usdc, usdc, ChainType.EVM, 1, "unused")).rejects.toThrow(BadRequestException);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to quote USDC"), {
                alert: true,
                dedupKey: `quote.rateProvider.${chainOneDescription.provider}.1`,
            });
        });

        describe("Curve", () => {
            async function buildCurveService(): Promise<RateProviderService> {
                const module: TestingModule = await Test.createTestingModule({
                    providers: [
                        RateProviderService,
                        createMockLoggerProvider(),
                        { provide: "RATE_GETTER_FUNCTION", useValue: curve_parameters.queryRate },
                        { provide: "RATE_PROVIDER_DESCRIPTION", useValue: chainOneDescription },
                    ],
                }).compile();
                return module.get<RateProviderService>(RateProviderService);
            }

            // First readContract call is the current rate, second the historic one
            // (queryRate reads sequentially: current → block number → historic).
            function mockCurveWallet(current: bigint, historic?: bigint): jest.Mock {
                const readContract = jest.fn()
                    .mockResolvedValueOnce(current)
                    .mockResolvedValueOnce(historic);
                jest.spyOn(curveUtilities, "getWallet").mockReturnValue({
                    readContract,
                    getBlockNumber: jest.fn().mockResolvedValue(23_000_000n),
                } as unknown as ReturnType<typeof curveUtilities.getWallet>);
                return readContract;
            }

            const dai: TokenDescription = {
                address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
                ticker: "DAI",
                quoter: RateProvider.CURVE,
                decimals: 18,
                chainType: ChainType.EVM,
                chainId: 1,
            };

            beforeEach(() => {
                delete process.env.DISABLE_CURVE_HISTORIC_RATE_CHECK;
                delete process.env.CURVE_RATE_MAX_DEVIATION_BPS;
            });

            afterEach(() => {
                delete process.env.DISABLE_CURVE_HISTORIC_RATE_CHECK;
                delete process.env.CURVE_RATE_MAX_DEVIATION_BPS;
            });

            it("throws a BadRequestException when the oracle returns a zero rate", async () => {
                jest.spyOn(curveUtilities, "getWallet").mockReturnValue({
                    readContract: jest.fn().mockResolvedValue(0n),
                } as unknown as ReturnType<typeof curveUtilities.getWallet>);

                const mockedService = await buildCurveService();

                await expect(mockedService.quote(dai, dai, ChainType.EVM, 1, "http://mock-rpc")).rejects.toThrow(BadRequestException);
                await expect(mockedService.quote(dai, dai, ChainType.EVM, 1, "http://mock-rpc")).rejects.toThrow(/zero rate/i);
            });

            it("accepts a current rate within the historic deviation threshold", async () => {
                const readContract = mockCurveWallet(1_050n * 10n ** 15n, 1_000n * 10n ** 15n); // +5%
                const mockedService = await buildCurveService();

                const response = await mockedService.quote(dai, dai, ChainType.EVM, 1, "http://mock-rpc");

                expect(response.num).toBe(1_050n * 10n ** 15n);
                // Second read must be pinned to a historic block, not a re-read of head.
                expect(readContract).toHaveBeenCalledTimes(2);
                expect(readContract.mock.calls[1][0]).toMatchObject({ blockNumber: 23_000_000n - 50n });
            });

            it("rejects a current rate that deviates beyond the threshold from the historic rate", async () => {
                mockCurveWallet(10_000n * 10n ** 15n, 1_000n * 10n ** 15n); // 10x spike
                const mockedService = await buildCurveService();

                await expect(mockedService.quote(dai, dai, ChainType.EVM, 1, "http://mock-rpc")).rejects.toThrow(BadRequestException);
            });

            it("includes a manipulation hint in the deviation error", async () => {
                mockCurveWallet(10_000n * 10n ** 15n, 1_000n * 10n ** 15n);
                const mockedService = await buildCurveService();

                await expect(mockedService.quote(dai, dai, ChainType.EVM, 1, "http://mock-rpc")).rejects.toThrow(/deviates|manipulation/i);
            });

            it("fails closed when there is no historic baseline (zero historic rate)", async () => {
                mockCurveWallet(1_000n * 10n ** 15n, 0n);
                const mockedService = await buildCurveService();

                await expect(mockedService.quote(dai, dai, ChainType.EVM, 1, "http://mock-rpc")).rejects.toThrow(/historic/i);
            });

            it("skips the historic check entirely when DISABLE_CURVE_HISTORIC_RATE_CHECK=true", async () => {
                process.env.DISABLE_CURVE_HISTORIC_RATE_CHECK = "true";
                const readContract = mockCurveWallet(10_000n * 10n ** 15n, 1_000n * 10n ** 15n);
                const mockedService = await buildCurveService();

                const response = await mockedService.quote(dai, dai, ChainType.EVM, 1, "http://mock-rpc");

                expect(response.num).toBe(10_000n * 10n ** 15n);
                expect(readContract).toHaveBeenCalledTimes(1);
            });

            it("respects a CURVE_RATE_MAX_DEVIATION_BPS override", async () => {
                process.env.CURVE_RATE_MAX_DEVIATION_BPS = "100000"; // 1000% — permissive
                mockCurveWallet(10_000n * 10n ** 15n, 1_000n * 10n ** 15n); // 10x, within 1000%
                const mockedService = await buildCurveService();

                const response = await mockedService.quote(dai, dai, ChainType.EVM, 1, "http://mock-rpc");

                expect(response.num).toBe(10_000n * 10n ** 15n);
            });
        });

        describe("Cowswap", () => {
            function fakeQuoteResponse(sellAmount: string, buyAmount: string): OrderQuoteResponse {
                return { quote: { sellAmount, buyAmount } } as unknown as OrderQuoteResponse;
            }

            async function buildCowswapService(): Promise<RateProviderService> {
                const module: TestingModule = await Test.createTestingModule({
                    providers: [
                        RateProviderService,
                        createMockLoggerProvider(),
                        { provide: "RATE_GETTER_FUNCTION", useValue: cowswap_parameters.queryRate },
                        { provide: "RATE_PROVIDER_DESCRIPTION", useValue: chainOneDescription },
                    ],
                }).compile();
                return module.get<RateProviderService>(RateProviderService);
            }

            const usdc: TokenDescription = {
                address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                ticker: "USDC",
                quoter: RateProvider.COWSWAP,
                decimals: 6,
                chainType: ChainType.EVM,
                chainId: 1,
            };

            it("throws a BadRequestException when the API returns a zero buyAmount", async () => {
                jest.spyOn(OrderBookApi.prototype, "getQuote").mockResolvedValue(fakeQuoteResponse("100000000", "0"));

                const mockedService = await buildCowswapService();

                await expect(mockedService.quote(usdc, usdc, ChainType.EVM, 1, "unused")).rejects.toThrow(BadRequestException);
                await expect(mockedService.quote(usdc, usdc, ChainType.EVM, 1, "unused")).rejects.toThrow(/non-positive quote/i);
            });

            it("throws a BadRequestException when the API returns a zero sellAmount", async () => {
                jest.spyOn(OrderBookApi.prototype, "getQuote").mockResolvedValue(fakeQuoteResponse("0", "50000000000000000"));

                const mockedService = await buildCowswapService();

                await expect(mockedService.quote(usdc, usdc, ChainType.EVM, 1, "unused")).rejects.toThrow(BadRequestException);
            });

            it("retries at a fee-derived amount when the first attempt is below the fee floor, and succeeds", async () => {
                const feeAmountHex = "0x1e8480"; // 2_000_000 (2 USDC), arbitrary for this test
                const getQuoteSpy = jest
                    .spyOn(OrderBookApi.prototype, "getQuote")
                    .mockRejectedValueOnce(
                        new OrderBookApiError({} as Response, {
                            errorType: "SellAmountDoesNotCoverFee",
                            data: { fee_amount: feeAmountHex },
                        })
                    )
                    .mockResolvedValueOnce(fakeQuoteResponse("9500000", "5000000000000000"));

                const mockedService = await buildCowswapService();
                const response = await mockedService.quote(usdc, usdc, ChainType.EVM, 1, "unused");

                expect(getQuoteSpy).toHaveBeenCalledTimes(2);
                const retryArgs = getQuoteSpy.mock.calls[1][0] as { sellAmountBeforeFee: string };
                expect(retryArgs.sellAmountBeforeFee).toBe((BigInt(feeAmountHex) * 10n).toString());
                expect(response.num).toBeGreaterThan(0n);
                expect(response.den).toBeGreaterThan(0n);
            });
        });
    });

    // Mock is pure computation (no RPC), so — like "Defensive guards" above — these run
    // unconditionally rather than being gated by itIfRpc.
    describe("Mock", () => {
        function token(overrides: Partial<TokenDescription> & Pick<TokenDescription, "ticker" | "chainId">): TokenDescription {
            return {
                address: "0x0000000000000000000000000000000000000001",
                quoter: RateProvider.MOCK,
                decimals: 18,
                chainType: ChainType.EVM,
                ...overrides,
            };
        }

        // Ethereum mainnet and Sepolia testnet share the ETH-priced (2100) branch;
        // Citrea mainnet and Citrea testnet share the cBTC-priced (63800) branch.
        const ETH_CHAIN_IDS = [1, 11155111];
        const CITREA_CHAIN_IDS = [4114, 5115];

        // Pure queryRate logic (ETH/CBTC pricing, case-insensitivity, fallback, unsupported
        // chain error) is covered by the colocated mock_sepolia_quote.spec.ts — not duplicated
        // here.

        // Exercises the same DI wiring quote.module.ts uses (real RATE_PROVIDER_DESCRIPTION),
        // across every chainId both the description and queryRate's branches agree on — see
        // the "Matrix" comment above for why this catches description/matrix drift.
        describe("via RateProviderService (real description)", () => {
            let service: RateProviderService;

            beforeEach(async () => {
                const module: TestingModule = await Test.createTestingModule({
                    providers: [
                        RateProviderService,
                        createMockLoggerProvider(),
                        { provide: "RATE_GETTER_FUNCTION", useValue: mock_sepolia_parameters.queryRate },
                        { provide: "RATE_PROVIDER_DESCRIPTION", useValue: mockDescription },
                    ],
                }).compile();
                service = module.get<RateProviderService>(RateProviderService);
            });

            it.each(CITREA_CHAIN_IDS)("quotes CBTC against a stablecoin (chainId %i)", async (chainId) => {
                const cbtc = token({ ticker: "CBTC", chainId });
                const usdc = token({ ticker: "USDC", chainId });

                const response = await service.quote(cbtc, usdc, ChainType.EVM, chainId, "unused");

                expect(response.num).toBe(63800n * 10n ** 18n);
            });

            it.each(ETH_CHAIN_IDS)("quotes a stablecoin against native ETH (chainId %i)", async (chainId) => {
                const usdc = token({ ticker: "USDC", chainId });
                const eth = token({ ticker: "ETH", chainId });

                const response = await service.quote(usdc, eth, ChainType.EVM, chainId, "unused");

                expect(response.num).toBe(10n ** 18n / 2100n);
            });
        });
    });
});
