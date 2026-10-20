import { Test, TestingModule } from "@nestjs/testing";
import { EvmDetailsService } from "./evm.details.service";
import { RelayerConfig } from "../config/relayer-config";
import { Chain } from "../config/chain";
import { ChainType } from "../config/enums";
import { createMockLoggerProvider } from "../test/mocks";
import { version as packageVersion } from "../../package.json";
import { YieldDiscoveryService } from "./yield-discovery.service";
import { installBigIntJson } from "../bigint-json";

const ENTRYPOINT = "0xe7fd6c857639E3a7cCf3Cd765B5816Cfc95C0890";
const POOL_VAULT = "0xE10c77548c31356805597Fc2c8430aB5b6Dfb56A";
const RELAY = "0x6996F478DF754Dc65bB437dc2df4272AFD647dB2";
const RELAY_SWAPS = "0x7430cc030d7eb8c83e76cd983996982c8c054204";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function fakeChain(id: number, name: string, relaySwaps?: string) {
    return {
        id,
        name,
        rpc_url: "http://localhost:8545",
        entrypoint_contract: ENTRYPOINT,
        relay_contract: RELAY,
        pool_vault_contract: POOL_VAULT,
        ...(relaySwaps !== undefined && { relay_swaps_contract: relaySwaps }),
        fee_receiver_address: "0x0000000000000000000000000000000000000001",
        signer_private_key: "0x0000000000000000000000000000000000000000000000000000000000000001",
        flat_fee_amount: 21000n,
        native_currency: { name: "Ether", symbol: "ETH", decimals: 18 },
        supported_assets: [
            {
                address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
                ticker: "ETH",
                quoter: "Mock",
                fee_bps: 10n,
                decimals: 18,
            },
        ],
    };
}

// The signer address behind fakeChain's `signer_private_key` (0x…01).
const SIGNER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const ROUTER = "0x00000000000000000000000000000000000030aa";
const WRAPPER = {
    ppToken: "0x00000000000000000000000000000000000030bb",
    underlying: "0x00000000000000000000000000000000000030cc",
    router: ROUTER,
    zap: "0x00000000000000000000000000000000000030dd",
    ppDecimals: 18,
    underlyingDecimals: 6,
    underlyingSymbol: "USDC",
};
const yieldDiscovery = { wrappersFor: jest.fn((chainId: number) => (chainId === 10 ? [WRAPPER] : [])) };

async function buildService(chains: ReturnType<typeof fakeChain>[]): Promise<EvmDetailsService> {
    const relayerConfig = {
        chain: (chainType: ChainType.EVM) => new Chain(chainType, chains as never),
        fullConfig: () => ({ chains: { evm: chains } }),
    };

    const module: TestingModule = await Test.createTestingModule({
        providers: [
            EvmDetailsService,
            createMockLoggerProvider(),
            { provide: RelayerConfig, useValue: relayerConfig },
            { provide: YieldDiscoveryService, useValue: yieldDiscovery },
        ],
    }).compile();

    return module.get<EvmDetailsService>(EvmDetailsService);
}

