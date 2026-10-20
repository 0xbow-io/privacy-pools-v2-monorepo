import { encodeAbiParameters, encodeEventTopics } from "viem";
import { describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    IASPClient,
    ICryptoService,
    IKeystoreInteractor,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    INoteManager,
    IPoolVaultInteractor,
    IProofService,
    IRPCInteractor,
    IWitnessPreparationService,
    Label,
    Note,
    PendingNote,
    ResolvedTransferRecipient,
    Secret,
    TxLog,
} from "../../../src/internal.js";
import {
    bigintToHex,
    BuildTransactWitnessInputsSchema,
    InvalidTransactParams,
    KeystoreNotRegistered,
    TransactNoteNotActive,
    RegistrationCheckFailed,
    NoteStatus,
    PendingNoteSchema,
    POOL_VAULT_TRANSACTED_EVENT_ABI,
    createEvmPoolVaultInteractor,
    AddressSchema,
    EvmAddressEqualityComparator,
    EvmAddressFieldConverter,
    EvmContextHashService,
    EvmPayoutRoutingCodec,
    EvmRelayBatchCodec,
    TransactOrchestrator,
} from "../../../src/internal.js";

// Direct unit tests for the private generatePendingNote helper. We
// reach in via bracket-access because the bug it guards against —
// ownerAddress = "0x0" sentinel failing AddressSchema's 40-hex-char
// check inside BuildTransactWitnessInputsSchema — never trips the
// PoolSessionTransfer mocks (those replace the orchestrator wholesale)
// or the existing integration tests (workflow_dispatch only,
// last green run 2026-04-01).

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const VALID_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const VALID_LABEL = "0x4444444444444444444444444444444444444444444444444444444444444444" as Hash;
const VALUE = "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000" as Hex;
const RECIPIENT_NOTE_ADDRESS_HASH =
    "0x6666666666666666666666666666666666666666666666666666666666666666" as Hash;
const RECIPIENT_NOTE_SECRET =
    "0xeeee111111111111111111111111111111111111111111111111111111111111" as Secret;
const FAKE_COMMITMENT =
    "0x7777777777777777777777777777777777777777777777777777777777777777" as Hash;
const FAKE_PRIVATE_NULLIFYING_KEY =
    "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex;
const FAKE_PRIVATE_REVOCABLE_KEY =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

function createOrchestrator(
    noteManager: INoteManager = {} as unknown as INoteManager,
    opts: {
        poolVaultInteractor?: IPoolVaultInteractor;
        keystoreInteractor?: IKeystoreInteractor;
        aspClient?: IASPClient;
        logger?: ILogger;
    } = {},
): TransactOrchestrator {
    const cryptoService = {
        generateSecret: vi.fn(() => RECIPIENT_NOTE_SECRET),
    } as unknown as ICryptoService;

    const noteComputationService = {
        computeNoteAddressHash: vi.fn(() => RECIPIENT_NOTE_ADDRESS_HASH),
        computeFullCommitment: vi.fn(() => FAKE_COMMITMENT),
        generateNoteData: vi.fn(() => ({ hint: "0x0" as Hex, data: "0x0" as Hex })),
        generatePaymentRequestNoteData: vi.fn(() => ({ hint: "0x0" as Hex, data: "0x0" as Hex })),
        decodeNotePayload: vi.fn(),
    } as unknown as INoteComputationService;

    // Everything below is unused by generatePendingNote but the
    // schema-validating constructor needs the right shape.
    const keystoreManager = {
        getPrivateNullifyingKey: () => FAKE_PRIVATE_NULLIFYING_KEY,
        getPrivateRevocableKey: () => FAKE_PRIVATE_REVOCABLE_KEY,
        getViewingKeyPair: () => ({
            publicKey: ("0x" + "cc".repeat(32)) as Hex,
            privateKey: ("0x" + "dd".repeat(32)) as Secret,
        }),
    } as unknown as IKeystoreManager;
    const witnessPreparationService = {} as unknown as IWitnessPreparationService;
    const proofService = {} as unknown as IProofService;
    const keystoreInteractor = opts.keystoreInteractor ?? ({} as unknown as IKeystoreInteractor);
    const poolVaultInteractor =
        opts.poolVaultInteractor ??
        ({
            getAddress: () => VALID_POOL,
        } as unknown as IPoolVaultInteractor);
    const aspClient = opts.aspClient ?? ({} as unknown as IASPClient);
    const rpcInteractor = {} as unknown as IRPCInteractor;

    return new TransactOrchestrator(
        {
            ownerAddress: VALID_OWNER,
            noteManager,
            keystoreManager,
            witnessPreparationService,
            proofService,
            keystoreInteractor,
            poolVaultInteractor,
            aspClient,
            cryptoService,
            noteComputationService,
            rpcInteractor,
            contextHashService: new EvmContextHashService(),
            payoutRoutingCodec: new EvmPayoutRoutingCodec(),
            relayBatchCodec: new EvmRelayBatchCodec(),
            addressFieldConverter: new EvmAddressFieldConverter(),
            addressEqualityComparator: new EvmAddressEqualityComparator(),
            addressSchema: AddressSchema,
        },
        opts.logger ? { logger: opts.logger } : undefined,
    );
}

