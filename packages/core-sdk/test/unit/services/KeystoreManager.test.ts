import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import {
    AlreadyRegistered,
    Hex,
    InvalidKeystoreManagerConfig,
    InvalidRotationIndex,
    KeystoreManager,
    KeystoreManagerConfig,
    Secret,
} from "../../../src/internal.js";

/** Generates a random 32-byte 0x-prefixed hex string suitable as a Secret. */
function randomSecret(): Secret {
    return ("0x" + bytesToHex(randomBytes(32))) as Secret;
}

/** Derives an X25519 public key from a 32-byte private scalar. */
function derivePublicKey(privateKey: Secret): Secret {
    const bytes = hexToBytes(privateKey.slice(2));
    const pubBytes = x25519.getPublicKey(bytes);
    return ("0x" + bytesToHex(pubBytes)) as Secret;
}

function makeValidConfig(): KeystoreManagerConfig {
    const viewingPrivateKey = randomSecret();
    return {
        privateNullifyingKey: randomSecret(),
        privateRevocableKey: randomSecret(),
        viewingPrivateKey,
        viewingPublicKey: derivePublicKey(viewingPrivateKey),
        revocableKeyIndex: "0x0" as Hex,
    };
}

describe("KeystoreManager", () => {
    describe("config validation", () => {
        it("accept valid config", () => {
            expect(() => new KeystoreManager(makeValidConfig())).not.toThrow();
        });

        it("reject config with missing privateNullifyingKey", () => {
            const { privateNullifyingKey: _, ...rest } = makeValidConfig();

            expect(() => new KeystoreManager(rest as unknown as KeystoreManagerConfig)).toThrow(
                InvalidKeystoreManagerConfig,
            );
        });

        it("reject config with invalid hex for privateRevocableKey", () => {
            const config = makeValidConfig();
            config.privateRevocableKey = "not-hex" as Secret;

            expect(() => new KeystoreManager(config)).toThrow(InvalidKeystoreManagerConfig);
        });

        it("reject config with viewingPublicKey of wrong length (not 32 bytes)", () => {
            const config = makeValidConfig();
            // 33 bytes — legacy compressed-secp format, not a valid X25519 pubkey
            config.viewingPublicKey = ("0x02" + "ab".repeat(32)) as Secret;

            expect(() => new KeystoreManager(config)).toThrow(InvalidKeystoreManagerConfig);
        });

        it("accept a secp256k1 viewingPublicKey when curve is 'secp256k1' (Stellar)", () => {
            const viewingPrivateKey = randomSecret();
            const viewingPublicKey = ("0x" +
                bytesToHex(
                    secp256k1.getPublicKey(hexToBytes(viewingPrivateKey.slice(2)), true),
                )) as Secret;

            expect(
                () =>
                    new KeystoreManager({
                        ...makeValidConfig(),
                        viewingPrivateKey,
                        viewingPublicKey,
                        curve: "secp256k1",
                    }),
            ).not.toThrow();
        });

        it("reject a secp256k1 viewingPublicKey mismatched with viewingPrivateKey", () => {
            const viewingPrivateKey = randomSecret();
            const wrongPublicKey = ("0x" +
                bytesToHex(secp256k1.getPublicKey(hexToBytes(randomSecret().slice(2)), true))) as Secret;

            expect(
                () =>
                    new KeystoreManager({
                        ...makeValidConfig(),
                        viewingPrivateKey,
                        viewingPublicKey: wrongPublicKey,
                        curve: "secp256k1",
                    }),
            ).toThrow(InvalidKeystoreManagerConfig);
        });

        it("reject an x25519 viewingPublicKey when curve is 'secp256k1' (wrong curve for the key)", () => {
            const config = makeValidConfig();

            expect(
                () => new KeystoreManager({ ...config, curve: "secp256k1" }),
            ).toThrow(InvalidKeystoreManagerConfig);
        });
    });

    describe("getters", () => {
        it("return correct privateNullifyingKey", () => {
            const config = makeValidConfig();
            const km = new KeystoreManager(config);

            expect(km.getPrivateNullifyingKey()).toBe(config.privateNullifyingKey);
        });

        it("return correct privateRevocableKey", () => {
            const config = makeValidConfig();
            const km = new KeystoreManager(config);

            expect(km.getPrivateRevocableKey()).toBe(config.privateRevocableKey);
        });

        it("return correct viewing key pair", () => {
            const config = makeValidConfig();
            const km = new KeystoreManager(config);
            const pair = km.getViewingKeyPair();

            expect(pair.privateKey).toBe(config.viewingPrivateKey);
            expect(pair.publicKey).toBe(config.viewingPublicKey);
        });
    });

    describe("applyRotation", () => {
        it("update getPrivateRevocableKey and getRevocableKeyIndex", () => {
            const km = new KeystoreManager(makeValidConfig());
            const newKey = randomSecret();

            km.applyRotation("0x5" as Hex, newKey);

            expect(km.getPrivateRevocableKey()).toBe(newKey);
            expect(BigInt(km.getRevocableKeyIndex())).toBe(5n);
        });

        it("leave privateNullifyingKey and viewingKeyPair unchanged", () => {
            const km = new KeystoreManager(makeValidConfig());
            const originalNullifying = km.getPrivateNullifyingKey();
            const originalViewing = km.getViewingKeyPair();

            km.applyRotation("0x1" as Hex, randomSecret());

            expect(km.getPrivateNullifyingKey()).toBe(originalNullifying);
            expect(km.getViewingKeyPair()).toEqual(originalViewing);
        });

        it("throw InvalidRotationIndex when new index equals current index", () => {
            const km = new KeystoreManager({
                ...makeValidConfig(),
                revocableKeyIndex: "0x2" as Hex,
            });

            expect(() => km.applyRotation("0x2" as Hex, randomSecret())).toThrow(
                InvalidRotationIndex,
            );
        });

        it("throw InvalidRotationIndex when new index is less than current index", () => {
            const km = new KeystoreManager({
                ...makeValidConfig(),
                revocableKeyIndex: "0x3" as Hex,
            });

            expect(() => km.applyRotation("0x1" as Hex, randomSecret())).toThrow(
                InvalidRotationIndex,
            );
        });
    });

    describe("registration tracking", () => {
        it("return false for unregistered chain", () => {
            const km = new KeystoreManager(makeValidConfig());

            expect(km.isRegistered(1)).toBe(false);
        });

        it("return true after markRegistered", () => {
            const km = new KeystoreManager(makeValidConfig());

            km.markRegistered(1);

            expect(km.isRegistered(1)).toBe(true);
        });

        it("track chains independently", () => {
            const km = new KeystoreManager(makeValidConfig());

            km.markRegistered(1);

            expect(km.isRegistered(1)).toBe(true);
            expect(km.isRegistered(42)).toBe(false);
        });

        it("throw AlreadyRegistered on duplicate markRegistered", () => {
            const km = new KeystoreManager(makeValidConfig());
            km.markRegistered(1);

            expect(() => km.markRegistered(1)).toThrow(AlreadyRegistered);
        });
    });
});