describe("EvmDetailsService", () => {
    describe("chainDetails", () => {
        it("returns the contracts block and swapsSupported=true when RelaySwaps is configured", async () => {
            const service = await buildService([fakeChain(10, "optimism", RELAY_SWAPS)]);

            const details = await service.chainDetails(10 as never);

            expect(details.contracts).toEqual({
                entrypoint: ENTRYPOINT,
                poolVault: POOL_VAULT,
                relay: RELAY,
                relaySwaps: RELAY_SWAPS,
            });
            expect(details.swapsSupported).toBe(true);
        });

        it("omits relaySwaps and reports swapsSupported=false when unset", async () => {
            const service = await buildService([fakeChain(10, "optimism")]);

            const details = await service.chainDetails(10 as never);

            expect(details.contracts.relaySwaps).toBeUndefined();
            expect("relaySwaps" in details.contracts).toBe(false);
            expect(details.swapsSupported).toBe(false);
        });

        it("publishes destination_calls_supported as destinationCallsSupported", async () => {
            const service = await buildService([{ ...fakeChain(10, "optimism"), destination_calls_supported: true }]);

            const details = await service.chainDetails(10 as never);

            expect(details.destinationCallsSupported).toBe(true);
        });

        it("reports destinationCallsSupported=false when the config omits it", async () => {
            const service = await buildService([fakeChain(10, "optimism", RELAY_SWAPS)]);

            const details = await service.chainDetails(10 as never);

            expect(details.destinationCallsSupported).toBe(false);
        });

        it("treats a zero-address RelaySwaps placeholder as unset", async () => {
            const service = await buildService([fakeChain(10, "optimism", ZERO_ADDRESS)]);

            const details = await service.chainDetails(10 as never);

            expect("relaySwaps" in details.contracts).toBe(false);
            expect(details.swapsSupported).toBe(false);
        });
    });

    describe("allDetails", () => {
        it("carries the package.json version and maps every chain's contracts", async () => {
            const service = await buildService([
                fakeChain(10, "optimism", RELAY_SWAPS),
                fakeChain(11155111, "sepolia", ZERO_ADDRESS),
            ]);

            const all = await service.allDetails();

            expect(all.version).toBe(packageVersion);
            expect(all.chains).toHaveLength(2);

            const optimism = all.chains.find((c) => c.id === 10);
            expect(optimism?.contracts.relaySwaps).toBe(RELAY_SWAPS);
            expect(optimism?.swapsSupported).toBe(true);
            expect(optimism?.type).toBe(ChainType.EVM);

            const sepolia = all.chains.find((c) => c.id === 11155111);
            expect(sepolia?.contracts).toEqual({
                entrypoint: ENTRYPOINT,
                poolVault: POOL_VAULT,
                relay: RELAY,
            });
            expect(sepolia?.swapsSupported).toBe(false);
        });

        it("skips non-EVM chains in a mixed config instead of throwing (chainless GET /details is EVM-only)", async () => {
            const chains = [fakeChain(10, "optimism", RELAY_SWAPS)];
            const relayerConfig = {
                chain: (chainType: ChainType.EVM) => new Chain(chainType, chains as never),
                fullConfig: () => ({
                    chains: {
                        evm: chains,
                        stellar: [{ id: 1, name: "stellar-testnet" }],
                    },
                }),
            };
            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    EvmDetailsService,
                    createMockLoggerProvider(),
                    { provide: RelayerConfig, useValue: relayerConfig },
                    { provide: YieldDiscoveryService, useValue: yieldDiscovery },
                ],
            }).compile();
            const service = module.get<EvmDetailsService>(EvmDetailsService);

            const all = await service.allDetails();

            expect(all.chains).toHaveLength(1);
            expect(all.chains[0]?.id).toBe(10);
        });
    });

    describe("discovery fields (minr #30)", () => {
        it("publishes the signer address, allowed_processors verbatim, and the boot-derived yield wrappers", async () => {
            const chain = { ...fakeChain(10, "optimism", RELAY_SWAPS), allowed_processors: [ROUTER] };
            const service = await buildService([chain]);

            const details = await service.chainDetails(10 as never);

            expect(details.relayerAddress).toBe(SIGNER);
            expect(details.processors).toEqual([ROUTER]);
            expect(details.yield).toEqual([WRAPPER]);
            expect(yieldDiscovery.wrappersFor).toHaveBeenCalledWith(10);
        });

        it("publishes empty processors and yield on a chain without routers", async () => {
            const service = await buildService([fakeChain(11155111, "sepolia")]);

            const details = await service.chainDetails(11155111 as never);

            expect(details.processors).toEqual([]);
            expect(details.yield).toEqual([]);
            expect(details.relayerAddress).toBe(SIGNER);
        });

        it("allDetails carries the same discovery fields per chain as chainDetails", async () => {
            const chain = { ...fakeChain(10, "optimism", RELAY_SWAPS), allowed_processors: [ROUTER] };
            const service = await buildService([chain, fakeChain(11155111, "sepolia")]);

            const all = await service.allDetails();

            expect(all.chains.map((c) => [c.id, c.processors, c.yield.length, c.relayerAddress])).toEqual([
                [10, [ROUTER], 1, SIGNER],
                [11155111, [], 0, SIGNER],
            ]);
        });
    });

    describe("enforced ceilings", () => {
        afterEach(() => {
            delete process.env.MAX_SWAP_VALUE_WEI_EVM_10;
        });

        it("publishes max_swap_value_wei, honoring the MAX_SWAP_VALUE_WEI_EVM_<id> override", async () => {
            const chain = {
                ...fakeChain(10, "optimism", RELAY_SWAPS),
                max_swap_value_wei: 5_000_000_000_000_000n,
            };
            const service = await buildService([chain]);

            const details = await service.chainDetails(10 as never);
            expect(details.maxSwapValueWei).toBe(5_000_000_000_000_000n);
            // max_native_gas_wei was removed (the client never picks the extraGas amount), so no
            // native-gas cap is published.
            expect(details).not.toHaveProperty("maxNativeGasWei");

            process.env.MAX_SWAP_VALUE_WEI_EVM_10 = "80000000000000000";
            expect((await service.chainDetails(10 as never)).maxSwapValueWei).toBe(80_000_000_000_000_000n);
        });

        it("serializes maxSwapValueWei (and fixedFeeAmount) as decimal strings on the wire", async () => {
            // The SDK's /details schema reads these as decimal strings; pin the encoding main.ts installs.
            installBigIntJson();
            const chain = {
                ...fakeChain(10, "optimism", RELAY_SWAPS),
                max_swap_value_wei: 5_000_000_000_000_000n,
            };
            const service = await buildService([chain]);

            const wire = JSON.parse(JSON.stringify(await service.chainDetails(10 as never)));

            expect(wire.maxSwapValueWei).toBe("5000000000000000");
            expect(wire.assets[0].fixedFeeAmount).toBe("21000");
        });
    });
});
