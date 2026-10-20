import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type {
    EphemeralKeyPair,
    MetaAddress,
    Scalar32,
    UncompressedPubKey,
} from "../../../src/stealth/index.js";
import { deriveStealthAddress, SCHEME_FLUIDKEY } from "../../../src/stealth/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, "../../fixtures/fluidkey/generateStealthAddresses.vectors.json");

interface Vector {
    label: string;
    ephemeralPrivateKey: string;
    spendingFromPrivateKey: string;
    expectedStealthAddress: string;
}
interface VectorsFile {
    source: string;
    vectors: Vector[];
}

const bytesToHex = (bytes: Uint8Array): string => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
};
const hexToBytes = (hex: string): Uint8Array => {
    const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
};

const fixtures = JSON.parse(readFileSync(vectorsPath, "utf8")) as VectorsFile;

describe("DERIV-03: byte-for-byte agreement with @fluidkey/stealth-account-kit", () => {
    for (const v of fixtures.vectors) {
        it(`vector "${v.label}": matches FluidKey reference output`, () => {
            // Re-derive the spending public key (uncompressed) from the published
            // private key, the same way `viem`'s privateKeyToAccount would.
            const spendingPubBytes = secp256k1.getPublicKey(
                hexToBytes(v.spendingFromPrivateKey),
                /* compressed */ false,
            );
            const metaAddress: MetaAddress = {
                scheme: SCHEME_FLUIDKEY,
                spendingPubKey: bytesToHex(spendingPubBytes) as UncompressedPubKey,
            };

            // Re-derive the ephemeral public key from the fixed ephemeral private
            // key so we can pretend it came from `generateEphemeralKeyPair(SCHEME_FLUIDKEY)`.
            const ephPubBytes = secp256k1.getPublicKey(
                hexToBytes(v.ephemeralPrivateKey),
                /* compressed */ false,
            );
            const ephemeral: EphemeralKeyPair = {
                privateKey: v.ephemeralPrivateKey as Scalar32,
                publicKey: bytesToHex(ephPubBytes) as UncompressedPubKey,
            };

            const { stealthAddress } = deriveStealthAddress(
                metaAddress,
                ephemeral,
                SCHEME_FLUIDKEY,
            );

            expect(
                stealthAddress.toLowerCase(),
                `our derivation must match FluidKey for vector "${v.label}". ` +
                    `If this fails, recipients running @fluidkey/stealth-account-kit will not discover our withdrawals.`,
            ).toBe(v.expectedStealthAddress.toLowerCase());
        });
    }
});
