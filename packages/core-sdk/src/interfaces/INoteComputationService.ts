import type {
    Hex,
    NoteData,
    NotePayload,
    PaymentRequestNotePayload,
    Secret,
} from "../internal.js";

/**
 * Interface for the NoteComputationService.
 * Centralizes Poseidon hash chain computations that are shared across multiple
 * consumers, plus the binary NotePayload codec and the `generateNoteData` helper
 * that produces the encrypted `{ hint, data }` tuple emitted on-chain.
 *
 * The Poseidon-hash methods below (`computeNoteAddressHash`, `computePrecommitment`,
 * `computeFullCommitment`) take the already field-converted `Hex` for owner/token values, not a
 * chain's raw `TAddress` — see {@link IAddressFieldConverter}. An EVM address already fits as a
 * field element, so an EVM caller's conversion is an identity function; a caller for a chain
 * whose `TAddress` is not itself field-sized (e.g. Stellar's StrKey) MUST call
 * `addressFieldConverter.toField(...)` before invoking these methods.
 */
export interface INoteComputationService {
    /**
     * Computes the note address hash: Poseidon(ownerAddressField, noteSecret).
     * @param ownerAddressField - The note owner's address, already converted to a field-sized `Hex`.
     * @param noteSecret - The random blinding factor.
     * @returns The note address hash.
     * @throws {NoteComputationServiceBaseError}
     */
    computeNoteAddressHash(ownerAddressField: Hex, noteSecret: Secret): Hex;

    /**
     * Computes the precommitment: Poseidon(noteAddressHash, tokenIdField, value, METADATA_STANDARD).
     * @param noteAddressHash - The note address hash.
     * @param tokenIdField - The token identifier, already converted to a field-sized `Hex`.
     * @param value - The token amount.
     * @returns The precommitment hash.
     * @throws {NoteComputationServiceBaseError}
     */
    computePrecommitment(noteAddressHash: Hex, tokenIdField: Hex, value: Hex): Hex;

    /**
     * Computes the label: Poseidon(precommitment, depositSecret).
     * @param precommitment - The precommitment hash.
     * @param depositSecret - The deposit secret.
     * @returns The label hash.
     * @throws {NoteComputationServiceBaseError}
     */
    computeLabel(precommitment: Hex, depositSecret: Secret): Hex;

    /**
     * Computes the full commitment from note parameters in one call:
     * precommitment = Poseidon(noteAddressHash, tokenIdField, value, METADATA_STANDARD)
     * commitment = Poseidon(precommitment, label)
     * @param params - The note parameters.
     * @returns The commitment hash.
     * @throws {NoteComputationServiceBaseError}
     */
    computeFullCommitment(params: {
        noteAddressHash: Hex;
        tokenId: Hex;
        value: Hex;
        label: Hex;
    }): Hex;

    /**
     * Computes the auth digest: Poseidon(AUTH_TYPE_DIRECT_KEY, privateRevocableKey).
     * @param privateRevocableKey - The private revocable key.
     * @returns The authorization digest.
     * @throws {NoteComputationServiceBaseError}
     */
    computeAuthDigest(privateRevocableKey: Secret): Hex;

    /**
     * Computes the nullifier: Poseidon(privateNullifyingKey, commitment).
     * @param privateNullifyingKey - The private nullifying key.
     * @param commitment - The note commitment.
     * @returns The nullifier hash.
     * @throws {NoteComputationServiceBaseError}
     */
    computeNullifier(privateNullifyingKey: Secret, commitment: Hex): Hex;

    /**
     * Computes the label hash: Poseidon(label).
     * @param label - The note label.
     * @returns The label hash.
     * @throws {NoteComputationServiceBaseError}
     */
    computeLabelHash(label: Hex): Hex;

    /**
     * Encodes a NotePayload into the unified RLP binary format.
     * Structure: `RLP([0x02, KIND_FULL, noteSecret, value, tokenId, label])`.
     * The version byte (`0x02`) is shared by every NotePayload on the wire; the
     * kind byte selects the field-set. This method always emits `KIND_FULL`.
     * @param payload - The note payload to encode.
     * @returns The RLP-encoded binary payload.
     * @throws {NoteComputationServiceBaseError}
     */
    encodeNotePayload(payload: NotePayload): Uint8Array;

