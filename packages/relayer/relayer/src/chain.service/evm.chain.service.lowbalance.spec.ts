import { Test, TestingModule } from "@nestjs/testing";
import { EVMChainService } from "./evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { createMockLogger } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import { Bytes, EvmRelaySDKPayload, ReshapedProof } from "../relay/evm/types";

// Low-balance alert (checkSignerBalance): fire-and-forget after every broadcast, paging via
// { alert: true } when the signer is below LOW_BALANCE_ALERT_WEI_EVM_<id>. Each test uses its own
// chainId: stuck-nonce.ts's module-level nonce state is NOT reset between tests.

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SIGNER_ADDRESS = "0x0000000000000000000000000000000000000009" as const;
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as const;

function relayPayload(nullifier: string): EvmRelaySDKPayload {
    return {
        proof: {
            pA: [0n, 0n],
            pB: [
                [0n, 0n],
                [0n, 0n],
            ],
            pC: [0n, 0n],
            pubSignals: [[], [], [0n], [0n], [0n], [1n], [0n], [0n]],
            parsedPubSignals: { nullifierHashes: [nullifier] },
        } as unknown as ReshapedProof,
        noteData: [],
        data: "0x00",
    } as unknown as EvmRelaySDKPayload;
}

// Lets the detached balance check (and the nonce log next to it) settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("EVM chain service — low signer balance alert", () => {
    let service: EVMChainService;
    let logger: ReturnType<typeof createMockLogger>;

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8545"),
        relayContractAddress: jest.fn().mockReturnValue("0x5FbDB2315678afecb367f032d93F642f64180aa3"),
    };

    async function makeService(chainId: string): Promise<EVMChainService> {
        logger = createMockLogger();
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EVMChainService,
                { provide: EvmConfigService, useValue: mockConfigService },
                { provide: FATLoggerService, useValue: logger },
                { provide: CHAIN_CONTEXT, useValue: { chainType: ChainType.EVM, chainId } },
            ],
        }).compile();
        return module.resolve<EVMChainService>(EVMChainService);
    }

    function stubClients(getBalance: jest.Mock) {
        const publicClient = {
            simulateContract: jest.fn(async () => ({ request: { some: "request" } })),
            estimateContractGas: jest.fn(async () => 500_000n),
            getTransactionCount: jest.fn(async () => 3),
            getBlock: jest.fn(async () => ({ transactions: [], baseFeePerGas: undefined })),
            estimateMaxPriorityFeePerGas: jest.fn(async () => 0n),
            getGasPrice: jest.fn(async () => 1_000_000_000n),
            getTransaction: jest.fn(async () => ({ nonce: 3 })),
            getBalance,
        };
        jest.spyOn(service as unknown as { client: () => Promise<unknown> }, "client").mockResolvedValue(publicClient);
        jest.spyOn(service as unknown as { signer: () => Promise<unknown> }, "signer").mockResolvedValue({
            account: { address: SIGNER_ADDRESS },
            writeContract: jest.fn(async () => TX_HASH),
        });
    }

    const alerts = () => (logger.warn as jest.Mock).mock.calls.filter((call) => call[1]?.alert === true);

    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.LOW_BALANCE_ALERT_WEI_EVM_51001;
        delete process.env.LOW_BALANCE_ALERT_WEI_EVM_51002;
        delete process.env.LOW_BALANCE_ALERT_WEI_EVM_51004;
    });

    it("pages with a per-chain dedupKey when the signer is below the threshold", async () => {
        service = await makeService("51001");
        process.env.LOW_BALANCE_ALERT_WEI_EVM_51001 = "10000000000000000"; // 0.01 ETH
        stubClients(jest.fn(async () => 4_000_000_000_000_000n)); // 0.004 ETH

        await expect(service.simulateAndWriteRelay(relayPayload("0xb1"))).resolves.toBe(TX_HASH);
        await flush();

        expect(alerts()).toHaveLength(1);
        const [message, meta] = alerts()[0];
        expect(message).toContain("RELAYER WALLET LOW on chain 51001");
        expect(message).toContain("0.004 ETH");
        expect(meta).toEqual({
            alert: true,
            dedupKey: "relayer.lowBalance.51001",
            chainId: "51001",
            signer: SIGNER_ADDRESS,
            balanceWei: "4000000000000000",
            thresholdWei: "10000000000000000",
        });
    });

    it("stays quiet at or above the threshold", async () => {
        service = await makeService("51002");
        process.env.LOW_BALANCE_ALERT_WEI_EVM_51002 = "10000000000000000";
        stubClients(jest.fn(async () => 10_000_000_000_000_000n));

        await service.simulateAndWriteRelay(relayPayload("0xb2"));
        await flush();

        expect(alerts()).toHaveLength(0);
    });

    it("reads no balance when the chain has no threshold", async () => {
        service = await makeService("51003");
        const getBalance = jest.fn(async () => 0n);
        stubClients(getBalance);

        await service.simulateAndWriteRelay(relayPayload("0xb3"));
        await flush();

        expect(getBalance).not.toHaveBeenCalled();
        expect(alerts()).toHaveLength(0);
    });

    it("a failing balance read never fails the relay and does not page", async () => {
        service = await makeService("51004");
        process.env.LOW_BALANCE_ALERT_WEI_EVM_51004 = "10000000000000000";
        stubClients(jest.fn(async () => Promise.reject(new Error("rpc down"))));

        await expect(service.simulateAndWriteRelay(relayPayload("0xb4"))).resolves.toBe(TX_HASH);
        await flush();

        expect(alerts()).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Could not check the signer balance on chain 51004")
        );
    });
});
