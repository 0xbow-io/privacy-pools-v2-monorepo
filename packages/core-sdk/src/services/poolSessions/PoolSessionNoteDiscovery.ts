import type {
    Address,
    DiscoveredNote,
    DiscoverNotesParams,
    EventSnapshot,
    EVMProof,
    FinalizedBlockResult,
    Hash,
    Hex,
    IAddressFieldConverter,
    IASPClient,
    IASPDataProvider,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    INoteDiscoveryService,
    INoteManager,
    IPaymentRequestService,
    IPoolSessionNoteDiscovery,
    IPoolVaultInteractor,
    Note,
    NoteEvent,
    PoolSessionNoteDiscoveryConfig,
    PoolSessionNoteDiscoveryDependencies,
    PreparedTransaction,
    PurgePhantomNotesParams,
    SnapshotArrayName,
    StatusRagequit,
    StatusTransact,
    TxLog,
    IRPCInteractor,
} from "../../internal.js";
import {
    bigintToHex,
    InvalidStatusTransitionError,
    lookupCommitmentTimestamp,
    NoteDiscoveryScanFailed,
    NoteNotFoundError,
    NoteStatus,
    StateInvariantViolation,
} from "../../internal.js";

/**
 * How many authoritative `spentNullifiers` reads to have in flight at once during
 * rejected-note recovery.
 *
 * The reads are batched rather than issued all at once because the case that makes batching
 * worth doing is the same case that makes an unbounded burst harmful: a single ASP outage or an
 * over-broad revocation leaves hundreds of notes REJECTED together, and firing hundreds of
 * simultaneous `eth_call`s is what public RPC endpoints rate-limit. Every rejection is mapped to
 * fail-closed, so a throttled burst would not recover anything at all — an unbounded fan-out
 * defeats itself in precisely the mass-recovery scenario it exists to speed up.
 *
 * 8 keeps the wallet's discovery path from serializing hundreds of round trips while staying
 * under the concurrency any mainstream provider throttles at.
 */
const NULLIFIER_SPEND_CHECK_CONCURRENCY = 8;

/**
 * Confirmations a ragequit log needs before it may drive a terminal `EXITED`, when
 * the provider cannot answer the `finalized` block tag at all.
 *
 * The tag is the real boundary and is preferred whenever it is served. This is the
 * fallback for the providers that do not serve it, and a fallback is needed rather
 * than a refusal: without one, those users would never record an exit, and their
 * balance would keep counting notes that are gone — overstating funds, which is its
 * own way to lose money.
 *
 * 64 is roughly two epochs, the neighbourhood where Ethereum finalizes. It is an
 * approximation on purpose and is not claimed to be safe on every chain this SDK can
 * be pointed at; it is strictly better than the head, which is what this replaces.
 */
const RAGEQUIT_FINALITY_FALLBACK_CONFIRMATIONS = 64n;

/**
 * How far below head an unresolved commitment may still hold the sync cursor.
 *
 * A note payload is written by whoever sent the transaction, and nothing forces the
 * commitment it names to be one the pool ever accepted: a one-wei deposit can carry a
 * payload naming a commitment that never enters contract storage. Such a commitment never
 * resolves, so an unbounded hold parks the cursor at that block permanently and every later
 * note stops being discovered.
 *
 * A commitment that is genuinely ours and merely late is late by a reorg or by an RPC
 * lagging the log it just served, both of which resolve within a few blocks. Past this
 * depth the absence is settled, not transient, so the discovery is dropped and the cursor
 * moves on. 64 is the same two-epoch neighbourhood used for the ragequit finality fallback.
 */
const UNRESOLVED_TIMESTAMP_HOLD_BLOCKS = 64n;

/**
 * Orchestrates note discovery by fetching on-chain events from the PoolVault contract,
 * delegating event scanning to NoteDiscoveryService, and integrating discovered notes
 * into the NoteManager. Generic over the chain's prepared-transaction type `TTx`, address type
 * `TAddress`, on-chain proof type `TProof`, and raw receipt-log type `TLog`.
 *
 * `INoteComputationService` still takes a concrete `Address` (not `TAddress`) — by design, per
 * the same boundary as `PoolSessionDeposit`. The call into it below routes through the injected
 * `addressFieldConverter` ({@link IAddressFieldConverter}) rather than a raw cast — except for a
 * stealth-owned deposit's `ownerAddress`, which is always EVM-hex-shaped regardless of `TAddress`
 * (see {@link INoteDiscoveryService.scanStealthDeposits}) and is used as-is.
 */
/**
 * Where a ragequit row came from. `chain` is a node's own answer and is
 * authoritative; `asp` is an unauthenticated row in the provider's snapshot
 * and is only ever a claim to be corroborated.
 */
type RagequitProvenance = "chain" | "asp";

export class PoolSessionNoteDiscovery<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionNoteDiscovery<TAddress>
{
    private readonly ownerAddress: TAddress;
    private readonly noteDiscoveryService: INoteDiscoveryService<TAddress>;
    private readonly noteManager: INoteManager<TAddress>;
    private readonly rpcInteractor?: Pick<IRPCInteractor, "getFinalizedBlockNumber">;
    private readonly keystoreManager: IKeystoreManager;
    private readonly poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    private readonly noteComputationService: INoteComputationService;
    private readonly addressFieldConverter: IAddressFieldConverter<TAddress>;
    private readonly aspDataProvider: IASPDataProvider;
    private readonly aspClient: IASPClient;
    private readonly paymentRequestService: IPaymentRequestService;
    private readonly logger?: ILogger;

    /**
     * Creates a new PoolSessionNoteDiscovery instance.
     * @param config - Required configuration with service dependencies.
     * @param dependencies - Optional dependencies (e.g. logger).
     */
    constructor(
        config: PoolSessionNoteDiscoveryConfig<TTx, TAddress, TProof, TLog>,
        dependencies?: PoolSessionNoteDiscoveryDependencies,
    ) {
        this.ownerAddress = config.ownerAddress;
        this.noteDiscoveryService = config.noteDiscoveryService;
        this.noteManager = config.noteManager;
        this.rpcInteractor = config.rpcInteractor;
        this.keystoreManager = config.keystoreManager;
        this.poolVaultInteractor = config.poolVaultInteractor;
        this.noteComputationService = config.noteComputationService;
        this.addressFieldConverter = config.addressFieldConverter;
        this.aspDataProvider = config.aspDataProvider;
        this.aspClient = config.aspClient;
        this.paymentRequestService = config.paymentRequestService;
        this.logger = dependencies?.logger;
    }

