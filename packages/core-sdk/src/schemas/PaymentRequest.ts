import { z } from "zod";

import type { Hash, PaymentRequest, Secret } from "../internal.js";
import { AddressSchema, HexSchema } from "./common.js";

/** Validates {@link PaymentRequestStatus}. */
export const PaymentRequestStatusSchema = z.enum(["OPEN", "FULFILLED", "ARCHIVED"]);

/**
 * Accepts a real `Map<Hex, Hex>`, a plain object `Record<Hex, Hex>`, or an
 * array of `[Hex, Hex]` entries and normalizes to `Map<Hex, Hex>`.
 *
 * Bare `z.map(...)` is type-correct in memory but `JSON.stringify(Map)`
 * returns `{}` and `JSON.parse(...)` produces a plain object — every
 * JSON-backed persistence path (LocalStorage, FileStorage) and every
 * QR/link transport silently dropped the entries (sub-739). The codec
 * accepts whichever shape the transport leaves us with.
 */
const NoteSecretsMapCodec = z
    .union([
        z.map(HexSchema, HexSchema),
        z.record(HexSchema, HexSchema),
        z.array(z.tuple([HexSchema, HexSchema])),
    ])
    .transform((input) => {
        if (input instanceof Map) return input as Map<Hash, Secret>;
        if (Array.isArray(input)) return new Map(input) as Map<Hash, Secret>;
        return new Map(Object.entries(input)) as Map<Hash, Secret>;
    })
    .refine((m) => m.size > 0, {
        message: "noteSecretsMap must contain at least one slot",
    });

/**
 * Validates a public {@link PaymentRequest} (the QR-shareable shape — no
 * private key, no secrets). Carries only the pre-committed `noteAddressHashes`;
 * the matching secrets stay recipient-local on the {@link PaymentRequestRecord}.
 */
export const PaymentRequestSchema = z.object({
    paymentId: HexSchema,
    noteAddressHashes: z.array(HexSchema).min(1),
    amount: HexSchema,
    tokenId: AddressSchema,
    tag: HexSchema,
    paymentPubKey: HexSchema,
    // Shared so the SENDER can see the deadline and refuse a lapsed request. Optional: a request
    // created before expiry existed carries no stamp and never expires.
    expiresAt: HexSchema.optional(),
});

/**
 * Validates a {@link StoredPaymentRequestRecord}. Extends the public shape with
 * the recipient-local `noteSecretsMap` (kept off the shareable request) plus
 * lifecycle metadata. No `paymentPrivKey` — see
 * {@link PaymentRequestRecord.paymentPrivKey} for why it is not stored.
 * `noteSecretsMap` round-trips through JSON via {@link NoteSecretsMapCodec}.
 */
export const StoredPaymentRequestRecordSchema = PaymentRequestSchema.extend({
    noteSecretsMap: NoteSecretsMapCodec,
    recipientAddress: AddressSchema,
    status: PaymentRequestStatusSchema,
    createdAt: HexSchema,
    fulfilledByCommitments: z.array(HexSchema),
    // `.default([])` keeps pre-#600 snapshots (which lack the field) importable.
    consumedSlots: z.array(HexSchema).default([]),
    // Optional: absent on every record written before scan retirement existed, and on every
    // request still being scanned. It must be declared here regardless — this schema is what
    // both the storage load path and `importState` run records through, and a field the
    // schema does not know about is dropped, so a retired request would come back scannable
    // after a reload or an export/import round trip.
    scanRetiredAt: HexSchema.optional(),
});

/** Validates the full persisted state blob. */
export const PaymentRequestServiceStateSchema = z.object({
    requests: z.array(StoredPaymentRequestRecordSchema),
});

/** Validates per-call generate parameters. */
export const GeneratePaymentRequestParamsSchema = z.object({
    amount: HexSchema,
    tokenId: AddressSchema,
    slots: z.number().int().positive().optional(),
});

/** Validates per-call fulfill parameters; enforces inputCommitments fits within request slots. */
export const FulfillPaymentRequestParamsSchema = z
    .object({
        paymentRequest: PaymentRequestSchema,
        inputCommitments: z.array(HexSchema).min(1),
        relayAddress: AddressSchema.optional(),
        feeAmount: HexSchema.optional(),
        processorAddress: AddressSchema.optional(),
    })
    .refine((v) => v.inputCommitments.length <= v.paymentRequest.noteAddressHashes.length, {
        message: "inputCommitments.length exceeds payment request slot count",
        path: ["inputCommitments"],
    });

/**
 * Serializes a {@link PaymentRequest} into a JSON string suitable for
 * QR codes / deep links. The public shape carries only JSON-native fields
 * (`noteAddressHashes` is a string array), so a plain `JSON.stringify` round-trips
 * cleanly. Pair with {@link parsePaymentRequest} on the receiving end.
 */
export function serializePaymentRequest(request: PaymentRequest): string {
    return JSON.stringify(request);
}

/**
 * Parses a {@link PaymentRequest} from the JSON shape produced by
 * {@link serializePaymentRequest}. The schema codec accepts either the
 * array-of-entries form or a real Map, so this also tolerates inputs
 * authored by hand.
 *
 * @throws {z.ZodError} If the input fails schema validation.
 */
export function parsePaymentRequest(raw: string): PaymentRequest {
    const parsed: unknown = JSON.parse(raw);
    return PaymentRequestSchema.parse(parsed);
}
