import { decodeFunctionData, encodeAbiParameters, encodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    AssetConfig,
    EstimateReshieldParams,
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
    PreparedTransaction,
    PrepareReshieldQuoteParams,
    ReadContractParams,
    RelayerInfo,
    ReshieldParams,
    StealthRecipientIdentifier,
    SwapQuoteParams,
    YieldDepositTarget,
    YieldSwapDepositTarget,
} from "../../../src/internal.js";
import {
    AssetNotSupported,
    SwapRouteUnavailable,
    DepositBelowMinimum,
    DepositTargetMismatch,
    DustRescueRecipientConflict,
    EMPTY_ADDRESS,
    EvmAddressEqualityComparator,
    EvmSwapChainAdapter,
    hasErrorAmounts,
    InvalidPoolSessionConfig,
    InvalidTransactParams,
    NativeSwapDepositUnavailable,
    LiFiDepositCalldataNotFound,
    LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
    NATIVE_ASSET_ADDRESS,
    LiFiDepositTargetNotFound,
    PoolSessionReshield,
    PoolSessionReshieldTransfer,
    PP_ROUTER_DEPOSIT_ABI,
    RELAY_SWAP_ROUTING_ABI,
    RELAY_SWAP_ROUTING_TYPEHASH,
    RelayFeeExceedsMax,
    RelaySwapsLayoutMismatch,
    SwapQuoteMismatch,
    toYieldSwapDepositTarget,
    TransactOrchestrator,
    UnallowedLiFiAddress,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";

const DUST_RESCUE_IDENTIFIER: StealthRecipientIdentifier = {
    kind: "raw",
    spendingPubKey: "0x0101010101010101010101010101010101010101010101010101010101010101" as Hex,
};

// --- Constants ---

const POOL_CHAIN_ID = 11155111;
const VALID_ENTRYPOINT = "0x9999999999999999999999999999999999999991" as Address;
const VALID_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const VALID_OUTPUT_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
const VALID_RELAY = "0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd" as Address;
const VALID_PROCESSOR = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
const VALID_RELAY_SWAPS = "0x5555555555555555555555555555555555555555" as Address;
const VALID_SWAP_TARGET = "0x1111111111111111111111111111111111111111" as Address;
const AMOUNT = "0xf4240" as Hex; // 1_000_000
const FEE_AMOUNT = "10";
const SWAP_CALLDATA = "0xdeadbeef" as Hex;
// Embeds the ABI-padded VALID_ENTRYPOINT address and the deposit calldata body so that
// the byte containment check passes in happy-path tests for prepareReshieldQuote.
const LIFI_TRANSACTION_DATA = ("0x" +
    "0000000000000000000000009999999999999999999999999999999999999991" + // VALID_ENTRYPOINT ABI-padded to 32 bytes
    "abcdef") as Hex; // deposit calldata body (0xabcdef → strip 0x prefix)
const MOCK_COMMITMENT =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as Hash;

// vettingFeeBPS 20 → noteValue 1_000_000 needs totalDepositCost 1_002_000
const NOTE_VALUE = 1_000_000n;
const VETTING_BPS = 20n;
const TOTAL_DEPOSIT_COST = (NOTE_VALUE + (NOTE_VALUE * VETTING_BPS) / 10000n).toString();

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
    maxRelayFee: "0x0" as Hex, // no cap by default
};

// --- Mock factories ---

function createMockEntrypointInteractor(
    assetConfig: Partial<AssetConfig> = {},
): IEntrypointInteractor {
    return {
        getAddress: vi.fn(() => VALID_ENTRYPOINT),
        getAssetConfig: vi.fn(async () => ({ ...DEFAULT_ASSET_CONFIG, ...assetConfig })),
    } as unknown as IEntrypointInteractor;
}

function createMockRelayerInteractor(): IRelayerInteractor {
    const interactor = {
        getRelayers: vi.fn(async () => []),
        getTransferQuote: vi.fn(),
        getWithdrawalQuote: vi.fn(),
        getBatchWithdrawalQuote: vi.fn(),
        getSwapQuote: vi.fn(),
        relayTransfer: vi.fn(),
        relayWithdrawal: vi.fn(),
        relayBatchWithdrawal: vi.fn(),
        relaySwap: vi.fn(async () => "0x1" as Hex),
    };
    // Honest relayer: signs a routing tuple mirroring the quote request.
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
                        // Reshield quotes are zero-recipient: extraGas is never set,
                        // so the honest relayer always signs a zero top-up.
                        nativeGas: 0n,
                        swapValue: 0n,
                        gasSwapMaxInput: 0n,
                        gasSwapCalldata: "0x",
                        swapCalldata: (req.swapCalldata ?? SWAP_CALLDATA) as Hex,
                        // Honest relayer: echoes the requested dustRescue opt-in (or the
                        // all-zero sentinel when none was requested).
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
                // Model the real relayer: amountSent echoes the GROSS request amount,
                // NOT amount + fee. The net (gross − fee) surfaces as netAmount.
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
                toAmountMin: "1020305", // → noteValue ≈ 1_008_083 after buffer/bps math
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
        warmMerkleCaches: vi.fn(async () => undefined),
        prepareTransact: vi.fn(async () => ({
            changePendingNotes: [],
            recipientPendingNotes: [],
            callData: "0xabcdef" as Hex,
            to: VALID_ENTRYPOINT,
            spentNotes: [],
            spentNullifiers: [MOCK_SPENT_NULLIFIER],
            notesData: [],
            proof: {},
        })),
        persistNoteUpdates: vi.fn(),
    } as unknown as TransactOrchestrator;
}