    /**
     * @inheritdoc IPoolSessionNoteDiscovery.discoverNotes
     * @throws {NoteDiscoveryScanFailed} If event fetching, scanning, or note insertion fails.
     */
    async discoverNotes(params?: DiscoverNotesParams): Promise<Note<TAddress>[]> {
        try {
            const fromBlockHex = params?.fromBlock ?? this.noteManager.getSyncCursor();
            const currentBlockHex = await this.poolVaultInteractor.getCurrentCursor();

            if (BigInt(fromBlockHex) >= BigInt(currentBlockHex)) {
                this.logger?.debug("Note discovery: already synced", {
                    fromBlock: fromBlockHex,
                    toBlock: currentBlockHex,
                });
                return [];
            }

            const events = await this.getNoteEvents(fromBlockHex, currentBlockHex);

            this.logger?.debug("Fetched note events from chain", {
                fromBlock: fromBlockHex,
                toBlock: currentBlockHex,
                eventCount: events.length,
            });

            const { privateKey: viewingPrivKey } = this.keystoreManager.getViewingKeyPair();

            // An empty array means "no contacts": it must run catch-all, not a targeted scan that
            // finds nothing and then advances the shared cursor (see the cursor guard below).
            const contacts = params?.contacts ?? [];
            const isTargeted = contacts.length > 0;

            let discovered: DiscoveredNote[];
            if (isTargeted) {
                discovered = this.noteDiscoveryService.scanTargeted(
                    events,
                    contacts,
                    viewingPrivKey,
                    this.ownerAddress,
                );
            } else {
                // No contacts: run catch-all AND payment-request scans against the same event set.
                // Payment-request matches are O(1) via tag filter; catch-all is O(N) trial decryption.
                // A single event will only match one scheme — payment-request scan validates the
                // payload's noteSecret is in the request's slot map, so unrelated events are skipped.
                // Scan ALL live requests, not just OPEN ones: a request's FULFILLED display
                // status must never gate discovery, or an attacker's phantom "fulfilled" flip
                // would suppress a genuine later payment note. The scan set is bounded only by
                // recipient archive + time expiry (#600).
                const scannableRequests = await this.paymentRequestService.getScannableRequests();
                const catchAll = this.noteDiscoveryService.scanCatchAll(
                    events,
                    viewingPrivKey,
                    this.ownerAddress,
                );
                const paymentRequest = this.noteDiscoveryService.scanPaymentRequests(
                    events,
                    scannableRequests,
                );
                discovered = [...catchAll, ...paymentRequest];
            }

            // Opt-in only (see DiscoverNotesParams.stealthDepositCredentials) — most accounts
            // never opt into dust rescue, so this scan doesn't run on every discovery pass. Also
            // gated on the injected noteDiscoveryService actually implementing the optional
            // scanStealthDeposits (core-sdk's base NoteDiscoveryService does not; a chain-specific
            // one, e.g. evm-sdk's, does) — credentials with no capability to use them is a no-op,
            // not an error.
            if (params?.stealthDepositCredentials !== undefined) {
                const stealthDeposits = this.noteDiscoveryService.scanStealthDeposits?.(
                    events,
                    params.stealthDepositCredentials,
                );
                if (stealthDeposits) discovered = [...discovered, ...stealthDeposits];
            }

            this.logger?.debug("Note discovery scan complete", {
                mode: isTargeted ? "targeted" : "catch-all+payment-request",
                discoveredCount: discovered.length,
            });

            const notes: Note<TAddress>[] = [];

            // Dedupe against notes already in the manager AND against
            // duplicates within the current scan batch. Chain invariant rules
            // out two Note events sharing a commitment in the same pool, but
            // `eth_getLogs` can return the same log twice during reorg windows
            // — a cheap `Set<Hex>` guard is worth the RPC-quirk insurance.
            const seen = new Set<Hex>();
            const newDiscoveries = discovered.filter((d) => {
                if (seen.has(d.commitment)) {
                    this.logger?.debug("Skipping intra-scan duplicate commitment", {
                        commitment: d.commitment,
                    });
                    return false;
                }
                seen.add(d.commitment);
                if (this.noteExists(d.commitment)) {
                    this.logger?.debug("Skipping duplicate note", {
                        commitment: d.commitment,
                    });
                    return false;
                }
                return true;
            });

            // Resolve the on-chain block.timestamp for every discovered commitment.
            // `Note.createdAtBlock` is the timestamp used by
            // `computeTimestampedLeaf(commitment, createdAtBlock)` in WitnessPreparationService —
            // the on-chain leaf is `PoseidonT3.hash([commitment, block.timestamp])`. A note is
            // never persisted without an authoritative timestamp; a sentinel would silently break
            // withdrawal proofs.
            // Resolve each discovered note's tokenId back to the chain's real address type.
            // `disc.tokenId` is the field-converted value recovered from the decrypted payload —
            // for EVM this is already the real address (identity conversion), but a chain whose
            // conversion is a one-way hash (Stellar) can only resolve it by cross-referencing
            // on-chain data (see IPoolVaultChainAdapter.resolveTokenId's doc comment). A note
            // whose tokenId can't be resolved yet (an asset never observed on-chain by this
            // interactor) is treated the same as an unresolved commitment timestamp below —
            // skipped this pass, retried next scan.
            const resolved = await Promise.all(
                newDiscoveries.map(async (d) => {
                    const lookup = await lookupCommitmentTimestamp(
                        this.poolVaultInteractor,
                        d.commitment,
                    );
                    return {
                        ...d,
                        createdAtTimestamp: lookup.status === "found" ? lookup.timestamp : null,
                        // Why it did not resolve: only a confirmed absence may stop holding
                        // the cursor (stillHoldingUnresolved).
                        timestampLookup: lookup.status,
                        resolvedTokenId: await this.poolVaultInteractor.resolveTokenId(
                            d.tokenId as unknown as Hash,
                        ),
                    };
                }),
            );

            // A null timestamp means the commitment is not in contract storage yet — a reorg, or an
            // RPC lagging behind the Note event we just read. Persist the notes that DID resolve and
            // skip the rest; the cursor is held at the earliest unresolved block (below) so only
            // that tail is retried next scan. Failing the whole batch would block every other new
            // note on one lagging commitment; advancing past it would lose the note for good (#73).
            const pendingFulfillments: {
                paymentId: Hex;
                commitment: Hex;
                noteAddressHash: Hash;
                value: Hex;
            }[] = [];
            const unresolved: (typeof resolved)[number][] = [];

            for (const disc of resolved) {
                if (!disc.createdAtTimestamp || disc.resolvedTokenId === null) {
                    unresolved.push(disc);
                    continue;
                }

                // Stealth-owned deposits (scanStealthDeposits) carry their own true owner —
                // the derived stealth address, not this session's registered address. Every
                // other scan path leaves ownerAddress unset, falling back to the session owner.
                // The stealth address is always EVM-hex-shaped (see INoteDiscoveryService.
                // scanStealthDeposits) and already field-sized, so it bypasses the injected
                // addressFieldConverter; the session's own TAddress owner routes through it.
                const ownerAddressField: Hex = disc.ownerAddress
                    ? (disc.ownerAddress as unknown as Hex)
                    : this.addressFieldConverter.toField(this.ownerAddress);
                const noteAddressHash = this.noteComputationService.computeNoteAddressHash(
                    ownerAddressField,
                    disc.noteSecret,
                );

                // `disc.ownerAddress` (for stealth notes) comes from secp256k1 derivation and
                // stays meaningful as `TAddress` only for an EVM deployment — `tokenId` above is
                // resolved chain-correctly via `resolveTokenId`, but stealth ownership recovery
                // has no Stellar equivalent yet.
                const note: Note<TAddress> = {
                    noteAddressHash,
                    commitment: disc.commitment,
                    value: disc.value,
                    tokenId: disc.resolvedTokenId,
                    label: disc.label as Hash,
                    status: NoteStatus.PENDING,
                    ownerAddress: disc.ownerAddress
                        ? (disc.ownerAddress as unknown as TAddress)
                        : this.ownerAddress,
                    noteSecret: disc.noteSecret,
                    isOwned: true,
                    createdAtBlock: disc.createdAtTimestamp,
                    spentAtBlock: null,
                    txHash: disc.txHash,
                };

                this.noteManager.addNote(note);
                notes.push(note);

                if (disc.paymentId) {
                    pendingFulfillments.push({
                        paymentId: disc.paymentId,
                        commitment: disc.commitment,
                        noteAddressHash,
                        value: disc.value,
                    });
                }
            }

            if (unresolved.length > 0) {
                this.logger?.warn("Commitments without an on-chain timestamp; retrying next scan", {
                    count: unresolved.length,
                    commitments: unresolved.map((d) => d.commitment),
                });
            }

            // Notes durable first, then mark their requests fulfilled. This way a crash between the
            // two leaves a request OPEN with its note already stored (harmless), never FULFILLED
            // with no note.
            await this.noteManager.flush();
            for (const { paymentId, commitment, noteAddressHash, value } of pendingFulfillments) {
                await this.paymentRequestService.markFulfilled(paymentId, {
                    commitment,
                    noteAddressHash,
                    value,
                });
            }

            const deferredStatusBlocks = await this.syncNotesStatus(fromBlockHex, currentBlockHex);

            // Advance the shared sync cursor only for a catch-all scan, and only here at the end.
            // If any commitment is still unresolved, stop at the earliest of them so the next scan
            // re-reads only that tail (addNote dedups the notes persisted above). A targeted scan
            // covers one range for specific contacts, so it must never move the shared cursor.
            //
            // A ragequit the finality gate deferred counts as unresolved for exactly the same
            // reason. Chain events are read by RANGE, so a cursor that moves past a block whose
            // ragequit was skipped never scans that block again: the gate would stop being a delay
            // and become permanent staleness, leaving a balance that counts a note already gone.
            // (The ASP path self-heals — a snapshot replays every row each sync — but the chain
            // tail is the path that runs when the snapshot is exactly what is unavailable.)
            if (!isTargeted) {
                this.noteManager.setSyncCursor(
                    this.earliestUnresolvedBlock(
                        [
                            ...this.stillHoldingUnresolved(unresolved, currentBlockHex),
                            ...deferredStatusBlocks.map((blockNumber) => ({ blockNumber })),
                        ],
                        currentBlockHex,
                    ),
                );
            }
            await this.noteManager.flush();

            this.logger?.debug("Discovered notes added to NoteManager", {
                addedCount: notes.length,
                cursorAdvanced: contacts.length === 0,
            });

            return notes;
        } catch (error) {
            if (error instanceof NoteDiscoveryScanFailed) throw error;
            if (error instanceof StateInvariantViolation) throw error;
            throw new NoteDiscoveryScanFailed(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /**
     * The unresolved discoveries that may still hold the sync cursor: every one whose lookup
     * could not reach an answer, and the confirmed-absent ones whose block is within
     * {@link UNRESOLVED_TIMESTAMP_HOLD_BLOCKS} of head.
     *
     * A confirmed absence deeper than that is dropped from the hold. Without the bound, a
     * payload naming a commitment that is never in contract storage holds the cursor at its
     * block forever, and no note in any later block is ever discovered. The note itself is
     * not persisted either way; only the cursor is at stake.
     *
     * A lookup that only ever threw is not an absence. Dropping it moved the cursor past a
     * real note whenever the RPC was flaky during a catch-up sync more than 64 blocks deep
     * (2 to 3 minutes on OP or BSC), and that block was never scanned again. It keeps the
     * hold until a lookup answers.
     */
    private stillHoldingUnresolved<
        T extends {
            blockNumber: Hex;
            commitment: Hex;
            timestampLookup?: "found" | "absent" | "unknown";
        },
    >(unresolved: T[], currentBlockHex: Hex): T[] {
        const head = BigInt(currentBlockHex);
        const held: T[] = [];
        const abandoned: T[] = [];
        for (const disc of unresolved) {
            if (
                disc.timestampLookup !== "absent" ||
                head - BigInt(disc.blockNumber) <= UNRESOLVED_TIMESTAMP_HOLD_BLOCKS
            ) {
                held.push(disc);
            } else {
                abandoned.push(disc);
            }
        }
        if (abandoned.length > 0) {
            this.logger?.warn(
                "Commitments still absent from contract storage well below head; no longer holding the sync cursor for them",
                {
                    count: abandoned.length,
                    commitments: abandoned.map((d) => d.commitment),
                    blocks: abandoned.map((d) => d.blockNumber),
                    holdDepth: String(UNRESOLVED_TIMESTAMP_HOLD_BLOCKS),
                },
            );
        }
        return held;
    }

    /** Earliest block among the unresolved discoveries, or `fallback` when none are unresolved. */
    private earliestUnresolvedBlock(unresolved: { blockNumber: Hex }[], fallback: Hex): Hex {
        if (unresolved.length === 0) return fallback;
        return unresolved.reduce(
            (min, d) => (BigInt(d.blockNumber) < BigInt(min) ? d.blockNumber : min),
            unresolved[0].blockNumber,
        );
    }

    /**
     * @inheritdoc IPoolSessionNoteDiscovery.purgePhantomNotes
     * @throws {NoteDiscoveryScanFailed} If snapshot fetch, tail event scan,
     * on-chain double-check, or note deletion fails.
     */
    async purgePhantomNotes(params?: PurgePhantomNotesParams): Promise<Hash[]> {
        const dryRun = Boolean(params?.dryRun);
        try {
            const localNotes = this.noteManager.getNotes();
            if (localNotes.length === 0) {
                this.logger?.debug("Phantom-note purge: no local notes, skipping");
                return [];
            }

            const onChain = await this.collectOnChainCommitments();

            const purged: Hash[] = [];
            for (const note of localNotes) {
                if (onChain.has(note.commitment)) continue;

                // Per-candidate on-chain double-check: defense against ASP
                // indexing gaps. Only delete when the chain itself confirms
                // the commitment is absent. Failure of the eth_call aborts
                // the whole purge run — surfacing as NoteDiscoveryScanFailed
                // — rather than risking destructive action on uncertain state.
                const timestamp = await this.poolVaultInteractor.getCommitmentTimestamp(
                    note.commitment,
                );
                if (BigInt(timestamp) !== 0n) {
                    this.logger?.debug(
                        "Skipping candidate confirmed on-chain by getCommitmentTimestamp",
                        { commitment: note.commitment },
                    );
                    continue;
                }

                this.logger?.debug("Purging phantom note", {
                    commitment: note.commitment,
                    dryRun,
                });
                if (!dryRun) this.noteManager.deleteNote(note.commitment);
                purged.push(note.commitment);
            }

            if (!dryRun && purged.length > 0) {
                await this.noteManager.flush();
            }

            this.logger?.debug("Phantom-note purge complete", {
                localNoteCount: localNotes.length,
                purgedCount: purged.length,
                dryRun,
            });

            return purged;
        } catch (error) {
            if (error instanceof NoteDiscoveryScanFailed) throw error;
            throw new NoteDiscoveryScanFailed(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async getNoteEvents(fromBlockNumber: Hex, toBlockNumber: Hex): Promise<NoteEvent[]> {
        const aspResult = await this.getASPNoteEvents(fromBlockNumber, toBlockNumber);

        if (aspResult === null) {
            return this.poolVaultInteractor.getNoteEvents(fromBlockNumber, toBlockNumber);
        }

        const { events: aspEvents, lastSyncedBlock } = aspResult;
        if (BigInt(lastSyncedBlock) >= BigInt(toBlockNumber)) return aspEvents;

        // Gap-fill: ASP cache lags chain head, fetch the remaining range from
        // RPC. The ASP's `lastSyncedBlock` may already be in `aspEvents`, but
        // the commitment-level dedupe in `discoverNotes` strips duplicates.
        const chainEvents = await this.poolVaultInteractor.getNoteEvents(
            lastSyncedBlock,
            toBlockNumber,
        );
        return [...aspEvents, ...chainEvents];
    }

    private async getASPNoteEvents(
        fromBlockNumber: Hex,
        toBlockNumber: Hex,
    ): Promise<{ events: NoteEvent[]; lastSyncedBlock: Hex } | null> {
        try {
            return await this.aspDataProvider.getNoteEvents(fromBlockNumber, toBlockNumber);
        } catch (error) {
            this.logger?.warn("Error getting note events from ASP", { error });
            return null;
        }
    }

    /**
     * Highest block a terminal `EXITED` may be written from this pass.
     *
     * `EXITED` has no reverse edge. A ragequit log read at the head can be reorged
     * out, and when it is, local state has recorded an exit the canonical chain never
     * contains — permanently, and in the direction that hides a note the user still
     * owns. Worse, a provider that kept the orphaned log knows a real
     * commitment/nullifier pair and can replay it, which every match check here would
     * accept, because the pair is genuine. Finality is what closes that, not more
     * matching.
     *
     * Prefers the chain's own `finalized` tag. Where a provider does not serve it,
     * falls back to a confirmation depth rather than refusing outright: refusing
     * would mean those users never record an exit at all and keep counting notes that
     * are gone.
     *
     * The depth fallback applies ONLY where the provider genuinely does not serve the
     * tag. A read that merely failed this time defers every terminal write instead:
     * collapsing the two would let anyone able to induce one timeout choose which rule
     * is in force, and a momentary failure says nothing about the chain. Deferring is
     * cheap because the cursor is held below the skipped block and it is rescanned.
     *
     * @returns The boundary, never above `toBlockNumber`; or `null` for "write nothing
     *   terminal this pass".
     */
    private async finalizedStatusHead(toBlockNumber: Hex): Promise<bigint | null> {
        const to = BigInt(toBlockNumber);

        let result: FinalizedBlockResult;
        try {
            result = this.rpcInteractor
                ? await this.rpcInteractor.getFinalizedBlockNumber()
                : { status: "unsupported" };
        } catch (error) {
            // A custom interactor that throws made a failed read, not a statement that
            // the provider has no finality — so it must not buy the weaker rule.
            result = {
                status: "unavailable",
                reason: error instanceof Error ? error.message : String(error),
            };
        }

        if (result.status === "finalized") {
            try {
                const head = BigInt(result.blockNumber);
                // A provider reporting a finalized block ahead of the range being
                // scanned tells us nothing extra; the scan is the ceiling either way.
                return head < to ? head : to;
            } catch {
                this.logger?.warn(
                    "Finalized block was unreadable; deferring terminal note status to a later sync",
                    { toBlock: toBlockNumber },
                );
                return null;
            }
        }

        if (result.status === "unavailable") {
            this.logger?.debug(
                "Finalized block unavailable this pass; deferring terminal note status rather than relaxing the rule",
                { toBlock: toBlockNumber, reason: result.reason },
            );
            return null;
        }

        this.logger?.debug(
            "Provider does not serve a finalized block; using a confirmation depth for terminal note status",
            {
                confirmations: String(RAGEQUIT_FINALITY_FALLBACK_CONFIRMATIONS),
                toBlock: toBlockNumber,
            },
        );
        const fallback = to - RAGEQUIT_FINALITY_FALLBACK_CONFIRMATIONS;
        // Below the depth nothing qualifies yet. Flooring at 0 instead would make a
        // block-0 log eligible on a chain that has not produced 64 blocks — the one
        // height that certainly does not have the confirmations being demanded.
        return fallback > 0n ? fallback : null;
    }

    /** Whether a log at `blockNumber` is settled enough to drive a terminal status. */
    private isWithinStatusHead(blockNumber: Hex | null, statusHead: bigint | null): boolean {
        if (blockNumber === null || statusHead === null) return false;
        try {
            return BigInt(blockNumber) <= statusHead;
        } catch {
            return false;
        }
    }

    /**
     *  Blocks whose ragequit was withheld by the finality gate. The caller keeps
     *   the sync cursor at or below the earliest of them, so a chain-tail scan reads the
     *   block again once it settles. Without that the gate would be permanent, not a delay.
     */
    private async syncNotesStatus(fromBlockNumber: Hex, toBlockNumber: Hex): Promise<Hex[]> {
        const ownedNotes = this.noteManager.getNotes();
        const commitmentToNote = this.buildCommitmentMap(ownedNotes);
        const nullifierToNote = this.buildNullifierMap(ownedNotes);

        // On-chain spend reconciliation runs FIRST and records every nullifier
        // spent on-chain. The REJECTED→ACTIVE recovery below consults this set
        // before re-activating a note, so a note that was rejected but later
        // spent on-chain can never be restored to ACTIVE (the double-count
        // hazard behind RC-04 #501).
        const spentNullifiers = new Set<Hex>();

        // Frozen BEFORE any scan, and read once for the whole pass. Fetching it
        // afterwards has a same-height race: a head log can be captured, reorged out
        // while the scan runs, and have its replacement height become final before the
        // later read — so the boundary would retroactively bless the log it was meant
        // to exclude. One value, taken first, applies to everything this pass writes.
        const statusHead = await this.finalizedStatusHead(toBlockNumber);

        // commitment -> block where THIS pass saw a ragequit bound to that note.
        // Consulted only by the pending-exit settler, to tell "the exit never
        // happened" apart from "the exit moved to another block".
        const boundRagequitBlocks = new Map<Hex, Hex>();

        // Blocks whose ragequit the gate withheld, collected for the caller to hold the
        // sync cursor at or below.
        const deferredBlocks: Hex[] = [];

        // Claims travel as a local, never as instance state: two overlapping syncs on one
        // session would otherwise settle each other's claims against the wrong snapshot.
        const {
            coveredThroughBlock: snapshotBlockNumber,
            ragequitClaims,
            snapshot: statusSnapshot,
        } = await this.syncNotesStatusFromASP(
            fromBlockNumber,
            commitmentToNote,
            nullifierToNote,
            spentNullifiers,
            statusHead,
        );

        if (BigInt(snapshotBlockNumber) < BigInt(toBlockNumber)) {
            // A snapshot that covered nothing makes this a scan of the entire requested
            // range — on a first sync that is every block since deployment, hundreds of
            // paginated `eth_getLogs` round-trips against the user's RPC, for both the
            // Transacted and the Ragequit stream. Correct, but never something to do
            // quietly: unannounced it reads as a normal sync that merely feels slow.
            const context = {
                fromBlock: snapshotBlockNumber,
                toBlock: toBlockNumber,
                snapshotCovered: BigInt(snapshotBlockNumber) > BigInt(fromBlockNumber),
            };
            if (context.snapshotCovered) {
                this.logger?.debug(
                    "Note-status sync: chain tail scan past the ASP snapshot",
                    context,
                );
            } else {
                this.logger?.warn(
                    "Note-status sync: ASP snapshot contributed no coverage, scanning the whole requested range from chain",
                    context,
                );
            }

            await this.syncNotesStatusFromChain(
                snapshotBlockNumber,
                toBlockNumber,
                commitmentToNote,
                nullifierToNote,
                spentNullifiers,
                statusHead,
                deferredBlocks,
                boundRagequitBlocks,
            );
        }

        // ASP ragequit claims are settled AFTER the chain pass, so a claim the
        // chain already corroborated by its own Ragequit event costs no extra
        // read — that note is EXITED by now and the claim is skipped. Only a
        // claim the chain never showed reaches the authoritative nullifier
        // check, which is exactly the set worth paying for.
        await this.applyConfirmedRagequitClaims(
            ragequitClaims,
            commitmentToNote,
            nullifierToNote,
            statusHead,
        );

        // Resolve exits this client itself submitted and recorded provisionally.
        await this.settleExitPendingNotes(nullifierToNote, statusHead, boundRagequitBlocks);

        // Re-read by status AFTER reconciliation: any note spent on-chain is
        // already SPENT and any ragequit is EXITED, so these working sets are
        // clean before the ASP label-status pass runs.
        const pendingNotes = this.noteManager.getNotes({ status: NoteStatus.PENDING });
        const activeNotes = this.noteManager.getNotes({ status: NoteStatus.ACTIVE });
        const rejectedNotes = this.noteManager.getNotes({ status: NoteStatus.REJECTED });

        // One bulk read answers every label. `null` means the set could not be fetched or
        // failed on-chain root verification, so nothing is known this pass and every note
        // keeps its current status (re-checked next scan) rather than moving on no evidence.
        const associationSet = await this.loadAssociationSet();
        if (associationSet === null) return deferredBlocks;

        // Membership says the ASP vetted the DEPOSIT this note descends from; it says
        // nothing about whether THIS commitment exists. An imported note is internally
        // consistent by construction, so anyone who knows the recipient's address and a
        // vetted label could hand them a note the chain never saw and watch it turn ACTIVE
        // (audit finding F-01, 2026-09-18). Promotion needs chain evidence as well: the
        // commitment in the bulk on-chain set (the snapshot this sync already read, plus
        // the tail), gathered only when something is promotable. Never a per-note read:
        // that would name the note to the RPC. Unreadable evidence keeps the note PENDING.
        const promotable = pendingNotes.filter((note) =>
            this.isInAssociationSet(note, associationSet),
        );
        const onChain =
            promotable.length > 0
                ? await this.promotionEvidence(statusSnapshot, snapshotBlockNumber, toBlockNumber)
                : new Set<Hex>();
        for (const note of promotable) {
            if (!onChain.has(note.commitment)) {
                this.logger?.warn(
                    "Vetted note stays PENDING: no on-chain evidence for its commitment",
                    { commitment: note.commitment },
                );
                continue;
            }
            this.noteManager.updateNoteStatus(note.commitment, NoteStatus.ACTIVE);
        }
        // Absence from the set is not a decision: a PENDING note's label may be under
        // review or may have been turned down, and the set cannot tell those apart for a
        // label that has never been in it. The note stays PENDING until the set includes it.

        // Apply revocation to active notes too. Without this, a locally-cached
        // ACTIVE note whose label gets revoked on the ASP keeps inflating the
        // user's spendable balance — failure only surfaces at proof-witness
        // time when the ASP Merkle proof can't be generated (sub-1875).
        for (const note of activeNotes) {
            // For an ACTIVE note, absence IS the decision: the label was in the set (that is
            // what made the note ACTIVE) and is no longer, which is exactly what a revocation
            // looks like. The set is root-verified against the chain, so this is not one
            // unverified response demoting a spendable note.
            if (!this.isInAssociationSet(note, associationSet)) {
                this.noteManager.updateNoteStatus(note.commitment, NoteStatus.REJECTED);
            }
        }

        // RC-04 #501: REJECTED is reversible. Restore a previously-rejected note
        // to ACTIVE when its label is back in the association set AND its nullifier is NOT
        // spent on-chain. The spent check (reconciled above) is the double-count
        // guard: a rejected-then-spent note is left in its SPENT state.
        await this.recoverRejectedNotes(rejectedNotes, associationSet, spentNullifiers);

        return deferredBlocks;
    }

    /**
     * Loads the ASP association set (as canonical label-hash `bigint`s) — the single bulk
     * read every note's label status is answered from. Fetched once per sync.
     *
     * This replaces a per-label `GET /labels/{labelHash}/status`, one request per label the
     * wallet holds. The labels a wallet holds are exactly the deposits its notes descend
     * from, so that shape published, from one client and in one burst, the set of deposits
     * behind this wallet's notes — including both ends of a shielded transfer, which relates
     * the sender's deposit to the recipient's note for anyone reading the request stream.
     * The association set is the same information already served in bulk to everyone, so
     * reading it names nothing. The point is what is asked for, not how the request is
     * shaped, so no per-label variant of it is acceptable either.
     *
     * Goes through {@link IASPClient.getAssociationSetLeaves}, NOT the raw
     * `aspDataProvider.getLeaves()`. The client rebuilds the LeanIMT root from the returned
     * leaves and asserts it against the on-chain `latestASPRoot`, so the answer is anchored
     * on data the ASP does not serve.
     *
     * The ASP is trusted infrastructure; the concern here is not malice but FRESHNESS and
     * CONSISTENCY — a snapshot mid-rebuild, a lagging replica, a cache serving a superseded
     * set. Checking the reconstructed root against the chain is what makes membership
     * evidence rather than an unverified assertion.
     *
     * @returns The set of currently-associated label hashes, or `null` when the set can't be
     *   fetched OR fails root verification — callers treat `null` as "nothing is known this
     *   pass" and leave every note's status unchanged rather than strand it.
     */
    private async loadAssociationSet(): Promise<Set<bigint> | null> {
        try {
            // Root-verified against the on-chain latestASPRoot — a leaf set that does not
            // reconstruct to the anchored root throws and lands in the defer path below.
            const leaves = await this.aspClient.getAssociationSetLeaves();
            return new Set(leaves.map((leaf) => BigInt(leaf)));
        } catch (error) {
            this.logger?.warn(
                "ASP association-set leaves unavailable or failed on-chain root verification; " +
                    "deferring note status updates",
                { reason: error instanceof Error ? error.message : String(error) },
            );
            return null;
        }
    }

    /**
     * Whether a note's label is in the association set the ASP builds spend proofs from.
     *
     * Membership is the authoritative statement, not a report about one: a label in the set
     * is spendable and a label outside it is not, and it is the only statement the set makes.
     * That asymmetry is why an ACTIVE note's absence demotes it while a PENDING note's
     * absence does not — see the two call sites.
     */
    private isInAssociationSet(note: Note<TAddress>, associationSet: Set<bigint>): boolean {
        const labelHash = this.noteComputationService.computeLabelHash(note.label);
        return associationSet.has(BigInt(labelHash));
    }

    /**
     * Restores previously-REJECTED notes to ACTIVE when their label is back in the
     * association set, guarded by the on-chain spend set. Membership is reversible,
     * so a transient/incorrect rejection must not permanently strand a spendable
     * note (RC-04 #501). The nullifier-spent check is the double-count guard: a
     * note that was rejected and then spent on-chain is left in its reconciled
     * (SPENT) state, never re-activated.
     *
     * The guard is two-stage. `spentNullifiers` (reconciled from the ASP snapshot plus the
     * chain tail) is the cheap first filter, but it is only as complete as that event feed:
     * a snapshot that lags the chain or is served mid-rebuild can omit a recent spend, and
     * when the snapshot fetch fails the chain scan resumes from the sync cursor rather than
     * from deployment, so spends older than the cursor are invisible to it. Before actually
     * re-activating, therefore, confirm against `PoolVault.spentNullifiers` directly — the
     * authoritative on-chain mapping, which is current by construction and needs no snapshot
     * to be up to date. One read per note that is genuinely recovering — usually none, but a mass
     * revocation makes it many at once, so the reads are issued in bounded batches rather than
     * all together (see {@link NULLIFIER_SPEND_CHECK_CONCURRENCY}).
     */
    private async recoverRejectedNotes(
        rejectedNotes: Note<TAddress>[],
        associationSet: Set<bigint>,
        spentNullifiers: Set<Hex>,
    ): Promise<void> {
        // Narrow to the notes that actually reach the on-chain check first, using only local
        // state, so the RPC reads can be issued in batches. A single ASP outage or over-broad
        // revocation can leave hundreds of notes REJECTED at once — exactly the mass-recovery
        // case #501 exists to serve — and awaiting each read inside the loop would serialize
        // that many round trips on the wallet's discovery path.
        const candidates = rejectedNotes
            .filter((note) => this.isInAssociationSet(note, associationSet))
            .map((note) => ({
                note,
                nullifier: this.noteComputationService.computeNullifier(
                    this.keystoreManager.getPrivateNullifyingKey(),
                    note.commitment,
                ),
            }))
            .filter(({ note, nullifier }) => {
                if (!spentNullifiers.has(nullifier)) return true;
                // Spent on-chain: the spend reconciliation already resolved this
                // note to SPENT. Never restore to ACTIVE — that would double-count
                // an already-spent note into the spendable balance.
                this.logger?.debug("Skipping recovery of rejected-but-spent note", {
                    commitment: note.commitment,
                });
                return false;
            });

        if (candidates.length === 0) return;

        // Bounded fan-out, not one Promise.all over the whole set — see
        // NULLIFIER_SPEND_CHECK_CONCURRENCY. Every candidate is still checked; only the number
        // in flight at once is capped, so nothing is silently dropped from the sweep.
        const spentOnChain: boolean[] = [];
        for (let i = 0; i < candidates.length; i += NULLIFIER_SPEND_CHECK_CONCURRENCY) {
            const batch = candidates.slice(i, i + NULLIFIER_SPEND_CHECK_CONCURRENCY);
            spentOnChain.push(
                ...(await Promise.all(
                    batch.map(({ nullifier }) => this.isNullifierSpentOnChain(nullifier)),
                )),
            );
        }

        candidates.forEach(({ note }, i) => {
            if (spentOnChain[i]) {
                this.logger?.debug(
                    "Skipping recovery of rejected note: nullifier is spent on-chain but absent " +
                        "from the reconciled event set",
                    { commitment: note.commitment },
                );
                return;
            }

            this.noteManager.updateNoteStatus(note.commitment, NoteStatus.ACTIVE);
            this.logger?.debug("Recovered rejected note to active after re-approval", {
                commitment: note.commitment,
            });
        });
    }

    /**
     * Authoritative spend check: reads `PoolVault.spentNullifiers` for the given nullifier.
     * A non-zero timestamp means the nullifier was consumed on-chain.
     *
     * Fails CLOSED — an RPC error is reported as "spent" so recovery is skipped. Skipping is
     * safe and non-stranding: the note simply stays REJECTED and is retried on the next scan,
     * whereas re-activating a genuinely-spent note double-counts it into the spendable balance
     * and yields a spend that reverts on-chain.
     *
     * Deliberately NOT reused for ragequit corroboration. Two reasons, either one decisive:
     * this policy's "unknown means spent" is safe only where "spent" is the conservative
     * answer, and there it is the destructive one; and the query names the nullifier, which
     * for an unspent note has never appeared on chain. Corroboration is keyed on a block
     * number instead — see {@link applyConfirmedRagequitClaims}.
     */
    private async isNullifierSpentOnChain(nullifier: Hex): Promise<boolean> {
        try {
            const timestamp = await this.poolVaultInteractor.getNullifierTimestamp(nullifier);
            return BigInt(timestamp) !== 0n;
        } catch (error) {
            this.logger?.warn(
                "On-chain nullifier spend check failed; deferring rejected-note recovery",
                { reason: error instanceof Error ? error.message : String(error) },
            );
            return true;
        }
    }

    private async syncNotesStatusFromChain(
        fromBlockNumber: Hex,
        toBlockNumber: Hex,
        commitmentToNote: Map<Hex, Note<TAddress>>,
        nullifierToNote: Map<Hex, Note<TAddress>>,
        spentNullifiers: Set<Hex>,
        statusHead: bigint | null,
        deferredBlocks: Hex[],
        boundRagequitBlocks: Map<Hex, Hex>,
    ): Promise<void> {
        // Bounded at `toBlockNumber` — the same head `discoverNotes` scanned events up to
        // and the block the sync cursor advances to. Scanning to live head instead would
        // consume events past the cursor, which the next pass re-reads anyway.
        const transactEvents = await this.poolVaultInteractor.getTransactedEvents(
            fromBlockNumber,
            toBlockNumber,
        );
        const ragequitEvents = await this.poolVaultInteractor.getRagequitEvents(
            fromBlockNumber,
            toBlockNumber,
        );

        this.processTransactEvents(
            transactEvents,
            nullifierToNote,
            commitmentToNote,
            fromBlockNumber,
            spentNullifiers,
        );
        this.processRagequitEvents(
            ragequitEvents,
            nullifierToNote,
            commitmentToNote,
            fromBlockNumber,
            "chain",
            statusHead,
            deferredBlocks,
            boundRagequitBlocks,
        );
    }

    /**
     * Applies the ASP snapshot's transact and ragequit events to local note status.
     *
     * @returns `coveredThroughBlock` — the block through which the snapshot can be trusted
     *   to have covered note status; `fromBlockNumber` means it covered nothing and the
     *   caller must scan the whole range from chain. And `ragequitClaims` — the commitments
     *   this snapshot claimed were ragequit, deliberately NOT applied here: an unauthenticated
     *   row is a claim to corroborate, and the caller settles it against the chain.
     */
    private async syncNotesStatusFromASP(
        fromBlockNumber: Hex,
        commitmentToNote: Map<Hex, Note<TAddress>>,
        nullifierToNote: Map<Hex, Note<TAddress>>,
        spentNullifiers: Set<Hex>,
        statusHead: bigint | null,
    ): Promise<{
        coveredThroughBlock: Hex;
        ragequitClaims: StatusRagequit[];
        /**
         * The snapshot this pass read, handed back so promotion can reuse it instead of
         * asking the ASP a second time in the same sync. `null` when the fetch failed.
         */
        snapshot: EventSnapshot | null;
    }> {
        let snapshotEvent: EventSnapshot;
        try {
            snapshotEvent = await this.aspDataProvider.getEventSnapshot();
        } catch (error) {
            // Only the fetch is guarded. A `StateInvariantViolation` raised while
            // processing the rows below means local state and the chain disagree, and
            // must reach the caller instead of being downgraded to "snapshot missed".
            this.logger?.warn(
                "ASP event snapshot unavailable — note status will be rebuilt from chain logs",
                {
                    fromBlock: fromBlockNumber,
                    reason: error instanceof Error ? error.message : String(error),
                },
            );
            return { coveredThroughBlock: fromBlockNumber, ragequitClaims: [], snapshot: null };
        }

        this.processTransactEvents(
            snapshotEvent.transacts,
            nullifierToNote,
            commitmentToNote,
            fromBlockNumber,
            spentNullifiers,
        );
        const ragequitClaims = this.processRagequitEvents(
            snapshotEvent.ragequits,
            nullifierToNote,
            commitmentToNote,
            fromBlockNumber,
            "asp",
            statusHead,
            // The asp branch returns claims instead of applying them, so it never defers
            // anything here; a snapshot also replays every row next sync, which is its own
            // retry. Only the range-read chain path needs the cursor held back.
            [],
        );

        const trusted = this.trustedSnapshotBlock(snapshotEvent, ["transacts", "ragequits"]);
        // Floored at the caller's range: coverage below `fromBlockNumber` is coverage of
        // blocks an earlier pass already reconciled, so a stale malformed row can never
        // drag this scan below the sync cursor.
        const covered =
            trusted === null || BigInt(trusted) < BigInt(fromBlockNumber)
                ? fromBlockNumber
                : trusted;

        // Warn only when the drops actually cost coverage. Drops confined to arrays this
        // sync never reads (`deposits`, `leaves`, `keystoreLeaves`) change nothing here,
        // and a warning that fires every pass under persistent ASP-side drift trains
        // integrators to ignore the one signal that matters. The dropped rows themselves
        // were already reported at the provider boundary.
        if (snapshotEvent.drops && BigInt(covered) !== BigInt(snapshotEvent.snapshotBlockNumber)) {
            this.logger?.warn(
                "ASP snapshot had unparseable rows — note-status coverage narrowed, the rest comes from chain logs",
                {
                    drops: snapshotEvent.drops,
                    snapshotBlockNumber: snapshotEvent.snapshotBlockNumber,
                    coveredThroughBlock: covered,
                },
            );
        }

        return { coveredThroughBlock: covered, ragequitClaims, snapshot: snapshotEvent };
    }

    /**
     * Highest block a snapshot can be trusted to cover for the given row arrays.
     *
     * Per-row validation (`parseEventSnapshotTolerant`) keeps a snapshot usable when one
     * row is malformed, but a dropped row is missing state: taking `snapshotBlockNumber`
     * at face value afterwards would let the chain catch-up skip the very range whose row
     * was lost, so a spend or a ragequit could stay invisible to this client indefinitely.
     * Coverage therefore stops one block below the earliest dropped row, which also keeps
     * the resulting rescan to that tail rather than the whole history.
     *
     * This guards *accidental* loss — ASP-side schema drift, a partially-indexed array —
     * and is not a defense against a lying ASP. Snapshot rows are unauthenticated (unlike
     * association-set leaves, which are checked against the on-chain root), so an ASP that
     * wants a spend hidden can simply omit the row and claim full coverage, and the
     * `blockNumber` this bound is read from sits on the malformed row itself. What actually
     * catches a lying ASP is elsewhere: note discovery gap-fills from RPC, the phantom
     * purge re-checks every candidate on-chain, and spending an already-spent note fails at
     * proof or submission time.
     *
     * @returns The trusted ceiling, or `null` when a dropped row's own `blockNumber`
     *   was unusable and no part of the snapshot can be trusted.
     */
    private trustedSnapshotBlock(snapshot: EventSnapshot, arrays: SnapshotArrayName[]): Hex | null {
        let covered = BigInt(snapshot.snapshotBlockNumber);

        for (const array of arrays) {
            const drops = snapshot.drops?.[array];
            if (!drops) continue;
            if (drops.earliestDroppedBlock === null) return null;
            const ceiling = BigInt(drops.earliestDroppedBlock) - 1n;
            if (ceiling < covered) covered = ceiling;
        }

        // Canonical padded hex: this value reaches `processTransactEvents` as the
        // `spentAtBlock` fallback and gets persisted, where `NoteManager` writes the
        // sync-cursor fallback through `bigintToHex` on the same field.
        return covered < 0n ? null : bigintToHex(covered);
    }

    // `StatusTransact` / `StatusRagequit`, not the chain event types: these run over both
    // chain logs and ASP snapshot rows, and a snapshot row may arrive with no usable
    // `blockNumber` — which the `|| fromBlockNumber` fallbacks below already handle.
    private processTransactEvents(
        events: StatusTransact[],
        nullifierToNote: Map<Hex, Note<TAddress>>,
        commitmentToNote: Map<Hex, Note<TAddress>>,
        fromBlockNumber: Hex,
        spentNullifiers: Set<Hex>,
    ): void {
        for (const transact of events) {
            // Record every nullifier spent on-chain (owned or not). The
            // REJECTED→ACTIVE recovery in `syncNotesStatus` checks this set so an
            // already-spent note is never re-activated (RC-04 #501 double-count
            // guard). Keyed identically to `nullifierToNote`, so membership tests
            // line up with the ownership matching below.
            for (const nullifier of transact.nullifierHashes) {
                spentNullifiers.add(nullifier);
            }

            const spentNotes = transact.nullifierHashes
                .map((nullifier) => nullifierToNote.get(nullifier))
                .filter((n): n is Note<TAddress> => n !== undefined);
            const activeNotes = transact.outputCommitments
                .map((commitment) => commitmentToNote.get(commitment))
                .filter((n): n is Note<TAddress> => n !== undefined);

            this.markNotesAsSpent(spentNotes, transact.blockNumber || fromBlockNumber);
            this.markNotesAsActive(activeNotes);
        }
    }

    /**
     * Applies ragequit events to local note status.
     *
     * `EXITED` IS TERMINAL AND MUST BE EARNED. It has no outgoing edge in
     * VALID_STATUS_TRANSITIONS, `PoolSessionRagequit.prepareRageQuit` refuses
     * on it, and the lineage totals drop the note's value — so writing it is
     * the one status change this class cannot take back. It must therefore
     * never rest on an unauthenticated claim.
     *
     * Rows reach here from two places with very different standing, and until
     * now this method could not tell them apart:
     *
     *   `chain` — read by `poolVaultInteractor.getRagequitEvents` from the
     *     user's own RPC. A ragequit that a node reports really happened.
     *     Authoritative; applied directly, as before.
     *
     *   `asp`   — a row in the association-set provider's event snapshot,
     *     fetched over HTTP, keyed on a commitment that is PUBLIC on chain,
     *     and checked against nothing. This class already holds every other
     *     provider-driven write to a stricter standard: a note is marked SPENT
     *     only through a nullifier derived from the user's private key, which
     *     the provider cannot compute, and a note is demoted to REJECTED only
     *     after corroboration, reversibly. `EXITED` was the one unchecked
     *     write and the one with no way back — so one row naming a note the
     *     user still holds made the client refuse the exit the protocol
     *     guarantees is always available, permanently and silently, while the
     *     note stayed perfectly spendable on chain.
     *
     * An `asp` row is now a CLAIM, not an instruction: it is returned to the
     * caller and applied only after the chain's own Ragequit event for the
     * claimed block is read back and matched. The whole row travels, not just
     * its commitment — the block number is where corroboration looks, and the
     * matched chain event is what supplies the exit block that gets persisted.
     *
     * @returns the rows an `asp` pass claimed, for the caller to corroborate.
     */
    private processRagequitEvents(
        events: readonly (StatusRagequit & { nullifierHash?: Hex | null })[],
        nullifierToNote: Map<Hex, Note<TAddress>>,
        commitmentToNote: Map<Hex, Note<TAddress>>,
        fromBlockNumber: Hex,
        provenance: RagequitProvenance,
        statusHead: bigint | null,
        deferredBlocks: Hex[],
        // Every chain row that BOUND to one of our notes is recorded here, whether or
        // not it was applied. A reorg can move a ragequit to a different block, and
        // the pending-exit settler must not read "absent from the block I recorded"
        // as "the exit never happened" when this pass just saw it somewhere else.
        boundElsewhere?: Map<Hex, Hex>,
    ): StatusRagequit[] {
        // commitment -> the nullifier this account derives for it. Built once per call
        // from the map the caller already has.
        const nullifierOf = new Map<Hex, Hex>();
        for (const [nullifier, owned] of nullifierToNote)
            nullifierOf.set(owned.commitment, nullifier);

        const unconfirmedClaims: StatusRagequit[] = [];
        for (const ragequit of events) {
            const note = commitmentToNote.get(ragequit.commitment);
            if (!note) continue;
            // Skip notes already EXITED — the ASP snapshot replays every
            // ragequit event on each discoverNotes call; EXITED -> EXITED is
            // a no-op, not an error.
            if (note.status === NoteStatus.EXITED) continue;

            if (provenance === "asp") {
                unconfirmedClaims.push(ragequit);
                continue;
            }

            // A chain row is authoritative about the CHAIN, not about which note it
            // belongs to. Matching on the commitment alone was enough to retire a note,
            // and the commitment is public — so a fabricated log carrying a held note's
            // commitment walked straight past the corroboration the ASP path now goes
            // through. That bypass is reachable: a provider whose snapshot lags (or fails)
            // forces exactly this chain-tail scan. Bind the event to the note the same way
            // corroboration does, with a locally derived value that is compared here and
            // never transmitted.
            const nullifier = nullifierOf.get(note.commitment);
            let bound = false;
            try {
                bound =
                    nullifier !== undefined &&
                    ragequit.nullifierHash !== undefined &&
                    ragequit.nullifierHash !== null &&
                    BigInt(nullifier) === BigInt(ragequit.nullifierHash);
            } catch {
                bound = false;
            }
            if (!bound) {
                // Dropped, never thrown. Raising here would hand anyone who can shape an
                // RPC response a way to abort every future discovery pass by replaying one
                // forged row against a public commitment.
                this.logger?.warn(
                    "Chain ragequit event does not bind to this note's nullifier; ignoring the row",
                    { commitment: note.commitment, status: note.status },
                );
                continue;
            }

            // Bound to this note, so it is canonical evidence of where the exit is,
            // even if it is too recent to act on yet.
            if (ragequit.blockNumber !== null) {
                boundElsewhere?.set(note.commitment, ragequit.blockNumber);
            }

            // Settled enough to be irreversible locally. A head log that later reorgs
            // out would otherwise leave the note permanently EXITED against a chain
            // that never contained the exit — and an orphaned log names a real
            // commitment/nullifier pair, so every match above would happily accept a
            // replay of it. Deferring costs one sync; the write cannot be undone.
            if (!this.isWithinStatusHead(ragequit.blockNumber, statusHead)) {
                this.logger?.debug(
                    "Chain ragequit event is not yet settled; deferring the terminal status to a later sync",
                    { commitment: note.commitment, blockNumber: ragequit.blockNumber },
                );
                // Reported so the caller holds the cursor below this block. Chain events
                // are read by range, so a cursor past it means never seeing it again.
                if (ragequit.blockNumber !== null) deferredBlocks.push(ragequit.blockNumber);
                continue;
            }

            try {
                this.noteManager.updateNoteStatus(
                    note.commitment,
                    NoteStatus.EXITED,
                    ragequit.blockNumber || fromBlockNumber,
                );
            } catch (error) {
                // After `REJECTED -> EXITED` joined the matrix, the only
                // transition that still lands here is `SPENT -> EXITED`,
                // which the chain disallows (transact and ragequit share the
                // nullifier-spent guard). The event is bound to this note by its
                // nullifier above, so reaching this point means local state and the
                // chain genuinely disagree — surface it.
                if (error instanceof InvalidStatusTransitionError) {
                    throw new StateInvariantViolation(
                        `ragequit event for commitment in status ${note.status}: ${note.commitment} (ragequit tx ${ragequit.txHash})`,
                    );
                }
                throw error;
            }
        }
        return unconfirmedClaims;
    }

    /**
     * Resolves notes this client put into `EXIT_PENDING` after its own ragequit was
     * mined, once the block that mined it is settled.
     *
     * `EXIT_PENDING` exists because a receipt is not finality: the transaction was
     * mined, but its block can still be reorged out, and `EXITED` has no way back.
     * That makes this pass the other half of the same guarantee — without it a note
     * would sit provisional forever, unspendable and never confirmed, which is its
     * own way to lose access to funds.
     *
     * Both outcomes are decided by the SAME single-block read the ASP-claim path
     * uses, and only once the block is below the finality boundary:
     *
     *   - the chain still shows this note's ragequit there → `EXITED`, settled.
     *   - it does not → the exit was reorged out, the note is live again, and it
     *     goes back to `ACTIVE`.
     *
     * The second case is the one that needs the finality gate to be sound. Absence
     * is only evidence once the block can no longer change; below the boundary a
     * missing event means nothing, so an unsettled note is simply left alone and
     * reconsidered next sync.
     */
    private async settleExitPendingNotes(
        nullifierToNote: Map<Hex, Note<TAddress>>,
        statusHead: bigint | null,
        boundRagequitBlocks: Map<Hex, Hex>,
    ): Promise<void> {
        const pending = this.noteManager.getNotes({ status: NoteStatus.EXIT_PENDING });
        if (pending.length === 0) return;

        const nullifierOf = new Map<Hex, Hex>();
        for (const [nullifier, note] of nullifierToNote)
            nullifierOf.set(note.commitment, nullifier);

        // One read per distinct block, same bound as the claim path: these are this
        // account's own exits, so the count is bounded by its own note count.
        const byBlock = new Map<string, Note<TAddress>[]>();
        for (const note of pending) {
            if (!this.isWithinStatusHead(note.spentAtBlock, statusHead)) continue;
            const key = BigInt(note.spentAtBlock as Hex).toString();
            const bucket = byBlock.get(key);
            if (bucket) bucket.push(note);
            else byBlock.set(key, [note]);
        }

        for (const [, notes] of byBlock) {
            const blockNumber = notes[0]!.spentAtBlock as Hex;

            let chainEvents;
            try {
                chainEvents = await this.poolVaultInteractor.getRagequitEvents(
                    blockNumber,
                    blockNumber,
                );
            } catch (error) {
                // Neither confirms nor refutes. Leave every note in this block
                // provisional and try again next sync.
                this.logger?.debug(
                    "Could not read the chain to settle a pending exit; leaving it provisional",
                    {
                        blockNumber,
                        reason: error instanceof Error ? error.message : String(error),
                    },
                );
                continue;
            }

            const chainByCommitment = new Map<Hex, (typeof chainEvents)[number]>();
            for (const event of chainEvents) {
                try {
                    if (BigInt(event.blockNumber) !== BigInt(blockNumber)) continue;
                } catch {
                    continue;
                }
                chainByCommitment.set(event.commitment, event);
            }

            for (const note of notes) {
                // The chain-tail pass runs before this one and reaches any pending
                // exit whose block fell inside the scanned range, settling it there.
                // Re-read so this pass does not write the same status twice.
                if (note.status !== NoteStatus.EXIT_PENDING) continue;

                const chainEvent = chainByCommitment.get(note.commitment);
                const nullifier = nullifierOf.get(note.commitment);
                let bound = false;
                if (chainEvent && nullifier) {
                    try {
                        bound = BigInt(nullifier) === BigInt(chainEvent.nullifierHash);
                    } catch {
                        bound = false;
                    }
                }

                try {
                    if (bound && chainEvent) {
                        this.noteManager.updateNoteStatus(
                            note.commitment,
                            NoteStatus.EXITED,
                            chainEvent.blockNumber,
                        );
                        continue;
                    }
                    // Before restoring, check whether this pass saw the same ragequit at a
                    // DIFFERENT block. A reorg can drop a transaction from block A and
                    // re-include it at B; if A is final while B is not, the earlier pass
                    // defers B and this one finds A empty. Restoring then makes a note
                    // spendable whose nullifier is already consumed on the canonical
                    // head — the spend builds and reverts. Absence at A is only evidence
                    // when the exit is not demonstrably somewhere else.
                    const movedTo = boundRagequitBlocks.get(note.commitment);
                    if (movedTo !== undefined) {
                        this.logger?.debug(
                            "A pending exit moved to another block; leaving it pending until that block settles",
                            {
                                commitment: note.commitment,
                                recordedBlock: blockNumber,
                                seenAt: movedTo,
                            },
                        );
                        continue;
                    }

                    // The block is final and carries no ragequit bound to this note,
                    // and this pass saw none elsewhere, so the exit is not on the
                    // canonical chain and the note is still the user's. Returning it to
                    // ACTIVE is the whole reason this state is not terminal.
                    this.logger?.warn(
                        "A submitted ragequit is absent from its now-final block; restoring the note",
                        { commitment: note.commitment, blockNumber },
                    );
                    this.noteManager.updateNoteStatus(note.commitment, NoteStatus.ACTIVE);
                } catch (error) {
                    if (error instanceof InvalidStatusTransitionError) {
                        this.logger?.warn("Could not settle a pending exit; leaving it as is", {
                            commitment: note.commitment,
                        });
                        continue;
                    }
                    throw error;
                }
            }
        }
    }

    /**
     * Confirms ASP ragequit claims against the chain's own Ragequit events,
     * then applies the ones that hold.
     *
     * Three things are deliberate here.
     *
     * **The claim is corroborated by the EVENT, not by the nullifier mapping.**
     * `spentNullifiers` proves only that a nullifier was consumed, and an
     * ordinary transact consumes the same nullifier — so against a snapshot
     * that omits the real Transact row and substitutes a ragequit row, that
     * mapping cheerfully agrees. Reading back the Ragequit event for the
     * claimed block proves the event type itself, which is what the row
     * actually asserted.
     *
     * **Corroboration is keyed on a BLOCK NUMBER, never on a note-derived
     * value.** The obvious check — hash the note to its nullifier and ask
     * `spentNullifiers(n)` — discloses that nullifier to the RPC provider. For
     * a note that was never exited the nullifier has never appeared on chain,
     * so the query publishes a value only the owner could compute, and the ASP
     * chooses when it fires: naming any commitment in a fabricated row would
     * make this client reveal that note's nullifier on demand. A provider that
     * also sees the RPC traffic gets a commitment→nullifier oracle for notes
     * that were never spent. Block numbers carry no such link, and the reads
     * are deduplicated per block, so `getRagequitEvents` is the cheaper query
     * as well as the honest one.
     *
     * **Nothing here throws.** A claim that names a note in a status with no
     * edge to `EXITED` is dropped with a warning rather than raised, because
     * the input is unauthenticated: `SPENT -> EXITED` is the one forbidden
     * transition, spent commitments are just as public as unspent ones, and
     * raising on one aborted the whole discovery pass on every subsequent
     * sync — turning one array element into an indefinite client-wide stall.
     * A corrupt row must cost the row, never the sync.
     *
     * Every inconclusive outcome — a row with no block to look in, an RPC that
     * will not answer, a block whose events do not match — leaves the note
     * exactly as it was. Unchanged means still spendable and still exitable,
     * and the claim is re-examined on the next sync.
     */
    private async applyConfirmedRagequitClaims(
        claims: StatusRagequit[],
        commitmentToNote: Map<Hex, Note<TAddress>>,
        nullifierToNote: Map<Hex, Note<TAddress>>,
        statusHead: bigint | null,
    ): Promise<void> {
        if (claims.length === 0) return;

        const nullifierOf = new Map<Hex, Hex>();
        for (const [nullifier, note] of nullifierToNote)
            nullifierOf.set(note.commitment, nullifier);

        // ONE claim per commitment, resolved before any block grouping. Grouping by
        // block alone would not bound anything: a provider can name a single owned
        // commitment at ten thousand distinct blocks and buy ten thousand reads with
        // one note. Collapsing to one claim per commitment first makes the distinct
        // block count at most the number of notes this account holds, which is the
        // bound this method actually relies on.
        //
        // `false` marks a commitment claimed at two different blocks. A note is
        // ragequit once, so contradictory rows are not weak evidence, they are no
        // evidence — same treatment conflicting proofs get in
        // `services/balance-crosscheck.ts` in the web client.
        const claimOf = new Map<Hex, StatusRagequit | false>();
        for (const claim of claims) {
            const note = commitmentToNote.get(claim.commitment);
            if (!note || note.status === NoteStatus.EXITED) continue;

            if (claim.blockNumber === null) {
                // No block means nowhere to look. Previously this fell back to the sync
                // cursor, which silently recorded the exit at the wrong height; now it is
                // simply not corroborable. Left spendable, re-examined next sync — and if
                // the exit was real, the chain pass carries its own authoritative event.
                this.logger?.warn(
                    "ASP claimed a ragequit with no block number; nothing to corroborate it against, note left spendable",
                    { commitment: claim.commitment, status: note.status },
                );
                continue;
            }

            const previous = claimOf.get(claim.commitment);
            if (previous === false) continue;
            if (!previous) {
                claimOf.set(claim.commitment, claim);
                continue;
            }
            if (BigInt(previous.blockNumber!) !== BigInt(claim.blockNumber)) {
                this.logger?.warn(
                    "ASP claimed the same ragequit at two different blocks; neither corroborated, note left spendable",
                    { commitment: claim.commitment, status: note.status },
                );
                claimOf.set(claim.commitment, false);
            }
        }

        const byBlock = new Map<string, StatusRagequit[]>();
        for (const claim of claimOf.values()) {
            if (claim === false) continue;
            const key = BigInt(claim.blockNumber!).toString();
            const bucket = byBlock.get(key);
            if (bucket) bucket.push(claim);
            else byBlock.set(key, [claim]);
        }

        for (const [, blockClaims] of byBlock) {
            const blockNumber = blockClaims[0]!.blockNumber!;

            let chainEvents;
            try {
                chainEvents = await this.poolVaultInteractor.getRagequitEvents(
                    blockNumber,
                    blockNumber,
                );
            } catch (error) {
                this.logger?.warn(
                    "Could not read the chain's ragequit events for a claimed block; notes left spendable",
                    {
                        blockNumber,
                        commitments: blockClaims.map((c) => c.commitment),
                        reason: error instanceof Error ? error.message : String(error),
                    },
                );
                continue;
            }

            // Only events actually AT the queried block count. The query asked for one
            // block; an event outside it means the source answered a different question
            // than the one asked, and the whole point here is that the block is the part
            // of the claim being verified. Without this the persisted exit height comes
            // from whatever the source chose to return.
            const chainByCommitment = new Map<Hex, (typeof chainEvents)[number]>();
            for (const event of chainEvents) {
                try {
                    if (BigInt(event.blockNumber) !== BigInt(blockNumber)) continue;
                } catch {
                    continue;
                }
                chainByCommitment.set(event.commitment, event);
            }

            for (const claim of blockClaims) {
                const note = commitmentToNote.get(claim.commitment);
                // Re-read: an earlier claim in this pass may already have exited the note.
                if (!note || note.status === NoteStatus.EXITED) continue;

                const chainEvent = chainByCommitment.get(claim.commitment);
                if (!chainEvent) {
                    this.logger?.warn(
                        "ASP claimed a ragequit the chain does not show at that block; note left spendable",
                        { commitment: claim.commitment, blockNumber, status: note.status },
                    );
                    continue;
                }

                // The event is public, so matching its commitment alone would let a provider
                // point at someone else's real ragequit. The nullifier binds the event to
                // THIS note and is derived from the owner's key — compared locally against a
                // value the chain already published, never sent anywhere.
                const nullifier = nullifierOf.get(claim.commitment);
                if (!nullifier || BigInt(nullifier) !== BigInt(chainEvent.nullifierHash)) {
                    this.logger?.warn(
                        "Chain ragequit event does not match this note's nullifier; note left spendable",
                        { commitment: claim.commitment, blockNumber, status: note.status },
                    );
                    continue;
                }

                // Same finality boundary the chain pass uses. An orphaned ragequit log
                // names a REAL commitment/nullifier pair, so every check above accepts a
                // replay of it after the reorg — matching cannot distinguish a log that
                // was true from one that still is. Only settledness can.
                if (!this.isWithinStatusHead(chainEvent.blockNumber, statusHead)) {
                    this.logger?.debug(
                        "Corroborating ragequit event is not yet settled; leaving the note spendable for now",
                        { commitment: claim.commitment, blockNumber },
                    );
                    continue;
                }

                try {
                    this.noteManager.updateNoteStatus(
                        claim.commitment,
                        NoteStatus.EXITED,
                        // The chain's block, not the sync cursor: the exit happened where
                        // the chain says it happened.
                        chainEvent.blockNumber,
                    );
                } catch (error) {
                    if (error instanceof InvalidStatusTransitionError) {
                        this.logger?.warn(
                            "Corroborated ragequit claim does not fit the note's current status; ignoring the row",
                            { commitment: claim.commitment, status: note.status },
                        );
                        continue;
                    }
                    throw error;
                }
            }
        }
    }

    private markNotesAsSpent(notes: Note<TAddress>[], spentAtBlock: Hex): void {
        for (const note of notes) {
            try {
                if (note.status === NoteStatus.PENDING)
                    this.noteManager.updateNoteStatus(note.commitment, NoteStatus.ACTIVE);
                this.noteManager.updateNoteStatus(note.commitment, NoteStatus.SPENT, spentAtBlock);
            } catch (error) {
                this.logger?.error("Failed to mark note as spent", {
                    commitment: note.commitment,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    private markNotesAsActive(notes: Note<TAddress>[]): void {
        for (const note of notes) {
            try {
                if (note.status !== NoteStatus.PENDING) continue; // Only update pending notes to active
                this.noteManager.updateNoteStatus(note.commitment, NoteStatus.ACTIVE);
            } catch (error) {
                this.logger?.error("Failed to mark note as active", {
                    commitment: note.commitment,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    /**
     * Builds a map from commitment hash to Note for O(1) lookups.
     */
    private buildCommitmentMap(notes: Note<TAddress>[]): Map<Hex, Note<TAddress>> {
        const map = new Map<Hex, Note<TAddress>>();
        for (const note of notes) {
            map.set(note.commitment, note);
        }
        return map;
    }

    /**
     * Builds a map from nullifier hash to Note for O(1) lookups.
     * Nullifier = Poseidon(privateNullifyingKey, commitment).
     */
    private buildNullifierMap(notes: Note<TAddress>[]): Map<Hex, Note<TAddress>> {
        const map = new Map<Hex, Note<TAddress>>();
        for (const note of notes) {
            const nullifier = this.noteComputationService.computeNullifier(
                this.keystoreManager.getPrivateNullifyingKey(),
                note.commitment,
            );
            map.set(nullifier, note);
        }
        return map;
    }

    /**
     * Commitments this sync can show were inserted on chain, for the promotion decision:
     * the snapshot the status sync already fetched, plus the tail between it and the block
     * the sync ran to. Deliberately NOT {@link collectOnChainCommitments}, which falls back
     * to a full-history log scan: that fallback exists so the purge can DELETE safely, and
     * paying it on every sync that has an approved pending note would hammer a public RPC.
     * A tail that fails keeps the snapshot's evidence, so only notes newer than the
     * snapshot wait for the next sync.
     *
     * The evidence is as trustworthy as the ASP that serves the snapshot, which is the same
     * party that already decides label approval. It raises promotion from "anyone who knows
     * an approved label" to "the ASP or the chain says this commitment exists". Verifying
     * against the on-chain state tree would close that too and is a separate change.
     */
    private async promotionEvidence(
        snapshot: EventSnapshot | null,
        snapshotBlockNumber: Hex,
        toBlockNumber: Hex,
    ): Promise<Set<Hex>> {
        const onChain = new Set<Hex>();
        // No snapshot is not "no evidence": a provider can serve the association set and no
        // snapshot at all (IpfsASPDataProvider throws on getEventSnapshot by design), and
        // answering "absent" there would leave every note of such a session PENDING for
        // ever, which means unspendable. Fall back to the chain itself, the same bulk read
        // the purge already trusts. Both unreadable still keeps the note PENDING.
        if (!snapshot) {
            try {
                return await this.collectOnChainCommitments();
            } catch (error) {
                this.logger?.warn(
                    "Promotion evidence: no snapshot and the chain could not be read, approved notes stay PENDING",
                    { error: error instanceof Error ? error.message : String(error) },
                );
                return onChain;
            }
        }
        this.addOutputCommitmentsToSet(onChain, snapshot.deposits, snapshot.transacts);
        if (BigInt(snapshotBlockNumber) >= BigInt(toBlockNumber)) return onChain;

        const tailFrom = `0x${(BigInt(snapshotBlockNumber) + 1n).toString(16)}` as Hex;
        try {
            const [deposits, transacts] = await Promise.all([
                this.poolVaultInteractor.getDepositedEvents(tailFrom, toBlockNumber),
                this.poolVaultInteractor.getTransactedEvents(tailFrom, toBlockNumber),
            ]);
            this.addOutputCommitmentsToSet(onChain, deposits, transacts);
        } catch (error) {
            this.logger?.warn(
                "Promotion evidence: chain tail unavailable, notes newer than the snapshot stay PENDING",
                { error: error instanceof Error ? error.message : String(error) },
            );
        }
        return onChain;
    }

    /**
     * Builds the set of every commitment ever inserted into the on-chain
     * state tree, drawn from the ASP `EventSnapshot` plus a chain-tail
     * catch-up. If the ASP snapshot fails, falls back to scanning Deposited
     * and Transacted logs across the full history so the purge can still
     * complete safely (a missing commitment must mean phantom, never
     * "snapshot unavailable").
     */
    private async collectOnChainCommitments(): Promise<Set<Hex>> {
        const onChain = new Set<Hex>();

        let snapshotBlock: Hex | null = null;
        try {
            const snapshot = await this.aspDataProvider.getEventSnapshot();
            this.addOutputCommitmentsToSet(onChain, snapshot.deposits, snapshot.transacts);
            // A dropped row is a commitment absent from `onChain`, i.e. a real note that
            // now looks like a phantom. Pull the tail scan back to cover it; the
            // per-candidate `getCommitmentTimestamp` check below stays the last line of
            // defense, not the only one.
            snapshotBlock = this.trustedSnapshotBlock(snapshot, ["deposits", "transacts"]);
            // Only when the scan actually widens — drops in the arrays this comparison
            // does not read leave the tail range byte-identical.
            if (
                snapshot.drops &&
                (snapshotBlock === null ||
                    BigInt(snapshotBlock) !== BigInt(snapshot.snapshotBlockNumber))
            ) {
                this.logger?.warn(
                    "Phantom-note purge: ASP snapshot had unparseable rows, widening the chain scan",
                    { drops: snapshot.drops, trustedThroughBlock: snapshotBlock },
                );
            }
        } catch (error) {
            this.logger?.warn(
                "Phantom-note purge: ASP snapshot unavailable, falling back to full chain scan",
                { error: error instanceof Error ? error.message : String(error) },
            );
        }

        const currentBlock = await this.poolVaultInteractor.getCurrentCursor();
        const tailFrom = this.computeTailFromBlock(snapshotBlock, currentBlock);

        if (tailFrom !== null) {
            const [deposits, transacts] = await Promise.all([
                this.poolVaultInteractor.getDepositedEvents(tailFrom, currentBlock),
                this.poolVaultInteractor.getTransactedEvents(tailFrom, currentBlock),
            ]);
            this.addOutputCommitmentsToSet(onChain, deposits, transacts);
        }

        return onChain;
    }

    /**
     * Folds the output-commitment pulls from a Deposited-event stream and a
     * Transacted-event stream into a Set. Source order is irrelevant (Set
     * semantics dedupe). Used by `collectOnChainCommitments` for both the ASP
     * snapshot and the chain-tail catch-up.
     */
    private addOutputCommitmentsToSet(
        onChain: Set<Hex>,
        deposits: { outputCommitment: Hex }[],
        transacts: { outputCommitments: Hex[] }[],
    ): void {
        for (const dep of deposits) onChain.add(dep.outputCommitment);
        for (const tx of transacts) {
            for (const c of tx.outputCommitments) onChain.add(c);
        }
    }

    /**
     * Resolves the tail-scan start block for `collectOnChainCommitments`.
     *
     * - Snapshot unavailable → full-history scan from block 0.
     * - Snapshot ahead of or at chain head → no tail scan needed.
     * - Snapshot behind chain head → resume from snapshot+1.
     *
     * @returns `null` when no tail scan is required.
     */
    private computeTailFromBlock(snapshotBlock: Hex | null, currentBlock: Hex): Hex | null {
        if (snapshotBlock === null) {
            return "0x0";
        }
        if (BigInt(snapshotBlock) >= BigInt(currentBlock)) {
            return null;
        }

        return `0x${(BigInt(snapshotBlock) + 1n).toString(16)}`;
    }

    private noteExists(commitmentHash: Hash): boolean {
        try {
            this.noteManager.getNote(commitmentHash);
            return true;
        } catch (error) {
            if (error instanceof NoteNotFoundError) return false;
            throw error;
        }
    }
}
