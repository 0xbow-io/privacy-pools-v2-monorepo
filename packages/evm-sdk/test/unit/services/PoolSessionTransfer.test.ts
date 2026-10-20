import { encodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";

import type {
    Address,
    FinalizedBlockResult,
    Hash,
    Hex,
    ICryptoService,
    IKeystoreInteractor,
    ILogger,
    INoteComputationService,
    IPaymentRequestService,
    IRelayerInteractor,
    IRPCInteractor,
    Note,
    NoteData,
    PaymentRequest,
    PendingNote,
    PrepareTransactResult,
    PublicKey,
    RelayTransferParams,
    Secret,
    TransactProof,
    TransferParams,
} from "../../../src/internal.js";
import {
    AddressSchema,
    bigintToHex,
    EvmAddressFieldConverter,
    EvmPreparedTxVerifier,
    FeeCommitmentExpired,
    InsufficientTransactValue,
    InvalidTransactParams,
    NoteStatus,
    PaymentRequestExpired,
    POOL_VAULT_TRANSACT_ABI,
    PoolSessionTransfer,
    TransactNoteNotActive,
    TransactOrchestrator,
} from "../../../src/internal.js";

// --- Constants ---

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const VALID_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const VALID_VALUE = "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000" as Hex; // 1e18
const HALF_VALUE = "0x00000000000000000000000000000000000000000000000006f05b59d3b20000" as Hex; // 5e17
const MOCK_SECRET = "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
const MOCK_CHANGE_SECRET =
    "0xcccc111111111111111111111111111111111111111111111111111111111111" as Secret;
const RECIPIENT_NOTE_SECRET =
    "0xeeee111111111111111111111111111111111111111111111111111111111111" as Secret;
const MOCK_COMMITMENT_1 =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const MOCK_COMMITMENT_2 =
    "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;
const MOCK_LABEL = "0x4444444444444444444444444444444444444444444444444444444444444444" as Hex;
const MOCK_NOTE_ADDRESS_HASH =
    "0x5555555555555555555555555555555555555555555555555555555555555555" as Hex;
const RECIPIENT_NOTE_ADDRESS_HASH =
    "0x6666666666666666666666666666666666666666666666666666666666666666" as Hex;
const RECIPIENT_EVM_ADDRESS = "0x7777777777777777777777777777777777777777" as Address;
const RECIPIENT_VIEWING_KEY =
    "0x8888888888888888888888888888888888888888888888888888888888888888" as PublicKey;
const ZERO_VIEWING_KEY =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as PublicKey;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const MOCK_NULLIFIER = "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex;

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
    commitment: MOCK_COMMITMENT_2 as Hash,
    value: HALF_VALUE,
    tokenId: VALID_TOKEN,
    label: MOCK_LABEL,
    ownerAddress: VALID_OWNER,
    noteSecret: MOCK_CHANGE_SECRET,
    isOwned: true,
    status: NoteStatus.PENDING,
};

const MOCK_RECIPIENT_PENDING_NOTE: PendingNote = {
    noteAddressHash: RECIPIENT_NOTE_ADDRESS_HASH,
    commitment: MOCK_COMMITMENT_1 as Hash,
    value: HALF_VALUE,
    tokenId: VALID_TOKEN,
    label: MOCK_LABEL,
    ownerAddress: ZERO_ADDRESS,
    noteSecret: "0x0" as Secret,
    isOwned: false,
    status: NoteStatus.PENDING,
};

// --- Default prepareTransact result ---

function defaultPrepareTransactResult(): PrepareTransactResult {
    return {
        changePendingNotes: [MOCK_CHANGE_PENDING_NOTE],
        recipientPendingNotes: [MOCK_RECIPIENT_PENDING_NOTE],
        transactTx: { data: "0xabcdef" as Hex, to: VALID_POOL, value: "0x0" as Hex },
        spentNotes: [MOCK_NOTE],
        spentNullifiers: [],
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
        /** Verdict the mocked persistNoteUpdates reports; see TransferResult.spentNullifiersConfirmed. */
        spentNullifiersConfirmed?: boolean;
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
        persistNoteUpdates: vi.fn(
            async (): Promise<boolean> => opts.spentNullifiersConfirmed ?? true,
        ),
        prepareRecipientNotes: vi.fn(async (notes: PendingNote[]) =>
            notes.map((n) => ({
                ...n,
                createdAtBlock: "0x1" as Hex,
                spentAtBlock: null,
                txHash: "0x1" as Hash,
            })),
        ),
    } as unknown as TransactOrchestrator;
}

