import { encodeAbiParameters } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    ExecuteWithdrawRelayerParams,
    FinalizedBlockResult,
    Hash,
    Hex,
    IRelayerInteractor,
    IRPCInteractor,
    Note,
    NoteData,
    PendingNote,
    PreparedRelayedRegistration,
    PrepareTransactResult,
    Secret,
    TransactProof,
    WithdrawParams,
} from "../../../src/internal.js";
import {
    AddressSchema,
    assertPayoutRoutingMatchesQuote,
    EMPTY_ADDRESS,
    EvmPayoutRoutingCodec,
    EvmPreparedTxVerifier,
    FeeCommitmentExpired,
    InsufficientTransactValue,
    InvalidTransactParams,
    NoteStatus,
    PAYOUT_ROUTING_ABI,
    PoolSessionWithdraw,
    RegistrationDeadlineInPast,
    TransactNoteNotActive,
    TransactOrchestrator,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";

// --- Constants ---

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const VALID_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const VALID_VALUE = "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000" as Hex; // 1e18
const HALF_VALUE = "0x00000000000000000000000000000000000000000000000006f05b59d3b20000" as Hex; // 5e17
const MOCK_SECRET = "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
const MOCK_COMMITMENT_1 =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const MOCK_LABEL = "0x4444444444444444444444444444444444444444444444444444444444444444" as Hex;
const MOCK_NOTE_ADDRESS_HASH =
    "0x5555555555555555555555555555555555555555555555555555555555555555" as Hex;
const VALID_RECIPIENT = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const VALID_RELAY = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;
const VALID_PROCESSOR = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
const ZERO_FEE = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

const MOCK_OUTPUT_COMMITMENT =
    "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;
const MOCK_NULLIFIER = "0x8888888888888888888888888888888888888888888888888888888888888888" as Hex;

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

// --- Mock pending notes ---

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

// --- Default prepareTransact result ---

function defaultPrepareTransactResult(): PrepareTransactResult {
    return {
        changePendingNotes: [MOCK_CHANGE_PENDING_NOTE],
        recipientPendingNotes: [],
        transactTx: { data: "0xabcdef" as Hex, to: VALID_POOL, value: "0x0" as Hex },
        spentNotes: [MOCK_NOTE],
        spentNullifiers: [MOCK_NULLIFIER],
        notesData: [
            { hint: `0x${"00".repeat(32)}` as Hex, data: "0xdeadbeef" as Hex },
        ] as NoteData[],
        proof: {} as TransactProof,
    };
}

// --- Mock factories ---

function createMockCore(
    opts: {
        prepareTransactResult?: PrepareTransactResult;
        prepareTransactError?: Error;
    } = {},
): TransactOrchestrator {
    const prepareTransact = opts.prepareTransactError
        ? vi.fn(async () => {
              throw opts.prepareTransactError!;
          })
        : vi.fn(async () => opts.prepareTransactResult ?? defaultPrepareTransactResult());

    return {
        ownerAddress: VALID_OWNER,
        poolAddress: VALID_POOL,
        warmMerkleCaches: vi.fn(async () => undefined),
        prepareTransact,
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
        getChainDetails: vi.fn() as never,
        getTransferQuote: vi.fn(),
        getWithdrawalQuote: vi.fn(),
        getBatchWithdrawalQuote: vi.fn(),
        relayTransfer: vi.fn(),
        relayWithdrawal: vi.fn(),
        relayBatchWithdrawal: vi.fn(),
        submitRelayedRegistration: vi.fn(),
        relayRegisterAndWithdrawal: vi.fn(),
        relayWithAnnounce: vi.fn(),
        getSwapQuote: vi.fn() as unknown as IRelayerInteractor["getSwapQuote"],
        relaySwap: vi.fn(),
    };
}

// --- Tests ---

describe("PoolSessionWithdraw", () => {
    describe("constructor", () => {
        it("create instance with valid config", () => {
            const core = createMockCore();
            const relayerInteractor = createMockRelayerInteractor();
            const service = new PoolSessionWithdraw({
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressSchema: AddressSchema,
                emptyAddress: EMPTY_ADDRESS,
            });
            expect(service).toBeInstanceOf(PoolSessionWithdraw);
        });
    });

    describe("prepareWithdraw", () => {
        let service: PoolSessionWithdraw;
        let core: TransactOrchestrator;
        let relayerInteractor: IRelayerInteractor;
        const validParams: WithdrawParams = {
            inputCommitments: [MOCK_COMMITMENT_1],
            amount: HALF_VALUE,
            tokenId: VALID_TOKEN,
            recipientAddress: VALID_RECIPIENT,
            relayAddress: VALID_RELAY,
            feeAmount: ZERO_FEE,
            processorAddress: VALID_PROCESSOR,
        };

        beforeEach(() => {
            core = createMockCore();
            relayerInteractor = createMockRelayerInteractor();
            service = new PoolSessionWithdraw({
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressSchema: AddressSchema,
                emptyAddress: EMPTY_ADDRESS,
            });
        });

        it("return result with changePendingNotes, callData, and to", async () => {
            const result = await service.prepareWithdraw(validParams);

            expect(result.changePendingNotes[0]!.commitment).toBe(MOCK_OUTPUT_COMMITMENT);
            expect(result.transactTx.data).toMatch(/^0x/);
            expect(result.transactTx.to).toBe(VALID_POOL);
        });

        it("call core.prepareTransact with correct amountOut", async () => {
            await service.prepareWithdraw(validParams);

            // amountOut = amount + feeAmount = HALF_VALUE + 0 = HALF_VALUE
            expect(core.prepareTransact).toHaveBeenCalledWith(
                expect.objectContaining({
                    amountOut: expect.stringMatching(/^0x/) as unknown as string,
                    tokenId: VALID_TOKEN,
                }),
            );
        });

        it("call core.prepareTransact with validated params", async () => {
            await service.prepareWithdraw(validParams);

            expect(core.prepareTransact).toHaveBeenCalledWith(
                expect.objectContaining({
                    inputCommitments: [MOCK_COMMITMENT_1],
                    amount: HALF_VALUE,
                    tokenId: VALID_TOKEN,
                    recipientAddress: VALID_RECIPIENT,
                }),
            );
        });

        it("not persist notes during prepare", async () => {
            await service.prepareWithdraw(validParams);

            expect(core.persistNoteUpdates).not.toHaveBeenCalled();
        });

        it("return spentNotes for deferred SPENT marking", async () => {
            const result = await service.prepareWithdraw(validParams);

            expect(result.spentNotes).toEqual([MOCK_NOTE]);
            expect(result.spentNotes.map((n) => n.commitment)).toEqual([MOCK_COMMITMENT_1]);
        });

        it("return changePendingNotes with change note data", async () => {
            const result = await service.prepareWithdraw(validParams);

            expect(result.changePendingNotes).toHaveLength(1);
            expect(result.changePendingNotes[0]).toEqual(
                expect.objectContaining({
                    commitment: MOCK_OUTPUT_COMMITMENT,
                    ownerAddress: VALID_OWNER,
                    noteSecret: MOCK_SECRET,
                    isOwned: true,
                    label: MOCK_LABEL,
                    tokenId: VALID_TOKEN,
                }),
            );
        });

        it("reject invalid params with InvalidTransactParams", async () => {
            await expect(
                service.prepareWithdraw({
                    ...validParams,
                    inputCommitments: [],
                }),
            ).rejects.toThrow(InvalidTransactParams);
        });

        it("reject invalid recipientAddress with InvalidTransactParams", async () => {
            await expect(
                service.prepareWithdraw({
                    ...validParams,
                    recipientAddress: "not-an-address" as Address,
                }),
            ).rejects.toThrow(InvalidTransactParams);
        });

        it("propagate prepareTransact errors", async () => {
            core = createMockCore({
                prepareTransactError: new InsufficientTransactValue("0x0", HALF_VALUE),
            });
            service = new PoolSessionWithdraw({
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressSchema: AddressSchema,
                emptyAddress: EMPTY_ADDRESS,
            });

            await expect(service.prepareWithdraw(validParams)).rejects.toThrow(
                InsufficientTransactValue,
            );
        });

        it("propagate TransactNoteNotActive errors", async () => {
            core = createMockCore({
                prepareTransactError: new TransactNoteNotActive(MOCK_COMMITMENT_1),
            });
            service = new PoolSessionWithdraw({
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressSchema: AddressSchema,
                emptyAddress: EMPTY_ADDRESS,
            });

            await expect(service.prepareWithdraw(validParams)).rejects.toThrow(
                TransactNoteNotActive,
            );
        });

        it("propagate witness builder errors", async () => {
            core = createMockCore({
                prepareTransactError: new Error("witness build failed"),
            });
            service = new PoolSessionWithdraw({
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressSchema: AddressSchema,
                emptyAddress: EMPTY_ADDRESS,
            });

            await expect(service.prepareWithdraw(validParams)).rejects.toThrow(
                "witness build failed",
            );
        });

        it("propagate proof generation errors", async () => {
            core = createMockCore({
                prepareTransactError: new Error("snarkjs failed"),
            });
            service = new PoolSessionWithdraw({
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressSchema: AddressSchema,
                emptyAddress: EMPTY_ADDRESS,
            });

            await expect(service.prepareWithdraw(validParams)).rejects.toThrow("snarkjs failed");
        });

        it("return relayerOptions in result", async () => {
            const result = await service.prepareWithdraw(validParams);

            expect(result.relayerOptions).toEqual([]);
        });

        describe("extraGas (native gas top-up)", () => {
            const relayer = {
                url: "https://relay.test",
                name: "test-relay",
                chainId: 11155111,
                chainType: "evm",
                status: "active",
                address: VALID_RELAY,
                processorAddress: VALID_PROCESSOR,
            };
            const quote = {
                txCost: "0",
                gasPrice: "0",
                feeAmount: "10",
                amountSent: "110",
                amountReceived: "100",
                feeCommitment: {
                    data: "0x" as Hex,
                    asset: VALID_TOKEN,
                    expiration: Date.now() + 3_600_000,
                    feeAmount: "10",
                    signedRelayerCommitment: "0xdeadbeef" as Hex,
                    recipient: VALID_RECIPIENT,
                    amountSent: "110",
                    amountReceived: "100",
                    extraGas: false,
                },
            };

            beforeEach(() => {
                vi.mocked(relayerInteractor.getRelayers).mockResolvedValue([relayer] as never);
                vi.mocked(relayerInteractor.getWithdrawalQuote).mockResolvedValue(quote as never);
            });

            // Before this was threaded through, getWithdrawRelayerQuotes hardcoded
            // extraGas:false, so a caller's opt-in produced a plain withdrawal: the
            // app quoted the user a fee WITH the top-up and the relay delivered none.
            it("forward the caller's opt-in to every relayer quote request and onto the options", async () => {
                const result = await service.prepareWithdraw({ ...validParams, extraGas: true });

                expect(relayerInteractor.getWithdrawalQuote).toHaveBeenCalledWith(
                    relayer,
                    expect.objectContaining({ extraGas: true, recipient: VALID_RECIPIENT }),
                );
                expect(result.relayerOptions).toHaveLength(1);
                expect(result.relayerOptions[0]?.extraGas).toBe(true);
            });

            it("request no top-up by default and mark the options as not requested", async () => {
                const result = await service.prepareWithdraw(validParams);

                expect(relayerInteractor.getWithdrawalQuote).toHaveBeenCalledWith(
                    relayer,
                    expect.objectContaining({ extraGas: false }),
                );
                expect(result.relayerOptions[0]?.extraGas).toBe(false);
            });
        });
    });

    describe("executeWithdraw", () => {
        // The top-up is relayer-funded: a self-submitted transact carries value 0 and has
        // no relayer to attach it, so an accepted-but-ignored flag would be the same
        // silent no-op the option was added to remove (cubic review of #396).
        it("reject extraGas on the self-submit convenience path before preparing anything", async () => {
            const core = createMockCore();
            const service = new PoolSessionWithdraw({
                core,
                relayerInteractor: createMockRelayerInteractor(),
                rpcInteractor: createMockRPCInteractor(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressSchema: AddressSchema,
                emptyAddress: EMPTY_ADDRESS,
            });
            await expect(
                service.withdraw({
                    inputCommitments: [MOCK_COMMITMENT_1],
                    amount: HALF_VALUE,
                    tokenId: VALID_TOKEN,
                    recipientAddress: VALID_RECIPIENT,
                    relayAddress: VALID_RELAY,
                    feeAmount: ZERO_FEE,
                    processorAddress: VALID_PROCESSOR,
                    extraGas: true,
                }),
            ).rejects.toThrow(InvalidTransactParams);
            expect(core.prepareTransact).not.toHaveBeenCalled();
            expect(core.submit).not.toHaveBeenCalled();
        });

        it("reject a result whose target is not the pool vault", async () => {
            const core = createMockCore();
            const service = new PoolSessionWithdraw({
                core,
                relayerInteractor: createMockRelayerInteractor(),
                rpcInteractor: createMockRPCInteractor(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressSchema: AddressSchema,
                emptyAddress: EMPTY_ADDRESS,
            });

            await expect(
                service.executeWithdraw({
                    changePendingNotes: [MOCK_CHANGE_PENDING_NOTE],
                    transactTx: {
                        data: "0xabcdef" as Hex,
                        to: "0x9999999999999999999999999999999999999999" as Address,
                        value: "0x0" as Hex,
                    },
                    spentNotes: [MOCK_NOTE],
                    spentNullifiers: [MOCK_NULLIFIER],
                    relayerOptions: [],
                }),
            ).rejects.toThrow(UnexpectedTransactionTarget);
            expect(core.submit).not.toHaveBeenCalled();
        });
    });

    describe("relayWithdraw", () => {
        let core: TransactOrchestrator;
        let relayerInteractor: IRelayerInteractor;
        let service: PoolSessionWithdraw;

        const AMOUNT = "0x64" as Hex; // 100
        const FEE_AMOUNT = "10"; // 10 — stringified bigint per quote shape
        const VALID_AMOUNT_SENT = "110"; // 100 + 10
        const VALID_AMOUNT_RECEIVED = "100";

        function buildRoutingData(
            recipient: Address,
            feeAmount: bigint,
            nativeGas = 0n,
        ): Hex {
            return encodeAbiParameters(PAYOUT_ROUTING_ABI, [
                {
                    recipient,
                    feeRecipient: VALID_RELAY,
                    feeAmount,
                    nativeGas,
                },
            ]);
        }

        function buildParams(overrides?: {
            amountSent?: string;
            recipientInData?: Address;
            feeAmountInData?: bigint;
            nativeGasInData?: bigint;
            expiration?: number;
            extraGas?: boolean;
            /** What the relayer echoes in feeCommitment.extraGas; defaults to `extraGas`. */
            echoExtraGas?: boolean;
        }): ExecuteWithdrawRelayerParams {
            const recipient = overrides?.recipientInData ?? VALID_RECIPIENT;
            const feeAmountEncoded = overrides?.feeAmountInData ?? BigInt(FEE_AMOUNT);
            const nativeGasEncoded = overrides?.nativeGasInData ?? 0n;
            return {
                inputCommitments: [MOCK_COMMITMENT_1 as Hash],
                amount: AMOUNT,
                tokenId: VALID_TOKEN,
                recipientAddress: VALID_RECIPIENT,
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
                        amountSent: overrides?.amountSent ?? VALID_AMOUNT_SENT,
                        amountReceived: VALID_AMOUNT_RECEIVED,
                        feeCommitment: {
                            data: buildRoutingData(recipient, feeAmountEncoded, nativeGasEncoded),
                            asset: VALID_TOKEN,
                            expiration: overrides?.expiration ?? Date.now() + 3_600_000,
                            feeAmount: FEE_AMOUNT,
                            signedRelayerCommitment: "0xdeadbeef" as Hex,
                            recipient,
                            amountSent: overrides?.amountSent ?? VALID_AMOUNT_SENT,
                            amountReceived: VALID_AMOUNT_RECEIVED,
                            extraGas: overrides?.echoExtraGas ?? overrides?.extraGas ?? false,
                        },
                    },
                },
                extraGas: overrides?.extraGas,
            };
        }

        beforeEach(() => {
            core = createMockCore();
            relayerInteractor = createMockRelayerInteractor();
            vi.mocked(relayerInteractor.relayWithdrawal).mockResolvedValue("0x1" as Hex);
            service = new PoolSessionWithdraw({
                core,
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressSchema: AddressSchema,
                emptyAddress: EMPTY_ADDRESS,
            });
        });

        it("pass when quote.amountSent equals amount + quote.feeAmount", async () => {
            await expect(service.relayWithdraw(buildParams())).resolves.toBeDefined();
            expect(core.prepareTransact).toHaveBeenCalledOnce();
        });

        it("thread the spent nullifiers and receipt logs to persistNoteUpdates for verification (AW-L-02)", async () => {
            const receiptLogs = [
                {
                    address: VALID_POOL,
                    topics: [] as Hex[],
                    data: "0x" as Hex,
                    blockNumber: "0x1" as Hex,
                    transactionHash: "0x1" as Hex,
                    logIndex: 0,
                },
            ];
            const rpcInteractor = createMockRPCInteractor();
            vi.mocked(rpcInteractor.waitForTransactionReceipt).mockResolvedValue({
                status: true,
                blockNumber: "0x1" as Hex,
                txHash: "0x1" as Hex,
                logs: receiptLogs,
            });
            service = new PoolSessionWithdraw({
                core,
                relayerInteractor,
                rpcInteractor,
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressSchema: AddressSchema,
                emptyAddress: EMPTY_ADDRESS,
            });

            await service.relayWithdraw(buildParams());

            // The persist sink must receive the proof's spent nullifiers plus the confirmed
            // receipt's logs so it can reject a bogus/unrelated relayer txHash.
            expect(core.persistNoteUpdates).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.anything(),
                { expectedNullifiers: [MOCK_NULLIFIER], receiptLogs },
            );
        });

        it("throw InvalidTransactParams when quote.amountSent is inflated above amount + feeAmount", async () => {
            const params = buildParams({ amountSent: "200" });
            await expect(service.relayWithdraw(params)).rejects.toThrow(InvalidTransactParams);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("throw InvalidTransactParams when quote.amountSent is deflated below amount + feeAmount", async () => {
            const params = buildParams({ amountSent: "50" });
            await expect(service.relayWithdraw(params)).rejects.toThrow(InvalidTransactParams);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject quote whose encoded recipient differs from caller recipientAddress", async () => {
            const params = buildParams({
                recipientInData: "0x9999999999999999999999999999999999999999" as Address,
            });
            await expect(service.relayWithdraw(params)).rejects.toThrow(InvalidTransactParams);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject quote whose encoded feeAmount differs from quote.feeAmount", async () => {
            const params = buildParams({ feeAmountInData: 99n });
            await expect(service.relayWithdraw(params)).rejects.toThrow(InvalidTransactParams);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject quote whose encoded nativeGas is non-zero while extraGas is off", async () => {
            const params = buildParams({ nativeGasInData: 5n });
            await expect(service.relayWithdraw(params)).rejects.toThrow(InvalidTransactParams);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        // A zeroed-out top-up would mean the user paid (the top-up is priced into
        // feeAmount) for gas the recipient never receives.
        it("reject quote whose encoded nativeGas is zero although extraGas was requested", async () => {
            const params = buildParams({ extraGas: true, nativeGasInData: 0n });
            await expect(service.relayWithdraw(params)).rejects.toThrow(InvalidTransactParams);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("accept a non-zero nativeGas when extraGas was requested", async () => {
            const params = buildParams({ extraGas: true, nativeGasInData: 5n });
            await expect(service.relayWithdraw(params)).resolves.toBeDefined();
            expect(core.prepareTransact).toHaveBeenCalled();
        });

        // The relayer's wire commitment carries no extraGas field, so the SDK schema
        // defaults feeCommitment.extraGas to false even on a genuine top-up quote. The
        // SIGNED routing (PayoutRouting.nativeGas) is the source of truth, not the echo.
        it("trust the signed routing over the relayer's echoed extraGas flag", async () => {
            const params = buildParams({
                extraGas: true,
                nativeGasInData: 5n,
                echoExtraGas: false,
            });
            await expect(service.relayWithdraw(params)).resolves.toBeDefined();
        });

        describe("assertPayoutRoutingMatchesQuote", () => {
            const fee = BigInt(FEE_AMOUNT);

            it("exact bigint form: match passes, mismatch throws", () => {
                expect(() =>
                    assertPayoutRoutingMatchesQuote(
                        buildRoutingData(VALID_RECIPIENT, fee, 0n),
                        VALID_RECIPIENT,
                        fee,
                        0n,
                    ),
                ).not.toThrow();
                expect(() =>
                    assertPayoutRoutingMatchesQuote(
                        buildRoutingData(VALID_RECIPIENT, fee, 5n),
                        VALID_RECIPIENT,
                        fee,
                        0n,
                    ),
                ).toThrow(InvalidTransactParams);
            });

            it("{ requested: false } requires a zero top-up", () => {
                expect(() =>
                    assertPayoutRoutingMatchesQuote(
                        buildRoutingData(VALID_RECIPIENT, fee, 0n),
                        VALID_RECIPIENT,
                        fee,
                        {
                            requested: false,
                        },
                    ),
                ).not.toThrow();
                expect(() =>
                    assertPayoutRoutingMatchesQuote(
                        buildRoutingData(VALID_RECIPIENT, fee, 5n),
                        VALID_RECIPIENT,
                        fee,
                        {
                            requested: false,
                        },
                    ),
                ).toThrow(InvalidTransactParams);
            });

            it("{ requested: true } requires a non-zero top-up", () => {
                expect(() =>
                    assertPayoutRoutingMatchesQuote(
                        buildRoutingData(VALID_RECIPIENT, fee, 5n),
                        VALID_RECIPIENT,
                        fee,
                        {
                            requested: true,
                        },
                    ),
                ).not.toThrow();
                expect(() =>
                    assertPayoutRoutingMatchesQuote(
                        buildRoutingData(VALID_RECIPIENT, fee, 0n),
                        VALID_RECIPIENT,
                        fee,
                        {
                            requested: true,
                        },
                    ),
                ).toThrow(InvalidTransactParams);
            });
        });

        it("reject an expired fee commitment before generating the proof", async () => {
            // The live-check must run before the expensive prepareTransact (audit #91).
            const params = buildParams({ expiration: Date.now() - 1000 });

            await expect(service.relayWithdraw(params)).rejects.toThrow(FeeCommitmentExpired);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject a quote whose feeCommitment.asset differs from the withdraw tokenId", async () => {
            // The relayer's signed commitment must be for the asset being withdrawn (audit #55).
            const params = buildParams();
            params.selectedQuote.quote.feeCommitment.asset =
                "0x9999999999999999999999999999999999999999" as Hex;

            await expect(service.relayWithdraw(params)).rejects.toThrow(InvalidTransactParams);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        describe("prepareRegisterAndWithdrawRelay", () => {
            const signedRegistration: PreparedRelayedRegistration = {
                typedData: {
                    domain: {
                        name: "PrivacyPoolsKeystore",
                        version: "1",
                        chainId: 11155111,
                        verifyingContract: VALID_POOL,
                    },
                    types: { SetAuthPolicy: [] },
                    primaryType: "SetAuthPolicy",
                    message: {},
                },
                account: VALID_OWNER,
                nullifyingKeyHash: "0xaaa" as Hash,
                authDigest: "0xbbb" as Hash,
                deadline: "0xffffffffff" as Hex,
                signature: ("0x" + "12".repeat(65)) as Hex,
            };

            it("assemble the registerAndRelay request with the signed registration fields", async () => {
                const result = await service.prepareRegisterAndWithdrawRelay(
                    buildParams(),
                    signedRegistration,
                );

                expect(result.relayer.address).toBe(VALID_RELAY);
                expect(result.relayParams.registration).toEqual({
                    account: VALID_OWNER,
                    authDigest: "0xbbb",
                    nullifyingKeyHash: "0xaaa",
                    deadline: "0xffffffffff",
                    signature: signedRegistration.signature,
                });
                expect(result.relayParams.proof).toBeDefined();
                expect(result.spentNotes.length).toBeGreaterThan(0);
            });

            it("build the withdrawal proof against the predicted post-insertion keystore root", async () => {
                await service.prepareRegisterAndWithdrawRelay(buildParams(), signedRegistration);

                expect(core.prepareTransact).toHaveBeenCalledWith(
                    expect.objectContaining({ pendingKeystoreRegistration: true }),
                );
            });

            // Callers on this path assemble selectedQuote themselves, so the opt-in
            // must be carried explicitly; the same presence rule applies as relayWithdraw.
            it("apply the extraGas presence rule to a manually assembled top-up quote", async () => {
                await expect(
                    service.prepareRegisterAndWithdrawRelay(
                        buildParams({ extraGas: true, nativeGasInData: 5n }),
                        signedRegistration,
                    ),
                ).resolves.toBeDefined();
                await expect(
                    service.prepareRegisterAndWithdrawRelay(
                        buildParams({ extraGas: true, nativeGasInData: 0n }),
                        signedRegistration,
                    ),
                ).rejects.toThrow(InvalidTransactParams);
            });

            it("reject an already-expired registration deadline before building any proof", async () => {
                // An expired signature deadline would still generate the ~30-60s withdrawal
                // proof and produce a registerAndRelay request the contract rejects with
                // Keystore_SignatureExpired. Guard it before proof generation.
                const expired: PreparedRelayedRegistration = {
                    ...signedRegistration,
                    deadline: "0x1" as Hex, // unix-seconds 1 — firmly in the past
                };

                await expect(
                    service.prepareRegisterAndWithdrawRelay(buildParams(), expired),
                ).rejects.toThrow(RegistrationDeadlineInPast);
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("reject an unsigned registration before building any proof", async () => {
                const unsigned: PreparedRelayedRegistration = {
                    ...signedRegistration,
                    signature: null,
                };

                await expect(
                    service.prepareRegisterAndWithdrawRelay(buildParams(), unsigned),
                ).rejects.toThrow(InvalidTransactParams);
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });

            it("apply the same fee guards as relayWithdraw (reject a mismatched recipient)", async () => {
                const params = buildParams({
                    recipientInData: "0x9999999999999999999999999999999999999999" as Address,
                });

                await expect(
                    service.prepareRegisterAndWithdrawRelay(params, signedRegistration),
                ).rejects.toThrow(InvalidTransactParams);
                expect(core.prepareTransact).not.toHaveBeenCalled();
            });
        });
    });
});
