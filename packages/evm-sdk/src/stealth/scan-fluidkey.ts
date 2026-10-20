import { secp256k1 } from "@noble/curves/secp256k1.js";

import type { EvmAddress, FluidKeyAnnouncement, Scalar32 } from "./types.js";
import { computeFluidKeySharedHash } from "./derive-fluidkey.js";
import { StealthAddressDeriveError, StealthAddressScanIntegrityError } from "./errors.js";
import {
    asScalar32,
    bigIntToBytes,
    bytesToBigInt,
    bytesToHex,
    hexToBytes,
    uncompressedPubKeyToEvmAddress,
} from "./internal/codec.js";
import { computeViewTag } from "./viewTag.js";

const SECP256K1_ORDER = secp256k1.Point.CURVE().n;

/**
 * Recipient-side ECDH + candidate-address derivation for the FluidKey variant,
 * shared by two callers that differ only in what they do with the result:
 * `scanAnnouncementFluidKey` (below) additionally verifies the candidate against
 * an on-chain claimed `announcement.stealthAddress`; `scanDepositPayloadFluidKey`
 * has no such claim to verify against (deposit ownership is Poseidon-hashed, never
 * plaintext on-chain) and returns the candidate directly.
 *
 * Ordering preserved for both callers: view-tag filter first (cheap), then full
 * address candidate derivation (1 scalar mult + 1 keccak) only on a tag match.
 *
 * @internal
 */
const deriveCandidateFluidKey = (
    ephemeralPubKey: FluidKeyAnnouncement["ephemeralPubKey"],
    viewTag: number,
    spendingPrivateKey: Scalar32,
): EvmAddress | null => {
    const sharedHash = computeFluidKeySharedHash(spendingPrivateKey, ephemeralPubKey);
    const candidateTag = computeViewTag(sharedHash);
    if (candidateTag !== viewTag) {
        return null;
    }

    const scalar = bytesToBigInt(sharedHash) % SECP256K1_ORDER;
    if (scalar === 0n) {
        throw new StealthAddressDeriveError("FluidKey scan: derived scalar is zero");
    }
    // Reconstruct the sender's stealth point: spending_pub * hash. We need
    // spending_pub for this, which we derive from spending_priv.
    const spendingPub = secp256k1.getPublicKey(
        hexToBytes(spendingPrivateKey),
        /* compressed */ false,
    );
    const spendingPoint = secp256k1.Point.fromBytes(spendingPub);
    const candidatePoint = spendingPoint.multiply(scalar);
    candidatePoint.assertValidity();

    return uncompressedPubKeyToEvmAddress(candidatePoint.toBytes(false));
};

/**
 * Recipient-side scan for the FluidKey variant. STLTH-17: needs the
 * recipient's SPENDING private key (not viewing), because the ECDH in
 * FluidKey is between eph_priv and spending_pub. Returns the stealth EVM
 * address on positive match, null on miss.
 *
 * @internal Dispatched-to from `scanAnnouncement` in `scan.ts`.
 */
export const scanAnnouncementFluidKey = (
    announcement: FluidKeyAnnouncement,
    spendingPrivateKey: Scalar32,
): EvmAddress | null => {
    const candidateAddress = deriveCandidateFluidKey(
        announcement.ephemeralPubKey,
        announcement.viewTag,
        spendingPrivateKey,
    );
    return candidateAddress?.toLowerCase() === announcement.stealthAddress.toLowerCase()
        ? candidateAddress
        : null;
};

/**
 * Recipient-side scan for a FluidKey-scheme stealth payload embedded in a plain
 * deposit's `noteData.data` (see `depositPayload.ts`) rather than an ERC-5564
 * `Announcement`. Same ECDH + candidate-address derivation as
 * `scanAnnouncementFluidKey`, but with no claimed on-chain `stealthAddress` to
 * verify against — the candidate address IS the result. Returns the shared hash
 * too, since the caller needs it to decrypt the payload's `encryptedNoteSecret`.
 *
 * @internal Dispatched-to from `scanDepositNoteData` in `scan.ts`.
 */
export const scanDepositPayloadFluidKey = (
    ephemeralPubKey: FluidKeyAnnouncement["ephemeralPubKey"],
    viewTag: number,
    spendingPrivateKey: Scalar32,
): { readonly stealthAddress: EvmAddress; readonly sharedHash: Uint8Array } | null => {
    const stealthAddress = deriveCandidateFluidKey(ephemeralPubKey, viewTag, spendingPrivateKey);
    if (!stealthAddress) return null;
    // Match confirmed — recompute the shared hash once more (cheap: no point mult)
    // so the caller can decrypt `encryptedNoteSecret` with it.
    const sharedHash = computeFluidKeySharedHash(spendingPrivateKey, ephemeralPubKey);
    return { stealthAddress, sharedHash };
};

/**
 * Derive the stealth private key for the FluidKey variant.
 * stealth_priv = (spending_priv * hash) mod n
 *
 * Self-validates: stealth_priv * G must yield the announced stealth address.
 * A mismatch indicates a mangled announcement or a Byzantine sender.
 *
 * @internal Dispatched-to from `deriveStealthPrivateKey` in `scan.ts`.
 */
export const deriveStealthPrivateKeyFluidKey = (
    announcement: FluidKeyAnnouncement,
    spendingPrivateKey: Scalar32,
): Scalar32 => {
    const sharedHash = computeFluidKeySharedHash(spendingPrivateKey, announcement.ephemeralPubKey);
    const k = bytesToBigInt(sharedHash) % SECP256K1_ORDER;
    if (k === 0n) {
        throw new StealthAddressDeriveError("FluidKey derive priv: hash scalar is zero");
    }
    const spendingScalar = bytesToBigInt(hexToBytes(spendingPrivateKey));
    const stealthScalar = (spendingScalar * k) % SECP256K1_ORDER;
    if (stealthScalar === 0n) {
        throw new StealthAddressDeriveError("FluidKey derive priv: stealth scalar is zero");
    }
    const stealthPriv = asScalar32(bytesToHex(bigIntToBytes(stealthScalar, 32)));

    // Self-validation: stealth_priv * G must equal the announced stealth address's point.
    const stealthPub = secp256k1.getPublicKey(hexToBytes(stealthPriv), /* compressed */ false);
    const recoveredAddress = uncompressedPubKeyToEvmAddress(stealthPub);
    if (recoveredAddress.toLowerCase() !== announcement.stealthAddress.toLowerCase()) {
        throw new StealthAddressScanIntegrityError(
            `FluidKey derived stealth private key does not control announced address; ` +
                `derived=${recoveredAddress}, announced=${announcement.stealthAddress}.`,
        );
    }
    return stealthPriv;
};