type GeneratePendingNoteFn = (
    tokenId: Address,
    label: Hash,
    value: Hex,
    noteAddressHash?: Hash,
    secretsMap?: Map<Hash, Hex>,
) => PendingNote;

function generate(orchestrator: TransactOrchestrator): GeneratePendingNoteFn {
    return (
        orchestrator as unknown as { generatePendingNote: GeneratePendingNoteFn }
    ).generatePendingNote.bind(orchestrator);
}

type GetTransactOutputNotesFn = (
    inputNotes: Note[],
    amount: Hex,
    feeAmount: Hex,
    tokenId: Address,
    recipient: ResolvedTransferRecipient | undefined,
) => { changeNotes: PendingNote[]; recipientNotes: PendingNote[] };

function getOutputNotes(orchestrator: TransactOrchestrator): GetTransactOutputNotesFn {
    return (
        orchestrator as unknown as { getTransactOutputNotes: GetTransactOutputNotesFn }
    ).getTransactOutputNotes.bind(orchestrator);
}

type BuildNotesDataFn = (
    changeNotes: PendingNote[],
    recipientNotes: PendingNote[],
    tokenId: Address,
    recipient: ResolvedTransferRecipient | undefined,
) => unknown;

function buildNotesData(orchestrator: TransactOrchestrator): BuildNotesDataFn {
    return (orchestrator as unknown as { buildNotesData: BuildNotesDataFn }).buildNotesData.bind(
        orchestrator,
    );
}

const LABEL_A = "0x1111111111111111111111111111111111111111111111111111111111111111" as Label;
const LABEL_B = "0x2222222222222222222222222222222222222222222222222222222222222222" as Label;
const HASH_FOR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hash;
const HASH_FOR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hash;

function buildNote(label: Label, value: Hex): Note {
    return {
        noteAddressHash: RECIPIENT_NOTE_ADDRESS_HASH,
        commitment: FAKE_COMMITMENT,
        value,
        tokenId: VALID_TOKEN,
        label,
        status: NoteStatus.ACTIVE,
        ownerAddress: VALID_OWNER,
        noteSecret: RECIPIENT_NOTE_SECRET,
        isOwned: true,
        createdAtBlock: "0x100" as Hex,
        spentAtBlock: null,
        txHash: "0x0" as Hash,
    };
}

const TEN = "0xa" as Hex;
const FIVE = "0x5" as Hex;
const FIFTEEN = "0xf" as Hex;
const ZERO = "0x0" as Hex;

