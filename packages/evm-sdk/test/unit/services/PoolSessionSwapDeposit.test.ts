import { ContractFunctionRevertedError, decodeFunctionData, encodeAbiParameters, encodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    IEntrypointInteractor,
    INoteManager,
    IPoolSessionDeposit,
    IPoolVaultInteractor,
    IRPCInteractor,
    ISwapAndDepositQuoteProvider,
    ISwapQuoteProvider,
    IWalletInteractor,
    PendingNote,
    PrepareDepositResult,
    PreparedTransaction,
    PrepareSwapAndDepositResult,
    ReadContractParams,
    Secret,
    SwapAndDepositParams,
    YieldDepositTarget,
} from "../../../src/internal.js";
import {
    AddressSchema,
    bigintToHex,
    DestinationDepositUnaffordable,
    EMPTY_ADDRESS,
    ERC20_APPROVE_ABI,
    EvmAddressEqualityComparator,
    EvmSwapChainAdapter,
    InvalidSwapAndDepositParams,
    InvalidTransactParams,
    LiFiDepositCalldataNotFound,
    LIFI_EXECUTOR_SCREENING_ABI,
    LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
    LiFiDepositTargetNotFound,
    NATIVE_ASSET_ADDRESS,
    NativeDestinationDepositUnsupported,
    NativeSwapDepositUnavailable,
    PoolSessionSwapDeposit,
    PoolSessionSwapDepositBaseError,
    PP_ROUTER_DEPOSIT_ABI,
    PP_ROUTER_DEPOSIT_NATIVE_ABI,
    RELAY_SWAP_ROUTING_TYPEHASH,
    RelaySwapsLayoutMismatch,
    SwapQuoteMismatch,
    toYieldSwapDepositTarget,
    UnallowedLiFiAddress,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";
import { encodeStargateMainLegCalldata } from "../helpers/stargateTestCalldata.js";

// --- Constants ---

const POOL_CHAIN_ID = 11155111;
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const ENTRYPOINT = "0x9999999999999999999999999999999999999991" as Address;
const INPUT_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const DEPOSIT_TOKEN = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const LIFI_ROUTER = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae" as Address;
const RELAY_SWAPS_ADDRESS = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;
// Embeds the ABI-padded ENTRYPOINT address and the deposit calldata body so that
// the byte containment check passes in happy-path tests.
const LIFI_TRANSACTION_DATA = ("0x" +
    "0000000000000000000000009999999999999999999999999999999999999991" + // ENTRYPOINT ABI-padded to 32 bytes
    "abcdef") as Hex; // deposit calldata body (0xabcdef → strip 0x prefix)
const DEPOSIT_AMOUNT = "0xf4240" as Hex; // 1_000_000
const FROM_AMOUNT = "999990"; // estimated input amount LiFi needs
const MOCK_COMMITMENT =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as Hash;
const MOCK_SECRET = "0x3333333333333333333333333333333333333333333333333333333333333333" as Secret;
const MOCK_TIMESTAMP = "0x64000000" as Hash;

/**
 * An attacker-built `Executor.swapAndExecute`: the first leg sends the pulled input tokens to
 * `attacker`; the second calls `attacker` with calldata (and an approveTo) that merely EMBED the
 * deposit bytes and the Entrypoint, so the byte-containment checks alone pass.
 */
function maliciousExecutorCalldata(attacker: Address, amount: bigint): Hex {
    return encodeFunctionData({
        abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
        functionName: "swapAndExecute",
        args: [
            `0x${"00".repeat(32)}`,
            [
                {
                    callTo: INPUT_TOKEN,
                    approveTo: INPUT_TOKEN,
                    sendingAssetId: INPUT_TOKEN,
                    receivingAssetId: INPUT_TOKEN,
                    fromAmount: 1n,
                    callData: encodeFunctionData({
                        abi: ERC20_TRANSFER_ABI,
                        functionName: "transfer",
                        args: [attacker, amount],
                    }),
                    requiresDeposit: false,
                },
                {
                    callTo: attacker,
                    approveTo: ENTRYPOINT,
                    sendingAssetId: INPUT_TOKEN,
                    receivingAssetId: INPUT_TOKEN,
                    fromAmount: 1n,
                    callData: "0xabcdef",
                    requiresDeposit: false,
                },
            ],
            INPUT_TOKEN,
            attacker,
            amount,
        ],
    });
}

const ERC20_TRANSFER_ABI = [
    {
        name: "transfer",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
] as const;

// --- Mock factories ---

function buildPendingNote(overrides?: Partial<PendingNote>): PendingNote {
    return {
        noteAddressHash: MOCK_COMMITMENT,
        commitment: MOCK_COMMITMENT,
        value: `0x${1_000_000n.toString(16)}` as Hex,
        tokenId: DEPOSIT_TOKEN,
        label: "0x1" as never,
        status: "PENDING" as never,
        ownerAddress: OWNER,
        noteSecret: MOCK_SECRET,
        isOwned: true,
        ...overrides,
    } as PendingNote;
}

function createMockDepositDelegate(pendingNote: PendingNote): IPoolSessionDeposit {
    return {
        prepareDeposit: vi.fn(
            async (): Promise<PrepareDepositResult> => ({
                pendingNote,
                depositTx: {
                    data: "0xabcdef" as Hex,
                    to: ENTRYPOINT,
                    value: "0x0" as Hex,
                },
                approvalTx: null,
                approvalTxs: [],
            }),
        ),
    } as unknown as IPoolSessionDeposit;
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
                fromAmount: FROM_AMOUNT,
                toAmount: "1000000",
                fromAmountUSD: "1.00",
                toAmountUSD: "1.00",
                approvalAddress: LIFI_ROUTER,
                transactionData: LIFI_TRANSACTION_DATA,
                transactionTo: LIFI_ROUTER,
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

function createMockEntrypointInteractor(allowance = "0x0"): IEntrypointInteractor {
    return {
        getAddress: vi.fn(() => ENTRYPOINT),
        getAllowance: vi.fn(async () => allowance as Hash),
        submitTransaction: vi.fn(async () => "0xtxhash" as Hex),
        // 100 BPS vetting fee — prepareSwapAndDeposit pads the LiFi quote amount
        // by this (Entrypoint pulls value + fee).
        getAssetConfig: vi.fn(async () => ({
            enabled: true,
            minAmount: "0x1" as Hex,
            vettingFeeBPS: "0x64" as Hex,
            maxRelayFee: "0xffffffffffffffff" as Hex,
        })),
    } as unknown as IEntrypointInteractor;
}

function createMockRPCInteractor(): IRPCInteractor {
    return {
        // Allowance reads return 0n (insufficient, so an approval is built by default);
        // ROUTING_TYPEHASH matches the SDK; every other allowlist read is approved by default.
        readContract: vi.fn(async ({ functionName }: ReadContractParams) => {
            if (functionName === "allowance") return 0n;
            return functionName === "ROUTING_TYPEHASH" ? RELAY_SWAP_ROUTING_TYPEHASH : true;
        }),
        getBlockNumber: vi.fn(),
        waitForTransactionReceipt: vi.fn(async () => ({
            status: true,
            blockNumber: "0x1" as Hex,
            txHash: "0xtxhash" as Hex,
            logs: [],
        })),
        getLogs: vi.fn(),
        getLogsPaginated: vi.fn(),
    } as unknown as IRPCInteractor;
}

function createMockNoteManager(): INoteManager {
    return {
        addNote: vi.fn(),
    } as unknown as INoteManager;
}

function createMockPoolVaultInteractor(timestamp: Hash = MOCK_TIMESTAMP): IPoolVaultInteractor {
    return {
        getCommitmentTimestamp: vi.fn(async () => timestamp),
    } as unknown as IPoolVaultInteractor;
}

// --- Tests ---

describe("PoolSessionSwapDeposit", () => {
    let depositDelegate: IPoolSessionDeposit;
    let swapAndDepositQuoteProvider: ISwapAndDepositQuoteProvider;
    let entrypointInteractor: IEntrypointInteractor;
    let rpcInteractor: IRPCInteractor;
    let noteManager: INoteManager;
    let poolVaultInteractor: IPoolVaultInteractor;
    let pendingNote: PendingNote;
    let service: PoolSessionSwapDeposit<PreparedTransaction>;

    function buildService(): void {
        service = new PoolSessionSwapDeposit({
            ownerAddress: OWNER,
            chainId: POOL_CHAIN_ID,
            depositDelegate,
            swapAndDepositQuoteProvider,
            entrypointInteractor,
            rpcInteractor,
            noteManager,
            poolVaultInteractor,
            relaySwapsAddress: RELAY_SWAPS_ADDRESS,
            nativeAssetAddress: NATIVE_ASSET_ADDRESS,
            emptyAddress: EMPTY_ADDRESS,
            addressEqualityComparator: new EvmAddressEqualityComparator(),
            addressSchema: AddressSchema,
            swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
        });
    }

    function baseParams(overrides?: Partial<SwapAndDepositParams>): SwapAndDepositParams {
        return {
            fromChainId: POOL_CHAIN_ID,
            inputToken: INPUT_TOKEN,
            depositToken: DEPOSIT_TOKEN,
            depositAmount: DEPOSIT_AMOUNT,
            ...overrides,
        };
    }

    beforeEach(() => {
        pendingNote = buildPendingNote();
        depositDelegate = createMockDepositDelegate(pendingNote);
        swapAndDepositQuoteProvider = createMockSwapAndDepositQuoteProvider();
        entrypointInteractor = createMockEntrypointInteractor();
        rpcInteractor = createMockRPCInteractor();
        noteManager = createMockNoteManager();
        poolVaultInteractor = createMockPoolVaultInteractor();
        buildService();
    });

    describe("prepareSwapAndDeposit", () => {
        it("prepare a swap-and-deposit echoing the LiFi tx and approval fields", async () => {
            const result = await service.prepareSwapAndDeposit(baseParams());

            expect(result.pendingNote).toBe(pendingNote);
            expect(result.inputToken).toBe(INPUT_TOKEN);
            expect(result.estimatedInputAmount).toBe(bigintToHex(BigInt(FROM_AMOUNT)));
            expect(result.approvalAddress).toBe(LIFI_ROUTER);
            expect(result.transactionData).toBe(LIFI_TRANSACTION_DATA);
            expect(result.transactionTo).toBe(LIFI_ROUTER);
            expect(result.msgValue).toBe("0x0");
            expect(result.estimatedDuration).toBe(30);
        });

        it("forward the deposit calldata and echo tokens/chains into the quote request", async () => {
            await service.prepareSwapAndDeposit(baseParams());

            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(req.fromChainId).toBe(POOL_CHAIN_ID);
            expect(req.toChainId).toBe(POOL_CHAIN_ID);
            expect(req.fromToken).toBe(INPUT_TOKEN);
            expect(req.toToken).toBe(DEPOSIT_TOKEN);
            expect(req.fromAddress).toBe(OWNER);
            expect(req.poolAddress).toBe(ENTRYPOINT);
            expect(req.depositCalldata).toBe("0xabcdef");
            // depositAmount is padded by the 100-BPS vetting fee: the Entrypoint pulls
            // value + fee, so LiFi must deliver the total (1_000_000 + 1% = 1_010_000).
            const total = BigInt(DEPOSIT_AMOUNT) + (BigInt(DEPOSIT_AMOUNT) * 100n) / 10_000n;
            expect(req.depositAmount).toBe(total.toString());
        });

        it("build an ERC-20 approval to the LiFi router when allowance is insufficient", async () => {
            const result = await service.prepareSwapAndDeposit(baseParams());

            expect(result.approvalTx).not.toBeNull();
            expect(result.approvalTx!.to).toBe(INPUT_TOKEN);
            const { functionName, args } = decodeFunctionData({
                abi: ERC20_APPROVE_ABI,
                data: result.approvalTx!.data,
            });
            expect(functionName).toBe("approve");
            expect((args[0] as Address).toLowerCase()).toBe(LIFI_ROUTER.toLowerCase());
            expect(args[1]).toBe(BigInt(FROM_AMOUNT));
        });

        it("plan approve(0) then approve(amount) when a non-zero allowance is too small (mainnet USDT)", async () => {
            rpcInteractor = {
                ...rpcInteractor,
                readContract: vi.fn(async ({ functionName }: ReadContractParams) => {
                    if (functionName === "allowance") return 1n;
                    return functionName === "ROUTING_TYPEHASH" ? RELAY_SWAP_ROUTING_TYPEHASH : true;
                }),
            };
            buildService();

            const result = await service.prepareSwapAndDeposit(baseParams());

            expect(result.approvalTxs).toHaveLength(2);
            const amounts = result.approvalTxs.map(
                (tx) => decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: tx.data }).args[1],
            );
            expect(amounts[0]).toBe(0n);
            expect(amounts[1]).toBe(BigInt(FROM_AMOUNT));
            expect(result.approvalTx).toBe(result.approvalTxs[1]);
        });

        it("skip the approval tx when the existing allowance already covers the input amount", async () => {
            rpcInteractor = {
                ...rpcInteractor,
                readContract: vi.fn(async ({ functionName }: ReadContractParams) => {
                    if (functionName === "allowance") return BigInt(FROM_AMOUNT) + 1n;
                    return functionName === "ROUTING_TYPEHASH" ? RELAY_SWAP_ROUTING_TYPEHASH : true;
                }),
            };
            buildService();

            const result = await service.prepareSwapAndDeposit(baseParams());
            expect(result.approvalTx).toBeNull();
        });

        it("return no approval tx for a native input token", async () => {
            const result = await service.prepareSwapAndDeposit(
                baseParams({ inputToken: NATIVE_ASSET_ADDRESS }),
            );

            expect(result.approvalTx).toBeNull();
            expect(vi.mocked(rpcInteractor.readContract)).not.toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "allowance" }),
            );
        });

        // A buggy/compromised quote provider that routes somewhere other than requested
        // must be rejected before anything is signed — otherwise the deposit could land
        // in a live but unintended pool (same Entrypoint address on every chain).
        function mockQuoteRoutingOverride(override: {
            fromChainId?: number;
            toChainId?: number;
            fromTokenAddress?: Address;
            toTokenAddress?: Address;
        }): void {
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: {
                    fromToken: Address;
                    toToken: Address;
                    fromChainId: number;
                    toChainId: number;
                }) =>
                    ({
                        fromAmount: FROM_AMOUNT,
                        toAmount: "1000000",
                        fromAmountUSD: "1.00",
                        toAmountUSD: "1.00",
                        approvalAddress: LIFI_ROUTER,
                        transactionData: LIFI_TRANSACTION_DATA,
                        transactionTo: LIFI_ROUTER,
                        transactionValue: "0x0" as Hex,
                        estimatedDuration: 30,
                        fromTokenAddress: override.fromTokenAddress ?? req.fromToken,
                        toTokenAddress: override.toTokenAddress ?? req.toToken,
                        fromChainId: override.fromChainId ?? req.fromChainId,
                        toChainId: override.toChainId ?? req.toChainId,
                    }) as never,
            );
            buildService();
        }

        it("ignore inputAmount on a same-chain swap: exact-out solves there and surplus must stay with the payer", async () => {
            await service.prepareSwapAndDeposit(
                baseParams({ inputAmount: "0x38d7ea4c68000" as Hex }),
            );

            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(req.netFromAmount).toBeUndefined();
        });

        it("leave the deposit gas budget to the provider default on a same-chain swap (no compose leg)", async () => {
            await service.prepareSwapAndDeposit(baseParams());

            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(req.depositGasLimit).toBeUndefined();
        });

        it("throw SwapQuoteMismatch when LiFi routes a different toChainId than requested", async () => {
            mockQuoteRoutingOverride({ toChainId: 8453 });

            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                SwapQuoteMismatch,
            );
        });

        it("throw SwapQuoteMismatch when LiFi routes a different fromChainId than requested", async () => {
            mockQuoteRoutingOverride({ fromChainId: 8453 });

            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                SwapQuoteMismatch,
            );
        });

        it("throw SwapQuoteMismatch when LiFi routes a different toToken than requested", async () => {
            mockQuoteRoutingOverride({
                toTokenAddress: "0x9999999999999999999999999999999999999999" as Address,
            });

            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                SwapQuoteMismatch,
            );
        });

        it("accept LiFi echoing the zero address for a native input token", async () => {
            // Paying a swap-deposit with ETH: the request names 0xEeee…, LiFi echoes
            // 0x0000…. Same asset, two spellings — not a routing mismatch.
            mockQuoteRoutingOverride({ fromTokenAddress: EMPTY_ADDRESS });

            const outcome = await service
                .prepareSwapAndDeposit(baseParams({ inputToken: NATIVE_ASSET_ADDRESS }))
                .then(
                    () => null,
                    (error: unknown) => error,
                );
            expect(outcome).not.toBeInstanceOf(SwapQuoteMismatch);
        });

        it("throw SwapQuoteMismatch when LiFi routes a different fromToken than requested", async () => {
            mockQuoteRoutingOverride({
                fromTokenAddress: "0x9999999999999999999999999999999999999999" as Address,
            });

            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                SwapQuoteMismatch,
            );
        });

        it("throw InvalidSwapAndDepositParams for a cross-chain fromChainId", async () => {
            await expect(
                service.prepareSwapAndDeposit(baseParams({ fromChainId: POOL_CHAIN_ID + 1 })),
            ).rejects.toThrow(InvalidSwapAndDepositParams);
            // Rejected before any deposit-proof or quote work.
            expect(vi.mocked(depositDelegate.prepareDeposit)).not.toHaveBeenCalled();
        });

        it("throw InvalidSwapAndDepositParams when params fail schema validation", async () => {
            await expect(
                service.prepareSwapAndDeposit(baseParams({ inputToken: "0x123" as Address })),
            ).rejects.toThrow(InvalidSwapAndDepositParams);
            expect(vi.mocked(depositDelegate.prepareDeposit)).not.toHaveBeenCalled();
        });

        it("throw RelaySwapsLayoutMismatch when the target RelaySwaps reports a different ROUTING_TYPEHASH", async () => {
            const STALE_TYPEHASH = `0x${"aa".repeat(32)}` as Hex;
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName }: ReadContractParams) =>
                    functionName === "ROUTING_TYPEHASH" ? STALE_TYPEHASH : true,
            );

            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                RelaySwapsLayoutMismatch,
            );
        });

        it("throw UnallowedLiFiAddress when transactionTo is not in RelaySwaps.approvedRouters", async () => {
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName }: ReadContractParams) =>
                    functionName === "ROUTING_TYPEHASH" ? RELAY_SWAP_ROUTING_TYPEHASH : false,
            );

            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                UnallowedLiFiAddress,
            );
        });

        it("throw UnallowedLiFiAddress when approvalAddress is not in RelaySwaps.approvedRouters", async () => {
            // Use a distinct approvalAddress so it gets its own cache entry and RPC call.
            const DISTINCT_APPROVAL = "0x2222222222222222222222222222222222222222" as Address;
            const providerWithDistinctApproval = {
                getSwapAndDepositQuote: vi.fn(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                    }) => ({
                        fromAmount: FROM_AMOUNT,
                        toAmount: "1000000",
                        fromAmountUSD: "1.00",
                        toAmountUSD: "1.00",
                        approvalAddress: DISTINCT_APPROVAL,
                        transactionData: LIFI_TRANSACTION_DATA,
                        transactionTo: LIFI_ROUTER,
                        transactionValue: "0x0" as Hex,
                        estimatedDuration: 30,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    }),
                ),
            } as unknown as ISwapAndDepositQuoteProvider;
            service = new PoolSessionSwapDeposit({
                ownerAddress: OWNER,
                chainId: POOL_CHAIN_ID,
                depositDelegate,
                swapAndDepositQuoteProvider: providerWithDistinctApproval,
                entrypointInteractor,
                rpcInteractor,
                noteManager,
                poolVaultInteractor,
                relaySwapsAddress: RELAY_SWAPS_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                emptyAddress: EMPTY_ADDRESS,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                addressSchema: AddressSchema,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
            });
            let approvedRoutersCalls = 0;
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName }: ReadContractParams) => {
                    if (functionName === "ROUTING_TYPEHASH") return RELAY_SWAP_ROUTING_TYPEHASH;
                    approvedRoutersCalls += 1;
                    return approvedRoutersCalls === 1; // transactionTo passes, approvalAddress fails
                },
            );

            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                UnallowedLiFiAddress,
            );
        });

        it("throw LiFiDepositCalldataNotFound when transactionData omits the deposit calldata", async () => {
            // transactionData has the ABI-padded Entrypoint but NOT the deposit calldata bytes.
            // Simulates a compromised quote that swapped out the Entrypoint.deposit() call.
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockResolvedValueOnce({
                fromAmount: FROM_AMOUNT,
                toAmount: "1000000",
                fromAmountUSD: "1.00",
                toAmountUSD: "1.00",
                approvalAddress: LIFI_ROUTER,
                transactionData:
                    "0x0000000000000000000000009999999999999999999999999999999999999991" as Hex,
                transactionTo: LIFI_ROUTER,
                transactionValue: "0x0" as Hex,
                estimatedDuration: 30,
                fromTokenAddress: INPUT_TOKEN,
                toTokenAddress: DEPOSIT_TOKEN,
                fromChainId: POOL_CHAIN_ID,
                toChainId: POOL_CHAIN_ID,
            } as never);

            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                LiFiDepositCalldataNotFound,
            );
        });

        it("throw LiFiDepositTargetNotFound when transactionData omits the Entrypoint address", async () => {
            // transactionData has the deposit calldata bytes but NOT the ABI-padded Entrypoint.
            // Simulates a compromised quote that routes the swap output to an attacker contract.
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockResolvedValueOnce({
                fromAmount: FROM_AMOUNT,
                toAmount: "1000000",
                fromAmountUSD: "1.00",
                toAmountUSD: "1.00",
                approvalAddress: LIFI_ROUTER,
                transactionData: "0xabcdef" as Hex,
                transactionTo: LIFI_ROUTER,
                transactionValue: "0x0" as Hex,
                estimatedDuration: 30,
                fromTokenAddress: INPUT_TOKEN,
                toTokenAddress: DEPOSIT_TOKEN,
                fromChainId: POOL_CHAIN_ID,
                toChainId: POOL_CHAIN_ID,
            } as never);

            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                LiFiDepositTargetNotFound,
            );
        });
    });

    describe("same-chain native deposit", () => {
        const EXECUTOR = "0x2dfaDAB8266483beD9Fd9A292Ce56596a2D1378D" as Address;
        const ERC20_PROXY = "0x5741A7FfE7c39Ca175546a54985fA79211290b51" as Address;
        const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address;
        // Note value 1_000_000 plus the mock's 100 bps vetting fee.
        const DEPOSIT_COST = 1_010_000n;
        // DEPOSIT_COST grossed up by 0.5% slippage + 0.1% margin, rounded up:
        // ceil(1_010_000 * 10_000 / 9_940).
        const SWAP_OUTPUT_TARGET = 1_016_097n;
        const INPUT_AMOUNT = 1_234_567n;
        const ATTACKER = "0x6666666666666666666666666666666666666666" as Address;
        // An ordinary LiFi swap whose calldata pays the executor (its receiver argument).
        const SWAP_CALLDATA = ("0x2c57e884" +
            encodeAbiParameters([{ type: "address" }], [EXECUTOR]).slice(2) +
            "ab".repeat(96)) as Hex;

        let swapQuoteProvider: ISwapQuoteProvider;

        function quoteWith(overrides: Record<string, unknown> = {}): void {
            swapQuoteProvider = {
                getSwapQuote: vi.fn(async () => ({
                    fromAmount: INPUT_AMOUNT.toString(),
                    toAmount: (DEPOSIT_COST + 9_000n).toString(),
                    toAmountMin: (DEPOSIT_COST + 50n).toString(),
                    approvalAddress: DIAMOND,
                    transactionData: SWAP_CALLDATA,
                    transactionTo: DIAMOND,
                    estimatedDuration: 20,
                    fromTokenAddress: INPUT_TOKEN,
                    toTokenAddress: NATIVE_ASSET_ADDRESS,
                    fromChainId: POOL_CHAIN_ID,
                    toChainId: POOL_CHAIN_ID,
                    ...overrides,
                })),
                getSwapStatus: vi.fn(),
            } as unknown as ISwapQuoteProvider;
        }

        function buildNativeService(
            executor: { executor: Address; erc20Proxy: Address } | null = {
                executor: EXECUTOR,
                erc20Proxy: ERC20_PROXY,
            },
        ): void {
            service = new PoolSessionSwapDeposit({
                ownerAddress: OWNER,
                chainId: POOL_CHAIN_ID,
                depositDelegate,
                swapAndDepositQuoteProvider,
                swapQuoteProvider,
                swapExecutor: executor ?? undefined,
                entrypointInteractor,
                rpcInteractor,
                noteManager,
                poolVaultInteractor,
                relaySwapsAddress: RELAY_SWAPS_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                emptyAddress: EMPTY_ADDRESS,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                addressSchema: AddressSchema,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
            });
        }

        const nativeParams = () => baseParams({ depositToken: NATIVE_ASSET_ADDRESS });

        beforeEach(() => {
            // A native deposit note is denominated in the native coin: execute derives the
            // executor output token from it.
            pendingNote = buildPendingNote({ tokenId: NATIVE_ASSET_ADDRESS });
            // A native deposit's msg.value is its exact cost (PoolSessionDeposit.computeMsgValue).
            vi.mocked(depositDelegate.prepareDeposit).mockImplementation(async () => ({
                pendingNote,
                depositTx: { data: "0xabcdef" as Hex, to: ENTRYPOINT, value: bigintToHex(DEPOSIT_COST) },
                approvalTx: null,
                approvalTxs: [],
            }));
            quoteWith();
            buildNativeService();
        });

        it("compose one executor call: LiFi's swap unchanged, then the deposit sent exactly its cost", async () => {
            const result = await service.prepareSwapAndDeposit(nativeParams());

            expect(result.transactionTo).toBe(EXECUTOR);
            expect(result.approvalAddress).toBe(ERC20_PROXY);
            expect(result.msgValue).toBe("0x0");
            expect(result.estimatedInputAmount).toBe(bigintToHex(INPUT_AMOUNT));
            const { args } = decodeFunctionData({
                abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
                data: result.transactionData,
            });
            const [, swaps, transferredAsset, receiver, amount] = args;
            expect(transferredAsset.toLowerCase()).toBe(INPUT_TOKEN);
            expect(receiver.toLowerCase()).toBe(OWNER);
            expect(amount).toBe(INPUT_AMOUNT);
            expect(swaps).toHaveLength(2);
            expect(swaps[0]).toMatchObject({
                callTo: DIAMOND,
                approveTo: DIAMOND,
                fromAmount: INPUT_AMOUNT,
                callData: SWAP_CALLDATA,
                requiresDeposit: false,
            });
            expect(swaps[0].sendingAssetId.toLowerCase()).toBe(INPUT_TOKEN);
            expect(swaps[0].receivingAssetId).toBe(EMPTY_ADDRESS);
            expect(swaps[1].callTo.toLowerCase()).toBe(ENTRYPOINT);
            expect(swaps[1].callData).toBe("0xabcdef");
            expect(swaps[1].fromAmount).toBe(DEPOSIT_COST);
            expect(swaps[1].sendingAssetId).toBe(EMPTY_ADDRESS);
            expect(swaps[1].receivingAssetId).toBe(EMPTY_ADDRESS);
        });

        it("quote an ordinary exact-out swap paid to the executor, never a contract-calls quote", async () => {
            await service.prepareSwapAndDeposit(nativeParams());
            expect(vi.mocked(swapQuoteProvider.getSwapQuote)).toHaveBeenCalledWith({
                fromChainId: POOL_CHAIN_ID,
                toChainId: POOL_CHAIN_ID,
                fromToken: INPUT_TOKEN,
                toToken: NATIVE_ASSET_ADDRESS,
                fromAddress: EXECUTOR,
                toAddress: EXECUTOR,
                amount: SWAP_OUTPUT_TARGET.toString(),
                amountType: "to",
                slippage: 0.005,
            });
            expect(vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote)).not.toHaveBeenCalled();
        });

        it("approve the executor's ERC20Proxy, never the swap's own approval address", async () => {
            const result = await service.prepareSwapAndDeposit(nativeParams());
            const approval = result.approvalTxs.at(-1)!;
            const { args } = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: approval.data });
            expect(approval.to.toLowerCase()).toBe(INPUT_TOKEN);
            expect(args).toEqual([ERC20_PROXY, INPUT_AMOUNT]);
        });

        it("refuse a swap whose guaranteed output is below the deposit cost", async () => {
            quoteWith({ toAmountMin: (DEPOSIT_COST - 1n).toString() });
            buildNativeService();
            await expect(service.prepareSwapAndDeposit(nativeParams())).rejects.toThrow(
                NativeSwapDepositUnavailable,
            );
        });

        it("accept LiFi's default 0.5% minimum output on the slippage-padded exact-out quote", async () => {
            vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementation(async (req) => ({
                fromAmount: INPUT_AMOUNT.toString(),
                toAmount: req.amount,
                toAmountMin: ((BigInt(req.amount) * 9_950n) / 10_000n).toString(),
                approvalAddress: DIAMOND,
                transactionData: SWAP_CALLDATA,
                transactionTo: DIAMOND,
                estimatedDuration: 20,
                fromTokenAddress: INPUT_TOKEN,
                toTokenAddress: NATIVE_ASSET_ADDRESS,
                fromChainId: POOL_CHAIN_ID,
                toChainId: POOL_CHAIN_ID,
            }));

            const result = await service.prepareSwapAndDeposit(nativeParams());
            expect(result.transactionTo).toBe(EXECUTOR);
        });

        it("refuse a swap that does not pay the executor", async () => {
            quoteWith({ transactionData: ("0x2c57e884" + "ab".repeat(128)) as Hex });
            buildNativeService();
            await expect(service.prepareSwapAndDeposit(nativeParams())).rejects.toThrow(
                NativeSwapDepositUnavailable,
            );
        });

        it("refuse a quote that routes another output token", async () => {
            quoteWith({ toTokenAddress: DEPOSIT_TOKEN });
            buildNativeService();
            await expect(service.prepareSwapAndDeposit(nativeParams())).rejects.toThrow(SwapQuoteMismatch);
        });

        it("refuse a swap target outside RelaySwaps.approvedRouters", async () => {
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName, args }: ReadContractParams) => {
                    if (functionName === "ROUTING_TYPEHASH") return RELAY_SWAP_ROUTING_TYPEHASH;
                    if (functionName === "allowance") return 0n;
                    return String(args?.[0]).toLowerCase() !== DIAMOND.toLowerCase();
                },
            );
            await expect(service.prepareSwapAndDeposit(nativeParams())).rejects.toThrow(UnallowedLiFiAddress);
        });

        it("refuse when the chain has no configured executor", async () => {
            buildNativeService(null);
            await expect(service.prepareSwapAndDeposit(nativeParams())).rejects.toThrow(
                NativeSwapDepositUnavailable,
            );
            expect(vi.mocked(swapQuoteProvider.getSwapQuote)).not.toHaveBeenCalled();
        });

        it("submit the composed call and re-validate it at execute", async () => {
            await service.swapAndDeposit(nativeParams());
            const submitted = vi.mocked(entrypointInteractor.submitTransaction).mock.calls.at(-1)![0];
            expect(submitted.to).toBe(EXECUTOR);
            const { args } = decodeFunctionData({
                abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
                data: submitted.data,
            });
            expect(args[1][1].fromAmount).toBe(DEPOSIT_COST);
        });

        it("reject a tampered deposit callTo even when approveTo still embeds Entrypoint", async () => {
            const result = await service.prepareSwapAndDeposit(nativeParams());
            const { args } = decodeFunctionData({
                abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
                data: result.transactionData,
            });
            const tampered: PrepareSwapAndDepositResult = {
                ...result,
                transactionData: encodeFunctionData({
                    abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
                    functionName: "swapAndExecute",
                    args: [
                        args[0],
                        [args[1][0], { ...args[1][1], callTo: ATTACKER }],
                        args[2],
                        args[3],
                        args[4],
                    ],
                }),
            };
            const adapter = new EvmSwapChainAdapter({ rpcInteractor });
            expect(adapter.isAddressEmbeddedInCalldata(tampered.transactionData, ENTRYPOINT)).toBe(true);
            expect(tampered.transactionData.toLowerCase()).toContain(
                result.depositCallData.slice(2).toLowerCase(),
            );
            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        it("reject a tampered executor receiver", async () => {
            const result = await service.prepareSwapAndDeposit(nativeParams());
            const adapter = new EvmSwapChainAdapter({ rpcInteractor });
            const decoded = adapter.decodeSwapThenCall(result.transactionData);
            if (!decoded) throw new Error("Genuine executor call did not decode");
            const tampered = {
                ...result,
                transactionData: adapter.encodeSwapThenCall({ ...decoded, receiver: ATTACKER }),
            };
            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        it("reject a swap-leg target outside the router allowlist at execute", async () => {
            const result = await service.prepareSwapAndDeposit(nativeParams());
            const adapter = new EvmSwapChainAdapter({ rpcInteractor });
            const decoded = adapter.decodeSwapThenCall(result.transactionData);
            if (!decoded) throw new Error("Genuine executor call did not decode");
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName, args }: ReadContractParams) => {
                    if (functionName === "ROUTING_TYPEHASH") return RELAY_SWAP_ROUTING_TYPEHASH;
                    if (functionName === "allowance") return 0n;
                    return String(args?.[0]).toLowerCase() !== ATTACKER.toLowerCase();
                },
            );
            const tampered = {
                ...result,
                transactionData: adapter.encodeSwapThenCall({ ...decoded, swapTarget: ATTACKER }),
            };
            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(UnallowedLiFiAddress);
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        it("reject a tampered executor approvalAddress even when it is allowlisted", async () => {
            const result = await service.prepareSwapAndDeposit(nativeParams());
            const tampered = { ...result, approvalAddress: DIAMOND, approvalTxs: [], approvalTx: null };
            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        it("reject a tampered executor deposit value", async () => {
            const result = await service.prepareSwapAndDeposit(nativeParams());
            const adapter = new EvmSwapChainAdapter({ rpcInteractor });
            const decoded = adapter.decodeSwapThenCall(result.transactionData);
            if (!decoded) throw new Error("Genuine executor call did not decode");
            const tampered = {
                ...result,
                transactionData: adapter.encodeSwapThenCall({ ...decoded, callValue: DEPOSIT_COST - 1n }),
            };
            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        it("reject native value attached to the executor transaction", async () => {
            const result = await service.prepareSwapAndDeposit(nativeParams());
            await expect(
                service.executeSwapAndDeposit({ ...result, msgValue: "0x1" as Hex }),
            ).rejects.toThrow(UnexpectedTransactionTarget);
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        function contractCallsQuoteWith(overrides: Record<string, unknown>): void {
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req) =>
                    ({
                        fromAmount: FROM_AMOUNT,
                        toAmount: "1000000",
                        approvalAddress: LIFI_ROUTER,
                        transactionData: LIFI_TRANSACTION_DATA,
                        transactionTo: LIFI_ROUTER,
                        transactionValue: "0x0" as Hex,
                        estimatedDuration: 30,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                        ...overrides,
                    }) as never,
            );
        }

        it("reject an executor payload that only embeds the deposit, when no executor is configured", async () => {
            buildNativeService(null);
            contractCallsQuoteWith({
                transactionTo: EXECUTOR,
                approvalAddress: ERC20_PROXY,
                transactionData: maliciousExecutorCalldata(ATTACKER, BigInt(FROM_AMOUNT)),
            });
            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
        });

        // DEV-489: with the executor configured, an executor payload from the contract-calls route
        // is never signed and never refused either. The session throws it away and composes the
        // deposit itself from an ordinary swap quote, so nothing the aggregator put in that payload
        // (here an attacker transfer) can reach the transaction.
        describe("an executor payload on the contract-calls route", () => {
            function erc20DepositOnTheExecutorRoute(inputToken: Address = INPUT_TOKEN): void {
                pendingNote = buildPendingNote();
                // An ERC-20 deposit's call carries no native value.
                vi.mocked(depositDelegate.prepareDeposit).mockImplementation(async () => ({
                    pendingNote,
                    depositTx: { data: "0xabcdef" as Hex, to: ENTRYPOINT, value: "0x0" as Hex },
                    approvalTx: null,
                    approvalTxs: [],
                }));
                contractCallsQuoteWith({
                    transactionTo: EXECUTOR,
                    approvalAddress: ERC20_PROXY,
                    transactionData: maliciousExecutorCalldata(ATTACKER, BigInt(FROM_AMOUNT)),
                });
                quoteWith({ fromTokenAddress: inputToken, toTokenAddress: DEPOSIT_TOKEN });
                buildNativeService();
            }

            it("is discarded: the deposit is composed from an ordinary swap into the deposit token", async () => {
                erc20DepositOnTheExecutorRoute();
                const result = await service.prepareSwapAndDeposit(baseParams());

                expect(result.transactionTo).toBe(EXECUTOR);
                expect(result.transactionData.toLowerCase()).not.toContain(ATTACKER.slice(2).toLowerCase());
                expect(vi.mocked(swapQuoteProvider.getSwapQuote)).toHaveBeenCalledWith(
                    expect.objectContaining({
                        fromToken: INPUT_TOKEN,
                        toToken: DEPOSIT_TOKEN,
                        fromAddress: EXECUTOR,
                        toAddress: EXECUTOR,
                        amountType: "to",
                        amount: SWAP_OUTPUT_TARGET.toString(),
                    }),
                );
                const { args } = decodeFunctionData({
                    abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
                    data: result.transactionData,
                });
                const [, swaps, transferredAsset, receiver] = args;
                expect(receiver.toLowerCase()).toBe(OWNER);
                expect(transferredAsset.toLowerCase()).toBe(INPUT_TOKEN);
                expect(swaps[0].receivingAssetId.toLowerCase()).toBe(DEPOSIT_TOKEN);
                // The deposit call spends the deposit token through an executor approval, with no value.
                expect(swaps[1].callTo.toLowerCase()).toBe(ENTRYPOINT);
                expect(swaps[1].approveTo.toLowerCase()).toBe(ENTRYPOINT);
                expect(swaps[1].sendingAssetId.toLowerCase()).toBe(DEPOSIT_TOKEN);
                expect(swaps[1].fromAmount).toBe(DEPOSIT_COST);
                expect(result.msgValue).toBe("0x0");
                expect(result.approvalAddress).toBe(ERC20_PROXY);
            });

            // #473 review: the ERC-20 branch pins the call's amount exactly, not "non-zero".
            it("reject a tampered ERC-20 deposit amount at execute", async () => {
                erc20DepositOnTheExecutorRoute();
                const result = await service.prepareSwapAndDeposit(baseParams());
                const adapter = new EvmSwapChainAdapter({ rpcInteractor });
                const decoded = adapter.decodeSwapThenCall(result.transactionData);
                if (!decoded) throw new Error("Genuine executor call did not decode");
                for (const callValue of [DEPOSIT_COST - 1n, DEPOSIT_COST + 1n]) {
                    const tampered = {
                        ...result,
                        transactionData: adapter.encodeSwapThenCall({ ...decoded, callValue }),
                    };
                    await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(/deposit call is handed/);
                }
                expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
            });

            it("reject an ERC-20 deposit amount tampered together with depositCallValue: the Entrypoint cost anchors it", async () => {
                erc20DepositOnTheExecutorRoute();
                const result = await service.prepareSwapAndDeposit(baseParams());
                const adapter = new EvmSwapChainAdapter({ rpcInteractor });
                const decoded = adapter.decodeSwapThenCall(result.transactionData);
                if (!decoded) throw new Error("Genuine executor call did not decode");
                const tampered = {
                    ...result,
                    transactionData: adapter.encodeSwapThenCall({ ...decoded, callValue: DEPOSIT_COST + 1n }),
                    depositCallValue: bigintToHex(DEPOSIT_COST + 1n),
                };
                await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(/does not match the deposit cost/);
                expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
            });

            it("reject an ERC-20 executor result that does not name the deposit amount", async () => {
                erc20DepositOnTheExecutorRoute();
                const result = await service.prepareSwapAndDeposit(baseParams());
                await expect(
                    service.executeSwapAndDeposit({ ...result, depositCallValue: undefined }),
                ).rejects.toThrow(UnexpectedTransactionTarget);
                expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
            });

            it("reject a tampered executor output token", async () => {
                erc20DepositOnTheExecutorRoute();
                const result = await service.prepareSwapAndDeposit(baseParams());
                const adapter = new EvmSwapChainAdapter({ rpcInteractor });
                const decoded = adapter.decodeSwapThenCall(result.transactionData);
                if (!decoded) throw new Error("Genuine executor call did not decode");
                const tampered = {
                    ...result,
                    transactionData: adapter.encodeSwapThenCall({ ...decoded, outputToken: ATTACKER }),
                };
                await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(UnexpectedTransactionTarget);
                expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
            });

            it("with a native input: the input is the transaction's value, and nothing is approved", async () => {
                erc20DepositOnTheExecutorRoute(NATIVE_ASSET_ADDRESS);
                const result = await service.prepareSwapAndDeposit(
                    baseParams({ inputToken: NATIVE_ASSET_ADDRESS }),
                );

                expect(result.msgValue).toBe(bigintToHex(INPUT_AMOUNT));
                expect(result.approvalTxs).toEqual([]);
                expect(result.approvalTx).toBeNull();
                const { args } = decodeFunctionData({
                    abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
                    data: result.transactionData,
                });
                const [, swaps, transferredAsset, receiver, amount] = args;
                expect(transferredAsset).toBe(EMPTY_ADDRESS);
                expect(swaps[0].sendingAssetId).toBe(EMPTY_ADDRESS);
                expect(swaps[0].fromAmount).toBe(INPUT_AMOUNT);
                expect(amount).toBe(INPUT_AMOUNT);
                expect(receiver.toLowerCase()).toBe(OWNER);

                // It executes as prepared: one transaction, carrying exactly the input.
                await service.executeSwapAndDeposit(result);
                expect(vi.mocked(entrypointInteractor.submitTransaction)).toHaveBeenCalledTimes(1);
                expect(vi.mocked(entrypointInteractor.submitTransaction)).toHaveBeenCalledWith(
                    expect.objectContaining({ to: EXECUTOR, value: bigintToHex(INPUT_AMOUNT) }),
                );
            });

            it("with a native input: any other value on the transaction is refused before signing", async () => {
                erc20DepositOnTheExecutorRoute(NATIVE_ASSET_ADDRESS);
                const result = await service.prepareSwapAndDeposit(
                    baseParams({ inputToken: NATIVE_ASSET_ADDRESS }),
                );
                for (const msgValue of ["0x0", bigintToHex(INPUT_AMOUNT + 1n)] as Hex[]) {
                    await expect(service.executeSwapAndDeposit({ ...result, msgValue })).rejects.toThrow(
                        UnexpectedTransactionTarget,
                    );
                }
                expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
            });

            it("with a native input: an injected approval is refused before anything is signed", async () => {
                erc20DepositOnTheExecutorRoute(NATIVE_ASSET_ADDRESS);
                const result = await service.prepareSwapAndDeposit(
                    baseParams({ inputToken: NATIVE_ASSET_ADDRESS }),
                );
                // An "approval" to the native placeholder only sends its value to an address with no code.
                const injected = {
                    to: NATIVE_ASSET_ADDRESS,
                    data: encodeFunctionData({
                        abi: ERC20_APPROVE_ABI,
                        functionName: "approve",
                        args: [ERC20_PROXY, 1n],
                    }),
                    value: "0x1" as Hex,
                };
                await expect(
                    service.executeSwapAndDeposit({ ...result, approvalTxs: [injected], approvalTx: injected }),
                ).rejects.toThrow(UnexpectedTransactionTarget);
                expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
            });

            it("an ERC-20 deposit whose call carries native value is refused, not composed", async () => {
                erc20DepositOnTheExecutorRoute();
                vi.mocked(depositDelegate.prepareDeposit).mockImplementation(async () => ({
                    pendingNote,
                    depositTx: { data: "0xabcdef" as Hex, to: ENTRYPOINT, value: "0x1" as Hex },
                    approvalTx: null,
                    approvalTxs: [],
                }));
                await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                    NativeSwapDepositUnavailable,
                );
            });

            it("is refused when the session has no ordinary swap quote to compose from", async () => {
                erc20DepositOnTheExecutorRoute();
                swapQuoteProvider = undefined as unknown as ISwapQuoteProvider;
                buildNativeService();
                await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                    NativeSwapDepositUnavailable,
                );
            });
        });

        it("reject an approval to the executor itself: anyone could spend that allowance", async () => {
            contractCallsQuoteWith({ approvalAddress: EXECUTOR });
            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            buildNativeService(null);
            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
        });

        it("reject an approval to an unlisted contract that identifies as an executor on-chain", async () => {
            const UNLISTED_EXECUTOR = "0x7777777777777777777777777777777777777777" as Address;
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName, address }: ReadContractParams) => {
                    if (functionName === "ROUTING_TYPEHASH") return RELAY_SWAP_ROUTING_TYPEHASH;
                    if (functionName === "allowance") return 0n;
                    if (functionName === "erc20Proxy") {
                        if (String(address).toLowerCase() === UNLISTED_EXECUTOR) return ERC20_PROXY;
                        throw new ContractFunctionRevertedError({
                            abi: LIFI_EXECUTOR_SCREENING_ABI,
                            functionName: "erc20Proxy",
                            message: "execution reverted",
                        });
                    }
                    return true;
                },
            );
            buildNativeService(null);
            contractCallsQuoteWith({ approvalAddress: UNLISTED_EXECUTOR });
            await expect(service.prepareSwapAndDeposit(baseParams())).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
        });

        it("leave an ERC-20 deposit on the contract-calls route", async () => {
            await service.prepareSwapAndDeposit(baseParams());
            expect(vi.mocked(swapQuoteProvider.getSwapQuote)).not.toHaveBeenCalled();
            expect(vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote)).toHaveBeenCalledOnce();
        });
    });

    describe("executeSwapAndDeposit / swapAndDeposit", () => {
        it("submit approval then swap and persist the owned deposit note", async () => {
            const receipt = await service.swapAndDeposit(baseParams());

            expect(receipt.status).toBe(true);
            // approval tx + swap tx
            expect(vi.mocked(entrypointInteractor.submitTransaction)).toHaveBeenCalledTimes(2);
            expect(vi.mocked(noteManager.addNote)).toHaveBeenCalledOnce();
            const persisted = vi.mocked(noteManager.addNote).mock.calls[0][0];
            expect(persisted.createdAtBlock).toBe(MOCK_TIMESTAMP);
            expect(persisted.txHash).toBe("0xtxhash");
        });

        it("skip note persistence when the pending note is not owned", async () => {
            pendingNote = buildPendingNote({ isOwned: false });
            depositDelegate = createMockDepositDelegate(pendingNote);
            buildService();

            const receipt = await service.swapAndDeposit(baseParams());

            expect(receipt.status).toBe(true);
            expect(vi.mocked(noteManager.addNote)).not.toHaveBeenCalled();
        });

        it("skip the approval tx entirely for a native input (single swap tx)", async () => {
            await service.swapAndDeposit(baseParams({ inputToken: NATIVE_ASSET_ADDRESS }));
            // Only the swap+deposit tx is submitted; no approval leg.
            expect(vi.mocked(entrypointInteractor.submitTransaction)).toHaveBeenCalledOnce();
        });

        it("abort before the swap when the approval tx reverts", async () => {
            vi.mocked(rpcInteractor.waitForTransactionReceipt).mockResolvedValueOnce({
                status: false,
                blockNumber: "0x1" as Hex,
                txHash: "0xtxhash" as Hex,
                logs: [],
            });

            const result = await service.prepareSwapAndDeposit(baseParams());
            await expect(service.executeSwapAndDeposit(result)).rejects.toThrow(
                PoolSessionSwapDepositBaseError,
            );
            // Only the approval tx was submitted; the swap tx never fired.
            expect(vi.mocked(entrypointInteractor.submitTransaction)).toHaveBeenCalledOnce();
            expect(vi.mocked(noteManager.addNote)).not.toHaveBeenCalled();
        });

        it("reject an approval tx whose encoded spender is not the LiFi router", async () => {
            const result = await service.prepareSwapAndDeposit(baseParams());
            // Relayer/tamper: keep result.approvalAddress but re-encode a hostile spender.
            const tampered: PrepareSwapAndDepositResult = {
                ...result,
                approvalTx: {
                    to: INPUT_TOKEN,
                    data: encodeFunctionData({
                        abi: ERC20_APPROVE_ABI,
                        functionName: "approve",
                        args: [
                            "0x6666666666666666666666666666666666666666" as Address,
                            BigInt(FROM_AMOUNT),
                        ],
                    }) as Hex,
                    value: "0x0" as Hex,
                },
            };

            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        it("reject an approval tx targeting the wrong token", async () => {
            const result = await service.prepareSwapAndDeposit(baseParams());
            const tampered: PrepareSwapAndDepositResult = {
                ...result,
                approvalTx: {
                    ...result.approvalTx!,
                    to: "0x7777777777777777777777777777777777777777" as Address,
                },
            };

            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        // Execute re-anchors trust to on-chain / session values, so a result tampered
        // after prepare (round-tripped through storage/UI) is rejected before signing.
        it("re-check the allowlist at execute and reject a tampered transactionTo", async () => {
            const result = await service.prepareSwapAndDeposit(baseParams());
            vi.mocked(rpcInteractor.readContract).mockImplementation(
                async ({ functionName }: ReadContractParams) =>
                    functionName === "ROUTING_TYPEHASH" ? RELAY_SWAP_ROUTING_TYPEHASH : false, // router now un-approved
            );
            const tampered: PrepareSwapAndDepositResult = {
                ...result,
                transactionTo: "0x8888888888888888888888888888888888888888" as Address,
            };

            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(
                UnallowedLiFiAddress,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        it("reject a tampered depositTarget that is not the session Entrypoint", async () => {
            const result = await service.prepareSwapAndDeposit(baseParams());
            const tampered: PrepareSwapAndDepositResult = {
                ...result,
                depositTarget: "0x8888888888888888888888888888888888888888" as Address,
            };

            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        it("reject a tampered transactionData that no longer embeds the deposit calldata", async () => {
            const result = await service.prepareSwapAndDeposit(baseParams());
            const tampered: PrepareSwapAndDepositResult = {
                ...result,
                transactionData: "0xdeadbeef" as Hex, // deposit calldata + entrypoint no longer present
            };

            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(
                LiFiDepositCalldataNotFound,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });

        it("reject an approval tx approving more than the estimated input amount", async () => {
            const result = await service.prepareSwapAndDeposit(baseParams());
            const tampered: PrepareSwapAndDepositResult = {
                ...result,
                approvalTx: {
                    to: INPUT_TOKEN,
                    data: encodeFunctionData({
                        abi: ERC20_APPROVE_ABI,
                        functionName: "approve",
                        args: [LIFI_ROUTER, 2n ** 256n - 1n], // unbounded approval
                    }) as Hex,
                    value: "0x0" as Hex,
                },
            };

            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });
    });

    describe("cross-chain", () => {
        const SOURCE_CHAIN_ID = 42161;
        const SOURCE_RELAY_SWAPS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
        const FALLBACK = "0x5555555555555555555555555555555555555555" as Address;

        let sourceWallet: IWalletInteractor;
        let sourceRpc: IRPCInteractor;

        function buildCrossChainService(): void {
            service = new PoolSessionSwapDeposit({
                ownerAddress: OWNER,
                chainId: POOL_CHAIN_ID,
                depositDelegate,
                swapAndDepositQuoteProvider,
                entrypointInteractor,
                rpcInteractor,
                noteManager,
                poolVaultInteractor,
                relaySwapsAddress: RELAY_SWAPS_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                emptyAddress: EMPTY_ADDRESS,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                addressSchema: AddressSchema,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
                sourceChain: {
                    chainId: SOURCE_CHAIN_ID,
                    walletInteractor: sourceWallet,
                    rpcInteractor: sourceRpc,
                    relaySwapsAddress: SOURCE_RELAY_SWAPS,
                    swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: sourceRpc }),
                },
            });
        }

        function crossChainParams(overrides?: Partial<SwapAndDepositParams>): SwapAndDepositParams {
            return baseParams({ fromChainId: SOURCE_CHAIN_ID, ...overrides });
        }

        beforeEach(() => {
            sourceWallet = {
                sendTransaction: vi.fn(async () => "0xsourcetxhash" as Hex),
                getAccounts: vi.fn(async () => [OWNER]),
                getChainId: vi.fn(async () => SOURCE_CHAIN_ID),
                signTypedData: vi.fn(),
            } as unknown as IWalletInteractor;
            // Allowance read returns 0n (bigint, raw readContract) so an approval is built;
            // allowlist reads return true.
            sourceRpc = {
                readContract: vi.fn(async (req: { functionName: string }) => {
                    if (req.functionName === "allowance") return 0n;
                    if (req.functionName === "ROUTING_TYPEHASH") return RELAY_SWAP_ROUTING_TYPEHASH;
                    return true;
                }),
                waitForTransactionReceipt: vi.fn(async () => ({
                    status: true,
                    blockNumber: "0x2" as Hex,
                    txHash: "0xsourcetxhash" as Hex,
                    logs: [],
                })),
            } as unknown as IRPCInteractor;
            buildCrossChainService();
        });

        it("reject a source-chain executor payload that only embeds the deposit", async () => {
            const SOURCE_EXECUTOR = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;
            const SOURCE_ERC20_PROXY = "0x68E1Acfa805dcA813116Ed6507E01c38D44318f0" as Address;
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req) =>
                    ({
                        fromAmount: FROM_AMOUNT,
                        toAmount: "1000000",
                        approvalAddress: SOURCE_ERC20_PROXY,
                        transactionData: maliciousExecutorCalldata(
                            "0x6666666666666666666666666666666666666666" as Address,
                            BigInt(FROM_AMOUNT),
                        ),
                        transactionTo: SOURCE_EXECUTOR,
                        transactionValue: "0x0" as Hex,
                        estimatedDuration: 30,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    }) as never,
            );
            await expect(service.prepareSwapAndDeposit(crossChainParams())).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(vi.mocked(sourceWallet.sendTransaction)).not.toHaveBeenCalled();
        });

        it("throw InvalidSwapAndDepositParams for cross-chain params without a sourceChain config", async () => {
            buildService(); // plain same-chain-only service

            await expect(service.prepareSwapAndDeposit(crossChainParams())).rejects.toThrow(
                InvalidSwapAndDepositParams,
            );
        });

        it("throw InvalidSwapAndDepositParams when fromChainId matches neither pool nor sourceChain", async () => {
            await expect(
                service.prepareSwapAndDeposit(crossChainParams({ fromChainId: 8453 })),
            ).rejects.toThrow(InvalidSwapAndDepositParams);
        });

        it("validate LiFi addresses against the SOURCE chain's RelaySwaps via the source RPC", async () => {
            await service.prepareSwapAndDeposit(crossChainParams());

            const allowlistReads = vi
                .mocked(sourceRpc.readContract)
                .mock.calls.filter(([req]) => req.functionName === "approvedRouters");
            expect(allowlistReads.length).toBeGreaterThan(0);
            for (const [req] of allowlistReads) {
                expect(req.address).toBe(SOURCE_RELAY_SWAPS);
            }
            // The pool-chain RPC must not be consulted for the allowlist.
            expect(vi.mocked(rpcInteractor.readContract)).not.toHaveBeenCalled();
        });

        it("throw UnallowedLiFiAddress when the source-chain allowlist rejects the router", async () => {
            vi.mocked(sourceRpc.readContract).mockImplementation(
                async (req: { functionName: string }) => {
                    if (req.functionName === "allowance") return 0n;
                    if (req.functionName === "ROUTING_TYPEHASH") return RELAY_SWAP_ROUTING_TYPEHASH;
                    return false;
                },
            );

            await expect(service.prepareSwapAndDeposit(crossChainParams())).rejects.toThrow(
                UnallowedLiFiAddress,
            );
        });

        it("route in fromAmount mode when the caller states its input budget", async () => {
            // Exact-out through a bridge only solves at larger sizes (LiFi 404 code 1003
            // for 2.4 USDC from 0.001 ETH); the same request in fromAmount mode routes.
            await service.prepareSwapAndDeposit(
                crossChainParams({ inputAmount: "0x38d7ea4c68000" as Hex }),
            );

            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(req.netFromAmount).toBe("1000000000000000");
            expect(req.depositAmount).toBeDefined();
        });

        it("stay exact-out when no input budget is given", async () => {
            await service.prepareSwapAndDeposit(crossChainParams());

            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(req.netFromAmount).toBeUndefined();
        });

        it("reject a non-positive input budget before quoting", async () => {
            await expect(
                service.prepareSwapAndDeposit(crossChainParams({ inputAmount: "0x0" as Hex })),
            ).rejects.toThrow(InvalidSwapAndDepositParams);
            expect(
                vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote),
            ).not.toHaveBeenCalled();
        });

        // --- Destination affordability gate (mirrors the reshield's) ---
        // LiFi caps the destination contract-call's budget at the Stargate route's
        // minAmountLD; a deposit costing more silently ships RAW bridged tokens to
        // fallbackAddress instead of a shielded note. The gate must refuse the quote.

        function armStargateQuote(minAmountLD: bigint): void {
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: {
                    fromToken: Address;
                    toToken: Address;
                    fromChainId: number;
                    toChainId: number;
                }) => ({
                    fromAmount: FROM_AMOUNT,
                    toAmount: "1000000",
                    fromAmountUSD: "1.00",
                    toAmountUSD: "1.00",
                    approvalAddress: LIFI_ROUTER,
                    // Real Stargate-facet encoding; the containment bytes ride in composeMsg.
                    transactionData: encodeStargateMainLegCalldata({
                        minAmountLD,
                        composeMsg: LIFI_TRANSACTION_DATA,
                    }),
                    transactionTo: LIFI_ROUTER,
                    transactionValue: "0x2710" as Hex,
                    estimatedDuration: 30,
                    fromTokenAddress: req.fromToken,
                    toTokenAddress: req.toToken,
                    fromChainId: req.fromChainId,
                    toChainId: req.toChainId,
                }),
            );
        }

        it("throw DestinationDepositUnaffordable when the Stargate route's guaranteed delivery cannot cover the deposit cost", async () => {
            const minAmountLD = 950_000n; // < depositAmount 1_000_000 + 100 bps vetting = 1_010_000
            armStargateQuote(minAmountLD);

            const err = (await service
                .prepareSwapAndDeposit(crossChainParams())
                .then(() => undefined)
                .catch((e: unknown) => e)) as DestinationDepositUnaffordable | undefined;

            expect(err).toBeInstanceOf(DestinationDepositUnaffordable);
            // minAmountLD minus the 1% quote-drift margin, scaled back by the 100 bps vetting fee
            expect(BigInt(err!.affordableNoteValue)).toBe(
                (((minAmountLD * 9_900n) / 10_000n) * 10_000n) / 10_100n,
            );
        });

        it("throw DestinationDepositUnaffordable when an Across route's guaranteed delivery is below the deposit cost", async () => {
            const guaranteed = 950_000n; // < 1_000_000 + 100 bps = 1_010_000
            vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mockImplementation(
                async (req: {
                    fromToken: Address;
                    toToken: Address;
                    fromChainId: number;
                    toChainId: number;
                }) => ({
                    fromAmount: FROM_AMOUNT,
                    toAmount: "0",
                    destinationCallAmount: guaranteed.toString(),
                    approvalAddress: LIFI_ROUTER,
                    transactionData: LIFI_TRANSACTION_DATA,
                    transactionTo: LIFI_ROUTER,
                    transactionValue: "0x0" as Hex,
                    estimatedDuration: 30,
                    fromTokenAddress: req.fromToken,
                    toTokenAddress: req.toToken,
                    fromChainId: req.fromChainId,
                    toChainId: req.toChainId,
                }),
            );

            const err = (await service
                .prepareSwapAndDeposit(crossChainParams())
                .then(() => undefined)
                .catch((e: unknown) => e)) as DestinationDepositUnaffordable | undefined;

            expect(err).toBeInstanceOf(DestinationDepositUnaffordable);
            expect(BigInt(err!.affordableNoteValue)).toBe(
                (((guaranteed * 9_900n) / 10_000n) * 10_000n) / 10_100n,
            );
        });

        it("refuse a cross-chain plain native-coin deposit before quoting", async () => {
            vi.mocked(depositDelegate.prepareDeposit).mockResolvedValueOnce({
                pendingNote: buildPendingNote(),
                depositTx: { data: "0xabcdef" as Hex, to: ENTRYPOINT, value: "0x10" as Hex },
                approvalTx: null,
                approvalTxs: [],
            });

            await expect(
                service.prepareSwapAndDeposit(crossChainParams({ depositToken: NATIVE_ASSET_ADDRESS })),
            ).rejects.toThrow(
                NativeDestinationDepositUnsupported,
            );
            expect(swapAndDepositQuoteProvider.getSwapAndDepositQuote).not.toHaveBeenCalled();
        });

        it("pass the affordability gate when the Stargate route's minAmountLD covers the deposit cost", async () => {
            armStargateQuote(2_000_000n); // > 1_010_000 total cost

            const result = await service.prepareSwapAndDeposit(crossChainParams());

            expect(result.transactionTo).toBe(LIFI_ROUTER);
        });

        it("give the destination Entrypoint deposit the flat 2M budget (LiFi defaults to 300k; a deposit costs ~545k)", async () => {
            await service.prepareSwapAndDeposit(crossChainParams());

            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(req.depositGasLimit).toBe("2000000");
        });

        it("give the destination Entrypoint deposit the flat 2M budget with no destination swap", async () => {
            await service.prepareSwapAndDeposit(crossChainParams({ inputToken: DEPOSIT_TOKEN }));

            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(req.depositGasLimit).toBe("2000000");
        });

        it("default fallbackAddress to the ownerAddress in the quote request", async () => {
            await service.prepareSwapAndDeposit(crossChainParams());

            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(req.fallbackAddress).toBe(OWNER);
        });

        it("honor an explicit fallbackAddress over the default", async () => {
            await service.prepareSwapAndDeposit(crossChainParams({ fallbackAddress: FALLBACK }));

            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(req.fallbackAddress).toBe(FALLBACK);
        });

        it("reject an explicit zero fallbackAddress (bridged funds would be unrecoverable)", async () => {
            await expect(
                service.prepareSwapAndDeposit(
                    crossChainParams({
                        fallbackAddress: "0x0000000000000000000000000000000000000000" as Address,
                    }),
                ),
            ).rejects.toThrow(InvalidSwapAndDepositParams);
        });

        it("query the source-chain allowlist even when the same router address was cached for the pool chain", async () => {
            // Pool and source RelaySwaps share an address (deterministic deployment). A
            // same-chain query must not satisfy a later cross-chain query for the same
            // router — the cache key includes the chainId.
            service = new PoolSessionSwapDeposit({
                ownerAddress: OWNER,
                chainId: POOL_CHAIN_ID,
                depositDelegate,
                swapAndDepositQuoteProvider,
                entrypointInteractor,
                rpcInteractor,
                noteManager,
                poolVaultInteractor,
                relaySwapsAddress: RELAY_SWAPS_ADDRESS,
                nativeAssetAddress: NATIVE_ASSET_ADDRESS,
                emptyAddress: EMPTY_ADDRESS,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                addressSchema: AddressSchema,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
                sourceChain: {
                    chainId: SOURCE_CHAIN_ID,
                    walletInteractor: sourceWallet,
                    rpcInteractor: sourceRpc,
                    relaySwapsAddress: RELAY_SWAPS_ADDRESS, // SAME address as the pool chain
                    swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: sourceRpc }),
                },
            });

            // Same-chain prepare caches the router as approved on the pool chain.
            await service.prepareSwapAndDeposit(baseParams());
            // Source chain has NOT approved the router.
            vi.mocked(sourceRpc.readContract).mockImplementation(
                async (req: { functionName: string }) => {
                    if (req.functionName === "allowance") return 0n;
                    if (req.functionName === "ROUTING_TYPEHASH") return RELAY_SWAP_ROUTING_TYPEHASH;
                    return false;
                },
            );

            await expect(service.prepareSwapAndDeposit(crossChainParams())).rejects.toThrow(
                UnallowedLiFiAddress,
            );
        });

        it("omit fallbackAddress from same-chain quote requests", async () => {
            await service.prepareSwapAndDeposit(baseParams());

            const req = vi.mocked(swapAndDepositQuoteProvider.getSwapAndDepositQuote).mock
                .calls[0][0];
            expect(req.fallbackAddress).toBeUndefined();
        });

        it("read the input-token allowance on the source chain, not via the pool Entrypoint", async () => {
            await service.prepareSwapAndDeposit(crossChainParams());

            const allowanceReads = vi
                .mocked(sourceRpc.readContract)
                .mock.calls.filter(([req]) => req.functionName === "allowance");
            expect(allowanceReads).toHaveLength(1);
            expect(allowanceReads[0][0].address).toBe(INPUT_TOKEN);
            expect(vi.mocked(entrypointInteractor.getAllowance)).not.toHaveBeenCalled();
        });

        it("skip the approval tx when the source-chain allowance already suffices", async () => {
            vi.mocked(sourceRpc.readContract).mockImplementation(
                async (req: { functionName: string }) => {
                    if (req.functionName === "allowance") return 10_000_000_000n;
                    if (req.functionName === "ROUTING_TYPEHASH") return RELAY_SWAP_ROUTING_TYPEHASH;
                    return true;
                },
            );

            const result = await service.prepareSwapAndDeposit(crossChainParams());
            expect(result.approvalTx).toBeNull();
        });

        it("populate fromChainId on the prepared result", async () => {
            const crossChain = await service.prepareSwapAndDeposit(crossChainParams());
            expect(crossChain.fromChainId).toBe(SOURCE_CHAIN_ID);

            const sameChain = await service.prepareSwapAndDeposit(baseParams());
            expect(sameChain.fromChainId).toBe(POOL_CHAIN_ID);
        });

        it("submit approval and swap via the source wallet and await receipts on the source RPC", async () => {
            const result = await service.prepareSwapAndDeposit(crossChainParams());
            const receipt = await service.executeSwapAndDeposit(result);

            expect(receipt.status).toBe(true);
            // Approval + swap = two source-wallet sends; pool-chain submission untouched.
            expect(vi.mocked(sourceWallet.sendTransaction)).toHaveBeenCalledTimes(2);
            expect(vi.mocked(sourceRpc.waitForTransactionReceipt)).toHaveBeenCalledTimes(2);
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
            expect(vi.mocked(rpcInteractor.waitForTransactionReceipt)).not.toHaveBeenCalled();
        });

        it("skip local note persistence for cross-chain execution", async () => {
            const result = await service.prepareSwapAndDeposit(crossChainParams());
            await service.executeSwapAndDeposit(result);

            // The destination deposit has not happened yet at source-receipt time —
            // there is no commitment timestamp to persist. The caller keeps pendingNote.
            expect(vi.mocked(noteManager.addNote)).not.toHaveBeenCalled();
            expect(vi.mocked(poolVaultInteractor.getCommitmentTimestamp)).not.toHaveBeenCalled();
        });

        it("throw InvalidSwapAndDepositParams when executing a cross-chain result without a matching sourceChain", async () => {
            const result = await service.prepareSwapAndDeposit(crossChainParams());
            buildService(); // same-chain-only service

            await expect(service.executeSwapAndDeposit(result)).rejects.toThrow(
                InvalidSwapAndDepositParams,
            );
            expect(vi.mocked(entrypointInteractor.submitTransaction)).not.toHaveBeenCalled();
        });
    });
});

