import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, hexToBytes, managedNonce } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { beforeEach, describe, expect, it } from "vitest";

import {
    Address,
    BN254_SCALAR_MODULUS,
    CryptoService,
    Hex,
    InvalidCipherText,
    InvalidPrivateKey,
    InvalidPublicKey,
    InvalidSecret,
    Secret,
} from "../../src/internal.js";

// XOR every byte in a hex substring with 0xff. Guarantees the bytes change,
// so tamper-detection tests can't accidentally pass an unchanged ciphertext
// when the original bytes happen to equal the replacement.
function flipHexBytes(hex: string): string {
    let out = "";
    for (let i = 0; i < hex.length; i += 2) {
        const byte = parseInt(hex.slice(i, i + 2), 16);
        out += (byte ^ 0xff).toString(16).padStart(2, "0");
    }
    return out;
}

describe("CryptoService", () => {
    let service: CryptoService;

    beforeEach(() => {
        service = new CryptoService();
    });

    describe("ecdh", () => {
        describe("known test vectors (RFC 7748 §6.1)", () => {
            it("compute correct shared secret for Alice/Bob test vector", () => {
                const alicePriv =
                    "0x77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a" as Secret;
                const bobPub = "0xde9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
                const expectedShared =
                    "0x4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

                const sharedSecret = service.ecdh(alicePriv, bobPub);
                expect(sharedSecret).toBe(expectedShared);
            });

            it("compute correct shared secret in the reverse direction", () => {
                const bobPriv =
                    "0x5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb" as Secret;
                const alicePub =
                    "0x8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
                const expectedShared =
                    "0x4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

                const sharedSecret = service.ecdh(bobPriv, alicePub);
                expect(sharedSecret).toBe(expectedShared);
            });
        });

        describe("round-trip property (symmetric ECDH)", () => {
            it("produce identical shared secrets when computed from both sides", () => {
                const alicePriv = x25519.utils.randomSecretKey();
                const alicePub = x25519.getPublicKey(alicePriv);
                const bobPriv = x25519.utils.randomSecretKey();
                const bobPub = x25519.getPublicKey(bobPriv);

                const aliceShared = service.ecdh(
                    ("0x" + bytesToHex(alicePriv)) as Secret,
                    "0x" + bytesToHex(bobPub),
                );
                const bobShared = service.ecdh(
                    ("0x" + bytesToHex(bobPriv)) as Secret,
                    "0x" + bytesToHex(alicePub),
                );

                expect(aliceShared).toBe(bobShared);
            });

            it("produce different shared secrets for different keypairs", () => {
                const alice1Priv = x25519.utils.randomSecretKey();
                const alice2Priv = x25519.utils.randomSecretKey();
                const bobPub = x25519.getPublicKey(x25519.utils.randomSecretKey());

                const secret1 = service.ecdh(
                    ("0x" + bytesToHex(alice1Priv)) as Secret,
                    "0x" + bytesToHex(bobPub),
                );
                const secret2 = service.ecdh(
                    ("0x" + bytesToHex(alice2Priv)) as Secret,
                    "0x" + bytesToHex(bobPub),
                );

                expect(secret1).not.toBe(secret2);
            });
        });

        describe("output format", () => {
            it("return Secret with 0x prefix", () => {
                const privKey = x25519.utils.randomSecretKey();
                const pubKey = x25519.getPublicKey(x25519.utils.randomSecretKey());

                const secret = service.ecdh(
                    ("0x" + bytesToHex(privKey)) as Secret,
                    "0x" + bytesToHex(pubKey),
                );

                expect(secret.startsWith("0x")).toBe(true);
            });

            it("return exactly 64 hex characters (32 bytes) after 0x", () => {
                const privKey = x25519.utils.randomSecretKey();
                const pubKey = x25519.getPublicKey(x25519.utils.randomSecretKey());

                const secret = service.ecdh(
                    ("0x" + bytesToHex(privKey)) as Secret,
                    "0x" + bytesToHex(pubKey),
                );

                expect(secret.length).toBe(66); // 0x + 64 hex chars
                expect(secret.slice(2)).toMatch(/^[0-9a-f]{64}$/);
            });

            it("return same shared secret on repeated calls with same inputs (deterministic)", () => {
                const privKey = ("0x" + bytesToHex(x25519.utils.randomSecretKey())) as Secret;
                const pubKey =
                    "0x" + bytesToHex(x25519.getPublicKey(x25519.utils.randomSecretKey()));

                const secret1 = service.ecdh(privKey, pubKey);
                const secret2 = service.ecdh(privKey, pubKey);
                const secret3 = service.ecdh(privKey, pubKey);

                expect(secret1).toBe(secret2);
                expect(secret2).toBe(secret3);
            });
        });

        describe("error cases - private key", () => {
            const validPubKey = "0x" + "a".repeat(64); // 32 bytes hex

            it("throw InvalidPrivateKey when hex is empty", () => {
                expect(() => service.ecdh("0x" as Secret, validPubKey)).toThrow(InvalidPrivateKey);
            });

            it("throw InvalidPrivateKey when hex contains non-hex chars", () => {
                const badKey = ("0x" + "z".repeat(64)) as Secret;
                expect(() => service.ecdh(badKey, validPubKey)).toThrow(InvalidPrivateKey);
            });

            it("throw InvalidPrivateKey when length is not 32 bytes", () => {
                const shortKey = ("0x" + "aa".repeat(16)) as Secret;
                expect(() => service.ecdh(shortKey, validPubKey)).toThrow(InvalidPrivateKey);
            });
        });

        describe("error cases - public key", () => {
            const validPrivKey = ("0x" + "aa".repeat(32)) as Secret;

            it("throw InvalidPublicKey when hex is empty", () => {
                expect(() => service.ecdh(validPrivKey, "0x")).toThrow(InvalidPublicKey);
            });

            it("throw InvalidPublicKey when hex contains non-hex chars", () => {
                expect(() => service.ecdh(validPrivKey, "0xzzzz" + "a".repeat(60))).toThrow(
                    InvalidPublicKey,
                );
            });

            it("throw InvalidPublicKey when length is not 32 bytes", () => {
                const wrongLength = "0x" + "aa".repeat(20);
                expect(() => service.ecdh(validPrivKey, wrongLength)).toThrow(InvalidPublicKey);
            });

            it("throw InvalidPublicKey when length is 33 bytes (legacy compressed secp format)", () => {
                const compressedSecpFormat = "0x02" + "aa".repeat(32);
                expect(() => service.ecdh(validPrivKey, compressedSecpFormat)).toThrow(
                    InvalidPublicKey,
                );
            });
        });

        describe("integration with encrypt/decrypt", () => {
            it("use ECDH shared secret to encrypt and decrypt data", () => {
                const alicePriv = x25519.utils.randomSecretKey();
                const alicePub = x25519.getPublicKey(alicePriv);
                const bobPriv = x25519.utils.randomSecretKey();
                const bobPub = x25519.getPublicKey(bobPriv);

                const sharedSecret = service.ecdh(
                    ("0x" + bytesToHex(alicePriv)) as Secret,
                    "0x" + bytesToHex(bobPub),
                );

                const plaintext = new TextEncoder().encode("secret note payload");
                const ciphertext = service.encrypt(plaintext, sharedSecret);

                const bobSharedSecret = service.ecdh(
                    ("0x" + bytesToHex(bobPriv)) as Secret,
                    "0x" + bytesToHex(alicePub),
                );

                const decrypted = service.decrypt(ciphertext, bobSharedSecret);

                expect(decrypted).toEqual(plaintext);
            });

            it("produce same encryption result when both parties compute ECDH", () => {
                const alicePriv = x25519.utils.randomSecretKey();
                const alicePub = x25519.getPublicKey(alicePriv);
                const bobPriv = x25519.utils.randomSecretKey();
                const bobPub = x25519.getPublicKey(bobPriv);

                const aliceSecret = service.ecdh(
                    ("0x" + bytesToHex(alicePriv)) as Secret,
                    "0x" + bytesToHex(bobPub),
                );
                const bobSecret = service.ecdh(
                    ("0x" + bytesToHex(bobPriv)) as Secret,
                    "0x" + bytesToHex(alicePub),
                );

                const data = new Uint8Array([1, 2, 3, 4, 5]);

                const aliceCiphertext = service.encrypt(data, aliceSecret);
                const bobCiphertext = service.encrypt(data, bobSecret);

                expect(service.decrypt(aliceCiphertext, bobSecret)).toEqual(data);
                expect(service.decrypt(bobCiphertext, aliceSecret)).toEqual(data);
            });

            it("fail to decrypt when wrong ECDH keypair is used", () => {
                const alicePriv = x25519.utils.randomSecretKey();
                const bobPub = x25519.getPublicKey(x25519.utils.randomSecretKey());
                const charliePub = x25519.getPublicKey(x25519.utils.randomSecretKey());

                const aliceBobSecret = service.ecdh(
                    ("0x" + bytesToHex(alicePriv)) as Secret,
                    "0x" + bytesToHex(bobPub),
                );
                const data = new Uint8Array([1, 2, 3]);
                const ciphertext = service.encrypt(data, aliceBobSecret);

                const aliceCharlieSecret = service.ecdh(
                    ("0x" + bytesToHex(alicePriv)) as Secret,
                    "0x" + bytesToHex(charliePub),
                );

                expect(() => service.decrypt(ciphertext, aliceCharlieSecret)).toThrow();
            });
        });
    });

    describe("associated data", () => {
        const secret =
            "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Secret;
        const otherSecret =
            "0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" as Secret;

        /**
         * The construction that existed before `associatedData` was accepted: XChaCha20-Poly1305
         * under a managed nonce, keyed by SHA-256 of the secret bytes, with no AAD argument.
         * Built here from the primitives rather than from the service, so it cannot change
         * along with the code under test.
         */
        function encryptWithPreviousConstruction(data: Uint8Array, forSecret: Secret): Hex {
            const key = sha256(hexToBytes(forSecret.slice(2))).slice(0, 32);
            return ("0x" + bytesToHex(managedNonce(xchacha20poly1305)(key).encrypt(data))) as Hex;
        }

        // The nonce is random, so equal ciphertexts cannot be compared directly. Byte-level
        // compatibility is shown the way it matters: each construction reads the other's output.
        // Two differing inputs and two differing secrets, so an accidental fixed-value match
        // cannot carry the claim.
        it("omitting associatedData stays byte-compatible with the previous construction", () => {
            const cases: [Uint8Array, Secret][] = [
                [new TextEncoder().encode("first plaintext"), secret],
                [new Uint8Array([0, 1, 2, 3, 250, 251, 252]), otherSecret],
            ];

            for (const [data, forSecret] of cases) {
                const legacy = encryptWithPreviousConstruction(data, forSecret);
                expect(service.decrypt(legacy, forSecret)).toEqual(data);

                const produced = service.encrypt(data, forSecret);
                const key = sha256(hexToBytes(forSecret.slice(2))).slice(0, 32);
                expect(
                    managedNonce(xchacha20poly1305)(key).decrypt(hexToBytes(produced.slice(2))),
                ).toEqual(data);
            }
        });

        it("round-trip with the same associated data", () => {
            const data = new TextEncoder().encode("bound plaintext");
            const aad = new TextEncoder().encode("chain:1|vault:0xabc");
            expect(service.decrypt(service.encrypt(data, secret, aad), secret, aad)).toEqual(data);
        });

        it("refuse to decrypt when the associated data differs", () => {
            // The binding is what makes a ciphertext valid only in the context it was written
            // for: the same secret with different context bytes must not open it.
            const data = new TextEncoder().encode("bound plaintext");
            const aad = new TextEncoder().encode("chain:1|vault:0xabc");
            const ciphertext = service.encrypt(data, secret, aad);

            expect(() =>
                service.decrypt(
                    ciphertext,
                    secret,
                    new TextEncoder().encode("chain:10|vault:0xabc"),
                ),
            ).toThrow();
            expect(() => service.decrypt(ciphertext, secret)).toThrow();
        });

        it("refuse to read an unbound ciphertext as a bound one", () => {
            const data = new TextEncoder().encode("unbound plaintext");
            const ciphertext = service.encrypt(data, secret);
            expect(() =>
                service.decrypt(ciphertext, secret, new TextEncoder().encode("chain:1")),
            ).toThrow();
        });
    });

    describe("encrypt", () => {
        const secret =
            "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;

        it("return a Hex string (0x prefix and valid hex)", () => {
            const data = new TextEncoder().encode("plaintext");
            const ciphertext = service.encrypt(data, secret);
            expect(ciphertext).toMatch(/^0x[0-9a-fA-F]+$/);
        });

        it("encrypt empty data and round-trip with decrypt", () => {
            const data = new Uint8Array(0);
            const ciphertext = service.encrypt(data, secret);
            expect(ciphertext).toMatch(/^0x[0-9a-fA-F]+$/);
            const decrypted = service.decrypt(ciphertext, secret);
            expect(decrypted).toEqual(data);
            expect(decrypted.length).toBe(0);
        });

        it("encrypt single byte and round-trip with decrypt", () => {
            const data = new Uint8Array([0xab]);
            const ciphertext = service.encrypt(data, secret);
            const decrypted = service.decrypt(ciphertext, secret);
            expect(decrypted).toEqual(data);
        });

        it("encrypt larger payload and round-trip with decrypt", () => {
            const data = new TextEncoder().encode(
                "note payload: noteSecret, value, tokenId, label",
            );
            const ciphertext = service.encrypt(data, secret);
            const decrypted = service.decrypt(ciphertext, secret);
            expect(decrypted).toEqual(data);
        });

        it("produce ciphertext that round-trips when encrypting same data twice", () => {
            const data = new Uint8Array([1, 2, 3, 4, 5]);
            const c1 = service.encrypt(data, secret);
            const c2 = service.encrypt(data, secret);
            expect(service.decrypt(c1, secret)).toEqual(data);
            expect(service.decrypt(c2, secret)).toEqual(data);
        });

        it("produce different ciphertext for different plaintext with same secret", () => {
            const a = new Uint8Array([1]);
            const b = new Uint8Array([2]);
            const ca = service.encrypt(a, secret);
            const cb = service.encrypt(b, secret);
            expect(ca).not.toBe(cb);
            expect(service.decrypt(ca, secret)).toEqual(a);
            expect(service.decrypt(cb, secret)).toEqual(b);
        });

        it("produce different ciphertext for same plaintext with different secret", () => {
            const data = new Uint8Array([1, 2, 3]);
            const otherSecret =
                "0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210" as const;
            const c1 = service.encrypt(data, secret);
            const c2 = service.encrypt(data, otherSecret);
            expect(c1).not.toBe(c2);
            expect(service.decrypt(c1, secret)).toEqual(data);
            expect(service.decrypt(c2, otherSecret)).toEqual(data);
        });

        it("fail decryption when wrong secret is used (ciphertext from encrypt)", () => {
            const data = new Uint8Array([1, 2, 3]);
            const ciphertext = service.encrypt(data, secret);
            const wrongSecret =
                "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
            expect(() => service.decrypt(ciphertext, wrongSecret)).toThrow();
        });

        it("encrypt large payload and round-trip (e.g. 64 KiB)", () => {
            const size = 64 * 1024;
            const data = new Uint8Array(size);
            for (let i = 0; i < size; i++) data[i] = i % 256;
            const ciphertext = service.encrypt(data, secret);
            const decrypted = service.decrypt(ciphertext, secret);
            expect(decrypted.length).toBe(size);
            expect(decrypted).toEqual(data);
        });

        it("throw or fail when decrypting altered ciphertext", () => {
            const data = new Uint8Array([1, 2, 3]);
            const ciphertext = service.encrypt(data, secret);
            const altered = (ciphertext.slice(0, -2) + "ff") as typeof ciphertext;
            expect(() => service.decrypt(altered, secret)).toThrow();
        });

        it("throw InvalidSecret when secret is missing 0x prefix", () => {
            const data = new Uint8Array([1]);
            expect(() => service.encrypt(data, "0123456789abcdef" as Hex)).toThrow(InvalidSecret);
        });

        it("throw InvalidSecret when secret is empty (only 0x)", () => {
            const data = new Uint8Array([1]);
            expect(() => service.encrypt(data, "0x" as const)).toThrow(InvalidSecret);
        });
    });

    describe("generateSecret", () => {
        it("return a valid Secret (0x prefix + 64 hex chars)", () => {
            const secret = service.generateSecret();
            expect(secret).toMatch(/^0x[0-9a-f]{64}$/);
        });

        it("return 32-byte secret (66 chars including 0x)", () => {
            const secret = service.generateSecret();
            expect(secret.length).toBe(66); // "0x" + 64 hex chars
        });

        it("generate different secrets on each call (randomness)", () => {
            const secret1 = service.generateSecret();
            const secret2 = service.generateSecret();
            const secret3 = service.generateSecret();

            expect(secret1).not.toBe(secret2);
            expect(secret2).not.toBe(secret3);
            expect(secret1).not.toBe(secret3);
        });

        it("generate secrets that are valid for encryption", () => {
            const secret = service.generateSecret();
            const data = new TextEncoder().encode("test data");

            const ciphertext = service.encrypt(data, secret);
            const decrypted = service.decrypt(ciphertext, secret);

            expect(decrypted).toEqual(data);
        });

        it("generate secrets that are valid for ECDH", () => {
            const secret = service.generateSecret();
            const bobPriv = x25519.utils.randomSecretKey();
            const bobPub = x25519.getPublicKey(bobPriv);

            const sharedSecret = service.ecdh(secret, "0x" + bytesToHex(bobPub));
            expect(sharedSecret).toMatch(/^0x[0-9a-f]{64}$/);
        });

        it("generate cryptographically random secrets (no patterns)", () => {
            const secrets = Array.from({ length: 100 }, () => service.generateSecret());

            const uniqueSecrets = new Set(secrets);
            expect(uniqueSecrets.size).toBe(100);

            const allZeros = "0x" + "0".repeat(64);
            expect(secrets).not.toContain(allZeros);
        });

        it("generate values in the BN254 scalar field", () => {
            for (let i = 0; i < 200; i++) {
                const secret = service.generateSecret();
                expect(BigInt(secret)).toBeLessThan(BN254_SCALAR_MODULUS);
            }
        });
    });

    describe("decrypt", () => {
        const secret =
            "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;

        it("return Uint8Array when given valid ciphertext and matching secret", () => {
            const data = new Uint8Array([1, 2, 3]);
            const ciphertext = service.encrypt(data, secret);
            const decrypted = service.decrypt(ciphertext, secret);
            expect(decrypted).toBeInstanceOf(Uint8Array);
            expect(decrypted).toEqual(data);
        });

        it("decrypt to original plaintext for various payload sizes", () => {
            const cases = [
                new Uint8Array(0),
                new Uint8Array([0]),
                new Uint8Array([0xff, 0x00, 0xab]),
                new TextEncoder().encode("note payload"),
            ];
            for (const data of cases) {
                const ciphertext = service.encrypt(data, secret);
                expect(service.decrypt(ciphertext, secret)).toEqual(data);
            }
        });

        it("throw when secret is wrong", () => {
            const data = new Uint8Array([1, 2, 3]);
            const ciphertext = service.encrypt(data, secret);
            const wrongSecret =
                "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as const;
            expect(() => service.decrypt(ciphertext, wrongSecret)).toThrow();
        });

        it("throw when ciphertext is tampered (last bytes changed)", () => {
            const ciphertext = service.encrypt(new Uint8Array([1, 2, 3]), secret);
            const tampered = (ciphertext.slice(0, -4) +
                flipHexBytes(ciphertext.slice(-4))) as typeof ciphertext;
            expect(() => service.decrypt(tampered, secret)).toThrow();
        });

        it("throw when ciphertext is tampered (middle bytes changed)", () => {
            const ciphertext = service.encrypt(new Uint8Array([1, 2, 3, 4, 5]), secret);
            const mid = Math.floor(ciphertext.length / 2) & ~1;
            const tampered = (ciphertext.slice(0, mid) +
                flipHexBytes(ciphertext.slice(mid, mid + 2)) +
                ciphertext.slice(mid + 2)) as typeof ciphertext;
            expect(() => service.decrypt(tampered, secret)).toThrow();
        });

        it("throw when ciphertext is random hex (not produced by encrypt)", () => {
            const randomHex = ("0x" + "ab".repeat(64)) as Hex;
            expect(() => service.decrypt(randomHex, secret)).toThrow();
        });

        it("throw InvalidCipherText when ciphertext is empty hex", () => {
            const emptyHex: Hex = "0x";
            expect(() => service.decrypt(emptyHex, secret)).toThrow(InvalidCipherText);
        });

        it("throw when ciphertext contains non-hex characters", () => {
            const badHex: Hex =
                "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefzz";
            expect(() => service.decrypt(badHex, secret)).toThrow();
        });

        it("throw InvalidCipherText when ciphertext is too short to be valid (e.g. missing nonce or tag)", () => {
            const tooShort: Hex = "0x1234";
            expect(() => service.decrypt(tooShort, secret)).toThrow(InvalidCipherText);
        });

        it("throw InvalidSecret when secret is missing 0x prefix", () => {
            const data = new Uint8Array([1, 2, 3]);
            const ciphertext = service.encrypt(data, secret);
            expect(() => service.decrypt(ciphertext, "0123456789abcdef" as Hex)).toThrow(
                InvalidSecret,
            );
        });
    });

    describe("derivePaymentRequestKeyPair", () => {
        const VIEWING_PRIV =
            "0x4444444444444444444444444444444444444444444444444444444444444444" as Secret;
        const OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
        const PAYMENT_ID =
            "0xaaaa000000000000000000000000000000000000000000000000000000000001" as Hex;

        it("produce a deterministic key pair for the same (viewingPriv, owner, paymentId) triple", () => {
            const first = service.derivePaymentRequestKeyPair(VIEWING_PRIV, OWNER, PAYMENT_ID);
            const second = service.derivePaymentRequestKeyPair(VIEWING_PRIV, OWNER, PAYMENT_ID);
            expect(first.privateKey).toBe(second.privateKey);
            expect(first.publicKey).toBe(second.publicKey);
        });

        it("produce a different key when the paymentId changes", () => {
            const a = service.derivePaymentRequestKeyPair(VIEWING_PRIV, OWNER, PAYMENT_ID);
            const otherId =
                "0xaaaa000000000000000000000000000000000000000000000000000000000002" as Hex;
            const b = service.derivePaymentRequestKeyPair(VIEWING_PRIV, OWNER, otherId);
            expect(a.privateKey).not.toBe(b.privateKey);
        });

        it("produce a different key when the ownerAddress changes", () => {
            const a = service.derivePaymentRequestKeyPair(VIEWING_PRIV, OWNER, PAYMENT_ID);
            const otherOwner = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address;
            const b = service.derivePaymentRequestKeyPair(VIEWING_PRIV, otherOwner, PAYMENT_ID);
            expect(a.privateKey).not.toBe(b.privateKey);
        });

        it("ECDH round-trip with the derived key matches the underlying X25519 contract", () => {
            const derived = service.derivePaymentRequestKeyPair(VIEWING_PRIV, OWNER, PAYMENT_ID);
            const counterparty = service.generateEphemeralKeyPair();
            const sharedA = service.ecdh(derived.privateKey, counterparty.publicKey);
            const sharedB = service.ecdh(counterparty.privateKey, derived.publicKey);
            expect(sharedA).toBe(sharedB);
        });

        it("throw InvalidPrivateKey when viewing key has wrong length", () => {
            expect(() =>
                service.derivePaymentRequestKeyPair("0xdead" as Secret, OWNER, PAYMENT_ID),
            ).toThrow();
        });

        it("throw InvalidAddress when owner is malformed", () => {
            expect(() =>
                service.derivePaymentRequestKeyPair(
                    VIEWING_PRIV,
                    "not-an-address" as Address,
                    PAYMENT_ID,
                ),
            ).toThrow();
        });
    });
});
