import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes as nobleHexToBytes } from "@noble/curves/utils.js";
import { bytesToHex } from "@noble/ciphers/utils.js";
import { parseAbiItem } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";

import type { Address, Hex } from "../../src/internal.js";
import {
    buildAnnounceCall,
    CANONICAL_ANNOUNCER_ADDRESS,
    deriveStealthAddress,
    deriveStealthPrivateKey,
    generateEphemeralKeyPair,
    resolveRecipient,
    SCHEME_CANONICAL,
    SCHEME_FLUIDKEY,
    scanAnnouncement,
    StealthAddressAnnouncementError,
    StealthAddressDeriveError,
    StealthAddressSchemeMismatchError,
    StealthAddressUnsupportedSchemeError,
} from "../../src/stealth/index.js";
import type {
    Announcement,
    CanonicalMetaAddress,
    CompressedPubKey,
    EvmAddress,
    Scalar32,
} from "../../src/stealth/index.js";
import type { Actor } from "../harness/actors.js";
import { createActor, walletFor } from "../harness/actors.js";
import { fundAddress } from "../network.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext, EVM_E2E } from "../harness/context.js";
import { nativeBalance } from "../harness/chain.js";

const ANNOUNCEMENT_EVENT = parseAbiItem(
    "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
);

interface RecipientKeys {
    spendingPrivateKey: Scalar32;
    viewingPrivateKey: Scalar32;
    meta: CanonicalMetaAddress;
}

/** A recipient's canonical EIP-5564 key material (separate spending and viewing keys). */
function newRecipient(): RecipientKeys {
    const spend = generatePrivateKey();
    const view = generatePrivateKey();
    const compressed = (priv: Hex) =>
        ("0x" + bytesToHex(secp256k1.getPublicKey(nobleHexToBytes(priv.slice(2)), true))) as CompressedPubKey;
    return {
        spendingPrivateKey: spend as unknown as Scalar32,
        viewingPrivateKey: view as unknown as Scalar32,
        meta: { scheme: SCHEME_CANONICAL, spendingPubKey: compressed(spend), viewingPubKey: compressed(view) },
    };
}

/**
 * Stealth-address ladders (matrix §11d): a sender derives a one-time address for a recipient and
 * announces it on the canonical ERC-5564 Announcer; only the recipient can find it and control it.
 * The module is pure derivation + scanning, so the failure rungs need no chain; the success path uses
 * the real Announcer's code, installed at its canonical address by `network.ts`.
 */
