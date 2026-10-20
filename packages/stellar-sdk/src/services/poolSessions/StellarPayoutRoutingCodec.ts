import { hexToBytes, utf8ToBytes } from "@noble/ciphers/utils.js";

import type { DecodedPayoutRouting, Hex, IPayoutRoutingCodec, StellarAddress } from "../../internal.js";
import { ContractCallError } from "../../internal.js";

/** Every Stellar StrKey (account "G..." or contract "C...") is exactly 56 ASCII characters. */
const STRKEY_LENGTH = 56;
const FEE_AMOUNT_LENGTH = 16;
const ROUTING_LENGTH = STRKEY_LENGTH * 2 + FEE_AMOUNT_LENGTH;

function u128LEBytes(value: bigint): Uint8Array {
    const bytes = new Uint8Array(FEE_AMOUNT_LENGTH);
    let remaining = value;
    for (let i = 0; i < FEE_AMOUNT_LENGTH; i++) {
        bytes[i] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    return bytes;
}

function u128FromLEBytes(bytes: Uint8Array): bigint {
    let value = 0n;
    for (let i = FEE_AMOUNT_LENGTH - 1; i >= 0; i--) {
        value = (value << 8n) | BigInt(bytes[i]);
    }
    return value;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function bytesToHexString(bytes: Uint8Array): Hex {
    let hex = "0x";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex as Hex;
}

/**
 * Stellar implementation of {@link IPayoutRoutingCodec} — packs the `PayoutRouting` tuple as
 * `recipient_strkey(56B ASCII) ‖ fee_recipient_strkey(56B ASCII) ‖ fee_amount(16B LE u128)`,
 * matching the reference Rust relay contract's `encode_routing` byte-for-byte (verified
 * directly against the source — the relay contract computes this internally from the caller's
 * `PayoutRouting {recipient, fee_recipient, fee_amount}` struct and uses it as `processor_data`
 * when it calls `pool.transact`, so the SDK must reproduce the identical bytes client-side to
 * bind the same context hash into the proof before submission).
 *
 * The real `PayoutRouting` struct has no `native_gas` field at all — Stellar's relay has no
 * native-gas-reimbursement concept — so `encode` rejects a non-zero `nativeGas` rather than
 * silently dropping it, and `decode` always reports `nativeGas: 0n`.
 */
export class StellarPayoutRoutingCodec implements IPayoutRoutingCodec<StellarAddress> {
    /**
     * @inheritdoc IPayoutRoutingCodec.encode
     * @throws {ContractCallError} If `routing.nativeGas` is non-zero — the real `PayoutRouting`
     *   struct has no slot for it.
     */
    encode(routing: DecodedPayoutRouting<StellarAddress>): Hex {
        if (routing.nativeGas !== 0n) {
            throw new ContractCallError(
                "Stellar's PayoutRouting has no native_gas field — nativeGas must be 0n",
            );
        }
        return bytesToHexString(
            concatBytes(
                utf8ToBytes(routing.recipient),
                utf8ToBytes(routing.feeRecipient),
                u128LEBytes(routing.feeAmount),
            ),
        );
    }

    /**
     * @inheritdoc IPayoutRoutingCodec.decode
     * @throws {ContractCallError} If `data` is not exactly 128 bytes.
     */
    decode(data: Hex): DecodedPayoutRouting<StellarAddress> {
        const bytes = hexToBytes(data.slice(2));
        if (bytes.length !== ROUTING_LENGTH) {
            throw new ContractCallError(
                `Expected a ${ROUTING_LENGTH}-byte PayoutRouting, got ${bytes.length} bytes`,
            );
        }
        const decoder = new TextDecoder();
        return {
            recipient: decoder.decode(bytes.subarray(0, STRKEY_LENGTH)),
            feeRecipient: decoder.decode(bytes.subarray(STRKEY_LENGTH, STRKEY_LENGTH * 2)),
            feeAmount: u128FromLEBytes(bytes.subarray(STRKEY_LENGTH * 2, ROUTING_LENGTH)),
            nativeGas: 0n,
        };
    }

    /**
     * @inheritdoc IPayoutRoutingCodec.decodeArray
     *
     * A batch fee commitment's `data` is the item routings concatenated in batch order, each in the
     * fixed 128-byte {@link encode} layout — no length prefix is needed, since every routing has
     * the same width.
     * @throws {ContractCallError} When the data is empty or not a whole number of routings.
     */
    decodeArray(data: Hex): DecodedPayoutRouting<StellarAddress>[] {
        const bytes = hexToBytes(data.slice(2));
        if (bytes.length === 0 || bytes.length % ROUTING_LENGTH !== 0) {
            throw new ContractCallError(
                `Expected a whole number of ${ROUTING_LENGTH}-byte PayoutRoutings, got ${bytes.length} bytes`,
            );
        }
        const routings: DecodedPayoutRouting<StellarAddress>[] = [];
        for (let offset = 0; offset < bytes.length; offset += ROUTING_LENGTH) {
            routings.push(this.decode(bytesToHexString(bytes.subarray(offset, offset + ROUTING_LENGTH))));
        }
        return routings;
    }

    /**
     * Encodes routings in the {@link decodeArray} layout — what a relayer signs into a batch fee
     * commitment. Not part of {@link IPayoutRoutingCodec}: only the relayer produces arrays.
     *
     * @param routings - One routing per batch item, in batch order.
     * @returns The concatenated encoding.
     * @throws {ContractCallError} When any routing carries a non-zero `nativeGas`.
     */
    encodeArray(routings: DecodedPayoutRouting<StellarAddress>[]): Hex {
        return bytesToHexString(
            concatBytes(...routings.map((r) => hexToBytes(this.encode(r).slice(2)))),
        );
    }
}
