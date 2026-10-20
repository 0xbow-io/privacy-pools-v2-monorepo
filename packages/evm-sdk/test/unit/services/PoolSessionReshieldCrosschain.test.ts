import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    AssetConfig,
    EstimateReshieldCrosschainParams,
    FinalizedBlockResult,
    Hash,
    Hex,
    IEntrypointInteractor,
    IPPYieldTokenInteractor,
    IRelayerInteractor,
    IRPCInteractor,
    ISwapAndDepositQuoteProvider,
    ISwapQuoteProvider,
    PrepareDepositResult,
    PreparedReshieldCrosschainQuote,
    PreparedTransaction,
    PrepareReshieldCrosschainQuoteParams,
    ReadContractParams,
    RelayerChainDetails,
    RelayerInfo,
    ReshieldCrosschainParams,
    SwapQuoteParams,
    YieldDepositTarget,
    YieldSwapDepositTarget,
} from "../../../src/internal.js";
import {
    AssetNotSupported,
    DepositBelowMinimum,
    DestinationCallsUnsupported,
    DestinationChainNotSupported,
    DestinationDepositTargetMismatch,
    DestinationDepositUnaffordable,
    DustRescueRecipientConflict,
    EMPTY_ADDRESS,
    EvmAddressEqualityComparator,
    EvmSwapChainAdapter,
    hasErrorAmounts,
    InvalidPoolSessionConfig,
    InvalidTransactParams,
    NATIVE_ASSET_ADDRESS,
    NativeDestinationDepositUnsupported,
    PoolSessionReshieldCrosschain,
    PoolSessionReshieldTransferCrosschain,
    RELAY_SWAP_ROUTING_ABI,
    RELAY_SWAP_ROUTING_TYPEHASH,
    RelayFeeExceedsMax,
    RelaySwapsLayoutMismatch,
    SwapValueExceedsRelayerCap,
    toYieldSwapDepositTarget,
    TransactOrchestrator,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";

// --- Constants ---

const POOL_CHAIN_ID = 11155111;
const DESTINATION_CHAIN_ID = 42161;
const DESTINATION_CHAIN_TYPE = "evm";
const SOURCE_ENTRYPOINT = "0x9999999999999999999999999999999999999991" as Address;
const DESTINATION_ENTRYPOINT = "0x8888888888888888888888888888888888888882" as Address;
const VALID_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const VALID_OUTPUT_TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
const VALID_RELAY = "0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd" as Address;
const VALID_PROCESSOR = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
const VALID_SWAP_TARGET = "0x1111111111111111111111111111111111111111" as Address;
const VALID_FALLBACK = "0x2222222222222222222222222222222222222222" as Address;
// LiFi's chain-1 Executor (LIFI_SWAP_EXECUTORS[1]); known Executors are screened on any chain,
// so this is rejected on the Sepolia pool too.
const LIFI_EXECUTOR = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;
const AMOUNT = "0xf4240" as Hex; // 1_000_000
const FEE_AMOUNT = "10";
const SWAP_CALLDATA = "0xdeadbeef" as Hex;
// Embeds the ABI-padded DESTINATION_ENTRYPOINT address and the deposit calldata body so the
// byte-containment check passes in happy-path tests for prepareReshieldCrosschainQuote.
const LIFI_TRANSACTION_DATA = ("0x" +
    "0000000000000000000000008888888888888888888888888888888888888882" + // DESTINATION_ENTRYPOINT ABI-padded to 32 bytes
    "abcdef") as Hex; // deposit calldata body
const MOCK_COMMITMENT =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as Hash;

const NOTE_VALUE = 1_000_000n;
const VETTING_BPS = 20n;
const TOTAL_DEPOSIT_COST = (NOTE_VALUE + (NOTE_VALUE * VETTING_BPS) / 10000n).toString();

// Local mirror of LiFi's StargateFacetV2 signature (selector 0xa6010a66, verified against
// live calldata 2026-08-31) — the affordability-gate tests must feed prepare REAL
// Stargate-shaped calldata so `decodeStargateDestBudget` exercises actual decoding.
const STARGATE_FACET_TEST_ABI = [
    {
        type: "function",
        name: "swapAndStartBridgeTokensViaStargate",
        stateMutability: "payable",
        inputs: [
            {
                name: "_bridgeData",
                type: "tuple",
                components: [
                    { name: "transactionId", type: "bytes32" },
                    { name: "bridge", type: "string" },
                    { name: "integrator", type: "string" },
                    { name: "referrer", type: "address" },
                    { name: "sendingAssetId", type: "address" },
                    { name: "receiver", type: "address" },
                    { name: "minAmount", type: "uint256" },
                    { name: "destinationChainId", type: "uint256" },
                    { name: "hasSourceSwaps", type: "bool" },
                    { name: "hasDestinationCall", type: "bool" },
                ],
            },
            {
                name: "_swapData",
                type: "tuple[]",
                components: [
                    { name: "callTo", type: "address" },
                    { name: "approveTo", type: "address" },
                    { name: "sendingAssetId", type: "address" },
                    { name: "receivingAssetId", type: "address" },
                    { name: "fromAmount", type: "uint256" },
                    { name: "callData", type: "bytes" },
                    { name: "requiresDeposit", type: "bool" },
                ],
            },
            {
                name: "_stargateData",
                type: "tuple",
                components: [
                    { name: "assetId", type: "uint16" },
                    {
                        name: "sendParams",
                        type: "tuple",
                        components: [
                            { name: "dstEid", type: "uint32" },
                            { name: "to", type: "bytes32" },
                            { name: "amountLD", type: "uint256" },
                            { name: "minAmountLD", type: "uint256" },
                            { name: "extraOptions", type: "bytes" },
                            { name: "composeMsg", type: "bytes" },
                            { name: "oftCmd", type: "bytes" },
                        ],
                    },
                    {
                        name: "fee",
                        type: "tuple",
                        components: [
                            { name: "nativeFee", type: "uint256" },
                            { name: "lzTokenFee", type: "uint256" },
                        ],
                    },
                    { name: "refundAddress", type: "address" },
                ],
            },
        ],
        outputs: [],
    },
] as const;

const RELAYER_INFO: RelayerInfo = {
    url: "https://relay.test",
    name: "test-relay",
    chainId: POOL_CHAIN_ID,
    chainType: "evm",
    status: "active",
    address: VALID_RELAY,
    processorAddress: VALID_PROCESSOR,
};

const DEFAULT_ASSET_CONFIG: AssetConfig = {
    enabled: true,
    minAmount: "0x1" as Hex,
    vettingFeeBPS: "0x14" as Hex, // 20 bps
    maxRelayFee: "0x0" as Hex,
};

// --- Mock factories ---

function createMockEntrypointInteractor(
    address: Address,
    assetConfig: Partial<AssetConfig> = {},
): IEntrypointInteractor {
    return {
        getAddress: vi.fn(() => address),
        getAssetConfig: vi.fn(async () => ({ ...DEFAULT_ASSET_CONFIG, ...assetConfig })),
    } as unknown as IEntrypointInteractor;
}

function createMockRelayerInteractor(): IRelayerInteractor {
    const interactor = {
        getRelayers: vi.fn(async () => []),
        // A relayer predating cap publication: no maxSwapValueWei, so the B2 cap check is skipped.
        getChainDetails: vi.fn(async () => ({})),
        getTransferQuote: vi.fn(),
        getWithdrawalQuote: vi.fn(),
        getBatchWithdrawalQuote: vi.fn(),
        getSwapQuote: vi.fn(),
        relayTransfer: vi.fn(),
        relayWithdrawal: vi.fn(),
        relayBatchWithdrawal: vi.fn(),
        relaySwap: vi.fn(async () => "0x1" as Hex),
    };
    vi.mocked(interactor.getSwapQuote).mockImplementation(
        async (_relayer: RelayerInfo, req: SwapQuoteParams) => ({
            txCost: "0",
            gasPrice: "0",
            feeAmount: FEE_AMOUNT,
            feeCommitment: {
                data: encodeAbiParameters(RELAY_SWAP_ROUTING_ABI, [
                    {
                        swapTarget: (req.swapTarget ?? VALID_SWAP_TARGET) as Address,
                        approvalAddress: (req.approvalAddress ??
                            req.swapTarget ??
                            VALID_SWAP_TARGET) as Address,
                        outputToken: req.outputToken as Address,
                        recipient: req.recipient as Address,
                        feeRecipient: VALID_RELAY,
                        fallbackAddress: (req.fallbackAddress ?? req.recipient) as Address,
                        dustRecipient: req.dustRecipient as Address,
                        feeAmount: BigInt(FEE_AMOUNT),
                        minOutputAmount: BigInt(req.minOutputAmount),
                        nativeGas: 0n,
                        // Echo the B2 fields the SDK sent, mirroring what the real relayer
                        // signs into the routing.
                        swapValue: req.swapValue !== undefined ? BigInt(req.swapValue) : 0n,
                        gasSwapMaxInput:
                            req.gasSwapMaxInput !== undefined ? BigInt(req.gasSwapMaxInput) : 0n,
                        gasSwapCalldata: (req.gasSwapCalldata ?? "0x") as Hex,
                        swapCalldata: (req.swapCalldata ?? SWAP_CALLDATA) as Hex,
                        // RC-10: mirror what the real relayer does — encode the
                        // requested dustRescue into the signed routing itself.
                        dustRescue: req.dustRescue
                            ? {
                                  chainId: BigInt(req.dustRescue.destinationChainId),
                                  tokenId: req.dustRescue.tokenId,
                                  isCanonical:
                                      req.dustRescue.recipientIdentifier.kind === "canonical",
                                  spendingPubKey: req.dustRescue.recipientIdentifier.spendingPubKey,
                                  viewingPubKey:
                                      req.dustRescue.recipientIdentifier.kind === "canonical"
                                          ? req.dustRescue.recipientIdentifier.viewingPubKey
                                          : ("0x" as Hex),
                              }
                            : {
                                  chainId: 0n,
                                  tokenId: "0x0000000000000000000000000000000000000000" as Address,
                                  isCanonical: false,
                                  spendingPubKey: "0x" as Hex,
                                  viewingPubKey: "0x" as Hex,
                              },
                    },
                ]),
                asset: VALID_TOKEN,
                expiration: 0,
                feeAmount: FEE_AMOUNT,
                signedRelayerCommitment: "0xdeadbeef" as Hex,
                recipient: req.recipient as Address,
                amountSent: BigInt(req.amount).toString(),
            },
        }),
    );
    return interactor as unknown as IRelayerInteractor;
}

function createMockSwapQuoteProvider(): ISwapQuoteProvider {
    return {
        getSwapQuote: vi.fn(
            async (req: {
                fromToken: Address;
                toToken: Address;
                fromChainId: number;
                toChainId: number;
            }) => ({
                fromAmount: "999990",
                toAmount: "1030000",
                toAmountMin: "1020305",
                approvalAddress: VALID_PROCESSOR,
                transactionData: SWAP_CALLDATA,
                transactionTo: VALID_PROCESSOR,
                estimatedDuration: 30,
                fromTokenAddress: req.fromToken,
                toTokenAddress: req.toToken,
                fromChainId: req.fromChainId,
                toChainId: req.toChainId,
            }),
        ),
    } as unknown as ISwapQuoteProvider;
}

function createMockSwapAndDepositQuoteProvider(): ISwapAndDepositQuoteProvider {
    return {
        getSwapAndDepositQuote: vi.fn(
            async (req: {
                fromToken: Address;
                toToken: Address;
                fromChainId: number;
                toChainId: number;
            }) => ({
                fromAmount: "999990",
                toAmount: TOTAL_DEPOSIT_COST,
                approvalAddress: VALID_PROCESSOR,
                transactionData: LIFI_TRANSACTION_DATA,
                transactionTo: VALID_SWAP_TARGET,
                transactionValue: "0x0" as Hex,
                estimatedDuration: 30,
                fromTokenAddress: req.fromToken,
                toTokenAddress: req.toToken,
                fromChainId: req.fromChainId,
                toChainId: req.toChainId,
            }),
        ),
    } as unknown as ISwapAndDepositQuoteProvider;
}

function createMockCore(): TransactOrchestrator {
    return {
        prepareTransact: vi.fn(async () => ({
            changePendingNotes: [],
            recipientPendingNotes: [],
            callData: "0xabcdef" as Hex,
            to: SOURCE_ENTRYPOINT,
            spentNotes: [],
            spentNullifiers: [MOCK_SPENT_NULLIFIER],
            notesData: [],
            proof: {},
        })),
        persistNoteUpdates: vi.fn(),
        warmMerkleCaches: vi.fn(async () => { /* no-op */ }),
    } as unknown as TransactOrchestrator;
}

const MOCK_SPENT_NULLIFIER = `0x${"11".repeat(32)}` as Hex;

function createMockRPCInteractor(): IRPCInteractor {
    return {
        readContract: vi.fn(async ({ functionName }: ReadContractParams) =>
            functionName === "ROUTING_TYPEHASH" ? RELAY_SWAP_ROUTING_TYPEHASH : true,
        ),
        getBlockNumber: vi.fn(),
        getFinalizedBlockNumber: vi.fn(
            async () => ({ status: "unsupported" }) as FinalizedBlockResult,
        ),
        waitForTransactionReceipt: vi.fn(async () => ({
            status: true,
            blockNumber: "0x1" as Hex,
            txHash: "0x1" as Hex,
            logs: [],
        })),
        getLogs: vi.fn(),
        getLogsPaginated: vi.fn(),
    };
}

function buildDepositResult(overrides?: {
    to?: Address;
    tokenId?: Address;
    value?: bigint;
}): PrepareDepositResult {
    return {
        depositTx: {
            data: "0xabcdef" as Hex,
            to: overrides?.to ?? DESTINATION_ENTRYPOINT,
            value: "0x0" as Hex,
        },
        approvalTx: null,
        pendingNote: {
            tokenId: overrides?.tokenId ?? VALID_OUTPUT_TOKEN,
            value: `0x${(overrides?.value ?? NOTE_VALUE).toString(16)}` as Hex,
        },
    } as PrepareDepositResult;
}

// --- Tests ---

describe("PoolSessionReshieldCrosschain", () => {
    let relayerInteractor: IRelayerInteractor;
    let entrypointInteractor: IEntrypointInteractor;
    let destinationEntrypointInteractor: IEntrypointInteractor;
    let swapQuoteProvider: ISwapQuoteProvider;
    let swapAndDepositQuoteProvider: ISwapAndDepositQuoteProvider;
    let core: TransactOrchestrator;
    let service: PoolSessionReshieldCrosschain<PreparedTransaction>;

    function buildService(relayerChainDetails?: RelayerChainDetails[]): void {
        service = new PoolSessionReshieldCrosschain({
            chainId: POOL_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            destinationChainType: DESTINATION_CHAIN_TYPE,
            core,
            relayerInteractor,
            rpcInteractor: createMockRPCInteractor(),
            addressEqualityComparator: new EvmAddressEqualityComparator(),
            emptyAddress: EMPTY_ADDRESS,
            nativeAssetAddress: NATIVE_ASSET_ADDRESS,
            swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
            entrypointInteractor,
            destinationEntrypointInteractor,
            swapQuoteProvider,
            swapAndDepositQuoteProvider,
            relayerChainDetails,
        });
    }

    beforeEach(() => {
        relayerInteractor = createMockRelayerInteractor();
        entrypointInteractor = createMockEntrypointInteractor(SOURCE_ENTRYPOINT);
        destinationEntrypointInteractor = createMockEntrypointInteractor(DESTINATION_ENTRYPOINT);
        swapQuoteProvider = createMockSwapQuoteProvider();
        swapAndDepositQuoteProvider = createMockSwapAndDepositQuoteProvider();
        core = createMockCore();
        buildService();
    });

    describe("estimateReshieldCrosschainAmount", () => {
        function estimateParams(): EstimateReshieldCrosschainParams {
            return {
                relayerInfo: RELAYER_INFO,
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                toChainId: DESTINATION_CHAIN_ID,
                toChainType: DESTINATION_CHAIN_TYPE,
                fallbackAddress: VALID_FALLBACK,
            };
        }

        // --- Route-guarantee sizing (2026-09-24) ---
        // LiFi encodes the contractCalls route's guaranteed delivery — not the amount we
        // request — as the destination call's budget. The estimate probes that route
        // (placeholder calldata) and never sizes the deposit above it.

        function armProbe(destinationCallAmount?: string): void {
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: {
                    fromToken: Address;
                    toToken: Address;
                    fromChainId: number;
                    toChainId: number;
                }) => ({
                    fromAmount: "999990",
                    toAmount: "0",
                    ...(destinationCallAmount ? { destinationCallAmount } : {}),
                    approvalAddress: VALID_PROCESSOR,
                    transactionData: LIFI_TRANSACTION_DATA,
                    transactionTo: VALID_SWAP_TARGET,
                    transactionValue: "0x0" as Hex,
                    estimatedDuration: 30,
                    fromTokenAddress: req.fromToken,
                    toTokenAddress: req.toToken,
                    fromChainId: req.fromChainId,
                    toChainId: req.toChainId,
                }),
            );
        }

        it("probe the contractCalls route with placeholder calldata against the destination deposit target", async () => {
            armProbe("1500000");
            await service.estimateReshieldCrosschainAmount(estimateParams());

            const probe = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(probe.depositCalldata.startsWith("0xd3f0f1de")).toBe(true);
            expect(probe.poolAddress).toBe(DESTINATION_ENTRYPOINT);
            expect(probe.toChainId).toBe(DESTINATION_CHAIN_ID);
            expect(probe.fromAddress).toBe(VALID_PROCESSOR);
        });

        it("size the note down to the route's guaranteed delivery when it is below the plain-quote sizing", async () => {
            // Plain quote toAmountMin 1_020_305 → 98% = 999_898; the route only guarantees
            // 900_000, so the deposit is sized from 900_000 minus the 1% drift margin.
            armProbe("900000");
            const estimate = await service.estimateReshieldCrosschainAmount(estimateParams());

            const guaranteedSafe = (900_000n * 9_900n) / 10_000n; // 891_000
            expect(BigInt(estimate.noteValue)).toBe(
                (guaranteedSafe * 10_000n) / (10_000n + VETTING_BPS),
            );
            expect(BigInt(estimate.totalDepositCost)).toBeLessThanOrEqual(guaranteedSafe);
        });

        it("size the note from the B2-reduced guarantee when the route needs a native fee", async () => {
            // The route wants a native fee (transactionValue > 0) for an ERC-20 input, so
            // prepare will carve a gas-swap slice out of the budget and re-quote the main leg
            // on what is left. Probed on the full amount the route guarantees 1_500_000; on
            // the reduced budget only 700_000. The estimate must size from the latter, or
            // prepare refuses it with DestinationDepositUnaffordable on every attempt
            // (BSC -> Ethereum, 2026-09-27).
            const GAS_SWAP_INPUT = 250_000n;
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: {
                    fromToken: Address;
                    toToken: Address;
                    fromChainId: number;
                    toChainId: number;
                    netFromAmount?: string;
                }) => ({
                    fromAmount: req.netFromAmount ?? "999990",
                    toAmount: "0",
                    destinationCallAmount:
                        req.netFromAmount !== undefined && BigInt(req.netFromAmount) < 999_000n ? "700000" : "1500000",
                    approvalAddress: VALID_PROCESSOR,
                    transactionData: LIFI_TRANSACTION_DATA,
                    transactionTo: VALID_SWAP_TARGET,
                    transactionValue: "0x1000" as Hex,
                    estimatedDuration: 30,
                    fromTokenAddress: req.fromToken,
                    toTokenAddress: req.toToken,
                    fromChainId: req.fromChainId,
                    toChainId: req.toChainId,
                }),
            );
            const plain = vi.mocked(swapQuoteProvider.getSwapQuote).getMockImplementation()!;
            vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementation(async (req) => {
                const r = req as { fromToken: Address; toToken: Address; fromChainId: number; toChainId: number };
                if (r.fromChainId === r.toChainId && r.toToken === NATIVE_ASSET_ADDRESS) {
                    return {
                        fromAmount: GAS_SWAP_INPUT.toString(),
                        toAmount: "0",
                        toAmountMin: "0",
                        approvalAddress: VALID_PROCESSOR,
                        transactionData: "0xba5eba11" as Hex,
                        transactionTo: VALID_SWAP_TARGET,
                        estimatedDuration: 15,
                        fromTokenAddress: r.fromToken,
                        toTokenAddress: r.toToken,
                        fromChainId: r.fromChainId,
                        toChainId: r.toChainId,
                    } as Awaited<ReturnType<ISwapQuoteProvider["getSwapQuote"]>>;
                }
                return plain(req);
            });

            // The relayer surcharges the gas-swap tx when swapValue is set: a distinct fee, so
            // a regression reporting the preliminary fee cannot pass.
            const B2_FEE = "5000";
            const plainFee = vi.mocked(relayerInteractor.getSwapQuote).getMockImplementation()!;
            vi.mocked(relayerInteractor.getSwapQuote).mockImplementation(async (info, body) => {
                const quote = await plainFee(info, body);
                return (body as { swapValue?: string }).swapValue !== undefined ? { ...quote, feeAmount: B2_FEE } : quote;
            });

            const estimate = await service.estimateReshieldCrosschainAmount(estimateParams());

            // Second probe on the reduced budget: net after the B2-surcharged fee, minus the slice.
            const mainLeg = BigInt(AMOUNT) - BigInt(B2_FEE) - GAS_SWAP_INPUT;
            const probes = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock.calls;
            expect(probes).toHaveLength(2);
            expect(BigInt(probes[1][0].netFromAmount as string)).toBe(mainLeg);
            expect(estimate.feeAmount).toBe(B2_FEE);
            expect(BigInt(estimate.netSwapAmount)).toBe(mainLeg);
            // The fee was re-quoted with the B2 fields, as prepare does.
            const feeQuotes = vi.mocked(relayerInteractor.getSwapQuote).mock.calls;
            expect(feeQuotes.some(([, body]) => (body as { swapValue?: string }).swapValue !== undefined)).toBe(true);
            // Sized from the reduced guarantee (minus the 1% drift margin), not the full one.
            const guaranteedSafe = (700_000n * 9_900n) / 10_000n;
            expect(BigInt(estimate.totalDepositCost)).toBeLessThanOrEqual(guaranteedSafe);
            expect(BigInt(estimate.noteValue)).toBe((guaranteedSafe * 10_000n) / (10_000n + VETTING_BPS));
        });

        it("scale the sizing by the gas-swap slice when the reduced probe exposes no guarantee", async () => {
            const GAS_SWAP_INPUT = 250_000n;
            // Baseline: the same route with no native fee, so no B2.
            armProbe("1500000");
            const baseline = await service.estimateReshieldCrosschainAmount(estimateParams());
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: { fromToken: Address; toToken: Address; fromChainId: number; toChainId: number; netFromAmount?: string }) => {
                    const reduced = req.netFromAmount !== undefined && BigInt(req.netFromAmount) < 999_000n;
                    return {
                        fromAmount: req.netFromAmount ?? "999990",
                        toAmount: "0",
                        ...(reduced ? {} : { destinationCallAmount: "1500000" }),
                        approvalAddress: VALID_PROCESSOR,
                        transactionData: LIFI_TRANSACTION_DATA,
                        transactionTo: VALID_SWAP_TARGET,
                        transactionValue: "0x1000" as Hex,
                        estimatedDuration: 30,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    };
                },
            );
            const plain = vi.mocked(swapQuoteProvider.getSwapQuote).getMockImplementation()!;
            vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementation(async (req) => {
                const r = req as { fromToken: Address; toToken: Address; fromChainId: number; toChainId: number };
                if (r.fromChainId === r.toChainId && r.toToken === NATIVE_ASSET_ADDRESS) {
                    return {
                        fromAmount: GAS_SWAP_INPUT.toString(),
                        toAmount: "0",
                        toAmountMin: "0",
                        approvalAddress: VALID_PROCESSOR,
                        transactionData: "0xba5eba11" as Hex,
                        transactionTo: VALID_SWAP_TARGET,
                        estimatedDuration: 15,
                        fromTokenAddress: r.fromToken,
                        toTokenAddress: r.toToken,
                        fromChainId: r.fromChainId,
                        toChainId: r.toChainId,
                    } as Awaited<ReturnType<ISwapQuoteProvider["getSwapQuote"]>>;
                }
                return plain(req);
            });
            const estimate = await service.estimateReshieldCrosschainAmount(estimateParams());
            // Roughly a quarter of the budget goes to the gas swap, so the note shrinks by about that.
            expect(BigInt(estimate.noteValue)).toBeLessThan((BigInt(baseline.noteValue) * 80n) / 100n);
        });

        it("refuse when the reduced B2 probe moves to another router", async () => {
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: { fromToken: Address; toToken: Address; fromChainId: number; toChainId: number; netFromAmount?: string }) => {
                    const reduced = req.netFromAmount !== undefined && BigInt(req.netFromAmount) < 999_000n;
                    return {
                        fromAmount: req.netFromAmount ?? "999990",
                        toAmount: "0",
                        destinationCallAmount: reduced ? "700000" : "1500000",
                        approvalAddress: VALID_PROCESSOR,
                        transactionData: LIFI_TRANSACTION_DATA,
                        transactionTo: reduced ? VALID_FALLBACK : VALID_SWAP_TARGET,
                        transactionValue: "0x1000" as Hex,
                        estimatedDuration: 30,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    };
                },
            );
            const plain = vi.mocked(swapQuoteProvider.getSwapQuote).getMockImplementation()!;
            vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementation(async (req) => {
                const r = req as { fromToken: Address; toToken: Address; fromChainId: number; toChainId: number };
                if (r.fromChainId === r.toChainId && r.toToken === NATIVE_ASSET_ADDRESS) {
                    return {
                        fromAmount: "250000",
                        toAmount: "0",
                        toAmountMin: "0",
                        approvalAddress: VALID_PROCESSOR,
                        transactionData: "0xba5eba11" as Hex,
                        transactionTo: VALID_SWAP_TARGET,
                        estimatedDuration: 15,
                        fromTokenAddress: r.fromToken,
                        toTokenAddress: r.toToken,
                        fromChainId: r.fromChainId,
                        toChainId: r.toChainId,
                    } as Awaited<ReturnType<ISwapQuoteProvider["getSwapQuote"]>>;
                }
                return plain(req);
            });
            // Re-sizing against the moved router is attempted, but the gas swap cannot follow it.
            await expect(service.estimateReshieldCrosschainAmount(estimateParams())).rejects.toThrow(
                /B2 gas-swap router .* differs from the main swap router/,
            );
        });

        it("re-size the B2 gas swap when the reduced probe's native fee drifts above the sized swapValue", async () => {
            // LiFi re-quotes every call: the reduced probe comes back on a higher LayerZero fee
            // (Mainnet gas moved) than the probe the gas swap was sized from. That is drift, so
            // the estimate re-sizes from the reduced quote instead of refusing.
            let reducedCalls = 0;
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: { fromToken: Address; toToken: Address; fromChainId: number; toChainId: number; netFromAmount?: string }) => {
                    const reduced = req.netFromAmount !== undefined && BigInt(req.netFromAmount) < 999_000n;
                    if (reduced) reducedCalls++;
                    return {
                        fromAmount: req.netFromAmount ?? "999990",
                        toAmount: "0",
                        destinationCallAmount: reduced ? "700000" : "1500000",
                        approvalAddress: VALID_PROCESSOR,
                        transactionData: LIFI_TRANSACTION_DATA,
                        transactionTo: VALID_SWAP_TARGET,
                        // 0x1000 sizes swapValue 4915; every reduced quote wants 0x2000 = 8192.
                        transactionValue: (reduced ? "0x2000" : "0x1000") as Hex,
                        estimatedDuration: 30,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    };
                },
            );
            const plain = vi.mocked(swapQuoteProvider.getSwapQuote).getMockImplementation()!;
            vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementation(async (req) => {
                const r = req as { fromToken: Address; toToken: Address; fromChainId: number; toChainId: number };
                if (r.fromChainId === r.toChainId && r.toToken === NATIVE_ASSET_ADDRESS) {
                    return {
                        fromAmount: "250000",
                        toAmount: "0",
                        toAmountMin: "0",
                        approvalAddress: VALID_PROCESSOR,
                        transactionData: "0xba5eba11" as Hex,
                        transactionTo: VALID_SWAP_TARGET,
                        estimatedDuration: 15,
                        fromTokenAddress: r.fromToken,
                        toTokenAddress: r.toToken,
                        fromChainId: r.fromChainId,
                        toChainId: r.toChainId,
                    } as Awaited<ReturnType<ISwapQuoteProvider["getSwapQuote"]>>;
                }
                return plain(req);
            });

            await expect(service.estimateReshieldCrosschainAmount(estimateParams())).resolves.toBeDefined();
            expect(reducedCalls).toBe(2);
            // The second fee quote carries the gas swap re-sized from the drifted fee (8192 x 1.2).
            const swapValues = vi
                .mocked(relayerInteractor.getSwapQuote)
                .mock.calls.map(([, body]) => (body as { swapValue?: string }).swapValue)
                .filter((v) => v !== undefined);
            expect(swapValues).toEqual(["4915", "9830"]);
        });

        it("skip the B2 sizing when the route needs no native fee", async () => {
            armProbe("900000");
            await service.estimateReshieldCrosschainAmount(estimateParams());
            expect(vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock.calls).toHaveLength(1);
            const feeQuotes = vi.mocked(relayerInteractor.getSwapQuote).mock.calls;
            expect(feeQuotes.every(([, body]) => (body as { swapValue?: string }).swapValue === undefined)).toBe(true);
        });

        it("keep the plain-quote sizing when the route guarantees at least as much", async () => {
            armProbe();
            const baseline = await service.estimateReshieldCrosschainAmount(estimateParams());
            armProbe("1500000");
            const estimate = await service.estimateReshieldCrosschainAmount(estimateParams());

            expect(estimate.noteValue).toBe(baseline.noteValue);
            expect(estimate.totalDepositCost).toBe(baseline.totalDepositCost);
        });

        it("throw DestinationChainNotSupported when toChainId does not match the configured destination", async () => {
            await expect(
                service.estimateReshieldCrosschainAmount({
                    ...estimateParams(),
                    toChainId: 1,
                }),
            ).rejects.toThrow(DestinationChainNotSupported);
        });

        it("throw DestinationCallsUnsupported before quoting when the destination chain reports destinationCallsSupported=false", async () => {
            vi.mocked(relayerInteractor.getChainDetails).mockResolvedValue({
                destinationCallsSupported: false,
            } as never);

            await expect(service.estimateReshieldCrosschainAmount(estimateParams())).rejects.toThrow(
                DestinationCallsUnsupported,
            );
            expect(swapQuoteProvider.getSwapQuote).not.toHaveBeenCalled();
            expect(relayerInteractor.getChainDetails).toHaveBeenCalledWith(
                expect.objectContaining({ chainId: DESTINATION_CHAIN_ID, chainType: DESTINATION_CHAIN_TYPE }),
            );
        });

        it("proceed when the destination chain reports destinationCallsSupported=true", async () => {
            vi.mocked(relayerInteractor.getChainDetails).mockResolvedValue({
                destinationCallsSupported: true,
            } as never);

            await expect(service.estimateReshieldCrosschainAmount(estimateParams())).resolves.toBeDefined();
        });

        it("proceed when the destination chain's details cannot be read", async () => {
            vi.mocked(relayerInteractor.getChainDetails).mockRejectedValue(new Error("400 unknown chain"));

            await expect(service.estimateReshieldCrosschainAmount(estimateParams())).resolves.toBeDefined();
        });

        it("read output asset config from the destination Entrypoint, not the source", async () => {
            await service.estimateReshieldCrosschainAmount(estimateParams());

            expect(destinationEntrypointInteractor.getAssetConfig).toHaveBeenCalledWith(
                VALID_OUTPUT_TOKEN,
            );
            expect(entrypointInteractor.getAssetConfig).toHaveBeenCalledWith(VALID_TOKEN);
        });

        it("send the zero-address sentinel as recipient", async () => {
            await service.estimateReshieldCrosschainAmount(estimateParams());

            const quoteCall = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[0][1];
            expect(quoteCall.recipient).toBe(EMPTY_ADDRESS);
            expect(quoteCall.minOutputAmount).toBe("0");
            expect(quoteCall.fallbackAddress).toBe(VALID_FALLBACK);
        });

        it("default dustRecipient to the relayer address", async () => {
            await service.estimateReshieldCrosschainAmount(estimateParams());

            const quoteCall = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[0][1];
            expect(quoteCall.dustRecipient).toBe(VALID_RELAY);
        });

        it("reject an explicit zero fallbackAddress before quoting (bridged funds would burn on a failed destination deposit)", async () => {
            await expect(
                service.estimateReshieldCrosschainAmount({
                    ...estimateParams(),
                    fallbackAddress: EMPTY_ADDRESS as Address,
                }),
            ).rejects.toThrow(/empty-address sentinel/);
            expect(relayerInteractor.getSwapQuote).not.toHaveBeenCalled();
        });

        it("throw AssetNotSupported when the destination output token is disabled", async () => {
            destinationEntrypointInteractor = createMockEntrypointInteractor(
                DESTINATION_ENTRYPOINT,
                { enabled: false },
            );
            buildService();

            await expect(
                service.estimateReshieldCrosschainAmount(estimateParams()),
            ).rejects.toThrow(AssetNotSupported);
        });

        it("throw RelayFeeExceedsMax when the fee exceeds a nonzero maxRelayFee", async () => {
            entrypointInteractor = createMockEntrypointInteractor(SOURCE_ENTRYPOINT, {
                maxRelayFee: "0x1" as Hex,
            });
            buildService();

            await expect(
                service.estimateReshieldCrosschainAmount(estimateParams()),
            ).rejects.toThrow(RelayFeeExceedsMax);
        });

        /** A quote provider returning exactly the numbers from a captured incident. */
        function fixedQuoteProvider(quote: Record<string, unknown>): ISwapQuoteProvider {
            return {
                getSwapQuote: vi.fn(async () => ({
                    approvalAddress: VALID_PROCESSOR,
                    transactionData: SWAP_CALLDATA,
                    transactionTo: VALID_PROCESSOR,
                    estimatedDuration: 30,
                    fromTokenAddress: VALID_TOKEN,
                    toTokenAddress: VALID_OUTPUT_TOKEN,
                    fromChainId: POOL_CHAIN_ID,
                    toChainId: DESTINATION_CHAIN_ID,
                    toChainType: DESTINATION_CHAIN_TYPE,
                    ...quote,
                })),
            } as unknown as ISwapQuoteProvider;
        }

        function serviceWithQuote(
            swapQuoteProvider: ISwapQuoteProvider,
        ): PoolSessionReshieldCrosschain<PreparedTransaction> {
            return new PoolSessionReshieldCrosschain({
                chainId: POOL_CHAIN_ID,
                destinationChainId: DESTINATION_CHAIN_ID,
                destinationChainType: DESTINATION_CHAIN_TYPE,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                entrypointInteractor,
                destinationEntrypointInteractor,
                swapQuoteProvider,
                swapAndDepositQuoteProvider: createMockSwapAndDepositQuoteProvider(),
            });
        }

        it("size a cross-asset note from the OUTPUT amount, never from the input's base units", async () => {
            // The captured incident (Optimism -> Ethereum, 2026-08-30): 20 USDC in,
            // 23_270 relayer fee, a 0.00788 ETH minimum output, 100 bps vetting fee.
            // The old unconditional min() reinterpreted the 19_976_730 USDC net as wei
            // and produced a 19_383_361 wei note — 2e-11 ETH, displayed as "0 ETH" —
            // which then reverted the relay.
            destinationEntrypointInteractor = createMockEntrypointInteractor(
                DESTINATION_ENTRYPOINT,
                { vettingFeeBPS: "0x64" as Hex }, // 100 bps
            );
            const minOutputWei = 7_880_000_000_000_000n; // 0.00788 ETH
            const service2 = serviceWithQuote(
                fixedQuoteProvider({
                    fromAmount: "19976730",
                    // Deliberately distinct from toAmountMin: the ceiling must be applied
                    // to the minimum, and never scaled by the expected/minimum gap.
                    toAmount: "7919000000000000",
                    toAmountMin: `${minOutputWei}`,
                    fromTokenSymbol: "USDC",
                    toTokenSymbol: "ETH",
                    fromTokenDecimals: 6,
                    toTokenDecimals: 18,
                }),
            );

            const estimate = await service2.estimateReshieldCrosschainAmount({
                relayerInfo: RELAYER_INFO,
                amount: `0x${20_000_000n.toString(16)}` as Hex,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                toChainId: DESTINATION_CHAIN_ID,
                toChainType: DESTINATION_CHAIN_TYPE,
                fallbackAddress: VALID_FALLBACK,
            });

            // Computed independently of the implementation: 98% buffer, then 100 bps
            // vetting divided out of the deposit total.
            expect(BigInt(estimate.noteValue)).toBe(7_645_940_594_059_405n);
            expect(BigInt(estimate.vettingFee)).toBe(76_459_405_940_594n);
            expect(BigInt(estimate.totalDepositCost)).toBe(7_722_399_999_999_999n);
            // Nowhere near the old, unit-mixed 19_383_361 wei.
            expect(BigInt(estimate.noteValue)).toBeGreaterThan(10n ** 15n);
        });

        it("still bound an incentivised SAME-ASSET bridge to the net input", async () => {
            // USDC on one chain to USDC on another: different addresses, same asset.
            // An LP incentive quoting more out than in must not size the deposit.
            const service2 = serviceWithQuote(
                fixedQuoteProvider({
                    fromAmount: "999990",
                    toAmount: "1040000",
                    toAmountMin: "1030000",
                    fromTokenSymbol: "USDC",
                    toTokenSymbol: "USDC",
                    fromTokenDecimals: 6,
                    toTokenDecimals: 6,
                }),
            );

            const estimate = await service2.estimateReshieldCrosschainAmount(estimateParams());

            // Capped at the net input 999_990, then the 98% buffer and 20 bps vetting.
            const capped = 999_990n;
            const expectedNote = (((capped * 98n) / 100n) * 10_000n) / 10_020n;
            expect(BigInt(estimate.noteValue)).toBe(expectedNote);
            expect(BigInt(estimate.noteValue)).toBeLessThan(capped);
        });

        it("apply no ceiling when the provider proves nothing about the assets", async () => {
            // Unproven must not be read as same-asset: a ceiling would be a guess.
            const service2 = serviceWithQuote(
                fixedQuoteProvider({
                    fromAmount: "999990",
                    toAmount: "1040000",
                    toAmountMin: "1030000",
                }),
            );

            const estimate = await service2.estimateReshieldCrosschainAmount(estimateParams());

            const expectedNote = (((1_030_000n * 98n) / 100n) * 10_000n) / 10_020n;
            expect(BigInt(estimate.noteValue)).toBe(expectedNote);
        });

        it("throw DepositBelowMinimum when the computed note value is below the destination minAmount", async () => {
            destinationEntrypointInteractor = createMockEntrypointInteractor(
                DESTINATION_ENTRYPOINT,
                { minAmount: `0x${(10n ** 18n).toString(16)}` as Hex },
            );
            buildService();

            await expect(
                service.estimateReshieldCrosschainAmount(estimateParams()),
            ).rejects.toThrow(DepositBelowMinimum);
        });

        it("reserves an extra ~3% of principal in noteValue for a Mainnet destination (B2)", async () => {
            const nonMainnet = await service.estimateReshieldCrosschainAmount(estimateParams());

            const mainnetSvc = new PoolSessionReshieldCrosschain({
                chainId: POOL_CHAIN_ID,
                destinationChainId: 1,
                destinationChainType: DESTINATION_CHAIN_TYPE,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                entrypointInteractor,
                destinationEntrypointInteractor,
                swapQuoteProvider,
                swapAndDepositQuoteProvider,
            });
            const mainnet = await mainnetSvc.estimateReshieldCrosschainAmount({
                ...estimateParams(),
                toChainId: 1,
            });

            expect(BigInt(mainnet.noteValue)).toBeLessThan(BigInt(nonMainnet.noteValue));
            const pctOfNonMainnet =
                (BigInt(mainnet.noteValue) * 10_000n) / BigInt(nonMainnet.noteValue);
            expect(pctOfNonMainnet).toBeGreaterThanOrEqual(9_690n);
            expect(pctOfNonMainnet).toBeLessThanOrEqual(9_701n);
        });
    });

    describe("prepareReshieldCrosschainQuote", () => {
        function quoteParams(
            overrides?: Partial<PrepareReshieldCrosschainQuoteParams>,
        ): PrepareReshieldCrosschainQuoteParams {
            return {
                relayerInfo: RELAYER_INFO,
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                toChainId: DESTINATION_CHAIN_ID,
                toChainType: DESTINATION_CHAIN_TYPE,
                fallbackAddress: VALID_FALLBACK,
                depositResult: buildDepositResult(),
                totalDepositCost: TOTAL_DEPOSIT_COST,
                ...overrides,
            };
        }

        // --- Route-guarantee gate on every route (2026-09-24) ---
        // LiFi encodes the route's guaranteed delivery as the destination call's budget on
        // Across too, not only on Stargate; a deposit costing more fails on arrival and the
        // bridged tokens go to the fallback address.

        function armAcrossQuote(destinationCallAmount: string): void {
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: {
                    fromToken: Address;
                    toToken: Address;
                    fromChainId: number;
                    toChainId: number;
                }) => ({
                    fromAmount: "999990",
                    toAmount: "0",
                    destinationCallAmount,
                    approvalAddress: VALID_PROCESSOR,
                    transactionData: LIFI_TRANSACTION_DATA,
                    transactionTo: VALID_SWAP_TARGET,
                    transactionValue: "0x0" as Hex,
                    estimatedDuration: 30,
                    fromTokenAddress: req.fromToken,
                    toTokenAddress: req.toToken,
                    fromChainId: req.fromChainId,
                    toChainId: req.toChainId,
                }),
            );
        }

        it("reject a quote whose target or approval spender is the swap executor", async () => {
            for (const field of ["transactionTo", "approvalAddress"] as const) {
                armAcrossQuote(TOTAL_DEPOSIT_COST);
                const base = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).getMockImplementation()!;
                vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(async (req) => ({
                    ...(await base(req)),
                    [field]: LIFI_EXECUTOR,
                }));
                await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                    UnexpectedTransactionTarget,
                );
            }
        });

        it("throw DestinationDepositUnaffordable when an Across route's guaranteed delivery is below the deposit cost", async () => {
            const guaranteed = 900_000n; // < TOTAL_DEPOSIT_COST (1_002_000)
            armAcrossQuote(guaranteed.toString());

            const err = (await service
                .prepareReshieldCrosschainQuote(quoteParams())
                .then(() => undefined)
                .catch((e: unknown) => e)) as DestinationDepositUnaffordable | undefined;

            expect(err).toBeInstanceOf(DestinationDepositUnaffordable);
            expect(BigInt(err!.affordableNoteValue)).toBe(
                (((guaranteed * 9_900n) / 10_000n) * 10_000n) / (10_000n + VETTING_BPS),
            );
            // The figures are carried as fields, so a caller can rebuild without parsing the message.
            expect(err!.destBudget).toBe(guaranteed.toString());
            expect(BigInt(err!.totalDepositCost)).toBeGreaterThan(guaranteed);
            expect(
                vi
                    .mocked(relayerInteractor.getSwapQuote)
                    .mock.calls.some(([, r]) => (r as SwapQuoteParams).commit),
            ).toBe(false);
        });

        it("pass the route-guarantee gate when the guaranteed delivery covers the deposit cost", async () => {
            armAcrossQuote("1002000");
            await expect(
                service.prepareReshieldCrosschainQuote(quoteParams()),
            ).resolves.toBeDefined();
        });

        it("give the destination Entrypoint deposit the flat 2M budget (prod OOG at 800k, 2026-10)", async () => {
            armAcrossQuote("1002000");
            await service.prepareReshieldCrosschainQuote(quoteParams());
            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock.calls[0][0];
            expect(req.poolAddress).toBe(buildDepositResult().depositTx.to);
            expect(req.depositGasLimit).toBe("2000000");
        });

        it("refuse a plain native-coin destination deposit before any network call", async () => {
            // Entrypoint.deposit{value} needs msg.value == noteValue + fee exactly; LiFi
            // sends its own guaranteed delivery instead, so the call can never land.
            await expect(
                service.prepareReshieldCrosschainQuote(
                    quoteParams({
                        outputToken: NATIVE_ASSET_ADDRESS,
                        depositResult: buildDepositResult({ tokenId: NATIVE_ASSET_ADDRESS }),
                    }),
                ),
            ).rejects.toThrow(NativeDestinationDepositUnsupported);
            expect(relayerInteractor.getSwapQuote).not.toHaveBeenCalled();
            expect(swapAndDepositQuoteProvider.getSwapAndDepositQuote).not.toHaveBeenCalled();
        });

        it("throw DestinationChainNotSupported when toChainId does not match the configured destination", async () => {
            await expect(
                service.prepareReshieldCrosschainQuote({ ...quoteParams(), toChainId: 1 }),
            ).rejects.toThrow(DestinationChainNotSupported);
        });

        it("throw DestinationCallsUnsupported from seeded destination details without fetching them", async () => {
            buildService([
                {
                    id: DESTINATION_CHAIN_ID,
                    type: DESTINATION_CHAIN_TYPE,
                    destinationCallsSupported: false,
                } as unknown as RelayerChainDetails,
            ]);

            await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                DestinationCallsUnsupported,
            );
            expect(relayerInteractor.getChainDetails).not.toHaveBeenCalled();
            expect(swapAndDepositQuoteProvider.getSwapAndDepositQuote).not.toHaveBeenCalled();
        });

        it("ignore seeded details for another chain and read the destination's own", async () => {
            buildService([
                { id: POOL_CHAIN_ID, type: DESTINATION_CHAIN_TYPE, destinationCallsSupported: false } as unknown as RelayerChainDetails,
            ]);

            await expect(service.prepareReshieldCrosschainQuote(quoteParams())).resolves.toBeDefined();
        });

        it("throw RelaySwapsLayoutMismatch when the source-chain RelaySwaps reports a different ROUTING_TYPEHASH", async () => {
            const STALE_TYPEHASH = `0x${"aa".repeat(32)}` as Hex;
            const rpcInteractor = createMockRPCInteractor();
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName }: ReadContractParams) =>
                    functionName === "ROUTING_TYPEHASH" ? STALE_TYPEHASH : true,
            );
            const service2 = new PoolSessionReshieldCrosschain({
                chainId: POOL_CHAIN_ID,
                destinationChainId: DESTINATION_CHAIN_ID,
                destinationChainType: DESTINATION_CHAIN_TYPE,
                core,
                relayerInteractor,
                rpcInteractor,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
                entrypointInteractor,
                destinationEntrypointInteractor,
                swapQuoteProvider,
                swapAndDepositQuoteProvider,
            });

            await expect(service2.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                RelaySwapsLayoutMismatch,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("route an ERC20 reshield needing native msg.value into the B2 gas-swap path instead of refusing it", async () => {
            // Pre-B2 this route was refused outright ("needs native msg.value ... does not
            // forward"). B2 funds the fee via the in-contract gas swap, so the flow must
            // now ATTEMPT the sizing: with these default mocks the gas-swap quote resolves
            // to a different router than the main leg, so the deterministic outcome of
            // entering the B2 path is the router-mismatch rejection — NOT the old
            // unfundable-route refusal.
            const service2 = new PoolSessionReshieldCrosschain({
                chainId: POOL_CHAIN_ID,
                destinationChainId: DESTINATION_CHAIN_ID,
                destinationChainType: DESTINATION_CHAIN_TYPE,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                entrypointInteractor,
                destinationEntrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: {
                    getSwapAndDepositQuote: vi.fn(
                        async (req: {
                            fromToken: Address;
                            toToken: Address;
                            fromChainId: number;
                            toChainId: number;
                        }) => ({
                            fromAmount: "999990",
                            toAmount: TOTAL_DEPOSIT_COST,
                            approvalAddress: VALID_PROCESSOR,
                            transactionData: LIFI_TRANSACTION_DATA,
                            transactionTo: VALID_SWAP_TARGET,
                            transactionValue: `0x${501_687_183_964_393n.toString(16)}` as Hex,
                            estimatedDuration: 30,
                            tool: "stargateV2",
                            fromTokenAddress: req.fromToken,
                            toTokenAddress: req.toToken,
                            fromChainId: req.fromChainId,
                            toChainId: req.toChainId,
                        }),
                    ),
                } as unknown as ISwapAndDepositQuoteProvider,
            });

            await expect(service2.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                /differs from the main swap router/,
            );
        });

        it("allow a route that needs no native msg.value", async () => {
            await expect(
                service.prepareReshieldCrosschainQuote(quoteParams()),
            ).resolves.toBeDefined();
        });

        it("allow a NATIVE-input route whose msg.value is exactly the swap amount", async () => {
            // A native-ETH-input reshield's transactionValue is the swap amount itself —
            // RelaySwaps' native branch already forwards exactly that
            // (`swapTarget.call{value: _swapAmount}`, packages/swaps/contracts/src/RelaySwaps.sol).
            // netSwapAmount here is 999_990 (1_000_000 amount − 10 fee), matching the mocked
            // relayer quote. This must NOT be refused — it has nothing to do with an
            // unfundable bridge fee.
            const service2 = new PoolSessionReshieldCrosschain({
                chainId: POOL_CHAIN_ID,
                destinationChainId: DESTINATION_CHAIN_ID,
                destinationChainType: DESTINATION_CHAIN_TYPE,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                entrypointInteractor,
                destinationEntrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: {
                    getSwapAndDepositQuote: vi.fn(
                        async (req: {
                            fromToken: Address;
                            toToken: Address;
                            fromChainId: number;
                            toChainId: number;
                        }) => ({
                            fromAmount: "999990",
                            toAmount: TOTAL_DEPOSIT_COST,
                            approvalAddress: VALID_PROCESSOR,
                            transactionData: LIFI_TRANSACTION_DATA,
                            transactionTo: VALID_SWAP_TARGET,
                            transactionValue: `0x${999_990n.toString(16)}` as Hex,
                            estimatedDuration: 30,
                            fromTokenAddress: req.fromToken,
                            toTokenAddress: req.toToken,
                            fromChainId: req.fromChainId,
                            toChainId: req.toChainId,
                        }),
                    ),
                } as unknown as ISwapAndDepositQuoteProvider,
            });

            await expect(
                service2.prepareReshieldCrosschainQuote(
                    quoteParams({ tokenId: NATIVE_ASSET_ADDRESS }),
                ),
            ).resolves.toBeDefined();
        });

        it("refuse a NATIVE-input route whose msg.value exceeds the swap amount", async () => {
            // Same shape as the OP -> Mainnet incident, but on the native branch: an extra
            // fee stacked ON TOP of the swap amount (999_990) is still unfundable — the
            // native branch only ever forwards the swap amount itself, never more.
            const service2 = new PoolSessionReshieldCrosschain({
                chainId: POOL_CHAIN_ID,
                destinationChainId: DESTINATION_CHAIN_ID,
                destinationChainType: DESTINATION_CHAIN_TYPE,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                entrypointInteractor,
                destinationEntrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: {
                    getSwapAndDepositQuote: vi.fn(
                        async (req: {
                            fromToken: Address;
                            toToken: Address;
                            fromChainId: number;
                            toChainId: number;
                        }) => ({
                            fromAmount: "999990",
                            toAmount: TOTAL_DEPOSIT_COST,
                            approvalAddress: VALID_PROCESSOR,
                            transactionData: LIFI_TRANSACTION_DATA,
                            transactionTo: VALID_SWAP_TARGET,
                            transactionValue: `0x${1_000_500n.toString(16)}` as Hex,
                            estimatedDuration: 30,
                            tool: "stargateV2",
                            fromTokenAddress: req.fromToken,
                            toTokenAddress: req.toToken,
                            fromChainId: req.fromChainId,
                            toChainId: req.toChainId,
                        }),
                    ),
                } as unknown as ISwapAndDepositQuoteProvider,
            });

            await expect(
                service2.prepareReshieldCrosschainQuote(
                    quoteParams({ tokenId: NATIVE_ASSET_ADDRESS }),
                ),
            ).rejects.toThrow(
                /1000500 wei of native msg\.value.*can only forward up to 999990 wei/s,
            );
        });

        describe("native input with a bridge fee on top (StargateV2, prod 2026-10-09)", () => {
            // Real routes quote transactionValue = fromAmount + native bridge fee. The mock
            // mirrors that: it bridges whatever netFromAmount it is asked for (or the full
            // net budget on the first call) and stacks `fee` on top.
            const NET = 999_990n;
            const buildService = (getSwapAndDepositQuote: unknown) =>
                new PoolSessionReshieldCrosschain({
                    chainId: POOL_CHAIN_ID,
                    destinationChainId: DESTINATION_CHAIN_ID,
                    destinationChainType: DESTINATION_CHAIN_TYPE,
                    core,
                    relayerInteractor,
                    rpcInteractor: createMockRPCInteractor(),
                    addressEqualityComparator: new EvmAddressEqualityComparator(),
                    emptyAddress: EMPTY_ADDRESS,
                    nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                    swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                    entrypointInteractor,
                    destinationEntrypointInteractor,
                    swapQuoteProvider: createMockSwapQuoteProvider(),
                    swapAndDepositQuoteProvider: {
                        getSwapAndDepositQuote,
                    } as unknown as ISwapAndDepositQuoteProvider,
                });
            const makeService = (fee: bigint, requoteFee: bigint = fee) => {
                // The first quote carries `fee`; every re-quote after it carries `requoteFee`.
                let calls = 0;
                const getSwapAndDepositQuote = vi.fn(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                        netFromAmount?: string;
                    }) => {
                        const from = BigInt(req.netFromAmount ?? NET.toString());
                        return {
                            fromAmount: from.toString(),
                            toAmount: TOTAL_DEPOSIT_COST,
                            approvalAddress: VALID_PROCESSOR,
                            transactionData: LIFI_TRANSACTION_DATA,
                            transactionTo: VALID_SWAP_TARGET,
                            transactionValue: `0x${(from + (calls++ === 0 ? fee : requoteFee)).toString(16)}` as Hex,
                            estimatedDuration: 30,
                            tool: "stargateV2",
                            fromTokenAddress: req.fromToken,
                            toTokenAddress: req.toToken,
                            fromChainId: req.fromChainId,
                            toChainId: req.toChainId,
                        };
                    },
                );
                return { svc: buildService(getSwapAndDepositQuote), getSwapAndDepositQuote };
            };

            it("re-quote with fromAmount reduced so fromAmount + fee fits the forwarded msg.value", async () => {
                const fee = 5_000n;
                const { svc, getSwapAndDepositQuote } = makeService(fee);

                await expect(
                    svc.prepareReshieldCrosschainQuote(quoteParams({ tokenId: NATIVE_ASSET_ADDRESS })),
                ).resolves.toBeDefined();

                expect(getSwapAndDepositQuote).toHaveBeenCalledTimes(2);
                const second = getSwapAndDepositQuote.mock.calls[1]![0] as { netFromAmount?: string };
                // 1.02x fee headroom + 2 bps of the budget.
                const expected = NET - (fee * 10_200n) / 10_000n - (NET * 2n) / 10_000n;
                expect(BigInt(second.netFromAmount!)).toBe(expected);
                expect(expected + fee).toBeLessThanOrEqual(NET);
                // The same proof-bound deposit is embedded in both quotes.
                const first = getSwapAndDepositQuote.mock.calls[0]![0] as unknown as { depositCalldata: Hex };
                expect((second as unknown as { depositCalldata: Hex }).depositCalldata).toBe(first.depositCalldata);
            });

            it("shrink the ask when the quote reports no fee stacked on top of fromAmount", async () => {
                // A fee-less native route (e.g. Across — "Across carries no native fee",
                // lifi-swap-quote-provider.md §Bridge allowlist) can still overshoot
                // netSwapAmount purely from toAmount-mode sizing drift, with
                // transactionValue === fromAmount (no separate fee to read off as
                // transactionValue - fromAmount). Exercises nativeFeeFundedFromAmount's
                // fallback branch (quotedFrom >= quotedValue), treating the whole overage
                // above netSwapAmount as the amount to shave off.
                const overshoot = 10_000n;
                let calls = 0;
                const getSwapAndDepositQuote = vi.fn(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                        netFromAmount?: string;
                    }) => {
                        const from = calls++ === 0 ? NET + overshoot : BigInt(req.netFromAmount!);
                        return {
                            fromAmount: from.toString(),
                            toAmount: TOTAL_DEPOSIT_COST,
                            approvalAddress: VALID_PROCESSOR,
                            transactionData: LIFI_TRANSACTION_DATA,
                            transactionTo: VALID_SWAP_TARGET,
                            transactionValue: `0x${from.toString(16)}` as Hex,
                            estimatedDuration: 30,
                            tool: "across",
                            fromTokenAddress: req.fromToken,
                            toTokenAddress: req.toToken,
                            fromChainId: req.fromChainId,
                            toChainId: req.toChainId,
                        };
                    },
                );
                const svc = buildService(getSwapAndDepositQuote);

                await expect(
                    svc.prepareReshieldCrosschainQuote(quoteParams({ tokenId: NATIVE_ASSET_ADDRESS })),
                ).resolves.toBeDefined();

                expect(getSwapAndDepositQuote).toHaveBeenCalledTimes(2);
                const second = getSwapAndDepositQuote.mock.calls[1]![0] as { netFromAmount?: string };
                expect(BigInt(second.netFromAmount!)).toBeLessThan(NET);
            });

            it("still refuse when the fee is at least the amount", async () => {
                const { svc, getSwapAndDepositQuote } = makeService(NET);

                await expect(
                    svc.prepareReshieldCrosschainQuote(quoteParams({ tokenId: NATIVE_ASSET_ADDRESS })),
                ).rejects.toThrow(/native msg\.value.*can only forward up to 999990 wei/s);
                expect(getSwapAndDepositQuote).toHaveBeenCalledTimes(1);
                expect(
                    vi
                        .mocked(relayerInteractor.getSwapQuote)
                        .mock.calls.some(([, r]) => (r as SwapQuoteParams).commit),
                ).toBe(false);
            });

            it("leave an ERC20 route on the B2 path, never the native re-quote", async () => {
                // ERC20 input with a native fee goes to B2 sizing (here: the default mocks'
                // router mismatch), not the native fromAmount reduction.
                const { svc, getSwapAndDepositQuote } = makeService(5_000n);

                await expect(svc.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                    /differs from the main swap router/,
                );
                expect(getSwapAndDepositQuote).toHaveBeenCalledTimes(1);
            });

            it("accept the prod fee ratio (fee ~18% of the budget) without tripping the dust cap", async () => {
                // Prod 2026-10-09: 34020741867341822 wanted vs 28883500000000000 forwarded, a fee
                // of ~17.8% of the budget. The fee is consumed by the route, not dust.
                const fee = (NET * 1_780n) / 10_000n;
                const { svc, getSwapAndDepositQuote } = makeService(fee);

                await expect(
                    svc.prepareReshieldCrosschainQuote(quoteParams({ tokenId: NATIVE_ASSET_ADDRESS })),
                ).resolves.toBeDefined();
                expect(getSwapAndDepositQuote).toHaveBeenCalledTimes(2);
            });

            it("refuse in prepare and estimate when the re-quoted fee grows past the headroom", async () => {
                const { svc } = makeService(5_000n, 50_000n);
                const { svc: estimateSvc } = makeService(5_000n, 50_000n);

                await expect(
                    svc.prepareReshieldCrosschainQuote(quoteParams({ tokenId: NATIVE_ASSET_ADDRESS })),
                ).rejects.toThrow(/native msg\.value.*can only forward up to 999990 wei/s);
                await expect(
                    estimateSvc.estimateReshieldCrosschainAmount({
                        relayerInfo: RELAYER_INFO,
                        amount: AMOUNT,
                        tokenId: NATIVE_ASSET_ADDRESS,
                        outputToken: VALID_OUTPUT_TOKEN,
                        toChainId: DESTINATION_CHAIN_ID,
                        toChainType: DESTINATION_CHAIN_TYPE,
                        fallbackAddress: VALID_FALLBACK,
                    }),
                ).rejects.toThrow(/native msg\.value.*can only forward up to 999990 wei/s);
            });

            it("refuse in estimate, as prepare does, when the re-quoted fee drops and leaves dust over the cap", async () => {
                // 5% fee on the first quote, zero on the re-quote: ~5.1% left unused.
                const { svc } = makeService((NET * 500n) / 10_000n, 0n);
                const { svc: prepSvc } = makeService((NET * 500n) / 10_000n, 0n);

                await expect(
                    svc.estimateReshieldCrosschainAmount({
                        relayerInfo: RELAYER_INFO,
                        amount: AMOUNT,
                        tokenId: NATIVE_ASSET_ADDRESS,
                        outputToken: VALID_OUTPUT_TOKEN,
                        toChainId: DESTINATION_CHAIN_ID,
                        toChainType: DESTINATION_CHAIN_TYPE,
                        fallbackAddress: VALID_FALLBACK,
                    }),
                ).rejects.toThrow(/bps tolerance/);
                await expect(
                    prepSvc.prepareReshieldCrosschainQuote(quoteParams({ tokenId: NATIVE_ASSET_ADDRESS })),
                ).rejects.toThrow(/bps tolerance/);
            });

            it("size the estimate off the reduced native route", async () => {
                const fee = 5_000n;
                const { svc, getSwapAndDepositQuote } = makeService(fee);

                const estimate = await svc.estimateReshieldCrosschainAmount(
                    {
                        relayerInfo: RELAYER_INFO,
                        amount: AMOUNT,
                        tokenId: NATIVE_ASSET_ADDRESS,
                        outputToken: VALID_OUTPUT_TOKEN,
                        toChainId: DESTINATION_CHAIN_ID,
                        toChainType: DESTINATION_CHAIN_TYPE,
                        fallbackAddress: VALID_FALLBACK,
                    },
                );
                const overrides = getSwapAndDepositQuote.mock.calls
                    .map(([r]) => (r as { netFromAmount?: string }).netFromAmount)
                    .filter((v): v is string => v !== undefined);
                expect(overrides.length).toBeGreaterThan(0);
                const reduced = BigInt(overrides[overrides.length - 1]!);
                expect(reduced + fee).toBeLessThanOrEqual(NET);
                expect(BigInt(estimate.netSwapAmount)).toBe(reduced);
            });
        });

        it("reject an explicit zero fallbackAddress before quoting (bridged funds would burn on a failed destination deposit)", async () => {
            await expect(
                service.prepareReshieldCrosschainQuote(
                    quoteParams({ fallbackAddress: EMPTY_ADDRESS as Address }),
                ),
            ).rejects.toThrow(/empty-address sentinel/);
            expect(relayerInteractor.getSwapQuote).not.toHaveBeenCalled();
        });

        it("throw DestinationDepositTargetMismatch when depositResult.to is not the destination Entrypoint", async () => {
            await expect(
                service.prepareReshieldCrosschainQuote(
                    quoteParams({ depositResult: buildDepositResult({ to: SOURCE_ENTRYPOINT }) }),
                ),
            ).rejects.toThrow(DestinationDepositTargetMismatch);
        });

        // #221: a relayer that inflates amountSent beyond the caller's requested gross
        // withdrawal must be rejected here — this is the only check anchored to a value
        // the relayer doesn't control. assertAmountSentMatchesAmountPlusFee in
        // relayReshieldCrosschain re-derives its "gross" from netAmount (= amountSent −
        // fee), which is itself read off this same amountSent, so it cannot catch this
        // on its own.
        it("reject a committed amountSent inflated beyond the caller's requested gross withdrawal", async () => {
            const honest = vi.mocked(relayerInteractor.getSwapQuote).getMockImplementation()!;
            vi.mocked(relayerInteractor.getSwapQuote).mockImplementation(
                async (relayer: RelayerInfo, req: SwapQuoteParams) => {
                    const quote = await honest(relayer, req);
                    if (!req.commit || !("feeCommitment" in quote)) return quote;
                    return {
                        ...quote,
                        feeCommitment: {
                            ...quote.feeCommitment,
                            amountSent: (BigInt(req.amount) + 1_000_000n).toString(),
                        },
                    };
                },
            );

            await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                "does not match requested gross withdrawal",
            );
            // Source-chain note units, not the destination chain's token.
            const error = await service
                .prepareReshieldCrosschainQuote(quoteParams())
                .catch((e: unknown) => e);
            expect(hasErrorAmounts(error) && error.amounts?.code).toBe(
                "commitmentAmountSentMismatch",
            );
            expect(hasErrorAmounts(error) && error.amounts?.side).toBe("spent");
        });

        // B2: the SDK does not yet size a Mainnet-destination gas swap, so it must reject
        // a committed routing that carries one — a relayer cannot inject a gas swap the
        // user never asked for.
        it("reject a committed reshield routing that carries a nonzero B2 swapValue", async () => {
            const honest = vi.mocked(relayerInteractor.getSwapQuote).getMockImplementation()!;
            vi.mocked(relayerInteractor.getSwapQuote).mockImplementation(
                async (relayer: RelayerInfo, req: SwapQuoteParams) => {
                    const quote = await honest(relayer, req);
                    if (!req.commit || !("feeCommitment" in quote)) return quote;
                    const [routing] = decodeAbiParameters(
                        RELAY_SWAP_ROUTING_ABI,
                        quote.feeCommitment.data,
                    );
                    const tampered = encodeAbiParameters(RELAY_SWAP_ROUTING_ABI, [
                        { ...(routing as Record<string, unknown>), swapValue: 1n } as never,
                    ]);
                    return {
                        ...quote,
                        feeCommitment: { ...quote.feeCommitment, data: tampered },
                    };
                },
            );

            await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                /routing swapValue 1 does not match expected 0/,
            );
        });

        // B2 — self-funded LayerZero fee for a Mainnet-destination reshield.
        describe("B2 self-funded bridge value", () => {
            const GAS_SWAP_CALLDATA = "0xba5eba11" as Hex;

            function armB2(lzFeeWei: bigint, gasSwapInput: string): void {
                // Main contractCalls leg: carries a nonzero transactionValue (the LZ fee);
                // fromAmount echoes the netFromAmount budget so assertLifiBudget passes.
                vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                        netFromAmount?: string;
                    }) => ({
                        fromAmount: req.netFromAmount ?? "999990",
                        toAmount: TOTAL_DEPOSIT_COST,
                        approvalAddress: VALID_SWAP_TARGET,
                        transactionData: LIFI_TRANSACTION_DATA,
                        transactionTo: VALID_SWAP_TARGET,
                        transactionValue: `0x${lzFeeWei.toString(16)}` as Hex,
                        estimatedDuration: 30,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    }),
                );
                // Same-chain gas swap: input token -> native ETH, on the SAME router.
                vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementation(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                    }) => ({
                        fromAmount: gasSwapInput,
                        toAmount: "0",
                        toAmountMin: "0",
                        approvalAddress: VALID_SWAP_TARGET,
                        transactionData: GAS_SWAP_CALLDATA,
                        transactionTo: VALID_SWAP_TARGET,
                        estimatedDuration: 15,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    }),
                );
            }

            it("sizes swapValue at 1.2x the LZ fee, carves the gas-swap input out of the budget, and threads all three fields into the committed routing", async () => {
                armB2(10_000n, "5000");

                const prepared = await service.prepareReshieldCrosschainQuote(quoteParams());

                expect(prepared.swapValue).toBe(12_000n); // 1.2x headroom
                expect(prepared.gasSwapMaxInput).toBe(5_050n); // gasSwapInput x 1.01
                expect(prepared.gasSwapCalldata).toBe(GAS_SWAP_CALLDATA);

                // the committed relayer quote was asked for the gas-swap fields
                const committedReq = vi
                    .mocked(relayerInteractor.getSwapQuote)
                    .mock.calls.find(
                        ([, r]) => (r as SwapQuoteParams).commit,
                    )?.[1] as SwapQuoteParams;
                expect(committedReq.swapValue).toBe("12000");
                expect(committedReq.gasSwapMaxInput).toBe("5050");
                expect(committedReq.gasSwapCalldata).toBe(GAS_SWAP_CALLDATA);

                // the main leg was re-quoted against the reduced net (amount - fee - gasSwapInput)
                const reQuote = vi
                    .mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote)
                    .mock.calls.at(-1)![0] as { netFromAmount?: string };
                expect(reQuote.netFromAmount).toBe((1_000_000n - 10n - 5_000n).toString());
            });

            it("re-sizes the gas swap when the re-quoted LZ fee drifts above the sized swapValue", async () => {
                armB2(10_000n, "5000");
                // First quote: fee 10_000 -> swapValue 12_000. Every re-quote wants 20_000.
                const first = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).getMockImplementation()!;
                let calls = 0;
                vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(async (req) => {
                    const q = await first(req);
                    return calls++ === 0 ? q : { ...q, transactionValue: "0x4e20" as Hex };
                });

                const prepared = await service.prepareReshieldCrosschainQuote(quoteParams());

                expect(prepared.swapValue).toBe(24_000n);
            });

            it("refuses before the gas-swap quote when swapValue exceeds the relayer's published max_swap_value_wei", async () => {
                armB2(10_000n, "5000"); // swapValue = 12_000
                vi.mocked(relayerInteractor.getChainDetails).mockResolvedValue({
                    maxSwapValueWei: "11999",
                } as never);

                const err = await service.prepareReshieldCrosschainQuote(quoteParams()).catch((e) => e);

                expect(err).toBeInstanceOf(SwapValueExceedsRelayerCap);
                expect(err).toMatchObject({ swapValue: 12_000n, maxSwapValueWei: 11_999n });
                expect(swapQuoteProvider.getSwapQuote).not.toHaveBeenCalled();
                expect(
                    vi.mocked(relayerInteractor.getSwapQuote).mock.calls.some(([, r]) => (r as SwapQuoteParams).commit),
                ).toBe(false);
            });

            it("proceeds when swapValue is exactly at the published cap", async () => {
                armB2(10_000n, "5000");
                vi.mocked(relayerInteractor.getChainDetails).mockResolvedValue({
                    maxSwapValueWei: "12000",
                } as never);

                const prepared = await service.prepareReshieldCrosschainQuote(quoteParams());

                expect(prepared.swapValue).toBe(12_000n);
            });

            it("leaves the cap to the relayer when /v1/details cannot be read", async () => {
                armB2(10_000n, "5000");
                vi.mocked(relayerInteractor.getChainDetails).mockRejectedValue(new Error("boom"));

                const prepared = await service.prepareReshieldCrosschainQuote(quoteParams());

                expect(prepared.swapValue).toBe(12_000n);
            });

            describe("relayer caps cache", () => {
                const capsDetails = (maxSwapValueWei: string, relayerAddress = VALID_RELAY) =>
                    ({ id: POOL_CHAIN_ID, relayerAddress, maxSwapValueWei }) as unknown as RelayerChainDetails;
                // The destination-calls gate also reads /v1/details, for the DESTINATION chain;
                // only source-chain reads are caps reads.
                const capsFetches = () =>
                    vi
                        .mocked(relayerInteractor.getChainDetails)
                        .mock.calls.filter(([endpoint]) => endpoint.chainId === POOL_CHAIN_ID).length;

                afterEach(() => {
                    vi.useRealTimers();
                });

                it("uses seeded relayerChainDetails without fetching /v1/details", async () => {
                    buildService([capsDetails("11999")]);
                    armB2(10_000n, "5000");

                    await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                        SwapValueExceedsRelayerCap,
                    );
                    expect(capsFetches()).toBe(0);
                });

                it("ignores seeded details for a different relayer and fetches instead", async () => {
                    buildService([capsDetails("11999", VALID_PROCESSOR)]);
                    armB2(10_000n, "5000");

                    const prepared = await service.prepareReshieldCrosschainQuote(quoteParams());

                    expect(prepared.swapValue).toBe(12_000n);
                    expect(capsFetches()).toBe(1);
                });

                it("fetches once across repeated B2 sizings, and again after the TTL", async () => {
                    vi.useFakeTimers({ toFake: ["Date"] });
                    armB2(10_000n, "5000");
                    vi.mocked(relayerInteractor.getChainDetails).mockResolvedValue(capsDetails("12000"));

                    await service.prepareReshieldCrosschainQuote(quoteParams());
                    await service.prepareReshieldCrosschainQuote(quoteParams());
                    expect(capsFetches()).toBe(1);

                    // An operator lowered the cap; past the TTL the session sees it.
                    vi.mocked(relayerInteractor.getChainDetails).mockResolvedValue(capsDetails("11999"));
                    vi.advanceTimersByTime(5 * 60_000);
                    await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                        SwapValueExceedsRelayerCap,
                    );
                    expect(capsFetches()).toBe(2);
                });

                it("keys a fetched entry by the RelayerInfo it was fetched for, even if relayerAddress differs", async () => {
                    armB2(10_000n, "5000");
                    vi.mocked(relayerInteractor.getChainDetails).mockResolvedValue(
                        capsDetails("12000", VALID_PROCESSOR),
                    );

                    await service.prepareReshieldCrosschainQuote(quoteParams());
                    await service.prepareReshieldCrosschainQuote(quoteParams());

                    expect(capsFetches()).toBe(1);
                });

                it("does not cache a failed /v1/details read", async () => {
                    armB2(10_000n, "5000");
                    let failed = false;
                    vi.mocked(relayerInteractor.getChainDetails).mockImplementation(async (endpoint) => {
                        if (endpoint.chainId === POOL_CHAIN_ID && !failed) {
                            failed = true;
                            throw new Error("boom");
                        }
                        return capsDetails("11999");
                    });

                    await service.prepareReshieldCrosschainQuote(quoteParams());

                    await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                        SwapValueExceedsRelayerCap,
                    );
                    expect(capsFetches()).toBe(2);
                });
            });

            it("rejects when the gas swap resolves to a different router than the main swap", async () => {
                armB2(10_000n, "5000");
                vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementation(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                    }) => ({
                        fromAmount: "5000",
                        toAmount: "0",
                        toAmountMin: "0",
                        approvalAddress: VALID_PROCESSOR, // != VALID_SWAP_TARGET
                        transactionData: GAS_SWAP_CALLDATA,
                        transactionTo: VALID_PROCESSOR, // != VALID_SWAP_TARGET
                        estimatedDuration: 15,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    }),
                );

                await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                    /gas-swap router .* differs from the main swap router/,
                );
            });

            it("rejects when the re-quoted LZ fee exceeds the sized swapValue", async () => {
                // A one-off drift is re-sized (see above); a fee that keeps spiking past every
                // re-sized swapValue is still refused after B2_RESIZE_ATTEMPTS.
                let call = 0;
                vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                        netFromAmount?: string;
                    }) => ({
                        fromAmount: req.netFromAmount ?? "999990",
                        toAmount: TOTAL_DEPOSIT_COST,
                        approvalAddress: VALID_SWAP_TARGET,
                        transactionData: LIFI_TRANSACTION_DATA,
                        transactionTo: VALID_SWAP_TARGET,
                        // 10_000, then tripling on every re-quote: it outruns each 1.2x re-sizing.
                        transactionValue: `0x${(10_000n * 3n ** BigInt(call++)).toString(16)}` as Hex,
                        estimatedDuration: 30,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    }),
                );
                vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementation(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                    }) => ({
                        fromAmount: "5000",
                        toAmount: "0",
                        toAmountMin: "0",
                        approvalAddress: VALID_SWAP_TARGET,
                        transactionData: GAS_SWAP_CALLDATA,
                        transactionTo: VALID_SWAP_TARGET,
                        estimatedDuration: 15,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    }),
                );

                await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                    /re-quoted LZ fee .* exceeds the sized swapValue/,
                );
            });

            // --- Destination affordability gate ---
            // LiFi caps the destination contract-call's budget at the Stargate route's
            // minAmountLD; a deposit costing more silently ships RAW bridged tokens to
            // the fallback address instead of a shielded note (verified on a mainnet
            // fork, 2026-08-31). prepare must refuse to sign such a quote.

            /** Real Stargate-facet calldata carrying `minAmountLD`, with the deposit-embed
             *  bytes threaded through composeMsg so the containment check still passes. */
            function stargateTransactionData(minAmountLD: bigint): Hex {
                return encodeFunctionData({
                    abi: STARGATE_FACET_TEST_ABI,
                    functionName: "swapAndStartBridgeTokensViaStargate",
                    args: [
                        {
                            transactionId: `0x${"11".repeat(32)}` as Hex,
                            bridge: "stargateV2",
                            integrator: "test",
                            referrer: EMPTY_ADDRESS as Address,
                            sendingAssetId: VALID_TOKEN,
                            receiver: VALID_PROCESSOR,
                            minAmount: 1n,
                            destinationChainId: 1n,
                            hasSourceSwaps: false,
                            hasDestinationCall: true,
                        },
                        [],
                        {
                            assetId: 1,
                            sendParams: {
                                dstEid: 30101,
                                to: `0x${VALID_PROCESSOR.slice(2).toLowerCase().padStart(64, "0")}` as Hex,
                                amountLD: minAmountLD + 1_000n,
                                minAmountLD,
                                extraOptions: "0x" as Hex,
                                composeMsg: LIFI_TRANSACTION_DATA,
                                oftCmd: "0x" as Hex,
                            },
                            fee: { nativeFee: 10_000n, lzTokenFee: 0n },
                            refundAddress: VALID_PROCESSOR,
                        },
                    ],
                });
            }

            function armB2Stargate(minAmountLD: bigint): void {
                armB2(10_000n, "5000");
                vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                        netFromAmount?: string;
                    }) => ({
                        fromAmount: req.netFromAmount ?? "999990",
                        toAmount: TOTAL_DEPOSIT_COST,
                        approvalAddress: VALID_SWAP_TARGET,
                        transactionData: stargateTransactionData(minAmountLD),
                        transactionTo: VALID_SWAP_TARGET,
                        transactionValue: "0x2710" as Hex, // 10_000
                        estimatedDuration: 30,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    }),
                );
            }

            it("throw DestinationDepositUnaffordable when the deposit cost exceeds the route's minAmountLD", async () => {
                const minAmountLD = 900_000n; // < TOTAL_DEPOSIT_COST (1_002_000)
                armB2Stargate(minAmountLD);

                const err = (await service
                    .prepareReshieldCrosschainQuote(quoteParams())
                    .then(() => undefined)
                    .catch((e: unknown) => e)) as DestinationDepositUnaffordable | undefined;

                expect(err).toBeInstanceOf(DestinationDepositUnaffordable);
                // affordable = minAmountLD minus the 1% quote-drift margin, scaled back by
                // the destination vetting fee (20 bps)
                expect(BigInt(err!.affordableNoteValue)).toBe(
                    (((minAmountLD * 9_900n) / 10_000n) * 10_000n) / (10_000n + VETTING_BPS),
                );
                // and no commitment was requested — the gate fires BEFORE signing
                expect(
                    vi
                        .mocked(relayerInteractor.getSwapQuote)
                        .mock.calls.some(([, r]) => (r as SwapQuoteParams).commit),
                ).toBe(false);
            });

            it("accept a Stargate route whose minAmountLD covers the deposit cost", async () => {
                armB2Stargate(2_000_000n); // > TOTAL_DEPOSIT_COST

                const prepared = await service.prepareReshieldCrosschainQuote(quoteParams());

                expect(BigInt(prepared.swapValue ?? "0")).toBeGreaterThan(0n);
            });
        });

        it("throw DustRescueRecipientConflict when an explicit dustRecipient conflicts with a dustRescue opt-in", async () => {
            await expect(
                service.prepareReshieldCrosschainQuote(
                    quoteParams({
                        dustRecipient: VALID_FALLBACK,
                        dustRescue: {
                            recipientIdentifier: {
                                kind: "raw",
                                spendingPubKey: ("0x" + "ab".repeat(65)) as Hex,
                            },
                        },
                    }),
                ),
            ).rejects.toThrow(DustRescueRecipientConflict);
        });

        it("pass through the dustRescue opt-in unchanged into the prepared quote", async () => {
            const dustRescue = {
                recipientIdentifier: {
                    kind: "raw" as const,
                    spendingPubKey: ("0x" + "ab".repeat(65)) as Hex,
                },
            };
            const result = await service.prepareReshieldCrosschainQuote(
                quoteParams({ dustRescue }),
            );

            expect(result.dustRescue).toEqual(dustRescue);
            expect(result.toChainId).toBe(DESTINATION_CHAIN_ID);
            expect(result.fallbackAddress).toBe(VALID_FALLBACK);
        });

        it("resolve dust rescue's implicit dustRecipient to the relayer address without conflict", async () => {
            const dustRescue = {
                recipientIdentifier: {
                    kind: "raw" as const,
                    spendingPubKey: ("0x" + "ab".repeat(65)) as Hex,
                },
            };
            const result = await service.prepareReshieldCrosschainQuote(
                quoteParams({ dustRescue }),
            );
            expect(result.dustRecipient).toBe(VALID_RELAY);
        });
    });

    describe("relayReshieldCrosschain", () => {
        async function preparedQuote(
            dustRescue?: PrepareReshieldCrosschainQuoteParams["dustRescue"],
        ): Promise<PreparedReshieldCrosschainQuote> {
            return service.prepareReshieldCrosschainQuote({
                relayerInfo: RELAYER_INFO,
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                toChainId: DESTINATION_CHAIN_ID,
                toChainType: DESTINATION_CHAIN_TYPE,
                fallbackAddress: VALID_FALLBACK,
                depositResult: buildDepositResult(),
                totalDepositCost: TOTAL_DEPOSIT_COST,
                dustRescue,
            });
        }

        function relayParams(
            prepared: Awaited<ReturnType<typeof preparedQuote>>,
            overrides?: Partial<ReshieldCrosschainParams>,
        ): ReshieldCrosschainParams {
            return {
                inputCommitments: [MOCK_COMMITMENT],
                amount: prepared.netAmount,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                toChainId: DESTINATION_CHAIN_ID,
                toChainType: DESTINATION_CHAIN_TYPE,
                fallbackAddress: VALID_FALLBACK,
                swapCalldata: prepared.swapCalldata,
                selectedQuote: {
                    ...prepared.selectedQuote,
                    quote: {
                        ...prepared.selectedQuote.quote,
                        feeCommitment: {
                            ...prepared.selectedQuote.quote.feeCommitment,
                            // The shared mock relayer defaults expiration to 0 (already
                            // expired); relay tests need a live commitment.
                            expiration: Date.now() + 3_600_000,
                        },
                    },
                },
                dustRecipient: prepared.dustRecipient,
                swapTarget: prepared.swapTarget,
                approvalAddress: prepared.approvalAddress,
                depositNote: prepared.depositNote,
                dustRescue: prepared.dustRescue,
                ...overrides,
            };
        }

        it("throw DestinationChainNotSupported when toChainId does not match the configured destination", async () => {
            const prepared = await preparedQuote();
            await expect(
                service.relayReshieldCrosschain(relayParams(prepared, { toChainId: 1 })),
            ).rejects.toThrow(DestinationChainNotSupported);
        });

        it("reject hand-built routing that targets the swap executor", async () => {
            const prepared = await preparedQuote();
            const [routing] = decodeAbiParameters(
                RELAY_SWAP_ROUTING_ABI,
                prepared.selectedQuote.quote.feeCommitment.data,
            );
            const params = relayParams(prepared, { swapTarget: LIFI_EXECUTOR });
            params.selectedQuote.quote.feeCommitment.data = encodeAbiParameters(RELAY_SWAP_ROUTING_ABI, [
                { ...routing, swapTarget: LIFI_EXECUTOR },
            ]);
            await expect(service.relayReshieldCrosschain(params)).rejects.toThrow(UnexpectedTransactionTarget);
            expect(vi.mocked(relayerInteractor.relaySwap)).not.toHaveBeenCalled();
        });

        // RC-10: dustRescue no longer travels as a separate relaySwap field at all —
        // it rides inside signedSwapCommitment.data, already committed at quote time.
        it("does not attach a dustRescue field to the relaySwap submission", async () => {
            const prepared = await preparedQuote();
            await service.relayReshieldCrosschain(relayParams(prepared));

            const submitCall = vi.mocked(relayerInteractor.relaySwap).mock.calls[0][1];
            expect(submitCall).not.toHaveProperty("dustRescue");
        });

        it("encodes the dustRescue opt-in into the committed routing instead of a separate field", async () => {
            const dustRescue = {
                recipientIdentifier: {
                    kind: "raw" as const,
                    spendingPubKey: ("0x" + "ab".repeat(65)) as Hex,
                },
            };
            const prepared = await preparedQuote(dustRescue);
            await service.relayReshieldCrosschain(relayParams(prepared));

            const submitCall = vi.mocked(relayerInteractor.relaySwap).mock.calls[0][1];
            expect(submitCall).not.toHaveProperty("dustRescue");

            const [routing] = decodeAbiParameters(
                RELAY_SWAP_ROUTING_ABI,
                submitCall.signedSwapCommitment.data,
            );
            expect(routing.dustRescue).toEqual({
                chainId: BigInt(DESTINATION_CHAIN_ID),
                tokenId: getAddress(VALID_OUTPUT_TOKEN),
                isCanonical: false,
                spendingPubKey: dustRescue.recipientIdentifier.spendingPubKey,
                viewingPubKey: "0x",
            });
        });

        // relayReshieldCrosschain accepts hand-built params, so it must re-validate the
        // committed routing's dustRescue against what the caller actually asked for here —
        // even when the quote itself was committed honestly. See
        // assertReshieldCrosschainRouting's dustRescue block.
        describe("relay-time dustRescue revalidation", () => {
            const dustRescue = {
                recipientIdentifier: {
                    kind: "raw" as const,
                    spendingPubKey: ("0x" + "ab".repeat(65)) as Hex,
                },
            };

            it("throw InvalidTransactParams when the relayer attaches a dustRescue the caller never requested", async () => {
                const prepared = await preparedQuote(dustRescue);

                await expect(
                    service.relayReshieldCrosschain(relayParams(prepared, { dustRescue: undefined })),
                ).rejects.toThrow(/Routing dustRescue\.chainId .* does not match expected 0/);
            });

            it("throw InvalidTransactParams when the routing dustRescue tokenId diverges from the caller's requested output token", async () => {
                const prepared = await preparedQuote(dustRescue);
                const OTHER_OUTPUT_TOKEN = "0x00000000000000000000000000000000000000bb" as Address;

                await expect(
                    service.relayReshieldCrosschain(
                        relayParams(prepared, { outputToken: OTHER_OUTPUT_TOKEN }),
                    ),
                ).rejects.toThrow(/Routing dustRescue\.tokenId/);
            });

            it("throw InvalidTransactParams when the routing dustRescue spendingPubKey diverges from the caller's requested recipient", async () => {
                const prepared = await preparedQuote(dustRescue);
                const otherDustRescue = {
                    recipientIdentifier: {
                        kind: "raw" as const,
                        spendingPubKey: ("0x" + "cd".repeat(65)) as Hex,
                    },
                };

                await expect(
                    service.relayReshieldCrosschain(
                        relayParams(prepared, { dustRescue: otherDustRescue }),
                    ),
                ).rejects.toThrow(/Routing dustRescue\.spendingPubKey does not match expected/);
            });

            it("throw InvalidTransactParams when the routing dustRescue isCanonical diverges from the caller's requested recipient kind", async () => {
                const prepared = await preparedQuote(dustRescue);
                const canonicalDustRescue = {
                    recipientIdentifier: {
                        kind: "canonical" as const,
                        spendingPubKey: dustRescue.recipientIdentifier.spendingPubKey,
                        viewingPubKey: ("0x" + "ef".repeat(65)) as Hex,
                    },
                };

                await expect(
                    service.relayReshieldCrosschain(
                        relayParams(prepared, { dustRescue: canonicalDustRescue }),
                    ),
                ).rejects.toThrow(
                    /Routing dustRescue\.isCanonical .* does not match expected recipientIdentifier\.kind/,
                );
            });
        });

        it("persist the deposit note as an owned output on success", async () => {
            const prepared = await preparedQuote();
            const ownedDepositNote = { ...prepared.depositNote, isOwned: true };
            await service.relayReshieldCrosschain(
                relayParams(prepared, { depositNote: ownedDepositNote }),
            );

            expect(core.persistNoteUpdates).toHaveBeenCalledWith([], [ownedDepositNote], "0x1", {
                expectedNullifiers: [MOCK_SPENT_NULLIFIER],
                receiptLogs: [],
            });
        });

        // PoolSessionReshieldTransferCrosschain.relayReshieldTransferCrosschain is a one-line
        // delegation to a real PoolSessionReshieldCrosschain — this exercises that delegate
        // un-mocked, so the dustRescue relay-time revalidation above is proven to actually run
        // for the transfer-crosschain variant too, not just asserted by inspecting the
        // delegation call.
        describe("via PoolSessionReshieldTransferCrosschain (real, un-mocked delegate)", () => {
            function buildTransferSession(): PoolSessionReshieldTransferCrosschain<PreparedTransaction> {
                return new PoolSessionReshieldTransferCrosschain({
                    reshieldCrosschainDelegate: service,
                    destinationYieldDepositTargets: [],
                    addressEqualityComparator: new EvmAddressEqualityComparator(),
                });
            }

            it("relay when the routing dustRescue matches the expected opt-in", async () => {
                const dustRescue = {
                    recipientIdentifier: {
                        kind: "raw" as const,
                        spendingPubKey: ("0x" + "ab".repeat(65)) as Hex,
                    },
                };
                const prepared = await preparedQuote(dustRescue);
                const transferSession = buildTransferSession();

                await expect(
                    transferSession.relayReshieldTransferCrosschain(relayParams(prepared)),
                ).resolves.toBeDefined();
            });

            it("throw InvalidTransactParams when the relayer attaches a dustRescue the caller never requested", async () => {
                const dustRescue = {
                    recipientIdentifier: {
                        kind: "raw" as const,
                        spendingPubKey: ("0x" + "ab".repeat(65)) as Hex,
                    },
                };
                const prepared = await preparedQuote(dustRescue);
                const transferSession = buildTransferSession();

                await expect(
                    transferSession.relayReshieldTransferCrosschain(
                        relayParams(prepared, { dustRescue: undefined }),
                    ),
                ).rejects.toThrow(/Routing dustRescue\.chainId .* does not match expected 0/);
            });

            it("reject a self-owned depositResult at prepareReshieldTransferCrosschainQuote before ever reaching the delegate's relay-time checks", async () => {
                const transferSession = buildTransferSession();
                const selfOwnedDepositResult = buildDepositResult();
                (selfOwnedDepositResult.pendingNote as { isOwned?: boolean }).isOwned = true;

                await expect(
                    transferSession.prepareReshieldTransferCrosschainQuote({
                        relayerInfo: RELAYER_INFO,
                        amount: AMOUNT,
                        tokenId: VALID_TOKEN,
                        outputToken: VALID_OUTPUT_TOKEN,
                        toChainId: DESTINATION_CHAIN_ID,
                        toChainType: DESTINATION_CHAIN_TYPE,
                        fallbackAddress: VALID_FALLBACK,
                        depositResult: selfOwnedDepositResult,
                        totalDepositCost: TOTAL_DEPOSIT_COST,
                    }),
                ).rejects.toBeInstanceOf(InvalidTransactParams);
                expect(relayerInteractor.getSwapQuote).not.toHaveBeenCalled();
            });
        });
    });

    describe("yield share input (RelaySwaps unwrap)", () => {
        const SHARE_UNDERLYING = "0x00000000000000000000000000000000000005dc" as Address;
        const ZAP = "0x0000000000000000000000000000000000000a99" as Address;
        /** 1 share redeems to 2 underlying units — keeps the two amounts distinguishable. */
        const RATE = 2n;
        let rpcInteractor: IRPCInteractor;
        let yieldToken: IPPYieldTokenInteractor;

        function mockZapAllowlist(approved: boolean): void {
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async (req: { functionName?: string }) => {
                    if (req.functionName === "approvedZaps") return approved;
                    if (req.functionName === "ROUTING_TYPEHASH") return RELAY_SWAP_ROUTING_TYPEHASH;
                    return true;
                },
            );
        }

        function buildYieldService(zap?: Address): void {
            service = new PoolSessionReshieldCrosschain({
                chainId: POOL_CHAIN_ID,
                destinationChainId: DESTINATION_CHAIN_ID,
                destinationChainType: DESTINATION_CHAIN_TYPE,
                core,
                relayerInteractor,
                rpcInteractor,
                entrypointInteractor,
                destinationEntrypointInteractor,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
                swapQuoteProvider,
                swapAndDepositQuoteProvider,
                yieldWrappers: [
                    {
                        shareToken: VALID_TOKEN,
                        underlying: SHARE_UNDERLYING,
                        zap,
                        previewRedeem: (shares: bigint) => yieldToken.previewRedeem(shares),
                    },
                ],
            });
        }

        beforeEach(() => {
            rpcInteractor = createMockRPCInteractor();
            yieldToken = {
                getAddress: vi.fn(() => VALID_TOKEN),
                previewRedeem: vi.fn(async (shares: bigint) => shares * RATE),
            } as unknown as IPPYieldTokenInteractor;
            mockZapAllowlist(true);
            buildYieldService(ZAP);
            // Echo the requested underlying budget so assertLifiBudget sees ~zero dust;
            // in toAmount mode fall back to a value within the dust tolerance of the net.
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: {
                    fromToken: Address;
                    toToken: Address;
                    fromChainId: number;
                    toChainId: number;
                    netFromAmount?: string;
                }) => ({
                    fromAmount: req.netFromAmount ?? "1999900",
                    toAmount: TOTAL_DEPOSIT_COST,
                    approvalAddress: VALID_PROCESSOR,
                    transactionData: LIFI_TRANSACTION_DATA,
                    transactionTo: VALID_SWAP_TARGET,
                    transactionValue: "0x0" as Hex,
                    estimatedDuration: 30,
                    fromTokenAddress: req.fromToken,
                    toTokenAddress: req.toToken,
                    fromChainId: req.fromChainId,
                    toChainId: req.toChainId,
                }),
            );
        });

        function estimateParams(): EstimateReshieldCrosschainParams {
            return {
                relayerInfo: RELAYER_INFO,
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                toChainId: DESTINATION_CHAIN_ID,
                toChainType: DESTINATION_CHAIN_TYPE,
                fallbackAddress: VALID_FALLBACK,
            };
        }

        function quoteParams(
            overrides?: Partial<PrepareReshieldCrosschainQuoteParams>,
        ): PrepareReshieldCrosschainQuoteParams {
            return {
                relayerInfo: RELAYER_INFO,
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                toChainId: DESTINATION_CHAIN_ID,
                toChainType: DESTINATION_CHAIN_TYPE,
                fallbackAddress: VALID_FALLBACK,
                depositResult: buildDepositResult(),
                totalDepositCost: TOTAL_DEPOSIT_COST,
                ...overrides,
            };
        }

        it("estimate: quote the DEX leg on the underlying for previewRedeem(net shares)", async () => {
            const estimate = await service.estimateReshieldCrosschainAmount(estimateParams());

            const dexReq = vi.mocked(swapQuoteProvider.getSwapQuote).mock.calls[0][0];
            expect(dexReq.fromToken).toBe(SHARE_UNDERLYING);
            // 1_000_000 gross − 10 fee = 999_990 shares → 1_999_980 underlying.
            expect(dexReq.amount).toBe("1999980");
            expect(yieldToken.previewRedeem).toHaveBeenCalledWith(999_990n);
            expect(estimate.swapInputToken).toBe(SHARE_UNDERLYING);
            expect(rpcInteractor.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "approvedZaps", args: [ZAP] }),
            );
        });

        it("prepare: LiFi contractCalls on the underlying, relayer fee on the share, netAmount in shares", async () => {
            const result = await service.prepareReshieldCrosschainQuote(quoteParams());

            const lifiReq = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(lifiReq.fromToken).toBe(SHARE_UNDERLYING);
            // Cross-asset (underlying ≠ outputToken) → netFromAmount mode, in underlying units.
            expect(lifiReq.netFromAmount).toBe("1999980");

            // Every relayer quote names the SHARE and the gross share amount.
            for (const call of vi.mocked(relayerInteractor.getSwapQuote).mock.calls) {
                expect(call[1].asset).toBe(VALID_TOKEN);
                expect(call[1].amount).toBe(BigInt(AMOUNT).toString());
            }

            expect(result.swapInputToken).toBe(SHARE_UNDERLYING);
            // netAmount forwarded to the relay leg stays in SHARES (gross − fee).
            expect(BigInt(result.netAmount)).toBe(BigInt(AMOUNT) - BigInt(FEE_AMOUNT));
            expect(result.feeAmount).toBe(FEE_AMOUNT);
        });

        it("prepare: reject before any commitment when the zap is not allowlisted", async () => {
            mockZapAllowlist(false);
            await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                /is not allowlisted on processor/,
            );
            expect(swapAndDepositQuoteProvider.getSwapAndDepositQuote).not.toHaveBeenCalled();
            // Only the preliminary (non-committing) relayer quote ran.
            const relayerCalls = vi.mocked(relayerInteractor.getSwapQuote).mock.calls;
            expect(relayerCalls).toHaveLength(1);
            expect(relayerCalls[0][1].commit).toBe(false);
        });

        it("prepare: reject when the deployment names no zap", async () => {
            buildYieldService(undefined);
            await expect(service.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(
                /has no zap configured/,
            );
        });

        it("prepare: a ppUSDC → underlying reshield is same-asset (toAmount mode, no netFromAmount)", async () => {
            await service.prepareReshieldCrosschainQuote(
                quoteParams({
                    outputToken: SHARE_UNDERLYING,
                    depositResult: buildDepositResult({ tokenId: SHARE_UNDERLYING }),
                }),
            );
            const lifiReq = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(lifiReq.fromToken).toBe(SHARE_UNDERLYING);
            expect(lifiReq.netFromAmount).toBeUndefined();
        });

        it("prepare: a non-yield token stays on the plain path even with wrappers configured", async () => {
            const OTHER_TOKEN = "0x00000000000000000000000000000000000000ab" as Address;
            const result = await service.prepareReshieldCrosschainQuote(
                quoteParams({ tokenId: OTHER_TOKEN }),
            );
            const lifiReq = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(lifiReq.fromToken).toBe(OTHER_TOKEN);
            expect(result.swapInputToken).toBe(OTHER_TOKEN);
            expect(yieldToken.previewRedeem).not.toHaveBeenCalled();
            expect(rpcInteractor.readContract).not.toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "approvedZaps" }),
            );
        });
    });
});

