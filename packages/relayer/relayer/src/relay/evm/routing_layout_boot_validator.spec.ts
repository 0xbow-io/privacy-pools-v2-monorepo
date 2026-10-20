import { RoutingLayoutBootValidator } from "./routing_layout_boot_validator";
import { RELAY_SWAP_ROUTING_TYPEHASH } from "./swap_routing_abi";

// Mock only createPublicClient; keep http real.
const readContract = jest.fn();
jest.mock("viem", () => ({
    ...jest.requireActual("viem"),
    createPublicClient: () => ({ readContract }),
}));

const RELAY_SWAPS = "0x0000000000000000000000000000000000000044";
const STALE_TYPEHASH = `0x${"aa".repeat(32)}`;

// Raw config shape (snake_case) — production code now wraps this itself via
// `new EvmChainConfigWrapper(c)` (Chain<T>.allConfigs() returns raw configs, not wrappers).
function fakeChain(id: number, relaySwaps?: string) {
    return {
        id,
        name: `chain-${id}`,
        rpc_url: "http://localhost:8545",
        relay_swaps_contract: relaySwaps,
    };
}

// Reassigned fresh by buildValidator() on every call — tests read it back to
// assert on logger.turbo's arguments (e.g. dedupKey).
let logger = { info: jest.fn(), warn: jest.fn(), turbo: jest.fn(), error: jest.fn() };

function buildValidator(chains: ReturnType<typeof fakeChain>[]): RoutingLayoutBootValidator {
    const relayerConfig = { chain: () => ({ allConfigs: () => chains }) };
    logger = { info: jest.fn(), warn: jest.fn(), turbo: jest.fn(), error: jest.fn() };
    return new RoutingLayoutBootValidator(relayerConfig as never, logger as never);
}

describe("RoutingLayoutBootValidator", () => {
    beforeEach(() => readContract.mockReset());

    it("skips a chain with no relay_swaps_contract without any RPC call", async () => {
        const validator = buildValidator([fakeChain(1)]);
        await validator.onApplicationBootstrap();
        expect(readContract).not.toHaveBeenCalled();
    });

    it("passes when the on-chain ROUTING_TYPEHASH matches the relayer's own encoder", async () => {
        readContract.mockResolvedValue(RELAY_SWAP_ROUTING_TYPEHASH);
        const validator = buildValidator([fakeChain(1, RELAY_SWAPS)]);
        await expect(validator.onApplicationBootstrap()).resolves.not.toThrow();
        expect(readContract).toHaveBeenCalledWith(
            expect.objectContaining({ address: RELAY_SWAPS, functionName: "ROUTING_TYPEHASH" })
        );
    });

    it("fails boot when the on-chain ROUTING_TYPEHASH disagrees with the relayer's encoder", async () => {
        readContract.mockResolvedValue(STALE_TYPEHASH);
        const validator = buildValidator([fakeChain(1, RELAY_SWAPS)]);
        await expect(validator.onApplicationBootstrap()).rejects.toThrow(/RC-32/);
    });

    it("fails boot when the ROUTING_TYPEHASH read throws", async () => {
        readContract.mockRejectedValue(new Error("RPC down"));
        const validator = buildValidator([fakeChain(1, RELAY_SWAPS)]);
        await expect(validator.onApplicationBootstrap()).rejects.toThrow(/boot read failed/);
        expect(logger.turbo.mock.calls[0][1]).toMatchObject({ dedupKey: "relayer.routingLayoutBootValidator.1" });
    });

    it("checks every configured chain independently", async () => {
        const OTHER_RELAY_SWAPS = "0x0000000000000000000000000000000000000055";
        readContract.mockImplementation(({ address }: { address: string }) =>
            Promise.resolve(
                address.toLowerCase() === RELAY_SWAPS.toLowerCase()
                    ? RELAY_SWAP_ROUTING_TYPEHASH
                    : STALE_TYPEHASH
            )
        );
        const validator = buildValidator([fakeChain(1, RELAY_SWAPS), fakeChain(2, OTHER_RELAY_SWAPS)]);
        await expect(validator.onApplicationBootstrap()).rejects.toThrow(/chainId 2/);
    });
});