describe("TransactOrchestrator.generatePendingNote", () => {
    it("recipient pending notes (with caller-supplied noteAddressHash) pass PendingNoteSchema", () => {
        const note = generate(createOrchestrator())(
            VALID_TOKEN,
            VALID_LABEL,
            VALUE,
            RECIPIENT_NOTE_ADDRESS_HASH,
            new Map([[RECIPIENT_NOTE_ADDRESS_HASH, RECIPIENT_NOTE_SECRET]]),
        );

        const parsed = PendingNoteSchema.safeParse(note);
        expect(
            parsed.success,
            parsed.success
                ? ""
                : `PendingNoteSchema rejected recipient pending note: ${parsed.error.issues[0].message} (at ${parsed.error.issues[0].path.join(".")})`,
        ).toBe(true);
    });

    it("sender's own pending note (no noteAddressHash) passes PendingNoteSchema", () => {
        const note = generate(createOrchestrator())(VALID_TOKEN, VALID_LABEL, VALUE);

        const parsed = PendingNoteSchema.safeParse(note);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.ownerAddress).toBe(VALID_OWNER);
            expect(parsed.data.isOwned).toBe(true);
        }
    });

    it("recipient pending notes feed BuildTransactWitnessInputsSchema cleanly", () => {
        const recipientNote = generate(createOrchestrator())(
            VALID_TOKEN,
            VALID_LABEL,
            VALUE,
            RECIPIENT_NOTE_ADDRESS_HASH,
            new Map([[RECIPIENT_NOTE_ADDRESS_HASH, RECIPIENT_NOTE_SECRET]]),
        );

        // Minimal but valid witness inputs — only `recipientNotes` is the
        // field this regression touches; the rest are filled with the
        // shape the schema demands so the recipient-notes failure stands
        // out clearly when it reappears.
        const inputs = {
            inputNotes: [
                {
                    noteAddressHash: RECIPIENT_NOTE_ADDRESS_HASH,
                    commitment: FAKE_COMMITMENT,
                    value: VALUE,
                    tokenId: VALID_TOKEN,
                    label: VALID_LABEL,
                    status: NoteStatus.ACTIVE,
                    ownerAddress: VALID_OWNER,
                    noteSecret: RECIPIENT_NOTE_SECRET,
                    isOwned: true,
                    createdAtBlock: "0x100" as Hex,
                    spentAtBlock: null,
                    txHash: "0x0" as Hash,
                },
            ],
            changeNotes: [
                {
                    noteAddressHash: RECIPIENT_NOTE_ADDRESS_HASH,
                    commitment: FAKE_COMMITMENT,
                    value: VALUE,
                    tokenId: VALID_TOKEN,
                    label: VALID_LABEL,
                    status: NoteStatus.PENDING,
                    ownerAddress: VALID_OWNER,
                    noteSecret: RECIPIENT_NOTE_SECRET,
                    isOwned: true,
                },
            ],
            recipientNotes: [recipientNote],
            ownerAddress: VALID_OWNER,
            privateNullifyingKey: FAKE_PRIVATE_NULLIFYING_KEY,
            privateRevocableKey: FAKE_PRIVATE_REVOCABLE_KEY,
            tokenId: VALID_TOKEN,
            amountOut: "0x0" as Hex,
            tokenIdOut: VALID_TOKEN,
            context: "0x0" as Hex,
            stateLeaves: [FAKE_COMMITMENT],
            keystoreLeaves: [FAKE_COMMITMENT],
        };

        const parsed = BuildTransactWitnessInputsSchema.safeParse(inputs);
        const recipientPathError = parsed.success
            ? null
            : parsed.error.issues.find((i) => i.path[0] === "recipientNotes");
        expect(
            recipientPathError,
            recipientPathError
                ? `BuildTransactWitnessInputsSchema rejected recipientNotes[0]: ${recipientPathError.message} (at ${recipientPathError.path.join(".")})`
                : "",
        ).toBeFalsy();
    });

    it("throw InvalidTransactParams when noteSecretsMap is supplied but missing the noteAddressHash", () => {
        const wrongHash =
            "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hash;
        const map = new Map([[wrongHash, RECIPIENT_NOTE_SECRET]]);

        expect(() =>
            generate(createOrchestrator())(
                VALID_TOKEN,
                VALID_LABEL,
                VALUE,
                RECIPIENT_NOTE_ADDRESS_HASH,
                map,
            ),
        ).toThrow(InvalidTransactParams);
    });
});