/** Nullifier of the note spent by the mocked prepare result (AW-L-02 / #1070 wiring). */
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
    data?: Hex;
}): PrepareDepositResult {
    return {
        depositTx: {
            data: overrides?.data ?? ("0xabcdef" as Hex),
            to: overrides?.to ?? VALID_ENTRYPOINT,
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

describe("PoolSessionReshield", () => {
    let relayerInteractor: IRelayerInteractor;
    let entrypointInteractor: IEntrypointInteractor;
    let core: TransactOrchestrator;
    let service: PoolSessionReshield<PreparedTransaction>;

    function buildService(): void {
        service = new PoolSessionReshield({
            chainId: POOL_CHAIN_ID,
            core,
            relayerInteractor,
            rpcInteractor: createMockRPCInteractor(),
            addressEqualityComparator: new EvmAddressEqualityComparator(),
            emptyAddress: EMPTY_ADDRESS,
            swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
            relaySwapsAddress: VALID_RELAY_SWAPS,
            entrypointInteractor,
            swapQuoteProvider: createMockSwapQuoteProvider(),
            swapAndDepositQuoteProvider: createMockSwapAndDepositQuoteProvider(),
        });
    }

    beforeEach(() => {
        relayerInteractor = createMockRelayerInteractor();
        entrypointInteractor = createMockEntrypointInteractor();
        core = createMockCore();
        buildService();
    });

    describe("estimateReshieldAmount", () => {
        function estimateParams(): EstimateReshieldParams {
            return {
                relayerInfo: RELAYER_INFO,
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
            };
        }

        it("send the zero-address sentinel as recipient", async () => {
            await service.estimateReshieldAmount(estimateParams());

            const quoteCall = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[0][1];
            expect(quoteCall.recipient).toBe(EMPTY_ADDRESS);
            expect(quoteCall.minOutputAmount).toBe("0");
        });

        it("default dustRecipient to the relayer address", async () => {
            await service.estimateReshieldAmount(estimateParams());

            const quoteCall = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[0][1];
            expect(quoteCall.dustRecipient).toBe(VALID_RELAY);
        });

        it("use the on-chain vettingFeeBPS in the note value math", async () => {
            const estimate = await service.estimateReshieldAmount(estimateParams());

            // safeMinOutput = toAmountMin * 99 / 100; noteValue = safe * 10000 / (10000 + 20)
            const safe = (1020305n * 99n) / 100n;
            const expectedNote = (safe * 10000n) / (10000n + VETTING_BPS);
            expect(BigInt(estimate.noteValue)).toBe(expectedNote);
            expect(BigInt(estimate.vettingFee)).toBe((expectedNote * VETTING_BPS) / 10000n);
        });

        it("throw AssetNotSupported when the output token is disabled", async () => {
            entrypointInteractor = createMockEntrypointInteractor({ enabled: false });
            buildService();

            await expect(service.estimateReshieldAmount(estimateParams())).rejects.toThrow(
                AssetNotSupported,
            );
        });

        it("throw RelayFeeExceedsMax when the fee exceeds a nonzero maxRelayFee", async () => {
            entrypointInteractor = createMockEntrypointInteractor({ maxRelayFee: "0x1" as Hex });
            buildService();

            await expect(service.estimateReshieldAmount(estimateParams())).rejects.toThrow(
                RelayFeeExceedsMax,
            );
        });

        it("throw InvalidTransactParams when the fee consumes the whole amount", async () => {
            vi.mocked(relayerInteractor.getSwapQuote).mockResolvedValue({
                txCost: "0",
                gasPrice: "0",
                feeAmount: BigInt(AMOUNT).toString(),
            } as never);

            await expect(service.estimateReshieldAmount(estimateParams())).rejects.toThrow(
                "consumes the entire withdrawal amount",
            );
            // Denominated in the note being reshielded, not in the output token.
            const error = await service
                .estimateReshieldAmount(estimateParams())
                .catch((e: unknown) => e);
            expect(hasErrorAmounts(error) && error.amounts).toEqual({
                code: "relayFeeConsumesWithdrawal",
                side: "spent",
                values: { fee: BigInt(AMOUNT), amount: BigInt(AMOUNT) },
            });
        });

        it("throw DepositBelowMinimum when the computed note value is below minAmount", async () => {
            entrypointInteractor = createMockEntrypointInteractor({
                minAmount: `0x${(10n ** 18n).toString(16)}` as Hex,
            });
            buildService();

            await expect(service.estimateReshieldAmount(estimateParams())).rejects.toThrow(
                DepositBelowMinimum,
            );
        });

        it("throw SwapQuoteMismatch when the LiFi quote routes a different toToken", async () => {
            const provider = createMockSwapQuoteProvider();
            vi.mocked(provider.getSwapQuote).mockResolvedValue({
                fromAmount: "999990",
                toAmount: "1030000",
                toAmountMin: "1020305",
                approvalAddress: VALID_PROCESSOR,
                transactionData: SWAP_CALLDATA,
                transactionTo: VALID_PROCESSOR,
                estimatedDuration: 30,
                fromTokenAddress: VALID_TOKEN,
                toTokenAddress: "0x9999999999999999999999999999999999999999" as Address,
                fromChainId: POOL_CHAIN_ID,
                toChainId: POOL_CHAIN_ID,
            } as never);
            service = new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor,
                swapQuoteProvider: provider,
                swapAndDepositQuoteProvider: createMockSwapAndDepositQuoteProvider(),
            });

            await expect(service.estimateReshieldAmount(estimateParams())).rejects.toThrow(
                SwapQuoteMismatch,
            );
        });

        it("accept LiFi echoing the zero address for a native output token", async () => {
            // VALID_OUTPUT_TOKEN is the 0xEeee… native sentinel. LiFi accepts it on
            // the request but echoes native as 0x0000…, and a literal compare here
            // rejected every route with native on a leg (receive-as ETH, ETH pool
            // exits) before any calldata was bound.
            const provider = createMockSwapQuoteProvider();
            vi.mocked(provider.getSwapQuote).mockResolvedValue({
                fromAmount: "999990",
                toAmount: "1030000",
                toAmountMin: "1020305",
                approvalAddress: VALID_PROCESSOR,
                transactionData: SWAP_CALLDATA,
                transactionTo: VALID_PROCESSOR,
                estimatedDuration: 30,
                fromTokenAddress: VALID_TOKEN,
                toTokenAddress: EMPTY_ADDRESS,
                fromChainId: POOL_CHAIN_ID,
                toChainId: POOL_CHAIN_ID,
            } as never);
            service = new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor,
                swapQuoteProvider: provider,
                swapAndDepositQuoteProvider: createMockSwapAndDepositQuoteProvider(),
            });

            const outcome = await service.estimateReshieldAmount(estimateParams()).then(
                () => null,
                (error: unknown) => error,
            );
            expect(outcome).not.toBeInstanceOf(SwapQuoteMismatch);
        });
    });

    describe("prepareReshieldQuote", () => {
        function prepareParams(overrides?: {
            depositResult?: PrepareDepositResult;
            totalDepositCost?: string;
            dustRecipient?: Address;
            dustRescue?: PrepareReshieldQuoteParams["dustRescue"];
        }): PrepareReshieldQuoteParams {
            return {
                relayerInfo: RELAYER_INFO,
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                depositResult: overrides?.depositResult ?? buildDepositResult(),
                totalDepositCost: overrides?.totalDepositCost ?? TOTAL_DEPOSIT_COST,
                dustRecipient: overrides?.dustRecipient,
                dustRescue: overrides?.dustRescue,
            };
        }

        it("send the zero-address sentinel in every quote request and echo routing fields", async () => {
            const prepared = await service.prepareReshieldQuote(prepareParams());

            const calls = vi.mocked(relayerInteractor.getSwapQuote).mock.calls;
            expect(calls.length).toBe(2); // budget-check prelim + committed
            for (const call of calls) {
                expect(call[1].recipient).toBe(EMPTY_ADDRESS);
                expect(call[1].minOutputAmount).toBe("0");
            }
            expect(prepared.swapTarget.toLowerCase()).toBe(VALID_SWAP_TARGET.toLowerCase());
            expect(prepared.approvalAddress.toLowerCase()).toBe(VALID_PROCESSOR.toLowerCase());
        });

        it("echo the effective dustRecipient (relayer default) in the result", async () => {
            const prepared = await service.prepareReshieldQuote(prepareParams());
            expect(prepared.dustRecipient).toBe(VALID_RELAY);
        });

        describe("dustRescue", () => {
            it("attaches dustRescue to the committed quote request and echoes it on the result", async () => {
                const dustRescue = { recipientIdentifier: DUST_RESCUE_IDENTIFIER };
                const prepared = await service.prepareReshieldQuote(prepareParams({ dustRescue }));

                const calls = vi.mocked(relayerInteractor.getSwapQuote).mock.calls;
                const committedCall = calls.find((c) => c[1].commit)!;
                expect(committedCall[1].dustRescue).toEqual({
                    destinationChainId: POOL_CHAIN_ID,
                    destinationChainType: "evm",
                    tokenId: VALID_OUTPUT_TOKEN,
                    recipientIdentifier: DUST_RESCUE_IDENTIFIER,
                });
                const prelimCall = calls.find((c) => !c[1].commit)!;
                expect(prelimCall[1].dustRescue).toBeUndefined();
                expect(prepared.dustRescue).toEqual(dustRescue);
            });

            it("omits dustRescue from the result when not requested", async () => {
                const prepared = await service.prepareReshieldQuote(prepareParams());
                expect(prepared.dustRescue).toBeUndefined();
            });

            it("throws DustRescueRecipientConflict when dustRecipient conflicts with the opt-in", async () => {
                await expect(
                    service.prepareReshieldQuote(
                        prepareParams({
                            dustRescue: { recipientIdentifier: DUST_RESCUE_IDENTIFIER },
                            dustRecipient: VALID_OUTPUT_TOKEN, // anything != the relayer address
                        }),
                    ),
                ).rejects.toBeInstanceOf(DustRescueRecipientConflict);
            });
        });

        it("surface netAmount as the gross amountSent minus the fee", async () => {
            const prepared = await service.prepareReshieldQuote(prepareParams());
            const amountSent = BigInt(prepared.selectedQuote.quote.feeCommitment.amountSent);
            // Real relayer echoes the gross request (AMOUNT) as amountSent — not amount + fee.
            expect(amountSent).toBe(BigInt(AMOUNT));
            // netAmount is the value the caller forwards as relayReshield's `amount`.
            expect(BigInt(prepared.netAmount)).toBe(amountSent - BigInt(prepared.feeAmount));
        });

        // M-1: reshield is fixed-output, so the leftover (net − LiFi input) is swept to the
        // relayer-default dustRecipient. Surface it, and bound it so a fee-under-quoting relayer
        // cannot shift unbounded value into it.
        it("surface the input dust as netAmount minus the LiFi input", async () => {
            const prepared = await service.prepareReshieldQuote(prepareParams());
            // The default LiFi mock consumes fromAmount 999990.
            expect(BigInt(prepared.dustAmount)).toBe(BigInt(prepared.netAmount) - 999990n);
        });

        it("reject an over-provisioned amount whose dust exceeds the tolerance", async () => {
            // LiFi needs far less than the net withdrawal, so the leftover would be swept to the
            // relayer's dustRecipient; the bound must reject it before the ~30-60s proof.
            const greedyProvider = {
                getSwapAndDepositQuote: vi.fn(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                    }) => ({
                        fromAmount: "1",
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
            const greedyService = new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: greedyProvider,
            });

            await expect(greedyService.prepareReshieldQuote(prepareParams())).rejects.toThrow(
                /tolerance/,
            );
        });

        it("echo an explicit dustRecipient in the result for prepare→relay passthrough", async () => {
            const explicitDust = "0x7777777777777777777777777777777777777777" as Address;
            const prepared = await service.prepareReshieldQuote({
                ...prepareParams(),
                dustRecipient: explicitDust,
            });
            expect(prepared.dustRecipient).toBe(explicitDust);
        });

        it("throw DepositTargetMismatch when depositResult.to is not the entrypoint", async () => {
            const params = prepareParams({
                depositResult: buildDepositResult({
                    to: "0x9999999999999999999999999999999999999999" as Address,
                }),
            });

            await expect(service.prepareReshieldQuote(params)).rejects.toThrow(
                DepositTargetMismatch,
            );
            // Fails before any network call
            expect(vi.mocked(relayerInteractor.getSwapQuote)).not.toHaveBeenCalled();
        });

        it("throw AssetNotSupported when the output token is disabled", async () => {
            entrypointInteractor = createMockEntrypointInteractor({ enabled: false });
            buildService();

            await expect(service.prepareReshieldQuote(prepareParams())).rejects.toThrow(
                AssetNotSupported,
            );
        });

        it("reject a depositResult whose pendingNote tokenId differs from outputToken", async () => {
            const params = prepareParams({
                depositResult: buildDepositResult({ tokenId: VALID_TOKEN }),
            });

            await expect(service.prepareReshieldQuote(params)).rejects.toThrow(
                "does not match outputToken",
            );
        });

        it("throw DepositBelowMinimum when the note value is below minAmount", async () => {
            entrypointInteractor = createMockEntrypointInteractor({
                minAmount: `0x${(10n ** 18n).toString(16)}` as Hex,
            });
            buildService();

            await expect(service.prepareReshieldQuote(prepareParams())).rejects.toThrow(
                DepositBelowMinimum,
            );
        });

        it("reject a totalDepositCost inconsistent with the on-chain vetting fee", async () => {
            const params = prepareParams({ totalDepositCost: (NOTE_VALUE + 1n).toString() });

            await expect(service.prepareReshieldQuote(params)).rejects.toThrow(
                "does not match noteValue + on-chain vetting fee",
            );
        });

        it("reject a committed routing whose dustRecipient was tampered by the relayer", async () => {
            const honest = vi.mocked(relayerInteractor.getSwapQuote).getMockImplementation()!;
            vi.mocked(relayerInteractor.getSwapQuote).mockImplementation(
                async (relayer: RelayerInfo, req: SwapQuoteParams) =>
                    honest(relayer, {
                        ...req,
                        dustRecipient: "0x9999999999999999999999999999999999999999" as Address,
                    }),
            );

            await expect(service.prepareReshieldQuote(prepareParams())).rejects.toThrow(
                "dustRecipient",
            );
        });

        // #221: a relayer that inflates amountSent beyond the caller's requested gross
        // withdrawal must be rejected here — this is the only check anchored to a value
        // the relayer doesn't control. assertAmountSentMatchesAmountPlusFee in relayReshield
        // re-derives its "gross" from netAmount (= amountSent − fee), which is itself
        // read off this same amountSent, so it cannot catch this on its own.
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

            await expect(service.prepareReshieldQuote(prepareParams())).rejects.toThrow(
                "does not match requested gross withdrawal",
            );
            const error = await service
                .prepareReshieldQuote(prepareParams())
                .catch((e: unknown) => e);
            expect(hasErrorAmounts(error) && error.amounts?.code).toBe(
                "commitmentAmountSentMismatch",
            );
            expect(hasErrorAmounts(error) && error.amounts?.side).toBe("spent");
        });

        it("throw RelaySwapsLayoutMismatch when the target RelaySwaps reports a different ROUTING_TYPEHASH", async () => {
            const rpcInteractor = createMockRPCInteractor();
            const STALE_TYPEHASH = `0x${"aa".repeat(32)}` as Hex;
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName }: ReadContractParams) =>
                    functionName === "ROUTING_TYPEHASH" ? STALE_TYPEHASH : true,
            );
            service = new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: createMockSwapAndDepositQuoteProvider(),
            });

            await expect(service.prepareReshieldQuote(prepareParams())).rejects.toThrow(
                RelaySwapsLayoutMismatch,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("throw UnallowedLiFiAddress when the quote transactionTo is not in RelaySwaps.approvedRouters", async () => {
            const rpcInteractor = createMockRPCInteractor();
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName }: ReadContractParams) =>
                    functionName === "ROUTING_TYPEHASH" ? RELAY_SWAP_ROUTING_TYPEHASH : false,
            );
            service = new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: rpcInteractor }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: createMockSwapAndDepositQuoteProvider(),
            });

            await expect(service.prepareReshieldQuote(prepareParams())).rejects.toThrow(
                UnallowedLiFiAddress,
            );
        });

        it("throw UnallowedLiFiAddress when the quote approvalAddress is not in RelaySwaps.approvedRouters", async () => {
            const rpcInteractor = createMockRPCInteractor();
            let approvedRoutersCalls = 0;
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName }: ReadContractParams) => {
                    if (functionName === "ROUTING_TYPEHASH") return RELAY_SWAP_ROUTING_TYPEHASH;
                    approvedRoutersCalls += 1;
                    return approvedRoutersCalls === 1; // transactionTo passes, approvalAddress fails
                },
            );
            service = new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: rpcInteractor }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: createMockSwapAndDepositQuoteProvider(),
            });

            await expect(service.prepareReshieldQuote(prepareParams())).rejects.toThrow(
                UnallowedLiFiAddress,
            );
        });

        // LiFi's Executor runs arbitrary calls for anyone and sits on the router allowlist: as the
        // target it defeats the deposit-embedding check, as the spender anyone can drain the approval.
        const LIFI_EXECUTOR = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;

        function serviceQuoting(overrides: { transactionTo?: Address; approvalAddress?: Address }): PoolSessionReshield<PreparedTransaction> {
            const provider = createMockSwapAndDepositQuoteProvider();
            const base = vi.mocked(provider.getSwapAndDepositQuote).getMockImplementation()!;
            vi.mocked(provider.getSwapAndDepositQuote).mockImplementation(async (req) => ({
                ...(await base(req)),
                ...overrides,
            }));
            return new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: provider,
            });
        }

        it("reject a quote targeting the swap executor even though it embeds the deposit", async () => {
            await expect(
                serviceQuoting({ transactionTo: LIFI_EXECUTOR }).prepareReshieldQuote(prepareParams()),
            ).rejects.toThrow(UnexpectedTransactionTarget);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject a quote whose approval spender is the swap executor", async () => {
            await expect(
                serviceQuoting({ approvalAddress: LIFI_EXECUTOR }).prepareReshieldQuote(prepareParams()),
            ).rejects.toThrow(UnexpectedTransactionTarget);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("throw LiFiDepositCalldataNotFound when transactionData omits the deposit calldata", async () => {
            // transactionData has the ABI-padded Entrypoint but NOT the deposit calldata bytes.
            // Simulates a compromised quote that swapped out the Entrypoint.deposit() call.
            const provider = {
                getSwapAndDepositQuote: vi.fn(async () => ({
                    fromAmount: "999990",
                    toAmount: TOTAL_DEPOSIT_COST,
                    approvalAddress: VALID_PROCESSOR,
                    transactionData:
                        "0x0000000000000000000000009999999999999999999999999999999999999991" as Hex,
                    transactionTo: VALID_SWAP_TARGET,
                    transactionValue: "0x0" as Hex,
                    estimatedDuration: 30,
                    fromTokenAddress: VALID_TOKEN,
                    toTokenAddress: VALID_OUTPUT_TOKEN,
                    fromChainId: POOL_CHAIN_ID,
                    toChainId: POOL_CHAIN_ID,
                })),
            } as unknown as ISwapAndDepositQuoteProvider;
            const testService = new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: provider,
            });

            await expect(testService.prepareReshieldQuote(prepareParams())).rejects.toThrow(
                LiFiDepositCalldataNotFound,
            );
        });

        it("throw LiFiDepositTargetNotFound when transactionData omits the Entrypoint address", async () => {
            // transactionData has the deposit calldata bytes but NOT the ABI-padded Entrypoint.
            // Simulates a compromised quote that routes the swap output to an attacker contract.
            const provider = {
                getSwapAndDepositQuote: vi.fn(async () => ({
                    fromAmount: "999990",
                    toAmount: TOTAL_DEPOSIT_COST,
                    approvalAddress: VALID_PROCESSOR,
                    transactionData: "0xabcdef" as Hex,
                    transactionTo: VALID_SWAP_TARGET,
                    transactionValue: "0x0" as Hex,
                    estimatedDuration: 30,
                    fromTokenAddress: VALID_TOKEN,
                    toTokenAddress: VALID_OUTPUT_TOKEN,
                    fromChainId: POOL_CHAIN_ID,
                    toChainId: POOL_CHAIN_ID,
                })),
            } as unknown as ISwapAndDepositQuoteProvider;
            const testService = new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: provider,
            });

            await expect(testService.prepareReshieldQuote(prepareParams())).rejects.toThrow(
                LiFiDepositTargetNotFound,
            );
        });
    });

    describe("relayReshield", () => {
        function buildRoutingData(overrides?: {
            recipient?: Address;
            outputToken?: Address;
            dustRecipient?: Address;
            feeAmount?: bigint;
            minOutputAmount?: bigint;
            nativeGas?: bigint;
            swapTarget?: Address;
            approvalAddress?: Address;
            dustRescue?: {
                chainId: bigint;
                tokenId: Address;
                isCanonical: boolean;
                spendingPubKey: Hex;
                viewingPubKey: Hex;
            };
        }): Hex {
            return encodeAbiParameters(RELAY_SWAP_ROUTING_ABI, [
                {
                    swapTarget: overrides?.swapTarget ?? VALID_SWAP_TARGET,
                    approvalAddress: overrides?.approvalAddress ?? VALID_SWAP_TARGET,
                    outputToken: overrides?.outputToken ?? VALID_OUTPUT_TOKEN,
                    recipient: overrides?.recipient ?? EMPTY_ADDRESS,
                    feeRecipient: VALID_RELAY,
                    fallbackAddress: EMPTY_ADDRESS,
                    dustRecipient: overrides?.dustRecipient ?? VALID_RELAY,
                    feeAmount: overrides?.feeAmount ?? BigInt(FEE_AMOUNT),
                    minOutputAmount: overrides?.minOutputAmount ?? 0n,
                    nativeGas: overrides?.nativeGas ?? 0n,
                    swapValue: 0n,
                    gasSwapMaxInput: 0n,
                    gasSwapCalldata: "0x",
                    swapCalldata: SWAP_CALLDATA,
                    dustRescue: overrides?.dustRescue ?? {
                        chainId: 0n,
                        tokenId: EMPTY_ADDRESS,
                        isCanonical: false,
                        spendingPubKey: "0x",
                        viewingPubKey: "0x",
                    },
                },
            ]);
        }

        function relayParams(
            routingOverrides?: Parameters<typeof buildRoutingData>[0],
            paramsOverrides?: { dustRescue?: ReshieldParams["dustRescue"] },
        ): ReshieldParams {
            return {
                inputCommitments: [MOCK_COMMITMENT],
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                swapCalldata: SWAP_CALLDATA,
                dustRescue: paramsOverrides?.dustRescue,
                selectedQuote: {
                    relayerInfo: RELAYER_INFO,
                    quote: {
                        txCost: "0",
                        gasPrice: "0",
                        feeAmount: FEE_AMOUNT,
                        feeCommitment: {
                            data: buildRoutingData(routingOverrides),
                            asset: VALID_TOKEN,
                            expiration: Date.now() + 3_600_000,
                            feeAmount: FEE_AMOUNT,
                            signedRelayerCommitment: "0xdeadbeef" as Hex,
                            recipient: EMPTY_ADDRESS,
                            amountSent: (BigInt(AMOUNT) + BigInt(FEE_AMOUNT)).toString(),
                        },
                    },
                },
            };
        }

        it("relay when the routing tuple matches all reshield invariants", async () => {
            await expect(service.relayReshield(relayParams())).resolves.toBeDefined();
            expect(core.prepareTransact).toHaveBeenCalledOnce();
        });

        // A relayed reshield executes via RelaySwaps.execute(), which calls PoolVault.transact()
        // itself — so the proof-bound processor must be RelaySwaps, not the relayer's
        // withdrawal-only fee processor (RELAYER_INFO.processorAddress). Binding the latter made
        // every relayed reshield revert PoolVault_ProofContextMismatch on-chain.
        it("bind RelaySwaps, not relayerInfo.processorAddress, as the proof processor", async () => {
            await service.relayReshield(relayParams());

            expect(VALID_RELAY_SWAPS).not.toBe(RELAYER_INFO.processorAddress);
            expect(core.prepareTransact).toHaveBeenCalledWith(
                expect.objectContaining({
                    processorAddress: VALID_RELAY_SWAPS,
                    transactParams: expect.objectContaining({ processor: VALID_RELAY_SWAPS }) as object,
                }),
            );
        });

        it("throw InvalidTransactParams when relaySwapsAddress is not configured", async () => {
            const unconfigured = new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                entrypointInteractor,
                swapQuoteProvider: createMockSwapQuoteProvider(),
                swapAndDepositQuoteProvider: createMockSwapAndDepositQuoteProvider(),
            });

            await expect(unconfigured.relayReshield(relayParams())).rejects.toThrow(
                InvalidTransactParams,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        describe("dustRescue", () => {
            const dustRescue = { recipientIdentifier: DUST_RESCUE_IDENTIFIER };
            const matchingRoutingDustRescue = {
                chainId: BigInt(POOL_CHAIN_ID),
                tokenId: VALID_OUTPUT_TOKEN,
                isCanonical: false,
                spendingPubKey: DUST_RESCUE_IDENTIFIER.spendingPubKey,
                viewingPubKey: "0x" as Hex,
            };

            it("relays when the routing dustRescue matches the expected opt-in", async () => {
                await expect(
                    service.relayReshield(
                        relayParams({ dustRescue: matchingRoutingDustRescue }, { dustRescue }),
                    ),
                ).resolves.toBeDefined();
            });

            it("throws InvalidTransactParams when the caller opts in but the routing carries the zero sentinel", async () => {
                await expect(
                    service.relayReshield(relayParams(undefined, { dustRescue })),
                ).rejects.toBeInstanceOf(InvalidTransactParams);
            });

            it("throws InvalidTransactParams when the routing dustRescue tokenId diverges", async () => {
                await expect(
                    service.relayReshield(
                        relayParams(
                            {
                                dustRescue: { ...matchingRoutingDustRescue, tokenId: VALID_TOKEN },
                            },
                            { dustRescue },
                        ),
                    ),
                ).rejects.toBeInstanceOf(InvalidTransactParams);
            });

            it("throws InvalidTransactParams when the routing dustRescue spendingPubKey diverges", async () => {
                await expect(
                    service.relayReshield(
                        relayParams(
                            {
                                dustRescue: {
                                    ...matchingRoutingDustRescue,
                                    spendingPubKey: `0x${"ab".repeat(33)}` as Hex,
                                },
                            },
                            { dustRescue },
                        ),
                    ),
                ).rejects.toBeInstanceOf(InvalidTransactParams);
            });

            it("throws InvalidTransactParams when the routing dustRescue viewingPubKey diverges", async () => {
                // DUST_RESCUE_IDENTIFIER is kind "raw" — the expected viewingPubKey is always
                // "0x", so any nonempty routing value must be rejected.
                await expect(
                    service.relayReshield(
                        relayParams(
                            {
                                dustRescue: {
                                    ...matchingRoutingDustRescue,
                                    viewingPubKey: `0x${"cd".repeat(33)}` as Hex,
                                },
                            },
                            { dustRescue },
                        ),
                    ),
                ).rejects.toBeInstanceOf(InvalidTransactParams);
            });

            it("throws InvalidTransactParams when the routing dustRescue isCanonical diverges", async () => {
                // DUST_RESCUE_IDENTIFIER is kind "raw" — expected isCanonical is always false.
                await expect(
                    service.relayReshield(
                        relayParams(
                            { dustRescue: { ...matchingRoutingDustRescue, isCanonical: true } },
                            { dustRescue },
                        ),
                    ),
                ).rejects.toBeInstanceOf(InvalidTransactParams);
            });

            it("throws InvalidTransactParams when the relayer attaches a dustRescue the caller never requested", async () => {
                // No dustRescue in paramsOverrides — expected.dustRescue is undefined, so the
                // routing must decode to the all-zero sentinel. A relayer attaching a real
                // dustRescue anyway (unrequested) must be rejected, not silently accepted.
                await expect(
                    service.relayReshield(
                        relayParams({ dustRescue: matchingRoutingDustRescue }, undefined),
                    ),
                ).rejects.toBeInstanceOf(InvalidTransactParams);
            });

            it("throws DustRescueRecipientConflict when dustRecipient conflicts with the opt-in", async () => {
                const params = relayParams(
                    { dustRescue: matchingRoutingDustRescue, dustRecipient: VALID_OUTPUT_TOKEN },
                    { dustRescue },
                );
                await expect(
                    service.relayReshield({ ...params, dustRecipient: VALID_OUTPUT_TOKEN }),
                ).rejects.toBeInstanceOf(DustRescueRecipientConflict);
            });
        });

        // The reshield-transfer session's relayReshieldTransfer/prepareReshieldTransferQuote are
        // one-line delegations to a real PoolSessionReshield — this exercises that delegate
        // un-mocked, so the dustRescue relay-time revalidation above is proven to actually run
        // for the transfer variant too, not just asserted by inspecting the delegation call.
        describe("via PoolSessionReshieldTransfer (real, un-mocked delegate)", () => {
            function buildTransferSession(): PoolSessionReshieldTransfer {
                return new PoolSessionReshieldTransfer({
                    reshieldDelegate: service,
                    yieldDepositTargets: [],
                    addressEqualityComparator: new EvmAddressEqualityComparator(),
                });
            }

            it("relays when the routing dustRescue matches the expected opt-in", async () => {
                const dustRescue = { recipientIdentifier: DUST_RESCUE_IDENTIFIER };
                const matchingRoutingDustRescue = {
                    chainId: BigInt(POOL_CHAIN_ID),
                    tokenId: VALID_OUTPUT_TOKEN,
                    isCanonical: false,
                    spendingPubKey: DUST_RESCUE_IDENTIFIER.spendingPubKey,
                    viewingPubKey: "0x" as Hex,
                };
                const transferSession = buildTransferSession();

                await expect(
                    transferSession.relayReshieldTransfer(
                        relayParams({ dustRescue: matchingRoutingDustRescue }, { dustRescue }),
                    ),
                ).resolves.toBeDefined();
            });

            it("throws InvalidTransactParams when the routing dustRescue tokenId diverges", async () => {
                const dustRescue = { recipientIdentifier: DUST_RESCUE_IDENTIFIER };
                const mismatchedRoutingDustRescue = {
                    chainId: BigInt(POOL_CHAIN_ID),
                    tokenId: VALID_TOKEN,
                    isCanonical: false,
                    spendingPubKey: DUST_RESCUE_IDENTIFIER.spendingPubKey,
                    viewingPubKey: "0x" as Hex,
                };
                const transferSession = buildTransferSession();

                await expect(
                    transferSession.relayReshieldTransfer(
                        relayParams({ dustRescue: mismatchedRoutingDustRescue }, { dustRescue }),
                    ),
                ).rejects.toBeInstanceOf(InvalidTransactParams);
            });

            it("throws InvalidTransactParams when the relayer attaches a dustRescue the caller never requested", async () => {
                const matchingRoutingDustRescue = {
                    chainId: BigInt(POOL_CHAIN_ID),
                    tokenId: VALID_OUTPUT_TOKEN,
                    isCanonical: false,
                    spendingPubKey: DUST_RESCUE_IDENTIFIER.spendingPubKey,
                    viewingPubKey: "0x" as Hex,
                };
                const transferSession = buildTransferSession();

                await expect(
                    transferSession.relayReshieldTransfer(
                        relayParams({ dustRescue: matchingRoutingDustRescue }, undefined),
                    ),
                ).rejects.toBeInstanceOf(InvalidTransactParams);
            });

            it("rejects a self-owned depositResult at prepareReshieldTransferQuote before ever reaching the delegate's relay-time checks", async () => {
                const transferSession = buildTransferSession();
                const selfOwnedDepositResult = buildDepositResult();
                (selfOwnedDepositResult.pendingNote as { isOwned?: boolean }).isOwned = true;

                await expect(
                    transferSession.prepareReshieldTransferQuote({
                        relayerInfo: RELAYER_INFO,
                        amount: AMOUNT,
                        tokenId: VALID_TOKEN,
                        outputToken: VALID_OUTPUT_TOKEN,
                        depositResult: selfOwnedDepositResult,
                        totalDepositCost: TOTAL_DEPOSIT_COST,
                    }),
                ).rejects.toBeInstanceOf(InvalidTransactParams);
                expect(relayerInteractor.getSwapQuote).not.toHaveBeenCalled();
            });
        });

        // AW-L-02 / #1070. Reshield persists SPENT on a RELAYER-chosen txHash, so it must hand
        // the receipt evidence to the verification gate. It previously called persistNoteUpdates
        // bare — the gate was optional, so it silently no-op'd and a relayer returning the hash
        // of an unrelated successful tx could drive spendable notes to SPENT. SPENT is terminal,
        // so that corruption is unrecoverable by discovery.
        it("forward receipt evidence to persistNoteUpdates so the SPENT gate cannot be skipped", async () => {
            await service.relayReshield(relayParams());

            expect(core.persistNoteUpdates).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                "0x1",
                { expectedNullifiers: [MOCK_SPENT_NULLIFIER], receiptLogs: [] },
            );
        });

        it("reject routing whose recipient is not the zero sentinel", async () => {
            const params = relayParams({ recipient: VALID_RELAY });
            await expect(service.relayReshield(params)).rejects.toThrow(
                "must be the empty-address sentinel",
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject a commitment whose asset differs from the withdraw tokenId", async () => {
            const params = relayParams();
            params.selectedQuote.quote.feeCommitment.asset = VALID_OUTPUT_TOKEN;
            await expect(service.relayReshield(params)).rejects.toThrow("feeCommitment.asset");
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject routing with nonzero minOutputAmount", async () => {
            const params = relayParams({ minOutputAmount: 1n });
            await expect(service.relayReshield(params)).rejects.toThrow("must be 0");
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject routing with nonzero nativeGas", async () => {
            const params = relayParams({ nativeGas: 1n });
            await expect(service.relayReshield(params)).rejects.toThrow("must be 0");
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject routing whose outputToken differs from params", async () => {
            const params = relayParams({ outputToken: VALID_TOKEN });
            await expect(service.relayReshield(params)).rejects.toThrow("outputToken");
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject routing whose dustRecipient differs from the relayer default", async () => {
            const params = relayParams({
                dustRecipient: "0x9999999999999999999999999999999999999999" as Address,
            });
            await expect(service.relayReshield(params)).rejects.toThrow("dustRecipient");
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject routing whose feeAmount differs from the quote feeAmount", async () => {
            const params = relayParams({ feeAmount: 99n });
            await expect(service.relayReshield(params)).rejects.toThrow("feeAmount");
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject routing whose swapTarget differs from the caller's expected target", async () => {
            const params = { ...relayParams(), swapTarget: VALID_PROCESSOR };
            await expect(service.relayReshield(params)).rejects.toThrow("swapTarget");
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject routing whose approvalAddress differs from the caller's expected", async () => {
            const params = { ...relayParams(), approvalAddress: VALID_PROCESSOR };
            await expect(service.relayReshield(params)).rejects.toThrow("approvalAddress");
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject hand-built routing that targets or approves the swap executor", async () => {
            const executor = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;
            await expect(service.relayReshield(relayParams({ swapTarget: executor }))).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            await expect(
                service.relayReshield(relayParams({ approvalAddress: executor })),
            ).rejects.toThrow(UnexpectedTransactionTarget);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("relay when expected swapTarget and approvalAddress match the routing", async () => {
            const params = {
                ...relayParams(),
                swapTarget: VALID_SWAP_TARGET,
                approvalAddress: VALID_SWAP_TARGET,
            };
            await expect(service.relayReshield(params)).resolves.toBeDefined();
            expect(core.prepareTransact).toHaveBeenCalledOnce();
        });
    });

    describe("yield share input (RelaySwaps unwrap)", () => {
        const SHARE_UNDERLYING = "0x00000000000000000000000000000000000005dc" as Address;
        const ZAP = "0x0000000000000000000000000000000000000a99" as Address;
        /** 1 share redeems to 2 underlying units. */
        const RATE = 2n;
        let rpcInteractor: IRPCInteractor;
        let swapQuoteProvider: ISwapQuoteProvider;
        let swapAndDepositQuoteProvider: ISwapAndDepositQuoteProvider;
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
            service = new PoolSessionReshield({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor,
                entrypointInteractor,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
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
            swapQuoteProvider = createMockSwapQuoteProvider();
            swapAndDepositQuoteProvider = createMockSwapAndDepositQuoteProvider();
            // Return a LiFi input within the dust tolerance of what the net shares redeem to.
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: {
                    fromToken: Address;
                    toToken: Address;
                    fromChainId: number;
                    toChainId: number;
                }) => ({
                    fromAmount: req.fromToken === SHARE_UNDERLYING ? "1999900" : "999990",
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
            yieldToken = {
                getAddress: vi.fn(() => VALID_TOKEN),
                previewRedeem: vi.fn(async (shares: bigint) => shares * RATE),
            } as unknown as IPPYieldTokenInteractor;
            mockZapAllowlist(true);
            buildYieldService(ZAP);
        });

        it("estimate: quote the DEX leg on the underlying for previewRedeem(net shares)", async () => {
            const estimate = await service.estimateReshieldAmount({
                relayerInfo: RELAYER_INFO,
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
            });

            const dexReq = vi.mocked(swapQuoteProvider.getSwapQuote).mock.calls[0][0];
            expect(dexReq.fromToken).toBe(SHARE_UNDERLYING);
            expect(dexReq.amount).toBe("1999980"); // (1_000_000 − 10) × 2
            expect(yieldToken.previewRedeem).toHaveBeenCalledWith(999_990n);
            expect(estimate.swapInputToken).toBe(SHARE_UNDERLYING);
            expect(rpcInteractor.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "approvedZaps", args: [ZAP] }),
            );
        });

        it("prepare: LiFi on the underlying, relayer fee on the share, netAmount in shares", async () => {
            const prepared = await service.prepareReshieldQuote({
                relayerInfo: RELAYER_INFO,
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                depositResult: buildDepositResult(),
                totalDepositCost: TOTAL_DEPOSIT_COST,
            });

            const lifiReq = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(lifiReq.fromToken).toBe(SHARE_UNDERLYING);

            for (const call of vi.mocked(relayerInteractor.getSwapQuote).mock.calls) {
                expect(call[1].asset).toBe(VALID_TOKEN);
                expect(call[1].amount).toBe(BigInt(AMOUNT).toString());
            }

            expect(prepared.swapInputToken).toBe(SHARE_UNDERLYING);
            expect(BigInt(prepared.netAmount)).toBe(BigInt(AMOUNT) - BigInt(FEE_AMOUNT));
            // dust = committed net underlying (1_999_980) − LiFi input (1_999_900).
            expect(BigInt(prepared.dustAmount)).toBe(80n);
        });

        it("prepare: reject before any commitment when the zap is not allowlisted", async () => {
            mockZapAllowlist(false);
            await expect(
                service.prepareReshieldQuote({
                    relayerInfo: RELAYER_INFO,
                    amount: AMOUNT,
                    tokenId: VALID_TOKEN,
                    outputToken: VALID_OUTPUT_TOKEN,
                    depositResult: buildDepositResult(),
                    totalDepositCost: TOTAL_DEPOSIT_COST,
                }),
            ).rejects.toThrow(/is not allowlisted on processor/);
            expect(swapAndDepositQuoteProvider.getSwapAndDepositQuote).not.toHaveBeenCalled();
        });

        it("prepare: reject when the deployment names no zap", async () => {
            buildYieldService(undefined);
            await expect(
                service.prepareReshieldQuote({
                    relayerInfo: RELAYER_INFO,
                    amount: AMOUNT,
                    tokenId: VALID_TOKEN,
                    outputToken: VALID_OUTPUT_TOKEN,
                    depositResult: buildDepositResult(),
                    totalDepositCost: TOTAL_DEPOSIT_COST,
                }),
            ).rejects.toThrow(/has no zap configured/);
        });

        it("prepare: a non-yield token stays on the plain path even with wrappers configured", async () => {
            const OTHER_TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
            const prepared = await service.prepareReshieldQuote({
                relayerInfo: RELAYER_INFO,
                amount: AMOUNT,
                tokenId: OTHER_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                depositResult: buildDepositResult(),
                totalDepositCost: TOTAL_DEPOSIT_COST,
            });
            const lifiReq = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(lifiReq.fromToken).toBe(OTHER_TOKEN);
            expect(prepared.swapInputToken).toBe(OTHER_TOKEN);
            expect(yieldToken.previewRedeem).not.toHaveBeenCalled();
        });
    });
});

