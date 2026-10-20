import type {
    Address,
    Contact,
    DiscoveredNote,
    Hex,
    IAddressFieldConverter,
    ICryptoService,
    IHashService,
    ILogger,
    INoteComputationService,
    INoteDiscoveryService,
    NoteDiscoveryServiceConfig,
    NoteDiscoveryServiceDependencies,
    NoteEvent,
    NotePayload,
    PaymentRequestRecord,
    Secret,
} from "../internal.js";
import { DecryptionError, PayloadParseError } from "../internal.js";

/**
 * Implementation of the NoteDiscoveryService interface, generic over the chain's address type
 * `TAddress`.
 * Scans on-chain Note events for notes belonging to the account
 * by computing ECDH shared secrets, matching Poseidon-derived tags,
 * and decrypting note payloads. Computes commitments from decrypted data.
 *
 * `scanTargeted`/`scanCatchAll` route the caller's `TAddress` through the injected
 * `addressFieldConverter` before it reaches the Poseidon-hash layer, matching the pattern used
 * throughout the genericized session classes. Does not implement the optional
 * `scanStealthDeposits` (see {@link INoteDiscoveryService.scanStealthDeposits}) — a chain-specific
 * subclass (e.g. evm-sdk's `EvmNoteDiscoveryService`, which extends this class to reuse
 * `computeNoteCommitment`/`decryptNotePayload`) adds it.
 */
export class NoteDiscoveryService<TAddress = Address> implements INoteDiscoveryService<TAddress> {
    private readonly cryptoService: ICryptoService;
    private readonly hashService: IHashService;
    private readonly noteComputationService: INoteComputationService;
    private readonly addressFieldConverter: IAddressFieldConverter<TAddress>;
    private readonly logger?: ILogger;

    /**
     * Creates a new NoteDiscoveryService instance.
     * @param config - Required service dependencies.
     * @param config.cryptoService - CryptoService for ECDH and decryption.
     * @param config.hashService - HashService for Poseidon tag computation.
     * @param config.noteComputationService - NoteComputationService for commitment computation and payload decoding.
     * @param config.addressFieldConverter - Converts `TAddress` into the field-sized `Hex` `noteComputationService` expects.
     * @param dependencies - Optional dependencies.
     * @param dependencies.logger - Optional logger for debug output.
     */
    constructor(
        config: NoteDiscoveryServiceConfig<TAddress>,
        dependencies?: NoteDiscoveryServiceDependencies,
    ) {
        this.cryptoService = config.cryptoService;
        this.hashService = config.hashService;
        this.noteComputationService = config.noteComputationService;
        this.addressFieldConverter = config.addressFieldConverter;
        this.logger = dependencies?.logger;
        this.logger?.debug("NoteDiscoveryService initialized");
    }

    /**
     * @inheritdoc INoteDiscoveryService.scanTargeted
     * @remarks MAC/decrypt failures are the "not mine" signal and are skipped silently —
     * tag collisions (Poseidon outputs can collide across viewing keys) mean a matched tag
     * does not guarantee the payload was encrypted for this viewer.
     */
    scanTargeted(
        events: NoteEvent[],
        contacts: Contact[],
        viewingPrivKey: Secret,
        ownerAddress: TAddress,
    ): DiscoveredNote[] {
        if (events.length === 0 || contacts.length === 0) {
            return [];
        }

        const tagMap = this.buildTagMap(contacts, viewingPrivKey);

        this.logger?.debug("Built tag map", {
            tagCount: tagMap.size,
            contactCount: contacts.length,
            eventCount: events.length,
        });

        const discovered: DiscoveredNote[] = [];

        for (const event of events) {
            const note = this.processTargetedEvent(event, tagMap, ownerAddress);
            if (note) discovered.push(note);
        }

        return discovered;
    }

