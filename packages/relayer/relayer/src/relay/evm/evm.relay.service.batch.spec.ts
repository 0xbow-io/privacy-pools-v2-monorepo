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
import { encodeBatchFeeSplit, encodeWithdrawalFeeSplit } from "./fee_abi";
import { BPS, Wei } from "../../quote/evm/unit.types";
import {
    Bytes,
    EvmRelayBatchRequest,
    EvmRelayBatchSDKPayload,
    FeeSplit,
    NoteData,
    ReshapedProof,
} from "./types";
import { ISignedBatchWithdrawalFeeCommitment } from "../../relayer.types";
import { zEvmRelayBatchRequest } from "./schemas";
import { zEvmBatchQuoteRequest } from "../../quote/evm/evm.schemas";
import { MAX_BATCH } from "@privacy-pools-v2/core-sdk/batch-fee";

// Native ETH sentinel asset (checksummed). tokenIdOut in the proofs is derived
// from this so that `getAddressFromBigInt(tokenIdOut) === commitment.asset`.
const ASSET = getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
const TOKEN_ID_OUT = BigInt(ASSET.toLowerCase());

const RECIPIENT = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const FEE_RECIPIENT = getAddress("0xc1ebfda3114bc2496e86d466b3082491a96767df");
const OTHER_RECIPIENT = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const RELAY_CONTRACT = getAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3");
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as Bytes;

// -========- Fixture builders -========-

function makeRouting(feeAmount: bigint, overrides: Partial<FeeSplit> = {}): FeeSplit {
    return {
        recipient: RECIPIENT,
        feeRecipient: FEE_RECIPIENT,
        feeAmount,
        nativeGas: 0n,
        ...overrides,
    };
}

// Build a reshaped transact proof carrying the amountOut / tokenIdOut the batch
// path reads. The other fields are present only to satisfy the type.
function makeProof(amountOut: bigint, tokenIdOut: bigint = TOKEN_ID_OUT): ReshapedProof {
    return {
        pA: [0n, 0n],
        pB: [
            [0n, 0n],
            [0n, 0n],
        ],
        pC: [0n, 0n],
        pubSignals: [[], [], [0n], [0n], [0n], [amountOut], [tokenIdOut], [0n]],
        parsedPubSignals: {
            nullifierHashes: [],
            outputCommitments: [],
            stateRoot: "0x0",
            keyRegistryRoot: "0x0",
            associationSetRoot: "0x0",
            amountOut,
            tokenIdOut,
            context: "0x0",
        },
    } as unknown as ReshapedProof;
}

function makeItem(amountOut: bigint, tokenIdOut: bigint = TOKEN_ID_OUT): EvmRelayBatchRequest["items"][number] {
    const noteData: NoteData[] = [];
    return {
        proof: makeProof(amountOut, tokenIdOut),
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData,
    } as unknown as EvmRelayBatchRequest["items"][number];
}

function makeCommitment(
    routings: FeeSplit[],
    opts: { asset?: string; maxRelayFee?: bigint; totalFee?: bigint } = {}
): ISignedBatchWithdrawalFeeCommitment {
    const totalFee = opts.totalFee ?? routings.reduce((acc, r) => acc + r.feeAmount, 0n);
    return {
        data: encodeBatchFeeSplit(routings),
        asset: (opts.asset ?? ASSET) as ISignedBatchWithdrawalFeeCommitment["asset"],
        expiration: Date.now() + 10_000_000,
        totalFee: Wei(totalFee),
        maxRelayFee: Wei(opts.maxRelayFee ?? 1_000n),
        // The relay path does not recompute fees from the fee model (it re-derives
        // and revalidates each per-item feeAmount from the signed routings), so
        // these signed params just have to be present. Signature verification is
        // mocked in these guard tests.
        relayCost: Wei(0n),
        feeBps: BPS(0n),
        flatFee: Wei(0n),
        signedRelayerCommitment: "0xdeadbeef" as Bytes,
    };
}

function makeRequest(
    items: EvmRelayBatchRequest["items"],
    commitment: ISignedBatchWithdrawalFeeCommitment
): EvmRelayBatchRequest {
    return {
        items,
        signedBatchFeeCommitment: commitment,
    } as unknown as EvmRelayBatchRequest;
}