// A yield SHARE as the reshield output (2026-09-18): the swap buys the share's
// underlying, the redeposit is the share's PPRouter call, and the router is an
// accepted deposit target next to the Entrypoint.
describe("PoolSessionReshield with a yield share as the output", () => {
    const SHARE = "0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6" as Address;
    const ROUTER = "0xe76E793d776c1e207aD7a7fa7C57d27420d85110" as Address;
    const UNDERLYING = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
    const SHARES = 990_000n;
    // The estimate's budget: 99% of the mocked toAmountMin (1_020_305).
    const BUDGET = (1_020_305n * 99n) / 100n;

    function routerCalldata(value: bigint, cap: bigint): Hex {
        return encodeFunctionData({
            abi: PP_ROUTER_DEPOSIT_ABI,
            functionName: "depositExactShares",
            args: [
                {
                    pA: [1n, 2n],
                    pB: [
                        [3n, 4n],
                        [5n, 6n],
                    ],
                    pC: [7n, 8n],
                    pubSignals: [9n, BigInt(SHARE), value, 0n],
                },
                { hint: `0x${"ab".repeat(32)}` as Hex, data: "0x1234" as Hex },
                "0x" as Hex,
                cap,
            ],
        });
    }
    function makeTarget(): YieldDepositTarget {
        return {
            chainId: POOL_CHAIN_ID,
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
        } as unknown as YieldDepositTarget;
    }
    /** LiFi echoes the embedded router call so the containment check passes. */
    function routerQuoteProvider(callData: Hex): ISwapAndDepositQuoteProvider {
        const provider = createMockSwapAndDepositQuoteProvider();
        vi.mocked(provider.getSwapAndDepositQuote).mockImplementation(async (req) => ({
            fromAmount: "999990",
            toAmount: BUDGET.toString(),
            approvalAddress: VALID_PROCESSOR,
            transactionData:
                `0x${ROUTER.slice(2).toLowerCase().padStart(64, "0")}${callData.slice(2)}` as Hex,
            transactionTo: VALID_SWAP_TARGET,
            transactionValue: "0x0" as Hex,
            estimatedDuration: 30,
            fromTokenAddress: req.fromToken,
            toTokenAddress: req.toToken,
            fromChainId: req.fromChainId,
            toChainId: req.toChainId,
        }));
        return provider;
    }
    function buildShareService(
        callData: Hex,
        relayerInteractor: IRelayerInteractor,
    ): PoolSessionReshield<PreparedTransaction> {
        return new PoolSessionReshield<PreparedTransaction>({
            chainId: POOL_CHAIN_ID,
            core: createMockCore(),
            relayerInteractor,
            rpcInteractor: createMockRPCInteractor(),
            addressEqualityComparator: new EvmAddressEqualityComparator(),
            emptyAddress: EMPTY_ADDRESS,
            swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
            relaySwapsAddress: VALID_RELAY_SWAPS,
            entrypointInteractor: createMockEntrypointInteractor(),
            swapQuoteProvider: createMockSwapQuoteProvider(),
            swapAndDepositQuoteProvider: routerQuoteProvider(callData),
            yieldDepositTargets: [toYieldSwapDepositTarget(makeTarget())],
        });
    }

    it("estimate: swaps into the UNDERLYING, sizes the note in shares and reports the budget as the deposit cost", async () => {
        const relayerInteractor = createMockRelayerInteractor();
        const service = buildShareService("0x" as Hex, relayerInteractor);
        const estimate = await service.estimateReshieldAmount({
            relayerInfo: RELAYER_INFO,
            amount: AMOUNT,
            tokenId: VALID_TOKEN,
            outputToken: SHARE,
        });
        const quote = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[0][1];
        expect(quote.outputToken.toLowerCase()).toBe(UNDERLYING.toLowerCase());
        expect(BigInt(estimate.noteValue)).toBe(SHARES);
        expect(BigInt(estimate.totalDepositCost)).toBe(BUDGET);
    });

    it("prepare: accepts the share's router as the deposit target, with the swap output as the routing token", async () => {
        const callData = routerCalldata(SHARES, BUDGET);
        const relayerInteractor = createMockRelayerInteractor();
        const service = buildShareService(callData, relayerInteractor);
        const prepared = await service.prepareReshieldQuote({
            relayerInfo: RELAYER_INFO,
            amount: AMOUNT,
            tokenId: VALID_TOKEN,
            outputToken: SHARE,
            depositResult: buildDepositResult({
                to: ROUTER,
                tokenId: SHARE,
                value: SHARES,
                data: callData,
            }),
            totalDepositCost: BUDGET.toString(),
        });
        expect(prepared.swapTarget.toLowerCase()).toBe(VALID_SWAP_TARGET.toLowerCase());
        for (const call of vi.mocked(relayerInteractor.getSwapQuote).mock.calls) {
            expect(call[1].outputToken.toLowerCase()).toBe(UNDERLYING.toLowerCase());
            expect(call[1].recipient).toBe(EMPTY_ADDRESS);
        }
    });

    it("prepare: still refuses a target that is neither the Entrypoint nor the share's router, and a cap that is not the budget", async () => {
        const callData = routerCalldata(SHARES, BUDGET);
        const service = buildShareService(callData, createMockRelayerInteractor());
        const base = {
            relayerInfo: RELAYER_INFO,
            amount: AMOUNT,
            tokenId: VALID_TOKEN,
            outputToken: SHARE,
            totalDepositCost: BUDGET.toString(),
        };
        await expect(
            service.prepareReshieldQuote({
                ...base,
                depositResult: buildDepositResult({
                    to: VALID_SWAP_TARGET,
                    tokenId: SHARE,
                    value: SHARES,
                    data: callData,
                }),
            }),
        ).rejects.toThrow(DepositTargetMismatch);
        await expect(
            service.prepareReshieldQuote({
                ...base,
                depositResult: buildDepositResult({
                    to: ROUTER,
                    tokenId: SHARE,
                    value: SHARES,
                    data: routerCalldata(SHARES, BUDGET - 1n),
                }),
            }),
        ).rejects.toThrow(InvalidTransactParams);
    });
});

