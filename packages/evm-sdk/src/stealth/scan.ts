import type {
    Announcement,
    CompressedPubKey,
    EvmAddress,
    Hex,
    Scalar32,
    UncompressedPubKey,
} from "./types.js";
import { decodeStealthDepositPayload } from "./depositPayload.js";
import { computeCanonicalSharedHash } from "./derive-canonical.js";
import { computeFluidKeySharedHash } from "./derive-fluidkey.js";
import { StealthAddressSchemeMismatchError } from "./errors.js";
import {
    deriveStealthPrivateKeyCanonical,
    scanAnnouncementCanonical,
    scanDepositPayloadCanonical,
} from "./scan-canonical.js";
import {
    deriveStealthPrivateKeyFluidKey,
    scanAnnouncementFluidKey,
    scanDepositPayloadFluidKey,
} from "./scan-fluidkey.js";
import { assertNever, SCHEME_CANONICAL, SCHEME_FLUIDKEY } from "./types.js";

/**
 * Per-scheme scan inputs. Canonical needs (viewing_priv, spending_pub);
 * FluidKey needs (spending_priv) alone per STLTH-17. The discriminated union
 * keeps the per-scheme arity explicit and prevents callers from passing
 * the wrong material to the wrong scheme.
 */
export type ScanCredentials =
    | {
          readonly scheme: typeof SCHEME_CANONICAL;
          readonly viewingPrivateKey: Scalar32;
          readonly spendingPublicKey: CompressedPubKey;
      }
    | {
          readonly scheme: typeof SCHEME_FLUIDKEY;
          readonly spendingPrivateKey: Scalar32;
      };

/**
 * Dispatch boundary (STLTH-19): scan an announcement under the matching
 * scheme. Mismatch between `announcement.schemeId` and
 * `credentials.scheme` is a typed error. Otherwise returns the recovered
 * stealth address on a positive match, or null on a miss.
 *
 * **STLTH-18 recipient obligation**: a positive return is necessary but not
 * sufficient. The caller MUST also invoke `verifyAnnouncementBindsToWithdrawal`
 * against the announcement's tx hash; otherwise a Byzantine relayer can mangle
 * the announcement and the recipient will recover a private key controlling
 * an address that never received funds. See `discoveryBinding.ts`.
 */
export const scanAnnouncement = (
    announcement: Announcement,
    credentials: ScanCredentials,
): EvmAddress | null => {
    if (announcement.schemeId !== credentials.scheme) {
        throw new StealthAddressSchemeMismatchError(announcement.schemeId, credentials.scheme);
    }
    // L-C: the ERC-5564 Announcer is permissionlessly spammable, so a malformed/off-curve announcement
    // (e.g. a garbage `ephemeralPubKey` that fails the ECDH parse before the view-tag filter) is a
    // NON-MATCH, not an error — a scanner sweeping many announcements must not abort on adversarial
    // input. Any parse/derive failure in the per-scheme scan therefore returns null (the documented
    // "null on miss" contract); this is a read-only scan, so at worst a legitimate payment is missed and
    // can be re-scanned — never a fund-safety issue. A scheme mismatch is a caller-credential error and
    // is still thrown, above.
    try {
        switch (credentials.scheme) {
            case SCHEME_CANONICAL:
                return scanAnnouncementCanonical(
                    announcement as Extract<Announcement, { schemeId: typeof SCHEME_CANONICAL }>,
                    credentials.viewingPrivateKey,
                    credentials.spendingPublicKey,
                );
            case SCHEME_FLUIDKEY:
                return scanAnnouncementFluidKey(
                    announcement as Extract<Announcement, { schemeId: typeof SCHEME_FLUIDKEY }>,
                    credentials.spendingPrivateKey,
                );
            default:
                return assertNever(credentials);
        }
    } catch {
        return null;
    }
};

/**
 * Recipient-side counterpart to `deriveStealthSharedSecret` (`derive.ts`): recomputes the
 * same ECDH shared-secret hash the sender derived, via ECDH commutativity (sender:
 * `ECDH(eph_priv, recipient_pub)`; recipient: `ECDH(recipient_priv, eph_pub)`). Only
 * meaningful after a positive `scanAnnouncement` match — call this to decrypt a payload
 * the sender encrypted under the shared secret (e.g. a stealth-withdrawal announcement's
 * encrypted metadata), not to re-derive the stealth address itself. For a deposit-side
 * payload (`noteData.data`, see `depositPayload.ts`), `scanDepositNoteData` below already
 * returns the shared hash directly — no separate recover step needed there.
 *
 * @throws {StealthAddressSchemeMismatchError} If `announcement.schemeId` does not match `credentials.scheme`.
 */