describe("EvmRelayService.batchWithdrawal — validation guards", () => {
    let service: EvmRelayService;
    const mockChainService = mock<EVMChainService>();
    const mockContractService = mock<EvmContractService>();
    const mockConfigService = mock<EvmConfigService>();
    const mockDustRescueOrchestrator = mock<DustRescueOrchestratorService>();
    const mockDustRescuePricing = mock<DustRescuePricingService>();
    const mockDustRescueForwarding = mock<DustRescueForwardingService>();
    const mockYieldZapRegistry = mock<YieldZapRegistry>();

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EvmRelayService,
                createMockLoggerProvider(),
                { provide: EvmContractService, useValue: mockContractService },
                { provide: EVMChainService, useValue: mockChainService },
                { provide: EvmConfigService, useValue: mockConfigService },
                { provide: DustRescueOrchestratorService, useValue: mockDustRescueOrchestrator },
                { provide: DustRescuePricingService, useValue: mockDustRescuePricing },
                { provide: DustRescueForwardingService, useValue: mockDustRescueForwarding },
                { provide: YieldZapRegistry, useValue: mockYieldZapRegistry },
            ],
        }).compile();

        service = await module.resolve<EvmRelayService>(EvmRelayService);

        jest.clearAllMocks();
        mockConfigService.relayContractAddress.mockReturnValue(RELAY_CONTRACT);
        // Default: the relayer signature verifies, so tests reach the business guards.
        mockChainService.verifyRelayBatchWithdrawalCommitment.mockResolvedValue(true);
        mockChainService.simulateAndWriteRelayBatch.mockResolvedValue(TX_HASH);
    });

    it("rejects when routings length !== items length", async () => {
        // Commitment encodes 2 routings but only 1 item submitted.
        const commitment = makeCommitment([makeRouting(10n), makeRouting(10n)]);
        const request = makeRequest([makeItem(100n)], commitment);

        await expect(service.batchWithdrawal(request)).rejects.toThrow(BadRequestException);
        await expect(service.batchWithdrawal(request)).rejects.toThrow(
            "Batch commitment encodes 2 routings but 1 items were submitted"
        );
        expect(mockChainService.simulateAndWriteRelayBatch).not.toHaveBeenCalled();
    });

    it("rejects a per-item amountOut of 0", async () => {
        const commitment = makeCommitment([makeRouting(10n)]);
        const request = makeRequest([makeItem(0n)], commitment);

        await expect(service.batchWithdrawal(request)).rejects.toThrow("Item 0: proof.amountOut must be greater than 0");
        expect(mockChainService.simulateAndWriteRelayBatch).not.toHaveBeenCalled();
    });

    it("rejects when an item's proof asset does not match the commitment asset", async () => {
        // tokenIdOut derived from a different address than the commitment asset.
        const wrongTokenId = BigInt(OTHER_RECIPIENT.toLowerCase());
        const commitment = makeCommitment([makeRouting(10n)]);
        const request = makeRequest([makeItem(100n, wrongTokenId)], commitment);

        await expect(service.batchWithdrawal(request)).rejects.toThrow(/does not match commitment asset/);
        expect(mockChainService.simulateAndWriteRelayBatch).not.toHaveBeenCalled();
    });

    it("rejects inconsistent recipient/feeRecipient across items", async () => {
        // Item 0 sets the reference recipient; item 1 diverges.
        const commitment = makeCommitment([
            makeRouting(10n),
            makeRouting(10n, { recipient: OTHER_RECIPIENT }),
        ]);
        const request = makeRequest([makeItem(100n), makeItem(100n)], commitment);

        await expect(service.batchWithdrawal(request)).rejects.toThrow(
            "Item 1: inconsistent recipient/feeRecipient across batch"
        );
        expect(mockChainService.simulateAndWriteRelayBatch).not.toHaveBeenCalled();
    });

    it("rejects a per-item feeAmount that exceeds maxRelayFee", async () => {
        // feeAmount 200 > maxRelayFee 100.
        const commitment = makeCommitment([makeRouting(200n)], { maxRelayFee: 100n });
        const request = makeRequest([makeItem(1_000n)], commitment);

        await expect(service.batchWithdrawal(request)).rejects.toThrow(/exceeds maxRelayFee/);
        expect(mockChainService.simulateAndWriteRelayBatch).not.toHaveBeenCalled();
    });

    it("rejects a per-item feeAmount that exceeds the proof amountOut", async () => {
        // feeAmount 50 <= maxRelayFee 100 (passes that guard) but > amountOut 40.
        const commitment = makeCommitment([makeRouting(50n)], { maxRelayFee: 100n });
        const request = makeRequest([makeItem(40n)], commitment);

        await expect(service.batchWithdrawal(request)).rejects.toThrow(/exceeds proof amountOut/);
        expect(mockChainService.simulateAndWriteRelayBatch).not.toHaveBeenCalled();
    });

    it("rejects when the sum of item fees != committed totalFee", async () => {
        // Per-item guards pass (fee 10 <= max 100, <= amountOut 1000), but the
        // committed totalFee (999) disagrees with the recomputed sum (20).
        const commitment = makeCommitment([makeRouting(10n), makeRouting(10n)], {
            maxRelayFee: 100n,
            totalFee: 999n,
        });
        const request = makeRequest([makeItem(1_000n), makeItem(1_000n)], commitment);

        await expect(service.batchWithdrawal(request)).rejects.toThrow(
            "Sum of item fees (20) does not match committed totalFee (999)"
        );
        expect(mockChainService.simulateAndWriteRelayBatch).not.toHaveBeenCalled();
    });

    it("rejects when the relayer signature fails to verify", async () => {
        mockChainService.verifyRelayBatchWithdrawalCommitment.mockResolvedValue(false);
        const commitment = makeCommitment([makeRouting(10n)], { maxRelayFee: 100n });
        const request = makeRequest([makeItem(1_000n)], commitment);

        await expect(service.batchWithdrawal(request)).rejects.toThrow(
            "The provided batch fee commitment couldn't be verified"
        );
        expect(mockChainService.simulateAndWriteRelayBatch).not.toHaveBeenCalled();
    });

    it("submits a valid batch: rebuilds transactParams from signed routings and returns the txHash", async () => {
        const routings = [makeRouting(10n), makeRouting(20n)];
        const commitment = makeCommitment(routings, { maxRelayFee: 100n });
        const request = makeRequest([makeItem(1_000n), makeItem(1_000n)], commitment);

        const result = await service.batchWithdrawal(request);

        expect(result).toEqual({ txHash: TX_HASH });
        expect(mockChainService.simulateAndWriteRelayBatch).toHaveBeenCalledTimes(1);

        const [payload, nativeGas] = mockChainService.simulateAndWriteRelayBatch.mock.calls[0] as [
            EvmRelayBatchSDKPayload,
            bigint | undefined
        ];
        // No native gas requested -> passed as undefined.
        expect(nativeGas).toBeUndefined();
        expect(payload.proofs).toHaveLength(2);
        expect(payload.noteData).toHaveLength(2);
        expect(payload.transactParams).toHaveLength(2);

        // transactParams are re-derived from the SIGNED routings (commitment.data),
        // each bound to the relay contract processor — NOT taken from client input.
        payload.transactParams.forEach((tp, i) => {
            expect(tp.processor).toBe(RELAY_CONTRACT);
            expect(tp.data).toBe(
                encodeWithdrawalFeeSplit(
                    routings[i].recipient,
                    routings[i].feeRecipient,
                    routings[i].feeAmount,
                    routings[i].nativeGas
                )
            );
        });

        // Signature verification is invoked with the totals recomputed from proofs:
        // totalAmountSent = 2000, totalFee = 30, totalAmountReceived = 1970.
        expect(mockChainService.verifyRelayBatchWithdrawalCommitment).toHaveBeenCalledWith(commitment, 2_000n, 1_970n);
    });

    it("forwards accumulated nativeGas to simulateAndWriteRelayBatch when present", async () => {
        const routings = [makeRouting(10n, { nativeGas: 5n }), makeRouting(20n, { nativeGas: 7n })];
        const commitment = makeCommitment(routings, { maxRelayFee: 100n });
        const request = makeRequest([makeItem(1_000n), makeItem(1_000n)], commitment);

        await service.batchWithdrawal(request);

        const [, nativeGas] = mockChainService.simulateAndWriteRelayBatch.mock.calls[0] as [
            EvmRelayBatchSDKPayload,
            bigint | undefined
        ];
        expect(nativeGas).toBe(12n);
    });

    it("accepts the worst-case batch at the per-item cap, confirming the aggregate cap never binds", async () => {
        // Every item's fee sits exactly at maxRelayFee, for a MAX_BATCH (10) batch.
        // This is the largest Σfee any batch can reach while passing the per-item
        // `feeAmount <= maxRelayFee` guard, so Σfee == maxRelayFee * itemCount ==
        // aggregateFeeCap. The aggregate check is `totalFee > cap`, so equality
        // passes — and exceeding it is impossible without an item breaching the
        // per-item cap first. Empirically confirms the aggregate assertion is
        // redundant defense-in-depth (audit L-1), never the binding constraint.
        const maxRelayFee = 100n;
        const itemCount = 10; // MAX_BATCH
        const routings = Array.from({ length: itemCount }, () => makeRouting(maxRelayFee));
        const commitment = makeCommitment(routings, { maxRelayFee });
        const request = makeRequest(
            Array.from({ length: itemCount }, () => makeItem(1_000n)),
            commitment
        );

        const result = await service.batchWithdrawal(request);

        // Reaches submission (not rejected by the aggregate cap) and returns the txHash.
        expect(result).toEqual({ txHash: TX_HASH });
        expect(mockChainService.simulateAndWriteRelayBatch).toHaveBeenCalledTimes(1);
        // Σfee (1000) equals the aggregate cap (maxRelayFee 100 * 10), not above it.
        expect(BigInt(commitment.totalFee)).toBe(maxRelayFee * BigInt(itemCount));
    });
});