describe("TransactOrchestrator.getTransactOutputNotes", () => {
    describe("deprecated positional noteAddressHash[] path", () => {
        it("preserve first-occurrence iteration order: array[i] binds to the i-th unique input label", () => {
            // Inputs ordered as [LABEL_B, LABEL_A] — groupByLabel iterates in
            // first-occurrence order so the array's element 0 binds to LABEL_B.
            const orchestrator = createOrchestrator();
            const recipient: ResolvedTransferRecipient = {
                noteAddressHash: [HASH_FOR_B, HASH_FOR_A],
            };
            const inputNotes = [buildNote(LABEL_B, TEN), buildNote(LABEL_A, TEN)];

            const { recipientNotes } = getOutputNotes(orchestrator)(
                inputNotes,
                FIFTEEN,
                ZERO,
                VALID_TOKEN,
                recipient,
            );

            expect(recipientNotes).toHaveLength(2);
            expect(recipientNotes[0].label).toBe(LABEL_B);
            expect(recipientNotes[1].label).toBe(LABEL_A);
        });

        it("throw when noteAddressHash array is shorter than the unique input label count", () => {
            const orchestrator = createOrchestrator();
            const recipient: ResolvedTransferRecipient = {
                noteAddressHash: [HASH_FOR_A],
            };
            const inputNotes = [buildNote(LABEL_A, TEN), buildNote(LABEL_B, TEN)];

            expect(() =>
                getOutputNotes(orchestrator)(inputNotes, FIFTEEN, ZERO, VALID_TOKEN, recipient),
            ).toThrow(InvalidTransactParams);
        });
    });

    describe("new noteAddressHashByLabel Map path", () => {
        it("look up hash by label name, independent of input commitment order", () => {
            // The Map is keyed by label name, so reordering inputs must NOT
            // change which hash binds to which label.
            const orchestrator = createOrchestrator();
            const recipient: ResolvedTransferRecipient = {
                noteAddressHash: [HASH_FOR_A, HASH_FOR_B],
                noteAddressHashByLabel: new Map([
                    [LABEL_A, HASH_FOR_A],
                    [LABEL_B, HASH_FOR_B],
                ]),
            };
            // Inputs intentionally reversed: B then A. Map-based lookup must
            // still bind HASH_FOR_A to LABEL_A and HASH_FOR_B to LABEL_B.
            const inputNotes = [buildNote(LABEL_B, TEN), buildNote(LABEL_A, TEN)];

            const { recipientNotes } = getOutputNotes(orchestrator)(
                inputNotes,
                FIFTEEN,
                ZERO,
                VALID_TOKEN,
                recipient,
            );

            // recipientNotes are emitted in input iteration order (LABEL_B then
            // LABEL_A) — the label binding inside each note is what matters,
            // and that comes from groupByLabel + Map lookup.
            const labelToNote = new Map(recipientNotes.map((n) => [n.label, n]));
            expect(labelToNote.has(LABEL_A)).toBe(true);
            expect(labelToNote.has(LABEL_B)).toBe(true);
            // Indirect proof of binding: when generatePendingNote receives
            // noteAddressHash, the resulting note's noteAddressHash equals the
            // SUPPLIED hash (mock just echoes it via computeNoteAddressHash).
            // Both notes happen to share RECIPIENT_NOTE_ADDRESS_HASH from the
            // mock so we can't assert on that directly — the absence of a
            // throw together with the label set is sufficient.
        });

        it("throw when the Map is missing an entry for an input label", () => {
            const orchestrator = createOrchestrator();
            const recipient: ResolvedTransferRecipient = {
                noteAddressHash: [HASH_FOR_A],
                noteAddressHashByLabel: new Map([[LABEL_A, HASH_FOR_A]]),
            };
            const inputNotes = [buildNote(LABEL_A, TEN), buildNote(LABEL_B, TEN)];

            expect(() =>
                getOutputNotes(orchestrator)(inputNotes, FIFTEEN, ZERO, VALID_TOKEN, recipient),
            ).toThrow(InvalidTransactParams);
        });

        it("throw when the Map contains a label not present in the input commitments", () => {
            const orchestrator = createOrchestrator();
            const EXTRA_LABEL =
                "0x3333333333333333333333333333333333333333333333333333333333333333" as Label;
            const recipient: ResolvedTransferRecipient = {
                noteAddressHash: [HASH_FOR_A, HASH_FOR_B],
                noteAddressHashByLabel: new Map([
                    [LABEL_A, HASH_FOR_A],
                    [EXTRA_LABEL, HASH_FOR_B],
                ]),
            };
            const inputNotes = [buildNote(LABEL_A, TEN)];

            expect(() =>
                getOutputNotes(orchestrator)(inputNotes, FIVE, ZERO, VALID_TOKEN, recipient),
            ).toThrow(InvalidTransactParams);
        });
    });

    it("throw when remainingSentAmount > 0 after the loop (post-loop truncation guard)", () => {
        // Inputs total 10 but amount asks for 20. The upstream amount/value
        // check normally rejects this, but `getTransactOutputNotes` is called
        // here in isolation so it reaches the post-loop guard with
        // remainingSentAmount > 0.
        const recipient: ResolvedTransferRecipient = {
            noteAddressHash: [HASH_FOR_A, HASH_FOR_B],
        };
        const inputNotes = [buildNote(LABEL_A, FIVE), buildNote(LABEL_B, FIVE)];
        const AMOUNT_OVERSHOOT = "0x14" as Hex; // 20

        expect(() =>
            getOutputNotes(createOrchestrator())(
                inputNotes,
                AMOUNT_OVERSHOOT,
                ZERO,
                VALID_TOKEN,
                recipient,
            ),
        ).toThrow(InvalidTransactParams);
    });
});