describe.skipIf(!EVM_E2E)("stealth addresses", () => {
    let ctx: E2EContext;
    let sender: Actor;

    beforeAll(async () => {
        ctx = e2eContext();
        sender = await createActor("sender");
    });

    describe("derivation and scanning refusals", () => {
        const recipient = newRecipient();

        it("refuse an unsupported scheme id with StealthAddressUnsupportedSchemeError", () => {
            const ephemeral = generateEphemeralKeyPair(SCHEME_CANONICAL);

            expect(() => deriveStealthAddress(recipient.meta, ephemeral, 0x1234)).toThrow(
                StealthAddressUnsupportedSchemeError,
            );
        });

        it("refuse a meta-address of one scheme derived under another with StealthAddressSchemeMismatchError", () => {
            const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);

            expect(() => deriveStealthAddress(recipient.meta, ephemeral, SCHEME_FLUIDKEY)).toThrow(
                StealthAddressSchemeMismatchError,
            );
        });

        it("refuse a recipient public key that is not on the curve with StealthAddressDeriveError", () => {
            const offCurve = ("0x04" + "11".repeat(64)) as Hex;

            expect(() => resolveRecipient({ kind: "raw", spendingPubKey: offCurve as never })).toThrow(StealthAddressDeriveError);
        });

        it("refuse to scan an announcement with credentials of another scheme", () => {
            const { announcement } = deriveStealthAddress(
                recipient.meta,
                generateEphemeralKeyPair(SCHEME_CANONICAL),
                SCHEME_CANONICAL,
            );

            expect(() =>
                scanAnnouncement(announcement, {
                    scheme: SCHEME_FLUIDKEY,
                    spendingPrivateKey: recipient.spendingPrivateKey,
                }),
            ).toThrow(StealthAddressSchemeMismatchError);
        });

        it("treat a garbage announcement as a non-match instead of aborting a scan", () => {
            const garbage: Announcement = {
                schemeId: SCHEME_CANONICAL,
                stealthAddress: ("0x" + "22".repeat(20)) as EvmAddress,
                ephemeralPubKey: ("0x02" + "00".repeat(32)) as CompressedPubKey,
                viewTag: 0,
            };

            expect(
                scanAnnouncement(garbage, {
                    scheme: SCHEME_CANONICAL,
                    viewingPrivateKey: recipient.viewingPrivateKey,
                    spendingPublicKey: recipient.meta.spendingPubKey,
                }),
            ).toBeNull();
        });

        it("refuse to announce through any contract other than the canonical Announcer", () => {
            const { announcement } = deriveStealthAddress(
                recipient.meta,
                generateEphemeralKeyPair(SCHEME_CANONICAL),
                SCHEME_CANONICAL,
            );

            expect(() => buildAnnounceCall(announcement, ("0x" + "33".repeat(20)) as EvmAddress)).toThrow(
                StealthAddressAnnouncementError,
            );
        });
    });

    describe("a payment to a stealth address", () => {
        const recipient = newRecipient();
        let derived: ReturnType<typeof deriveStealthAddress>;
        let onChain: Announcement;
        let announceBlock: bigint;

        it("derive a one-time address that is not the recipient's spending address", () => {
            derived = deriveStealthAddress(recipient.meta, generateEphemeralKeyPair(SCHEME_CANONICAL), SCHEME_CANONICAL);

            expect(derived.stealthAddress).toMatch(/^0x[0-9a-f]{40}$/i);
            expect(derived.announcement.schemeId).toBe(SCHEME_CANONICAL);
        });

        it("announce it on the canonical Announcer", async () => {
            const code = await ctx.publicClient.getCode({ address: CANONICAL_ANNOUNCER_ADDRESS as Address });
            expect(code, "the canonical ERC-5564 Announcer must exist on the node").not.toBe(undefined);

            const call = buildAnnounceCall(derived.announcement, CANONICAL_ANNOUNCER_ADDRESS);
            const hash = await walletFor(ctx, sender).sendTransaction({
                to: call.to as Address,
                data: call.data as Hex,
                chain: null,
            });
            const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });

            expect(receipt.status).toBe("success");
            announceBlock = receipt.blockNumber;
        });

        it("read the announcement back from the chain's logs", async () => {
            const logs = await ctx.publicClient.getLogs({
                address: CANONICAL_ANNOUNCER_ADDRESS as Address,
                event: ANNOUNCEMENT_EVENT,
                args: { stealthAddress: derived.stealthAddress as Address },
                fromBlock: announceBlock,
                toBlock: announceBlock,
            });

            expect(logs).toHaveLength(1);
            const log = logs[0]!;
            onChain = {
                schemeId: SCHEME_CANONICAL,
                stealthAddress: log.args.stealthAddress as EvmAddress,
                ephemeralPubKey: log.args.ephemeralPubKey as CompressedPubKey,
                viewTag: Number(BigInt(log.args.metadata as Hex)),
            };
            expect(Number(log.args.schemeId)).toBe(SCHEME_CANONICAL);
        });

        it("let the recipient's scan recognize it", () => {
            const found = scanAnnouncement(onChain, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: recipient.viewingPrivateKey,
                spendingPublicKey: recipient.meta.spendingPubKey,
            });

            expect(found?.toLowerCase()).toBe(derived.stealthAddress.toLowerCase());
        });

        it("keep everyone else's scan from recognizing it", () => {
            const stranger = newRecipient();

            const found = scanAnnouncement(onChain, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: stranger.viewingPrivateKey,
                spendingPublicKey: stranger.meta.spendingPubKey,
            });

            expect(found).toBeNull();
        });

        it("hand the recipient a private key that controls exactly that address", () => {
            const key = deriveStealthPrivateKey(onChain, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: recipient.viewingPrivateKey,
                spendingPrivateKey: recipient.spendingPrivateKey,
            });

            expect(privateKeyToAccount(key as unknown as Hex).address.toLowerCase()).toBe(
                derived.stealthAddress.toLowerCase(),
            );
        });

        it("let the recipient spend from the stealth address with the derived key", async () => {
            const key = deriveStealthPrivateKey(onChain, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: recipient.viewingPrivateKey,
                spendingPrivateKey: recipient.spendingPrivateKey,
            }) as unknown as Hex;
            const stealthAccount = privateKeyToAccount(key);
            await fundAddress(ctx.network.rpcUrl, stealthAccount.address as Address);
            const destination = await createActor("destination", { funded: false });

            const hash = await walletFor(ctx, { ...sender, account: stealthAccount }).sendTransaction({
                to: destination.address,
                value: 1_000n,
                chain: null,
            });
            await ctx.publicClient.waitForTransactionReceipt({ hash });

            expect(await nativeBalance(ctx, destination.address)).toBe(1_000n);
        });
    });
});