// A yield SHARE as the destination output (2026-09-18): the DEX leg buys the
// destination underlying, and the relayer routing names the NATIVE sentinel as
// outputToken, because RelaySwaps reads outputToken.balanceOf on the SOURCE
// chain even with a zero recipient and a destination-only token would revert.
describe("PoolSessionReshieldCrosschain with a yield share as the destination output", () => {
    const SHARE = "0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6" as Address;
    const ROUTER = "0xe76E793d776c1e207aD7a7fa7C57d27420d85110" as Address;
    const UNDERLYING = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
    const SHARES = 990_000n;

    it("estimate: quotes the DEX leg on the underlying and routes the native sentinel to the relayer", async () => {
        const relayerInteractor = createMockRelayerInteractor();
        const swapQuoteProvider = createMockSwapQuoteProvider();
        const swapAndDepositQuoteProvider = createMockSwapAndDepositQuoteProvider();
        const service = new PoolSessionReshieldCrosschain({
            chainId: POOL_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            destinationChainType: DESTINATION_CHAIN_TYPE,
            core: createMockCore(),
            relayerInteractor,
            rpcInteractor: createMockRPCInteractor(),
            addressEqualityComparator: new EvmAddressEqualityComparator(),
            emptyAddress: EMPTY_ADDRESS,
            nativeAssetAddress: NATIVE_ASSET_ADDRESS,
            swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
            entrypointInteractor: createMockEntrypointInteractor(SOURCE_ENTRYPOINT),
            destinationEntrypointInteractor: createMockEntrypointInteractor(DESTINATION_ENTRYPOINT),
            swapQuoteProvider,
            swapAndDepositQuoteProvider: swapAndDepositQuoteProvider,
            destinationYieldDepositTargets: [
                toYieldSwapDepositTarget({
                    chainId: DESTINATION_CHAIN_ID,
                    deployment: {
                        ppRouter: ROUTER,
                        zap: VALID_SWAP_TARGET,
                        ppUSDC: SHARE,
                        ppUSDCDecimals: 18,
                        underlying: UNDERLYING,
                        underlyingDecimals: 6,
                        underlyingSymbol: "USDC",
                    },
                    deposit: {
                        sizeSharesForBudget: vi.fn(async (budget: bigint) => ({
                            shares: SHARES,
                            underlyingNeeded: budget - 10n,
                            maxUnderlyingIn: budget,
                            headroom: 1n,
                        })),
                        prepareYieldDeposit: vi.fn(),
                    },
                } as unknown as YieldDepositTarget),
            ],
        });
        const estimate = await service.estimateReshieldCrosschainAmount({
            relayerInfo: RELAYER_INFO,
            amount: AMOUNT,
            tokenId: VALID_TOKEN,
            outputToken: SHARE,
            toChainId: DESTINATION_CHAIN_ID,
            toChainType: DESTINATION_CHAIN_TYPE,
            fallbackAddress: VALID_FALLBACK,
        });
        const relayerQuote = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[0][1];
        expect(relayerQuote.outputToken.toLowerCase()).toBe(NATIVE_ASSET_ADDRESS.toLowerCase());
        const dexQuote = vi.mocked(swapQuoteProvider.getSwapQuote).mock.calls[0][0];
        expect(dexQuote.toToken.toLowerCase()).toBe(UNDERLYING.toLowerCase());
        expect(BigInt(estimate.noteValue)).toBe(SHARES);
        // The probe targets the yield router: same flat 2M budget.
        const probe = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock.calls[0][0];
        expect(probe.poolAddress.toLowerCase()).toBe(ROUTER.toLowerCase());
        expect(probe.depositGasLimit).toBe("2000000");
    });
});

