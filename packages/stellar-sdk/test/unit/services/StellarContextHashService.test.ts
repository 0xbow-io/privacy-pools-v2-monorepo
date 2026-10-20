import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";

import type { Hex, NoteData, TransactParams } from "../../../src/internal.js";
import { BN254_SCALAR_MODULUS, StellarContextHashService } from "../../../src/internal.js";

const service = new StellarContextHashService();

/** Independently reduces a keccak256 digest mod the BN254 scalar field, as a `0x`-padded Hex. */
function keccakModFieldReference(bytes: Uint8Array): Hex {
    const hash = keccak_256(bytes);
    let value = 0n;
    for (const byte of hash) value = (value << 8n) | BigInt(byte);
    const field = value % BN254_SCALAR_MODULUS;
    return ("0x" + field.toString(16).padStart(64, "0")) as Hex;
}

/** 4 little-endian bytes, built independently of the service's own `u32LE` helper. */
function u32LEReference(n: number): number[] {
    return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

function hexBytes(hex: Hex): number[] {
    const clean = hex.slice(2);
    const out: number[] = [];
    for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
    return out;
}

describe("StellarContextHashService", () => {
    describe("computeDepositContext", () => {
        it("match a hand-packed hint‖len(data)‖data reference for known inputs", () => {
            const noteData: NoteData = {
                hint: `0x${"00".repeat(32)}` as Hex,
                data: "0x1234" as Hex,
            };

            const expectedBytes = new Uint8Array([
                ...hexBytes(noteData.hint),
                ...u32LEReference(2),
                0x12,
                0x34,
            ]);
            const expected = keccakModFieldReference(expectedBytes);

            expect(service.computeDepositContext(noteData)).toBe(expected);
        });

        it("produce different contexts for different note data", () => {
            const a = service.computeDepositContext({
                hint: `0x${"00".repeat(32)}` as Hex,
                data: "0x1234" as Hex,
            });
            const b = service.computeDepositContext({
                hint: `0x${"00".repeat(32)}` as Hex,
                data: "0x5678" as Hex,
            });
            expect(a).not.toBe(b);
        });

        it("produce different contexts for different hints", () => {
            const a = service.computeDepositContext({
                hint: `0x${"00".repeat(32)}` as Hex,
                data: "0x1234" as Hex,
            });
            const b = service.computeDepositContext({
                hint: `0x${"11".repeat(32)}` as Hex,
                data: "0x1234" as Hex,
            });
            expect(a).not.toBe(b);
        });
    });

    describe("computeTransactContext", () => {
        it("match a hand-packed processor‖len‖data‖numNotes‖notes reference for known inputs", () => {
            const processor = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5FQE";
            const transactParams: TransactParams<string> = {
                processor,
                data: "0xabcd" as Hex,
            };
            const noteData: NoteData[] = [
                { hint: `0x${"01".repeat(32)}` as Hex, data: "0x11" as Hex },
                { hint: `0x${"02".repeat(32)}` as Hex, data: "0x2222" as Hex },
            ];

            const processorBytes = Array.from(Buffer.from(processor, "utf8"));
            const expectedBytes = new Uint8Array([
                ...processorBytes,
                ...u32LEReference(2),
                0xab,
                0xcd,
                ...u32LEReference(2),
                ...hexBytes(noteData[0].hint),
                ...u32LEReference(1),
                0x11,
                ...hexBytes(noteData[1].hint),
                ...u32LEReference(2),
                0x22,
                0x22,
            ]);
            const expected = keccakModFieldReference(expectedBytes);

            expect(service.computeTransactContext(transactParams, noteData)).toBe(expected);
        });

        it("produce different contexts for a different processor", () => {
            const noteData: NoteData[] = [{ hint: `0x${"00".repeat(32)}` as Hex, data: "0x" as Hex }];
            const a = service.computeTransactContext(
                { processor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5FQE", data: "0x" as Hex },
                noteData,
            );
            const b = service.computeTransactContext(
                { processor: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHZ7O", data: "0x" as Hex },
                noteData,
            );
            expect(a).not.toBe(b);
        });

        it("produce different contexts for a different number of output notes", () => {
            const transactParams: TransactParams<string> = {
                processor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5FQE",
                data: "0x" as Hex,
            };
            const one = service.computeTransactContext(transactParams, [
                { hint: `0x${"00".repeat(32)}` as Hex, data: "0x" as Hex },
            ]);
            const two = service.computeTransactContext(transactParams, [
                { hint: `0x${"00".repeat(32)}` as Hex, data: "0x" as Hex },
                { hint: `0x${"00".repeat(32)}` as Hex, data: "0x" as Hex },
            ]);
            expect(one).not.toBe(two);
        });
    });
});
