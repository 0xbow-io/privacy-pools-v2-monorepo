import { Test, TestingModule } from "@nestjs/testing";
import { EVMChainService } from "./evm.chain.service";
import type { ConnectedWalletClient } from "./evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import { Bytes, EvmRelaySDKPayload, ReshapedProof } from "../relay/evm/types";

// Nonce assignment (stuck-nonce.ts: withSignerLock / nextNonce /
// sendWithAssignedNonce / resolveBroadcastFees), exercised through
// EVMChainService's write paths. The relayer no longer uses viem's
// nonceManager: its cache trusts itself over the RPC forever, so one evicted
// broadcast queued every later nonce behind a gap (mainnet 98-100,
// 2026-09-30). Each test uses its own chainId: stuck-nonce.ts's module-level
// state (locks, last assignment, outstanding nonces) is NOT reset between tests.

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SIGNER_ADDRESS = "0x0000000000000000000000000000000000000009" as const;
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as const;

const minimalProof = {
    pA: [0n, 0n],
    pB: [
        [0n, 0n],
        [0n, 0n],
    ],
    pC: [0n, 0n],
    pubSignals: [[], [], [0n], [0n], [0n], [1n], [0n], [0n]],
    parsedPubSignals: { nullifierHashes: ["0xnonce"] },
} as unknown as ReshapedProof;

function relayPayload(nullifier: string): EvmRelaySDKPayload {
    return {
        proof: { ...minimalProof, parsedPubSignals: { nullifierHashes: [nullifier] } },
        noteData: [],
        data: "0x00",
    } as unknown as EvmRelaySDKPayload;
}

interface Counts {
    latest: number;
    pending: number;
}

