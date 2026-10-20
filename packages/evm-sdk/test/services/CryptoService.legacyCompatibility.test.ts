import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, hexToBytes, managedNonce } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import type { Secret } from "../../src/internal.js";
import { CryptoService } from "../../src/internal.js";

describe("CryptoService previous construction compatibility", () => {
    it("produce identical bytes without associated data when the nonce is identical", () => {
        const service = new CryptoService();
        const secrets: Secret[] = [
            ("0x" + "01".repeat(32)) as Secret,
            ("0x" + "02".repeat(32)) as Secret,
        ];
        const plaintexts = [
            new Uint8Array(),
            new Uint8Array([0, 1, 2, 255]),
            new TextEncoder().encode("compatibility"),
        ];

        for (const secret of secrets) {
            for (const plaintext of plaintexts) {
                const actual = service.encrypt(plaintext, secret);
                // Reuse the encoded nonce so the comparison covers every output byte
                // without replacing the service's random-number source.
                const nonce = hexToBytes(actual.slice(2)).slice(0, 24);
                const key = sha256(hexToBytes(secret.slice(2))).slice(0, 32);
                const previous = managedNonce(
                    xchacha20poly1305,
                    () => nonce,
                )(key).encrypt(plaintext);

                expect(actual).toBe("0x" + bytesToHex(previous));
            }
        }
    });
});