describe("PoolSessionReshield refuses a yield target from another chain", () => {
    it("throws InvalidPoolSessionConfig when a target's chainId is not the session's", () => {
        expect(
            () =>
                new PoolSessionReshield({
                    chainId: POOL_CHAIN_ID,
                    core: createMockCore(),
                    relayerInteractor: createMockRelayerInteractor(),
                    rpcInteractor: createMockRPCInteractor(),
                    addressEqualityComparator: new EvmAddressEqualityComparator(),
                    emptyAddress: EMPTY_ADDRESS,
                    swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                    relaySwapsAddress: VALID_RELAY_SWAPS,
                    entrypointInteractor: createMockEntrypointInteractor(),
                    swapQuoteProvider: createMockSwapQuoteProvider(),
                    swapAndDepositQuoteProvider: createMockSwapAndDepositQuoteProvider(),
                    yieldDepositTargets: [
                        {
                            chainId: 1,
                            shareToken: VALID_OUTPUT_TOKEN,
                            router: VALID_SWAP_TARGET,
                        } as unknown as YieldSwapDepositTarget<PreparedTransaction, Address>,
                    ],
                }),
        ).toThrow(InvalidPoolSessionConfig);
    });
});

// DEV-507 (2026-10-06): for a swap-then-deposit, LiFi routes through its own Executor, which the
// session never signs. With the Executor configured, the session throws that quote away and
// composes the call itself: an ordinary swap paid to the Executor, then the deposit, leftovers to
// RelaySwaps. Nothing from the replaced quote reaches the relayed transaction.
interface AggregatorQuoteRequest {
    fromToken: Address;
    toToken: Address;
    fromChainId: number;
    toChainId: number;
}

