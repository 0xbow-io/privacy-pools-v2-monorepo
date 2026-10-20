import { secp256k1 } from "@noble/curves/secp256k1.js";
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import type { Announcement, EvmAddress, UncompressedPubKey } from "../../../src/stealth/index.js";
import { buildAnnounceCalldata } from "../../../src/stealth/announce.js";
import {
    buildAnnounceCall,
    ERC5564_ANNOUNCE_ABI,
    SCHEME_FLUIDKEY,
} from "../../../src/stealth/index.js";

// Fixed ephemeral private key for a reproducible test pubkey.
const FIXED_EPH_PRIV = new Uint8Array(32).fill(7);
const ephPub = secp256k1.getPublicKey(FIXED_EPH_PRIV, false);
let ephPubHex = "0x";
for (const b of ephPub) ephPubHex += b.toString(16).padStart(2, "0");

const exampleAnnouncement: Announcement = {
    schemeId: SCHEME_FLUIDKEY,
    stealthAddress: "0xf4126489ac2f0df6441d0b72efcc760ef0c19706" as EvmAddress,
    ephemeralPubKey: ephPubHex as UncompressedPubKey,
    viewTag: 0xab,
};

describe("announce.ts (STLTH-02, STLTH-09, STLTH-12)", () => {
    it("buildAnnounceCalldata: round-trips through viem decode", () => {
        const data = buildAnnounceCalldata(exampleAnnouncement);
        expect(data.startsWith("0x")).toBe(true);
        expect(data.length).toBeGreaterThan(10);

        const decoded = decodeFunctionData({
            abi: ERC5564_ANNOUNCE_ABI,
            data: data as `0x${string}`,
        });
        expect(decoded.functionName).toBe("announce");
        const [schemeId, stealthAddress, ephemeralPubKey, metadata] = decoded.args as [
            bigint,
            `0x${string}`,
            `0x${string}`,
            `0x${string}`,
        ];
        expect(schemeId).toBe(BigInt(SCHEME_FLUIDKEY));
        expect(stealthAddress.toLowerCase()).toBe(exampleAnnouncement.stealthAddress);
        expect(ephemeralPubKey.toLowerCase()).toBe(exampleAnnouncement.ephemeralPubKey);
        // STLTH-12: metadata is exactly 1 byte = 0x + 2 hex = 4 chars.
        expect(metadata.length).toBe(4);
        expect(metadata).toBe("0xab");
    });

    it("STLTH-12: viewTag-only metadata, no memo path", () => {
        // The ABI itself only has 4 args (schemeId, stealthAddress, ephemeralPubKey, metadata).
        // There is no `memo` arg. This assertion is structural: any future addition
        // of a memo arg would break the ABI shape we lock here.
        const announceFn = ERC5564_ANNOUNCE_ABI.find((e) => e.name === "announce");
        expect(announceFn).toBeDefined();
        expect(announceFn!.inputs.length).toBe(4);
        expect(announceFn!.inputs.map((i) => i.name)).toEqual([
            "schemeId",
            "stealthAddress",
            "ephemeralPubKey",
            "metadata",
        ]);
    });

    it("buildAnnounceCall: targets the supplied announcer address", () => {
        const announcer = "0x55649e01b5df198d18d95b5cc5051630cfd45564" as EvmAddress;
        const call = buildAnnounceCall(exampleAnnouncement, announcer);
        expect(call.to).toBe(announcer);
        // Same calldata as the direct builder for the same announcement.
        expect(call.data).toBe(buildAnnounceCalldata(exampleAnnouncement));
    });
});
