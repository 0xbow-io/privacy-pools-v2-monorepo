import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import type {
    EvmAddress,
    Hex,
    Scalar32,
    WithdrawalLogEvent,
    WithdrawCallGenerator,
} from "../../../src/stealth/index.js";
import { ERC5564_ANNOUNCE_ABI } from "../../../src/stealth/announce.js";
import {
    prepareStealthWithdrawal,
    scanAnnouncement,
    SCHEME_CANONICAL,
    SCHEME_FLUIDKEY,
    StealthAddressSchemeMismatchError,
    verifyAnnouncementBindsToWithdrawal,
} from "../../../src/stealth/index.js";

const bytesToHex = (bytes: Uint8Array): string => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
};

const ANNOUNCER = "0x55649e01b5df198d18d95b5cc5051630cfd45564" as EvmAddress;
const POOL = "0x9c5e9eb59ddb38a3c7b56b96d7a87c200000a59c" as EvmAddress;

describe("withdraw.ts: prepareStealthWithdrawal orchestrator", () => {
    it("happy path: orchestrates resolve -> derive -> withdraw-gen -> compose", async () => {
        const recipientPriv = randomBytes(32);
        const recipientPub = secp256k1.getPublicKey(recipientPriv, false);

        // The caller's PP-bound proof generator. In real usage this returns an
        // EvmCall whose calldata is a Groth16-attested withdraw proof to PoolVault.
        // For the test it just records what destination was asked for.
        let capturedDestination: EvmAddress | null = null;
        const gen: WithdrawCallGenerator = (stealthAddress) => {
            capturedDestination = stealthAddress;
            return { to: POOL, data: "0xfeedbeef" as Hex };
        };

        const bundle = await prepareStealthWithdrawal({
            recipient: { kind: "raw", spendingPubKey: bytesToHex(recipientPub) as Hex },
            generateWithdrawCall: gen,
            announcerAddress: ANNOUNCER,
        });

        // Withdraw call shape preserved.
        expect(bundle.withdraw.to).toBe(POOL);
        expect(bundle.withdraw.data).toBe("0xfeedbeef");

        // Announce call targets the announcer; calldata decodes to a FluidKey-schemed announcement.
        expect(bundle.announce.to).toBe(ANNOUNCER);
        const decoded = decodeFunctionData({
            abi: ERC5564_ANNOUNCE_ABI,
            data: bundle.announce.data as `0x${string}`,
        });
        expect(decoded.functionName).toBe("announce");
        const [schemeId, stealthAddrFromCalldata] = decoded.args;
        expect(schemeId).toBe(BigInt(SCHEME_FLUIDKEY));

        // STLTH-18 binding: the proof generator was asked for the same address
        // that ends up in the announcement.
        expect(capturedDestination).toBe(stealthAddrFromCalldata.toLowerCase());
    });

    // M-2: the ergonomic orchestrator can now emit a spec-compliant canonical (0x0001)
    // announcement — previously unreachable because resolveRecipient only returned FluidKey.
    it("canonical mode: orchestrates a spec-compliant EIP-5564 (0x0001) announcement", async () => {
        const spendingPub = secp256k1.getPublicKey(randomBytes(32), /* compressed */ true);
        const viewingPub = secp256k1.getPublicKey(randomBytes(32), true);

        let capturedDestination: EvmAddress | null = null;
        const gen: WithdrawCallGenerator = (stealthAddress) => {
            capturedDestination = stealthAddress;
            return { to: POOL, data: "0xfeedbeef" as Hex };
        };

        const bundle = await prepareStealthWithdrawal({
            recipient: {
                kind: "canonical",
                spendingPubKey: bytesToHex(spendingPub) as Hex,
                viewingPubKey: bytesToHex(viewingPub) as Hex,
            },
            generateWithdrawCall: gen,
            announcerAddress: ANNOUNCER,
        });

        const decoded = decodeFunctionData({
            abi: ERC5564_ANNOUNCE_ABI,
            data: bundle.announce.data as `0x${string}`,
        });
        const [schemeId, stealthAddrFromCalldata, ephemeralPubKey] = decoded.args;
        expect(schemeId).toBe(BigInt(SCHEME_CANONICAL));
        // Canonical uses a COMPRESSED (33-byte) ephemeral pubkey, unlike FluidKey's 65-byte one.
        expect((ephemeralPubKey as string).length).toBe(2 + 33 * 2);
        expect(capturedDestination).toBe(stealthAddrFromCalldata.toLowerCase());
    });

    it("TG-G3: rejects an explicit schemeId that mismatches the resolved recipient scheme", async () => {
        // The optional `schemeId` is a defensive cross-check (STLTH-19). A raw recipient resolves to
        // FluidKey (0xfffe); asking for canonical (0x0001) must hard-error at the orchestrator, not
        // silently derive under the wrong scheme.
        const recipientPub = secp256k1.getPublicKey(randomBytes(32), false);
        await expect(
            prepareStealthWithdrawal({
                recipient: { kind: "raw", spendingPubKey: bytesToHex(recipientPub) as Hex },
                generateWithdrawCall: () => ({ to: POOL, data: "0xfeedbeef" as Hex }),
                announcerAddress: ANNOUNCER,
                schemeId: SCHEME_CANONICAL,
            }),
        ).rejects.toThrow(StealthAddressSchemeMismatchError);
    });

    it("STLTH-14: bundle output does not contain the recipient spending pub key (meta-address)", async () => {
        const recipientPriv = randomBytes(32);
        const recipientPub = secp256k1.getPublicKey(recipientPriv, false);
        const recipientPubHex = bytesToHex(recipientPub);

        const gen: WithdrawCallGenerator = () => ({
            to: POOL,
            data: "0xfeedbeef" as Hex,
        });

        const bundle = await prepareStealthWithdrawal({
            recipient: { kind: "raw", spendingPubKey: recipientPubHex as Hex },
            generateWithdrawCall: gen,
            announcerAddress: ANNOUNCER,
        });

        const serialized = JSON.stringify(bundle).toLowerCase();
        expect(
            serialized.includes(recipientPubHex.slice(2).toLowerCase()),
            `meta-address leaked into bundle output: ${serialized}`,
        ).toBe(false);
    });

    it("end-to-end: bundle -> on-chain simulation -> recipient discovers + binds", async () => {
        const recipientPriv = randomBytes(32);
        const recipientPub = secp256k1.getPublicKey(recipientPriv, false);

        const gen: WithdrawCallGenerator = () => ({
            to: POOL,
            data: "0x" as Hex,
        });

        const bundle = await prepareStealthWithdrawal({
            recipient: { kind: "raw", spendingPubKey: bytesToHex(recipientPub) as Hex },
            generateWithdrawCall: gen,
            announcerAddress: ANNOUNCER,
        });

        // Decode the announcement back out of the calldata so we can simulate
        // what a recipient scanner would see on-chain.
        const decoded = decodeFunctionData({
            abi: ERC5564_ANNOUNCE_ABI,
            data: bundle.announce.data as `0x${string}`,
        });
        const [schemeId, stealthAddrHex, ephPubHex, metadataHex] = decoded.args as [
            bigint,
            `0x${string}`,
            `0x${string}`,
            `0x${string}`,
        ];
        const reconstructedAnnouncement = {
            schemeId: Number(schemeId) as typeof SCHEME_FLUIDKEY,
            stealthAddress: stealthAddrHex.toLowerCase() as EvmAddress,
            ephemeralPubKey: ephPubHex.toLowerCase() as ReturnType<typeof bytesToHex> as never,
            viewTag: Number.parseInt(metadataHex.slice(2), 16),
        };

        // Recipient scans + recovers.
        const recovered = scanAnnouncement(reconstructedAnnouncement as never, {
            scheme: SCHEME_FLUIDKEY,
            spendingPrivateKey: bytesToHex(recipientPriv) as Scalar32,
        });
        expect(recovered).toBe(reconstructedAnnouncement.stealthAddress);

        // Recipient does the STLTH-18 binding check against the same-tx Withdrawal.
        const FAKE_TX = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex;
        const withdrawals: WithdrawalLogEvent[] = [
            { txHash: FAKE_TX, destination: reconstructedAnnouncement.stealthAddress },
        ];
        expect(
            verifyAnnouncementBindsToWithdrawal(
                FAKE_TX,
                reconstructedAnnouncement as never,
                withdrawals,
            ),
        ).toBe(true);
    });
});
