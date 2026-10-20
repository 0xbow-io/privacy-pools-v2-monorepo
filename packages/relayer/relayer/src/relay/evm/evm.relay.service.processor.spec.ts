import { Test, TestingModule } from "@nestjs/testing";
import { mock } from "jest-mock-extended";
import { BadRequestException } from "@nestjs/common";
import { getAddress } from "viem";
import { EvmRelayService } from "./evm.relay.service";
import { DustRescueOrchestratorService } from "./dust-rescue-orchestrator.service";
import { DustRescuePricingService } from "./dust-rescue-pricing.service";
import { DustRescueForwardingService } from "./dust-rescue-forwarding.service";
import { YieldZapRegistry } from "../../rate_provider/yield_zap_registry";

// See evm.relay.service.spec.ts's identical comment: real module pulls in the SDK's
// LiFiSwapQuoteProvider, whose CJS bundle can't load under jest (multiformats has no
// require export condition).
jest.mock("./dust-rescue-forwarding.service", () => ({ DustRescueForwardingService: jest.fn() }));
import { EVMChainService } from "../../chain.service/evm.chain.service";
import { EvmContractService } from "../../sdk/evm.contract.service";
import { EvmConfigService } from "../../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../../test/mocks";
import { encodeWithdrawalFeeSplit } from "./fee_abi";
import { computeContext } from "./context";
import type { EvmRelayWithdrawalRequest, ReshapedProof } from "./types";
import type { ISignedWithdrawalFeeCommitment } from "../../relayer.types";

// Processor / minUnderlyingOut coverage (code-review R1 TEST-1 + SEC-2): the
// alternate-processor allowlist reject path and the client-supplied
// minUnderlyingOut threading through EvmRelayService.withdrawal had no coverage.

const ASSET = getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
const TOKEN_ID_OUT = BigInt(ASSET.toLowerCase());
const RECIPIENT = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const FEE_RECIPIENT = getAddress("0xc1ebfda3114bc2496e86d466b3082491a96767df");
const ALLOWED_PROCESSOR = getAddress("0x7c7c871fbeb28f90a85d47868aa5245f370e142f");
const DENIED_PROCESSOR = getAddress("0x000000000000000000000000000000000000dead");
const RELAY_CONTRACT = getAddress("0x00000000000000000000000000000000deadbeef");
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as const;

const AMOUNT_OUT = 1_000_000n;
const FEE_AMOUNT = 10_000n;

function makeProof(context: bigint): ReshapedProof {
    return {
        pA: [0n, 0n],
        pB: [
            [0n, 0n],
            [0n, 0n],
        ],
        pC: [0n, 0n],
        pubSignals: [[], [], [0n], [0n], [0n], [AMOUNT_OUT], [TOKEN_ID_OUT], [context]],
        parsedPubSignals: {
            nullifierHashes: [],
            outputCommitments: [],
            stateRoot: "0x0",
            keyRegistryRoot: "0x0",
            associationSetRoot: "0x0",
            amountOut: AMOUNT_OUT,
            tokenIdOut: TOKEN_ID_OUT,
            context: `0x${context.toString(16)}`,
        },
    } as unknown as ReshapedProof;
}

function makeCommitment(): ISignedWithdrawalFeeCommitment {
    return {
        data: encodeWithdrawalFeeSplit(RECIPIENT, FEE_RECIPIENT, FEE_AMOUNT, 0n),
        asset: ASSET,
        expiration: Date.now() + 10_000_000,
        feeAmount: FEE_AMOUNT,
        recipient: RECIPIENT,
        amountSent: AMOUNT_OUT,
        amountReceived: AMOUNT_OUT - FEE_AMOUNT,
        signedRelayerCommitment: "0x00",
    } as unknown as ISignedWithdrawalFeeCommitment;
}

// The proof binds whichever processor the relayer will submit — the requested
// alternate when given, else the default relay contract — so the context check passes.
function makeRequest(overrides: Partial<EvmRelayWithdrawalRequest> = {}): EvmRelayWithdrawalRequest {
    const processor = overrides.processorAddress ?? RELAY_CONTRACT;
    const context = computeContext(processor, makeCommitment().data, []);
    return {
        proof: makeProof(context),
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: [],
        signedFeeCommitment: makeCommitment(),
        ...overrides,
    } as unknown as EvmRelayWithdrawalRequest;
}

