import { keccak256, toBytes } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
    Address,
    CryptoService,
    Hex,
    ICryptoService,
    InvalidAddress,
    InvalidKeystoreManagerConfig,
    InvalidSignature,
    KeystoreManager,
} from "../../src/internal.js";

const VALID_SIG = ("0x" + "ab".repeat(64) + "1b") as Hex;
const VALID_ADDR = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF" as Address;
const VALID_ADDRESS_HASH = keccak256(toBytes(VALID_ADDR));
const cryptoService = new CryptoService();
const dependencies = { cryptoService };

describe("KeystoreManager — static derivation factories", () => {
    describe("fromSignature", () => {
        describe("creates a valid instance", () => {
            it("return a KeystoreManager whose keys match CryptoService.deriveKeysFromSignature", () => {
                const km = KeystoreManager.fromSignature(
                    {
                        signature: VALID_SIG,
                        signerAddress: VALID_ADDR,
                        addressHash: VALID_ADDRESS_HASH,
                        revocableKeyIndex: "0x0" as Hex,
                    },
                    dependencies,
                );
                const derived = new CryptoService().deriveKeysFromSignature({
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                });

                expect(km.getPrivateNullifyingKey()).toBe(derived.privateNullifyingKey);
                expect(km.getPrivateRevocableKey()).toBe(derived.privateRevocableKey);
                expect(km.getViewingKeyPair().privateKey).toBe(derived.viewingPrivateKey);
                expect(km.getViewingKeyPair().publicKey).toBe(derived.viewingPublicKey);
            });

            it("return the same instance data on repeated calls with the same input", () => {
                const km1 = KeystoreManager.fromSignature(
                    {
                        signature: VALID_SIG,
                        signerAddress: VALID_ADDR,
                        addressHash: VALID_ADDRESS_HASH,
                        revocableKeyIndex: "0x0" as Hex,
                    },
                    dependencies,
                );
                const km2 = KeystoreManager.fromSignature(
                    {
                        signature: VALID_SIG,
                        signerAddress: VALID_ADDR,
                        addressHash: VALID_ADDRESS_HASH,
                        revocableKeyIndex: "0x0" as Hex,
                    },
                    dependencies,
                );

                expect(km1.getPrivateNullifyingKey()).toBe(km2.getPrivateNullifyingKey());
                expect(km1.getViewingKeyPair().publicKey).toBe(km2.getViewingKeyPair().publicKey);
            });
        });

        describe("error cases", () => {
            it("throw InvalidSignature for a 64-byte signature", () => {
                expect(() =>
                    KeystoreManager.fromSignature(
                        {
                            signature: ("0x" + "aa".repeat(64)) as Hex,
                            signerAddress: VALID_ADDR,
                            addressHash: VALID_ADDRESS_HASH,
                            revocableKeyIndex: "0x0" as Hex,
                        },
                        dependencies,
                    ),
                ).toThrow(InvalidSignature);
            });

            it("throw InvalidSignature for a missing 0x prefix", () => {
                expect(() =>
                    KeystoreManager.fromSignature(
                        {
                            signature: "ab".repeat(65) as Hex,
                            signerAddress: VALID_ADDR,
                            addressHash: VALID_ADDRESS_HASH,
                            revocableKeyIndex: "0x0" as Hex,
                        },
                        dependencies,
                    ),
                ).toThrow(InvalidSignature);
            });

            it("throw InvalidAddress for a 19-byte address", () => {
                expect(() =>
                    KeystoreManager.fromSignature(
                        {
                            signature: VALID_SIG,
                            signerAddress: ("0x" + "aa".repeat(19)) as Address,
                            addressHash: VALID_ADDRESS_HASH,
                            revocableKeyIndex: "0x0" as Hex,
                        },
                        dependencies,
                    ),
                ).toThrow(InvalidAddress);
            });
        });
    });

    describe("cryptoService injection", () => {
        it("use the injected cryptoService instead of the default for fromSignature", () => {
            const real = new CryptoService().deriveKeysFromSignature({
                signature: VALID_SIG,
                signerAddress: VALID_ADDR,
                addressHash: VALID_ADDRESS_HASH,
                revocableKeyIndex: "0x0" as Hex,
            });
            const mockService = {
                deriveKeysFromSignature: vi.fn().mockReturnValue(real),
            } as unknown as ICryptoService;

            KeystoreManager.fromSignature(
                {
                    signature: VALID_SIG,
                    signerAddress: VALID_ADDR,
                    addressHash: VALID_ADDRESS_HASH,
                    revocableKeyIndex: "0x0" as Hex,
                },
                { cryptoService: mockService },
            );

            expect(mockService.deriveKeysFromSignature).toHaveBeenCalledOnce();
            expect(mockService.deriveKeysFromSignature).toHaveBeenCalledWith({
                signature: VALID_SIG,
                signerAddress: VALID_ADDR,
                addressHash: VALID_ADDRESS_HASH,
                revocableKeyIndex: "0x0" as Hex,
            });
        });
    });

    describe("direct constructor", () => {
        it("construct KeystoreManager with pre-derived keys and return them unchanged", () => {
            const derived = new CryptoService().deriveKeysFromSignature({
                signature: VALID_SIG,
                signerAddress: VALID_ADDR,
                addressHash: VALID_ADDRESS_HASH,
                revocableKeyIndex: "0x0" as Hex,
            });
            const km = new KeystoreManager({
                privateNullifyingKey: derived.privateNullifyingKey,
                privateRevocableKey: derived.privateRevocableKey,
                viewingPrivateKey: derived.viewingPrivateKey,
                viewingPublicKey: derived.viewingPublicKey,
                revocableKeyIndex: "0x0" as Hex,
            });

            expect(km.getPrivateNullifyingKey()).toBe(derived.privateNullifyingKey);
            expect(km.getPrivateRevocableKey()).toBe(derived.privateRevocableKey);
        });

        it("throw InvalidKeystoreManagerConfig when constructed with wrong-length keys", () => {
            const shortKey = ("0x" + "aa".repeat(16)) as Hex;
            expect(
                () =>
                    new KeystoreManager({
                        privateNullifyingKey: shortKey,
                        privateRevocableKey: shortKey,
                        viewingPrivateKey: shortKey,
                        viewingPublicKey: shortKey,
                        revocableKeyIndex: "0x0" as Hex,
                    }),
            ).toThrow(InvalidKeystoreManagerConfig);
        });
    });
});
