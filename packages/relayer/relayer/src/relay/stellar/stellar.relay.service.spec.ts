import { NotImplementedException } from "@nestjs/common";
import { mock } from "jest-mock-extended";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StellarRelayService } from "./stellar.relay.service";
import { StellarChainService } from "../../chain.service/stellar.chain.service";
import { StellarConfigService } from "../../config/stellar/stellar-config.service";
import { createMockLogger } from "../../test/mocks";
import type {
    StellarRelayBatchRequest,
    StellarRelayRegisterAndWithdrawalRequest,
    StellarRelaySendRequest,
    StellarRelayWithdrawalRequest,
} from "./types";

const RECIPIENT = Keypair.random().publicKey();
const FEE_RECIPIENT = Keypair.random().publicKey();
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 3));
const ROUTER = StrKey.encodeContract(Buffer.alloc(32, 4));
const OWNER = Keypair.random().publicKey();

function fakeRequest(
    overrides: Partial<StellarRelayWithdrawalRequest["proof"]["parsedPubSignals"]> = {}
): StellarRelayWithdrawalRequest {
    const parsedPubSignals = {
        nullifierHashes: [1n],
        outputCommitments: [2n],
        stateRoot: 3n,
        keystoreRoot: 4n,
        aspRoot: 5n,
        amountOut: 1_000_000n,
        tokenIdOut: 6n,
        context: 7n,
        ...overrides,
    };
    return {
        proof: {
            a: "0x00",
            b: "0x00",
            c: "0x00",
            pubSignals: [[1n], [2n], [3n], [4n], [5n], [6n], [7n]],
            parsedPubSignals,
        },
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: [],
        signedFeeCommitment: {
            data: "0x00",
            asset: ASSET,
            expiration: Date.now() + 10_000_000,
            feeAmount: 1000n,
            recipient: RECIPIENT,
            amountSent: parsedPubSignals.amountOut,
            amountReceived: parsedPubSignals.amountOut - 1000n,
            signedRelayerCommitment: "0x00",
        },
    };
}

