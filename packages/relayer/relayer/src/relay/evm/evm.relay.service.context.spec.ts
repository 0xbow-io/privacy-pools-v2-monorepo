import { Test, TestingModule } from "@nestjs/testing";
import { mock } from "jest-mock-extended";
import { BadRequestException } from "@nestjs/common";
import { Address, getAddress } from "viem";
import { EvmRelayService } from "./evm.relay.service";
import { DustRescueOrchestratorService } from "./dust-rescue-orchestrator.service";
import { DustRescuePricingService } from "./dust-rescue-pricing.service";
import { DustRescueForwardingService } from "./dust-rescue-forwarding.service";
import { YieldZapRegistry } from "../../rate_provider/yield_zap_registry";

// See evm.relay.service.spec.ts's identical comment: real module pulls in the SDK's
// LiFiSwapQuoteProvider, whose CJS bundle can't load under jest.
jest.mock("./dust-rescue-forwarding.service", () => ({ DustRescueForwardingService: jest.fn() }));
import { EVMChainService } from "../../chain.service/evm.chain.service";
import { EvmContractService } from "../../sdk/evm.contract.service";
import { EvmConfigService } from "../../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../../test/mocks";
import { computeContext } from "./context";
import { encodeWithdrawalFeeSplit, encodeTransferFeeSplit } from "./fee_abi";
import { EvmRelayTransferRequest, EvmRelayWithdrawalRequest, NoteData } from "./types";
import { Wei } from "../../quote/evm/unit.types";

const SIGNER_ADDRESS: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RELAY_CONTRACT: Address = getAddress("0x00000000000000000000000000000000DeaDBeef");
const RECIPIENT: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FEE_RECIPIENT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ASSET: Address = getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");

const ZERO_HINT = `0x${"00".repeat(32)}` as const;
const FEE_AMOUNT = 1_000n;
const AMOUNT_SENT = 10_000n;

const toUnpaddedHex = (v: bigint) => `0x${v.toString(16)}` as const;

