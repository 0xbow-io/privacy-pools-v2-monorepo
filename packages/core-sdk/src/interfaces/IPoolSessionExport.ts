import type { AccountExport, Address, Note, SealedEnvelope } from "../internal.js";

/**
 * Interface for the PoolSessionExport facade, generic over the chain's address type `TAddress`.
 * Provides account portability via export/import of note and payment-request state.
 * Keys are excluded from export — they are always provided at construction time.
 */
export interface IPoolSessionExport<TAddress = Address> {
    /**
     * Serializes full account state (notes, lineages, sync cursor, and pending
     * payment requests) for backup or migration. The envelope is stamped with
     * the owner address and chain id it belongs to.
     *
     * ⚠️ SECURITY (RC-03 #360): the returned envelope contains note secrets and
     * the full shielded-note graph **in cleartext**. It MUST NOT be written to
     * disk, logged, or transmitted unsealed. Either seal it yourself before it
     * leaves memory, or use {@link exportAccountSealed} which returns an
     * AEAD-encrypted envelope instead.
     *
     * @returns AccountExport containing note and payment-request state (cleartext secrets).
     */
    exportAccount(): Promise<AccountExport<TAddress>>;

    /**
     * AEAD-sealed variant of {@link exportAccount} (RC-03 #360). Serializes the
     * same account state, then XChaCha20-Poly1305-encrypts it under a key derived
     * from `passphrase` via scrypt. Safe to persist or transmit — the passphrase
     * is never included in the envelope. Restore with {@link importAccountSealed}.
     *
     * @param passphrase - Runtime passphrase the seal key is derived from (never persisted).
     * @returns A self-describing sealed envelope (salt + KDF params + ciphertext).
     * @throws {EncryptedStorageBaseError}
     */
    exportAccountSealed(passphrase: string | Uint8Array): Promise<SealedEnvelope>;

    /**
     * Restores account state from a previous export. Replaces current note state
     * in NoteManager and pending requests in PaymentRequestService. Rejects a
     * blob whose owner or chain differs from this session.
     *
     * @param data - Previously exported state from `exportAccount()`.
     * @throws {PoolSessionExportBaseError}
     * @throws {NoteManagerBaseError}
     * @throws {PaymentRequestBaseError}
     */
    importAccount(data: AccountExport<TAddress>): Promise<void>;

    /**
     * Restores account state from a sealed envelope produced by
     * {@link exportAccountSealed}. Opens the AEAD envelope with `passphrase`,
     * then applies it exactly like {@link importAccount} (owner/chain checks
     * included). A wrong passphrase or tampered envelope fails to decrypt.
     *
     * @param sealed - Previously sealed envelope from `exportAccountSealed()`.
     * @param passphrase - The passphrase the envelope was sealed under.
     * @throws {PoolSessionExportBaseError}
     * @throws {EncryptedStorageBaseError}
     * @throws {NoteManagerBaseError}
     * @throws {PaymentRequestBaseError}
     */
    importAccountSealed(sealed: SealedEnvelope, passphrase: string | Uint8Array): Promise<void>;

    /**
     * Imports a note received via a cold start transfer.
     *
     * The note comes from another party, so its fields are verified before
     * storage: the owner must match this session and the commitment must bind
     * the note's own value, token, label, and secret. The note is added with
     * PENDING status and promoted to ACTIVE when the next `discoverNotes()` call
     * syncs label approval from the ASP.
     *
     * @param note - The note delivered out-of-band by the sender.
     * @throws {NoteManagerBaseError}
     */
    importReceivedNote(note: Note<TAddress>): Promise<void>;
}
