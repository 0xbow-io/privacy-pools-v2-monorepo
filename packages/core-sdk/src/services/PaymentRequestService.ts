import type {
    Address,
    GeneratePaymentRequestParams,
    Hash,
    Hex,
    ICryptoService,
    IHashService,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    IPaymentRequestService,
    IPaymentRequestStorageAdapter,
    PaymentRequestFulfillment,
    PaymentRequestRecord,
    PaymentRequestServiceConfig,
    PaymentRequestServiceDependencies,
    PaymentRequestStatus,
    Secret,
    SerializedPaymentRequestRecord,
    StoredPaymentRequestRecord,
} from "../internal.js";
import {
    bigintToHex,
    DEFAULT_REQUEST_EXPIRY_MS,
    GeneratePaymentRequestParamsSchema,
    InvalidPaymentRequestParams,
    InvalidPaymentRequestState,
    PaymentRequestNotFoundError,
    PaymentRequestServiceStateSchema,
    SCAN_EXPIRY_GRACE_MS,
} from "../internal.js";

const DEFAULT_SLOT_COUNT = 5;

/**
 * Implementation of the PaymentRequestService interface.
 *
 * Owns the lifecycle of payment requests on the recipient side: generates a fresh
 * `paymentId`, ephemeral X25519 paymentKeyPair, recipient-chosen `tag`, and N
 * `(noteAddressHash, noteSecret)` slots; persists them via a storage adapter; and
 * exposes lookup + fulfillment-marking methods used by note discovery.
 */
export class PaymentRequestService implements IPaymentRequestService {
    private readonly ownerAddress: Address;
    private readonly cryptoService: ICryptoService;
    private readonly hashService: IHashService;
    private readonly noteComputationService: INoteComputationService;
    private readonly keystoreManager: IKeystoreManager;
    private readonly storageAdapter: IPaymentRequestStorageAdapter;
    private readonly expiryMs: number;
    private readonly logger?: ILogger;
    private requests: Map<Hex, PaymentRequestRecord>;

    constructor(
        config: PaymentRequestServiceConfig,
        dependencies?: PaymentRequestServiceDependencies,
    ) {
        this.ownerAddress = config.ownerAddress;
        this.cryptoService = config.cryptoService;
        this.hashService = config.hashService;
        this.noteComputationService = config.noteComputationService;
        this.keystoreManager = config.keystoreManager;
        this.storageAdapter = config.storageAdapter;
        // Validate here rather than at first use: `generate` converts this to a BigInt when
        // stamping `expiresAt`, and `Infinity` (a plausible caller's way of saying "never
        // expire") or a fractional value would throw RangeError mid-generation — after the
        // payment ID, key pair, and slot secrets had already been derived.
        this.expiryMs = config.requestExpiryMs ?? DEFAULT_REQUEST_EXPIRY_MS;
        if (!Number.isSafeInteger(this.expiryMs) || this.expiryMs <= 0) {
            throw new InvalidPaymentRequestParams(
                `requestExpiryMs must be a positive safe integer (got ${String(config.requestExpiryMs)})`,
            );
        }
        this.logger = dependencies?.logger;
        this.requests = new Map<Hex, PaymentRequestRecord>();

        this.logger?.debug("PaymentRequestService initialized");
    }

    /**
     * @inheritdoc IPaymentRequestService.loadFromStorage
     */
    async loadFromStorage(): Promise<void> {
        const state = await this.storageAdapter.getState();
        if (!state) {
            this.logger?.debug("No existing PaymentRequestService state found in storage");
            return;
        }

        this.requests = new Map(state.requests.map((r) => [r.paymentId, this.hydrate(r)]));
        this.logger?.debug("Loaded PaymentRequestService state from storage", {
            requestCount: this.requests.size,
        });
    }

    /**
     * @inheritdoc IPaymentRequestService.generate
     * @throws {InvalidPaymentRequestParams} If the parameters fail schema validation.
     */
    async generate(params: GeneratePaymentRequestParams): Promise<PaymentRequestRecord> {
        const validated = GeneratePaymentRequestParamsSchema.safeParse(params);
        if (!validated.success) {
            throw new InvalidPaymentRequestParams(validated.error.issues[0].message);
        }

        const slotCount = validated.data.slots ?? DEFAULT_SLOT_COUNT;
        const createdAt = bigintToHex(BigInt(Date.now()));
        const paymentId = this.cryptoService.generateSecret();
        const paymentKeyPair = this.derivePaymentKeyPair(paymentId);
        const tag = this.hashService.hash([paymentId]);

        const noteSecretsMap = new Map<Hash, Secret>();
        for (let i = 0; i < slotCount; i++) {
            const noteSecret = this.cryptoService.generateSecret();
            const noteAddressHash = this.noteComputationService.computeNoteAddressHash(
                this.ownerAddress,
                noteSecret,
            );
            noteSecretsMap.set(noteAddressHash, noteSecret);
        }

        const record: PaymentRequestRecord = {
            paymentId,
            noteAddressHashes: Array.from(noteSecretsMap.keys()),
            noteSecretsMap,
            amount: validated.data.amount,
            tokenId: validated.data.tokenId,
            tag,
            paymentPubKey: paymentKeyPair.publicKey,
            paymentPrivKey: paymentKeyPair.privateKey,
            recipientAddress: this.ownerAddress,
            status: "OPEN",
            createdAt: createdAt,
            // Stamped at creation rather than recomputed from `createdAt` on every scan. A record
            // written before scan-expiry existed carries no `expiresAt` and is therefore never
            // expired — see `isPastDeadline`. Recomputing instead would retroactively drop every
            // pre-existing request older than the window out of the scan set on upgrade.
            expiresAt: bigintToHex(BigInt(createdAt) + BigInt(this.expiryMs)),
            fulfilledByCommitments: [],
            consumedSlots: [],
        };

        this.requests.set(paymentId, record);
        await this.persist();

        this.logger?.debug("Generated payment request", {
            paymentId,
            tag,
            slots: slotCount,
        });

        return record;
    }

