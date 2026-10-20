import { Test, TestingModule } from "@nestjs/testing";
import { DiscoveryService } from "@nestjs/core";
import { RateProviderBootValidator } from "./rate_provider_boot_validator";
import { RelayerConfig } from "../config/relayer-config";
import { ChainType } from "../config/enums";
import { RateProvider } from "./rate_types";

function fakeAsset(
    overrides: Partial<{ address: string; ticker: string; quoter: RateProvider; underlying: string; zap: string }> = {}
) {
    return {
        address: "0x0000000000000000000000000000000000000001",
        ticker: "USDC",
        quoter: RateProvider.CURVE,
        decimals: 6,
        ...overrides,
    };
}

// Raw config shape (snake_case) — production code now wraps this itself via
// `new EvmChainConfigWrapper(c)` (Chain<T>.allConfigs() returns raw configs, not wrappers).
function fakeChainConfig(
    id: number,
    allAssets: ReturnType<typeof fakeAsset>[],
    relaySwaps?: string
) {
    return { id, supported_assets: allAssets, relay_swaps_contract: relaySwaps };
}

function fakeProvider(token: RateProvider, knownChainIds: number[]) {
    return {
        token,
        instance: {
            getDescription: () => ({
                provider: token,
                known_currencies: knownChainIds.map((chainId) => ({
                    chainType: ChainType.EVM,
                    chainId,
                    assetId: "*",
                })),
            }),
        },
    };
}

async function buildValidator(
    chainConfigs: ReturnType<typeof fakeChainConfig>[],
    providers: ReturnType<typeof fakeProvider>[]
): Promise<RateProviderBootValidator> {
    const relayerConfig = {
        chain: () => ({ allConfigs: () => chainConfigs }),
    };
    const discoveryService = {
        getProviders: () => providers,
    };

    const module: TestingModule = await Test.createTestingModule({
        providers: [
            RateProviderBootValidator,
            { provide: RelayerConfig, useValue: relayerConfig },
            { provide: DiscoveryService, useValue: discoveryService },
        ],
    }).compile();

    return module.get<RateProviderBootValidator>(RateProviderBootValidator);
}