    /**
     * Decodes an RLP binary NotePayload. Dispatches on the version byte:
     * - `0x01` (legacy v1, decode-only) — `RLP([0x01, noteSecret, value, tokenId, label])`,
     *   accepted for backward compatibility with notes already on-chain.
     * - `0x02` (current) — `RLP([0x02, kind, ...])` with kind asserted as `KIND_FULL`.
     * Rejects any other version, or a `0x02` payload whose kind isn't `KIND_FULL`
     * (e.g. a `KIND_BLIND` payment-request payload) so the discovery silent-skip
     * path can treat the event as "not mine." New payloads are always emitted at
     * version `0x02` (`encodeNotePayload`).
     * @param bytes - The RLP-encoded binary payload to decode.
     * @returns The decoded NotePayload.
     * @throws {NoteComputationServiceBaseError}
     */
    decodeNotePayload(bytes: Uint8Array): NotePayload;

    /**
     * Builds the on-chain `NoteData` tuple for note discovery:
     * 1. Encodes the NotePayload to RLP binary.
     * 2. Generates an ephemeral X25519 key pair.
     * 3. Derives a shared secret via ECDH with the recipient's viewing public key.
     * 4. Encrypts the plaintext with that shared secret.
     * 5. Prepends the ephemeral public key to the ciphertext and returns it with the supplied hint.
     *
     * @param payload - The NotePayload to encrypt.
     * @param recipientViewingPubKey - The recipient's X25519 viewing public key (32 bytes).
     * @param hint - Optional on-chain `hint` topic. Defaults to the catch-all (`ANONYMOUS_HINT`).
     *               Payment-request fulfillment passes the recipient-chosen `tag` so the recipient
     *               can filter `eth_getLogs` for their request in O(1).
     * @returns A `NoteData` tuple ready to be emitted on-chain.
     * @throws {NoteComputationServiceBaseError}
     */
    generateNoteData(payload: NotePayload, recipientViewingPubKey: Hex, hint?: Hex): NoteData;

    /**
     * Encodes a {@link PaymentRequestNotePayload} into the unified RLP binary format.
     * Structure: `RLP([0x02, KIND_BLIND, noteAddressHash, value, tokenId, label])`.
     * Carries the pre-committed `noteAddressHash` instead of the `noteSecret`, so
     * the secret never travels to the sender or onto the chain for payment-request
     * notes. (Wire-kind `blind` is distinct from `ResolvedTransferRecipient.blind`,
     * which refers to suppressing the on-chain Note event entirely.)
     * @param payload - The blind-kind payment-request note payload to encode.
     * @returns The RLP-encoded binary payload.
     * @throws {NoteComputationServiceBaseError}
     */
    encodePaymentRequestNotePayload(payload: PaymentRequestNotePayload): Uint8Array;

    /**
     * Decodes an RLP binary payload into a {@link PaymentRequestNotePayload}.
     * Asserts version `0x02` and kind `KIND_BLIND`; rejects any other version or
     * kind (e.g. a `KIND_FULL` ordinary payload).
     * @param bytes - The RLP-encoded binary payload to decode.
     * @returns The decoded blind-kind payment-request note payload.
     * @throws {NoteComputationServiceBaseError}
     */
    decodePaymentRequestNotePayload(bytes: Uint8Array): PaymentRequestNotePayload;

    /**
     * Builds the on-chain `NoteData` tuple for a payment-request note using the
     * blind-kind payload (no `noteSecret`). Identical wrapping to
     * {@link generateNoteData} — encode, ephemeral ECDH, encrypt, prepend
     * ephemeral key — but encodes a {@link PaymentRequestNotePayload} carrying
     * `noteAddressHash` instead of the secret.
     *
     * @param payload - The v2 payment-request note payload to encrypt.
     * @param recipientViewingPubKey - The recipient's X25519 viewing public key (32 bytes).
     * @param hint - Optional on-chain `hint` topic; payment-request fulfillment passes the `tag`.
     * @returns A `NoteData` tuple ready to be emitted on-chain.
     * @throws {NoteComputationServiceBaseError}
     */
    generatePaymentRequestNoteData(
        payload: PaymentRequestNotePayload,
        recipientViewingPubKey: Hex,
        hint?: Hex,
    ): NoteData;
}
