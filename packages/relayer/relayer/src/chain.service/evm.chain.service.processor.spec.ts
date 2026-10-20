import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { EVMChainService } from "./evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import { Bytes, EvmRelaySDKPayload, ReshapedProof } from "../relay/evm/types";

// Coverage for the PPRouter `withdrawToUnderlying` branch of
// `simulateAndWriteRelay` (code-review R1 TEST-1): when a payload carries a
// processorAddress, the call must target THAT address, use functionName
// `withdrawToUnderlying`, and append the minUnderlyingOut floor as the trailing
// arg. The default (no processor) branch must instead target the relay contract
// with functionName `relay`. viem clients are stubbed via the private
// client()/signer() accessors (same pattern as the roothistory spec).

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as Bytes;
const ROUTER = "0x7c7c871fbeb28f90a85d47868aa5245f370e142f" as const;
const RELAY_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

const minimalProof = {
    pA: [0n, 0n],
    pB: [
        [0n, 0n],
        [0n, 0n],
    ],
    pC: [0n, 0n],
    pubSignals: [[], [], [0n], [0n], [0n], [1n], [0n], [0n]],
    parsedPubSignals: { nullifierHashes: ["0xdeadbeef"] },
} as unknown as ReshapedProof;

function makePayload(overrides: Partial<EvmRelaySDKPayload> = {}): EvmRelaySDKPayload {
    return {
        proof: minimalProof,
        noteData: [],
        data: "0x00",
        ...overrides,
    } as unknown as EvmRelaySDKPayload;
}

describe("EVM chain service — simulateAndWriteRelay processor routing", () => {
    let service: EVMChainService;

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8545"),
        relayContractAddress: jest.fn().mockReturnValue(RELAY_CONTRACT),
    };

    function stubClients() {
        const simulateContract = jest.fn(async () => ({ request: { some: "request" } }));
        const writeContract = jest.fn(async () => TX_HASH);
        const mockPublicClient = {
            simulateContract,
            estimateContractGas: jest.fn(async () => 500_000n),
            getTransactionCount: jest.fn(async () => 0),
        };
        const mockWalletClient = {
            account: { address: "0x0000000000000000000000000000000000000001" },
            writeContract,
        };
        jest.spyOn(service as unknown as { client: () => unknown }, "client").mockResolvedValue(mockPublicClient);
        jest.spyOn(service as unknown as { signer: () => unknown }, "signer").mockResolvedValue(mockWalletClient);
        return { simulateContract, writeContract };
    }

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EVMChainService,
                { provide: EvmConfigService, useValue: mockConfigService },
                createMockLoggerProvider(),
                { provide: CHAIN_CONTEXT, useValue: { chainType: ChainType.EVM, chainId: "31337" } },
            ],
        }).compile();

        service = await module.resolve<EVMChainService>(EVMChainService);
        jest.clearAllMocks();
    });

    it("route through the PPRouter withdrawToUnderlying when a processorAddress is set", async () => {
        const { simulateContract, writeContract } = stubClients();
        const minUnderlyingOut = 990_000n;

        const result = await service.simulateAndWriteRelay(
            makePayload({ processorAddress: ROUTER, minUnderlyingOut })
        );

        expect(result).toBe(TX_HASH);
        expect(simulateContract).toHaveBeenCalledTimes(1);
        const [call] = simulateContract.mock.calls[0] as [Record<string, unknown>];
        expect(call.address).toBe(ROUTER);
        expect(call.functionName).toBe("withdrawToUnderlying");
        // args = [proof, {processor, data}, noteData, minUnderlyingOut]
        const args = call.args as unknown[];
        expect(args[3]).toBe(minUnderlyingOut);
        expect((args[1] as { processor: string }).processor).toBe(ROUTER);
        expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ some: "request" }));
    });

    it("default the router minUnderlyingOut arg to 0n when omitted", async () => {
        const { simulateContract } = stubClients();

        await service.simulateAndWriteRelay(makePayload({ processorAddress: ROUTER }));

        const [call] = simulateContract.mock.calls[0] as [Record<string, unknown>];
        expect((call.args as unknown[])[3]).toBe(0n);
    });

    it("route through the default relay contract when no processorAddress is set", async () => {
        const { simulateContract } = stubClients();

        await service.simulateAndWriteRelay(makePayload());

        const [call] = simulateContract.mock.calls[0] as [Record<string, unknown>];
        expect(call.address).toBe(RELAY_CONTRACT);
        expect(call.functionName).toBe("relay");
    });

    it("wrap a router simulation revert in a BadRequestException", async () => {
        const simulateContract = jest.fn(async () => {
            throw new Error("router reverted");
        });
        const mockPublicClient = {
            simulateContract,
            estimateContractGas: jest.fn(async () => 500_000n),
            getTransactionCount: jest.fn(async () => 0),
        };
        const mockWalletClient = {
            account: { address: "0x0000000000000000000000000000000000000001" },
            writeContract: jest.fn(),
        };
        jest.spyOn(service as unknown as { client: () => unknown }, "client").mockResolvedValue(mockPublicClient);
        jest.spyOn(service as unknown as { signer: () => unknown }, "signer").mockResolvedValue(mockWalletClient);

        await expect(
            service.simulateAndWriteRelay(makePayload({ processorAddress: ROUTER }))
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
