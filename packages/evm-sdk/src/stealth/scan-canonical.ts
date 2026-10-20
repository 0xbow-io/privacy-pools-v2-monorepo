import { secp256k1 } from "@noble/curves/secp256k1.js";

import type { CanonicalAnnouncement, CompressedPubKey, EvmAddress, Scalar32 } from "./types.js";
import { computeCanonicalSharedHash } from "./derive-canonical.js";
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
 * Recipient-side ECDH + candidate-address derivation for canonical scheme 1,
 * shared by two callers that differ only in what they do with the result:
 * `scanAnnouncementCanonical` (below) additionally verifies the candidate against
 * an on-chain claimed `announcement.stealthAddress`; `scanDepositPayloadCanonical`
 * has no such claim to verify against (deposit ownership is Poseidon-hashed, never
 * plaintext on-chain) and returns the candidate directly.
 *
 * Ordering preserved for both callers: view-tag filter first (cheap), then full
 * address candidate derivation (1 scalar mult + 1 point add + 1 keccak) only on a
 * tag match.
 *
 * @internal
 */
const deriveCandidateCanonical = (
    ephemeralPubKey: CompressedPubKey,
    viewTag: number,
    viewingPrivateKey: Scalar32,
    spendingPublicKey: CompressedPubKey,
): EvmAddress | null => {
    // ECDH commutativity: the sender computed shared = ECDH(eph_priv, viewing_pub).
    // The recipient recomputes the same shared point as ECDH(viewing_priv, eph_pub).
    // The spending PUB key is NOT in the ECDH; it enters later as the offset point
    // for the candidate-address reconstruction (P = spending_pub + hash*G).
    const sharedHash = computeCanonicalSharedHash(viewingPrivateKey, ephemeralPubKey);
    const candidateTag = computeViewTag(sharedHash);
    if (candidateTag !== viewTag) {
        return null;
    }

    const hashScalar = bytesToBigInt(sharedHash) % SECP256K1_ORDER;
    if (hashScalar === 0n) {
        throw new StealthAddressDeriveError("canonical scan: derived scalar is zero");
    }
    // Reconstruct: P_stealth = spending_pub + hash*G.
    const spendingPoint = secp256k1.Point.fromBytes(hexToBytes(spendingPublicKey));
    const hashPoint = secp256k1.Point.BASE.multiply(hashScalar);
    const candidatePoint = spendingPoint.add(hashPoint);
    candidatePoint.assertValidity();

    return uncompressedPubKeyToEvmAddress(candidatePoint.toBytes(false));
};

/**
 * Recipient-side scan for canonical EIP-5564 scheme 1. Takes the
 * recipient's VIEWING private key (per classical EIP-5564 separation:
 * the viewing key suffices for scanning, the spending key is required only
 * for actually spending). Plus the recipient's spending PUB key, which is
 * needed to derive the candidate stealth point. Returns the stealth EVM
 * address on positive match, null on miss.
 *
 * @internal Dispatched-to from `scanAnnouncement` in `scan.ts`.
 */
export const scanAnnouncementCanonical = (
    announcement: CanonicalAnnouncement,
    viewingPrivateKey: Scalar32,
    spendingPublicKey: CompressedPubKey,
): EvmAddress | null => {
    const candidateAddress = deriveCandidateCanonical(
        announcement.ephemeralPubKey,
        announcement.viewTag,
        viewingPrivateKey,
        spendingPublicKey,
    );
    return candidateAddress?.toLowerCase() === announcement.stealthAddress.toLowerCase()
        ? candidateAddress
        : null;
};

/**
 * Recipient-side scan for a canonical-scheme stealth payload embedded in a plain
 * deposit's `noteData.data` (see `depositPayload.ts`) rather than an ERC-5564
 * `Announcement`. Same ECDH + candidate-address derivation as `scanAnnouncementCanonical`,
 * but with no claimed on-chain `stealthAddress` to verify against — the candidate
 * address IS the result. Returns the shared hash too, since the caller needs it to
 * decrypt the payload's `encryptedNoteSecret`.
 *
 * @internal Dispatched-to from `scanDepositNoteData` in `scan.ts`.
 */
export const scanDepositPayloadCanonical = (
    ephemeralPubKey: CompressedPubKey,
    viewTag: number,
    viewingPrivateKey: Scalar32,
    spendingPublicKey: CompressedPubKey,
): { readonly stealthAddress: EvmAddress; readonly sharedHash: Uint8Array } | null => {
    const stealthAddress = deriveCandidateCanonical(
        ephemeralPubKey,
        viewTag,
        viewingPrivateKey,
        spendingPublicKey,
    );
    if (!stealthAddress) return null;
    // Match confirmed — recompute the shared hash once more (cheap: one ECDH scalar
    // mult, no point-add) so the caller can decrypt `encryptedNoteSecret` with it.
    const sharedHash = computeCanonicalSharedHash(viewingPrivateKey, ephemeralPubKey);
    return { stealthAddress, sharedHash };
};

/**
 * Derive the canonical stealth private key. Requires both the recipient's
 * VIEWING priv (for the ECDH) and SPENDING priv (for the final addition).
 *
 *   stealth_priv = (spending_priv + hash) mod n
 *
 * Self-validates: stealth_priv * G must yield the announced address.
 *
 * @internal Dispatched-to from `deriveStealthPrivateKey` in `scan.ts`.
 */
export const deriveStealthPrivateKeyCanonical = (
    announcement: CanonicalAnnouncement,
    viewingPrivateKey: Scalar32,
    spendingPrivateKey: Scalar32,
): Scalar32 => {
    // Same ECDH as scanAnnouncementCanonical: shared = (viewing_priv, eph_pub).
    const sharedHash = computeCanonicalSharedHash(viewingPrivateKey, announcement.ephemeralPubKey);
    const k = bytesToBigInt(sharedHash) % SECP256K1_ORDER;
    if (k === 0n) {
        throw new StealthAddressDeriveError("canonical derive priv: hash scalar is zero");
    }
    const spendingScalar = bytesToBigInt(hexToBytes(spendingPrivateKey));
    const stealthScalar = (spendingScalar + k) % SECP256K1_ORDER;
    if (stealthScalar === 0n) {
        throw new StealthAddressDeriveError("canonical derive priv: stealth scalar is zero");
    }
    const stealthPriv = asScalar32(bytesToHex(bigIntToBytes(stealthScalar, 32)));

    // Self-validation: stealthPriv * G must yield the announced address.
    const stealthPub = secp256k1.getPublicKey(hexToBytes(stealthPriv), /* compressed */ false);
    const recoveredAddress = uncompressedPubKeyToEvmAddress(stealthPub);
    if (recoveredAddress.toLowerCase() !== announcement.stealthAddress.toLowerCase()) {
        throw new StealthAddressScanIntegrityError(
            `canonical derived stealth private key does not control announced address; ` +
                `derived=${recoveredAddress}, announced=${announcement.stealthAddress}.`,
        );
    }
    return stealthPriv;
};
