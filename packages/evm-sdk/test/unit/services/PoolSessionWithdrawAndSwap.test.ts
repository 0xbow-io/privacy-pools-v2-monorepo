import { encodeAbiParameters } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    AssetConfig,
    ExecuteWithdrawAndSwapRelayerParams,
    FinalizedBlockResult,
    Hash,
    Hex,
    IEntrypointInteractor,
    IPPYieldTokenInteractor,
    IRelayerInteractor,
    IRPCInteractor,
    ISwapQuoteProvider,
    Note,
    NoteData,
    PendingNote,
    PrepareSwapQuoteParams,
    PrepareTransactResult,
    Secret,
    SwapQuoteParams,
    SwapRelayerQuote,
    TransactProof,
} from "../../../src/internal.js";
import {
    EMPTY_ADDRESS,
    EvmAddressEqualityComparator,
    EvmSwapChainAdapter,
    FeeCommitmentExpired,
    hasErrorAmounts,
    InvalidTransactParams,
    LiFiRecipientNotFound,
    NoteStatus,
    PoolSessionWithdrawAndSwap,
    RELAY_SWAP_ROUTING_ABI,
    RelayFeeExceedsMax,
    SwapQuoteMismatch,
    TransactOrchestrator,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";

// --- Constants ---

const POOL_CHAIN_ID = 11155111;
const VALID_ENTRYPOINT = "0x9999999999999999999999999999999999999991" as Address;
const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const VALID_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const VALID_VALUE = "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000" as Hex;
const HALF_VALUE = "0x00000000000000000000000000000000000000000000000006f05b59d3b20000" as Hex;
const MOCK_SECRET = "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
const MOCK_COMMITMENT_1 =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const MOCK_LABEL = "0x4444444444444444444444444444444444444444444444444444444444444444" as Hex;
const MOCK_NOTE_ADDRESS_HASH =
    "0x5555555555555555555555555555555555555555555555555555555555555555" as Hex;
const VALID_RECIPIENT = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const VALID_RELAY = "0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd" as Address;
const VALID_PROCESSOR = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
const VALID_OUTPUT_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
const VALID_FALLBACK = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab" as Address;
const VALID_SWAP_TARGET = "0x1111111111111111111111111111111111111111" as Address;
const VALID_APPROVAL_ADDRESS = "0x2222222222222222222222222222222222222223" as Address;
const VALID_RELAY_SWAPS = "0x5555555555555555555555555555555555555555" as Address;
const SWAP_CALLDATA = "0xdeadbeef" as Hex;
const OTHER_SWAP_CALLDATA = "0xbeefdead" as Hex;

const MOCK_OUTPUT_COMMITMENT =
    "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;

// --- Mock notes ---

const MOCK_NOTE: Note = {
    commitment: MOCK_COMMITMENT_1,
    noteSecret: MOCK_SECRET,
    value: VALID_VALUE,
    label: MOCK_LABEL,
    tokenId: VALID_TOKEN,
    status: NoteStatus.ACTIVE,
    isOwned: true,
    ownerAddress: VALID_OWNER,
    createdAtBlock: "0x100" as Hex,
    spentAtBlock: null,
    txHash: "0x0" as Hash,
    noteAddressHash: MOCK_NOTE_ADDRESS_HASH,
};

const MOCK_CHANGE_PENDING_NOTE: PendingNote = {
    noteAddressHash: MOCK_NOTE_ADDRESS_HASH,
    commitment: MOCK_OUTPUT_COMMITMENT as Hash,
    value: HALF_VALUE,
    tokenId: VALID_TOKEN,
    label: MOCK_LABEL,
    ownerAddress: VALID_OWNER,
    noteSecret: MOCK_SECRET,
    isOwned: true,
    status: NoteStatus.PENDING,
};

/** Nullifier of the note spent by the default prepare result (AW-L-02 / #1070 wiring). */
const MOCK_SPENT_NULLIFIER = `0x${"11".repeat(32)}` as Hex;

// --- Default prepareTransact result ---

function defaultPrepareTransactResult(): PrepareTransactResult {
    return {
        changePendingNotes: [MOCK_CHANGE_PENDING_NOTE],
        recipientPendingNotes: [],
        transactTx: { data: "0xabcdef" as Hex, to: VALID_POOL, value: "0x0" as Hex },
        spentNotes: [MOCK_NOTE],
        spentNullifiers: [MOCK_SPENT_NULLIFIER],
        notesData: [
            { hint: `0x${"00".repeat(32)}` as Hex, data: "0xdeadbeef" as Hex },
        ] as NoteData[],
        proof: {} as TransactProof,
    };
}

// --- Mock factories ---

function createMockCore(): TransactOrchestrator {
    return {
        ownerAddress: VALID_OWNER,
        poolAddress: VALID_POOL,
        warmMerkleCaches: vi.fn(async () => undefined),
        prepareTransact: vi.fn(async () => defaultPrepareTransactResult()),
        submit: vi.fn(async () => "0x1" as Hash),
        persistNoteUpdates: vi.fn(),
    } as unknown as TransactOrchestrator;
}

function createMockRPCInteractor(): IRPCInteractor {
    return {
        readContract: vi.fn(),
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

function createMockRelayerInteractor(): IRelayerInteractor {
    return {
        getRelayers: vi.fn(async () => []),
        getTransferQuote: vi.fn(),
        getWithdrawalQuote: vi.fn(),
        getBatchWithdrawalQuote: vi.fn(),
        relayTransfer: vi.fn(),
        relayWithdrawal: vi.fn(),
        relayBatchWithdrawal: vi.fn(),
        submitRelayedRegistration: vi.fn(),
        relayRegisterAndWithdrawal: vi.fn(),
        relayWithAnnounce: vi.fn(),
        getSwapQuote: vi.fn(),
        relaySwap: vi.fn(),
    } as unknown as IRelayerInteractor;
}

const DEFAULT_ASSET_CONFIG: AssetConfig = {
    enabled: true,
    minAmount: "0x1" as Hex,
    vettingFeeBPS: "0x14" as Hex, // 20 bps
    maxRelayFee: "0x0" as Hex, // no cap by default
};

function createMockEntrypointInteractor(
    assetConfig: Partial<AssetConfig> = {},
): IEntrypointInteractor {
    return {
        getAddress: vi.fn(() => VALID_ENTRYPOINT),
        getAssetConfig: vi.fn(async () => ({ ...DEFAULT_ASSET_CONFIG, ...assetConfig })),
    } as unknown as IEntrypointInteractor;
}

// --- Routing helpers ---

const AMOUNT = "0x64" as Hex; // 100 (gross withdrawal)
const AMOUNT_DECIMAL = "100"; // AMOUNT as a decimal string (relayer amountSent format)
const FEE_AMOUNT = "10";
// Relayer-computed ETH top-up carried in the signed routing when extraGas is on.
const MOCK_RELAYER_TOP_UP = 600_000_000_000_000n;
const VALID_AMOUNT_SENT = "110"; // net 100 + fee 10 = gross (relay fixture: amount is net)

function buildSwapRoutingData(overrides?: {
    recipient?: Address;
    fallbackAddress?: Address;
    dustRecipient?: Address;
    outputToken?: Address;
    feeAmount?: bigint;
    swapCalldata?: Hex;
    minOutputAmount?: bigint;
    nativeGas?: bigint;
    swapTarget?: Address;
    approvalAddress?: Address;
}): Hex {
    return encodeAbiParameters(RELAY_SWAP_ROUTING_ABI, [
        {
            swapTarget: overrides?.swapTarget ?? VALID_SWAP_TARGET,
            approvalAddress: overrides?.approvalAddress ?? VALID_APPROVAL_ADDRESS,
            outputToken: overrides?.outputToken ?? VALID_OUTPUT_TOKEN,
            recipient: overrides?.recipient ?? VALID_RECIPIENT,
            feeRecipient: VALID_RELAY,
            fallbackAddress: overrides?.fallbackAddress ?? VALID_RECIPIENT,
            dustRecipient: overrides?.dustRecipient ?? VALID_RECIPIENT,
            feeAmount: overrides?.feeAmount ?? BigInt(FEE_AMOUNT),
            minOutputAmount: overrides?.minOutputAmount ?? 1n,
            nativeGas: overrides?.nativeGas ?? 0n,
            swapValue: 0n,
            gasSwapMaxInput: 0n,
            gasSwapCalldata: "0x",
            swapCalldata: overrides?.swapCalldata ?? SWAP_CALLDATA,
            dustRescue: {
                chainId: 0n,
                tokenId: "0x0000000000000000000000000000000000000000",
                isCanonical: false,
                spendingPubKey: "0x",
                viewingPubKey: "0x",
            },
        },
    ]);
}

function buildSwapParams(overrides?: {
    amountSent?: string;
    recipientInData?: Address;
    fallbackInData?: Address;
    dustInData?: Address;
    outputTokenInData?: Address;
    callerFallback?: Address;
    feeAmountInData?: bigint;
    swapCalldataInData?: Hex;
    minOutputAmountInData?: bigint;
    nativeGasInData?: bigint;
    callerMinOutputAmount?: Hex;
    toChainId?: number;
    callerDustRecipient?: Address;
    callerExtraGas?: boolean;
    swapTargetInData?: Address;
    approvalAddressInData?: Address;
}): ExecuteWithdrawAndSwapRelayerParams {
    const recipient = overrides?.recipientInData ?? VALID_RECIPIENT;
    const fallback = overrides?.fallbackInData ?? overrides?.callerFallback ?? VALID_RECIPIENT;
    const feeAmountEncoded = overrides?.feeAmountInData ?? BigInt(FEE_AMOUNT);

    return {
        inputCommitments: [MOCK_COMMITMENT_1 as Hash],
        amount: AMOUNT,
        tokenId: VALID_TOKEN,
        recipientAddress: VALID_RECIPIENT,
        fallbackAddress: overrides?.callerFallback,
        outputToken: VALID_OUTPUT_TOKEN,
        minOutputAmount: overrides?.callerMinOutputAmount ?? ("0x01" as Hex),
        swapCalldata: SWAP_CALLDATA,
        toChainId: overrides?.toChainId,
        dustRecipient: overrides?.callerDustRecipient,
        extraGas: overrides?.callerExtraGas,
        selectedQuote: {
            relayerInfo: {
                url: "https://relay.test",
                name: "test-relay",
                chainId: 11155111,
                chainType: "evm",
                status: "active",
                address: VALID_RELAY,
                processorAddress: VALID_PROCESSOR,
            },
            quote: {
                txCost: "0",
                gasPrice: "0",
                feeAmount: FEE_AMOUNT,
                feeCommitment: {
                    data: buildSwapRoutingData({
                        recipient,
                        fallbackAddress: fallback,
                        dustRecipient: overrides?.dustInData,
                        outputToken: overrides?.outputTokenInData,
                        feeAmount: feeAmountEncoded,
                        swapCalldata: overrides?.swapCalldataInData,
                        minOutputAmount: overrides?.minOutputAmountInData,
                        nativeGas: overrides?.nativeGasInData,
                        swapTarget: overrides?.swapTargetInData,
                        approvalAddress: overrides?.approvalAddressInData,
                    }),
                    asset: VALID_TOKEN,
                    expiration: Date.now() + 3_600_000,
                    feeAmount: FEE_AMOUNT,
                    signedRelayerCommitment: "0xdeadbeef" as Hex,
                    recipient,
                    amountSent: overrides?.amountSent ?? VALID_AMOUNT_SENT,
                },
            },
        },
    };
}

// --- Tests ---

describe("PoolSessionWithdrawAndSwap", () => {
    describe("constructor", () => {
        it("create instance with valid config", () => {
            const service = new PoolSessionWithdrawAndSwap({
                chainId: POOL_CHAIN_ID,
                core: createMockCore(),
                relayerInteractor: createMockRelayerInteractor(),
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor: createMockEntrypointInteractor(),
            });
            expect(service).toBeInstanceOf(PoolSessionWithdrawAndSwap);
        });
    });

    describe("relayWithdrawAndSwap", () => {
        let core: TransactOrchestrator;
        let relayerInteractor: IRelayerInteractor;
        let service: PoolSessionWithdrawAndSwap;

        beforeEach(() => {
            core = createMockCore();
            relayerInteractor = createMockRelayerInteractor();
            vi.mocked(relayerInteractor.relaySwap).mockResolvedValue("0x1" as Hex);
            service = new PoolSessionWithdrawAndSwap({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: createMockRPCInteractor() }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor: createMockEntrypointInteractor(),
            });
        });

        it("pass when all routing fields match and amountSent is correct", async () => {
            await expect(service.relayWithdrawAndSwap(buildSwapParams())).resolves.toBeDefined();
            expect(core.prepareTransact).toHaveBeenCalledOnce();
        });

        // AW-L-02 / #1070. This path persists SPENT on the strength of a txHash the RELAYER
        // chose, so it must hand the receipt evidence to the verification gate. It previously
        // called persistNoteUpdates bare — the gate was optional, so it silently no-op'd and a
        // relayer returning the hash of an unrelated successful tx could drive spendable notes
        // to SPENT. SPENT is terminal, so that corruption is unrecoverable by discovery.
        it("forward receipt evidence to persistNoteUpdates so the SPENT gate cannot be skipped", async () => {
            const receipt = {
                status: true,
                blockNumber: "0x1" as Hex,
                txHash: "0xrelayed" as Hex,
                logs: [{ address: VALID_POOL }],
            };
            const rpcInteractor = createMockRPCInteractor();
            vi.mocked(rpcInteractor.waitForTransactionReceipt).mockResolvedValue(
                receipt as unknown as Awaited<
                    ReturnType<IRPCInteractor["waitForTransactionReceipt"]>
                >,
            );
            service = new PoolSessionWithdrawAndSwap({
                chainId: POOL_CHAIN_ID,
                core,
                relayerInteractor,
                rpcInteractor,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: rpcInteractor }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor: createMockEntrypointInteractor(),
            });

            await service.relayWithdrawAndSwap(buildSwapParams());

            expect(core.persistNoteUpdates).toHaveBeenCalledWith(
                [MOCK_NOTE],
                [MOCK_CHANGE_PENDING_NOTE],
                receipt.txHash,
                { expectedNullifiers: [MOCK_SPENT_NULLIFIER], receiptLogs: receipt.logs },
            );
        });

        it("reject a commitment whose asset differs from the withdraw tokenId", async () => {
            const params = buildSwapParams();
            params.selectedQuote.quote.feeCommitment.asset = VALID_OUTPUT_TOKEN;
            await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                "feeCommitment.asset",
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("throw InvalidTransactParams when quote.amountSent is inflated", async () => {
            const params = buildSwapParams({ amountSent: "200" });
            await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                InvalidTransactParams,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("throw InvalidTransactParams when quote.amountSent is deflated", async () => {
            const params = buildSwapParams({ amountSent: "50" });
            await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                InvalidTransactParams,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("throw when the caller passes the gross amount instead of netAmount", async () => {
            // Real relayer echoes the gross withdrawal as amountSent. `amount` is AMOUNT
            // (100); pointing amountSent at the same gross value models a caller who
            // forwarded the gross amount rather than netAmount (= gross − fee). The
            // assert amountSent == amount + fee (100 == 110) then fails — the mismatch
            // the masking mock used to hide.
            const params = buildSwapParams({ amountSent: AMOUNT_DECIMAL });
            await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                InvalidTransactParams,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject quote whose encoded recipient differs from caller recipientAddress", async () => {
            const params = buildSwapParams({
                recipientInData: "0x9999999999999999999999999999999999999999" as Address,
            });
            await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                InvalidTransactParams,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject quote whose encoded swapCalldata differs from caller swapCalldata", async () => {
            const params = buildSwapParams({ swapCalldataInData: OTHER_SWAP_CALLDATA });
            await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                InvalidTransactParams,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        describe("fallbackAddress validation", () => {
            it("pass when fallbackAddress defaults to recipient and routing matches", async () => {
                // No callerFallback → defaults to recipientAddress
                // Routing fallbackAddress = VALID_RECIPIENT (default)
                const params = buildSwapParams();
                await expect(service.relayWithdrawAndSwap(params)).resolves.toBeDefined();
            });

            it("pass when explicit fallbackAddress matches routing", async () => {
                const params = buildSwapParams({
                    callerFallback: VALID_FALLBACK,
                    fallbackInData: VALID_FALLBACK,
                });
                await expect(service.relayWithdrawAndSwap(params)).resolves.toBeDefined();
            });

            it("reject when routing fallbackAddress differs from caller fallbackAddress", async () => {
                const params = buildSwapParams({
                    callerFallback: VALID_FALLBACK,
                    fallbackInData: "0x9999999999999999999999999999999999999999" as Address,
                });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                    InvalidTransactParams,
                );
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("reject when routing fallbackAddress differs from default (recipient)", async () => {
                // No callerFallback → defaults to recipientAddress (VALID_RECIPIENT)
                // But routing has a different fallback
                const params = buildSwapParams({
                    fallbackInData: "0x9999999999999999999999999999999999999999" as Address,
                });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                    InvalidTransactParams,
                );
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("match fallbackAddress case-insensitively", async () => {
                const lower = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab" as Address;
                const checksummed = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab" as Address;
                const params = buildSwapParams({
                    callerFallback: checksummed,
                    fallbackInData: lower,
                });
                await expect(service.relayWithdrawAndSwap(params)).resolves.toBeDefined();
            });
        });

        describe("relayer chain validation", () => {
            it("reject when relayer chainId differs from pool chainId", async () => {
                const params = buildSwapParams();
                params.selectedQuote.relayerInfo.chainId = 999;
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                    InvalidTransactParams,
                );
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("pass when relayer chainId matches pool chainId", async () => {
                const params = buildSwapParams();
                await expect(service.relayWithdrawAndSwap(params)).resolves.toBeDefined();
            });
        });

        describe("cross-chain validation", () => {
            const DEST_CHAIN_ID = 10;

            function buildCrossChainParams(
                overrides?: Parameters<typeof buildSwapParams>[0],
            ): ExecuteWithdrawAndSwapRelayerParams {
                return buildSwapParams({
                    toChainId: DEST_CHAIN_ID,
                    callerFallback: VALID_FALLBACK,
                    fallbackInData: VALID_FALLBACK,
                    callerMinOutputAmount: "0x0" as Hex,
                    recipientInData: EMPTY_ADDRESS,
                    minOutputAmountInData: 0n,
                    nativeGasInData: 0n,
                    dustInData: VALID_RELAY, // cross-chain dust default = relayer
                    ...overrides,
                });
            }

            it("pass when routing has zero recipient, zero minOutput, and zero nativeGas", async () => {
                const params = buildCrossChainParams();
                await expect(service.relayWithdrawAndSwap(params)).resolves.toBeDefined();
                expect(core.prepareTransact).toHaveBeenCalledOnce();
            });

            it("throw InvalidTransactParams when fallbackAddress is missing", async () => {
                const params = buildCrossChainParams({ callerFallback: undefined });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                    "fallbackAddress is required for cross-chain swaps",
                );
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("reject an empty-address-sentinel cross-chain fallback at relay time", async () => {
                const params = buildCrossChainParams({
                    callerFallback: EMPTY_ADDRESS,
                    fallbackInData: EMPTY_ADDRESS,
                });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow("empty-address sentinel");
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("throw InvalidTransactParams when caller minOutputAmount is nonzero", async () => {
                const params = buildCrossChainParams({ callerMinOutputAmount: "0x01" as Hex });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                    "minOutputAmount must be 0 for cross-chain swaps",
                );
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("reject routing whose recipient is not the zero-address sentinel", async () => {
                const params = buildCrossChainParams({ recipientInData: VALID_RECIPIENT });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                    InvalidTransactParams,
                );
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("reject routing with nonzero nativeGas", async () => {
                const params = buildCrossChainParams({ nativeGasInData: 1n });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                    "nativeGas 1 must be 0 when extraGas was not requested",
                );
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("treat toChainId equal to the relayer chain as same-chain", async () => {
                // Same chainId → same-chain path: nonzero recipient + minOutput expected
                const params = buildSwapParams({ toChainId: POOL_CHAIN_ID });
                await expect(service.relayWithdrawAndSwap(params)).resolves.toBeDefined();
            });
        });

        describe("routing tuple validation", () => {
            // Regression: the same-chain execute path previously passed `nativeGas:
            // undefined`, which SKIPPED this check entirely — a hand-built params
            // flow never validated the routing's top-up. It is now always validated.
            it("reject same-chain routing with nonzero nativeGas when extraGas was not requested", async () => {
                const params = buildSwapParams({ nativeGasInData: 5n });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                    "nativeGas 5 must be 0 when extraGas was not requested",
                );
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("accept same-chain routing with a relayer-funded top-up when extraGas is echoed", async () => {
                const params = buildSwapParams({
                    nativeGasInData: MOCK_RELAYER_TOP_UP,
                    callerExtraGas: true,
                });
                await expect(service.relayWithdrawAndSwap(params)).resolves.toBeDefined();
            });

            it("reject same-chain routing whose top-up is zero although extraGas was requested", async () => {
                const params = buildSwapParams({ callerExtraGas: true });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                    "nativeGas is 0 although extraGas was requested",
                );
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("reject routing whose outputToken differs from params", async () => {
                const params = buildSwapParams({
                    outputTokenInData: "0x9999999999999999999999999999999999999999" as Address,
                });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow("outputToken");
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("reject routing whose dustRecipient differs from the same-chain default", async () => {
                const params = buildSwapParams({
                    dustInData: "0x9999999999999999999999999999999999999999" as Address,
                });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow("dustRecipient");
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("accept routing whose dustRecipient matches an explicit caller dustRecipient", async () => {
                const explicitDust = "0x7777777777777777777777777777777777777777" as Address;
                const params = buildSwapParams({
                    dustInData: explicitDust,
                    callerDustRecipient: explicitDust,
                });
                await expect(service.relayWithdrawAndSwap(params)).resolves.toBeDefined();
            });

            it("reject routing whose feeAmount differs from the quote feeAmount", async () => {
                const params = buildSwapParams({ feeAmountInData: 99n });
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow("feeAmount");
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("reject routing whose swapTarget differs from the caller's expected target", async () => {
                const params = { ...buildSwapParams(), swapTarget: VALID_PROCESSOR };
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow("swapTarget");
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("reject routing whose approvalAddress differs from the caller's expected", async () => {
                const params = { ...buildSwapParams(), approvalAddress: VALID_PROCESSOR };
                await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                    "approvalAddress",
                );
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("reject hand-built routing that targets or approves the swap executor", async () => {
                const executor = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;
                await expect(
                    service.relayWithdrawAndSwap(buildSwapParams({ swapTargetInData: executor })),
                ).rejects.toThrow(UnexpectedTransactionTarget);
                await expect(
                    service.relayWithdrawAndSwap(buildSwapParams({ approvalAddressInData: executor })),
                ).rejects.toThrow(UnexpectedTransactionTarget);
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("relay when expected swapTarget and approvalAddress match the routing", async () => {
                const params = {
                    ...buildSwapParams(),
                    swapTarget: VALID_SWAP_TARGET,
                    approvalAddress: VALID_APPROVAL_ADDRESS,
                };
                await expect(service.relayWithdrawAndSwap(params)).resolves.toBeDefined();
                expect(core.prepareTransact).toHaveBeenCalledOnce();
            });
        });

        it("reject an expired fee commitment before building the proof", async () => {
            const params = buildSwapParams();
            params.selectedQuote.quote.feeCommitment.expiration = Date.now() - 1;
            await expect(service.relayWithdrawAndSwap(params)).rejects.toThrow(
                FeeCommitmentExpired,
            );
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });
    });

    describe("prepareSwapQuote", () => {
        const DEST_CHAIN_ID = 10;
        const TO_AMOUNT_MIN = "990000";
        const TO_AMOUNT = "1000000";

        let relayerInteractor: IRelayerInteractor;
        let swapQuoteProvider: ISwapQuoteProvider;
        let entrypointInteractor: IEntrypointInteractor;
        let rpcInteractor: IRPCInteractor;
        let service: PoolSessionWithdrawAndSwap;

        /** Honest relayer: signs a routing tuple mirroring the quote request. */
        function mockHonestRelayerQuote(): void {
            vi.mocked(relayerInteractor.getSwapQuote).mockImplementation(
                async (_relayer, req: SwapQuoteParams) => ({
                    txCost: "0",
                    gasPrice: "0",
                    feeAmount: FEE_AMOUNT,
                    feeCommitment: {
                        data: encodeAbiParameters(RELAY_SWAP_ROUTING_ABI, [
                            {
                                swapTarget: (req.swapTarget ?? VALID_SWAP_TARGET) as Address,
                                approvalAddress: (req.approvalAddress ??
                                    req.swapTarget ??
                                    VALID_APPROVAL_ADDRESS) as Address,
                                outputToken: req.outputToken as Address,
                                recipient: req.recipient as Address,
                                feeRecipient: VALID_RELAY,
                                fallbackAddress: (req.fallbackAddress ?? req.recipient) as Address,
                                dustRecipient: req.dustRecipient as Address,
                                feeAmount: BigInt(FEE_AMOUNT),
                                minOutputAmount: BigInt(req.minOutputAmount),
                                // Model the real relayer: the flag resolves to a
                                // relayer-computed top-up amount in the signed routing.
                                nativeGas: req.extraGas ? MOCK_RELAYER_TOP_UP : 0n,
                                swapValue: 0n,
                                gasSwapMaxInput: 0n,
                                gasSwapCalldata: "0x",
                                swapCalldata: (req.swapCalldata ?? SWAP_CALLDATA) as Hex,
                                dustRescue: {
                                    chainId: 0n,
                                    tokenId:
                                        "0x0000000000000000000000000000000000000000" as Address,
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
                        // Model the real relayer: amountSent echoes the GROSS request
                        // amount (evm.quote.service sets `amountSent: amount`), NOT
                        // amount + fee. The net (gross − fee) surfaces as netAmount.
                        amountSent: BigInt(req.amount).toString(),
                    },
                }),
            );
        }

        function buildService(): void {
            service = new PoolSessionWithdrawAndSwap({
                chainId: POOL_CHAIN_ID,
                core: createMockCore(),
                relayerInteractor,
                rpcInteractor,
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
                swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: rpcInteractor }),
                relaySwapsAddress: VALID_RELAY_SWAPS,
                entrypointInteractor,
                swapQuoteProvider,
            });
        }

        beforeEach(() => {
            relayerInteractor = createMockRelayerInteractor();
            mockHonestRelayerQuote();
            entrypointInteractor = createMockEntrypointInteractor();
            rpcInteractor = createMockRPCInteractor();
            // Default: CalldataVerificationFacet returns VALID_RECIPIENT at tuple index 2.
            vi.mocked(rpcInteractor.readContract).mockResolvedValue([
                VALID_SWAP_TARGET,
                0n,
                VALID_RECIPIENT,
            ]);
            swapQuoteProvider = {
                getSwapQuote: vi.fn(
                    async (req: {
                        fromToken: Address;
                        toToken: Address;
                        fromChainId: number;
                        toChainId: number;
                        amount: string;
                    }) => ({
                        transactionData: SWAP_CALLDATA,
                        transactionTo: VALID_SWAP_TARGET,
                        approvalAddress: VALID_APPROVAL_ADDRESS,
                        // Fixed-input swap: LiFi echoes the requested net (amount − fee) as
                        // fromAmount. assertLifiBudget reads it to bound the dust.
                        fromAmount: req.amount,
                        toAmount: TO_AMOUNT,
                        toAmountMin: TO_AMOUNT_MIN,
                        fromTokenAddress: req.fromToken,
                        toTokenAddress: req.toToken,
                        fromChainId: req.fromChainId,
                        toChainId: req.toChainId,
                    }),
                ),
            } as unknown as ISwapQuoteProvider;
            buildService();
        });

        function baseQuoteParams(): PrepareSwapQuoteParams {
            return {
                relayerInfo: {
                    url: "https://relay.test",
                    name: "test-relay",
                    chainId: POOL_CHAIN_ID,
                    chainType: "evm" as const,
                    status: "active" as const,
                    address: VALID_RELAY,
                    processorAddress: VALID_PROCESSOR,
                },
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                outputToken: VALID_OUTPUT_TOKEN,
                recipientAddress: VALID_RECIPIENT,
            };
        }

        it("reject a quote whose approval spender or target is the swap executor", async () => {
            const executor = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;
            for (const field of ["approvalAddress", "transactionTo"] as const) {
                const base = vi.mocked(swapQuoteProvider.getSwapQuote).getMockImplementation()!;
                vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementationOnce(async (req) => ({
                    ...(await base(req)),
                    [field]: executor,
                }));
                await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                    UnexpectedTransactionTarget,
                );
            }
            expect(vi.mocked(relayerInteractor.getSwapQuote)).not.toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ commit: true }),
            );
        });

        it("reject a cross-chain empty-address fallbackAddress", async () => {
            await expect(
                service.prepareSwapQuote({
                    ...baseQuoteParams(),
                    toChainId: DEST_CHAIN_ID,
                    fallbackAddress: EMPTY_ADDRESS,
                }),
            ).rejects.toThrow("empty-address sentinel");
        });

        describe("yield share input (RelaySwaps unwrap)", () => {
            const UNDERLYING = "0x0000000000000000000000000000000000005dc0" as Address;
            const ZAP = "0x0000000000000000000000000000000000000a99" as Address;
            /** 1 share redeems to 2 underlying units — keeps share/underlying amounts distinguishable. */
            const RATE = 2n;
            let yieldToken: IPPYieldTokenInteractor;

            function mockZapAllowlist(approved: boolean): void {
                vi.mocked(rpcInteractor.readContract).mockImplementation(
                    async (req: { functionName?: string }) =>
                        req.functionName === "approvedZaps"
                            ? approved
                            : [VALID_SWAP_TARGET, 0n, VALID_RECIPIENT],
                );
            }

            function buildYieldService(): void {
                service = new PoolSessionWithdrawAndSwap({
                    chainId: POOL_CHAIN_ID,
                    core: createMockCore(),
                    relayerInteractor,
                    rpcInteractor,
                    addressEqualityComparator: new EvmAddressEqualityComparator(),
                    emptyAddress: EMPTY_ADDRESS,
                    swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
                    relaySwapsAddress: VALID_RELAY_SWAPS,
                    entrypointInteractor,
                    swapQuoteProvider,
                    yieldWrappers: [
                        {
                            shareToken: VALID_TOKEN,
                            underlying: UNDERLYING,
                            zap: ZAP,
                            previewRedeem: (shares: bigint) => yieldToken.previewRedeem(shares),
                        },
                    ],
                });
            }

            beforeEach(() => {
                yieldToken = {
                    getAddress: vi.fn(() => VALID_TOKEN),
                    previewRedeem: vi.fn(async (shares: bigint) => shares * RATE),
                } as unknown as IPPYieldTokenInteractor;
                mockZapAllowlist(true);
                buildYieldService();
            });

            it("quote LiFi on the underlying for previewRedeem(net shares) while the relayer is quoted on the share", async () => {
                const result = await service.prepareSwapQuote(baseQuoteParams());

                // Relayer: both quotes name the SHARE and the gross share amount (fee in shares).
                const relayerCalls = vi.mocked(relayerInteractor.getSwapQuote).mock.calls;
                expect(relayerCalls).toHaveLength(2);
                expect(relayerCalls[0][1].asset).toBe(VALID_TOKEN);
                expect(relayerCalls[1][1].asset).toBe(VALID_TOKEN);
                expect(relayerCalls[1][1].amount).toBe(AMOUNT_DECIMAL);

                // LiFi: quoted on the UNDERLYING for what the net shares redeem to.
                // AMOUNT 100 − fee 10 − buffer (30bps of 100 = 0) = 90 shares → 180 underlying.
                const lifiReq = vi.mocked(swapQuoteProvider.getSwapQuote).mock.calls[0][0];
                expect(lifiReq.fromToken).toBe(UNDERLYING);
                expect(lifiReq.amount).toBe("180");
                expect(yieldToken.previewRedeem).toHaveBeenCalledWith(90n);

                // Registry checked on RelaySwaps (the actual on-chain zap caller) before any
                // commitment was taken.
                expect(rpcInteractor.readContract).toHaveBeenCalledWith(
                    expect.objectContaining({
                        address: VALID_RELAY_SWAPS,
                        functionName: "approvedZaps",
                        args: [ZAP],
                    }),
                );

                expect(result.swapInputToken).toBe(UNDERLYING);
                // netAmount forwarded to the relay leg stays in SHARES (gross − fee).
                expect(BigInt(result.netAmount)).toBe(90n);
                // Committed net (90 shares → 180 underlying) minus LiFi input (180): no dust.
                expect(BigInt(result.dustAmount)).toBe(0n);
                expect(result.feeAmount).toBe(FEE_AMOUNT);
            });

            it("reject the share before taking any commitment when its zap is not allowlisted", async () => {
                mockZapAllowlist(false);
                await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                    /is not allowlisted on processor/,
                );
                expect(swapQuoteProvider.getSwapQuote).not.toHaveBeenCalled();
                // Only the preliminary (non-committing) relayer quote ran.
                expect(vi.mocked(relayerInteractor.getSwapQuote).mock.calls).toHaveLength(1);
                expect(vi.mocked(relayerInteractor.getSwapQuote).mock.calls[0][1].commit).toBe(
                    false,
                );
            });

            it("reject the share when the deployment names no zap", async () => {
                service = new PoolSessionWithdrawAndSwap({
                    chainId: POOL_CHAIN_ID,
                    core: createMockCore(),
                    relayerInteractor,
                    rpcInteractor,
                    addressEqualityComparator: new EvmAddressEqualityComparator(),
                    emptyAddress: EMPTY_ADDRESS,
                    swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor }),
                    relaySwapsAddress: VALID_RELAY_SWAPS,
                    entrypointInteractor,
                    swapQuoteProvider,
                    yieldWrappers: [
                        {
                            shareToken: VALID_TOKEN,
                            underlying: UNDERLYING,
                            previewRedeem: (shares: bigint) => yieldToken.previewRedeem(shares),
                        },
                    ],
                });
                await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                    /has no zap configured/,
                );
                expect(swapQuoteProvider.getSwapQuote).not.toHaveBeenCalled();
            });

            it("reject when the net shares redeem to nothing", async () => {
                vi.mocked(yieldToken.previewRedeem).mockResolvedValue(0n);
                await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                    /Net swap input is zero/,
                );
                expect(swapQuoteProvider.getSwapQuote).not.toHaveBeenCalled();
                // Only the share figure: the message's other number is in the
                // underlying and is zero here anyway.
                const error = await service
                    .prepareSwapQuote(baseQuoteParams())
                    .catch((e: unknown) => e);
                expect(hasErrorAmounts(error) && error.amounts?.code).toBe("yieldRedeemsToNothing");
                expect(hasErrorAmounts(error) && error.amounts?.side).toBe("spent");
            });

            it("check the LiFi budget in underlying units against the committed net shares", async () => {
                // LiFi asks for more underlying than the committed net shares redeem to.
                vi.mocked(swapQuoteProvider.getSwapQuote).mockImplementation(async (req) => ({
                    transactionData: SWAP_CALLDATA,
                    transactionTo: VALID_SWAP_TARGET,
                    approvalAddress: VALID_APPROVAL_ADDRESS,
                    fromAmount: "181",
                    toAmount: TO_AMOUNT,
                    toAmountMin: TO_AMOUNT_MIN,
                    estimatedDuration: 0,
                    fromTokenAddress: req.fromToken,
                    toTokenAddress: req.toToken,
                    fromChainId: req.fromChainId,
                    toChainId: req.toChainId,
                }));
                await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                    /LiFi needs 181 input but only 180 available/,
                );
            });

            it("leave a non-yield token on the plain path even when wrappers are configured", async () => {
                const OTHER_TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
                const result = await service.prepareSwapQuote({
                    ...baseQuoteParams(),
                    tokenId: OTHER_TOKEN,
                });
                const lifiReq = vi.mocked(swapQuoteProvider.getSwapQuote).mock.calls[0][0];
                expect(lifiReq.fromToken).toBe(OTHER_TOKEN);
                expect(lifiReq.amount).toBe("90");
                expect(result.swapInputToken).toBe(OTHER_TOKEN);
                expect(yieldToken.previewRedeem).not.toHaveBeenCalled();
                expect(rpcInteractor.readContract).not.toHaveBeenCalledWith(
                    expect.objectContaining({ functionName: "approvedZaps" }),
                );
            });
        });

        it("send the real recipient and LiFi toAmountMin for same-chain quotes", async () => {
            const result = await service.prepareSwapQuote(baseQuoteParams());

            const committedCall = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[1][1];
            expect(committedCall.recipient).toBe(VALID_RECIPIENT);
            expect(committedCall.minOutputAmount).toBe(TO_AMOUNT_MIN);
            expect(committedCall.dustRecipient).toBe(VALID_RECIPIENT);
            expect(result.minOutputAmount).toBe(`0x${BigInt(TO_AMOUNT_MIN).toString(16)}`);
            expect(result.destinationMinOutputAmount).toBe(
                `0x${BigInt(TO_AMOUNT_MIN).toString(16)}`,
            );
        });

        it("throw InvalidTransactParams for cross-chain quote without fallbackAddress", async () => {
            await expect(
                service.prepareSwapQuote({ ...baseQuoteParams(), toChainId: DEST_CHAIN_ID }),
            ).rejects.toThrow("fallbackAddress is required for cross-chain swaps");
        });

        it("throw InvalidTransactParams for cross-chain quote with extraGas", async () => {
            await expect(
                service.prepareSwapQuote({
                    ...baseQuoteParams(),
                    toChainId: DEST_CHAIN_ID,
                    fallbackAddress: VALID_FALLBACK,
                    extraGas: true,
                }),
            ).rejects.toThrow("extraGas is not supported for cross-chain swaps");
        });

        it("forward extraGas to both relayer quotes and accept the relayer-funded top-up in the routing", async () => {
            await service.prepareSwapQuote({ ...baseQuoteParams(), extraGas: true });

            const prelimCall = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[0][1];
            const committedCall = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[1][1];
            expect(prelimCall.extraGas).toBe(true);
            expect(committedCall.extraGas).toBe(true);
        });

        it("reject a committed routing whose top-up was zeroed out although extraGas was requested", async () => {
            // Dishonest relayer: accepts the extraGas flag but signs nativeGas = 0 —
            // the user pre-pays (fee) for a top-up the recipient never receives.
            vi.mocked(relayerInteractor.getSwapQuote).mockImplementation(
                async (_relayer, req: SwapQuoteParams) => ({
                    txCost: "0",
                    gasPrice: "0",
                    feeAmount: FEE_AMOUNT,
                    feeCommitment: {
                        data: encodeAbiParameters(RELAY_SWAP_ROUTING_ABI, [
                            {
                                swapTarget: (req.swapTarget ?? VALID_SWAP_TARGET) as Address,
                                approvalAddress: (req.approvalAddress ??
                                    req.swapTarget ??
                                    VALID_APPROVAL_ADDRESS) as Address,
                                outputToken: req.outputToken as Address,
                                recipient: req.recipient as Address,
                                feeRecipient: VALID_RELAY,
                                fallbackAddress: (req.fallbackAddress ?? req.recipient) as Address,
                                dustRecipient: req.dustRecipient as Address,
                                feeAmount: BigInt(FEE_AMOUNT),
                                minOutputAmount: BigInt(req.minOutputAmount),
                                nativeGas: 0n,
                                swapValue: 0n,
                                gasSwapMaxInput: 0n,
                                gasSwapCalldata: "0x",
                                swapCalldata: (req.swapCalldata ?? SWAP_CALLDATA) as Hex,
                                dustRescue: {
                                    chainId: 0n,
                                    tokenId:
                                        "0x0000000000000000000000000000000000000000" as Address,
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

            await expect(
                service.prepareSwapQuote({ ...baseQuoteParams(), extraGas: true }),
            ).rejects.toThrow("nativeGas is 0 although extraGas was requested");
        });

        it("send the zero-address sentinel and zero minOutput for cross-chain quotes", async () => {
            const result = await service.prepareSwapQuote({
                ...baseQuoteParams(),
                toChainId: DEST_CHAIN_ID,
                fallbackAddress: VALID_FALLBACK,
            });

            // Both relayer quotes use the sentinel
            for (const call of vi.mocked(relayerInteractor.getSwapQuote).mock.calls) {
                expect(call[1].recipient).toBe(EMPTY_ADDRESS);
            }
            const committedCall = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[1][1];
            expect(committedCall.minOutputAmount).toBe("0");
            // Dust defaults to the relayer on cross-chain (recipient is destination-chain)
            expect(committedCall.dustRecipient).toBe(VALID_RELAY);
            expect(committedCall.fallbackAddress).toBe(VALID_FALLBACK);

            // LiFi quote goes to the destination chain with the real recipient
            const lifiCall = vi.mocked(swapQuoteProvider.getSwapQuote).mock.calls[0][0];
            expect(lifiCall.toChainId).toBe(DEST_CHAIN_ID);
            expect(lifiCall.toAddress).toBe(VALID_RECIPIENT);
            expect(lifiCall.fallbackAddress).toBe(VALID_FALLBACK);

            // On-chain minOutput is zero; LiFi minimum surfaces separately
            expect(result.minOutputAmount).toBe("0x0");
            expect(result.destinationMinOutputAmount).toBe(
                `0x${BigInt(TO_AMOUNT_MIN).toString(16)}`,
            );
        });

        it("respect an explicit dustRecipient for cross-chain quotes", async () => {
            const explicitDust = "0x7777777777777777777777777777777777777777" as Address;
            await service.prepareSwapQuote({
                ...baseQuoteParams(),
                toChainId: DEST_CHAIN_ID,
                fallbackAddress: VALID_FALLBACK,
                dustRecipient: explicitDust,
            });

            const committedCall = vi.mocked(relayerInteractor.getSwapQuote).mock.calls[1][1];
            expect(committedCall.dustRecipient).toBe(explicitDust);
        });

        it("echo the validated swapTarget and approvalAddress in the result", async () => {
            const result = await service.prepareSwapQuote(baseQuoteParams());
            expect(result.swapTarget.toLowerCase()).toBe(VALID_SWAP_TARGET.toLowerCase());
            expect(result.approvalAddress.toLowerCase()).toBe(VALID_APPROVAL_ADDRESS.toLowerCase());
        });

        it("echo an explicit dustRecipient in the result for prepare→relay passthrough", async () => {
            const explicitDust = "0x7777777777777777777777777777777777777777" as Address;
            const result = await service.prepareSwapQuote({
                ...baseQuoteParams(),
                dustRecipient: explicitDust,
            });
            expect(result.dustRecipient).toBe(explicitDust);
        });

        it("echo the default dustRecipient (recipient) for same-chain quotes", async () => {
            const result = await service.prepareSwapQuote(baseQuoteParams());
            expect(result.dustRecipient).toBe(VALID_RECIPIENT);
        });

        it("echo the default dustRecipient (relayer) for cross-chain quotes", async () => {
            const result = await service.prepareSwapQuote({
                ...baseQuoteParams(),
                toChainId: DEST_CHAIN_ID,
                fallbackAddress: VALID_FALLBACK,
            });
            expect(result.dustRecipient).toBe(VALID_RELAY);
        });

        it("echo the relayer chain as toChainId for same-chain quotes", async () => {
            const result = await service.prepareSwapQuote(baseQuoteParams());
            expect(result.toChainId).toBe(POOL_CHAIN_ID);
        });

        it("echo the destination chain as toChainId for cross-chain quotes", async () => {
            const result = await service.prepareSwapQuote({
                ...baseQuoteParams(),
                toChainId: DEST_CHAIN_ID,
                fallbackAddress: VALID_FALLBACK,
            });
            expect(result.toChainId).toBe(DEST_CHAIN_ID);
        });

        it("throw RelayFeeExceedsMax when the fee exceeds a nonzero maxRelayFee", async () => {
            entrypointInteractor = createMockEntrypointInteractor({ maxRelayFee: "0x1" as Hex });
            buildService();

            await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                RelayFeeExceedsMax,
            );
        });

        it("allow any fee below the amount when maxRelayFee is zero", async () => {
            // Default mock has maxRelayFee 0x0 — fee 10 of amount 100 passes
            await expect(service.prepareSwapQuote(baseQuoteParams())).resolves.toBeDefined();
        });

        it("throw InvalidTransactParams when the fee consumes the whole amount", async () => {
            vi.mocked(relayerInteractor.getSwapQuote).mockResolvedValue({
                txCost: "0",
                gasPrice: "0",
                feeAmount: "100", // == AMOUNT
            } as never);

            await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                "consumes the entire withdrawal amount",
            );
            // The figures travel as fields so a caller can render them without
            // parsing that sentence. They are in the WITHDRAWN token, not the
            // swap's output token, which is the one the user picked.
            const error = await service
                .prepareSwapQuote(baseQuoteParams())
                .catch((e: unknown) => e);
            expect(hasErrorAmounts(error) && error.amounts).toEqual({
                code: "relayFeeConsumesWithdrawal",
                side: "spent",
                values: { fee: 100n, amount: 100n },
            });
        });

        it("throw SwapQuoteMismatch when LiFi routes a different output token", async () => {
            vi.mocked(swapQuoteProvider.getSwapQuote).mockResolvedValue({
                transactionData: SWAP_CALLDATA,
                transactionTo: VALID_SWAP_TARGET,
                approvalAddress: VALID_APPROVAL_ADDRESS,
                toAmount: TO_AMOUNT,
                toAmountMin: TO_AMOUNT_MIN,
                fromTokenAddress: VALID_TOKEN,
                toTokenAddress: "0x9999999999999999999999999999999999999999" as Address,
                fromChainId: POOL_CHAIN_ID,
                toChainId: POOL_CHAIN_ID,
            } as never);

            await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                SwapQuoteMismatch,
            );
        });

        it("throw SwapQuoteMismatch when LiFi routes a different destination chain", async () => {
            vi.mocked(swapQuoteProvider.getSwapQuote).mockResolvedValue({
                transactionData: SWAP_CALLDATA,
                transactionTo: VALID_SWAP_TARGET,
                approvalAddress: VALID_APPROVAL_ADDRESS,
                toAmount: TO_AMOUNT,
                toAmountMin: TO_AMOUNT_MIN,
                fromTokenAddress: VALID_TOKEN,
                toTokenAddress: VALID_OUTPUT_TOKEN,
                fromChainId: POOL_CHAIN_ID,
                toChainId: 999,
            } as never);

            await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                SwapQuoteMismatch,
            );
        });

        it("reject a committed routing whose dustRecipient was tampered by the relayer", async () => {
            // Relayer signs a different dustRecipient than requested
            const honest = vi.mocked(relayerInteractor.getSwapQuote).getMockImplementation()!;
            vi.mocked(relayerInteractor.getSwapQuote).mockImplementation(
                async (relayer, req: SwapQuoteParams) =>
                    honest(relayer, {
                        ...req,
                        dustRecipient: "0x9999999999999999999999999999999999999999" as Address,
                    }),
            );

            await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                "dustRecipient",
            );
        });

        it("reject a committed routing whose swapTarget differs from the LiFi quote", async () => {
            const honest = vi.mocked(relayerInteractor.getSwapQuote).getMockImplementation()!;
            vi.mocked(relayerInteractor.getSwapQuote).mockImplementation(
                async (relayer, req: SwapQuoteParams) =>
                    honest(relayer, {
                        ...req,
                        swapTarget: "0x9999999999999999999999999999999999999999" as Address,
                        approvalAddress: req.approvalAddress,
                    }),
            );

            await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow("swapTarget");
        });

        it("surface netAmount as the gross amountSent minus the fee", async () => {
            const result = await service.prepareSwapQuote(baseQuoteParams());
            const amountSent = BigInt(result.selectedQuote.quote.feeCommitment.amountSent);
            // Real relayer echoes the gross request (AMOUNT) as amountSent — not amount + fee.
            expect(amountSent).toBe(BigInt(AMOUNT));
            // netAmount is the value the caller forwards as relayWithdrawAndSwap's `amount`.
            expect(BigInt(result.netAmount)).toBe(amountSent - BigInt(result.feeAmount));
        });

        it("throw InvalidTransactParams when committed amountSent differs from requested gross withdrawal", async () => {
            // Use the honest mock for the prelim call, then tamper amountSent on the committed call.
            const honest = vi.mocked(relayerInteractor.getSwapQuote).getMockImplementation()!;
            let callIndex = 0;
            vi.mocked(relayerInteractor.getSwapQuote).mockImplementation(
                async (relayer, req: SwapQuoteParams) => {
                    callIndex++;
                    const result = (await honest(relayer, req)) as SwapRelayerQuote;
                    if (callIndex === 1) return result;
                    // Committed call: relayer inflates amountSent to extract more from the pool.
                    return {
                        ...result,
                        feeCommitment: { ...result.feeCommitment, amountSent: "200" },
                    };
                },
            );

            await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow("amountSent");
            callIndex = 0;
            const error = await service
                .prepareSwapQuote(baseQuoteParams())
                .catch((e: unknown) => e);
            expect(hasErrorAmounts(error) && error.amounts).toEqual({
                code: "commitmentAmountSentMismatch",
                side: "spent",
                values: { amountSent: 200n, expected: 100n },
            });
        });

        it("throw InvalidTransactParams when a same-chain quote returns toAmountMin = 0", async () => {
            vi.mocked(swapQuoteProvider.getSwapQuote).mockResolvedValueOnce({
                transactionData: SWAP_CALLDATA,
                transactionTo: VALID_SWAP_TARGET,
                approvalAddress: VALID_APPROVAL_ADDRESS,
                toAmount: TO_AMOUNT,
                toAmountMin: "0",
                fromTokenAddress: VALID_TOKEN,
                toTokenAddress: VALID_OUTPUT_TOKEN,
                fromChainId: POOL_CHAIN_ID,
                toChainId: POOL_CHAIN_ID,
            } as never);

            await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                InvalidTransactParams,
            );
        });

        it("accept a cross-chain quote with toAmountMin = 0 (source-chain output goes to contract)", async () => {
            vi.mocked(swapQuoteProvider.getSwapQuote).mockResolvedValueOnce({
                transactionData: SWAP_CALLDATA,
                transactionTo: VALID_SWAP_TARGET,
                approvalAddress: VALID_APPROVAL_ADDRESS,
                fromAmount: "90", // net = 100 gross − 10 fee
                toAmount: TO_AMOUNT,
                toAmountMin: "0",
                fromTokenAddress: VALID_TOKEN,
                toTokenAddress: VALID_OUTPUT_TOKEN,
                fromChainId: POOL_CHAIN_ID,
                toChainId: DEST_CHAIN_ID,
            } as never);

            await expect(
                service.prepareSwapQuote({
                    ...baseQuoteParams(),
                    toChainId: DEST_CHAIN_ID,
                    fallbackAddress: VALID_FALLBACK,
                }),
            ).resolves.toBeDefined();
        });

        it("throw LiFiRecipientNotFound when the Diamond decodes a different recipient from transactionData", async () => {
            vi.mocked(rpcInteractor.readContract).mockResolvedValueOnce([
                VALID_SWAP_TARGET,
                0n,
                "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Address,
            ]);

            await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                LiFiRecipientNotFound,
            );
        });

        it("throw when the CalldataVerificationFacet call reverts on malformed transactionData", async () => {
            vi.mocked(rpcInteractor.readContract).mockRejectedValueOnce(
                new Error("execution reverted: InvalidCallData"),
            );

            await expect(service.prepareSwapQuote(baseQuoteParams())).rejects.toThrow(
                "execution reverted",
            );
        });
    });
});