function createMockRelayerInteractor(): IRelayerInteractor {
    return {
        getRelayers: vi.fn(async () => []),
        getChainDetails: vi.fn() as never,
        getTransferQuote: vi.fn(),
        getWithdrawalQuote: vi.fn(),
        getBatchWithdrawalQuote: vi.fn(),
        relayTransfer: vi.fn(async () => "0x1" as Hash),
        relayWithdrawal: vi.fn(),
        relayBatchWithdrawal: vi.fn(),
        submitRelayedRegistration: vi.fn(),
        relayRegisterAndWithdrawal: vi.fn(),
        relayWithAnnounce: vi.fn(),
        getSwapQuote: vi.fn() as unknown as IRelayerInteractor["getSwapQuote"],
        relaySwap: vi.fn(),
    };
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

function createMockCryptoService(): ICryptoService {
    return {
        generateSecret: vi.fn(() => RECIPIENT_NOTE_SECRET),
    } as unknown as ICryptoService;
}

function createMockNoteComputationService(): INoteComputationService {
    return {
        computeNoteAddressHash: vi.fn(() => RECIPIENT_NOTE_ADDRESS_HASH),
    } as unknown as INoteComputationService;
}

function createMockKeystoreInteractor(
    viewingKey: Hex = RECIPIENT_VIEWING_KEY,
): IKeystoreInteractor {
    return {
        getViewingKey: vi.fn(async () => viewingKey),
    } as unknown as IKeystoreInteractor;
}

function createMockPaymentRequestService(): IPaymentRequestService {
    return {
        generate: vi.fn(),
        list: vi.fn(async () => []),
        getOpenRequests: vi.fn(async () => []),
        getScannableRequests: vi.fn(async () => []),
        markScanRetired: vi.fn(async () => undefined),
        markFulfilled: vi.fn(async () => undefined),
        archive: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
        loadFromStorage: vi.fn(async () => undefined),
        exportState: vi.fn(() => []),
        importState: vi.fn(async () => undefined),
    };
}

function buildService(
    overrides: {
        core?: TransactOrchestrator;
        relayerInteractor?: IRelayerInteractor;
        rpcInteractor?: IRPCInteractor;
        keystoreInteractor?: IKeystoreInteractor;
        paymentRequestService?: IPaymentRequestService;
    } = {},
): {
    service: PoolSessionTransfer;
    core: TransactOrchestrator;
    relayerInteractor: IRelayerInteractor;
    rpcInteractor: IRPCInteractor;
    keystoreInteractor: IKeystoreInteractor;
    paymentRequestService: IPaymentRequestService;
} {
    const core = overrides.core ?? createMockCore();
    const relayerInteractor = overrides.relayerInteractor ?? createMockRelayerInteractor();
    const rpcInteractor = overrides.rpcInteractor ?? createMockRPCInteractor();
    const keystoreInteractor = overrides.keystoreInteractor ?? createMockKeystoreInteractor();
    const paymentRequestService =
        overrides.paymentRequestService ?? createMockPaymentRequestService();
    const service = new PoolSessionTransfer({
        ownerAddress: VALID_OWNER,
        core,
        relayerInteractor,
        rpcInteractor,
        cryptoService: createMockCryptoService(),
        noteComputationService: createMockNoteComputationService(),
        keystoreInteractor,
        paymentRequestService,
        preparedTxVerifier: new EvmPreparedTxVerifier(),
        addressFieldConverter: new EvmAddressFieldConverter(),
        addressSchema: AddressSchema,
    });
    return {
        service,
        core,
        relayerInteractor,
        rpcInteractor,
        keystoreInteractor,
        paymentRequestService,
    };
}

// --- Tests ---

describe("PoolSessionTransfer", () => {
    describe("constructor", () => {
        it("create instance with valid config", () => {
            const { service } = buildService();
            expect(service).toBeInstanceOf(PoolSessionTransfer);
        });
    });

    describe("prepareTransfer — recipientNoteAddressHash (blind)", () => {
        const validParams: TransferParams = {
            inputCommitments: [MOCK_COMMITMENT_1],
            recipientNoteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH],
            amount: HALF_VALUE,
            tokenId: VALID_TOKEN,
            relayAddress: VALID_OWNER,
            feeAmount: "0x0" as Hex,
            processorAddress: ZERO_ADDRESS,
        };

        it("resolve recipient with only noteAddressHash (blind variant)", async () => {
            const { service } = buildService();
            const result = await service.prepareTransfer(validParams);

            expect(result.executeOptions.recipient).toEqual({
                noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH],
            });
            expect(result.executeOptions.recipient.noteSecretsMap).toBeUndefined();
            expect(result.executeOptions.recipient.publicViewingKey).toBeUndefined();
        });

        it("forward blind recipient to orchestrator", async () => {
            const { service, core } = buildService();
            await service.prepareTransfer(validParams);

            expect(core.prepareTransact).toHaveBeenCalledWith(
                expect.objectContaining({
                    inputCommitments: [MOCK_COMMITMENT_1],
                    amount: HALF_VALUE,
                    tokenId: VALID_TOKEN,
                    amountOut: "0x0",
                    recipient: { noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH] },
                }),
            );
        });

        it("never call keystoreInteractor.getViewingKey", async () => {
            const { service, keystoreInteractor } = buildService();
            await service.prepareTransfer(validParams);

            expect(keystoreInteractor.getViewingKey).not.toHaveBeenCalled();
        });

        it("expose executeOptions with calldata, spentNotes and pending notes", async () => {
            const { service } = buildService();
            const result = await service.prepareTransfer(validParams);

            expect(result.executeOptions.transactTx.data).toMatch(/^0x/);
            expect(result.executeOptions.transactTx.to).toBe(VALID_POOL);
            expect(result.executeOptions.spentNotes).toEqual([MOCK_NOTE]);
            expect(result.executeOptions.changePendingNotes[0]!.noteAddressHash).toBe(
                MOCK_NOTE_ADDRESS_HASH,
            );
            expect(result.executeOptions.recipientPendingNotes[0]!.noteAddressHash).toBe(
                RECIPIENT_NOTE_ADDRESS_HASH,
            );
        });

        it("not enrich recipient pending notes for blind variant", async () => {
            const { service } = buildService();
            const result = await service.prepareTransfer(validParams);

            expect(result.executeOptions.recipientPendingNotes[0]!.isOwned).toBe(false);
            expect(result.executeOptions.recipientPendingNotes[0]!.noteSecret).toBe("0x0");
        });

        it("emit empty relayOptions when no relayers are available", async () => {
            const { service } = buildService();
            const result = await service.prepareTransfer(validParams);

            expect(result.relayOptions).toEqual([]);
        });

        it("not persist notes during prepare", async () => {
            const { service, core } = buildService();
            await service.prepareTransfer(validParams);

            expect(core.persistNoteUpdates).not.toHaveBeenCalled();
        });

        it("reject empty inputCommitments with InvalidTransactParams", async () => {
            const { service } = buildService();
            await expect(
                service.prepareTransfer({ ...validParams, inputCommitments: [] }),
            ).rejects.toThrow(InvalidTransactParams);
        });

        it("reject invalid recipientNoteAddressHash with InvalidTransactParams", async () => {
            const { service } = buildService();
            await expect(
                service.prepareTransfer({
                    ...validParams,
                    recipientNoteAddressHash: ["not-hex" as Hex],
                }),
            ).rejects.toThrow(InvalidTransactParams);
        });

        it("propagate prepareTransact errors", async () => {
            const { service } = buildService({
                core: createMockCore({
                    prepareTransactError: new InsufficientTransactValue("0x0", HALF_VALUE),
                }),
            });
            await expect(service.prepareTransfer(validParams)).rejects.toThrow(
                InsufficientTransactValue,
            );
        });

        it("propagate TransactNoteNotActive errors", async () => {
            const { service } = buildService({
                core: createMockCore({
                    prepareTransactError: new TransactNoteNotActive(MOCK_COMMITMENT_1),
                }),
            });
            await expect(service.prepareTransfer(validParams)).rejects.toThrow(
                TransactNoteNotActive,
            );
        });

        it("emit a one-shot deprecation warning when callers use the positional array form", async () => {
            const warn = vi.fn();
            const service = new PoolSessionTransfer(
                {
                    ownerAddress: VALID_OWNER,
                    core: createMockCore(),
                    relayerInteractor: createMockRelayerInteractor(),
                    rpcInteractor: createMockRPCInteractor(),
                    cryptoService: createMockCryptoService(),
                    noteComputationService: createMockNoteComputationService(),
                    keystoreInteractor: createMockKeystoreInteractor(),
                    paymentRequestService: createMockPaymentRequestService(),
                    preparedTxVerifier: new EvmPreparedTxVerifier(),
                    addressFieldConverter: new EvmAddressFieldConverter(),
                    addressSchema: AddressSchema,
                },
                {
                    logger: {
                        warn,
                        info: vi.fn(),
                        debug: vi.fn(),
                        error: vi.fn(),
                        fatal: vi.fn(),
                        child: vi.fn(),
                        level: "info",
                    } as unknown as ILogger,
                },
            );

            await service.prepareTransfer(validParams);
            await service.prepareTransfer(validParams);

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(
                expect.stringMatching(/recipientNoteAddressHash.*deprecated/),
            );
        });
    });

    describe("prepareTransfer — recipientNoteAddressHashByLabel (blind, Map)", () => {
        const validByLabelParams: TransferParams = {
            inputCommitments: [MOCK_COMMITMENT_1],
            recipientNoteAddressHashByLabel: new Map([[MOCK_LABEL, RECIPIENT_NOTE_ADDRESS_HASH]]),
            amount: HALF_VALUE,
            tokenId: VALID_TOKEN,
            relayAddress: VALID_OWNER,
            feeAmount: "0x0" as Hex,
            processorAddress: ZERO_ADDRESS,
        };

        it("resolve recipient with both noteAddressHash and noteAddressHashByLabel populated", async () => {
            const { service } = buildService();
            const result = await service.prepareTransfer(validByLabelParams);

            expect(result.executeOptions.recipient.noteAddressHashByLabel).toBeInstanceOf(Map);
            expect(result.executeOptions.recipient.noteAddressHashByLabel?.get(MOCK_LABEL)).toBe(
                RECIPIENT_NOTE_ADDRESS_HASH,
            );
            expect(result.executeOptions.recipient.noteAddressHash).toEqual([
                RECIPIENT_NOTE_ADDRESS_HASH,
            ]);
            expect(result.executeOptions.recipient.noteSecretsMap).toBeUndefined();
            expect(result.executeOptions.recipient.publicViewingKey).toBeUndefined();
        });

        it("not emit the deprecation warning when using the Map form", async () => {
            const warn = vi.fn();
            const service = new PoolSessionTransfer(
                {
                    ownerAddress: VALID_OWNER,
                    core: createMockCore(),
                    relayerInteractor: createMockRelayerInteractor(),
                    rpcInteractor: createMockRPCInteractor(),
                    cryptoService: createMockCryptoService(),
                    noteComputationService: createMockNoteComputationService(),
                    keystoreInteractor: createMockKeystoreInteractor(),
                    paymentRequestService: createMockPaymentRequestService(),
                    preparedTxVerifier: new EvmPreparedTxVerifier(),
                    addressFieldConverter: new EvmAddressFieldConverter(),
                    addressSchema: AddressSchema,
                },
                {
                    logger: {
                        warn,
                        info: vi.fn(),
                        debug: vi.fn(),
                        error: vi.fn(),
                        fatal: vi.fn(),
                        child: vi.fn(),
                        level: "info",
                    } as unknown as ILogger,
                },
            );

            await service.prepareTransfer(validByLabelParams);

            expect(warn).not.toHaveBeenCalled();
        });

        it("reject invalid hash values via the Zod schema", async () => {
            const { service } = buildService();
            await expect(
                service.prepareTransfer({
                    ...validByLabelParams,
                    recipientNoteAddressHashByLabel: new Map([[MOCK_LABEL, "not-hex" as Hex]]),
                }),
            ).rejects.toThrow(InvalidTransactParams);
        });
    });

    describe("prepareTransfer — recipientDiscoveryData with evmAddress", () => {
        const baseParams = {
            inputCommitments: [MOCK_COMMITMENT_1],
            amount: HALF_VALUE,
            tokenId: VALID_TOKEN,
            relayAddress: VALID_OWNER,
            feeAmount: "0x0" as Hex,
            processorAddress: ZERO_ADDRESS,
        };

        it("resolve to discoverable when keystore returns a non-zero viewing key", async () => {
            const { service, keystoreInteractor } = buildService();
            const result = await service.prepareTransfer({
                ...baseParams,
                recipientDiscoveryData: { evmAddress: RECIPIENT_EVM_ADDRESS },
            });

            expect(keystoreInteractor.getViewingKey).toHaveBeenCalledWith(RECIPIENT_EVM_ADDRESS);
            const recipient = result.executeOptions.recipient;
            expect(recipient.publicViewingKey).toBe(RECIPIENT_VIEWING_KEY);
            expect(recipient.noteAddressHash).toEqual([RECIPIENT_NOTE_ADDRESS_HASH]);
            expect(recipient.noteSecretsMap).toBeDefined();
        });

        it("generate noteSecretsMap when not supplied", async () => {
            const { service } = buildService();
            const result = await service.prepareTransfer({
                ...baseParams,
                recipientDiscoveryData: { evmAddress: RECIPIENT_EVM_ADDRESS },
            });

            const recipient = result.executeOptions.recipient;
            expect(recipient.noteSecretsMap?.size).toBe(1);
            expect(recipient.noteSecretsMap?.get(RECIPIENT_NOTE_ADDRESS_HASH)).toBe(
                RECIPIENT_NOTE_SECRET,
            );
        });

        it("use caller-supplied noteSecretsMap when provided", async () => {
            const callerMap = new Map<Hash, Secret>([[RECIPIENT_NOTE_ADDRESS_HASH, MOCK_SECRET]]);
            const { service, core } = buildService();
            await service.prepareTransfer({
                ...baseParams,
                recipientDiscoveryData: {
                    evmAddress: RECIPIENT_EVM_ADDRESS,
                    noteSecretsMap: callerMap,
                },
            });

            expect(core.prepareTransact).toHaveBeenCalledWith(
                expect.objectContaining({
                    recipient: expect.objectContaining({
                        noteSecretsMap: callerMap,
                        publicViewingKey: RECIPIENT_VIEWING_KEY,
                    }) as object,
                }),
            );
        });

        it("throw RecipientViewingKeyUnregistered by default when keystore returns zero", async () => {
            const { service } = buildService({
                keystoreInteractor: createMockKeystoreInteractor(ZERO_VIEWING_KEY),
            });

            await expect(
                service.prepareTransfer({
                    ...baseParams,
                    recipientDiscoveryData: { evmAddress: RECIPIENT_EVM_ADDRESS },
                }),
            ).rejects.toThrow("has no on-chain viewing key");
        });

        it("fall back to outOfBand when keystore returns zero and caller opts in", async () => {
            const { service } = buildService({
                keystoreInteractor: createMockKeystoreInteractor(ZERO_VIEWING_KEY),
            });
            const result = await service.prepareTransfer({
                ...baseParams,
                recipientDiscoveryData: {
                    evmAddress: RECIPIENT_EVM_ADDRESS,
                    allowOutOfBandFallback: true,
                },
            });

            const recipient = result.executeOptions.recipient;
            expect(recipient.publicViewingKey).toBeUndefined();
            expect(recipient.noteSecretsMap?.size).toBe(1);
            expect(result.executeOptions.recipientEvmAddress).toBe(RECIPIENT_EVM_ADDRESS);
        });

        it("propagate keystore RPC errors instead of falling back", async () => {
            const failingKeystore = {
                getViewingKey: vi.fn(async () => {
                    throw new Error("RPC unreachable");
                }),
            } as unknown as IKeystoreInteractor;
            const { service } = buildService({ keystoreInteractor: failingKeystore });

            await expect(
                service.prepareTransfer({
                    ...baseParams,
                    recipientDiscoveryData: { evmAddress: RECIPIENT_EVM_ADDRESS },
                }),
            ).rejects.toThrow("RPC unreachable");
        });

        it("enrich recipient pending notes with secret and evmAddress on opted-in outOfBand fallback", async () => {
            const { service } = buildService({
                keystoreInteractor: createMockKeystoreInteractor(ZERO_VIEWING_KEY),
            });
            const result = await service.prepareTransfer({
                ...baseParams,
                recipientDiscoveryData: {
                    evmAddress: RECIPIENT_EVM_ADDRESS,
                    allowOutOfBandFallback: true,
                },
            });

            const recipientNote = result.executeOptions.recipientPendingNotes[0]!;
            expect(recipientNote.isOwned).toBe(true);
            expect(recipientNote.ownerAddress).toBe(RECIPIENT_EVM_ADDRESS);
            expect(recipientNote.noteSecret).toBe(RECIPIENT_NOTE_SECRET);
        });
    });

    describe("prepareTransfer — recipientDiscoveryData with publicViewingKey", () => {
        it("resolve directly to discoverable without calling keystore", async () => {
            const callerMap = new Map<Hash, Secret>([[RECIPIENT_NOTE_ADDRESS_HASH, MOCK_SECRET]]);
            const { service, keystoreInteractor } = buildService();
            const result = await service.prepareTransfer({
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipientDiscoveryData: {
                    publicViewingKey: RECIPIENT_VIEWING_KEY,
                    noteSecretsMap: callerMap,
                },
            });

            expect(keystoreInteractor.getViewingKey).not.toHaveBeenCalled();
            expect(result.executeOptions.recipient).toEqual({
                noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH],
                noteSecretsMap: callerMap,
                publicViewingKey: RECIPIENT_VIEWING_KEY,
            });
        });
    });

    describe("relayTransfer", () => {
        function buildQuote(
            expiration = Date.now() + 3_600_000,
        ): RelayTransferParams["selectedQuote"] {
            return {
                relayerInfo: {
                    url: "http://relay",
                    name: "test",
                    chainId: 1,
                    chainType: "evm",
                    status: "active" as const,
                    address: VALID_OWNER,
                    processorAddress: ZERO_ADDRESS,
                },
                quote: {
                    txCost: "0",
                    gasPrice: "0",
                    feeAmount: "0",
                    feeCommitment: {
                        data: "0xfee" as Hex,
                        asset: VALID_TOKEN,
                        expiration,
                        feeAmount: "0",
                        signedRelayerCommitment: "0xsig" as Hex,
                    },
                },
            };
        }

        it("forward discoverable recipient to orchestrator on relay", async () => {
            const { service, core, relayerInteractor } = buildService();
            const callerMap = new Map<Hash, Secret>([[RECIPIENT_NOTE_ADDRESS_HASH, MOCK_SECRET]]);
            const params: RelayTransferParams = {
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipient: {
                    noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH],
                    noteSecretsMap: callerMap,
                    publicViewingKey: RECIPIENT_VIEWING_KEY,
                },
                selectedQuote: buildQuote(),
            };

            await service.relayTransfer(params);

            expect(core.prepareTransact).toHaveBeenCalledWith(
                expect.objectContaining({
                    recipient: expect.objectContaining({
                        publicViewingKey: RECIPIENT_VIEWING_KEY,
                        noteSecretsMap: callerMap,
                    }) as object,
                    transactParams: expect.objectContaining({ data: "0xfee" }) as object,
                }),
            );
            expect(relayerInteractor.relayTransfer).toHaveBeenCalled();
        });

        it("forward outOfBand recipient unchanged on relay (no on-chain publish)", async () => {
            const { service, core } = buildService();
            const map = new Map<Hash, Secret>([[RECIPIENT_NOTE_ADDRESS_HASH, MOCK_SECRET]]);
            const params: RelayTransferParams = {
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipient: {
                    noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH],
                    noteSecretsMap: map,
                },
                recipientEvmAddress: RECIPIENT_EVM_ADDRESS,
                selectedQuote: buildQuote(),
            };

            const result = await service.relayTransfer(params);

            expect(core.prepareTransact).toHaveBeenCalledWith(
                expect.objectContaining({
                    recipient: expect.objectContaining({ noteSecretsMap: map }) as object,
                }),
            );
            expect(result.recipientNotes).toBeDefined();
            expect(result.recipientNotes![0]!.ownerAddress).toBe(RECIPIENT_EVM_ADDRESS);
            expect(result.recipientNotes![0]!.noteSecret).toBe(MOCK_SECRET);
        });

        // The verdict must reach the caller, which is the whole point of the change:
        // persistNoteUpdates already detected an unrelated relayer receipt (AW-L-02 /
        // #1070) and then returned void, so finalizeTransfer handed back a successful
        // TransferResult either way and consumers reading txReceipt.status announced a
        // completed transfer over a transact that never happened.
        it("surface spentNullifiersConfirmed true when the receipt confirms the spend", async () => {
            const { service } = buildService({
                core: createMockCore({ spentNullifiersConfirmed: true }),
            });

            const result = await service.relayTransfer({
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipient: { noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH] },
                selectedQuote: buildQuote(),
            });

            expect(result.spentNullifiersConfirmed).toBe(true);
        });

        it("surface spentNullifiersConfirmed false for a successful but unrelated receipt", async () => {
            const { service } = buildService({
                core: createMockCore({ spentNullifiersConfirmed: false }),
            });

            const result = await service.relayTransfer({
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipient: { noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH] },
                selectedQuote: buildQuote(),
            });

            // The receipt succeeded. It is simply not ours, and the caller can now tell.
            expect(result.txReceipt.status).toBe(true);
            expect(result.spentNullifiersConfirmed).toBe(false);
        });

        it("leave spentNullifiersConfirmed undefined when the receipt reverted", async () => {
            const { service, rpcInteractor } = buildService();
            vi.mocked(rpcInteractor.waitForTransactionReceipt).mockResolvedValue({
                status: false,
                blockNumber: "0x1" as Hex,
                txHash: "0x1" as Hex,
                logs: [],
            });

            const result = await service.relayTransfer({
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipient: { noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH] },
                selectedQuote: buildQuote(),
            });

            // undefined means verification never ran, which is different from `false`
            // (it ran and the receipt was not ours). Callers must not conflate them.
            expect(result.spentNullifiersConfirmed).toBeUndefined();
        });

        it("not return recipientNotes when relay recipient is blind", async () => {
            const { service } = buildService();
            const params: RelayTransferParams = {
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipient: {
                    noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH],
                },
                selectedQuote: buildQuote(),
            };

            const result = await service.relayTransfer(params);
            expect(result.recipientNotes).toBeUndefined();
        });

        it("reject an expired fee commitment before generating the proof", async () => {
            // The live-check must run before the expensive runPrepareTransact (audit #91).
            const { service, core } = buildService();
            const params: RelayTransferParams = {
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipient: {
                    noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH],
                },
                selectedQuote: buildQuote(Date.now() - 1000),
            };

            await expect(service.relayTransfer(params)).rejects.toThrow(FeeCommitmentExpired);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("reject a quote whose feeCommitment.asset differs from the transfer tokenId", async () => {
            // Same audit #55 check as relayWithdraw: the relayer's signed commitment must be for
            // the asset being transferred.
            const { service, core } = buildService();
            const quote = buildQuote();
            quote.quote.feeCommitment.asset = "0x9999999999999999999999999999999999999999" as Hex;
            const params: RelayTransferParams = {
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipient: {
                    noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH],
                },
                selectedQuote: quote,
            };

            await expect(service.relayTransfer(params)).rejects.toThrow(InvalidTransactParams);
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("thread the spent nullifiers and receipt logs to persistNoteUpdates for verification (AW-L-02)", async () => {
            // Mirror of the relayWithdraw AW-L-02 test: an untrusted relayer's txHash must be
            // verified against the confirmed receipt's PoolVault Transacted logs before the input
            // notes are marked SPENT. A bogus/unrelated txHash would otherwise strand live notes
            // (#1070). The verify-and-WARN gating itself is unit-tested against the real
            // orchestrator in TransactOrchestrator.persistNoteUpdates verify-before-persist.
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
            const core = createMockCore({
                prepareTransactResult: {
                    ...defaultPrepareTransactResult(),
                    spentNullifiers: [MOCK_NULLIFIER],
                },
            });
            const rpcInteractor = createMockRPCInteractor();
            vi.mocked(rpcInteractor.waitForTransactionReceipt).mockResolvedValue({
                status: true,
                blockNumber: "0x1" as Hex,
                txHash: "0x1" as Hex,
                logs: receiptLogs,
            });
            const { service } = buildService({ core, rpcInteractor });
            const params: RelayTransferParams = {
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipient: { noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH] },
                selectedQuote: buildQuote(),
            };

            await service.relayTransfer(params);

            // The persist sink must receive the proof's spent nullifiers plus the confirmed
            // receipt's logs so it can reject a bogus/unrelated relayer txHash.
            expect(core.persistNoteUpdates).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.anything(),
                { expectedNullifiers: [MOCK_NULLIFIER], receiptLogs },
            );
        });
    });

    describe("executeTransfer", () => {
        it("thread the spent nullifiers and receipt logs to persistNoteUpdates for verification (AW-L-02)", async () => {
            // The self-submit path threads the same verification bundle for consistency with the
            // relay path — the receipt is our own here, but the sink treats both identically.
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
            // executeTransfer asserts the calldata really decodes as `transact`, so supply valid
            // transact calldata (the mock's placeholder "0xabcdef" would fail that guard).
            const validCallData = encodeFunctionData({
                abi: POOL_VAULT_TRANSACT_ABI,
                functionName: "transact",
                args: [
                    {
                        pA: [1n, 2n],
                        pB: [
                            [3n, 4n],
                            [5n, 6n],
                        ],
                        pC: [7n, 8n],
                        pubSignals: [
                            [9n, 10n],
                            [11n, 12n],
                        ],
                    },
                    { processor: ZERO_ADDRESS, data: "0x" },
                    [{ hint: `0x${"22".repeat(32)}` as Hex, data: "0xbeef" as Hex }],
                ] as never,
            });
            const core = createMockCore({
                prepareTransactResult: {
                    ...defaultPrepareTransactResult(),
                    transactTx: {
                        ...defaultPrepareTransactResult().transactTx,
                        data: validCallData,
                    },
                    spentNullifiers: [MOCK_NULLIFIER],
                },
            });
            const rpcInteractor = createMockRPCInteractor();
            vi.mocked(rpcInteractor.waitForTransactionReceipt).mockResolvedValue({
                status: true,
                blockNumber: "0x1" as Hex,
                txHash: "0x1" as Hex,
                logs: receiptLogs,
            });
            const { service } = buildService({ core, rpcInteractor });

            const prepared = await service.prepareTransfer({
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                recipientNoteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH],
            });
            await service.executeTransfer(prepared.executeOptions);

            expect(core.persistNoteUpdates).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.anything(),
                { expectedNullifiers: [MOCK_NULLIFIER], receiptLogs },
            );
        });
    });

    describe("prepareColdStartTransfer", () => {
        const params = {
            inputCommitments: [MOCK_COMMITMENT_1],
            recipientEvmAddress: RECIPIENT_EVM_ADDRESS,
            amount: HALF_VALUE,
            tokenId: VALID_TOKEN,
        };

        it("resolve to outOfBand and skip keystore lookup", async () => {
            const { service, keystoreInteractor } = buildService();
            const result = await service.prepareColdStartTransfer(params);

            expect(keystoreInteractor.getViewingKey).not.toHaveBeenCalled();
            const recipient = result.executeOptions.recipient;
            expect(recipient.publicViewingKey).toBeUndefined();
            expect(recipient.noteSecretsMap).toBeDefined();
            expect(result.executeOptions.recipientEvmAddress).toBe(RECIPIENT_EVM_ADDRESS);
        });

        it("forward outOfBand recipient to orchestrator", async () => {
            const { service, core } = buildService();
            await service.prepareColdStartTransfer(params);

            expect(core.prepareTransact).toHaveBeenCalledWith(
                expect.objectContaining({
                    recipient: expect.objectContaining({
                        noteSecretsMap: expect.any(Map) as Map<unknown, unknown>,
                    }) as object,
                }),
            );
        });
    });

    describe("prepareTransfer — discoverable hint propagation", () => {
        it("propagate hint from RecipientDiscoveryData onto the resolved recipient", async () => {
            const callerMap = new Map<Hash, Secret>([[RECIPIENT_NOTE_ADDRESS_HASH, MOCK_SECRET]]);
            const tag = ("0x" + "fa".repeat(32)) as Hex;
            const { service } = buildService();
            const result = await service.prepareTransfer({
                inputCommitments: [MOCK_COMMITMENT_1],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                feeAmount: "0x0" as Hex,
                recipientDiscoveryData: {
                    publicViewingKey: RECIPIENT_VIEWING_KEY,
                    noteSecretsMap: callerMap,
                    hint: tag,
                },
            });
            expect(result.executeOptions.recipient.hint).toBe(tag);
        });
    });

    describe("payment requests", () => {
        const TAG = ("0x" + "ab".repeat(32)) as Hex;
        const PAYMENT_PUB_KEY = ("0x" + "cd".repeat(32)) as Hex;
        const PAYMENT_PRIV_KEY = ("0x" + "ef".repeat(32)) as Secret;
        const PAYMENT_ID = ("0x" + "11".repeat(32)) as Hex;
        const PAYMENT_CREATED_AT = "0x1" as Hex; // 1ms after epoch
        /**
         * What `PaymentRequestService.generate` actually stamps: `createdAt + requestExpiryMs`
         * at the 7-day default. The fixture carries it because production records always do —
         * a fixture shaped like a pre-expiry record would let a dropped stamp pass unnoticed.
         */
        const PAYMENT_EXPIRES_AT = bigintToHex(BigInt(PAYMENT_CREATED_AT) + 604_800_000n);

        function makePaymentRecord(): {
            paymentId: Hex;
            noteAddressHashes: Hash[];
            noteSecretsMap: Map<Hash, Secret>;
            amount: Hex;
            tokenId: Address;
            tag: Hex;
            paymentPubKey: Hex;
            paymentPrivKey: Secret;
            recipientAddress: Address;
            status: "OPEN";
            createdAt: Hex;
            expiresAt: Hex;
            fulfilledByCommitments: Hex[];
        } {
            return {
                paymentId: PAYMENT_ID,
                noteAddressHashes: [RECIPIENT_NOTE_ADDRESS_HASH],
                noteSecretsMap: new Map<Hash, Secret>([
                    [RECIPIENT_NOTE_ADDRESS_HASH, RECIPIENT_NOTE_SECRET],
                ]),
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                tag: TAG,
                paymentPubKey: PAYMENT_PUB_KEY,
                paymentPrivKey: PAYMENT_PRIV_KEY,
                recipientAddress: RECIPIENT_EVM_ADDRESS,
                status: "OPEN" as const,
                createdAt: PAYMENT_CREATED_AT,
                expiresAt: PAYMENT_EXPIRES_AT,
                fulfilledByCommitments: [],
            };
        }

        it("generatePaymentRequest delegate to PaymentRequestService and strip private fields", async () => {
            const paymentRequestService = createMockPaymentRequestService();
            (paymentRequestService.generate as ReturnType<typeof vi.fn>).mockResolvedValue(
                makePaymentRecord(),
            );

            const { service } = buildService({ paymentRequestService });

            const request = await service.generatePaymentRequest({
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
            });

            expect(paymentRequestService.generate).toHaveBeenCalledWith({
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
            });
            expect(request).toEqual({
                paymentId: PAYMENT_ID,
                noteAddressHashes: [RECIPIENT_NOTE_ADDRESS_HASH],
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
                tag: TAG,
                paymentPubKey: PAYMENT_PUB_KEY,
                expiresAt: PAYMENT_EXPIRES_AT,
            });
            // Secrets and private fields MUST not leak into the shareable request.
            expect(request).not.toHaveProperty("noteSecretsMap");
            expect(request).not.toHaveProperty("paymentPrivKey");
            expect(request).not.toHaveProperty("recipientAddress");
            expect(request).not.toHaveProperty("status");
            expect(request).not.toHaveProperty("createdAt");
        });

        // #600. The shareable payload is the ONLY thing a sender ever sees, so the stamp has to
        // survive `generatePaymentRequest` — which hand-builds the public object field by field,
        // and where `expiresAt?` being optional means a dropped field still type-checks. Asserting
        // the property in isolation would not prove much; feeding the returned object straight
        // back into the sender-side guard is what shows the two halves are actually connected.
        // Without the stamp the request reads as "predates the policy" and is fulfillable forever,
        // while the recipient still drops it from the scan set — the invisible-payment loss again.
        it("generatePaymentRequest carry expiresAt through to the sender-side expiry guard", async () => {
            const paymentRequestService = createMockPaymentRequestService();
            (paymentRequestService.generate as ReturnType<typeof vi.fn>).mockResolvedValue(
                makePaymentRecord(),
            );
            const { service, core } = buildService({ paymentRequestService });

            const request = await service.generatePaymentRequest({
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
            });
            expect(request.expiresAt).toBe(PAYMENT_EXPIRES_AT);

            vi.useFakeTimers();
            vi.setSystemTime(new Date(Number(BigInt(PAYMENT_EXPIRES_AT)) + 1));
            try {
                await expect(
                    service.prepareFulfillPaymentRequest({
                        paymentRequest: request,
                        inputCommitments: [MOCK_COMMITMENT_1],
                    }),
                ).rejects.toBeInstanceOf(PaymentRequestExpired);
            } finally {
                vi.useRealTimers();
            }
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        // A record written before expiry existed carries no stamp, and the public payload must
        // then carry no key at all — not `expiresAt: undefined`, which would survive as a
        // spurious field through the QR/link encoding.
        it("generatePaymentRequest omit expiresAt entirely for a legacy unstamped record", async () => {
            const paymentRequestService = createMockPaymentRequestService();
            const { expiresAt: _dropped, ...legacyRecord } = makePaymentRecord();
            (paymentRequestService.generate as ReturnType<typeof vi.fn>).mockResolvedValue(
                legacyRecord,
            );
            const { service } = buildService({ paymentRequestService });

            const request = await service.generatePaymentRequest({
                amount: HALF_VALUE,
                tokenId: VALID_TOKEN,
            });

            expect(request).not.toHaveProperty("expiresAt");
        });

        it("prepareFulfillPaymentRequest forward to prepareTransfer with hint = tag", async () => {
            const { service, core } = buildService();
            const record = makePaymentRecord();
            const publicRequest = {
                paymentId: record.paymentId,
                noteAddressHashes: record.noteAddressHashes,
                amount: record.amount,
                tokenId: record.tokenId,
                tag: record.tag,
                paymentPubKey: record.paymentPubKey,
            };

            await service.prepareFulfillPaymentRequest({
                paymentRequest: publicRequest,
                inputCommitments: [MOCK_COMMITMENT_1],
            });

            expect(core.prepareTransact).toHaveBeenCalledWith(
                expect.objectContaining({
                    recipient: expect.objectContaining({
                        publicViewingKey: PAYMENT_PUB_KEY,
                        hint: TAG,
                        noteAddressHash: record.noteAddressHashes,
                    }) as object,
                }),
            );
            // The fulfiller never receives the recipient's secrets.
            const firstCallArg = (core.prepareTransact as ReturnType<typeof vi.fn>).mock
                .calls[0][0] as { recipient: Record<string, unknown> };
            expect(firstCallArg.recipient.noteSecretsMap).toBeUndefined();
        });

        it("prepareFulfillPaymentRequest reject when inputCommitments exceeds slot count", async () => {
            const { service } = buildService();
            const record = makePaymentRecord(); // 1 slot
            const publicRequest = {
                paymentId: record.paymentId,
                noteAddressHashes: record.noteAddressHashes,
                amount: record.amount,
                tokenId: record.tokenId,
                tag: record.tag,
                paymentPubKey: record.paymentPubKey,
            };

            await expect(
                service.prepareFulfillPaymentRequest({
                    paymentRequest: publicRequest,
                    inputCommitments: [MOCK_COMMITMENT_1, MOCK_COMMITMENT_2],
                }),
            ).rejects.toThrow(InvalidTransactParams);
        });

        // #600. Expiry is shared with the sender precisely so it can be enforced HERE, before
        // any value moves. The recipient drops an expired request from its scan set, so paying
        // one produces a note that is on-chain, valid, and undiscoverable by them.
        it("prepareFulfillPaymentRequest reject a request whose expiresAt has passed", async () => {
            const { service, core } = buildService();
            const record = makePaymentRecord();

            await expect(
                service.prepareFulfillPaymentRequest({
                    paymentRequest: {
                        paymentId: record.paymentId,
                        noteAddressHashes: record.noteAddressHashes,
                        amount: record.amount,
                        tokenId: record.tokenId,
                        tag: record.tag,
                        paymentPubKey: record.paymentPubKey,
                        expiresAt: bigintToHex(BigInt(Date.now()) - 1n),
                    },
                    inputCommitments: [MOCK_COMMITMENT_1],
                }),
            ).rejects.toBeInstanceOf(PaymentRequestExpired);

            // Rejected before any proof work is started.
            expect(core.prepareTransact).not.toHaveBeenCalled();
        });

        it("prepareFulfillPaymentRequest accept a request whose expiresAt is still in the future", async () => {
            const { service, core } = buildService();
            const record = makePaymentRecord();

            await service.prepareFulfillPaymentRequest({
                paymentRequest: {
                    paymentId: record.paymentId,
                    noteAddressHashes: record.noteAddressHashes,
                    amount: record.amount,
                    tokenId: record.tokenId,
                    tag: record.tag,
                    paymentPubKey: record.paymentPubKey,
                    expiresAt: bigintToHex(BigInt(Date.now()) + 3_600_000n),
                },
                inputCommitments: [MOCK_COMMITMENT_1],
            });

            expect(core.prepareTransact).toHaveBeenCalledOnce();
        });

        // Requests created before expiry existed carry no stamp. They must stay fulfillable —
        // retro-voiding an already-shared request is the same invisible-payment failure in
        // reverse, with the sender blocked instead of the recipient blind.
        it("prepareFulfillPaymentRequest accept a legacy request carrying no expiresAt", async () => {
            const { service, core } = buildService();
            const record = makePaymentRecord();

            await service.prepareFulfillPaymentRequest({
                paymentRequest: {
                    paymentId: record.paymentId,
                    noteAddressHashes: record.noteAddressHashes,
                    amount: record.amount,
                    tokenId: record.tokenId,
                    tag: record.tag,
                    paymentPubKey: record.paymentPubKey,
                },
                inputCommitments: [MOCK_COMMITMENT_1],
            });

            expect(core.prepareTransact).toHaveBeenCalledOnce();
        });

        // The exact instant of expiry, both sides. The guard is `now > expiresAt`, so the stamp
        // itself is still payable and only the millisecond after it is not. The recipient's
        // isExpired uses the same comparison and IS tested at both boundaries; leaving the
        // sender side tested only at `now - 1` and `now + 1h` would let a `>` drift to `>=`
        // (or the reverse) without a single test noticing — and the two sides silently
        // disagreeing about who owns the boundary millisecond is how a payment goes missing.
        function requestExpiringAt(expiresAt: Hex): PaymentRequest {
            const record = makePaymentRecord();
            return {
                paymentId: record.paymentId,
                noteAddressHashes: record.noteAddressHashes,
                amount: record.amount,
                tokenId: record.tokenId,
                tag: record.tag,
                paymentPubKey: record.paymentPubKey,
                expiresAt,
            };
        }

        it("prepareFulfillPaymentRequest accept a request at the exact expiry instant (boundary, still payable)", async () => {
            const { service, core } = buildService();
            vi.useFakeTimers();
            vi.setSystemTime(new Date(Number(BigInt(PAYMENT_EXPIRES_AT))));
            try {
                await service.prepareFulfillPaymentRequest({
                    paymentRequest: requestExpiringAt(PAYMENT_EXPIRES_AT),
                    inputCommitments: [MOCK_COMMITMENT_1],
                });
            } finally {
                vi.useRealTimers();
            }

            expect(core.prepareTransact).toHaveBeenCalledOnce();
        });

        it("prepareFulfillPaymentRequest reject a request one millisecond past expiry", async () => {
            const { service, core } = buildService();
            vi.useFakeTimers();
            vi.setSystemTime(new Date(Number(BigInt(PAYMENT_EXPIRES_AT)) + 1));
            try {
                await expect(
                    service.prepareFulfillPaymentRequest({
                        paymentRequest: requestExpiringAt(PAYMENT_EXPIRES_AT),
                        inputCommitments: [MOCK_COMMITMENT_1],
                    }),
                ).rejects.toBeInstanceOf(PaymentRequestExpired);
            } finally {
                vi.useRealTimers();
            }

            expect(core.prepareTransact).not.toHaveBeenCalled();
        });
    });
});