describe("RateProviderBootValidator", () => {
    it("passes when every configured asset's quoter supports its chain", async () => {
        const validator = await buildValidator(
            [fakeChainConfig(1, [fakeAsset({ quoter: RateProvider.CURVE })])],
            [fakeProvider(RateProvider.CURVE, [1])]
        );

        expect(() => validator.onApplicationBootstrap()).not.toThrow();
    });

    it("throws when the quoter doesn't support the asset's chain", async () => {
        const validator = await buildValidator(
            [fakeChainConfig(11155111, [fakeAsset({ quoter: RateProvider.CURVE })])],
            [fakeProvider(RateProvider.CURVE, [1])]
        );

        expect(() => validator.onApplicationBootstrap()).toThrow(/does not support chainId=11155111/);
    });

    it("throws when no provider is registered for the asset's quoter", async () => {
        const validator = await buildValidator(
            [fakeChainConfig(1, [fakeAsset({ quoter: RateProvider.MOCK })])],
            [fakeProvider(RateProvider.CURVE, [1])]
        );

        expect(() => validator.onApplicationBootstrap()).toThrow(/No rate provider registered/);
    });

    it("accepts a sentinel-addressed native asset with the Native quoter and no providers registered", async () => {
        const validator = await buildValidator(
            [
                fakeChainConfig(11155111, [
                    fakeAsset({
                        // checksummed sentinel — the native check must be case-insensitive
                        address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
                        ticker: "ETH",
                        quoter: RateProvider.NATIVE,
                    }),
                ]),
            ],
            [] // no providers registered at all — the native path must never look one up
        );

        expect(() => validator.onApplicationBootstrap()).not.toThrow();
    });

    it("accepts a non-ETH native (cBTC on Citrea) by its sentinel address", async () => {
        const validator = await buildValidator(
            [
                fakeChainConfig(4114, [
                    fakeAsset({
                        address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
                        ticker: "cBTC",
                        quoter: RateProvider.NATIVE,
                    }),
                ]),
            ],
            []
        );

        expect(() => validator.onApplicationBootstrap()).not.toThrow();
    });

    it("accepts WETH by ticker with the Native quoter", async () => {
        const validator = await buildValidator(
            [fakeChainConfig(11155111, [fakeAsset({ ticker: "WETH", quoter: RateProvider.NATIVE })])],
            []
        );

        expect(() => validator.onApplicationBootstrap()).not.toThrow();
    });

    it("rejects a native asset that names a real quoter (misleading no-op)", async () => {
        const validator = await buildValidator(
            [
                fakeChainConfig(1, [
                    fakeAsset({
                        address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
                        ticker: "ETH",
                        quoter: RateProvider.CURVE,
                    }),
                ]),
            ],
            [fakeProvider(RateProvider.CURVE, [1])] // Curve DOES support chain 1 — still rejected
        );

        expect(() => validator.onApplicationBootstrap()).toThrow(/must use quoter "Native" \(got "Curve"\)/);
    });

    it("rejects WETH that names a real quoter", async () => {
        const validator = await buildValidator(
            [fakeChainConfig(1, [fakeAsset({ ticker: "WETH", quoter: RateProvider.MOCK })])],
            [fakeProvider(RateProvider.MOCK, [1])]
        );

        expect(() => validator.onApplicationBootstrap()).toThrow(/must use quoter "Native" \(got "Mock"\)/);
    });

    it("rejects a non-native ERC-20 that uses the Native quoter", async () => {
        const validator = await buildValidator(
            [fakeChainConfig(1, [fakeAsset({ ticker: "USDC", quoter: RateProvider.NATIVE })])],
            [fakeProvider(RateProvider.CURVE, [1])]
        );

        expect(() => validator.onApplicationBootstrap()).toThrow(/cannot use quoter "Native"/);
    });

    describe("quoter Underlying (ERC-4626 share tokens)", () => {
        const USDC = "0x000000000000000000000000000000000000000a";
        const PP_USDC = "0x000000000000000000000000000000000000000b";

        it("accepts a share token whose underlying is a configured asset with a real quoter", async () => {
            const validator = await buildValidator(
                [
                    fakeChainConfig(1, [
                        fakeAsset({ address: USDC, ticker: "USDC", quoter: RateProvider.CURVE }),
                        // Checksum-different casing: lookup must be case-insensitive.
                        fakeAsset({ address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC.toUpperCase().replace("0X", "0x") }),
                    ]),
                ],
                [fakeProvider(RateProvider.CURVE, [1])]
            );
            expect(() => validator.onApplicationBootstrap()).not.toThrow();
        });

        it("rejects a share token with no underlying", async () => {
            const validator = await buildValidator(
                [fakeChainConfig(1, [fakeAsset({ address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING })])],
                []
            );
            expect(() => validator.onApplicationBootstrap()).toThrow(/has no `underlying` address/);
        });

        it("rejects a share token whose underlying is not in supported_assets", async () => {
            const validator = await buildValidator(
                [fakeChainConfig(1, [fakeAsset({ address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC })])],
                []
            );
            expect(() => validator.onApplicationBootstrap()).toThrow(/is not in this chain's supported_assets/);
        });

        it("accepts a Native-treated underlying — ppETH over WETH (native-mode PPRouter) prices 1:1 to gas", async () => {
            const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
            const wethUnderlying = await buildValidator(
                [
                    fakeChainConfig(1, [
                        fakeAsset({ address: WETH, ticker: "WETH", quoter: RateProvider.NATIVE }),
                        fakeAsset({ address: PP_USDC, ticker: "ppETH", quoter: RateProvider.UNDERLYING, underlying: WETH }),
                    ]),
                ],
                []
            );
            expect(() => wethUnderlying.onApplicationBootstrap()).not.toThrow();
            const sentinelUnderlying = await buildValidator(
                [
                    fakeChainConfig(1, [
                        fakeAsset({ address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", ticker: "ETH", quoter: RateProvider.NATIVE }),
                        fakeAsset({ address: PP_USDC, ticker: "ppETH", quoter: RateProvider.UNDERLYING, underlying: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" }),
                    ]),
                ],
                []
            );
            expect(() => sentinelUnderlying.onApplicationBootstrap()).not.toThrow();
        });

        it("rejects a chained underlying (a share over a share)", async () => {

            const chained = await buildValidator(
                [
                    fakeChainConfig(1, [
                        fakeAsset({ address: USDC, ticker: "USDC", quoter: RateProvider.CURVE }),
                        fakeAsset({ address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC }),
                        fakeAsset({ address: "0x000000000000000000000000000000000000000c", ticker: "ppppUSDC", quoter: RateProvider.UNDERLYING, underlying: PP_USDC }),
                    ]),
                ],
                [fakeProvider(RateProvider.CURVE, [1])]
            );
            expect(() => chained.onApplicationBootstrap()).toThrow(/chained wrappers are not supported/);
        });

        it("rejects `underlying` on a native-treated asset (Native quoter) too", async () => {
            const validator = await buildValidator(
                [
                    fakeChainConfig(1, [
                        fakeAsset({
                            address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
                            ticker: "ETH",
                            quoter: RateProvider.NATIVE,
                            underlying: USDC,
                        }),
                    ]),
                ],
                []
            );
            expect(() => validator.onApplicationBootstrap()).toThrow(/only meaningful with quoter "Underlying"/);
        });

        const ZAP = "0x000000000000000000000000000000000000000d";
        const RELAY_SWAPS = "0x000000000000000000000000000000000000000e";

        it("no longer requires a zap on a share when the chain has a RelaySwaps deployment (YieldZapRegistry derives it on-chain at boot)", async () => {
            const validator = await buildValidator(
                [
                    fakeChainConfig(
                        1,
                        [
                            fakeAsset({ address: USDC, ticker: "USDC", quoter: RateProvider.CURVE }),
                            fakeAsset({ address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC }),
                        ],
                        RELAY_SWAPS
                    ),
                ],
                [fakeProvider(RateProvider.CURVE, [1])]
            );
            expect(() => validator.onApplicationBootstrap()).not.toThrow();
        });

        it("accepts a share with a zap on a swap chain, and one without on a chain with no RelaySwaps", async () => {
            const withZap = await buildValidator(
                [
                    fakeChainConfig(
                        1,
                        [
                            fakeAsset({ address: USDC, ticker: "USDC", quoter: RateProvider.CURVE }),
                            fakeAsset({ address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC, zap: ZAP }),
                        ],
                        RELAY_SWAPS
                    ),
                ],
                [fakeProvider(RateProvider.CURVE, [1])]
            );
            expect(() => withZap.onApplicationBootstrap()).not.toThrow();
            const noSwaps = await buildValidator(
                [
                    fakeChainConfig(1, [
                        fakeAsset({ address: USDC, ticker: "USDC", quoter: RateProvider.CURVE }),
                        fakeAsset({ address: PP_USDC, ticker: "ppUSDC", quoter: RateProvider.UNDERLYING, underlying: USDC }),
                    ]),
                ],
                [fakeProvider(RateProvider.CURVE, [1])]
            );
            expect(() => noSwaps.onApplicationBootstrap()).not.toThrow();
        });

        it("rejects `zap` on an asset that uses a real quoter", async () => {
            const validator = await buildValidator(
                [fakeChainConfig(1, [fakeAsset({ address: USDC, ticker: "USDC", quoter: RateProvider.CURVE, zap: ZAP })])],
                [fakeProvider(RateProvider.CURVE, [1])]
            );
            expect(() => validator.onApplicationBootstrap()).toThrow(/`zap` is only meaningful with quoter "Underlying"/);
        });

        it("rejects `underlying` on an asset that uses a real quoter", async () => {
            const validator = await buildValidator(
                [fakeChainConfig(1, [fakeAsset({ address: USDC, ticker: "USDC", quoter: RateProvider.CURVE, underlying: PP_USDC })])],
                [fakeProvider(RateProvider.CURVE, [1])]
            );
            expect(() => validator.onApplicationBootstrap()).toThrow(/only meaningful with quoter "Underlying"/);
        });
    });

    it("validates an ETH-ticker asset at a non-sentinel address", async () => {
        const validator = await buildValidator(
            [fakeChainConfig(11155111, [fakeAsset({ ticker: "ETH", quoter: RateProvider.CURVE })])],
            [fakeProvider(RateProvider.CURVE, [1])]
        );

        expect(() => validator.onApplicationBootstrap()).toThrow(/does not support chainId=11155111/);
    });
});
