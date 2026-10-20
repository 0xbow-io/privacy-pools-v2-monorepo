import type {
    IAddressFieldConverter,
    ICryptoService,
    IHashService,
    ILogger,
    INoteComputationService,
} from "../internal.js";
import type { Address } from "./Address.js";
import type { Hash } from "./Hash.js";
import type { Hex } from "./Hex.js";
import type { Label } from "./Label.js";
import type { Note } from "./Note.js";
import type { PublicKey } from "./PublicKey.js";
import type { Secret } from "./Secret.js";

/**
 * Configuration for the NoteDiscoveryService, generic over the chain's address type `TAddress`.
 * Contains required service dependencies.
 */
export interface NoteDiscoveryServiceConfig<TAddress = Address> {
    /** CryptoService for ECDH shared secret derivation and symmetric decryption. */
    cryptoService: ICryptoService;
    /** HashService for Poseidon tag computation. */
    hashService: IHashService;
    /** NoteComputationService for commitment computation and binary payload decoding. */
    noteComputationService: INoteComputationService;
    /** Converts `TAddress` values into the field-sized `Hex` the Poseidon-hash layer expects. */
    addressFieldConverter: IAddressFieldConverter<TAddress>;
}

/**
 * Optional dependencies for the NoteDiscoveryService.
 */
export interface NoteDiscoveryServiceDependencies {
    /** Optional logger for debug output and monitoring. */
    logger?: ILogger;
}

/**
 * A known contact with their viewing public key.
 * Used for targeted discovery to compute shared secrets.
 */
export interface Contact {
    /** The contact's privacy pool address. */
    address: Address;
    /** The contact's viewing public key (X25519, 32 bytes, 0x-prefixed). */
    viewingPublicKey: PublicKey;
    /** Optional human-readable label for the contact. */
    label?: string;
}

/**
 * Parsed representation of an on-chain Note event.
 * Each Note event corresponds to a single output note.
 */
export interface NoteEvent {
    /** Block number where the event was emitted. */
    blockNumber: Hex;
    /** Transaction hash of the event. */
    txHash: Hash;
    /** Poseidon-derived tag for targeted discovery filtering. bytes32(0) for anonymous/catch-all. */
    hint: Hex;
    /** Sender's single-use ephemeral public key (X25519, 32 bytes). */
    ephemeralPubKey: PublicKey;
    /** The encrypted payload (ciphertext). When decrypted, yields an RLP-encoded versioned NotePayload. */
    encryptedPayload: Hex;
}

/**
 * Decrypted note payload extracted from an encrypted on-chain payload.
 * Contains the four essential fields needed to reconstruct a note.
 */
export interface NotePayload {
    /** Random blinding factor: Poseidon(ownerAddress, noteSecret) produces the note address hash. */
    noteSecret: Secret;
    /** Token amount in smallest unit. */
    value: Hex;
    /** Token address (20 bytes). */
    tokenId: Address;
    /** Lineage identifier shared by all notes in the same deposit lineage. */
    label: Label;
}

/**
 * Decrypted v2 note payload used exclusively for payment-request notes.
 *
 * Carries the pre-computed `noteAddressHash` instead of the `noteSecret`: the
 * recipient already holds the matching secret locally (persisted on its
 * {@link PaymentRequestRecord}), so the secret never travels to the sender or
 * onto the chain. At discovery the recipient looks the secret up from its local
 * map keyed by this `noteAddressHash`. Encodes as `RLP([0x02, noteAddressHash,
 * value, tokenId, label])`.
 */
export interface PaymentRequestNotePayload {
    /** Pre-computed `Poseidon(recipientAddress, noteSecret)` slot the recipient committed to. */
    noteAddressHash: Hash;
    /** Token amount in smallest unit. */
    value: Hex;
    /** Token address (20 bytes). */
    tokenId: Address;
    /** Lineage identifier shared by all notes in the same deposit lineage. */
    label: Label;
}

/**
 * A note discovered via scanning.
 * Reuses fields from Note to avoid duplication and ensure alignment.
 * Adds discovery-specific metadata (contact, blockNumber).
 */
export interface DiscoveredNote extends Pick<
    Note,
    "commitment" | "noteSecret" | "value" | "tokenId" | "label" | "txHash"
> {
    /** The contact who sent this note. Null for catch-all and payment-request discoveries. */
    contact: Contact | null;
    /** Block number where the note was created. */
    blockNumber: Hex;
    /**
     * paymentId of the payment request this note fulfilled. Set only for notes discovered
     * via {@link INoteDiscoveryService.scanPaymentRequests} — used by the discovery
     * orchestrator to call {@link IPaymentRequestService.markFulfilled} after persisting.
     */
    paymentId?: Hex;
    /**
     * The note's true owner, when it differs from the scanning session's own account address.
     * Set only by {@link INoteDiscoveryService.scanStealthDeposits} — a stealth-owned deposit's
     * `noteAddressHash` is bound to the derived stealth address, not the session's registered
     * address. Every other scan path leaves this unset; the orchestrator falls back to the
     * session's own address when absent.
     */
    ownerAddress?: Address;
}