describe("EvmRelayService.withdrawal — processor allowlist + minUnderlyingOut", () => {
    let service: EvmRelayService;

    const chainService = mock<EVMChainService>();
    const contractService = mock<EvmContractService>();
    const config = mock<EvmConfigService>();
    const dustRescueOrchestrator = mock<DustRescueOrchestratorService>();
    const dustRescuePricing = mock<DustRescuePricingService>();
    const dustRescueForwarding = mock<DustRescueForwardingService>();
    const yieldZapRegistry = mock<YieldZapRegistry>();

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EvmRelayService,
                createMockLoggerProvider(),
                { provide: EVMChainService, useValue: chainService },
                { provide: EvmContractService, useValue: contractService },
                { provide: EvmConfigService, useValue: config },
                { provide: DustRescueOrchestratorService, useValue: dustRescueOrchestrator },
                { provide: DustRescuePricingService, useValue: dustRescuePricing },
                { provide: DustRescueForwardingService, useValue: dustRescueForwarding },
                { provide: YieldZapRegistry, useValue: yieldZapRegistry },
            ],
        }).compile();

        service = await module.resolve<EvmRelayService>(EvmRelayService);
        jest.clearAllMocks();

        // Fee commitment always verifies in these tests; we exercise the
        // processor + slippage branches, not signature verification.
        chainService.verifyRelayWithdrawalCommitment.mockResolvedValue(true);
        contractService.sdkWithdraw.mockResolvedValue({ txHash: TX_HASH });
        config.processorAddress.mockReturnValue(RELAY_CONTRACT);
    });

    it("reject a processorAddress that is not in the allowlist", async () => {
        config.isAllowedProcessor.mockReturnValue(false);

        await expect(service.withdrawal(makeRequest({ processorAddress: DENIED_PROCESSOR }))).rejects.toThrow(
            /not in the allowed_processors allowlist/
        );
        await expect(service.withdrawal(makeRequest({ processorAddress: DENIED_PROCESSOR }))).rejects.toBeInstanceOf(
            BadRequestException
        );
        expect(contractService.sdkWithdraw).not.toHaveBeenCalled();
    });

    it("forward an allowlisted processor and the client minUnderlyingOut floor to the SDK", async () => {
        config.isAllowedProcessor.mockReturnValue(true);
        const minUnderlyingOut = 990_000n;

        const result = await service.withdrawal(
            makeRequest({ processorAddress: ALLOWED_PROCESSOR, minUnderlyingOut })
        );

        expect(result.txHash).toBe(TX_HASH);
        expect(contractService.sdkWithdraw).toHaveBeenCalledTimes(1);
        const [payload] = contractService.sdkWithdraw.mock.calls[0];
        expect(payload.processorAddress).toBe(ALLOWED_PROCESSOR);
        expect(payload.minUnderlyingOut).toBe(minUnderlyingOut);
    });

    it("default minUnderlyingOut to 0n when the client omits it", async () => {
        config.isAllowedProcessor.mockReturnValue(true);

        await service.withdrawal(makeRequest({ processorAddress: ALLOWED_PROCESSOR }));

        const [payload] = contractService.sdkWithdraw.mock.calls[0];
        expect(payload.minUnderlyingOut).toBe(0n);
    });

    it("reject a proof bound to the default relay when an alternate processor is requested", async () => {
        config.isAllowedProcessor.mockReturnValue(true);
        const request = makeRequest();

        await expect(service.withdrawal({ ...request, processorAddress: ALLOWED_PROCESSOR })).rejects.toThrow(
            new RegExp(`context mismatch.*processor=${ALLOWED_PROCESSOR}`, "i")
        );
        expect(contractService.sdkWithdraw).not.toHaveBeenCalled();
    });

    it("use the default relay (no processor) when processorAddress is absent", async () => {
        await service.withdrawal(makeRequest());

        expect(config.isAllowedProcessor).not.toHaveBeenCalled();
        const [payload] = contractService.sdkWithdraw.mock.calls[0];
        expect(payload.processorAddress).toBeUndefined();
        expect(payload.minUnderlyingOut).toBe(0n);
    });
});
