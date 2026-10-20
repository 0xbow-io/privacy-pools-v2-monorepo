import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import type {
    Address,
    ASPCipherTextPayload,
    DerivedKeyMaterial,
    Hex,
    KeyPair,
    PublicKey,
    Secret,
} from "../../../src/internal.js";
import {
    AbstractCryptoService,
    decodeASPCipherText,
    encodeASPCipherText,
    InvalidASPCipherText,
} from "../../../src/internal.js";

/**
 * Minimal X25519 `ICryptoService` fixture for these tests — ASPUtils's encode/decode only
 * need `ecdh`/`generateEphemeralKeyPair` (for the ephemeral-ECDH scheme) and `encrypt`/`decrypt`
 * (inherited concrete from `AbstractCryptoService`). Mirrors the same `@noble/curves` X25519
 * calls the real `CryptoService`/`StellarCryptoService` implementations use — that part of the
 * scheme is chain-agnostic; only signature-based key derivation (not exercised here) varies.
 */
class TestCryptoService extends AbstractCryptoService {
    ecdh(privateKey: Secret, publicKey: string): Secret {
        const shared = x25519.getSharedSecret(
            hexToBytes(privateKey.slice(2)),
            hexToBytes(publicKey.slice(2)),
        );
        return ("0x" + bytesToHex(shared)) as Secret;
    }

    generateEphemeralKeyPair(): KeyPair {
        const { publicKey, secretKey } = x25519.keygen();
        return {
            privateKey: ("0x" + bytesToHex(secretKey)) as Secret,
            publicKey: ("0x" + bytesToHex(publicKey)) as Hex,
        };
    }

    deriveKeysFromSignature(): DerivedKeyMaterial {
        throw new Error("not exercised by ASPUtils tests");
    }

    protected keyPairFromBytes(): KeyPair {
        throw new Error("not exercised by ASPUtils tests");
    }
}

describe("ASPUtils", () => {
    const crypto = new TestCryptoService();
    const aspKeyPair = crypto.generateEphemeralKeyPair();
    const aspPublicKey = aspKeyPair.publicKey;
    const aspPrivateKey = aspKeyPair.privateKey;

    const payload: ASPCipherTextPayload = {
        noteAddressHash:
            "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
        tokenId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address,
        value: "0x64" as Hex,
        depositSecret: "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex,
        metadata: "0x0" as Hex,
    };

    describe("encodeASPCipherText", () => {
        it("prefix the ciphertext with a fresh ephemeral pubkey, not the depositor's long-term viewing key", () => {
            const a = encodeASPCipherText(payload, { aspPublicKey }, { cryptoService: crypto });
            const b = encodeASPCipherText(payload, { aspPublicKey }, { cryptoService: crypto });

            const prefixA = a.slice(0, 66);
            const prefixB = b.slice(0, 66);

            expect(prefixA).not.toBe(prefixB);
        });

        it("produce a 32-byte prefix followed by the encrypted payload", () => {
            const result = encodeASPCipherText(payload, { aspPublicKey }, { cryptoService: crypto });

            expect(result.startsWith("0x")).toBe(true);
            expect(result.slice(2).length).toBeGreaterThan(64);
        });
    });

    describe("round-trip", () => {
        it("round-trip via ASP private key recovers the original payload", () => {
            const ciphertext = encodeASPCipherText(payload, { aspPublicKey }, { cryptoService: crypto });
            const decoded = decodeASPCipherText(ciphertext, { aspPrivateKey }, { cryptoService: crypto });

            expect(decoded).toEqual(payload);
        });

        it("decode fails when the ASP private key does not match", () => {
            const wrongAspKey = crypto.generateEphemeralKeyPair().privateKey as Secret;
            const ciphertext = encodeASPCipherText(payload, { aspPublicKey }, { cryptoService: crypto });

            expect(() =>
                decodeASPCipherText(
                    ciphertext,
                    { aspPrivateKey: wrongAspKey },
                    { cryptoService: crypto },
                ),
            ).toThrow();
        });

        it("two ciphertexts of the same payload decode to the same plaintext under different ephemeral prefixes", () => {
            const a = encodeASPCipherText(payload, { aspPublicKey }, { cryptoService: crypto });
            const b = encodeASPCipherText(payload, { aspPublicKey }, { cryptoService: crypto });

            expect(a).not.toBe(b);
            expect(decodeASPCipherText(a, { aspPrivateKey }, { cryptoService: crypto })).toEqual(payload);
            expect(decodeASPCipherText(b, { aspPrivateKey }, { cryptoService: crypto })).toEqual(payload);
        });
    });

    describe("public key isolation", () => {
        it("the ciphertext prefix is not equal to any well-known recipient long-term key", () => {
            const longTermViewingPub =
                "0x0000000000000000000000000000000000000000000000000000000000000001" as PublicKey;

            const result = encodeASPCipherText(payload, { aspPublicKey }, { cryptoService: crypto });
            const prefix = result.slice(0, 66);

            expect(prefix).not.toBe(longTermViewingPub);
            expect(prefix).not.toBe(aspPublicKey);
        });
    });

    describe("decodeASPCipherText validation", () => {
        it("throw InvalidASPCipherText when decrypt-succeeds-but-bytes-are-garbage", () => {
            const fakeCiphertext = forgeGarbagePayload(
                crypto,
                aspPublicKey,
                aspPrivateKey,
                '{"unexpected":"shape"}',
            );

            expect(() =>
                decodeASPCipherText(fakeCiphertext, { aspPrivateKey }, { cryptoService: crypto }),
            ).toThrow(InvalidASPCipherText);
        });

        it("throw InvalidASPCipherText when post-decrypt payload is missing required fields", () => {
            const fakeCiphertext = forgeGarbagePayload(
                crypto,
                aspPublicKey,
                aspPrivateKey,
                JSON.stringify({ noteAddressHash: payload.noteAddressHash }),
            );

            expect(() =>
                decodeASPCipherText(fakeCiphertext, { aspPrivateKey }, { cryptoService: crypto }),
            ).toThrow(InvalidASPCipherText);
        });

        it("throw InvalidASPCipherText when post-decrypt JSON is malformed", () => {
            const fakeCiphertext = forgeGarbagePayload(
                crypto,
                aspPublicKey,
                aspPrivateKey,
                "{not valid json",
            );

            expect(() =>
                decodeASPCipherText(fakeCiphertext, { aspPrivateKey }, { cryptoService: crypto }),
            ).toThrow(InvalidASPCipherText);
        });
    });
});

function forgeGarbagePayload(
    crypto: TestCryptoService,
    aspPublicKey: PublicKey,
    _aspPrivateKey: Secret,
    plaintextJson: string,
): Hex {
    const ephemeral = crypto.generateEphemeralKeyPair();
    const sharedSecret = crypto.ecdh(ephemeral.privateKey, aspPublicKey);
    const encrypted = crypto.encrypt(new TextEncoder().encode(plaintextJson), sharedSecret);
    return ("0x" + ephemeral.publicKey.slice(2) + encrypted.slice(2)) as Hex;
}
