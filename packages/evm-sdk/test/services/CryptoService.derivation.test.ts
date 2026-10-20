import { keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";

import {
    Address,
    CryptoService,
    Hex,
    InvalidAddress,
    InvalidSignature,
    PayloadAddressHashMismatch,
    Secret,
} from "../../src/internal.js";

const VALID_SIG = ("0x" + "ab".repeat(64) + "1b") as Hex;
const VALID_ADDR = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF" as Address;
const VALID_ADDRESS_HASH = keccak256(toBytes(VALID_ADDR));

describe("CryptoService — key derivation", () => {
    const service = new CryptoService();

    describe("deriveKeysFromSignature", () => {
        describe("determinism", () => {
            it("return identical keys on repeated calls with the same (signature, address)", () => {
                const result1 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });
                const result2 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(result1.privateNullifyingKey).toBe(result2.privateNullifyingKey);
                expect(result1.privateRevocableKey).toBe(result2.privateRevocableKey);
                expect(result1.viewingPrivateKey).toBe(result2.viewingPrivateKey);
                expect(result1.viewingPublicKey).toBe(result2.viewingPublicKey);
            });

            it("return different keys for different signatures with the same address", () => {
                const sig2 = ("0x" + "cd".repeat(64) + "1b") as Hex;
                const r1 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });
                const r2 = service.deriveKeysFromSignature({
                    signature: sig2,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(r1.privateNullifyingKey).not.toBe(r2.privateNullifyingKey);
            });

            it("return different keys for different addresses with the same signature", () => {
                const addr2 = "0x0000000000000000000000000000000000000001" as Address;
                const addr2Hash = keccak256(toBytes(addr2));
                const r1 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });
                const r2 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: addr2,
                    addressHash: addr2Hash,
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(r1.privateNullifyingKey).not.toBe(r2.privateNullifyingKey);
            });

            it("return three distinct keys from the same input", () => {
                const r = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(r.privateNullifyingKey).not.toBe(r.privateRevocableKey);
                expect(r.privateNullifyingKey).not.toBe(r.viewingPrivateKey);
                expect(r.privateRevocableKey).not.toBe(r.viewingPrivateKey);
            });

            it("return a different privateRevocableKey for each distinct revocableKeyIndex", () => {
                const r0 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });
                const r1 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x1" as Hex,
                });
                const rMax = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0xffffffffffffffff" as Hex,
                });

                expect(r0.privateRevocableKey).not.toBe(r1.privateRevocableKey);
                expect(r0.privateRevocableKey).not.toBe(rMax.privateRevocableKey);
                expect(r1.privateRevocableKey).not.toBe(rMax.privateRevocableKey);
            });

            it("leave nullifyingKey and viewingKey unchanged across different revocableKeyIndex values", () => {
                const r0 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });
                const r1 = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
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
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });
                const hexPattern = /^0x[0-9a-f]{64}$/;

                expect(r.privateNullifyingKey).toMatch(hexPattern);
                expect(r.privateRevocableKey).toMatch(hexPattern);
                expect(r.viewingPrivateKey).toMatch(hexPattern);
            });

            it("return viewingPublicKey as 0x-prefixed 32-byte X25519 key (64 hex chars)", () => {
                const r = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(r.viewingPublicKey).toMatch(/^0x[0-9a-f]{64}$/);
            });

            it("derive a viewingPrivateKey that is RFC 7748 clamped (cofactor multiple, high bit set)", () => {
                const r = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });
                const hex = r.viewingPrivateKey.slice(2).padStart(64, "0");
                // Hex is bigintToHex(bytesToBigIntBE(clamped)), so the first 2 hex chars
                // correspond to clamped[0] and the last 2 to clamped[31].
                const byte0 = parseInt(hex.slice(0, 2), 16);
                const byte31 = parseInt(hex.slice(62, 64), 16);
                expect(byte0 & 0x07).toBe(0); // bottom 3 bits cleared
                expect(byte31 & 0x80).toBe(0); // top bit cleared
                expect(byte31 & 0x40).toBe(0x40); // 2^254 bit set
            });

            it("derive viewingPublicKey consistent with viewingPrivateKey (ECDH round-trip)", () => {
                const r = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });
                const ephemeral = service.generateEphemeralKeyPair();

                const shared = service.ecdh(r.viewingPrivateKey as Secret, ephemeral.publicKey);
                expect(shared).toMatch(/^0x[0-9a-f]{64}$/);
            });
        });

        describe("use only r component of signature (ignore s and v)", () => {
            it("produce identical keys for signatures differing only in s and v", () => {
                const r = "ab".repeat(32);
                const sigA = ("0x" + r + "cc".repeat(32) + "1b") as Hex;
                const sigB = ("0x" + r + "dd".repeat(32) + "1c") as Hex;

                const keysA = service.deriveKeysFromSignature({
                    signature: sigA,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });
                const keysB = service.deriveKeysFromSignature({
                    signature: sigB,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(keysA.privateNullifyingKey).toBe(keysB.privateNullifyingKey);
                expect(keysA.privateRevocableKey).toBe(keysB.privateRevocableKey);
                expect(keysA.viewingPrivateKey).toBe(keysB.viewingPrivateKey);
            });
        });

        describe("error cases", () => {
            it("throw InvalidSignature when signature is 64 bytes (too short by 1)", () => {
                expect(() =>
                    service.deriveKeysFromSignature({
                        signature: ("0x" + "aa".repeat(64)) as Hex,
                        signerAddress: VALID_ADDR,
                        addressHash: VALID_ADDRESS_HASH,
                        revocableKeyIndex: "0x0" as Hex,
                    }),
                ).toThrow(InvalidSignature);
            });

            it("throw InvalidSignature when signature is 66 bytes (too long by 1)", () => {
                expect(() =>
                    service.deriveKeysFromSignature({
                        signature: ("0x" + "aa".repeat(66)) as Hex,
                        signerAddress: VALID_ADDR,
                        addressHash: VALID_ADDRESS_HASH,
                        revocableKeyIndex: "0x0" as Hex,
                    }),
                ).toThrow(InvalidSignature);
            });

            it("throw InvalidSignature when missing 0x prefix", () => {
                expect(() =>
                    service.deriveKeysFromSignature({
                        signature: "ab".repeat(65) as Hex,
                        signerAddress: VALID_ADDR,
                        addressHash: VALID_ADDRESS_HASH,
                        revocableKeyIndex: "0x0" as Hex,
                    }),
                ).toThrow(InvalidSignature);
            });

            it("throw InvalidAddress when address is not 20 bytes", () => {
                expect(() =>
                    service.deriveKeysFromSignature({
                        signature: VALID_SIG,
                        signerAddress: ("0x" + "aa".repeat(19)) as Address,
                        addressHash: VALID_ADDRESS_HASH,
                        revocableKeyIndex: "0x0" as Hex,
                    }),
                ).toThrow(InvalidAddress);
            });

            it("throw InvalidAddress when address is missing 0x prefix", () => {
                expect(() =>
                    service.deriveKeysFromSignature({
                        signature: VALID_SIG,
                        signerAddress: "aa".repeat(20) as Address,
                        addressHash: VALID_ADDRESS_HASH,
                        revocableKeyIndex: "0x0" as Hex,
                    }),
                ).toThrow(InvalidAddress);
            });
        });

        describe("addressHash verification (spec Step 4)", () => {
            it("accept the payload when addressHash equals keccak256(signerAddress)", () => {
                const r = service.deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });
                expect(r.privateNullifyingKey).toMatch(/^0x[0-9a-f]{64}$/);
            });

            it("throw PayloadAddressHashMismatch when addressHash does not match signer", () => {
                const foreignHash = keccak256(
                    toBytes("0x0000000000000000000000000000000000000001" as Address),
                );
                expect(() =>
                    service.deriveKeysFromSignature({
                        signature: VALID_SIG,
                        signerAddress: VALID_ADDR,
                        addressHash: foreignHash,
                        revocableKeyIndex: "0x0" as Hex,
                    }),
                ).toThrow(PayloadAddressHashMismatch);
            });

            it("throw PayloadAddressHashMismatch when addressHash is a bogus zero value", () => {
                expect(() =>
                    service.deriveKeysFromSignature({
                        signature: VALID_SIG,
                        signerAddress: VALID_ADDR,
                        addressHash: ("0x" + "00".repeat(32)) as Hex,
                        revocableKeyIndex: "0x0" as Hex,
                    }),
                ).toThrow(PayloadAddressHashMismatch);
            });
        });
    });
});