describe("StellarRelayService", () => {
    let service: StellarRelayService;
    const chainService = mock<StellarChainService>();
    const configService = mock<StellarConfigService>();

    beforeEach(() => {
        jest.clearAllMocks();
        configService.yieldRouterFor.mockReturnValue(undefined);
        chainService.tokenIdOf.mockReturnValue(6n);
        chainService.verifyRelayWithdrawalCommitment.mockResolvedValue(true);
        chainService.decodeRouting.mockReturnValue({ recipient: RECIPIENT, feeRecipient: FEE_RECIPIENT, feeAmount: 1000n });
        chainService.submitRelay.mockResolvedValue({ txHash: "0xtxhash" });
        service = new StellarRelayService(createMockLogger() as never, chainService, configService);
    });

    it("relays a valid withdrawal", async () => {
        const result = await service.withdrawal(fakeRequest());

        expect(result).toEqual({ txHash: "0xtxhash" });
        expect(chainService.submitRelay).toHaveBeenCalledWith(
            expect.objectContaining({ amountOut: 1_000_000n, asset: ASSET, routing: { recipient: RECIPIENT, feeRecipient: FEE_RECIPIENT, feeAmount: 1000n } })
        );
    });

    it("reject a zero-amountOut proof before verifying the commitment", async () => {
        await expect(service.withdrawal(fakeRequest({ amountOut: 0n }))).rejects.toThrow(
            "proof.pubSignals.amountOut should be more than 0"
        );
        expect(chainService.verifyRelayWithdrawalCommitment).not.toHaveBeenCalled();
    });

    it("reject when the fee commitment fails verification", async () => {
        chainService.verifyRelayWithdrawalCommitment.mockResolvedValue(false);
        await expect(service.withdrawal(fakeRequest())).rejects.toThrow("couldn't be verified");
        expect(chainService.submitRelay).not.toHaveBeenCalled();
    });

    it("reject when the commitment's amountSent disagrees with the proof's amountOut", async () => {
        const request = fakeRequest();
        request.signedFeeCommitment.amountSent = request.proof.parsedPubSignals.amountOut + 1n;
        await expect(service.withdrawal(request)).rejects.toThrow("does not match commitment amountSent");
    });

    it("reject when the committed fee exceeds the proof's amountOut", async () => {
        const request = fakeRequest();
        request.signedFeeCommitment.feeAmount = request.proof.parsedPubSignals.amountOut + 1n;
        await expect(service.withdrawal(request)).rejects.toThrow("is less than committed fee");
    });

    it("relayAndAnnounce throws NotImplementedException", async () => {
        await expect(service.relayAndAnnounce()).rejects.toThrow(NotImplementedException);
    });

    describe("yield withdrawal (processorAddress)", () => {
        it("route a withdrawal naming the asset's yield router through withdraw_to_underlying", async () => {
            configService.yieldRouterFor.mockReturnValue(ROUTER);
            chainService.submitYieldWithdrawal.mockResolvedValue({ txHash: "0xyield" });

            const result = await service.withdrawal({ ...fakeRequest(), processorAddress: ROUTER, minUnderlyingOut: 42n });

            expect(result).toEqual({ txHash: "0xyield" });
            expect(chainService.submitYieldWithdrawal).toHaveBeenCalledWith(
                expect.objectContaining({ router: ROUTER, minUnderlyingOut: 42n, amountOut: 1_000_000n })
            );
            expect(chainService.submitRelay).not.toHaveBeenCalled();
        });

        it("reject a processor that is not the router configured for the committed asset", async () => {
            configService.yieldRouterFor.mockReturnValue(ROUTER);

            await expect(
                service.withdrawal({ ...fakeRequest(), processorAddress: StrKey.encodeContract(Buffer.alloc(32, 9)) })
            ).rejects.toThrow("is not the yield router configured");
            expect(chainService.submitYieldWithdrawal).not.toHaveBeenCalled();
        });

        it("reject any processor for an asset with no yield router", async () => {
            await expect(service.withdrawal({ ...fakeRequest(), processorAddress: ROUTER })).rejects.toThrow(
                "is not the yield router configured"
            );
        });
    });

    describe("transfer", () => {
        function transferRequest(amountOut: bigint, feeAmount = 1000n): StellarRelaySendRequest {
            const base = fakeRequest({ amountOut });
            return {
                ...base,
                signedFeeCommitment: {
                    data: "0x00",
                    asset: ASSET,
                    expiration: Date.now() + 10_000_000,
                    feeAmount,
                    signedRelayerCommitment: "0x00",
                },
            } as StellarRelaySendRequest;
        }

        beforeEach(() => {
            chainService.verifyTransferCommitment.mockResolvedValue(true);
            chainService.submitTransfer.mockResolvedValue({ txHash: "0xtransfer" });
        });

        it("submit the pool's own transact when the proof releases exactly the committed fee", async () => {
            await expect(service.transfer(transferRequest(1000n))).resolves.toEqual({ txHash: "0xtransfer" });
            expect(chainService.submitTransfer).toHaveBeenCalledWith(
                expect.objectContaining({ amountOut: 1000n, asset: ASSET, processorData: "0x00" })
            );
        });

        it("reject a transfer that would pay out more than the fee in the clear", async () => {
            await expect(service.transfer(transferRequest(1001n))).rejects.toThrow("must release exactly the committed fee");
            expect(chainService.submitTransfer).not.toHaveBeenCalled();
        });

        it("reject a proof for another asset", async () => {
            chainService.tokenIdOf.mockReturnValue(99n);
            await expect(service.transfer(transferRequest(1000n))).rejects.toThrow("does not match commitment asset");
        });

        it("reject an unverifiable transfer commitment", async () => {
            chainService.verifyTransferCommitment.mockResolvedValue(false);
            await expect(service.transfer(transferRequest(1000n))).rejects.toThrow("couldn't be verified");
        });
    });

    describe("batchWithdrawal", () => {
        const routing = (feeAmount: bigint, recipient = RECIPIENT) => ({ recipient, feeRecipient: FEE_RECIPIENT, feeAmount });
        function batchRequest(totalFee: bigint): StellarRelayBatchRequest {
            const item = fakeRequest();
            return {
                items: [item, item].map(({ proof, inputNullifierNumber, outputCommitmentNumber, noteData }) => ({
                    proof,
                    inputNullifierNumber,
                    outputCommitmentNumber,
                    noteData,
                })),
                signedBatchFeeCommitment: {
                    data: "0x00",
                    asset: ASSET,
                    expiration: Date.now() + 10_000_000,
                    totalFee,
                    maxRelayFee: 0n,
                    relayCost: 0n,
                    feeBps: 0n,
                    flatFee: 1000n,
                    signedRelayerCommitment: "0x00",
                },
            } as StellarRelayBatchRequest;
        }

        beforeEach(() => {
            chainService.verifyBatchCommitment.mockResolvedValue(true);
            chainService.decodeRoutings.mockReturnValue([routing(1000n), routing(1000n)]);
            chainService.submitRelayBatch.mockResolvedValue({ txHash: "0xbatch" });
        });

        it("relay every item in one relay_batch when each matches its signed routing", async () => {
            await expect(service.batchWithdrawal(batchRequest(2000n))).resolves.toEqual({ txHash: "0xbatch" });
            expect(chainService.submitRelayBatch).toHaveBeenCalledWith(ASSET, expect.any(Array));
            expect(chainService.submitRelayBatch.mock.calls[0]![1]).toHaveLength(2);
        });

        it("reject when the routings do not line up one-to-one with the items", async () => {
            chainService.decodeRoutings.mockReturnValue([routing(1000n)]);
            await expect(service.batchWithdrawal(batchRequest(1000n))).rejects.toThrow("encodes 1 routings but 2 items");
        });

        it("reject a mixed-destination batch", async () => {
            chainService.decodeRoutings.mockReturnValue([routing(1000n), routing(1000n, OWNER)]);
            await expect(service.batchWithdrawal(batchRequest(2000n))).rejects.toThrow("inconsistent recipient");
        });

        it("reject item fees that do not sum to the committed total", async () => {
            await expect(service.batchWithdrawal(batchRequest(1999n))).rejects.toThrow("does not match committed totalFee");
            expect(chainService.submitRelayBatch).not.toHaveBeenCalled();
        });

        it("reject an item whose proof is for another asset", async () => {
            chainService.tokenIdOf.mockReturnValue(99n);
            await expect(service.batchWithdrawal(batchRequest(2000n))).rejects.toThrow("does not match commitment asset");
        });
    });

    describe("registerAndWithdrawal", () => {
        const registration = {
            account: OWNER,
            authDigest: "0x02",
            nullifyingKeyHash: "0x01",
            deadline: "0xffffffff",
            signature: "0xabcd",
        } as const;
        const request = (): StellarRelayRegisterAndWithdrawalRequest =>
            ({ ...fakeRequest(), registration }) as StellarRelayRegisterAndWithdrawalRequest;

        it("submit register_and_relay with the owner's checked auth entry", async () => {
            const entry = {} as never;
            chainService.parseRegistrationEntry.mockResolvedValue(entry);
            chainService.submitRegisterAndRelay.mockResolvedValue({ txHash: "0xreg" });

            await expect(service.registerAndWithdrawal(request())).resolves.toEqual({ txHash: "0xreg" });
            expect(chainService.submitRegisterAndRelay).toHaveBeenCalledWith(
                expect.objectContaining({ owner: OWNER, nullifyingKeyHash: 1n, authDigest: 2n, ownerAuth: entry })
            );
        });

        it("refuse before submitting when the owner's entry fails its checks", async () => {
            chainService.parseRegistrationEntry.mockRejectedValue(new Error("registration entry has expired"));

            await expect(service.registerAndWithdrawal(request())).rejects.toThrow("expired");
            expect(chainService.submitRegisterAndRelay).not.toHaveBeenCalled();
        });

        it("check the withdrawal's commitment exactly as a plain withdrawal does", async () => {
            chainService.verifyRelayWithdrawalCommitment.mockResolvedValue(false);
            await expect(service.registerAndWithdrawal(request())).rejects.toThrow("couldn't be verified");
            expect(chainService.parseRegistrationEntry).not.toHaveBeenCalled();
        });
    });
});