// Off-chain proof context check (ported from dev #343): withdrawal and transfer
// reject a proof whose context doesn't bind the processor + fee data + noteData
// the relayer will submit, before any simulation.
describe("EvmRelayService — proof context check", () => {
    let service: EvmRelayService;

    const mockConfigService = mock<EvmConfigService>();
    const mockChainService = mock<EVMChainService>();
    const mockContractService = mock<EvmContractService>();

    const buildProof = (amountOut: bigint, context: bigint) => ({
        pA: [0n, 0n] as [bigint, bigint],
        pB: [
            [0n, 0n],
            [0n, 0n],
        ] as [[bigint, bigint], [bigint, bigint]],
        pC: [0n, 0n] as [bigint, bigint],
        // publicSignals only satisfies the inferred request type; the service reads pubSignals/parsedPubSignals
        publicSignals: [1n, 2n, 3n, 4n, 5n, amountOut, BigInt(ASSET), context],
        pubSignals: [[1n], [2n], [3n], [4n], [5n], [amountOut], [BigInt(ASSET)], [context]],
        parsedPubSignals: {
            nullifierHashes: [toUnpaddedHex(1n)],
            outputCommitments: [toUnpaddedHex(2n)],
            stateRoot: toUnpaddedHex(3n),
            keyRegistryRoot: toUnpaddedHex(4n),
            associationSetRoot: toUnpaddedHex(5n),
            amountOut,
            tokenIdOut: BigInt(ASSET),
            context: toUnpaddedHex(context),
        },
    });

    const withdrawalData = encodeWithdrawalFeeSplit(RECIPIENT, FEE_RECIPIENT, FEE_AMOUNT);
    const transferData = encodeTransferFeeSplit(FEE_RECIPIENT);
    const noteData: NoteData[] = [{ hint: ZERO_HINT, data: "0x1234" }];

    const buildWithdrawalRequest = (context: bigint, notes: NoteData[] = noteData): EvmRelayWithdrawalRequest => ({
        proof: buildProof(AMOUNT_SENT, context),
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: notes,
        signedFeeCommitment: {
            data: withdrawalData,
            asset: ASSET,
            expiration: Date.now() + 60_000,
            feeAmount: Wei(FEE_AMOUNT),
            recipient: RECIPIENT,
            amountSent: Wei(AMOUNT_SENT),
            amountReceived: Wei(AMOUNT_SENT - FEE_AMOUNT),
            signedRelayerCommitment: "0xdead",
        },
    });

    const buildTransferRequest = (context: bigint, notes: NoteData[] = noteData): EvmRelayTransferRequest => ({
        proof: buildProof(FEE_AMOUNT, context),
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: notes,
        signedFeeCommitment: {
            data: transferData,
            asset: ASSET,
            expiration: Date.now() + 60_000,
            feeAmount: Wei(FEE_AMOUNT),
            signedRelayerCommitment: "0xdead",
        },
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EvmRelayService,
                createMockLoggerProvider(),
                { provide: EvmContractService, useValue: mockContractService },
                { provide: EVMChainService, useValue: mockChainService },
                { provide: EvmConfigService, useValue: mockConfigService },
                { provide: DustRescueOrchestratorService, useValue: mock<DustRescueOrchestratorService>() },
                { provide: DustRescuePricingService, useValue: mock<DustRescuePricingService>() },
                { provide: DustRescueForwardingService, useValue: mock<DustRescueForwardingService>() },
                { provide: YieldZapRegistry, useValue: mock<YieldZapRegistry>() },
            ],
        }).compile();

        service = await module.resolve<EvmRelayService>(EvmRelayService);

        jest.clearAllMocks();
        mockChainService.verifyRelayWithdrawalCommitment.mockResolvedValue(true);
        mockChainService.verifyRelayTransferCommitment.mockResolvedValue(true);
        mockConfigService.processorAddress.mockImplementation((op) =>
            op === "transfer" ? SIGNER_ADDRESS : RELAY_CONTRACT
        );
        mockContractService.sdkWithdraw.mockResolvedValue({
            txHash: "0xaa",
            amountOut: AMOUNT_SENT,
            recipientAddress: RECIPIENT,
            fee: FEE_AMOUNT,
        });
        mockContractService.sdkTransfer.mockResolvedValue({ txHash: "0xbb", fee: FEE_AMOUNT });
    });

    describe("withdrawal", () => {
        it("relays when the proof binds the configured processor", async () => {
            const context = computeContext(RELAY_CONTRACT, withdrawalData, noteData);

            const result = await service.withdrawal(buildWithdrawalRequest(context));

            expect(result.txHash).toBe("0xaa");
            expect(mockContractService.sdkWithdraw).toHaveBeenCalledTimes(1);
        });

        it("rejects a proof bound to the wrong processor before touching the chain", async () => {
            const context = computeContext(SIGNER_ADDRESS, withdrawalData, noteData);

            await expect(service.withdrawal(buildWithdrawalRequest(context))).rejects.toThrow(
                /context mismatch.*processor=0x00000000000000000000000000000000DeaDBeef/i
            );
            expect(mockContractService.sdkWithdraw).not.toHaveBeenCalled();
        });

        it("rejects a proof bound to different noteData", async () => {
            const context = computeContext(RELAY_CONTRACT, withdrawalData, [{ hint: ZERO_HINT, data: "0x9999" }]);

            await expect(service.withdrawal(buildWithdrawalRequest(context))).rejects.toThrow(/context mismatch/i);
            expect(mockContractService.sdkWithdraw).not.toHaveBeenCalled();
        });

        it("rejects a hint that is not exactly 32 bytes with a 400, not an encoding error", async () => {
            const badNotes: NoteData[] = [{ hint: "0xab", data: "0x" }];
            const context = computeContext(RELAY_CONTRACT, withdrawalData, noteData);

            await expect(service.withdrawal(buildWithdrawalRequest(context, badNotes))).rejects.toThrow(
                BadRequestException
            );
            await expect(service.withdrawal(buildWithdrawalRequest(context, badNotes))).rejects.toThrow(
                /hint must be exactly 32 bytes/
            );
            expect(mockContractService.sdkWithdraw).not.toHaveBeenCalled();
        });

        it("accepts noteData count differing from outputCommitmentNumber when context matches", async () => {
            // PoolVault emits note discovery events independently of the output
            // commitment count — the relayer must not reject on a count mismatch.
            const twoNotes: NoteData[] = [
                { hint: ZERO_HINT, data: "0x" },
                { hint: ZERO_HINT, data: "0x" },
            ];
            const context = computeContext(RELAY_CONTRACT, withdrawalData, twoNotes);

            const result = await service.withdrawal(buildWithdrawalRequest(context, twoNotes));

            expect(result.txHash).toBe("0xaa");
            expect(mockContractService.sdkWithdraw).toHaveBeenCalledTimes(1);
        });
    });

    describe("transfer", () => {
        it("relays when the proof binds the configured processor (signer)", async () => {
            const context = computeContext(SIGNER_ADDRESS, transferData, noteData);

            const result = await service.transfer(buildTransferRequest(context));

            expect(result.txHash).toBe("0xbb");
            expect(mockContractService.sdkTransfer).toHaveBeenCalledTimes(1);
        });

        it("rejects a proof bound to the wrong processor", async () => {
            const context = computeContext(RELAY_CONTRACT, transferData, noteData);

            await expect(service.transfer(buildTransferRequest(context))).rejects.toThrow(/context mismatch/i);
            expect(mockContractService.sdkTransfer).not.toHaveBeenCalled();
        });

        it("rejects a proof bound to a different fee split", async () => {
            const otherData = encodeTransferFeeSplit(RECIPIENT);
            const context = computeContext(SIGNER_ADDRESS, otherData, noteData);

            await expect(service.transfer(buildTransferRequest(context))).rejects.toThrow(/context mismatch/i);
            expect(mockContractService.sdkTransfer).not.toHaveBeenCalled();
        });
    });
});
