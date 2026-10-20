import { describe, expect, it } from "vitest";

import { Hex, InvalidSignature, StellarCryptoService } from "../../src/internal.js";

const VALID_SIG = ("0x" + "ab".repeat(64)) as Hex;

describe("StellarCryptoService — key derivation", () => {
    const service = new StellarCryptoService();

    describe("deriveKeysFromSignature", () => {
        describe("determinism", () => {
            it("return identical keys on repeated calls with the same (signature, appIdentifier)", () => {
                const result1 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x0" as Hex,
                });
                const result2 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(result1.privateNullifyingKey).toBe(result2.privateNullifyingKey);
                expect(result1.privateRevocableKey).toBe(result2.privateRevocableKey);
                expect(result1.viewingPrivateKey).toBe(result2.viewingPrivateKey);
                expect(result1.viewingPublicKey).toBe(result2.viewingPublicKey);
            });

            it("return different keys for different signatures with the same appIdentifier", () => {
                const sig2 = ("0x" + "cd".repeat(64)) as Hex;
                const r1 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x0" as Hex,
                });
                const r2 = service.deriveKeysFromSignature({
                    signature: sig2,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(r1.privateNullifyingKey).not.toBe(r2.privateNullifyingKey);
            });

            it("return different keys for different appIdentifiers with the same signature", () => {
                const r1 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app-a",
                    revocableKeyIndex: "0x0" as Hex,
                });
                const r2 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app-b",
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(r1.privateNullifyingKey).not.toBe(r2.privateNullifyingKey);
            });

            it("accept an empty appIdentifier", () => {
                const r = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "",
                    revocableKeyIndex: "0x0" as Hex,
                });
                expect(r.privateNullifyingKey).toMatch(/^0x[0-9a-f]{64}$/);
            });

            it("return three distinct keys from the same input", () => {
                const r = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(r.privateNullifyingKey).not.toBe(r.privateRevocableKey);
                expect(r.privateNullifyingKey).not.toBe(r.viewingPrivateKey);
                expect(r.privateRevocableKey).not.toBe(r.viewingPrivateKey);
            });

            it("return a different privateRevocableKey for each distinct revocableKeyIndex", () => {
                const r0 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x0" as Hex,
                });
                const r1 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x1" as Hex,
                });
                const rMax = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0xffffffffffffffff" as Hex,
                });

                expect(r0.privateRevocableKey).not.toBe(r1.privateRevocableKey);
                expect(r0.privateRevocableKey).not.toBe(rMax.privateRevocableKey);
                expect(r1.privateRevocableKey).not.toBe(rMax.privateRevocableKey);
            });

            it("leave nullifyingKey and viewingKey unchanged across different revocableKeyIndex values", () => {
                const r0 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x0" as Hex,
                });
                const r1 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x1" as Hex,
                });

                expect(r0.privateNullifyingKey).toBe(r1.privateNullifyingKey);
                expect(r0.viewingPrivateKey).toBe(r1.viewingPrivateKey);
                expect(r0.viewingPublicKey).toBe(r1.viewingPublicKey);
            });
        });

        describe("output format", () => {
            it("return all private keys as 0x-prefixed 64-hex-char secrets", () => {
                const r = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x0" as Hex,
                });
                const hexPattern = /^0x[0-9a-f]{64}$/;

                expect(r.privateNullifyingKey).toMatch(hexPattern);
                expect(r.privateRevocableKey).toMatch(hexPattern);
                expect(r.viewingPrivateKey).toMatch(hexPattern);
            });

            it("return viewingPublicKey as a 0x-prefixed 32-byte X25519 key", () => {
                const r = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(r.viewingPublicKey).toMatch(/^0x[0-9a-f]{64}$/);
            });

            it("derive a viewingPublicKey consistent with viewingPrivateKey (ECDH round-trip)", () => {
                const r = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    appIdentifier: "app",
                    revocableKeyIndex: "0x0" as Hex,
                });
                const ephemeral = service.generateEphemeralKeyPair();

                const sharedA = service.ecdh(r.viewingPrivateKey, ephemeral.publicKey);
                const sharedB = service.ecdh(ephemeral.privateKey, r.viewingPublicKey);
                expect(sharedA).toBe(sharedB);
            });
        });

        describe("error cases", () => {
            it("throw InvalidSignature when signature is 63 bytes (too short by 1)", () => {
                expect(() =>
                    service.deriveKeysFromSignature({
                        signature: ("0x" + "aa".repeat(63)) as Hex,
                        appIdentifier: "app",
                        revocableKeyIndex: "0x0" as Hex,
                    }),
                ).toThrow(InvalidSignature);
            });

            it("throw InvalidSignature when signature is 65 bytes (too long by 1)", () => {
                expect(() =>
                    service.deriveKeysFromSignature({
                        signature: ("0x" + "aa".repeat(65)) as Hex,
                        appIdentifier: "app",
                        revocableKeyIndex: "0x0" as Hex,
                    }),
                ).toThrow(InvalidSignature);
            });

            it("throw InvalidSignature when missing 0x prefix", () => {
                expect(() =>
                    service.deriveKeysFromSignature({
                        signature: "ab".repeat(64) as Hex,
                        appIdentifier: "app",
                        revocableKeyIndex: "0x0" as Hex,
                    }),
                ).toThrow(InvalidSignature);
            });
        });
    });
});
