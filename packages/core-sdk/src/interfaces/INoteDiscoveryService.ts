import type {
    Address,
    Contact,
    DiscoveredNote,
    Hex,
    NoteEvent,
    NotePayload,
    PaymentRequestRecord,
    Secret,
} from "../internal.js";

/**
 * Interface for the NoteDiscoveryService, generic over the chain's address type `TAddress`.
 * Responsible for finding notes that belong to the account by scanning on-chain Note events
 * and attempting cryptographic decryption. Implements targeted discovery for known contacts.
 *
 * `scanStealthDeposits` is optional and chain-specific (currently only implemented for EVM,
 * via ERC-5564 — see evm-sdk's `EvmNoteDiscoveryService`) — see its own doc for why it can't
 * genericize. Core-sdk's base `NoteDiscoveryService` does not implement it.
 */
export interface INoteDiscoveryService<TAddress = Address> {
    /**
     * Scans Note events for notes sent by known contacts.
     * For each contact, computes the shared secret via ECDH(viewingPrivKey, contact.viewingPublicKey),
     * derives the expected tag using Poseidon(sharedSecret, 0), and filters events matching that tag.
     * Matching payloads are decrypted and commitments are computed from the decrypted data.
     *
     * @param events - Array of on-chain Note events to scan.
     * @param contacts - Known contacts with their viewing public keys.
     * @param viewingPrivKey - The account's viewing private key for ECDH computation.
     * @param ownerAddress - The account owner's address for commitment computation.
     * @returns Array of discovered notes with decrypted payloads and matched contacts.
     * @throws {NoteDiscoveryServiceBaseError}
     */
    scanTargeted(
        events: NoteEvent[],
        contacts: Contact[],
        viewingPrivKey: Secret,
        ownerAddress: TAddress,
    ): DiscoveredNote[];

    /**
     * Decrypts an encrypted note payload using the provided shared secret.
     * Decodes the versioned RLP format into the four payload fields: noteSecret, value, tokenId, label.
     *
     * @param encryptedPayload - The ciphertext portion of the encrypted payload (0x-prefixed hex).
     * @param sharedSecret - The shared secret derived via ECDH.
     * @returns The decrypted NotePayload.
     * @throws {NoteDiscoveryServiceBaseError}
     */
    decryptNotePayload(encryptedPayload: Hex, sharedSecret: Secret): NotePayload;

    /**
     * Scans anonymous Note events (tag = bytes32(0)) by attempting
     * ECDH + decrypt against every event. Computes ECDH(viewingPrivKey, event.ephemeralPubKey)
     * and attempts to decrypt the payload. If decryption yields a valid note structure,
     * the note belongs to this account. Commitments are computed from the decrypted data.
     *
     * Failed decryptions are expected and silently skipped — they indicate
     * the event was not sent to this account.
     *
     * @param events - Array of Note events to scan.
     * @param viewingPrivKey - The account's viewing private key.
     * @param ownerAddress - The account owner's address for commitment computation.
     * @returns Array of discovered notes with contact set to null.
     * @throws {NoteDiscoveryServiceBaseError}
     */
    scanCatchAll(
        events: NoteEvent[],
        viewingPrivKey: Secret,
        ownerAddress: TAddress,
    ): DiscoveredNote[];

    /**
     * Scans Note events for matches against open payment requests.
     *
     * Each request carries a recipient-chosen `tag` (= `Poseidon([paymentId])`) and an
     * ephemeral X25519 keypair; matching events are decrypted with the request's
     * `paymentPrivKey`. The decoded v2 payload's `noteAddressHash` is checked for
     * membership in the request's `noteSecretsMap` slots — events whose hash doesn't
     * correspond to a known slot are treated as tag collisions and silently skipped.
     * The spendable `noteSecret` is looked up locally from that map and injected into
     * the returned note (it never travels on-chain).
     *
     * Returned notes carry `paymentId` so the orchestrator can mark the request fulfilled.
     *
     * @param events - Array of Note events to scan.
     * @param requests - Open payment-request records to match against.
     * @returns Array of discovered notes with `paymentId` populated and `contact` null.
     * @throws {NoteDiscoveryServiceBaseError}
     */
    scanPaymentRequests(events: NoteEvent[], requests: PaymentRequestRecord[]): DiscoveredNote[];

    /**
     * Scans Note events for stealth-owned deposits — currently only produced by the
     * cross-chain-reshield dust-rescue flow (`packages/relayer/dust-rescue-prover`), not a
     * general-purpose stealth-deposit path. Unlike `scanTargeted`/`scanCatchAll`, ownership
     * isn't the account's own registered viewing key: each event's `noteData.data` may carry
     * a packed stealth payload (ephemeral pubkey + view tag + encrypted note payload) instead
     * of the standard viewing-key-encrypted format. A positive match's derived stealth address
     * becomes the note's owner for commitment computation.
     *
     * Every ordinary deposit's `noteData.data` will fail to parse as a stealth payload or fail
     * the view-tag filter — that's the expected common case, not an error.
     *
     * Optional, and opaque to the generic core by design — not a raw-cast oversight. On EVM the
     * stealth address is *computed* via secp256k1 point addition (ERC-5564), bound to a pinned
     * Announcer contract; `credentials`/the returned notes' owner are chain-specific shapes the
     * implementation itself knows how to interpret. A non-EVM chain needs its own stealth scheme
     * (curve/derivation AND on-chain announcement mechanism) before it can supply one; until
     * then, simply omitting this method (as core-sdk's base `NoteDiscoveryService` does) means
     * the caller (`PoolSessionNoteDiscovery.discoverNotes`) just skips the stealth-deposit scan.
     *
     * @param events - Array of Note events to scan.
     * @param credentials - The stealth recipient's scan credentials for the opted-in scheme —
     *   opaque here; the chain-specific implementation defines and casts to its own shape.
     * @returns Array of discovered notes with contact set to null.
     * @throws {NoteDiscoveryServiceBaseError}
     */
    scanStealthDeposits?(events: NoteEvent[], credentials: unknown): DiscoveredNote[];
}
