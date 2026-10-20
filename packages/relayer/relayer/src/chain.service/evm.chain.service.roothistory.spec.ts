import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { MAX_BATCH } from "@privacy-pools-v2/core-sdk/batch-fee";
import { EVMChainService } from "./evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import { Bytes, EvmRelayBatchSDKPayload, ReshapedProof } from "../relay/evm/types";

// GAP-2: `assertBatchFitsRootHistory` (reached via `simulateAndWriteRelayBatch`)
// reads the pool's on-chain `rootHistorySize()` and the relay contract's
// `MAX_BATCH()`, then fails the batch fast if either invariant breaks:
//   1. MAX_BATCH must be STRICTLY BELOW the pool's rootHistorySize, else a
//      near-max batch's early-item state root is evicted before the batch lands
//      (PoolVault_UnknownStateRoot).
//   2. The on-chain relay MAX_BATCH() must equal this process's SDK MAX_BATCH,
//      else a contract/SDK drift silently mis-caps batches.
// Neither reject branch (nor the happy path) had any coverage. These specs drive
// `simulateAndWriteRelayBatch` with the viem clients stubbed so only the guard's
// on-chain reads are exercised.
//
// NOTE: `rootHistorySizeCache` / `relayMaxBatchCache` are MODULE-LEVEL maps keyed
// by pool / relay address and are NOT reset between tests. Each case therefore
// uses DISTINCT pool + relay addresses so a cached read from one case cannot
// poison another.

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as Bytes;

// A minimal reshaped proof — enough for `simulateAndWriteRelayBatch`'s
// `proofs.map(({ pA, pB, pC, pubSignals }) => ...)` in the happy-path case.
const minimalProof = {
    pA: [0n, 0n],
    pB: [
        [0n, 0n],
        [0n, 0n],
    ],
    pC: [0n, 0n],
    pubSignals: [[], [], [0n], [0n], [0n], [1n], [0n], [0n]],
    parsedPubSignals: {
        nullifierHashes: [],
        outputCommitments: [],
        stateRoot: "0x0",
        keyRegistryRoot: "0x0",
        associationSetRoot: "0x0",
        amountOut: 1n,
        tokenIdOut: 0n,
        context: "0x0",
    },
} as unknown as ReshapedProof;

function makePayload(): EvmRelayBatchSDKPayload {
    return {
        proofs: [minimalProof],
        transactParams: [{ processor: "0x0000000000000000000000000000000000000000", data: "0x00" }],
        noteData: [[]],
    } as unknown as EvmRelayBatchSDKPayload;
}

describe("EVM chain service — assertBatchFitsRootHistory fail-fast", () => {
    let service: EVMChainService;
    let poolAddress: string;
    let relayAddress: string;

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8545"),
        poolVaultContractAddress: jest.fn(),
        relayContractAddress: jest.fn(),
    };

    // Builds a fake public client whose `readContract` answers the two on-chain
    // reads the guard makes, dispatching on `functionName`.
    function stubClients(opts: {
        rootHistorySize: bigint;
        contractMaxBatch: bigint;
        onSimulate?: jest.Mock;
        onWrite?: jest.Mock;
    }) {
        const readContract = jest.fn(async (args: { functionName: string }) => {
            if (args.functionName === "rootHistorySize") return opts.rootHistorySize;
            if (args.functionName === "MAX_BATCH") return opts.contractMaxBatch;
            throw new Error(`unexpected readContract functionName: ${args.functionName}`);
        });
        const simulateContract = opts.onSimulate ?? jest.fn(async () => ({ request: {} }));
        const mockPublicClient = {
            readContract,
            simulateContract,
            estimateContractGas: jest.fn(async () => 500_000n),
            // Stuck-nonce check (checkAndFixStuckNonce) reads this first; a constant
            // value takes its "healthy, nothing to do" fast path every call here.
            getTransactionCount: jest.fn(async () => 0),
        };
        const mockWalletClient = {
            account: { address: "0x0000000000000000000000000000000000000001" },
            writeContract: opts.onWrite ?? jest.fn(async () => TX_HASH),
        };
        jest.spyOn(service as unknown as { client: () => unknown }, "client").mockResolvedValue(
            mockPublicClient
        );
        jest.spyOn(service as unknown as { signer: () => unknown }, "signer").mockResolvedValue(
            mockWalletClient
        );
        return { readContract, simulateContract, mockWalletClient };
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

    it(`rejects when rootHistorySize equals MAX_BATCH (${MAX_BATCH}) — must be strictly below`, async () => {
        // Distinct addresses for this case (cache isolation).
        poolAddress = "0x1111111111111111111111111111111111111111";
        relayAddress = "0xaaaa000000000000000000000000000000000001";
        mockConfigService.poolVaultContractAddress.mockReturnValue(poolAddress);
        mockConfigService.relayContractAddress.mockReturnValue(relayAddress);

        const { simulateContract } = stubClients({
            rootHistorySize: BigInt(MAX_BATCH),
            contractMaxBatch: BigInt(MAX_BATCH),
        });

        await expect(service.simulateAndWriteRelayBatch(makePayload())).rejects.toThrow(
            /must be strictly below pool rootHistorySize/
        );
        await expect(service.simulateAndWriteRelayBatch(makePayload())).rejects.toBeInstanceOf(
            BadRequestException
        );
        // Guard short-circuits before the on-chain simulate/write.
        expect(simulateContract).not.toHaveBeenCalled();
    });

    it("rejects when the relay contract MAX_BATCH() differs from the SDK MAX_BATCH — drift", async () => {
        poolAddress = "0x2222222222222222222222222222222222222222";
        relayAddress = "0xaaaa000000000000000000000000000000000002";
        mockConfigService.poolVaultContractAddress.mockReturnValue(poolAddress);
        mockConfigService.relayContractAddress.mockReturnValue(relayAddress);

        const { simulateContract } = stubClients({
            // rootHistorySize is fine (> MAX_BATCH), so the first guard passes and
            // the drift guard is reached.
            rootHistorySize: 64n,
            contractMaxBatch: BigInt(MAX_BATCH - 1),
        });

        await expect(service.simulateAndWriteRelayBatch(makePayload())).rejects.toThrow(
            /does not match relay contract MAX_BATCH/
        );
        expect(simulateContract).not.toHaveBeenCalled();
    });

    it("proceeds to simulate + write when rootHistorySize > MAX_BATCH and MAX_BATCH() matches", async () => {
        poolAddress = "0x3333333333333333333333333333333333333333";
        relayAddress = "0xaaaa000000000000000000000000000000000003";
        mockConfigService.poolVaultContractAddress.mockReturnValue(poolAddress);
        mockConfigService.relayContractAddress.mockReturnValue(relayAddress);

        const simulateContract = jest.fn(async () => ({ request: { some: "request" } }));
        const writeContract = jest.fn(async () => TX_HASH);
        const { mockWalletClient } = stubClients({
            rootHistorySize: 64n,
            contractMaxBatch: BigInt(MAX_BATCH),
            onSimulate: simulateContract,
            onWrite: writeContract,
        });

        const result = await service.simulateAndWriteRelayBatch(makePayload());

        expect(result).toBe(TX_HASH);
        expect(simulateContract).toHaveBeenCalledTimes(1);
        expect(mockWalletClient.writeContract).toHaveBeenCalledWith(expect.objectContaining({ some: "request" }));
    });
});