describe("PoolSessionReshield composes an executor-routed swap-then-deposit", () => {
    const EXECUTOR = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;
    const ERC20_PROXY = "0x68E1Acfa805dcA813116Ed6507E01c38D44318f0" as Address;
    const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address;
    const OUT = "0x7777777777777777777777777777777777777777" as Address;
    const ATTACKER = "0x6666666666666666666666666666666666666666" as Address;
    const SWAP_INPUT = 999_000n;
    // An ordinary LiFi swap whose calldata pays the executor.
    const SWAP_LEG = ("0x2c57e884" +
        encodeAbiParameters([{ type: "address" }], [EXECUTOR]).slice(2) +
        "ab".repeat(64)) as Hex;
    // What the aggregator returned: its own executor call, here sending funds to an attacker
    // while merely embedding the deposit bytes.
    const AGGREGATOR_EXECUTOR_PAYLOAD = ("0x" +
        encodeAbiParameters([{ type: "address" }], [ATTACKER]).slice(2) +
        "0000000000000000000000009999999999999999999999999999999999999991" +
        "abcdef") as Hex;

    let relayerInteractor: IRelayerInteractor;
    let core: TransactOrchestrator;
    let swapQuoteProvider: ISwapQuoteProvider;
    let swapAndDeposit: ReturnType<typeof createMockSwapAndDepositQuoteProvider>;

    function build(withExecutor = true, withContractCalls = true): PoolSessionReshield<PreparedTransaction> {
        swapQuoteProvider = {
            getSwapQuote: vi.fn(async (req: AggregatorQuoteRequest) => ({
                fromAmount: SWAP_INPUT.toString(),
                toAmount: (BigInt(TOTAL_DEPOSIT_COST) + 20_000n).toString(),
                toAmountMin: (BigInt(TOTAL_DEPOSIT_COST) + 5_000n).toString(),
                approvalAddress: DIAMOND,
                transactionData: SWAP_LEG,
                transactionTo: DIAMOND,
                estimatedDuration: 20,
                fromTokenAddress: req.fromToken,
                toTokenAddress: req.toToken,
                fromChainId: req.fromChainId,
                toChainId: req.toChainId,
            })),
        } as unknown as ISwapQuoteProvider;
        swapAndDeposit = createMockSwapAndDepositQuoteProvider();
        const base = vi.mocked(swapAndDeposit.getSwapAndDepositQuote).getMockImplementation()!;
        vi.mocked(swapAndDeposit.getSwapAndDepositQuote).mockImplementation(async (req) => ({
            ...(await base(req)),
            transactionTo: EXECUTOR,
            approvalAddress: ERC20_PROXY,
            transactionData: AGGREGATOR_EXECUTOR_PAYLOAD,
        }));
        return new PoolSessionReshield({
            chainId: POOL_CHAIN_ID,
            core,
            relayerInteractor,
            rpcInteractor: createMockRPCInteractor(),
            addressEqualityComparator: new EvmAddressEqualityComparator(),
            emptyAddress: EMPTY_ADDRESS,
            swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
            relaySwapsAddress: VALID_RELAY_SWAPS,
            entrypointInteractor: createMockEntrypointInteractor(),
            swapQuoteProvider,
            swapAndDepositQuoteProvider: withContractCalls ? swapAndDeposit : undefined,
            swapExecutor: withExecutor ? { executor: EXECUTOR, erc20Proxy: ERC20_PROXY } : undefined,
            nativeAssetAddress: NATIVE_ASSET_ADDRESS,
        });
    }

    function nativeDeposit(): PrepareDepositResult {
        return {
            ...erc20Deposit(),
            depositTx: {
                data: "0xabcdef" as Hex,
                to: VALID_ENTRYPOINT,
                value: `0x${BigInt(TOTAL_DEPOSIT_COST).toString(16)}` as Hex,
            },
            pendingNote: { tokenId: VALID_OUTPUT_TOKEN, value: `0x${NOTE_VALUE.toString(16)}` as Hex, commitment: MOCK_COMMITMENT },
        } as unknown as PrepareDepositResult;
    }

    function erc20Deposit(): PrepareDepositResult {
        return {
            depositTx: { data: "0xabcdef" as Hex, to: VALID_ENTRYPOINT, value: "0x0" as Hex },
            approvalTx: null,
            pendingNote: { tokenId: OUT, value: `0x${NOTE_VALUE.toString(16)}` as Hex, commitment: MOCK_COMMITMENT },
        } as unknown as PrepareDepositResult;
    }

    function prepareParams(depositResult: PrepareDepositResult = erc20Deposit(), outputToken: Address = OUT): PrepareReshieldQuoteParams {
        return {
            relayerInfo: RELAYER_INFO,
            amount: AMOUNT,
            tokenId: VALID_TOKEN,
            outputToken,
            depositResult,
            totalDepositCost: TOTAL_DEPOSIT_COST,
        };
    }

    beforeEach(() => {
        relayerInteractor = createMockRelayerInteractor();
        core = createMockCore();
    });

    it("discards the aggregator's executor payload and composes the call itself", async () => {
        const prepared = await build().prepareReshieldQuote(prepareParams());

        expect(prepared.swapTarget.toLowerCase()).toBe(EXECUTOR.toLowerCase());
        expect(prepared.approvalAddress.toLowerCase()).toBe(ERC20_PROXY.toLowerCase());
        expect(prepared.swapCalldata.toLowerCase()).not.toContain(ATTACKER.slice(2).toLowerCase());
        expect(vi.mocked(swapQuoteProvider.getSwapQuote)).toHaveBeenCalledWith(
            expect.objectContaining({
                fromToken: VALID_TOKEN,
                toToken: OUT,
                fromAddress: EXECUTOR,
                toAddress: EXECUTOR,
                amountType: "to",
            }),
        );
        const { args } = decodeFunctionData({ abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI, data: prepared.swapCalldata });
        const [, swaps, transferred, receiver, amount] = args;
        // Leftovers go to RelaySwaps, whose delta sweep forwards them to the dust recipient.
        expect(receiver.toLowerCase()).toBe(VALID_RELAY_SWAPS.toLowerCase());
        expect(transferred.toLowerCase()).toBe(VALID_TOKEN);
        expect(amount).toBe(SWAP_INPUT);
        expect(swaps[0].callTo.toLowerCase()).toBe(DIAMOND.toLowerCase());
        expect(swaps[0].receivingAssetId.toLowerCase()).toBe(OUT);
        expect(swaps[1].callTo.toLowerCase()).toBe(VALID_ENTRYPOINT);
        expect(swaps[1].sendingAssetId.toLowerCase()).toBe(OUT);
        expect(swaps[1].fromAmount).toBe(BigInt(TOTAL_DEPOSIT_COST));
        expect(swaps[1].callData).toBe("0xabcdef");
        // The committed relayer quote binds exactly the composed call.
        const committed = vi.mocked(relayerInteractor.getSwapQuote).mock.calls.at(-1)![1];
        expect(committed.swapCalldata).toBe(prepared.swapCalldata);
        expect(committed.swapTarget).toBe(EXECUTOR);
        expect(committed.approvalAddress).toBe(ERC20_PROXY);
    });

    it("hands a native-coin output to the deposit call as exactly its value", async () => {
        const depositValue = BigInt(TOTAL_DEPOSIT_COST);
        const prepared = await build().prepareReshieldQuote(prepareParams(nativeDeposit(), VALID_OUTPUT_TOKEN));
        const { args } = decodeFunctionData({ abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI, data: prepared.swapCalldata });
        const [, swaps] = args;
        expect(swaps[1].sendingAssetId).toBe(EMPTY_ADDRESS);
        expect(swaps[1].fromAmount).toBe(depositValue);
    });

    // QA 2026-10-08 (BSC, ppUSDT -> BNB): LiFi refuses every native-output contract-calls quote
    // (422/1004 "Step simulation failed") because its Executor would hand the deposit the
    // route's guaranteed delivery, never the exact msg.value the Entrypoint requires. The
    // native path must not depend on that quote at all.
    it("composes a native-coin output without asking for a contract-calls quote", async () => {
        const service = build();
        vi.mocked(swapAndDeposit.getSwapAndDepositQuote).mockRejectedValue(
            new Error("422 Step simulation failed: Transaction reverted silently"),
        );
        const prepared = await service.prepareReshieldQuote(prepareParams(nativeDeposit(), VALID_OUTPUT_TOKEN));
        expect(swapAndDeposit.getSwapAndDepositQuote).not.toHaveBeenCalled();
        expect(prepared.swapTarget.toLowerCase()).toBe(EXECUTOR.toLowerCase());
        const { args } = decodeFunctionData({ abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI, data: prepared.swapCalldata });
        expect(args[1][1].fromAmount).toBe(BigInt(TOTAL_DEPOSIT_COST));
        expect(vi.mocked(swapQuoteProvider.getSwapQuote)).toHaveBeenCalledWith(
            expect.objectContaining({ toToken: VALID_OUTPUT_TOKEN, amountType: "to" }),
        );
    });

    it("composes a native-coin output without a contract-calls provider configured", async () => {
        const prepared = await build(true, false).prepareReshieldQuote(
            prepareParams(nativeDeposit(), VALID_OUTPUT_TOKEN),
        );
        expect(prepared.swapTarget.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    });

    it("rejects a native deposit whose value differs from the validated cost", async () => {
        const deposit = nativeDeposit();
        (deposit.depositTx as { value: Hex }).value = `0x${(BigInt(TOTAL_DEPOSIT_COST) + 1n).toString(16)}` as Hex;
        await expect(
            build().prepareReshieldQuote(prepareParams(deposit, VALID_OUTPUT_TOKEN)),
        ).rejects.toThrow(InvalidTransactParams);
        expect(vi.mocked(swapQuoteProvider.getSwapQuote)).not.toHaveBeenCalled();
    });

    it("refuses a native-coin output with a typed error when no executor is configured", async () => {
        const service = build(false);
        await expect(
            service.prepareReshieldQuote(prepareParams(nativeDeposit(), VALID_OUTPUT_TOKEN)),
        ).rejects.toThrow(NativeSwapDepositUnavailable);
        expect(swapAndDeposit.getSwapAndDepositQuote).not.toHaveBeenCalled();
        expect(relayerInteractor.getSwapQuote).not.toHaveBeenCalled();
    });

    it("gives the embedded deposit call a gas budget above the measured ~574k", async () => {
        await build().prepareReshieldQuote(prepareParams());
        expect(swapAndDeposit.getSwapAndDepositQuote).toHaveBeenCalledWith(
            expect.objectContaining({ depositGasLimit: "800000" }),
        );
    });

    it("refuses when the swap cannot guarantee what the deposit consumes", async () => {
        const service = build();
        vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementation(async (req: AggregatorQuoteRequest) => ({
            fromAmount: SWAP_INPUT.toString(),
            toAmount: TOTAL_DEPOSIT_COST,
            toAmountMin: (BigInt(TOTAL_DEPOSIT_COST) - 1n).toString(),
            approvalAddress: DIAMOND,
            transactionData: SWAP_LEG,
            transactionTo: DIAMOND,
            estimatedDuration: 20,
            fromTokenAddress: req.fromToken,
            toTokenAddress: req.toToken,
            fromChainId: req.fromChainId,
            toChainId: req.toChainId,
        }));
        await expect(service.prepareReshieldQuote(prepareParams())).rejects.toThrow(InvalidTransactParams);
        expect(core.prepareTransact).not.toHaveBeenCalled();
    });

    describe("at relay", () => {
        async function preparedRelayParams(): Promise<ReshieldParams> {
            const prepared = await build().prepareReshieldQuote(prepareParams());
            prepared.selectedQuote.quote.feeCommitment.expiration = Date.now() + 3_600_000;
            return {
                inputCommitments: [MOCK_COMMITMENT],
                amount: prepared.netAmount,
                tokenId: VALID_TOKEN,
                outputToken: OUT,
                swapCalldata: prepared.swapCalldata,
                selectedQuote: prepared.selectedQuote,
                swapTarget: prepared.swapTarget,
                approvalAddress: prepared.approvalAddress,
                depositNote: prepared.depositNote,
                executorCall: prepared.executorCall,
            };
        }

        function withRouting(params: ReshieldParams, swapCalldata: Hex): ReshieldParams {
            const routing = new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }).decodeSwapRouting(
                params.selectedQuote.quote.feeCommitment.data,
            );
            const data = encodeAbiParameters(RELAY_SWAP_ROUTING_ABI, [{ ...routing, swapCalldata } as never]);
            return {
                ...params,
                swapCalldata,
                selectedQuote: {
                    ...params.selectedQuote,
                    quote: {
                        ...params.selectedQuote.quote,
                        feeCommitment: { ...params.selectedQuote.quote.feeCommitment, data },
                    },
                },
            };
        }

        it("relays the composed call", async () => {
            const service = build();
            await expect(service.relayReshield(await preparedRelayParams())).resolves.toBeDefined();
            expect(core.prepareTransact).toHaveBeenCalledOnce();
        });

        it("refuses the aggregator's own executor payload, hand-built into the routing", async () => {
            const service = build();
            const params = withRouting(await preparedRelayParams(), AGGREGATOR_EXECUTOR_PAYLOAD);
            await expect(service.relayReshield(params)).rejects.toThrow(UnexpectedTransactionTarget);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("refuses a composed call whose leftovers go anywhere but RelaySwaps", async () => {
            const service = build();
            const params = await preparedRelayParams();
            const adapter = new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() });
            const decoded = adapter.decodeSwapThenCall(params.swapCalldata)!;
            const tampered = adapter.encodeSwapThenCall({ ...decoded, receiver: ATTACKER });
            await expect(service.relayReshield(withRouting(params, tampered))).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("refuses a composed call whose deposit goes anywhere but this session's targets", async () => {
            const service = build();
            const params = await preparedRelayParams();
            const adapter = new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() });
            const decoded = adapter.decodeSwapThenCall(params.swapCalldata)!;
            const tampered = adapter.encodeSwapThenCall({ ...decoded, callTarget: ATTACKER });
            await expect(service.relayReshield(withRouting(params, tampered))).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });
        it("echoes the composed input amount and call value for relay to pin", async () => {
            const prepared = await build().prepareReshieldQuote(prepareParams());
            expect(BigInt(prepared.executorCall!.inputAmount)).toBe(SWAP_INPUT);
            expect(BigInt(prepared.executorCall!.callValue)).toBe(BigInt(TOTAL_DEPOSIT_COST));
        });

        it("refuses a composed call whose deposit is handed a different amount than prepare composed", async () => {
            const params = await preparedRelayParams();
            const adapter = new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() });
            const decoded = adapter.decodeSwapThenCall(params.swapCalldata)!;
            for (const callValue of [decoded.callValue - 1n, decoded.callValue + 1n]) {
                const tampered = adapter.encodeSwapThenCall({ ...decoded, callValue });
                await expect(build().relayReshield(withRouting(params, tampered))).rejects.toThrow(
                    /deposit call is handed/,
                );
            }
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("refuses a composed call whose swap pulls a different input amount than prepare composed", async () => {
            const params = await preparedRelayParams();
            const adapter = new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() });
            const decoded = adapter.decodeSwapThenCall(params.swapCalldata)!;
            for (const inputAmount of [decoded.inputAmount - 1n, decoded.inputAmount + 1n]) {
                const tampered = adapter.encodeSwapThenCall({ ...decoded, inputAmount });
                await expect(build().relayReshield(withRouting(params, tampered))).rejects.toThrow(
                    /executor call: input/,
                );
            }
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("refuses an executor call whose deposit is handed nothing, even when the echo agrees", async () => {
            const params = await preparedRelayParams();
            const adapter = new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() });
            const decoded = adapter.decodeSwapThenCall(params.swapCalldata)!;
            const tampered = adapter.encodeSwapThenCall({ ...decoded, callValue: 0n });
            await expect(
                build().relayReshield({
                    ...withRouting(params, tampered),
                    executorCall: { ...params.executorCall!, callValue: "0x0" as Hex },
                }),
            ).rejects.toThrow(/handed nothing/);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("refuses an executor call relayed without the amounts prepare composed", async () => {
            const params = await preparedRelayParams();
            await expect(build().relayReshield({ ...params, executorCall: undefined })).rejects.toThrow(
                /must echo PreparedReshieldQuote.executorCall/,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("refuses a swap input above the net withdrawal even when the echo agrees with the calldata", async () => {
            const params = await preparedRelayParams();
            const adapter = new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() });
            const decoded = adapter.decodeSwapThenCall(params.swapCalldata)!;
            const inputAmount = BigInt(params.amount) + 1n;
            const tampered = adapter.encodeSwapThenCall({ ...decoded, inputAmount });
            await expect(
                build().relayReshield({
                    ...withRouting(params, tampered),
                    executorCall: { ...params.executorCall!, inputAmount: `0x${inputAmount.toString(16)}` as Hex },
                }),
            ).rejects.toThrow(/exceeds the net withdrawal/);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });
    });
});