    /**
     * @inheritdoc IPaymentRequestService.list
     */
    async list(filter?: { status?: PaymentRequestStatus }): Promise<PaymentRequestRecord[]> {
        const all = Array.from(this.requests.values());
        if (!filter?.status) return all;
        return all.filter((r) => r.status === filter.status);
    }

    /**
     * @inheritdoc IPaymentRequestService.getOpenRequests
     */
    async getOpenRequests(): Promise<PaymentRequestRecord[]> {
        return this.list({ status: "OPEN" });
    }

    /**
     * @inheritdoc IPaymentRequestService.getScannableRequests
     */
    async getScannableRequests(): Promise<PaymentRequestRecord[]> {
        return Array.from(this.requests.values()).filter(
            (r) => r.status !== "ARCHIVED" && r.scanRetiredAt === undefined,
        );
    }

    /**
     * @inheritdoc IPaymentRequestService.markScanRetired
     */
    async markScanRetired(coveredThroughMs: Hex): Promise<void> {
        const coveredMs = BigInt(coveredThroughMs);
        const retired: Hex[] = [];
        for (const record of this.requests.values()) {
            if (record.scanRetiredAt !== undefined) continue;
            if (!this.isPastDeadline(record, coveredMs)) continue;
            record.scanRetiredAt = coveredThroughMs;
            retired.push(record.paymentId);
        }
        if (retired.length === 0) return;

        try {
            await this.persist();
        } catch (error) {
            // A save that did not land must not shrink the scan set in the running session
            // either: in-memory and on-disk would then disagree about which requests are
            // still scanned, and the session would stop looking for a payment nothing
            // recorded as retired.
            for (const paymentId of retired) {
                const record = this.requests.get(paymentId);
                if (record?.scanRetiredAt === coveredThroughMs) delete record.scanRetiredAt;
            }
            throw error;
        }

        this.logger?.debug("Retired payment requests from the scan set", {
            coveredThroughMs,
            paymentIds: retired,
        });
    }

    /**
     * @inheritdoc IPaymentRequestService.markFulfilled
     * @throws {PaymentRequestNotFoundError} If no request exists with the given paymentId.
     */
    async markFulfilled(paymentId: Hex, fulfillment: PaymentRequestFulfillment): Promise<void> {
        const record = this.requests.get(paymentId);
        if (!record) throw new PaymentRequestNotFoundError(paymentId);

        const { commitment, noteAddressHash, value } = fulfillment;

        if (record.fulfilledByCommitments.includes(commitment)) {
            this.logger?.debug("Skipping duplicate fulfillment", { paymentId, commitment });
            return;
        }

        // Audit trail: every discovered commitment is recorded, phantoms included.
        record.fulfilledByCommitments.push(commitment);

        // A slot is only *consumed* by a genuine match: a non-zero-value note landing on a
        // request-owned, still-unused slot. A 0-value phantom or a note re-using an already
        // consumed slot is recorded above but must NOT advance fulfillment — otherwise an
        // attacker's dust could drive the request terminal or misrepresent progress (#600).
        const isGenuineSlotConsumption =
            BigInt(value) > 0n &&
            record.noteSecretsMap.has(noteAddressHash) &&
            !record.consumedSlots.includes(noteAddressHash);

        if (isGenuineSlotConsumption) {
            record.consumedSlots.push(noteAddressHash);
            // FULFILLED is display state only; getScannableRequests ignores it, so this flip
            // never suppresses a genuine later payment. ARCHIVED stays terminal.
            if (record.status === "OPEN") record.status = "FULFILLED";
        }

        await this.persist();

        this.logger?.debug("Marked payment request fulfillment", {
            paymentId,
            commitment,
            consumedSlot: isGenuineSlotConsumption,
            consumedSlots: record.consumedSlots.length,
            totalCommitments: record.fulfilledByCommitments.length,
        });
    }

