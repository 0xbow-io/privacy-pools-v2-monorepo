import { z } from "zod";

import type { Address, Hash, Hex, PaymentRequestNotePayload } from "../internal.js";
// Direct path import (bypassing `internal.js`) so the template-literal error
// messages below resolve at schema-build time — `internal.js` evaluates the
// schemas barrel before the constants barrel, which would otherwise bake an
// `undefined` into the message strings.
import {
    KIND_BLIND,
    KIND_BLIND_HEX,
    NOTE_PAYLOAD_VERSION,
    NOTE_PAYLOAD_VERSION_HEX,
} from "../constant/NoteComputationService.js";

/**
 * Validates the RLP-decoded items array for a blind-kind NotePayload —
 * `RLP([0x02, KIND_BLIND, noteAddressHash, value, tokenId, label])` — and
 * transforms it into a typed {@link PaymentRequestNotePayload}.
 *
 * Replaces a chain of length / version / kind / field-count `if` checks in
 * `decodePaymentRequestNotePayload`. Field-level hex shape isn't asserted
 * here because viem's `fromRlp` already returns canonical `Hex` items; the
 * schema's job is to guard the discriminator (version + kind) and arity.
 *
 * Custom messages are kept so the existing test assertions stay valid and
 * a thrown {@link PayloadDecodeError} carries an actionable string.
 */
export const BlindNoteRlpSchema = z
    .array(z.string())
    .refine((items) => items.length === 6, {
        message: "blind kind expects 4 fields",
    })
    .refine((items) => items[0] === NOTE_PAYLOAD_VERSION_HEX, {
        message: `expected NotePayload version ${NOTE_PAYLOAD_VERSION}`,
    })
    .refine((items) => items[1] === KIND_BLIND_HEX, {
        message: `expected kind ${KIND_BLIND} (blind)`,
    })
    .transform(
        (items): PaymentRequestNotePayload => ({
            noteAddressHash: items[2] as Hash,
            value: items[3] as Hex,
            tokenId: items[4] as Address,
            label: items[5] as Hex,
        }),
    );