    /**
     * @inheritdoc INoteDiscoveryService.decryptNotePayload
     * @throws {DecryptionError} If symmetric decryption fails.
     * @throws {PayloadParseError} If decrypted bytes fail binary NotePayload decoding.
     */
    decryptNotePayload(encryptedPayload: Hex, sharedSecret: Secret): NotePayload {
        const decryptedBytes = this.decryptToBytes(encryptedPayload, sharedSecret);
        try {
            return this.noteComputationService.decodeNotePayload(decryptedBytes);
        } catch (error) {
            throw new PayloadParseError(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * @inheritdoc INoteDiscoveryService.scanCatchAll
     */
    scanCatchAll(
        events: NoteEvent[],
        viewingPrivKey: Secret,
        ownerAddress: TAddress,
    ): DiscoveredNote[] {
        if (events.length === 0) {
            return [];
        }

        this.logger?.debug("Starting catch-all scan", { eventCount: events.length });

        const discovered: DiscoveredNote[] = [];

        for (const event of events) {
            const note = this.tryDecryptEvent(event, viewingPrivKey, ownerAddress);
            if (note) discovered.push(note);
        }

        this.logger?.debug("Catch-all scan complete", { discoveredCount: discovered.length });

        return discovered;
    }

    /**
     * @inheritdoc INoteDiscoveryService.scanPaymentRequests
     */
    scanPaymentRequests(events: NoteEvent[], requests: PaymentRequestRecord[]): DiscoveredNote[] {
        if (events.length === 0 || requests.length === 0) return [];

        const tagMap = new Map<Hex, PaymentRequestRecord>();
        for (const r of requests) tagMap.set(r.tag, r);

        this.logger?.debug("Built payment-request tag map", {
            tagCount: tagMap.size,
            eventCount: events.length,
        });

        const discovered: DiscoveredNote[] = [];

        for (const event of events) {
            const note = this.processPaymentRequestEvent(event, tagMap);
            if (note) discovered.push(note);
        }

        this.logger?.debug("Payment-request scan complete", { discoveredCount: discovered.length });

        return discovered;
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Attempts to match a Note event against the tag map, decrypt the payload, compute
     * commitment, and return a DiscoveredNote. MAC/decrypt/parse failures are treated as
     * tag collisions ("not mine") and return null — MUST NOT surface as errors.
     */
    private processTargetedEvent(
        event: NoteEvent,
        tagMap: Map<Hex, { contact: Contact; sharedSecret: Secret }>,
        ownerAddress: TAddress,
    ): DiscoveredNote | null {
        const match = tagMap.get(event.hint);
        if (!match) return null;

        try {
            const payload = this.decryptNotePayload(event.encryptedPayload, match.sharedSecret);
            const commitment = this.computeNoteCommitment(
                this.addressFieldConverter.toField(ownerAddress),
                payload,
            );

            this.logger?.debug("Discovered targeted note", {
                commitment,
                contact: match.contact.label ?? match.contact.address,
                blockNumber: event.blockNumber,
            });

            return {
                commitment,
                ...payload,
                contact: match.contact,
                blockNumber: event.blockNumber,
                txHash: event.txHash,
            };
        } catch {
            // Tag collision: matched tag but decrypt/parse failed. Silent skip.
            return null;
        }
    }

    /**
     * Attempts to decrypt a Note event via trial ECDH. Returns a
     * `DiscoveredNote` when the event was encrypted to `viewingPrivKey`, or
     * `null` on any failure (ECDH, AEAD-auth, or payload decode).
     *
     * No hint-based pre-filter: anonymous-discovery notes carry random hints
     * (introduced 2026-05-15, commit 66c1cb8) so the constant-zero sentinel
     * is no longer a reliable signal. The ECDH-then-decrypt path is the only
     * correct rejection criterion — the try/catch fails fast on non-matching
     * events (ECDH bytes won't decrypt; AEAD auth tag fails).
     */
    private tryDecryptEvent(
        event: NoteEvent,
        viewingPrivKey: Secret,
        ownerAddress: TAddress,
    ): DiscoveredNote | null {
        try {
            const sharedSecret = this.cryptoService.ecdh(viewingPrivKey, event.ephemeralPubKey);
            const bytes = this.cryptoService.decrypt(event.encryptedPayload, sharedSecret);
            const payload = this.noteComputationService.decodeNotePayload(bytes);
            const commitment = this.computeNoteCommitment(
                this.addressFieldConverter.toField(ownerAddress),
                payload,
            );

            this.logger?.debug("Discovered catch-all note", {
                commitment,
                blockNumber: event.blockNumber,
            });

            return {
                commitment,
                ...payload,
                contact: null,
                blockNumber: event.blockNumber,
                txHash: event.txHash,
            };
        } catch {
            return null;
        }
    }

    /**
     * Attempts to match a Note event against the payment-request tag map, decrypt the
     * v2 payload with the request's `paymentPrivKey`, and validate that the decoded
     * `noteAddressHash` is one of the request's pre-allocated slots. The spendable
     * `noteSecret` is looked up from the request's recipient-local map (it never
     * travels on-chain) and injected into the discovered note.
     *
     * Returns null on any failure (tag collision, decrypt error, or unknown
     * noteAddressHash) — MUST NOT surface as errors.
     */
    private processPaymentRequestEvent(
        event: NoteEvent,
        tagMap: Map<Hex, PaymentRequestRecord>,
    ): DiscoveredNote | null {
        const match = tagMap.get(event.hint);
        if (!match) return null;

        try {
            const sharedSecret = this.cryptoService.ecdh(
                match.paymentPrivKey,
                event.ephemeralPubKey,
            );
            const bytes = this.decryptToBytes(event.encryptedPayload, sharedSecret);
            const payload = this.noteComputationService.decodePaymentRequestNotePayload(bytes);

            // The v2 payload carries only the noteAddressHash — the secret stays
            // recipient-local. Confirm the hash is one of this request's pre-allocated
            // slots (defends against tag collisions / malformed payloads), then look the
            // spendable secret up locally to reconstruct the note.
            const noteSecret = match.noteSecretsMap.get(payload.noteAddressHash);
            if (!noteSecret) return null;

            const commitment = this.noteComputationService.computeFullCommitment({
                noteAddressHash: payload.noteAddressHash,
                tokenId: payload.tokenId,
                value: payload.value,
                label: payload.label,
            });

            this.logger?.debug("Discovered payment-request note", {
                commitment,
                paymentId: match.paymentId,
                blockNumber: event.blockNumber,
            });

            return {
                commitment,
                noteSecret,
                value: payload.value,
                tokenId: payload.tokenId,
                label: payload.label,
                contact: null,
                blockNumber: event.blockNumber,
                txHash: event.txHash,
                paymentId: match.paymentId,
            };
        } catch {
            return null;
        }
    }

    /**
     * Computes the note commitment from the owner address and decrypted payload
     * using NoteComputationService.
     *
     * @param ownerAddressField - The owner address, already converted to the field-sized `Hex`
     *   the Poseidon-hash layer expects (via `addressFieldConverter.toField` for the generic
     *   scan paths, or used as-is by a chain-specific `scanStealthDeposits` implementation).
     *
     * Protected (not private) so a chain-specific subclass implementing the optional
     * `scanStealthDeposits` (e.g. evm-sdk's `EvmNoteDiscoveryService`) can reuse it instead of
     * duplicating commitment computation.
     */
    protected computeNoteCommitment(ownerAddressField: Hex, payload: NotePayload): Hex {
        const noteAddressHash = this.noteComputationService.computeNoteAddressHash(
            ownerAddressField,
            payload.noteSecret,
        );
        return this.noteComputationService.computeFullCommitment({
            noteAddressHash,
            tokenId: payload.tokenId,
            value: payload.value,
            label: payload.label,
        });
    }

    /**
     * Builds a lookup map from tag → { contact, sharedSecret }.
     * Computes one tag per contact using index 0: tag = Poseidon(sharedSecret, 0x0).
     */
    private buildTagMap(
        contacts: Contact[],
        viewingPrivKey: Secret,
    ): Map<Hex, { contact: Contact; sharedSecret: Secret }> {
        const tagMap = new Map<Hex, { contact: Contact; sharedSecret: Secret }>();

        for (const contact of contacts) {
            const sharedSecret = this.cryptoService.ecdh(viewingPrivKey, contact.viewingPublicKey);
            const tag = this.hashService.hash([sharedSecret, "0x0"]);
            tagMap.set(tag, { contact, sharedSecret });
        }

        return tagMap;
    }

    /** Decrypts ciphertext into raw bytes. */
    private decryptToBytes(encryptedPayload: Hex, sharedSecret: Secret): Uint8Array {
        try {
            return this.cryptoService.decrypt(encryptedPayload, sharedSecret);
        } catch (error) {
            throw new DecryptionError(error instanceof Error ? error.message : String(error));
        }
    }
}
