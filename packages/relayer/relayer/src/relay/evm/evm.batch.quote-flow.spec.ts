import { Test, TestingModule } from "@nestjs/testing";
import { ContextIdFactory, DiscoveryService } from "@nestjs/core";
import { mock } from "jest-mock-extended";
import { getAddress } from "viem";

import { EvmQuoteService } from "../../quote/evm/evm.quote.service";
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
import { CHAIN_CONTEXT } from "../../core/chain-context.token";
import { ChainType } from "../../config/enums";
import { BPS, Wei } from "../../quote/evm/unit.types";
import { RateProvider } from "../../rate_provider/rate_types";
import { decodeBatchFeeSplit, encodeWithdrawalFeeSplit } from "./fee_abi";
import type { EvmPrivateKey } from "../../config/evm/evm.types";
import type {
    Bytes,
    EvmRelayBatchRequest,
    EvmRelayBatchSDKPayload,
    NoteData,
    ReshapedProof,
} from "./types";
import { RELAY_GAS_BUDGET } from "../../quote/evm/relay_gas_budget";

// -========- Fixed test parameters -========-
//
// This spec closes a coverage seam: the standalone relay batch guard spec
// (evm.relay.service.batch.spec.ts) HAND-BUILDS its commitment and MOCKS both
// sign and verify. Here we wire the REAL EvmQuoteService, EvmRelayService and
// EVMChainService into one module and let the quote's REAL EIP-712 signature be
// verified by the REAL relay path — only RPC is neutralized. The whole point is
// that sign+verify use the genuine chain-service crypto, not a mock.

// anvil account0 — the relayer's signing key. Real key -> real signature.
const ANVIL_PKEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as EvmPrivateKey;

// Native ETH sentinel asset (all-0xee). tokenIdOut in each proof is derived from
// this so `getAddressFromBigInt(tokenIdOut) === commitment.asset`. Using the ETH
// ticker makes quoteInNativeToken short-circuit (num/den = 1), so no rate
// provider is needed and relayCost is the raw single-tx gas cost in wei.
const ASSET = getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
const TOKEN_ID_OUT = BigInt(ASSET.toLowerCase());

const RECIPIENT = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const FEE_RECIPIENT = getAddress("0xc1ebfda3114bc2496e86d466b3082491a96767df");
const RELAY_CONTRACT = getAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3");
const CHAIN_ID = 31337;
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as Bytes;

const GAS_PRICE = 1_000_000_000n; // 1 gwei
const RELAY_TX_COST = RELAY_GAS_BUDGET.relayBatchItem; // batch items price at the per-item budget
const FEE_BPS = BPS(50n); // 0.5%
const FLAT_FEE = Wei(21_000n);
const MAX_RELAY_FEE = Wei(100_000_000_000_000_000n); // 0.1 ETH (never caps here)

// The single-tx relay gas cost in token units. Native asset -> rate is 1, so
// relayCost = gasPrice * relayTxCost exactly (audit: per-item single-tx fee).
const RELAY_COST = GAS_PRICE * RELAY_TX_COST;

// The fee an item pays as a STANDALONE withdrawal — the number the quote must
// produce and the relay must agree with: min(maxRelayFee, relayCost + amount*bps/10000).
function standaloneFee(amount: bigint): bigint {
    const raw = RELAY_COST + (amount * FEE_BPS) / 10_000n;
    return raw < MAX_RELAY_FEE ? raw : MAX_RELAY_FEE;
}

// -========- Fixture builders (mirrors evm.relay.service.batch.spec.ts) -========-

// A reshaped transact proof carrying the amountOut / tokenIdOut the batch path
// reads; the remaining fields exist only to satisfy the type.
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

