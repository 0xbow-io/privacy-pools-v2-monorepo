import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import type { DecodedPayoutRouting, Hex, StellarAddress } from "../../../src/internal.js";
import { ContractCallError, StellarPayoutRoutingCodec } from "../../../src/internal.js";

const codec = new StellarPayoutRoutingCodec();

const ROUTING: DecodedPayoutRouting<StellarAddress> = {
    recipient: Keypair.random().publicKey(),
    feeRecipient: Keypair.random().publicKey(),
    feeAmount: 1234n,
    nativeGas: 0n,
};

/** Independently builds the reference `recipient‖fee_recipient‖fee_amount(LE)` byte layout. */
function referenceEncode(routing: DecodedPayoutRouting<StellarAddress>): Hex {
    const recipientBytes = Buffer.from(routing.recipient, "ascii");
    const feeRecipientBytes = Buffer.from(routing.feeRecipient, "ascii");
    const feeAmountBytes = Buffer.alloc(16);
    feeAmountBytes.writeBigUInt64LE(routing.feeAmount & 0xffffffffffffffffn, 0);
    feeAmountBytes.writeBigUInt64LE(routing.feeAmount >> 64n, 8);
    const buf = Buffer.concat([recipientBytes, feeRecipientBytes, feeAmountBytes]);
    return `0x${buf.toString("hex")}` as Hex;
}

describe("StellarPayoutRoutingCodec", () => {
    describe("encode", () => {
        it("match a hand-packed recipient‖fee_recipient‖fee_amount(LE) reference", () => {
            expect(codec.encode(ROUTING)).toBe(referenceEncode(ROUTING));
        });

        it("produce exactly 128 bytes (56 + 56 + 16)", () => {
            const encoded = codec.encode(ROUTING);
            expect(encoded.slice(2).length).toBe(128 * 2);
        });

        it("reject a non-zero nativeGas — the real PayoutRouting struct has no such field", () => {
            expect(() => codec.encode({ ...ROUTING, nativeGas: 1n })).toThrow(ContractCallError);
        });

        it("produce different encodings for different routing fields", () => {
            const a = codec.encode(ROUTING);
            const b = codec.encode({ ...ROUTING, feeAmount: ROUTING.feeAmount + 1n });
            expect(a).not.toBe(b);
        });
    });

    describe("decode", () => {
        it("round-trip a PayoutRouting tuple through encode/decode", () => {
            const encoded = codec.encode(ROUTING);
            expect(codec.decode(encoded)).toEqual(ROUTING);
        });

        it("reject data that is not exactly 128 bytes", () => {
            expect(() => codec.decode("0x1234" as Hex)).toThrow(ContractCallError);
        });
    });

    describe("decodeArray", () => {
        it("round-trip batch routings through encodeArray, in order", () => {
            const second = { ...ROUTING, feeAmount: ROUTING.feeAmount + 1n };

            expect(codec.decodeArray(codec.encodeArray([ROUTING, second]))).toEqual([ROUTING, second]);
        });

        it("reject data that is not a whole number of routings with ContractCallError", () => {
            const partial = codec.encode(ROUTING).slice(0, -2) as Hex;

            expect(() => codec.decodeArray(partial)).toThrow(ContractCallError);
            expect(() => codec.decodeArray("0x" as Hex)).toThrow(ContractCallError);
        });
    });
});