describe("TransactOrchestrator.buildNotesData", () => {
    const PR_PUB_KEY = ("0x" + "ab".repeat(32)) as Hex;
    const PR_TAG = ("0x" + "cd".repeat(32)) as Hash;

    function recipientPendingNote(): PendingNote {
        return {
            noteAddressHash: RECIPIENT_NOTE_ADDRESS_HASH,
            commitment: FAKE_COMMITMENT,
            value: TEN,
            tokenId: VALID_TOKEN,
            label: VALID_LABEL,
            isOwned: false,
            ownerAddress: VALID_OWNER,
            status: NoteStatus.PENDING,
            noteSecret: ("0x" + "00".repeat(32)) as Secret,
        };
    }

    it("emit a v2 no-secret payload for the discoverable-without-secrets recipient", () => {
        const orchestrator = createOrchestrator();
        const ncs = (orchestrator as unknown as { noteComputationService: INoteComputationService })
            .noteComputationService;
        // discoverable-without-secrets: publicViewingKey present, no noteSecretsMap.
        const recipient: ResolvedTransferRecipient = {
            noteAddressHash: [RECIPIENT_NOTE_ADDRESS_HASH],
            publicViewingKey: PR_PUB_KEY,
            hint: PR_TAG,
        };

        buildNotesData(orchestrator)([], [recipientPendingNote()], VALID_TOKEN, recipient);

        expect(ncs.generatePaymentRequestNoteData).toHaveBeenCalledWith(
            expect.objectContaining({
                noteAddressHash: RECIPIENT_NOTE_ADDRESS_HASH,
                value: TEN,
                tokenId: VALID_TOKEN,
                label: VALID_LABEL,
            }),
            PR_PUB_KEY,
            PR_TAG,
        );
        // The legacy v1 path (which would need the secret) is never taken for the recipient.
        expect(ncs.generateNoteData).not.toHaveBeenCalledWith(
            expect.anything(),
            PR_PUB_KEY,
            expect.anything(),
        );
    });
});

describe("TransactOrchestrator.persistNoteUpdates", () => {
    it("flush note state to storage after marking inputs spent", async () => {
        const noteManager = {
            updateNoteStatus: vi.fn(),
            addNote: vi.fn(),
            flush: vi.fn(async () => { /* no-op */ }),
        } as unknown as INoteManager;
        // The verification gate now always runs, so this case needs a decoder even though it
        // asserts nothing about verification.
        const orchestrator = createOrchestrator(noteManager, {
            poolVaultInteractor: {
                getAddress: () => VALID_POOL,
                extractSpentNullifiers: () => [],
            } as unknown as IPoolVaultInteractor,
        });

        // This case is about durability (does the SPENT mark reach storage), not about receipt
        // verification — that has its own describe block below. An empty `expectedNullifiers`
        // set is vacuously confirmed, so the verification gate passes and the flush is exercised.
        await orchestrator.persistNoteUpdates(
            [buildNote(VALID_LABEL, VALUE)],
            [],
            "0xabc" as Hash,
            {
                expectedNullifiers: [],
                receiptLogs: [],
            },
        );

        // The in-memory SPENT mark is worthless if the process exits before it reaches storage:
        // the next start would treat the note as ACTIVE and the re-spend would revert on-chain.
        expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
            FAKE_COMMITMENT,
            NoteStatus.SPENT,
        );
        expect(noteManager.flush).toHaveBeenCalledOnce();
    });
});