export const recoverStealthSharedSecret = (
    announcement: Announcement,
    credentials: ScanCredentials,
): Uint8Array => {
    if (announcement.schemeId !== credentials.scheme) {
        throw new StealthAddressSchemeMismatchError(announcement.schemeId, credentials.scheme);
    }
    switch (credentials.scheme) {
        case SCHEME_CANONICAL:
            return computeCanonicalSharedHash(
                credentials.viewingPrivateKey,
                (announcement as Extract<Announcement, { schemeId: typeof SCHEME_CANONICAL }>)
                    .ephemeralPubKey,
            );
        case SCHEME_FLUIDKEY:
            return computeFluidKeySharedHash(
                credentials.spendingPrivateKey,
                (announcement as Extract<Announcement, { schemeId: typeof SCHEME_FLUIDKEY }>)
                    .ephemeralPubKey,
            );
        default:
            return assertNever(credentials);
    }
};

/**
 * Per-scheme stealth private key derivation. Returns the scalar that
 * controls the announced stealth address. Self-validates internally.
 *
 * For canonical: needs (viewing_priv, spending_priv) — the same material the
 * scanner used to prove the announcement was for the user, plus the spending
 * priv to compute the additive offset.
 *
 * For FluidKey: needs only (spending_priv) per STLTH-17.
 */
export type DerivePrivCredentials =
    | {
          readonly scheme: typeof SCHEME_CANONICAL;
          readonly viewingPrivateKey: Scalar32;
          readonly spendingPrivateKey: Scalar32;
      }
    | {
          readonly scheme: typeof SCHEME_FLUIDKEY;
          readonly spendingPrivateKey: Scalar32;
      };

export const deriveStealthPrivateKey = (
    announcement: Announcement,
    credentials: DerivePrivCredentials,
): Scalar32 => {
    if (announcement.schemeId !== credentials.scheme) {
        throw new StealthAddressSchemeMismatchError(announcement.schemeId, credentials.scheme);
    }
    switch (credentials.scheme) {
        case SCHEME_CANONICAL:
            return deriveStealthPrivateKeyCanonical(
                announcement as Extract<Announcement, { schemeId: typeof SCHEME_CANONICAL }>,
                credentials.viewingPrivateKey,
                credentials.spendingPrivateKey,
            );
        case SCHEME_FLUIDKEY:
            return deriveStealthPrivateKeyFluidKey(
                announcement as Extract<Announcement, { schemeId: typeof SCHEME_FLUIDKEY }>,
                credentials.spendingPrivateKey,
            );
        default:
            return assertNever(credentials);
    }
};

/** Positive match from `scanDepositNoteData`: the note's stealth owner, plus everything
 *  needed to decrypt the embedded secret and confirm the match wasn't a tag collision. */
export interface DepositStealthMatch {
    readonly stealthAddress: EvmAddress;
    /** ECDH shared secret — pass to `ICryptoService.decrypt(encryptedNoteSecret, sharedSecret)`. */
    readonly sharedSecret: Uint8Array;
    readonly encryptedNoteSecret: Hex;
}

/**
 * Sibling to `scanAnnouncement` for the camouflaged dust-rescue delivery channel: scans
 * a plain deposit's `noteData.data` for a packed stealth payload (see `depositPayload.ts`)
 * instead of an ERC-5564 `Announcement` event. Unlike `scanAnnouncement`, there is no
 * separately claimed on-chain `stealthAddress` to verify a match against — deposit
 * ownership is Poseidon-hashed into the commitment, never plaintext on-chain — so the
 * derived candidate address IS the result on a positive match.
 *
 * Every ordinary (non-stealth) deposit's `data` will fail to parse or fail the view-tag
 * filter here — that's the expected common case, not an error, so this returns `null` on
 * any parse/scheme/tag/derivation miss rather than throwing (same "null on miss" contract
 * `scanAnnouncement` uses, for the same reason: a scanner sweeping many events must not
 * abort on non-matching input).
 */
export const scanDepositNoteData = (
    data: Hex,
    credentials: ScanCredentials,
): DepositStealthMatch | null => {
    const payload = decodeStealthDepositPayload(data);
    if (!payload || payload.schemeId !== credentials.scheme) {
        return null;
    }
    try {
        switch (credentials.scheme) {
            case SCHEME_CANONICAL: {
                const match = scanDepositPayloadCanonical(
                    payload.ephemeralPubKey as CompressedPubKey,
                    payload.viewTag,
                    credentials.viewingPrivateKey,
                    credentials.spendingPublicKey,
                );
                return match
                    ? {
                          stealthAddress: match.stealthAddress,
                          sharedSecret: match.sharedHash,
                          encryptedNoteSecret: payload.encryptedNoteSecret,
                      }
                    : null;
            }
            case SCHEME_FLUIDKEY: {
                const match = scanDepositPayloadFluidKey(
                    payload.ephemeralPubKey as UncompressedPubKey,
                    payload.viewTag,
                    credentials.spendingPrivateKey,
                );
                return match
                    ? {
                          stealthAddress: match.stealthAddress,
                          sharedSecret: match.sharedHash,
                          encryptedNoteSecret: payload.encryptedNoteSecret,
                      }
                    : null;
            }
            default:
                return assertNever(credentials);
        }
    } catch {
        return null;
    }
};