// Prod QA 2026-10-13: the estimate sized the deposit from a plain /v1/quote while prepare built
// the executor route, so prepare refused with lifiInputExceedsNet on every retry (BSC) or found
// no contract-calls route at all (Optimism). The estimate now asks the route prepare builds.
describe("PoolSessionReshield sizes the estimate from the executor route prepare builds", () => {
    const EXECUTOR = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;
    const ERC20_PROXY = "0x68E1Acfa805dcA813116Ed6507E01c38D44318f0" as Address;
    const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address;
    const OUT = "0x7777777777777777777777777777777777777777" as Address;
    const SWAP_LEG = ("0x2c57e884" +
        encodeAbiParameters([{ type: "address" }], [EXECUTOR]).slice(2) +
        "ab".repeat(64)) as Hex;
    // BSC USDC-share -> USDT-share: the net budget prod reported.
    const BSC_NET = 12_921_950_211_317_188_232n;
    const BSC_AMOUNT = `0x${(BSC_NET + BigInt(FEE_AMOUNT)).toString(16)}` as Hex;

    let relayerInteractor: IRelayerInteractor;
    let swapQuoteProvider: ISwapQuoteProvider;
    let swapAndDeposit: ReturnType<typeof createMockSwapAndDepositQuoteProvider>;
    /** Exact-output requests the executor composition sent, with the input each one priced. */
    let exactOut: { toAmount: bigint; fromAmount: bigint }[];

    /**
     * A 1:1 plain quote, and an exact-output route that needs `routeCostPpm` / 1e6 input per
     * unit out (1_000_000 = both agree). `exactOutError` makes every exact-output quote fail.
     */
    function build(opts: {
        routeCostPpm: bigint;
        exactOutError?: Error;
        contractCallsError?: Error;
        /** The aggregator's own (non-executor) route, needing this input. */
        contractCallsFromAmount?: bigint;
        yieldTargets?: YieldSwapDepositTarget[];
    }): PoolSessionReshield<PreparedTransaction> {
        exactOut = [];
        swapQuoteProvider = {
            getSwapQuote: vi.fn(async (req: AggregatorQuoteRequest & { amount: string; amountType: "from" | "to" }) => {
                const amount = BigInt(req.amount);
                let fromAmount: bigint;
                let toAmount: bigint;
                if (req.amountType === "to") {
                    if (opts.exactOutError) throw opts.exactOutError;
                    toAmount = amount;
                    fromAmount = (amount * opts.routeCostPpm + 999_999n) / 1_000_000n;
                    exactOut.push({ toAmount, fromAmount });
                } else {
                    fromAmount = amount;
                    toAmount = amount;
                }
                return {
                    fromAmount: fromAmount.toString(),
                    toAmount: toAmount.toString(),
                    // The 0.5% slippage floor the provider applies.
                    toAmountMin: ((toAmount * 9_950n) / 10_000n).toString(),
                    approvalAddress: DIAMOND,
                    transactionData: SWAP_LEG,
                    transactionTo: DIAMOND,
                    estimatedDuration: 20,
                    fromTokenAddress: req.fromToken,
                    toTokenAddress: req.toToken,
                    fromChainId: req.fromChainId,
                    toChainId: req.toChainId,
                };
            }),
        } as unknown as ISwapQuoteProvider;
        swapAndDeposit = createMockSwapAndDepositQuoteProvider();
        const base = vi.mocked(swapAndDeposit.getSwapAndDepositQuote).getMockImplementation()!;
        vi.mocked(swapAndDeposit.getSwapAndDepositQuote).mockImplementation(async (req) => {
            if (opts.contractCallsError) throw opts.contractCallsError;
            if (opts.contractCallsFromAmount !== undefined) {
                return { ...(await base(req)), fromAmount: opts.contractCallsFromAmount.toString() };
            }
            return { ...(await base(req)), transactionTo: EXECUTOR, approvalAddress: ERC20_PROXY };
        });
        return new PoolSessionReshield({
            chainId: POOL_CHAIN_ID,
            core: createMockCore(),
            relayerInteractor,
            rpcInteractor: createMockRPCInteractor(),
            addressEqualityComparator: new EvmAddressEqualityComparator(),
            emptyAddress: EMPTY_ADDRESS,
            swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
            relaySwapsAddress: VALID_RELAY_SWAPS,
            entrypointInteractor: createMockEntrypointInteractor(),
            swapQuoteProvider,
            swapAndDepositQuoteProvider: swapAndDeposit,
            swapExecutor: { executor: EXECUTOR, erc20Proxy: ERC20_PROXY },
            nativeAssetAddress: NATIVE_ASSET_ADDRESS,
            ...(opts.yieldTargets ? { yieldDepositTargets: opts.yieldTargets } : {}),
        });
    }

    function estimateParams(outputToken: Address = OUT): EstimateReshieldParams {
        return { relayerInfo: RELAYER_INFO, amount: BSC_AMOUNT, tokenId: VALID_TOKEN, outputToken };
    }

    async function prepareFromEstimate(service: PoolSessionReshield<PreparedTransaction>) {
        const estimate = await service.estimateReshieldAmount(estimateParams());
        const depositResult = {
            depositTx: { data: "0xabcdef" as Hex, to: VALID_ENTRYPOINT, value: "0x0" as Hex },
            approvalTx: null,
            pendingNote: { tokenId: OUT, value: estimate.noteValue, commitment: MOCK_COMMITMENT },
        } as unknown as PrepareDepositResult;
        const prepared = await service.prepareReshieldQuote({
            relayerInfo: RELAYER_INFO,
            amount: BSC_AMOUNT,
            tokenId: VALID_TOKEN,
            outputToken: OUT,
            depositResult,
            totalDepositCost: estimate.totalDepositCost,
        });
        return { estimate, prepared };
    }

    /** What the old estimate produced: 99% of the plain quote's floor, net of the vetting fee. */
    function legacyNoteValue(net: bigint): bigint {
        const safeMinOutput = (((net * 9_950n) / 10_000n) * 99n) / 100n;
        return (safeMinOutput * 10_000n) / (10_000n + VETTING_BPS);
    }

    beforeEach(() => {
        relayerInteractor = createMockRelayerInteractor();
    });

    it("shrinks the deposit when the executor route needs more input than the plain quote (BSC)", async () => {
        // The exact-output route costs 1.4% more than the plain quote implied: the old sizing
        // asks it for more than the net budget, which is what prod refused.
        const service = build({ routeCostPpm: 1_014_000n });
        const { estimate, prepared } = await prepareFromEstimate(service);

        expect(exactOut[0].fromAmount).toBeGreaterThan(BSC_NET);
        expect(BigInt(estimate.noteValue)).toBeLessThan(legacyNoteValue(BSC_NET));
        const input = BigInt(prepared.executorCall!.inputAmount);
        expect(input).toBeLessThanOrEqual(BSC_NET);
        expect(BSC_NET - input).toBeLessThanOrEqual((BSC_NET * 300n) / 10_000n);
        expect(BigInt(prepared.dustAmount)).toBe(BSC_NET - input);
    });

    it("grows the deposit when the executor route is cheaper than the dust tolerance allows", async () => {
        const service = build({ routeCostPpm: 960_000n });
        const { estimate, prepared } = await prepareFromEstimate(service);
        expect(BigInt(estimate.noteValue)).toBeGreaterThan(legacyNoteValue(BSC_NET));
        const input = BigInt(prepared.executorCall!.inputAmount);
        expect(input).toBeLessThanOrEqual(BSC_NET);
        expect(BSC_NET - input).toBeLessThanOrEqual((BSC_NET * 300n) / 10_000n);
    });

    it("keeps the plain sizing, with one route quote, when both quotes agree", async () => {
        const service = build({ routeCostPpm: 1_000_000n });
        const { estimate, prepared } = await prepareFromEstimate(service);
        expect(BigInt(estimate.noteValue)).toBe(legacyNoteValue(BSC_NET));
        // One route quote at estimate, one at prepare.
        expect(exactOut).toHaveLength(2);
        expect(BigInt(prepared.executorCall!.inputAmount)).toBeLessThanOrEqual(BSC_NET);
    });

    it("asks the route the same exact-output question prepare asks", async () => {
        const service = build({ routeCostPpm: 1_014_000n });
        await prepareFromEstimate(service);
        const calls = vi.mocked(swapQuoteProvider.getSwapQuote).mock.calls.map(([req]) => req);
        const routeCalls = calls.filter((req) => req.amountType === "to");
        const lastEstimate = routeCalls.at(-2)!;
        const atPrepare = routeCalls.at(-1)!;
        expect(lastEstimate).toEqual(atPrepare);
        expect(atPrepare).toMatchObject({ fromAddress: EXECUTOR, toAddress: EXECUTOR, toToken: OUT });
    });

    it("throws SwapRouteUnavailable at estimate when the aggregator has no exact-output route (Optimism)", async () => {
        const service = build({
            routeCostPpm: 1_000_000n,
            exactOutError: new Error("404 Unable to find quote to match expected output."),
        });
        const err = await service.estimateReshieldAmount(estimateParams()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SwapRouteUnavailable);
        expect((err as Error).message).toContain("Unable to find quote");
        expect(relayerInteractor.getSwapQuote).toHaveBeenCalledTimes(1); // the uncommitted fee quote only
    });

    it("composes the executor route at prepare when contract-calls has no route", async () => {
        const service = build({
            routeCostPpm: 1_005_000n,
            contractCallsError: new Error("404 Unable to find quote to match expected output."),
        });
        const { prepared } = await prepareFromEstimate(service);
        expect(prepared.swapTarget.toLowerCase()).toBe(EXECUTOR.toLowerCase());
        expect(BigInt(prepared.executorCall!.inputAmount)).toBeLessThanOrEqual(BSC_NET);
    });

    it("composes the executor route at prepare when the contract-calls route leaves dust over the tolerance", async () => {
        // LiFi's own route needs 10% less than the net: assertLifiBudget would refuse the dust.
        const service = build({ routeCostPpm: 1_005_000n, contractCallsFromAmount: (BSC_NET * 90n) / 100n });
        const { prepared } = await prepareFromEstimate(service);
        expect(prepared.swapTarget.toLowerCase()).toBe(EXECUTOR.toLowerCase());
        const input = BigInt(prepared.executorCall!.inputAmount);
        expect(input).toBeLessThanOrEqual(BSC_NET);
        expect(BSC_NET - input).toBeLessThanOrEqual((BSC_NET * 300n) / 10_000n);
    });

    it("sizes a yield-share output's budget against the executor route", async () => {
        const SHARE = "0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6" as Address;
        const UNDERLYING = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
        const sizeSharesForBudget = vi.fn(async (budget: bigint) => ({
            shares: budget / 2n,
            underlyingNeeded: budget - 10n,
            maxUnderlyingIn: budget,
            headroom: 1n,
        }));
        const target = toYieldSwapDepositTarget({
            chainId: POOL_CHAIN_ID,
            deployment: {
                ppRouter: "0xe76E793d776c1e207aD7a7fa7C57d27420d85110",
                zap: VALID_SWAP_TARGET,
                ppUSDC: SHARE,
                ppUSDCDecimals: 18,
                underlying: UNDERLYING,
                underlyingDecimals: 6,
                underlyingSymbol: "USDC",
            },
            deposit: { sizeSharesForBudget, prepareYieldDeposit: vi.fn() },
        } as unknown as YieldDepositTarget);
        const service = build({ routeCostPpm: 1_014_000n, yieldTargets: [target] });
        const estimate = await service.estimateReshieldAmount(estimateParams(SHARE));

        const budget = BigInt(estimate.totalDepositCost);
        expect(BigInt(estimate.noteValue)).toBe(budget / 2n);
        expect(sizeSharesForBudget.mock.calls.at(-1)![0]).toBe(budget);
        // The accepted budget is what the last route quote priced, and it fits the net.
        const accepted = exactOut.at(-1)!;
        expect(accepted.fromAmount).toBeLessThanOrEqual(BSC_NET);
        expect(BSC_NET - accepted.fromAmount).toBeLessThanOrEqual((BSC_NET * 300n) / 10_000n);
        const swapReq = vi.mocked(swapQuoteProvider.getSwapQuote).mock.calls.at(-1)![0];
        expect(swapReq.toToken.toLowerCase()).toBe(UNDERLYING.toLowerCase());
    });
});