// A yield SHARE as the deposit token (2026-09-18): the wallet swap buys the
// share's funding token and the LiFi contract call is the share's PPRouter deposit.
describe("PoolSessionSwapDeposit with a yield share as the deposit token", () => {
    const SHARE = "0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6" as Address;
    const ROUTER = "0xe76E793d776c1e207aD7a7fa7C57d27420d85110" as Address;
    const UNDERLYING = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
    const SHARES = 990_000n;
    const BUDGET = BigInt(DEPOSIT_AMOUNT);

    interface ProofTuple {
        pA: [bigint, bigint];
        pB: [[bigint, bigint], [bigint, bigint]];
        pC: [bigint, bigint];
        pubSignals: [bigint, bigint, bigint, bigint];
    }
    function proof(value: bigint): ProofTuple {
        return {
            pA: [1n, 2n] as [bigint, bigint],
            pB: [
                [3n, 4n],
                [5n, 6n],
            ] as [[bigint, bigint], [bigint, bigint]],
            pC: [7n, 8n] as [bigint, bigint],
            pubSignals: [9n, BigInt(SHARE), value, 0n] as [bigint, bigint, bigint, bigint],
        };
    }
    const NOTE_DATA = { hint: `0x${"ab".repeat(32)}` as Hex, data: "0x1234" as Hex };
    function makeTarget(nativeMode: boolean): YieldDepositTarget {
        return {
            chainId: POOL_CHAIN_ID,
            deployment: {
                ppRouter: ROUTER,
                zap: LIFI_ROUTER,
                ppUSDC: SHARE,
                ppUSDCDecimals: 18,
                underlying: UNDERLYING,
                underlyingDecimals: 6,
                underlyingSymbol: "USDC",
                ...(nativeMode ? { nativeMode: true } : {}),
            },
            deposit: {
                // Linear in the budget: the prepared BUDGET buys exactly SHARES.
                sizeSharesForBudget: vi.fn(async (budget: bigint) => ({
                    shares: (budget * SHARES) / BUDGET,
                    underlyingNeeded: budget - 10n,
                    maxUnderlyingIn: budget,
                    headroom: 1n,
                })),
                prepareYieldDeposit: vi.fn(
                    async (params: { value: Hex; maxUnderlyingIn?: bigint }) => {
                        const value = BigInt(params.value);
                        const cap = params.maxUnderlyingIn ?? 0n;
                        const data = nativeMode
                            ? encodeFunctionData({
                                  abi: PP_ROUTER_DEPOSIT_NATIVE_ABI,
                                  functionName: "depositExactSharesNative",
                                  args: [proof(value), NOTE_DATA, "0x" as Hex],
                              })
                            : encodeFunctionData({
                                  abi: PP_ROUTER_DEPOSIT_ABI,
                                  functionName: "depositExactShares",
                                  args: [proof(value), NOTE_DATA, "0x" as Hex, cap],
                              });
                        return {
                            pendingNote: buildPendingNote({ tokenId: SHARE, value: params.value }),
                            depositTx: {
                                to: ROUTER,
                                data,
                                value: nativeMode ? bigintToHex(cap) : ("0x0" as Hex),
                            },
                            approvalTxs: [],
                            approvalTx: null,
                            sharesValue: value,
                            underlyingNeeded: cap - 10n,
                            maxUnderlyingIn: cap,
                        };
                    },
                ),
            },
        } as unknown as YieldDepositTarget;
    }
    /** LiFi echoes the router call so the containment check passes. */
    function routerQuoteProvider(): ISwapAndDepositQuoteProvider {
        const provider = createMockSwapAndDepositQuoteProvider();
        vi.mocked(provider.getSwapAndDepositQuote).mockImplementation(async (req) => ({
            fromAmount: FROM_AMOUNT,
            toAmount: req.depositAmount,
            fromAmountUSD: "1.00",
            toAmountUSD: "1.00",
            approvalAddress: LIFI_ROUTER,
            transactionData:
                `0x${req.poolAddress.slice(2).toLowerCase().padStart(64, "0")}${req.depositCalldata.slice(2)}` as Hex,
            transactionTo: LIFI_ROUTER,
            transactionValue: "0x0" as Hex,
            estimatedDuration: 30,
            fromTokenAddress: req.fromToken,
            toTokenAddress: req.toToken,
            fromChainId: req.fromChainId,
            toChainId: req.toChainId,
        }));
        return provider;
    }
    function buildShareService(nativeMode: boolean, executor?: { executor: Address; erc20Proxy: Address; swapQuoteProvider: ISwapQuoteProvider; provider: ISwapAndDepositQuoteProvider }): {
        service: PoolSessionSwapDeposit<PreparedTransaction>;
        depositDelegate: IPoolSessionDeposit;
        provider: ISwapAndDepositQuoteProvider;
    } {
        const depositDelegate = createMockDepositDelegate(buildPendingNote());
        const provider = executor?.provider ?? routerQuoteProvider();
        const rpcInteractor = createMockRPCInteractor();
        const service = new PoolSessionSwapDeposit<PreparedTransaction>({
            ownerAddress: OWNER,
            chainId: POOL_CHAIN_ID,
            depositDelegate,
            swapAndDepositQuoteProvider: provider,
            entrypointInteractor: createMockEntrypointInteractor(),
            rpcInteractor,
            noteManager: createMockNoteManager(),
            poolVaultInteractor: createMockPoolVaultInteractor(),
            relaySwapsAddress: RELAY_SWAPS_ADDRESS,
            nativeAssetAddress: NATIVE_ASSET_ADDRESS,
            emptyAddress: EMPTY_ADDRESS,
            addressEqualityComparator: new EvmAddressEqualityComparator(),
            addressSchema: AddressSchema,
            swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
            yieldDepositTargets: [toYieldSwapDepositTarget(makeTarget(nativeMode))],
            ...(executor
                ? {
                      swapExecutor: { executor: executor.executor, erc20Proxy: executor.erc20Proxy },
                      swapQuoteProvider: executor.swapQuoteProvider,
                  }
                : {}),
        });
        return { service, depositDelegate, provider };
    }

    it("swaps into the UNDERLYING and embeds depositExactShares on the router with the budget as the cap", async () => {
        const { service, depositDelegate, provider } = buildShareService(false);
        const result = await service.prepareSwapAndDeposit({
            fromChainId: POOL_CHAIN_ID,
            inputToken: INPUT_TOKEN,
            depositToken: SHARE,
            depositAmount: DEPOSIT_AMOUNT,
        });
        expect(depositDelegate.prepareDeposit).not.toHaveBeenCalled();
        const req = vi.mocked(provider.getSwapAndDepositQuote).mock.calls[0][0];
        expect(req.toToken.toLowerCase()).toBe(UNDERLYING.toLowerCase());
        expect(req.poolAddress.toLowerCase()).toBe(ROUTER.toLowerCase());
        expect(req.depositAmount).toBe(BUDGET.toString());
        const decoded = decodeFunctionData({
            abi: PP_ROUTER_DEPOSIT_ABI,
            data: req.depositCalldata,
        });
        expect(decoded.functionName).toBe("depositExactShares");
        expect(decoded.args[3]).toBe(BUDGET);
        expect(result.pendingNote.tokenId).toBe(SHARE);
        expect(BigInt(result.pendingNote.value)).toBe(SHARES);
        // The wallet still approves LiFi for the INPUT token; the router itself is never approved by the wallet.
        expect((result.approvalTx as { to: Address } | null)?.to).toBe(INPUT_TOKEN);
    });

    it("a native-mode share swaps into the native coin and embeds depositExactSharesNative carrying the budget as value", async () => {
        const { service, provider } = buildShareService(true);
        await service.prepareSwapAndDeposit({
            fromChainId: POOL_CHAIN_ID,
            inputToken: INPUT_TOKEN,
            depositToken: SHARE,
            depositAmount: DEPOSIT_AMOUNT,
        });
        const req = vi.mocked(provider.getSwapAndDepositQuote).mock.calls[0][0];
        expect(req.toToken.toLowerCase()).toBe(NATIVE_ASSET_ADDRESS.toLowerCase());
        expect(req.poolAddress.toLowerCase()).toBe(ROUTER.toLowerCase());
        const decoded = decodeFunctionData({
            abi: PP_ROUTER_DEPOSIT_NATIVE_ABI,
            data: req.depositCalldata,
        });
        expect(decoded.functionName).toBe("depositExactSharesNative");
    });

    it("a plain deposit token is untouched: no router, the Entrypoint stays the target", async () => {
        const { service, depositDelegate, provider } = buildShareService(false);
        await service.prepareSwapAndDeposit({
            fromChainId: POOL_CHAIN_ID,
            inputToken: INPUT_TOKEN,
            depositToken: DEPOSIT_TOKEN,
            depositAmount: DEPOSIT_AMOUNT,
        });
        expect(depositDelegate.prepareDeposit).toHaveBeenCalledTimes(1);
        expect(vi.mocked(provider.getSwapAndDepositQuote).mock.calls[0][0].poolAddress).toBe(
            ENTRYPOINT,
        );
    });
    // cubic on #476: the router's funding budget is not in the note, so the amount an executor
    // call hands the router is anchored on chain (the shares it buys at the router's rate).
    describe("composed through the swap executor", () => {
        const EXECUTOR = "0x2dfaDAB8266483beD9Fd9A292Ce56596a2D1378D" as Address;
        const ERC20_PROXY = "0x5741A7FfE7c39Ca175546a54985fA79211290b51" as Address;
        const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address;
        const SWAP_CALLDATA = ("0x2c57e884" +
            encodeAbiParameters([{ type: "address" }], [EXECUTOR]).slice(2) +
            "ab".repeat(96)) as Hex;

        function buildExecutorShareService(): PoolSessionSwapDeposit<PreparedTransaction> {
            const swapQuoteProvider = {
                getSwapQuote: vi.fn(async () => ({
                    fromAmount: FROM_AMOUNT,
                    toAmount: (BUDGET * 2n).toString(),
                    toAmountMin: (BUDGET * 2n).toString(),
                    approvalAddress: DIAMOND,
                    transactionData: SWAP_CALLDATA,
                    transactionTo: DIAMOND,
                    estimatedDuration: 20,
                    fromTokenAddress: INPUT_TOKEN,
                    toTokenAddress: UNDERLYING,
                    fromChainId: POOL_CHAIN_ID,
                    toChainId: POOL_CHAIN_ID,
                })),
                getSwapStatus: vi.fn(),
            } as unknown as ISwapQuoteProvider;
            const provider = routerQuoteProvider();
            const base = vi.mocked(provider.getSwapAndDepositQuote).getMockImplementation()!;
            vi.mocked(provider.getSwapAndDepositQuote).mockImplementation(async (req) => ({
                ...(await base(req)),
                transactionTo: EXECUTOR,
                approvalAddress: ERC20_PROXY,
            }));
            return buildShareService(false, { executor: EXECUTOR, erc20Proxy: ERC20_PROXY, swapQuoteProvider, provider })
                .service;
        }

        async function prepared(service: PoolSessionSwapDeposit<PreparedTransaction>) {
            return service.prepareSwapAndDeposit({
                fromChainId: POOL_CHAIN_ID,
                inputToken: INPUT_TOKEN,
                depositToken: SHARE,
                depositAmount: DEPOSIT_AMOUNT,
            });
        }

        it("composes the router deposit handed exactly the budget, and executes it", async () => {
            const service = buildExecutorShareService();
            const result = await prepared(service);
            expect(result.transactionTo).toBe(EXECUTOR);
            expect(BigInt(result.depositCallValue!)).toBe(BUDGET);
            await expect(service.executeSwapAndDeposit(result)).resolves.toBeDefined();
        });

        it("reject a router budget inflated across the result, the router cap and the executor call together", async () => {
            const service = buildExecutorShareService();
            const result = await prepared(service);
            const inflated = BUDGET * 2n;
            const router = decodeFunctionData({ abi: PP_ROUTER_DEPOSIT_ABI, data: result.depositCallData });
            const [p, noteData, extra] = router.args;
            const depositCallData = encodeFunctionData({
                abi: PP_ROUTER_DEPOSIT_ABI,
                functionName: "depositExactShares",
                args: [p, noteData, extra, inflated],
            });
            const adapter = new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() });
            const decoded = adapter.decodeSwapThenCall(result.transactionData)!;
            const tampered = {
                ...result,
                depositCallData,
                depositCallValue: bigintToHex(inflated),
                transactionData: adapter.encodeSwapThenCall({ ...decoded, callData: depositCallData, callValue: inflated }),
            };
            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(/more than the note's/);
        });

        it("reject a router budget that disagrees with the router calldata's cap", async () => {
            const service = buildExecutorShareService();
            const result = await prepared(service);
            const adapter = new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() });
            const decoded = adapter.decodeSwapThenCall(result.transactionData)!;
            const tampered = {
                ...result,
                depositCallValue: bigintToHex(BUDGET + 1n),
                transactionData: adapter.encodeSwapThenCall({ ...decoded, callValue: BUDGET + 1n }),
            };
            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(InvalidTransactParams);
        });

        it("reject an executor call handed nothing, even when the result agrees", async () => {
            const service = buildExecutorShareService();
            const result = await prepared(service);
            const adapter = new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() });
            const decoded = adapter.decodeSwapThenCall(result.transactionData)!;
            const tampered = {
                ...result,
                depositCallValue: "0x0" as Hex,
                transactionData: adapter.encodeSwapThenCall({ ...decoded, callValue: 0n }),
            };
            await expect(service.executeSwapAndDeposit(tampered)).rejects.toThrow(/handed nothing/);
        });
    });
});