// -========- Zod-level cap tests -========-

describe("Batch request schemas — MAX_BATCH caps", () => {
    // Minimal valid raw batch item (pre-transform snarkjs shape). publicSignals
    // length must equal inputNullifierNumber + outputCommitmentNumber + 6.
    const validRawItem = {
        proof: {
            pi_a: [1, 2, 3],
            pi_b: [
                [1, 2],
                [3, 4],
                [5, 6],
            ],
            pi_c: [1, 2, 3],
            publicSignals: [1, 2, 3, 4, 5, 6, 7, 8],
        },
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: [],
    };

    it("zEvmRelayBatchRequest rejects an empty items array", () => {
        const result = zEvmRelayBatchRequest.shape.items.safeParse([]);
        expect(result.success).toBe(false);
    });

    it("zEvmRelayBatchRequest accepts a single valid item", () => {
        const result = zEvmRelayBatchRequest.shape.items.safeParse([validRawItem]);
        expect(result.success).toBe(true);
    });

    it(`zEvmRelayBatchRequest rejects items.length > MAX_BATCH (${MAX_BATCH})`, () => {
        const tooMany = Array.from({ length: MAX_BATCH + 1 }, () => validRawItem);
        const result = zEvmRelayBatchRequest.shape.items.safeParse(tooMany);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((iss) => iss.code === "too_big")).toBe(true);
        }
    });

    it(`zEvmBatchQuoteRequest rejects amounts.length > MAX_BATCH (${MAX_BATCH})`, () => {
        const tooMany = Array.from({ length: MAX_BATCH + 1 }, () => 1);
        const result = zEvmBatchQuoteRequest.shape.amounts.safeParse(tooMany);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((iss) => iss.code === "too_big")).toBe(true);
        }
    });

    it("zEvmBatchQuoteRequest accepts amounts.length === MAX_BATCH", () => {
        const atCap = Array.from({ length: MAX_BATCH }, () => 1);
        const result = zEvmBatchQuoteRequest.shape.amounts.safeParse(atCap);
        expect(result.success).toBe(true);
    });
});