describe("PoolSessionReshieldCrosschain refuses a destination yield target from another chain", () => {
    it("throws InvalidPoolSessionConfig when a destination target is bound to the SOURCE chain", () => {
        expect(
            () =>
                new PoolSessionReshieldCrosschain({
                    chainId: POOL_CHAIN_ID,
                    destinationChainId: DESTINATION_CHAIN_ID,
                    destinationChainType: DESTINATION_CHAIN_TYPE,
                    core: createMockCore(),
                    relayerInteractor: createMockRelayerInteractor(),
                    rpcInteractor: createMockRPCInteractor(),
                    addressEqualityComparator: new EvmAddressEqualityComparator(),
                    emptyAddress: EMPTY_ADDRESS,
                    nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                    swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                    entrypointInteractor: createMockEntrypointInteractor(SOURCE_ENTRYPOINT),
                    destinationEntrypointInteractor:
                        createMockEntrypointInteractor(DESTINATION_ENTRYPOINT),
                    swapQuoteProvider: createMockSwapQuoteProvider(),
                    swapAndDepositQuoteProvider: createMockSwapAndDepositQuoteProvider(),
                    destinationYieldDepositTargets: [
                        {
                            chainId: POOL_CHAIN_ID,
                            shareToken: VALID_OUTPUT_TOKEN,
                            router: VALID_SWAP_TARGET,
                        } as unknown as YieldSwapDepositTarget<PreparedTransaction, Address>,
                    ],
                }),
        ).toThrow(InvalidPoolSessionConfig);
    });
});