describe("TransactOrchestrator.persistNoteUpdates verify-before-persist (AW-L-02 / #1070)", () => {
    const POOL_NULLIFIER = 0xdeadn;
    const OTHER_CONTRACT = "0x9999999999999999999999999999999999999999" as Address;

    // Real Transacted receipt log, encoded exactly as an EVM node emits it, so the
    // orchestrator drives the REAL PoolVaultInteractor.extractSpentNullifiers decode path
    // and the REAL nullifier-match in persistNoteUpdates end-to-end (TEST-7: not stubbed).
    function makeTransactedLog(nullifierHashes: bigint[], address: Address = VALID_POOL): TxLog {
        const topics = encodeEventTopics({
            abi: POOL_VAULT_TRANSACTED_EVENT_ABI,
            eventName: "Transacted",
            args: { asset: VALID_TOKEN, caller: VALID_OWNER },
        }) as Hex[];
        const data = encodeAbiParameters(
            [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256" }],
            [[], nullifierHashes, 0n],
        );
        return {
            address,
            topics,
            data,
            blockNumber: "0x1" as Hex,
            transactionHash: "0xtx" as Hex,
            logIndex: 0,
        };
    }

    function realPoolVault(): IPoolVaultInteractor {
        const rpc = {
            readContract: vi.fn(async () => 0n),
            getLogs: vi.fn(async () => []),
            getLogsPaginated: vi.fn(async () => []),
            getBlockNumber: vi.fn(async () => "0x0"),
            waitForTransactionReceipt: vi.fn(),
        } as unknown as IRPCInteractor;
        return createEvmPoolVaultInteractor({ rpcInteractor: rpc, contractAddress: VALID_POOL });
    }

    function buildManager(): INoteManager {
        return {
            updateNoteStatus: vi.fn(),
            addNote: vi.fn(),
            flush: vi.fn(async () => { /* no-op */ }),
        } as unknown as INoteManager;
    }

    function buildLogger(): ILogger {
        return {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        } as unknown as ILogger;
    }

    it("persist SPENT when the receipt's PoolVault Transacted logs confirm every spent nullifier", async () => {
        const noteManager = buildManager();
        const orchestrator = createOrchestrator(noteManager, {
            poolVaultInteractor: realPoolVault(),
        });

        await orchestrator.persistNoteUpdates([buildNote(VALID_LABEL, VALUE)], [], "0xtx" as Hash, {
            expectedNullifiers: [bigintToHex(POOL_NULLIFIER)],
            receiptLogs: [makeTransactedLog([POOL_NULLIFIER])],
        });

        expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
            FAKE_COMMITMENT,
            NoteStatus.SPENT,
        );
        expect(noteManager.flush).toHaveBeenCalledOnce();
    });

    it("warn and persist nothing when the receipt logs do not contain the spent nullifier (bogus/unrelated txHash)", async () => {
        const noteManager = buildManager();
        const logger = buildLogger();
        const orchestrator = createOrchestrator(noteManager, {
            poolVaultInteractor: realPoolVault(),
            logger,
        });

        // Relayer returned the hash of a real-but-unrelated tx: its Transacted log spends a
        // DIFFERENT nullifier. The note must NOT be silently marked SPENT.
        await orchestrator.persistNoteUpdates(
            [buildNote(VALID_LABEL, VALUE)],
            [],
            "0xbogus" as Hash,
            {
                expectedNullifiers: [bigintToHex(POOL_NULLIFIER)],
                receiptLogs: [makeTransactedLog([0x1234n])],
            },
        );

        expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
        expect(noteManager.addNote).not.toHaveBeenCalled();
        expect(noteManager.flush).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledOnce();
    });

    it("warn and persist nothing when the confirming Transacted log is emitted by a non-PoolVault contract", async () => {
        const noteManager = buildManager();
        const logger = buildLogger();
        const orchestrator = createOrchestrator(noteManager, {
            poolVaultInteractor: realPoolVault(),
            logger,
        });

        // The right nullifier, but the log's emitter is not the PoolVault — must not confirm.
        await orchestrator.persistNoteUpdates([buildNote(VALID_LABEL, VALUE)], [], "0xtx" as Hash, {
            expectedNullifiers: [bigintToHex(POOL_NULLIFIER)],
            receiptLogs: [makeTransactedLog([POOL_NULLIFIER], OTHER_CONTRACT)],
        });

        expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledOnce();
    });

    // Replaces an earlier case that asserted "persist SPENT unchanged when no verification is
    // supplied". That fail-OPEN behaviour WAS the defect: `verification` was optional, so the
    // relayed swap paths skipped the gate entirely and persisted SPENT on an unverified relayer
    // txHash. The parameter is now required, so omitting it is a compile error and cannot be
    // expressed as a runtime test. What remains worth covering is the adversarial shape that
    // reaches the gate: a receipt carrying no Transacted logs at all.
    it("warn and persist nothing when the receipt carries no Transacted logs at all", async () => {
        const noteManager = buildManager();
        const logger = buildLogger();
        const orchestrator = createOrchestrator(noteManager, {
            poolVaultInteractor: realPoolVault(),
            logger,
        });

        // A relayer can return the hash of any successful tx — including one that touched the
        // pool not at all, whose receipt therefore has zero Transacted logs to decode.
        await orchestrator.persistNoteUpdates([buildNote(VALID_LABEL, VALUE)], [], "0xtx" as Hash, {
            expectedNullifiers: [bigintToHex(POOL_NULLIFIER)],
            receiptLogs: [],
        });

        expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
        expect(noteManager.flush).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledOnce();
    });

    // The implementation carries an explicit `if (!verification)` guard whose own comment names
    // the callers TypeScript cannot police: plain-JS consumers, `as any` dispatch, a downstream
    // package compiled against the older optional-parameter .d.ts. That branch is reachable in
    // production and it sits on the terminal-SPENT path, so leaving it uncovered means the
    // difference between "warns and persists nothing" and "throws on undefined AFTER the spend
    // already confirmed" is asserted by a comment alone. Reaching it needs a cast precisely
    // because the required parameter does its job at compile time.
    it("warn and persist nothing when verification is omitted entirely by an untyped caller", async () => {
        const noteManager = buildManager();
        const logger = buildLogger();
        const orchestrator = createOrchestrator(noteManager, {
            poolVaultInteractor: realPoolVault(),
            logger,
        });

        const persistBare = orchestrator.persistNoteUpdates.bind(orchestrator) as (
            ...args: unknown[]
        ) => Promise<boolean>;

        await expect(
            persistBare([buildNote(VALID_LABEL, VALUE)], [], "0xtx" as Hash),
        ).resolves.toBe(false);

        expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
        expect(noteManager.addNote).not.toHaveBeenCalled();
        expect(noteManager.flush).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledOnce();
    });

    // The verdict used to die here. Skipping persistence protected our own note state,
    // but persistNoteUpdates returned void, so PoolSessionTransfer.finalizeTransfer handed
    // back a successful TransferResult either way and a caller reading txReceipt.status
    // announced a completed transfer while nothing had entered the pool. It is now returned
    // and surfaced as TransferResult.spentNullifiersConfirmed.
    it("REPORT true when the receipt confirms every expected nullifier", async () => {
        const orchestrator = createOrchestrator(buildManager(), {
            poolVaultInteractor: realPoolVault(),
        });

        await expect(
            orchestrator.persistNoteUpdates([buildNote(VALID_LABEL, VALUE)], [], "0xtx" as Hash, {
                expectedNullifiers: [bigintToHex(POOL_NULLIFIER)],
                receiptLogs: [makeTransactedLog([POOL_NULLIFIER])],
            }),
        ).resolves.toBe(true);
    });

    it("REPORT false for an unrelated successful receipt, so the caller cannot claim success", async () => {
        const orchestrator = createOrchestrator(buildManager(), {
            poolVaultInteractor: realPoolVault(),
            logger: buildLogger(),
        });

        // The shape that produced the bug in the field: a receipt that succeeded, for a
        // transaction that is not ours. Persisting nothing was already correct; staying
        // silent about it was not.
        await expect(
            orchestrator.persistNoteUpdates([buildNote(VALID_LABEL, VALUE)], [], "0xtx" as Hash, {
                expectedNullifiers: [bigintToHex(POOL_NULLIFIER)],
                receiptLogs: [],
            }),
        ).resolves.toBe(false);
    });
});

