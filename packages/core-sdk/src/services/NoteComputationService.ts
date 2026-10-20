import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";
import type { ZodType } from "zod";

import type {
    Address,
    Hex,
    ICryptoService,
    IHashService,
    ILogger,
    INoteComputationService,
    NoteComputationServiceConfig,
    NoteComputationServiceDependencies,
    NoteData,
    NotePayload,
    PaymentRequestNotePayload,
    Secret,
} from "../internal.js";
import {
    AddressSchema,
    AUTH_TYPE_DIRECT_KEY,
    BlindNoteRlpSchema,
    decodeHexListRlp,
    encodeHexListRlp,
    HexSchema,
    KIND_BLIND_HEX,
    KIND_FULL,
    KIND_FULL_HEX,
    METADATA_STANDARD,
    NOTE_PAYLOAD_VERSION,
    NOTE_PAYLOAD_VERSION_HEX,
    PayloadDecodeError,
    SecretSchema,
} from "../internal.js";

/**
 * Implementation of the NoteComputationService interface.
 * Centralizes Poseidon hash chain computations shared across multiple consumers,
 * the binary NotePayload codec, and the `generateNoteData` helper used by both
 * PoolSessionDeposit and PoolSessionTransact to build the on-chain NoteData.
 */
export class NoteComputationService implements INoteComputationService {
    private readonly hashService: IHashService;
    private readonly cryptoService: ICryptoService;
    private readonly tokenIdFieldSchema: ZodType<string>;
    private readonly logger?: ILogger;

    /**
     * Creates a new NoteComputationService instance.
     * @param config - Required service dependencies.
     * @param config.hashService - The hash service for Poseidon computations.
     * @param config.cryptoService - The crypto service for ECDH, ephemeral keys, and encryption.
     * @param config.tokenIdFieldSchema - Validates a decoded payload's tokenId field.
     * @param dependencies - Optional dependencies.
     * @param dependencies.logger - Optional logger for debug output.
     */
    constructor(
        config: NoteComputationServiceConfig,
        dependencies?: NoteComputationServiceDependencies,
    ) {
        this.hashService = config.hashService;
        this.cryptoService = config.cryptoService;
        this.tokenIdFieldSchema = config.tokenIdFieldSchema ?? AddressSchema;
        this.logger = dependencies?.logger;
    }

    /**
     * @inheritdoc INoteComputationService.computeNoteAddressHash
     */
    computeNoteAddressHash(ownerAddressField: Hex, noteSecret: Secret): Hex {
        return this.hashService.hash([ownerAddressField, noteSecret]);
    }

    /**
     * @inheritdoc INoteComputationService.computePrecommitment
     */
    computePrecommitment(noteAddressHash: Hex, tokenIdField: Hex, value: Hex): Hex {
        return this.hashService.hash([noteAddressHash, tokenIdField, value, METADATA_STANDARD]);
    }

    /**
     * @inheritdoc INoteComputationService.computeLabel
     */
    computeLabel(precommitment: Hex, depositSecret: Secret): Hex {
        return this.hashService.hash([precommitment, depositSecret]);
    }

    /**
     * @inheritdoc INoteComputationService.computeFullCommitment
     */
    computeFullCommitment(params: {
        noteAddressHash: Hex;
        tokenId: Hex;
        value: Hex;
        label: Hex;
    }): Hex {
        const precommitment = this.computePrecommitment(
            params.noteAddressHash,
            params.tokenId,
            params.value,
        );
        return this.hashService.hash([precommitment, params.label]);
    }

    /**
     * @inheritdoc INoteComputationService.computeAuthDigest
     */
    computeAuthDigest(privateRevocableKey: Secret): Hex {
        return this.hashService.hash([AUTH_TYPE_DIRECT_KEY, privateRevocableKey]);
    }

    /**
     * @inheritdoc INoteComputationService.computeNullifier
     */
    computeNullifier(privateNullifyingKey: Secret, commitment: Hex): Hex {
        return this.hashService.hash([privateNullifyingKey, commitment]);
    }

    /**
     * @inheritdoc INoteComputationService.computeLabelHash
     */
    computeLabelHash(label: Hex): Hex {
        return this.hashService.hash([label]);
    }

    /**
     * @inheritdoc INoteComputationService.encodeNotePayload
     */
    encodeNotePayload(payload: NotePayload): Uint8Array {
        const rlpHex = encodeHexListRlp([
            NOTE_PAYLOAD_VERSION_HEX,
            KIND_FULL_HEX,
            payload.noteSecret,
            payload.value,
            payload.tokenId,
            payload.label,
        ]);
        return hexToBytes(rlpHex.slice(2));
    }

