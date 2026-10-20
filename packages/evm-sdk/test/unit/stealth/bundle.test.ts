import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type {
    EvmAddress,
    Hex,
    MetaAddress,
    UncompressedPubKey,
} from "../../../src/stealth/index.js";
import {
    composeWithdrawalBundle,
    deriveStealthAddress,
    generateEphemeralKeyPair,
    SCHEME_FLUIDKEY,
    StealthAddressAnnouncementError,
} from "../../../src/stealth/index.js";

const bytesToHex = (bytes: Uint8Array): string => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
};

const newRecipientMeta = (): MetaAddress => ({
    scheme: SCHEME_FLUIDKEY,
    spendingPubKey: bytesToHex(
        secp256k1.getPublicKey(randomBytes(32), false),
    ) as UncompressedPubKey,
});

const ANNOUNCER = "0x55649e01b5df198d18d95b5cc5051630cfd45564" as EvmAddress;

describe("bundle.ts: composeWithdrawalBundle (STLTH-02, STLTH-03, STLTH-18)", () => {
    it("happy path: destinations match -> returns a (withdraw, announce) bundle", () => {
        const metaAddress = newRecipientMeta();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { stealthAddress, announcement } = deriveStealthAddress(
            metaAddress,
            ephemeral,
            SCHEME_FLUIDKEY,
        );

        const withdraw = {
            to: "0x000000000000000000000000000000000000beef" as EvmAddress,
            data: "0xdeadbeef" as Hex,
            declaredDestination: stealthAddress,
        };

        const bundle = composeWithdrawalBundle(withdraw, announcement, ANNOUNCER);
        expect(bundle.withdraw.to).toBe(withdraw.to);
        expect(bundle.withdraw.data).toBe(withdraw.data);
        expect(bundle.announce.to).toBe(ANNOUNCER);
        expect(bundle.announce.data.startsWith("0x")).toBe(true);
    });

    it("STLTH-18: refuses to compose if declaredDestination != announcement.stealthAddress", () => {
        const metaAddress = newRecipientMeta();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);

        const wrongDestination = {
            to: "0x000000000000000000000000000000000000beef" as EvmAddress,
            data: "0xdeadbeef" as Hex,
            declaredDestination: "0x0000000000000000000000000000000000000001" as EvmAddress,
        };

        expect(
            () => composeWithdrawalBundle(wrongDestination, announcement, ANNOUNCER),
            "mismatched destination must throw",
        ).toThrow(StealthAddressAnnouncementError);
    });

    it("STLTH-18: case-insensitive destination comparison", () => {
        const metaAddress = newRecipientMeta();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { stealthAddress, announcement } = deriveStealthAddress(
            metaAddress,
            ephemeral,
            SCHEME_FLUIDKEY,
        );

        const upperCased = stealthAddress.toUpperCase().replace("0X", "0x") as EvmAddress;
        const withdraw = {
            to: "0x000000000000000000000000000000000000beef" as EvmAddress,
            data: "0x" as Hex,
            declaredDestination: upperCased,
        };

        expect(() => composeWithdrawalBundle(withdraw, announcement, ANNOUNCER)).not.toThrow();
    });
});
