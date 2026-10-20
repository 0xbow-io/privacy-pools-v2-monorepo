import { beforeEach, describe, expect, it } from "vitest";

import { Hex, InvalidPrivateKey, InvalidPublicKey, Secret, StellarCryptoService } from "../../src/internal.js";

describe("StellarCryptoService", () => {
    let service: StellarCryptoService;

    beforeEach(() => {
        service = new StellarCryptoService();
    });

    describe("ecdh", () => {
        // Stellar's viewing-key curve is X25519 (same as EVM) — see StellarPublicKeySchema's
        // doc comment for why this reverted from an earlier secp256k1 choice: the on-chain
        // `viewing_key` field is BytesN<32>, not 33 bytes, and is pure off-chain storage with
        // no on-chain cryptographic use, so there was no reason tying it to secp256k1.
        describe("known test vector (RFC 7748 §6.1 Alice/Bob)", () => {
            it("compute the correct shared secret for the Alice/Bob test vector", () => {
                const alicePriv =
                    "0x77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a" as Secret;
                const bobPub = "0xde9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
                const expectedShared =
                    "0x4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

                expect(service.ecdh(alicePriv, bobPub)).toBe(expectedShared);
            });
        });

        describe("error cases", () => {
            it("throw InvalidPrivateKey when private key is not 32 bytes", () => {
                expect(() => service.ecdh(("0x" + "aa".repeat(31)) as Secret, "0x00")).toThrow(
                    InvalidPrivateKey,
                );
            });

            it("throw InvalidPublicKey when public key is not 32 bytes", () => {
                const priv = ("0x" + "11".repeat(32)) as Secret;
                expect(() => service.ecdh(priv, ("0x" + "aa".repeat(33)) as Hex)).toThrow(
                    InvalidPublicKey,
                );
            });

            it("throw InvalidPublicKey for the all-zero public key", () => {
                const priv = ("0x" + "11".repeat(32)) as Secret;
                expect(() => service.ecdh(priv, ("0x" + "00".repeat(32)) as Hex)).toThrow(
                    InvalidPublicKey,
                );
            });

        });
    });

    describe("generateEphemeralKeyPair", () => {
        it("return a 32-byte private key and a 32-byte public key", () => {
            const { privateKey, publicKey } = service.generateEphemeralKeyPair();
            expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
            expect(publicKey).toMatch(/^0x[0-9a-f]{64}$/);
        });

        it("return a public key consistent with the private key (ECDH round-trip)", () => {
            const ephemeral = service.generateEphemeralKeyPair();
            const other = service.generateEphemeralKeyPair();

            const sharedFromEphemeral = service.ecdh(ephemeral.privateKey, other.publicKey);
            const sharedFromOther = service.ecdh(other.privateKey, ephemeral.publicKey);
            expect(sharedFromEphemeral).toBe(sharedFromOther);
        });

        it("return different keypairs on repeated calls", () => {
            const a = service.generateEphemeralKeyPair();
            const b = service.generateEphemeralKeyPair();
            expect(a.privateKey).not.toBe(b.privateKey);
        });
    });

    describe("stellarAddressToField", () => {
        it("match the on-chain address_to_field computation for a known StrKey address", () => {
            // Ground truth computed directly against the reference implementation's own
            // sdk/src/crypto.mjs addressToField() for this exact address.
            const field = service.stellarAddressToField(
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            );
            expect(BigInt(field)).toBe(
                2546882737937671087797865303492133949014456605657702609113996756825541318677n,
            );
        });

        it("return a value reduced below the BN254 scalar field modulus", () => {
            const field = service.stellarAddressToField(
                "GCKFBEIYTKP74Q7WQL5D7Y5FYCM6PFMTM3JOKGKQXXTVJNW2WKQ5MKJH",
            );
            const modulus =
                21888242871839275222246405745257275088548364400416034343698204186575808495617n;
            expect(BigInt(field)).toBeLessThan(modulus);
        });

        it("return different field elements for different addresses", () => {
            const a = service.stellarAddressToField(
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            );
            const b = service.stellarAddressToField(
                "GCKFBEIYTKP74Q7WQL5D7Y5FYCM6PFMTM3JOKGKQXXTVJNW2WKQ5MKJH",
            );
            expect(a).not.toBe(b);
        });
    });
});
