import { z } from "zod";

import { DecimalRepresentationToHexSchema, HexSchema } from "./common.js";

/**
 * Validates a single Note event entry from the ASP wire payload. Field names
 * match the wire — the `hint → tag` rename happens at the boundary in
 * `HttpASPDataProvider`. Decimal-string `blockNumber` is normalized to
 * canonical Hex; the four hex string fields are validated as `Hex`.
 */
export const NoteEventSchema = z.object({
    blockNumber: DecimalRepresentationToHexSchema,
    txHash: HexSchema,
    hint: HexSchema,
    ephemeralPubKey: HexSchema,
    encryptedPayload: HexSchema,
});

/**
 * Validates the `/{chainId}/public/note-events` response from an ASP.
 * `events` is optional on the wire — an absent field deserializes to `[]`.
 * `lastSyncedBlock` is the highest block the ASP has indexed for this chain;
 * the caller uses it to fall back to RPC for any range past it.
 */
export const NoteEventsResponseSchema = z.object({
    events: z.array(NoteEventSchema).optional().default([]),
    lastSyncedBlock: HexSchema,
});
