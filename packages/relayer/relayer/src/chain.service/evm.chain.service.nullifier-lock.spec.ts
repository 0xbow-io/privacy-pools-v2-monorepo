import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { EVMChainService } from "./evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import type { Bytes, EvmRelaySDKPayload, EvmRelayBatchSDKPayload, ReshapedProof } from "../relay/evm/types";

// Per-nullifier in-flight lock.
//
// withNullifierLock guards every simulateAndWrite* method. It checks each
// nullifier in the incoming request against a module-level Set of in-flight
// nullifiers; if any match it throws BadRequestException immediately, before
// simulateContract is called. If no match, all nullifiers are locked for the
// duration of the broadcast and released (via finally) when it settles.
//
// Tests drive the lock through simulateAndWriteRelay (non-router branch) and
// simulateAndWriteRelayBatch. Each test uses distinct nullifier hashes to avoid
// interference from the module-level Set that persists across tests.

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as Bytes;
const SIGNER_ADDRESS = "0x0000000000000000000000000000000000000001" as const;
const RELAY_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

describe("EVM chain service — per-nullifier in-flight lock", () => {
    let service: EVMChainService;

    interface ServicePrivate { client(): Promise<unknown>; signer(): Promise<unknown> }

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8545"),
        relayContractAddress: jest.fn().mockReturnValue(RELAY_CONTRACT),
    };

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

    function stubClients(writeContractMock?: jest.Mock) {
        const simulateContract = jest.fn(async () => ({ request: {} }));
        const writeContract = writeContractMock ?? jest.fn(async () => TX_HASH);
        jest.spyOn(service as unknown as ServicePrivate, "client").mockResolvedValue({
            simulateContract,
            estimateContractGas: jest.fn(async () => 500_000n),
            getTransactionCount: jest.fn(async () => 0),
        });
        jest.spyOn(service as unknown as ServicePrivate, "signer").mockResolvedValue({
            account: { address: SIGNER_ADDRESS },
            writeContract,
        });
        return { simulateContract, writeContract };
    }

    function makePayload(nullifierHashes: string[]): EvmRelaySDKPayload {
        return {
            proof: {
                pA: [0n, 0n],
                pB: [[0n, 0n], [0n, 0n]],
                pC: [0n, 0n],
                pubSignals: [nullifierHashes.map(() => 0n), [], [0n], [0n], [0n], [1n], [0n], [0n]],
                parsedPubSignals: { nullifierHashes },
            } as unknown as ReshapedProof,
            noteData: [],
            data: "0x00",
        } as unknown as EvmRelaySDKPayload;
    }

    function makeBatchPayload(nullifierSets: string[][]): EvmRelayBatchSDKPayload {
        return {
            proofs: nullifierSets.map((hashes) => ({
                pA: [0n, 0n], pB: [[0n, 0n], [0n, 0n]], pC: [0n, 0n],
                pubSignals: [],
                parsedPubSignals: { nullifierHashes: hashes },
            })) as unknown as ReshapedProof[],
            transactParams: [],
            noteData: [],
        };
    }

    it("permits a request when no nullifier is in-flight", async () => {
        stubClients();
        await expect(service.simulateAndWriteRelay(makePayload(["0x1111"]))).resolves.toBe(TX_HASH);
    });

    it("rejects a concurrent duplicate and names the colliding nullifier in the error", async () => {
        stubClients();

        // Both calls are dispatched synchronously. withNullifierLock adds the
        // nullifier to the Set during the first call's synchronous setup, so by
        // the time the second call's withNullifierLock runs (still in the same
        // tick), the nullifier is already present and the throw is immediate.
        const first = service.simulateAndWriteRelay(makePayload(["0x2222"]));
        const second = service.simulateAndWriteRelay(makePayload(["0x2222"]));

        await expect(second).rejects.toBeInstanceOf(BadRequestException);
        await expect(second).rejects.toMatchObject({
            message: expect.stringContaining("0x2222"),
        });
        await expect(second).rejects.toMatchObject({
            message: expect.stringContaining("in-flight"),
        });

        await first; // settle so the Set is clean before the next test
    });

    it("releases the lock after a successful broadcast so a later retry succeeds", async () => {
        stubClients();

        await service.simulateAndWriteRelay(makePayload(["0x3333"]));
        // Lock is released by the finally block once the promise settled above.
        await expect(service.simulateAndWriteRelay(makePayload(["0x3333"]))).resolves.toBe(TX_HASH);
    });

    it("releases the lock after a simulation failure so a later retry can proceed", async () => {
        const simulateContract = jest
            .fn()
            .mockRejectedValueOnce(new Error("contract reverted"))
            .mockResolvedValue({ request: {} });
        jest.spyOn(service as unknown as ServicePrivate, "client").mockResolvedValue({
            simulateContract,
            estimateContractGas: jest.fn(async () => 500_000n),
            getTransactionCount: jest.fn(async () => 0),
        });
        jest.spyOn(service as unknown as ServicePrivate, "signer").mockResolvedValue({
            account: { address: SIGNER_ADDRESS },
            writeContract: jest.fn(async () => TX_HASH),
        });

        await expect(service.simulateAndWriteRelay(makePayload(["0x4444"]))).rejects.toBeInstanceOf(
            BadRequestException
        );

        // finally ran on rejection — lock must be gone.
        await expect(service.simulateAndWriteRelay(makePayload(["0x4444"]))).resolves.toBe(TX_HASH);
    });

    it("rejects a batch whose nullifiers overlap with an in-flight single relay", async () => {
        stubClients();

        // Single-relay acquires 0x5555. Batch arrives with [0x5555, 0x6666] — the
        // overlap on 0x5555 is caught inside withNullifierLock before fn() is even
        // called, so assertBatchFitsRootHistory is never reached.
        const relay = service.simulateAndWriteRelay(makePayload(["0x5555"]));
        const batch = service.simulateAndWriteRelayBatch(makeBatchPayload([["0x5555", "0x6666"]]));

        await expect(batch).rejects.toBeInstanceOf(BadRequestException);
        await expect(batch).rejects.toMatchObject({
            message: expect.stringContaining("0x5555"),
        });

        await relay;
    });

    it("rejects a request when any of multiple nullifiers in the proof is already in-flight", async () => {
        stubClients();

        // First relay locks 0x7777.
        const first = service.simulateAndWriteRelay(makePayload(["0x7777"]));

        // Second proof carries [0x8888, 0x7777] — the second nullifier collides.
        const second = service.simulateAndWriteRelay(makePayload(["0x8888", "0x7777"]));

        await expect(second).rejects.toBeInstanceOf(BadRequestException);
        await expect(second).rejects.toMatchObject({
            message: expect.stringContaining("0x7777"),
        });

        await first;
    });
});
