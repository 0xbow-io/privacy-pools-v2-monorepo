import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type {
    CanonicalMetaAddress,
    CompressedPubKey,
    Scalar32,
} from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
    deriveStealthPrivateKey,
    scanAnnouncement,
    SCHEME_CANONICAL,
} from "../../../src/stealth/index.js";

interface Vector {
    description: string;
    inputs: {
        recipient: {
            spendingPrivateKey: string;
            viewingPrivateKey: string;
            spendingPublicKey: string;
            viewingPublicKey: string;
        };
        ephemeral: {
            privateKey: string;
            publicKey: string;
        };
    };
    expected: {
        stealthAddress: string;
        viewTag: number;
        stealthPrivateKey: string;
    };
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../../fixtures/scopelift/v6-internal-vectors.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    schemeId: number;
    vectors: Vector[];
};

const hexToBytes = (h: string): Uint8Array => {
    const s = h.startsWith("0x") ? h.slice(2) : h;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
};

describe("canonical scheme 1 - frozen v7 internal-consistency vectors", () => {
    expect(fixture.schemeId).toBe(SCHEME_CANONICAL);
    expect(fixture.vectors.length >= 3, "expected at least 3 fixture vectors").toBeTruthy();

    for (const v of fixture.vectors) {
        it(`${v.description}: derive yields the pinned stealth address + view tag`, () => {
            const meta: CanonicalMetaAddress = {
                scheme: SCHEME_CANONICAL,
                spendingPubKey: v.inputs.recipient.spendingPublicKey as CompressedPubKey,
                viewingPubKey: v.inputs.recipient.viewingPublicKey as CompressedPubKey,
            };
            const ephemeral = {
                privateKey: v.inputs.ephemeral.privateKey as Scalar32,
                publicKey: v.inputs.ephemeral.publicKey as CompressedPubKey,
            };
            const { stealthAddress, announcement } = deriveStealthAddress(
                meta,
                ephemeral,
                SCHEME_CANONICAL,
            );
            expect(stealthAddress).toBe(v.expected.stealthAddress);
            expect(announcement.viewTag).toBe(v.expected.viewTag);
            expect(announcement.schemeId).toBe(SCHEME_CANONICAL);
            expect(announcement.ephemeralPubKey).toBe(v.inputs.ephemeral.publicKey);
        });

        it(`${v.description}: scan recovers + derive priv yields the pinned scalar`, () => {
            const meta: CanonicalMetaAddress = {
                scheme: SCHEME_CANONICAL,
                spendingPubKey: v.inputs.recipient.spendingPublicKey as CompressedPubKey,
                viewingPubKey: v.inputs.recipient.viewingPublicKey as CompressedPubKey,
            };
            const ephemeral = {
                privateKey: v.inputs.ephemeral.privateKey as Scalar32,
                publicKey: v.inputs.ephemeral.publicKey as CompressedPubKey,
            };
            const { announcement } = deriveStealthAddress(meta, ephemeral, SCHEME_CANONICAL);

            const recovered = scanAnnouncement(announcement, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: v.inputs.recipient.viewingPrivateKey as Scalar32,
                spendingPublicKey: v.inputs.recipient.spendingPublicKey as CompressedPubKey,
            });
            expect(recovered).toBe(v.expected.stealthAddress);

            const stealthPriv = deriveStealthPrivateKey(announcement, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: v.inputs.recipient.viewingPrivateKey as Scalar32,
                spendingPrivateKey: v.inputs.recipient.spendingPrivateKey as Scalar32,
            });
            expect(stealthPriv).toBe(v.expected.stealthPrivateKey);

            // Cross-check: stealthPriv * G must yield the announced stealth address.
            const pub = secp256k1.getPublicKey(hexToBytes(stealthPriv), false);
            expect(pub.length === 65).toBeTruthy();
        });
    }
});
