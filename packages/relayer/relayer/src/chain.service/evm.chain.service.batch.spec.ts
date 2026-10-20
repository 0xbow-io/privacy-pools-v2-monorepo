import { Test, TestingModule } from "@nestjs/testing";
import { EVMChainService } from "./evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import { Bytes } from "../relay/evm/types";
import { ISignedBatchWithdrawalFeeCommitment } from "../relayer.types";
import { BPS, Wei } from "../quote/evm/unit.types";
import { encodeBatchFeeSplit, decodeBatchFeeSplit } from "../relay/evm/fee_abi";

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const FEE_RECIPIENT = "0xc1ebfda3114bc2496e86d466b3082491a96767df" as const;
const ASSET = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;

describe("EVM chain service — batch withdrawal commitment.", () => {
    let service: EVMChainService;

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8545"),
        relayContractAddress: jest.fn().mockReturnValue("0x5FbDB2315678afecb367f032d93F642f64180aa3"),
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
    });

    function makeData(fees: bigint[]): Bytes {
        return encodeBatchFeeSplit(
            fees.map((feeAmount) => ({
                recipient: RECIPIENT,
                feeRecipient: FEE_RECIPIENT,
                feeAmount,
                nativeGas: 0n,
            }))
        );
    }

    it("round-trip encode/decode a PayoutRouting[]", () => {
        const data = makeData([30n, 0n, 5n]);
        const decoded = decodeBatchFeeSplit(data);
        expect(decoded).toHaveLength(3);
        expect(decoded[0].feeAmount).toBe(30n);
        expect(decoded[2].feeAmount).toBe(5n);
        expect(decoded[0].recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    });

    it("sign a batch commitment and verify it with the recomputed totals", async () => {
        const data = makeData([30n, 0n]);
        const expiration = Date.now() + 10_000_000;
        const totalAmountSent = 150n;
        const totalAmountReceived = 120n;

        const signature = await service.signRelayBatchWithdrawalCommitment({
            data,
            asset: ASSET,
            expiration,
            totalAmountSent,
            totalAmountReceived,
            relayCost: 10n,
            feeBps: 1000n,
            flatFee: 0n,
        });

        const commitment: ISignedBatchWithdrawalFeeCommitment = {
            data,
            asset: ASSET,
            expiration,
            totalFee: Wei(30n),
            maxRelayFee: Wei(100n),
            relayCost: Wei(10n),
            feeBps: BPS(1000n),
            flatFee: Wei(0n),
            signedRelayerCommitment: signature,
        };

        const ok = await service.verifyRelayBatchWithdrawalCommitment(commitment, totalAmountSent, totalAmountReceived);
        expect(ok).toBe(true);
    });

    it("reject verification when a signed fee-model parameter is tampered", async () => {
        const data = makeData([30n, 0n]);
        const expiration = Date.now() + 10_000_000;

        const signature = await service.signRelayBatchWithdrawalCommitment({
            data,
            asset: ASSET,
            expiration,
            totalAmountSent: 150n,
            totalAmountReceived: 120n,
            relayCost: 10n,
            feeBps: 1000n,
            flatFee: 0n,
        });

        const commitment: ISignedBatchWithdrawalFeeCommitment = {
            data,
            asset: ASSET,
            expiration,
            totalFee: Wei(30n),
            maxRelayFee: Wei(100n),
            // relayCost tampered from the signed 10 -> signature no longer verifies.
            relayCost: Wei(999n),
            feeBps: BPS(1000n),
            flatFee: Wei(0n),
            signedRelayerCommitment: signature,
        };

        const ok = await service.verifyRelayBatchWithdrawalCommitment(commitment, 150n, 120n);
        expect(ok).toBe(false);
    });

    it("reject verification when the recomputed sent total is tampered", async () => {
        const data = makeData([30n, 0n]);
        const expiration = Date.now() + 10_000_000;

        const signature = await service.signRelayBatchWithdrawalCommitment({
            data,
            asset: ASSET,
            expiration,
            totalAmountSent: 150n,
            totalAmountReceived: 120n,
            relayCost: 10n,
            feeBps: 1000n,
            flatFee: 0n,
        });

        const commitment: ISignedBatchWithdrawalFeeCommitment = {
            data,
            asset: ASSET,
            expiration,
            totalFee: Wei(30n),
            maxRelayFee: Wei(100n),
            relayCost: Wei(10n),
            feeBps: BPS(1000n),
            flatFee: Wei(0n),
            signedRelayerCommitment: signature,
        };

        // Verify with a different sent total than was signed -> signature mismatch.
        const ok = await service.verifyRelayBatchWithdrawalCommitment(commitment, 200n, 170n);
        expect(ok).toBe(false);
    });

    it("throw when the batch commitment has expired", async () => {
        const data = makeData([30n]);
        const commitment: ISignedBatchWithdrawalFeeCommitment = {
            data,
            asset: ASSET,
            expiration: Date.now() - 1_000,
            totalFee: Wei(30n),
            maxRelayFee: Wei(100n),
            relayCost: Wei(10n),
            feeBps: BPS(1000n),
            flatFee: Wei(0n),
            signedRelayerCommitment: "0x00" as Bytes,
        };
        await expect(service.verifyRelayBatchWithdrawalCommitment(commitment, 30n, 0n)).rejects.toThrow(
            "Batch fee commitment has expired"
        );
    });
});
