import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type {
    EvmAddress,
    Hex,
    MetaAddress,
    UncompressedPubKey,
    WithdrawalLogEvent,
} from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
    generateEphemeralKeyPair,
    SCHEME_FLUIDKEY,
    StealthAddressAnnouncementError,
    verifyAnnouncementBindsToWithdrawal,
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

const SAMPLE_TX = "0xc0ffee00000000000000000000000000000000000000000000000000000000ee" as Hex;
const OTHER_TX = "0xbaadf00d00000000000000000000000000000000000000000000000000000001" as Hex;

describe("discoveryBinding (STLTH-18 recipient side, v4)", () => {
    it("accepts when a same-tx Withdrawal pays the announced stealth address", () => {
        const meta = newRecipientMeta();
        const eph = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { stealthAddress, announcement } = deriveStealthAddress(meta, eph, SCHEME_FLUIDKEY);

        const withdrawals: WithdrawalLogEvent[] = [
            { txHash: SAMPLE_TX, destination: stealthAddress },
        ];
        expect(verifyAnnouncementBindsToWithdrawal(SAMPLE_TX, announcement, withdrawals)).toBe(
            true,
        );
    });

    it("rejects when no Withdrawal in the tx pays the announced address", () => {
        const meta = newRecipientMeta();
        const eph = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(meta, eph, SCHEME_FLUIDKEY);

        const withdrawals: WithdrawalLogEvent[] = [
            {
                txHash: SAMPLE_TX,
                destination: "0xdead000000000000000000000000000000000000" as EvmAddress,
            },
            {
                txHash: SAMPLE_TX,
                destination: "0xbeef000000000000000000000000000000000000" as EvmAddress,
            },
        ];
        expect(verifyAnnouncementBindsToWithdrawal(SAMPLE_TX, announcement, withdrawals)).toBe(
            false,
        );
    });

    it("rejects empty withdrawal set (Byzantine-relayer baseline case)", () => {
        const meta = newRecipientMeta();
        const eph = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(meta, eph, SCHEME_FLUIDKEY);

        expect(verifyAnnouncementBindsToWithdrawal(SAMPLE_TX, announcement, [])).toBe(false);
    });

    it("accepts mixed batch where one same-tx withdrawal matches", () => {
        const meta = newRecipientMeta();
        const eph = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { stealthAddress, announcement } = deriveStealthAddress(meta, eph, SCHEME_FLUIDKEY);

        const withdrawals: WithdrawalLogEvent[] = [
            {
                txHash: SAMPLE_TX,
                destination: "0xdead000000000000000000000000000000000000" as EvmAddress,
            },
            { txHash: SAMPLE_TX, destination: stealthAddress },
            {
                txHash: SAMPLE_TX,
                destination: "0xbeef000000000000000000000000000000000000" as EvmAddress,
            },
        ];
        expect(verifyAnnouncementBindsToWithdrawal(SAMPLE_TX, announcement, withdrawals)).toBe(
            true,
        );
    });

    it("case-insensitive destination match", () => {
        const meta = newRecipientMeta();
        const eph = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { stealthAddress, announcement } = deriveStealthAddress(meta, eph, SCHEME_FLUIDKEY);

        const upperCased = stealthAddress.toUpperCase().replace("0X", "0x") as EvmAddress;
        const withdrawals: WithdrawalLogEvent[] = [{ txHash: SAMPLE_TX, destination: upperCased }];
        expect(verifyAnnouncementBindsToWithdrawal(SAMPLE_TX, announcement, withdrawals)).toBe(
            true,
        );
    });

    it("BIND-01 (v4): throws if a withdrawal is from a different tx than the announcement", () => {
        const meta = newRecipientMeta();
        const eph = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { stealthAddress, announcement } = deriveStealthAddress(meta, eph, SCHEME_FLUIDKEY);

        // Caller mistake: passes a withdrawal that pays our stealth address but
        // happens to live in a totally different tx. Without the v4 txHash check
        // this would falsely accept.
        const withdrawals: WithdrawalLogEvent[] = [
            { txHash: OTHER_TX, destination: stealthAddress },
        ];
        expect(() =>
            verifyAnnouncementBindsToWithdrawal(SAMPLE_TX, announcement, withdrawals),
        ).toThrow(StealthAddressAnnouncementError);
    });

    it("BIND-01 (v4): case-insensitive txHash match", () => {
        const meta = newRecipientMeta();
        const eph = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { stealthAddress, announcement } = deriveStealthAddress(meta, eph, SCHEME_FLUIDKEY);

        const upperTx = SAMPLE_TX.toUpperCase().replace("0X", "0x") as Hex;
        const withdrawals: WithdrawalLogEvent[] = [
            { txHash: upperTx, destination: stealthAddress },
        ];
        expect(verifyAnnouncementBindsToWithdrawal(SAMPLE_TX, announcement, withdrawals)).toBe(
            true,
        );
    });
});
