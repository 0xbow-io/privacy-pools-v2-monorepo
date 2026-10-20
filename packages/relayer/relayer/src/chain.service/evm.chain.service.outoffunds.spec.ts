import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { InsufficientFundsError } from "viem";
import { EVMChainService } from "./evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import { Bytes, EvmRelaySDKPayload, ReshapedProof } from "../relay/evm/types";

// Coverage for the out-of-funds branch of `failWrite`: when the RELAYER's own
// signer wallet cannot pay gas (viem InsufficientFundsError, or a node's raw
// "insufficient funds" rejection), the request must surface as a retryable 503
// ServiceUnavailableException (package CLAUDE.md §4 — operator fault, never a
// 4xx) and page operators via `logger.turbo`. Any other failure keeps the
// established 400 + `logger.error` contract. viem clients are stubbed via the
// private client()/signer() accessors (same pattern as the processor spec).
// Addresses/chainId are distinct from the other chain-service specs — the
// module-level caches are not reset between tests.

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RELAY_CONTRACT = "0x0165878A594ca255338adfa4d48449f69242Eb8F" as const;

const minimalProof = {
    pA: [0n, 0n],
    pB: [
        [0n, 0n],
        [0n, 0n],
    ],
    pC: [0n, 0n],
    pubSignals: [[], [], [0n], [0n], [0n], [1n], [0n], [0n]],
    parsedPubSignals: { nullifierHashes: ["0xfeedf00d"] },
} as unknown as ReshapedProof;

function makePayload(): EvmRelaySDKPayload {
    return {
        proof: minimalProof,
        noteData: [],
        data: "0x00",
    } as unknown as EvmRelaySDKPayload;
}

describe("EVM chain service — relayer wallet out of funds", () => {
    let service: EVMChainService;
    const loggerProvider = createMockLoggerProvider();
    const mockLogger = loggerProvider.useValue as {
        error: jest.Mock;
        turbo: jest.Mock;
    };

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil-oof" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8549"),
        relayContractAddress: jest.fn().mockReturnValue(RELAY_CONTRACT),
        chainId: jest.fn().mockReturnValue("31339"),
    };

    function stubClients({ simulateError, writeError }: { simulateError?: unknown; writeError?: unknown } = {}) {
        const simulateContract = jest.fn(async () => {
            if (simulateError) throw simulateError;
            return { request: { some: "request" } };
        });
        const writeContract = jest.fn(async () => {
            if (writeError) throw writeError;
            return "0xabc0000000000000000000000000000000000000000000000000000000000abc";
        });
        const mockPublicClient = {
            simulateContract,
            estimateContractGas: jest.fn(async () => 500_000n),
            estimateGas: jest.fn(async () => 500_000n),
            getTransactionCount: jest.fn(async () => 0),
        };
        const mockWalletClient = {
            account: { address: "0x0000000000000000000000000000000000000002" },
            writeContract,
            sendTransaction: jest.fn(async () => {
                if (writeError) throw writeError;
                return "0xabc0000000000000000000000000000000000000000000000000000000000abc";
            }),
        };
        jest.spyOn(service as unknown as { client: () => Promise<unknown> }, "client").mockResolvedValue(
            mockPublicClient
        );
        jest.spyOn(service as unknown as { signer: () => Promise<unknown> }, "signer").mockResolvedValue(
            mockWalletClient
        );
        return { simulateContract, writeContract };
    }

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EVMChainService,
                { provide: EvmConfigService, useValue: mockConfigService },
                loggerProvider,
                { provide: CHAIN_CONTEXT, useValue: { chainType: ChainType.EVM, chainId: "31339" } },
            ],
        }).compile();

        service = await module.resolve<EVMChainService>(EVMChainService);
        jest.clearAllMocks();
    });

    it("surface a viem InsufficientFundsError from write as a 503 and page via turbo", async () => {
        stubClients({ writeError: new InsufficientFundsError() });

        const promise = service.simulateAndWriteRelay(makePayload());

        await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
        await expect(promise).rejects.toThrow(/relayer.*wallet cannot cover gas/i);
        expect(mockLogger.turbo).toHaveBeenCalledTimes(1);
        expect(mockLogger.turbo.mock.calls[0][0]).toMatch(/RELAYER WALLET OUT OF FUNDS on chain 31339/);
        // dedupKey must be chain-scoped — otherwise an out-of-funds page on one chain
        // suppresses a distinct page for a different chain within the cooldown window.
        expect(mockLogger.turbo.mock.calls[0][1]).toEqual({ dedupKey: "relayer.outOfFunds.31339" });
        expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("surface an unclassified 'insufficient funds' node rejection during simulate as a 503", async () => {
        stubClients({
            simulateError: new Error("insufficient funds for gas * price + value: balance 0, tx cost 12345"),
        });

        const promise = service.simulateAndWriteRelay(makePayload());

        await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(mockLogger.turbo).toHaveBeenCalledTimes(1);
    });

    it("keep the 400 + logger.error contract for any other failure", async () => {
        stubClients({ simulateError: new Error("execution reverted: some contract condition") });

        const promise = service.simulateAndWriteRelay(makePayload());

        await expect(promise).rejects.toBeInstanceOf(BadRequestException);
        await expect(promise).rejects.toThrow(/Relay failed/);
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(mockLogger.turbo).not.toHaveBeenCalled();
    });

    it("apply the same 503 mapping on the sendRawTransaction path", async () => {
        stubClients({ writeError: new InsufficientFundsError() });

        const promise = service.sendRawTransaction({
            to: "0x0000000000000000000000000000000000000003",
            data: "0x00",
            value: 0n,
        });

        await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(mockLogger.turbo).toHaveBeenCalledTimes(1);
    });
});