    /**
     * @inheritdoc INoteComputationService.decodeNotePayload
     * @throws {PayloadDecodeError} If the RLP structure is invalid, the version
     *   is not supported, the v2 kind isn't {@link KIND_FULL}, or the field
     *   count is wrong for the detected version.
     */
    decodeNotePayload(bytes: Uint8Array): NotePayload {
        try {
            const items = decodeHexListRlp(`0x${bytesToHex(bytes)}` as Hex);
            if (items.length === 0) {
                throw new PayloadDecodeError("expected a non-empty RLP list");
            }
            const version = Number(items[0]);

            switch (version) {
                case 1:
                    return this.deserializeV1(items);
                case NOTE_PAYLOAD_VERSION:
                    return this.deserializeV2(items);
                default:
                    throw new PayloadDecodeError(`unsupported NotePayload version ${version}`);
            }
        } catch (error) {
            if (error instanceof PayloadDecodeError) throw error;
            throw new PayloadDecodeError(
                `invalid RLP: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * @inheritdoc INoteComputationService.generateNoteData
     */
    generateNoteData(payload: NotePayload, recipientViewingPubKey: Hex, hint?: Hex): NoteData {
        const plaintext = this.encodeNotePayload(payload);
        return this.encryptAndWrap(plaintext, recipientViewingPubKey, hint);
    }

    /**
     * @inheritdoc INoteComputationService.encodePaymentRequestNotePayload
     */
    encodePaymentRequestNotePayload(payload: PaymentRequestNotePayload): Uint8Array {
        const rlpHex = encodeHexListRlp([
            NOTE_PAYLOAD_VERSION_HEX,
            KIND_BLIND_HEX,
            payload.noteAddressHash,
            payload.value,
            payload.tokenId,
            payload.label,
        ]);
        return hexToBytes(rlpHex.slice(2));
    }

    /**
     * @inheritdoc INoteComputationService.decodePaymentRequestNotePayload
     * @throws {PayloadDecodeError} If the RLP structure is invalid or the
     *   payload fails {@link BlindNoteRlpSchema} validation (wrong version,
     *   non-blind kind, or wrong field count).
     */
    decodePaymentRequestNotePayload(bytes: Uint8Array): PaymentRequestNotePayload {
        try {
            const decoded = decodeHexListRlp(`0x${bytesToHex(bytes)}` as Hex);
            const parsed = BlindNoteRlpSchema.safeParse(decoded);
            if (!parsed.success) {
                throw new PayloadDecodeError(parsed.error.issues[0]!.message);
            }
            return parsed.data;
        } catch (error) {
            if (error instanceof PayloadDecodeError) throw error;
            throw new PayloadDecodeError(
                `invalid RLP: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * @inheritdoc INoteComputationService.generatePaymentRequestNoteData
     */
    generatePaymentRequestNoteData(
        payload: PaymentRequestNotePayload,
        recipientViewingPubKey: Hex,
        hint?: Hex,
    ): NoteData {
        const plaintext = this.encodePaymentRequestNotePayload(payload);
        return this.encryptAndWrap(plaintext, recipientViewingPubKey, hint);
    }

    /**
     * Encrypts an encoded payload to the recipient's viewing key via a fresh
     * ephemeral X25519 keypair and wraps it as on-chain `NoteData`. Shared by
     * the full-kind (`generateNoteData`) and blind-kind
     * (`generatePaymentRequestNoteData`) paths.
     *
     * No associated data is passed, so the ciphertext is bound to the secret alone and to no
     * chain, vault or event. `ICryptoService.encrypt` accepts one, but supplying it here is a
     * WIRE change rather than a local one: the reader must pass byte-identical bytes, and
     * every payload already on-chain was written without them and is immutable. Requiring the
     * binding on the read side would make those notes undiscoverable, and accepting both
     * forms would leave it unenforced permanently, since the old payloads never age out.
     * Turning it on needs a per-chain block below which the unbound form is still read, agreed
     * with the senders — an SDK release decision, not a change to make from one call site.
     */
    private encryptAndWrap(
        plaintext: Uint8Array,
        recipientViewingPubKey: Hex,
        hint?: Hex,
    ): NoteData {
        const ephemeralKey = this.cryptoService.generateEphemeralKeyPair();
        const sharedSecret = this.cryptoService.ecdh(
            ephemeralKey.privateKey,
            recipientViewingPubKey,
        );
        const encrypted = this.cryptoService.encrypt(plaintext, sharedSecret);
        const data = ("0x" + ephemeralKey.publicKey.slice(2) + encrypted.slice(2)) as Hex;

        this.logger?.debug("Generated NoteData", { dataLength: data.length });

        // Anonymous-discovery notes get a fresh random 32-byte hint rather than a
        // hardcoded zero sentinel. A constant zero hint would let observers (ASP,
        // chain explorers) cluster every "anonymous" note across the protocol and
        // identify the catch-all code path. Random hints blend with targeted
        // hints (which are themselves random Poseidon-derived bytes32).
        const resolvedHint = hint ?? (("0x" + bytesToHex(randomBytes(32))) as Hex);
        return { hint: resolvedHint, data };
    }

    /**
     * Decodes the legacy v1 layout (kept decode-only for backward compatibility
     * with notes already on-chain): `RLP([0x01, noteSecret, value, tokenId, label])`.
     * No kind byte. The SDK no longer emits this version; see
     * {@link encodeNotePayload} for the v2 layout used by new payloads.
     */
    private deserializeV1(items: Hex[]): NotePayload {
        const fields = items.slice(1);
        if (fields.length !== 4) {
            throw new PayloadDecodeError(`v1 expects 4 fields, got ${fields.length}`);
        }
        return this.toNotePayload(fields);
    }

    /**
     * Validates the four decoded fields by shape before trusting them. RLP strips leading zeros,
     * so a short `tokenId` would otherwise be cast to `Address` and only fail later in `addNote` —
     * which, with the discovery cursor left un-advanced, retries the same bad event forever. A
     * `PayloadDecodeError` here is caught by the scan as "not mine" and skipped cleanly instead.
     *
     * `tokenId` here is always the FIELD-CONVERTED value (`IAddressFieldConverter.toTokenIdField`),
     * not a literal chain address — EVM's converter is the identity, so it happens to always be a
     * full 20-byte `Address`, but Stellar's is a 160-bit-masked field element whose RLP encoding
     * legitimately strips to fewer than 40 hex chars whenever its high byte is zero. The check
     * below keeps the same "reject obviously-garbage RLP" defense (bounded to the same 160-bit /
     * 20-byte width `Num2Bits(160)` enforces in the shared circuit) without assuming every chain's
     * converted value is exactly that width.
     */
    private toNotePayload(fields: Hex[]): NotePayload {
        const noteSecret = SecretSchema.safeParse(fields[0]);
        if (!noteSecret.success) {
            throw new PayloadDecodeError(
                `invalid noteSecret: ${noteSecret.error.issues[0].message}`,
            );
        }
        const value = HexSchema.safeParse(fields[1]);
        if (!value.success) {
            throw new PayloadDecodeError(`invalid value: ${value.error.issues[0].message}`);
        }
        const tokenId = this.tokenIdFieldSchema.safeParse(fields[2]);
        if (!tokenId.success) {
            throw new PayloadDecodeError(`invalid tokenId: ${tokenId.error.issues[0].message}`);
        }
        const label = HexSchema.safeParse(fields[3]);
        if (!label.success || label.data.length !== 66) {
            throw new PayloadDecodeError("invalid label: expected a 32-byte hash (64 hex chars)");
        }
        return {
            noteSecret: noteSecret.data as Secret,
            value: value.data,
            tokenId: tokenId.data as Address,
            label: label.data,
        };
    }

    /**
     * Decodes the current v2 layout: `RLP([0x02, kind, noteSecret, value, tokenId, label])`.
     * Asserts `kind === KIND_FULL`; rejects `KIND_BLIND` (payment-request) so a
     * cross-kind event silent-skips through the discovery path. Symmetric with
     * the blind-kind dispatch in {@link decodePaymentRequestNotePayload}.
     */
    private deserializeV2(items: Hex[]): NotePayload {
        const kind = Number(items[1]);
        if (kind !== KIND_FULL) {
            throw new PayloadDecodeError(`expected kind ${KIND_FULL} (full), got ${kind}`);
        }
        const fields = items.slice(2);
        if (fields.length !== 4) {
            throw new PayloadDecodeError(`full kind expects 4 fields, got ${fields.length}`);
        }
        return this.toNotePayload(fields);
    }
}