describe("TransactOrchestrator.getNotesTokenId", () => {
    type GetNotesTokenIdFn = (notes: Note[]) => Address;
    const getNotesTokenId = (orchestrator: TransactOrchestrator): GetNotesTokenIdFn =>
        (orchestrator as unknown as { getNotesTokenId: GetNotesTokenIdFn }).getNotesTokenId.bind(
            orchestrator,
        );
    const withToken = (note: Note, tokenId: string): Note => ({
        ...note,
        tokenId: tokenId as Address,
    });

    it("accept notes that spell the same token with different casing", () => {
        // One account can hold a note with the checksummed address and another
        // with the lowercase one; they are the same token and must share a proof.
        const orchestrator = createOrchestrator();
        // The real EIP-55 checksum of VALID_TOKEN, the spelling an account can hold.
        const checksummed = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
        const notes = [
            withToken(buildNote(LABEL_A, TEN), checksummed),
            withToken(buildNote(LABEL_B, FIVE), VALID_TOKEN),
        ];

        expect(getNotesTokenId(orchestrator)(notes)).toBe(checksummed);
    });

    it("still reject notes of different tokens", () => {
        const orchestrator = createOrchestrator();
        const notes = [
            buildNote(LABEL_A, TEN),
            withToken(buildNote(LABEL_B, FIVE), "0xcccccccccccccccccccccccccccccccccccccccc"),
        ];

        expect(() => getNotesTokenId(orchestrator)(notes)).toThrow(InvalidTransactParams);
    });
});