    /**
     * @inheritdoc IPaymentRequestService.archive
     * @throws {PaymentRequestNotFoundError} If no request exists with the given paymentId.
     */
    async archive(paymentId: Hex): Promise<void> {
        const record = this.requests.get(paymentId);
        if (!record) throw new PaymentRequestNotFoundError(paymentId);

        if (record.status === "ARCHIVED") {
            this.logger?.debug("Skipping archive of already-archived request", { paymentId });
            return;
        }

        record.status = "ARCHIVED";
        await this.persist();

        this.logger?.debug("Archived payment request", { paymentId });
    }

    /**
     * @inheritdoc IPaymentRequestService.clear
     */
    async clear(): Promise<void> {
        this.requests.clear();
        await this.storageAdapter.clearState();
        this.logger?.debug("Cleared PaymentRequestService state");
    }

    /**
     * @inheritdoc IPaymentRequestService.exportState
     */
    exportState(): SerializedPaymentRequestRecord[] {
        return Array.from(this.requests.values()).map((r) => {
            const stored = this.dehydrate(r);
            return { ...stored, noteSecretsMap: Array.from(stored.noteSecretsMap.entries()) };
        });
    }

    /**
     * @inheritdoc IPaymentRequestService.importState
     * @throws {InvalidPaymentRequestState} If the snapshot fails schema validation.
     */
    async importState(records: SerializedPaymentRequestRecord[]): Promise<void> {
        const parsed = PaymentRequestServiceStateSchema.safeParse({ requests: records });
        if (!parsed.success) {
            throw new InvalidPaymentRequestState(parsed.error.issues[0].message);
        }

        this.requests = new Map(parsed.data.requests.map((r) => [r.paymentId, this.hydrate(r)]));
        await this.persist();

        this.logger?.debug("Imported PaymentRequestService state", {
            requestCount: this.requests.size,
        });
    }

    private async persist(): Promise<void> {
        const stripped = Array.from(this.requests.values()).map((r) => this.dehydrate(r));
        await this.storageAdapter.saveState({ requests: stripped });
    }

    /**
     * Whether `nowMs` is past the request's scan deadline: `expiresAt` plus
     * {@link SCAN_EXPIRY_GRACE_MS}.
     *
     * This is no longer, by itself, what removes a request from the scan set. The clock
     * passing says nothing about whether a payment made before the deadline was looked for,
     * and that payment is on-chain and matchable forever, so a recipient who scans late
     * would otherwise never find it. `markScanRetired` applies this to a timestamp the scan
     * has actually covered, and the resulting `scanRetiredAt` stamp is what
     * `getScannableRequests` consults.
     *
     * `createdAt` and the configured window are NOT consulted here — see the body for why, and note the consequence: changing `requestExpiryMs` never
     * re-dates an existing record.
     *
     * This is deliberately LATER than the sender-side deadline enforced by
     * `PoolSessionTransfer.prepareFulfillPaymentRequest`, which refuses at `expiresAt` exactly.
     * The two are not meant to agree: the grace covers the interval between a sender passing
     * that check and their transaction actually landing.
     */
    private isPastDeadline(record: PaymentRequestRecord, nowMs: bigint): boolean {
        // No stamp = the record predates scan-expiry, so it is grandfathered in and never
        // expires. Expiry must only ever apply to requests generated under a policy the
        // recipient actually had when they created (and shared) the link — retro-applying it
        // would silently drop already-shared requests out of the scan set on upgrade, making a
        // legitimate later payment land on-chain but stay invisible to the wallet (#600).
        if (record.expiresAt === undefined) return false;
        return nowMs > BigInt(record.expiresAt) + BigInt(SCAN_EXPIRY_GRACE_MS);
    }

    /** Stored record → in-memory record: re-derive the non-persisted private key. */
    private hydrate(stored: StoredPaymentRequestRecord): PaymentRequestRecord {
        return {
            ...stored,
            // Pre-#600 snapshots persisted without `consumedSlots`; default so they hydrate cleanly.
            consumedSlots: stored.consumedSlots ?? [],
            paymentPrivKey: this.derivePaymentPrivKey(stored.paymentId),
        };
    }

    /** In-memory record → stored record: drop the re-derivable private key. */
    private dehydrate({
        paymentPrivKey: _omit,
        ...stored
    }: PaymentRequestRecord): StoredPaymentRequestRecord {
        return stored;
    }

    private derivePaymentKeyPair(paymentId: Hex): { privateKey: Secret; publicKey: Hex } {
        const viewingKeyPair = this.keystoreManager.getViewingKeyPair();
        return this.cryptoService.derivePaymentRequestKeyPair(
            viewingKeyPair.privateKey,
            this.ownerAddress,
            paymentId,
        );
    }

    private derivePaymentPrivKey(paymentId: Hex): Secret {
        return this.derivePaymentKeyPair(paymentId).privateKey;
    }
}