describe("EVM batch quote -> relay flow (real signed commitment)", () => {
    let quoteService: EvmQuoteService;
    let relayService: EvmRelayService;
    let chainService: EVMChainService;

    const mockConfigService = mock<EvmConfigService>();
    const mockContractService = mock<EvmContractService>();
    const mockDiscoveryService = { getProviders: jest.fn().mockReturnValue([]) };
    const mockDustRescueOrchestrator = mock<DustRescueOrchestratorService>();
    const mockDustRescuePricing = mock<DustRescuePricingService>();
    const mockDustRescueForwarding = mock<DustRescueForwardingService>();
    const mockYieldZapRegistry = mock<YieldZapRegistry>();

    let simulateSpy: jest.SpyInstance;
    let getGasPriceSpy: jest.SpyInstance;
    // Spied but NOT mocked — observes the REAL crypto verification result.
    let verifySpy: jest.SpyInstance;

    beforeEach(async () => {
        jest.clearAllMocks();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EvmQuoteService,
                EvmRelayService,
                EVMChainService,
                createMockLoggerProvider(),
                { provide: EvmConfigService, useValue: mockConfigService },
                { provide: EvmContractService, useValue: mockContractService },
                { provide: DiscoveryService, useValue: mockDiscoveryService },
                { provide: CHAIN_CONTEXT, useValue: { chainType: ChainType.EVM, chainId: CHAIN_ID } },
                { provide: DustRescueOrchestratorService, useValue: mockDustRescueOrchestrator },
                { provide: DustRescuePricingService, useValue: mockDustRescuePricing },
                { provide: DustRescueForwardingService, useValue: mockDustRescueForwarding },
                { provide: YieldZapRegistry, useValue: mockYieldZapRegistry },
            ],
        }).compile();

        // Config values the REAL EVMChainService constructor + sign/verify read.
        // These must be set BEFORE resolving (the chain-service constructor runs
        // during resolve and dereferences chainConfig().name / nativeCurrency()).
        mockConfigService.signerPrivateKey.mockReturnValue(ANVIL_PKEY);
        mockConfigService.relayContractAddress.mockReturnValue(RELAY_CONTRACT);
        mockConfigService.feeReceiverAddress.mockReturnValue(FEE_RECIPIENT);
        mockConfigService.flatFeeAmount.mockReturnValue(FLAT_FEE);
        mockConfigService.quoteExpirationMs.mockReturnValue(60_000);
        mockConfigService.rpcUrl.mockReturnValue("http://127.0.0.1:8545");
        mockConfigService.asset.mockReturnValue({
            fee_bps: FEE_BPS,
            ticker: "ETH",
            address: ASSET,
            quoter: RateProvider.CURVE,
            decimals: 18,
        });
        mockConfigService.chainConfig.mockReturnValue({ name: "anvil" } as unknown as ReturnType<
            EvmConfigService["chainConfig"]
        >);
        mockConfigService.nativeCurrency.mockReturnValue({
            name: "Ether",
            symbol: "ETH",
            decimals: 18,
        } as unknown as ReturnType<EvmConfigService["nativeCurrency"]>);

        mockContractService.getAssetConfig.mockResolvedValue({
            maxRelayFee: MAX_RELAY_FEE,
            enabled: true,
            minAmount: Wei(1_000_000_000_000_000n),
            vettingFeeBPS: BPS(20n),
        });

        // Share ONE request-scoped instance graph so the chain service the quote
        // signs with is the SAME instance the relay verifies with — and the SAME
        // instance we spy on for RPC neutralization.
        const contextId = ContextIdFactory.create();
        quoteService = await module.resolve(EvmQuoteService, contextId);
        relayService = await module.resolve(EvmRelayService, contextId);
        chainService = await module.resolve(EVMChainService, contextId);

        // Neutralize ONLY the RPC touchpoints. sign + verify stay REAL.
        getGasPriceSpy = jest.spyOn(chainService, "getGasPrice").mockResolvedValue(Wei(GAS_PRICE));
        simulateSpy = jest
            .spyOn(chainService, "simulateAndWriteRelayBatch")
            .mockResolvedValue(TX_HASH);
        verifySpy = jest.spyOn(chainService, "verifyRelayBatchWithdrawalCommitment"); // calls through
    });

    it("accepts the quote's real signed commitment in the relay path and submits", async () => {
        const amounts = [Wei(1_000_000_000_000_000_000n), Wei(2_000_000_000_000_000_000n)];

        // 1. Real batch quote -> real signed fee commitment (real routings/fee model).
        const quote = await quoteService.quoteBatch({
            asset: ASSET,
            recipient: RECIPIENT,
            amounts,
            extraGas: false,
            commit: true,
        });
        expect(getGasPriceSpy).toHaveBeenCalled();

        // 2. Relay request whose per-item amountOut EXACTLY equals the quoted amounts.
        const request = {
            items: amounts.map((a) => makeItem(a)),
            signedBatchFeeCommitment: quote.feeCommitment,
        } as unknown as EvmRelayBatchRequest;

        // 3. Feed the exact quote commitment into the real relay handler.
        const result = await relayService.batchWithdrawal(request);

        // -- Core seam assertion: the REAL signature VERIFIED (no "couldn't be
        //    verified" / "expired" rejection) and the batch submitted.
        expect(result).toEqual({ txHash: TX_HASH });
        expect(simulateSpy).toHaveBeenCalledTimes(1);

        // The real crypto verifier was invoked with the totals recomputed from the
        // proofs, and it genuinely returned true (spied, not mocked).
        const summed = amounts.reduce((s, a) => s + a, 0n);
        const expectedFees = amounts.map(standaloneFee);
        const totalFee = expectedFees.reduce((s, f) => s + f, 0n);
        expect(verifySpy).toHaveBeenCalledWith(quote.feeCommitment, summed, summed - totalFee);
        await expect(verifySpy.mock.results[0].value).resolves.toBe(true);

        // transactParams are rebuilt from the SIGNED routings (commitment.data),
        // each bound to the relay contract processor.
        const [payload, nativeGas] = simulateSpy.mock.calls[0] as [EvmRelayBatchSDKPayload, bigint | undefined];
        expect(nativeGas).toBeUndefined();
        expect(payload.proofs).toHaveLength(2);
        expect(payload.noteData).toHaveLength(2);
        expect(payload.transactParams).toHaveLength(2);

        const routings = decodeBatchFeeSplit(quote.feeCommitment.data);
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

        // The quote and relay AGREE on the fee: each item pays its standalone
        // single-tx fee (relayCost + amount*bps/10000, capped).
        expect(routings.map((r) => r.feeAmount)).toEqual(expectedFees);
        expect(BigInt(quote.totalFee)).toBe(totalFee);
        expect(BigInt(quote.feeCommitment.relayCost)).toBe(RELAY_COST);
        expect(BigInt(quote.feeCommitment.feeBps)).toBe(FEE_BPS);
    });

    it("rejects when a signed field of the quote commitment is mutated after quoting", async () => {
        const amounts = [Wei(1_000_000_000_000_000_000n)];

        const quote = await quoteService.quoteBatch({
            asset: ASSET,
            recipient: RECIPIENT,
            amounts,
            extraGas: false,
            commit: true,
        });

        // Tamper with a SIGNED field (relayCost is bound by the EIP-712 message).
        // The routings/data are untouched, so every business guard still passes —
        // only the real signature check fails, proving the binding is genuine and
        // not a mocked `true`.
        const tampered = {
            ...quote.feeCommitment,
            relayCost: Wei(BigInt(quote.feeCommitment.relayCost) + 1n),
        };
        const request = {
            items: amounts.map((a) => makeItem(a)),
            signedBatchFeeCommitment: tampered,
        } as unknown as EvmRelayBatchRequest;

        await expect(relayService.batchWithdrawal(request)).rejects.toThrow(
            "The provided batch fee commitment couldn't be verified"
        );
        // Real verifier ran and genuinely returned false.
        await expect(verifySpy.mock.results[0].value).resolves.toBe(false);
        expect(simulateSpy).not.toHaveBeenCalled();
    });
});