describe("TransactOrchestrator.prepareTransact keystore registration", () => {
    const REGISTERED_HASH = ("0x" + "ab".repeat(32)) as Hash;
    const UNREGISTERED_HASH = "0x0" as Hash;
    const PAST_THE_CHECK = "reached witness stage";

    function harness(nullifyingKeyHash: () => Promise<Hash>) {
        const getNullifyingKeyHash = vi.fn(nullifyingKeyHash);
        const getKeystoreLeaves = vi.fn().mockResolvedValue([]);
        // The first thing prepareTransact does after the registration check is fetch the merkle
        // leaves, so a rejecting getStateLeaves marks "got past the check" without a real witness.
        const getStateLeaves = vi.fn().mockRejectedValue(new Error(PAST_THE_CHECK));
        const noteManager = {
            getNote: vi.fn(() => buildNote(LABEL_A, TEN)),
        } as unknown as INoteManager;
        const orchestrator = createOrchestrator(noteManager, {
            keystoreInteractor: {
                getNullifyingKeyHash,
                getKeystoreLeaves,
            } as unknown as IKeystoreInteractor,
            poolVaultInteractor: {
                getAddress: () => VALID_POOL,
                getStateLeaves,
            } as unknown as IPoolVaultInteractor,
            // fetchMerkleLeaves reads all three trees together; the ASP one must exist or Promise.all
            // is never reached and the sentinel rejection goes unobserved.
            aspClient: {
                getAssociationSetLeaves: vi.fn().mockResolvedValue([]),
            } as unknown as IASPClient,
        });
        return { orchestrator, getNullifyingKeyHash, getKeystoreLeaves, getStateLeaves };
    }

    const params = (extra: { pendingKeystoreRegistration?: boolean } = {}) => ({
        inputCommitments: [FAKE_COMMITMENT],
        amount: FIVE,
        tokenId: VALID_TOKEN,
        relayAddress: VALID_OWNER,
        feeAmount: ZERO,
        processorAddress: VALID_OWNER,
        amountOut: FIVE,
        recipientAddress: VALID_OWNER,
        ...extra,
    });

    it("throw KeystoreNotRegistered before fetching any merkle leaves when the owner never registered", async () => {
        const { orchestrator, getKeystoreLeaves, getStateLeaves } = harness(() =>
            Promise.resolve(UNREGISTERED_HASH),
        );

        await expect(orchestrator.prepareTransact(params())).rejects.toThrow(KeystoreNotRegistered);
        expect(getStateLeaves).not.toHaveBeenCalled();
        expect(getKeystoreLeaves).not.toHaveBeenCalled();
    });

    it("name the owner in the KeystoreNotRegistered message", async () => {
        const { orchestrator } = harness(() => Promise.resolve(UNREGISTERED_HASH));

        await expect(orchestrator.prepareTransact(params())).rejects.toThrow(VALID_OWNER);
    });

    it("read the registration of the session owner", async () => {
        const { orchestrator, getNullifyingKeyHash } = harness(() => Promise.resolve(REGISTERED_HASH));

        await orchestrator.prepareTransact(params()).catch(() => undefined);

        expect(getNullifyingKeyHash).toHaveBeenCalledWith(VALID_OWNER);
    });

    it("proceed to witness building when the owner is registered", async () => {
        const { orchestrator, getStateLeaves } = harness(() => Promise.resolve(REGISTERED_HASH));

        await expect(orchestrator.prepareTransact(params())).rejects.toThrow(PAST_THE_CHECK);
        expect(getStateLeaves).toHaveBeenCalledOnce();
    });

    it("skip the check for a register-and-withdraw bundle, whose owner is not on-chain yet", async () => {
        const { orchestrator, getNullifyingKeyHash } = harness(() => Promise.resolve(UNREGISTERED_HASH));

        await expect(
            orchestrator.prepareTransact(params({ pendingKeystoreRegistration: true })),
        ).rejects.toThrow(PAST_THE_CHECK);
        expect(getNullifyingKeyHash).not.toHaveBeenCalled();
    });

    it("wrap a failed registration read in RegistrationCheckFailed", async () => {
        const { orchestrator } = harness(() => Promise.reject(new Error("rpc down")));

        await expect(orchestrator.prepareTransact(params())).rejects.toThrow(RegistrationCheckFailed);
    });

    it("keep the ACTIVE-note check ahead of the registration check", async () => {
        const { orchestrator, getNullifyingKeyHash } = harness(() => Promise.resolve(UNREGISTERED_HASH));
        const spent = { ...buildNote(LABEL_A, TEN), status: NoteStatus.SPENT };
        (
            (orchestrator as unknown as { noteManager: { getNote: () => Note } }).noteManager
        ).getNote = () => spent;

        await expect(orchestrator.prepareTransact(params())).rejects.toThrow(TransactNoteNotActive);
        expect(getNullifyingKeyHash).not.toHaveBeenCalled();
    });
});
