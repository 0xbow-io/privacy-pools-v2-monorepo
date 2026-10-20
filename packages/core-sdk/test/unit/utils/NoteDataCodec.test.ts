import { describe, expect, it } from "vitest";

import type { Hex, PublicKey } from "../../../src/internal.js";
import { decodeNoteData, encodeNoteData } from "../../../src/internal.js";

const MOCK_EPHEMERAL_PUB_KEY = ("0x" + "ab".repeat(32)) as PublicKey;
const MOCK_ENCRYPTED_PAYLOAD = ("0x" + "ff".repeat(50)) as Hex;

describe("NoteDataCodec", () => {
    describe("decodeNoteData", () => {
        it("decode concatenated ephemeralPubKey and encryptedPayload", () => {
            const encoded = encodeNoteData(MOCK_EPHEMERAL_PUB_KEY, MOCK_ENCRYPTED_PAYLOAD);
            const { ephemeralPubKey, encryptedPayload } = decodeNoteData(encoded);

            expect(ephemeralPubKey).toBe(MOCK_EPHEMERAL_PUB_KEY);
            expect(encryptedPayload).toBe(MOCK_ENCRYPTED_PAYLOAD);
        });

        it("throw on data with exactly 32 bytes (pubkey only, no payload)", () => {
            const pubKeyOnly = MOCK_EPHEMERAL_PUB_KEY;
            const encoded = encodeNoteData(pubKeyOnly, "0x" as Hex);

            expect(() => decodeNoteData(encoded)).toThrow(/too short/);
        });

        it("decode data with 33 bytes (pubkey + 1 byte payload)", () => {
            const encoded = encodeNoteData(MOCK_EPHEMERAL_PUB_KEY, "0xaa" as Hex);
            const { ephemeralPubKey, encryptedPayload } = decodeNoteData(encoded);

            expect(ephemeralPubKey).toBe(MOCK_EPHEMERAL_PUB_KEY);
            expect(encryptedPayload).toBe("0xaa");
        });

        it("throw on data shorter than 32 bytes", () => {
            const tooShort = ("0x" + "ab".repeat(20)) as Hex;

            expect(() => decodeNoteData(tooShort)).toThrow(/too short/);
        });
    });

    describe("encodeNoteData", () => {
        it("concatenate pubkey and payload into a single hex string", () => {
            const result = encodeNoteData(MOCK_EPHEMERAL_PUB_KEY, MOCK_ENCRYPTED_PAYLOAD);

            const expected =
                "0x" + MOCK_EPHEMERAL_PUB_KEY.slice(2) + MOCK_ENCRYPTED_PAYLOAD.slice(2);
            expect(result).toBe(expected);
        });

        it("round-trip encode then decode produces original values", () => {
            const encoded = encodeNoteData(MOCK_EPHEMERAL_PUB_KEY, MOCK_ENCRYPTED_PAYLOAD);
            const decoded = decodeNoteData(encoded);

            expect(decoded.ephemeralPubKey).toBe(MOCK_EPHEMERAL_PUB_KEY);
            expect(decoded.encryptedPayload).toBe(MOCK_ENCRYPTED_PAYLOAD);
        });
    });
});