describe("EVM chain service — nonce management", () => {
    let service: EVMChainService;

    // signer() is private; cast through this alias to invoke it in tests.
    interface ServicePrivate {
        signer(): Promise<ConnectedWalletClient>;
    }

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8545"),
        relayContractAddress: jest.fn().mockReturnValue("0x5FbDB2315678afecb367f032d93F642f64180aa3"),
    };

    async function makeService(chainId: string): Promise<EVMChainService> {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EVMChainService,
                { provide: EvmConfigService, useValue: mockConfigService },
                createMockLoggerProvider(),
                { provide: CHAIN_CONTEXT, useValue: { chainType: ChainType.EVM, chainId } },
            ],
        }).compile();
        return module.resolve<EVMChainService>(EVMChainService);
    }

    function stubClients(counts: Counts, opts: { baseFeePerGas?: bigint; rpcTip?: bigint } = {}) {
        const getTransactionCount = jest.fn(async ({ blockTag }: { blockTag: "latest" | "pending" }) =>
            blockTag === "latest" ? counts.latest : counts.pending
        );
        const writeContract = jest.fn(async (_args: Record<string, unknown>) => TX_HASH);
        const publicClient = {
            simulateContract: jest.fn(async () => ({ request: { some: "request" } })),
            estimateContractGas: jest.fn(async () => 500_000n),
            getTransactionCount,
            getBlock: jest.fn(async () => ({ transactions: [], baseFeePerGas: opts.baseFeePerGas })),
            estimateMaxPriorityFeePerGas: jest.fn(async () => opts.rpcTip ?? 0n),
            getGasPrice: jest.fn(async () => 1_000_000_000n),
            getTransaction: jest.fn(async () => ({ nonce: counts.pending })),
        };
        jest.spyOn(service as unknown as { client: () => Promise<unknown> }, "client").mockResolvedValue(publicClient);
        jest.spyOn(service as unknown as { signer: () => Promise<unknown> }, "signer").mockResolvedValue({
            account: { address: SIGNER_ADDRESS },
            writeContract,
        });
        return { writeContract, getTransactionCount };
    }

    const noncesSent = (writeContract: jest.Mock) =>
        writeContract.mock.calls.map((call) => (call[0] as { nonce?: number }).nonce);

    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.MIN_PRIORITY_FEE_WEI_EVM_50006;
    });

    it("does not attach viem's nonceManager to the signer account", async () => {
        service = await makeService("50000");
        const walletClient = await (service as unknown as ServicePrivate).signer();
        expect((walletClient.account as { nonceManager?: unknown }).nonceManager).toBeUndefined();
    });

    it("passes the RPC's pending count as an explicit nonce", async () => {
        service = await makeService("50001");
        const { writeContract } = stubClients({ latest: 7, pending: 7 });

        await service.simulateAndWriteRelay(relayPayload("0xa1"));

        expect(noncesSent(writeContract)).toEqual([7]);
    });

    it("concurrent writes in one process get consecutive nonces even before the RPC reflects the first", async () => {
        service = await makeService("50002");
        const { writeContract } = stubClients({ latest: 10, pending: 10 }); // RPC never catches up

        await Promise.all([
            service.simulateAndWriteRelay(relayPayload("0xb1")),
            service.simulateAndWriteRelay(relayPayload("0xb2")),
        ]);

        expect(noncesSent(writeContract)).toEqual([10, 11]);
    });

    it("regression 2026-09-30: an evicted broadcast's nonce is refilled by the next write, not skipped", async () => {
        // viem's nonceManager returned cache+1 (99) while the chain still
        // expected 98, queuing the transfer behind a gap forever. Past the
        // local-trust window the chain's `pending` count wins again.
        service = await makeService("50003");
        const { writeContract } = stubClients({ latest: 98, pending: 98 });

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xc1")); // sends 98

        // 98 is evicted, so `pending` stays 98. 40s later (past the 30s
        // local trust, under the 120s stuck timeout, so no cancel fires).
        dateSpy.mockReturnValue(now + 40_000);
        await service.simulateAndWriteRelay(relayPayload("0xc2"));

        expect(noncesSent(writeContract)).toEqual([98, 98]);
    });

    it("retries once, one nonce higher, when the node reports the nonce already taken", async () => {
        service = await makeService("50004");
        const { writeContract } = stubClients({ latest: 20, pending: 20 });
        writeContract.mockRejectedValueOnce(new Error("nonce too low: next nonce 21, tx nonce 20"));

        await expect(service.simulateAndWriteRelay(relayPayload("0xd1"))).resolves.toBe(TX_HASH);

        expect(noncesSent(writeContract)).toEqual([20, 21]);
    });

    it("does not retry a failure unrelated to the nonce", async () => {
        service = await makeService("50005");
        const { writeContract } = stubClients({ latest: 30, pending: 30 });
        writeContract.mockRejectedValueOnce(new Error("execution reverted"));

        await expect(service.simulateAndWriteRelay(relayPayload("0xe1"))).rejects.toThrow();

        expect(writeContract).toHaveBeenCalledTimes(1);
    });

    it("tip floor: raises a zero RPC tip to the configured floor, maxFee = 2 x base + tip", async () => {
        service = await makeService("50006");
        process.env.MIN_PRIORITY_FEE_WEI_EVM_50006 = "50000000"; // 0.05 gwei
        const { writeContract } = stubClients(
            { latest: 40, pending: 40 },
            { baseFeePerGas: 300_000_000n, rpcTip: 0n }
        );

        await service.simulateAndWriteRelay(relayPayload("0xf1"));

        expect(writeContract).toHaveBeenCalledWith(
            expect.objectContaining({ maxPriorityFeePerGas: 50_000_000n, maxFeePerGas: 650_000_000n })
        );
    });

    it("tip floor: unset (default 0) leaves fee selection to viem", async () => {
        service = await makeService("50007");
        const { writeContract } = stubClients({ latest: 50, pending: 50 }, { baseFeePerGas: 300_000_000n });

        await service.simulateAndWriteRelay(relayPayload("0xg1"));

        const sent = writeContract.mock.calls[0][0] as Record<string, unknown>;
        expect(sent.maxPriorityFeePerGas).toBeUndefined();
        expect(sent.maxFeePerGas).toBeUndefined();
    });
});
