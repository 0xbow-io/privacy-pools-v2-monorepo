import { describe, expect, it } from "vitest";

import type {
    CanonicalAnnouncement,
    CompressedPubKey,
    DeclaredWithdrawCall,
    EvmAddress,
    Hex,
} from "../../../src/stealth/index.js";
import {
    assertCanonicalAnnouncer,
    buildAnnounceCall,
    CANONICAL_ANNOUNCER_ADDRESS,
    composeWithdrawalBundle,
    SCHEME_CANONICAL,
    StealthAddressAnnouncementError,
} from "../../../src/stealth/index.js";
import * as stealth from "../../../src/stealth/index.js";

describe("STLTH-20: canonical Announcer enforcement", () => {
    const stealthAddress = "0x9c658edec4279006256b69943be8a0f93c7dde54" as EvmAddress;
    const announcement: CanonicalAnnouncement = {
        schemeId: SCHEME_CANONICAL,
        stealthAddress,
        ephemeralPubKey:
            "0x02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9" as CompressedPubKey,
        viewTag: 28,
    };
    const withdraw: DeclaredWithdrawCall = {
        to: "0x0000000000000000000000000000000000000bad" as EvmAddress,
        data: "0xdeadbeef" as Hex,
        declaredDestination: stealthAddress,
    };

    it("NEGATIVE-20: composeWithdrawalBundle refuses a non-canonical announcer", () => {
        const wrongAnnouncer = "0x1111111111111111111111111111111111111111" as EvmAddress;
        expect(() => composeWithdrawalBundle(withdraw, announcement, wrongAnnouncer)).toThrow(
            StealthAddressAnnouncementError,
        );
    });

    it("STLTH-20: assertCanonicalAnnouncer accepts the canonical address (lowercase + UPPERCASE)", () => {
        expect(() => assertCanonicalAnnouncer(CANONICAL_ANNOUNCER_ADDRESS)).not.toThrow();
        expect(() =>
            assertCanonicalAnnouncer(CANONICAL_ANNOUNCER_ADDRESS.toUpperCase() as EvmAddress),
        ).not.toThrow();
    });

    it("STLTH-20: assertCanonicalAnnouncer accepts EIP-55 mixed-case", () => {
        // EIP-55 checksum encoding of the canonical announcer address. The
        // toLowerCase compare inside assertCanonicalAnnouncer treats any casing
        // as equivalent so checksummed input must pass.
        const mixed = "0x55649E01B5Df198D18D95b5cc5051630cfD45564" as EvmAddress;
        expect(() => assertCanonicalAnnouncer(mixed)).not.toThrow();
    });

    it("NEGATIVE-20: assertCanonicalAnnouncer throws the typed error class", () => {
        const wrong = "0x1111111111111111111111111111111111111111" as EvmAddress;
        expect(() => assertCanonicalAnnouncer(wrong)).toThrow(StealthAddressAnnouncementError);
    });

    it("STLTH-20: composeWithdrawalBundle accepts the canonical announcer", () => {
        expect(() =>
            composeWithdrawalBundle(withdraw, announcement, CANONICAL_ANNOUNCER_ADDRESS),
        ).not.toThrow();
    });

    it("STLTH-20: canonical announcer address is a 20-byte lowercase hex", () => {
        expect(CANONICAL_ANNOUNCER_ADDRESS).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it("NEGATIVE-20: buildAnnounceCall refuses a non-canonical announcer (direct call)", () => {
        // GAP-V8-01: the chokepoint pushed down from composeWithdrawalBundle to
        // buildAnnounceCall in v8. Test the direct entry point, not just the
        // bundle composer, so the gate's location stays load-bearing.
        const wrong = "0x2222222222222222222222222222222222222222" as EvmAddress;
        expect(() => buildAnnounceCall(announcement, wrong)).toThrow(
            StealthAddressAnnouncementError,
        );
    });

    it("NEGATIVE-20: composeWithdrawalBundle rejection carries STLTH-20 message text", () => {
        // Preserves the v7 /STLTH-20/ message-contract pin that v8 swapped for a
        // pure class assertion (GAP-V8-05).
        const wrong = "0x3333333333333333333333333333333333333333" as EvmAddress;
        expect(() => composeWithdrawalBundle(withdraw, announcement, wrong)).toThrow(/STLTH-20/);
    });
});

describe("STLTH-21: deleted sunset/placeholder symbols stay deleted", () => {
    it("NEGATIVE-21: no sunset constants or placeholder-expired error are re-exported", () => {
        // GAP-V8-03: if a regression re-introduces STLTH21_SUNSET_DATE,
        // placeholderSchemeStillAccepted, or StealthAddressPlaceholderSchemeExpiredError,
        // this test catches it before another convergence round.
        const exports = stealth as unknown as Record<string, unknown>;
        expect(exports.STLTH21_SUNSET_DATE).toBe(undefined);
        expect(exports.placeholderSchemeStillAccepted).toBe(undefined);
        expect(exports.StealthAddressPlaceholderSchemeExpiredError).toBe(undefined);
    });

    it("NEGATIVE-20: buildAnnounceCalldata is NOT re-exported from the public surface", () => {
        // GAP-V9-04: v9 removed buildAnnounceCalldata from index.ts to keep
        // buildAnnounceCall (which gates by assertCanonicalAnnouncer) as the
        // single public chokepoint for emitting an announce EvmCall. Re-adding
        // the lower-level helper to the public surface would reopen the gate
        // bypass; this sentinel pins the removal.
        const exports = stealth as unknown as Record<string, unknown>;
        expect(exports.buildAnnounceCalldata).toBe(undefined);
    });

    // L-1: pin the announcer address to the verified canonical ERC-5564 singleton. If this constant
    // is ever changed, STLTH-20 would silently pin traffic to a different Announcer (splitting the
    // anonymity set); this value assertion fails loudly on any drift.
    it("L-1: CANONICAL_ANNOUNCER_ADDRESS is the verified EIP-5564 singleton", () => {
        // Checksums to 0x55649E01B5Df198D18D95b5cc5051630cfD45564 (EIP-5564 Deployment Method +
        // ScopeLift ERC5564Announcer on Etherscan, verified 2026-07-09).
        expect(CANONICAL_ANNOUNCER_ADDRESS).toBe("0x55649e01b5df198d18d95b5cc5051630cfd45564");
    });
});
