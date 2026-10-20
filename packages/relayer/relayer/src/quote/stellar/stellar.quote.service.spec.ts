import { BadRequestException } from "@nestjs/common";
import { mock } from "jest-mock-extended";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StellarQuoteService } from "./stellar.quote.service";
import { StellarConfigService } from "../../config/stellar/stellar-config.service";
import { StellarChainService } from "../../chain.service/stellar.chain.service";
import { createMockLogger } from "../../test/mocks";
import type { StellarQuoteRequest } from "./types";

const ASSET = StrKey.encodeContract(Buffer.alloc(32, 4));
const RECIPIENT = Keypair.random().publicKey();
const FEE_RECEIVER = Keypair.random().publicKey();

function fakeRequest(overrides: Partial<StellarQuoteRequest> = {}): StellarQuoteRequest {
    return {
        asset: ASSET,
        amount: 1_000_000n,
        recipient: RECIPIENT,
        commit: false,
        ...overrides,
    };
}

describe("StellarQuoteService", () => {
    let service: StellarQuoteService;
    const configService = mock<StellarConfigService>();
    const chainService = mock<StellarChainService>();

    beforeEach(() => {
        jest.clearAllMocks();
        configService.asset.mockReturnValue({ address: ASSET, ticker: "USDC", decimals: 7 });
        configService.flatFeeAmount.mockReturnValue(100n);
        configService.feeReceiverAddress.mockReturnValue(FEE_RECEIVER);
        configService.quoteExpirationMs.mockReturnValue(60_000);
        chainService.getAssetConfig.mockResolvedValue({
            enabled: true,
            minDepositAmount: 0n,
            vettingFeeBps: 0,
            maxRelayFee: 0n, // 0 = uncapped, mirroring EVM's maxRelayFee sentinel
        });
        chainService.encodeRouting.mockReturnValue("0x00");
        chainService.signRelayWithdrawalCommitment.mockResolvedValue("0xsig");
        service = new StellarQuoteService(createMockLogger() as never, configService, chainService);
    });

    it("quote a flat fee with no commitment when commit is false", async () => {
        const result = await service.quote(fakeRequest({ commit: false }), false);

        expect(result.feeAmount).toBe(100n);
        expect(result.amountSent).toBe(1_000_000n);
        expect(result.amountReceived).toBe(999_900n);
        expect(result.feeCommitment).toBeUndefined();
        expect(chainService.signRelayWithdrawalCommitment).not.toHaveBeenCalled();
    });

    it("price the flat fee from the quoted asset's own configuration", async () => {
        configService.flatFeeAmount.mockImplementation((asset?: string) => (asset === ASSET ? 7n : 100n));

        const withdrawal = await service.quote(fakeRequest({ commit: false }), false);
        const transfer = await service.quoteTransfer({ asset: ASSET, commit: false } as never);

        expect(withdrawal.feeAmount).toBe(7n);
        expect(transfer.feeAmount).toBe(7n);
        expect(configService.flatFeeAmount).toHaveBeenCalledWith(ASSET);
    });

    it("quote a bps fee when the asset has fee_bps configured", async () => {
        configService.asset.mockReturnValue({ address: ASSET, ticker: "USDC", decimals: 7, fee_bps: 50 as never });

        const result = await service.quote(fakeRequest({ amount: 1_000_000n, commit: false }), false);

        expect(result.feeAmount).toBe(5_000n); // 50 bps of 1_000_000
    });

    it("caps the fee at the on-chain maxRelayFee", async () => {
        chainService.getAssetConfig.mockResolvedValue({
            enabled: true,
            minDepositAmount: 0n,
            vettingFeeBps: 0,
            maxRelayFee: 10n,
        });

        const result = await service.quote(fakeRequest({ commit: false }), false);

        expect(result.feeAmount).toBe(10n);
    });

    it("attach a signed fee commitment when commit is true and recipient is provided", async () => {
        const result = await service.quote(fakeRequest({ commit: true, recipient: RECIPIENT }), false);

        expect(result.feeCommitment).toBeDefined();
        expect(result.feeCommitment?.signedRelayerCommitment).toBe("0xsig");
        expect(chainService.signRelayWithdrawalCommitment).toHaveBeenCalledTimes(1);
    });

    it("throw BadRequestException when commit is true but no recipient is provided", async () => {
        await expect(service.quote(fakeRequest({ commit: true, recipient: undefined }), false)).rejects.toThrow(
            BadRequestException
        );
        expect(chainService.signRelayWithdrawalCommitment).not.toHaveBeenCalled();
    });

    it("throw BadRequestException when the fee would exceed the withdrawal amount", async () => {
        configService.flatFeeAmount.mockReturnValue(2_000_000n);
        await expect(service.quote(fakeRequest({ amount: 1_000_000n, commit: false }), false)).rejects.toThrow(
            BadRequestException
        );
    });

    it("quote exact (receive-mode): amount is what the recipient receives, fee added on top", async () => {
        const result = await service.quote(fakeRequest({ amount: 1_000_000n, commit: false }), true);

        expect(result.feeAmount).toBe(100n);
        expect(result.amountReceived).toBe(1_000_000n);
        expect(result.amountSent).toBe(1_000_100n);
    });

    it("cap the exact-mode fee at the on-chain maxRelayFee too", async () => {
        chainService.getAssetConfig.mockResolvedValue({
            enabled: true,
            minDepositAmount: 0n,
            vettingFeeBps: 0,
            maxRelayFee: 10n,
        });

        const result = await service.quote(fakeRequest({ amount: 1_000_000n, commit: false }), true);

        expect(result.feeAmount).toBe(10n);
        expect(result.amountReceived).toBe(1_000_000n);
        expect(result.amountSent).toBe(1_000_010n);
    });

    describe("quoteTransfer", () => {
        it("quote the flat fee and sign no commitment when commit is false", async () => {
            const result = await service.quoteTransfer({ asset: ASSET, commit: false });

            expect(result).toEqual({ feeAmount: 100n, txCost: 0n, gasPrice: 0n });
            expect(chainService.signTransferCommitment).not.toHaveBeenCalled();
        });

        it("sign a transfer commitment binding the fee receiver's routing when committing", async () => {
            chainService.signTransferCommitment.mockResolvedValue("0xtsig");

            const result = await service.quoteTransfer({ asset: ASSET, commit: true });

            expect(chainService.encodeRouting).toHaveBeenCalledWith(FEE_RECEIVER, FEE_RECEIVER, 100n);
            expect(result.feeCommitment).toMatchObject({ asset: ASSET, feeAmount: 100n, signedRelayerCommitment: "0xtsig" });
        });

        it("price a yield share's flat fee in shares", async () => {
            configService.asset.mockReturnValue({ address: ASSET, ticker: "ppXLM", decimals: 18, yield_router: RECIPIENT as never });
            chainService.sharesForUnderlying.mockResolvedValue(4_000n);

            await expect(service.quoteTransfer({ asset: ASSET, commit: false })).resolves.toMatchObject({ feeAmount: 4_000n });
            expect(chainService.sharesForUnderlying).toHaveBeenCalledWith(ASSET, 100n);
        });
    });

    describe("quoteBatch", () => {
        it("charge each item the fee it would pay relayed alone, and sign no commitment when commit is false", async () => {
            const result = await service.quoteBatch({ asset: ASSET, recipient: RECIPIENT, amounts: [1_000n, 2_000n], commit: false });

            expect(result).toEqual({ txCost: 0n, gasPrice: 0n, totalFee: 200n, maxRelayFee: 0n });
            expect(chainService.signBatchCommitment).not.toHaveBeenCalled();
        });

        it("sign one routing per item, all to the same recipient and fee receiver, when committing", async () => {
            chainService.encodeRoutings.mockReturnValue("0xrouting");
            chainService.signBatchCommitment.mockResolvedValue("0xbsig");

            const result = await service.quoteBatch({ asset: ASSET, recipient: RECIPIENT, amounts: [1_000n, 2_000n], commit: true });

            expect(chainService.encodeRoutings).toHaveBeenCalledWith([
                { recipient: RECIPIENT, feeRecipient: FEE_RECEIVER, feeAmount: 100n },
                { recipient: RECIPIENT, feeRecipient: FEE_RECEIVER, feeAmount: 100n },
            ]);
            expect(result.feeCommitment).toMatchObject({ data: "0xrouting", totalFee: 200n, flatFee: 100n, signedRelayerCommitment: "0xbsig" });
        });

        it("refuse a batch whose item cannot cover its own fee", async () => {
            await expect(
                service.quoteBatch({ asset: ASSET, recipient: RECIPIENT, amounts: [50n], commit: false })
            ).rejects.toThrow(BadRequestException);
        });

        it("refuse extraGas, which Stellar's routing cannot carry", async () => {
            await expect(
                service.quoteBatch({ asset: ASSET, recipient: RECIPIENT, amounts: [1_000n], commit: false, extraGas: true })
            ).rejects.toThrow("extraGas is not supported");
        });
    });
});
