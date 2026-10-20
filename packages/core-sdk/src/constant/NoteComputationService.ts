import type { Hex } from "../internal.js";

/**
 * Single on-chain NotePayload wire version. Every note emitted on-chain
 * (deposit, change, withdraw output, ordinary transfer, payment-request note)
 * uses this version. Per-kind field-sets are selected by the kind byte that
 * immediately follows the version.
 *
 * Wire format: `RLP([NOTE_PAYLOAD_VERSION_HEX, kind, ...fields])`.
 */
export const NOTE_PAYLOAD_VERSION = 2;
export const NOTE_PAYLOAD_VERSION_HEX: Hex = "0x02" as Hex;

/**
 * "Full" kind — payload carries the spend material (`noteSecret`) inline.
 * Used by deposit, sender change, withdraw output, and ordinary discoverable
 * transfers — the recipient learns the noteSecret by decrypting the payload.
 *
 * Fields after `[version, kind]`: `[noteSecret, value, tokenId, label]`.
 */
export const KIND_FULL = 1;
export const KIND_FULL_HEX: Hex = "0x01" as Hex;

/**
 * "Blind" kind — payload carries only the pre-committed `noteAddressHash`,
 * never the secret. The recipient holds the matching `noteSecret` locally
 * (persisted on its `PaymentRequestRecord`) and reconstructs the spendable
 * note at discovery by looking the secret up by hash. The sender is blind to
 * the spendable material.
 *
 * Distinct from `ResolvedTransferRecipient.blind` (a resolved-recipient state
 * meaning "no on-chain Note event at all") — same word, different layer.
 *
 * Fields after `[version, kind]`: `[noteAddressHash, value, tokenId, label]`.
 */
export const KIND_BLIND = 2;
export const KIND_BLIND_HEX: Hex = "0x02" as Hex;
