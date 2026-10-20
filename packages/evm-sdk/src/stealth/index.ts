/**
 * Public API for the Privacy Pools v2 stealth-address module
 * (Phase 2, multi-scheme: canonical EIP-5564 + FluidKey variant).
 *
 * Scope: sender-side derivation and recipient-side recovery for both
 * schemes side-by-side, dispatch on meta-address scheme tag (STLTH-19),
 * identifier resolution, announcement on-chain encoding, relayer-bundle
 * composition, EIP-6538 registry + ENS/CCIP-Read resolution (v9+).
 *
 * This module has no dedicated tech-design doc — it is an EXTENSION over the SDK
 * spec (see `agents/deviations.md`, INTL-01..04 at the repo root). The `STLTH-NN`
 * tags throughout the module are this module's own internal design rubric, not
 * references to an external spec file. Canonical scheme follows EIP-5564
 * (scheme 1); the FluidKey variant follows the FluidKey stealth-address recipe.
 */
export {
    deriveStealthAddress,
    deriveStealthSharedSecret,
    generateEphemeralKeyPair,
} from "./derive.js";

export {
    deriveStealthPrivateKey,
    recoverStealthSharedSecret,
    scanAnnouncement,
    scanDepositNoteData,
} from "./scan.js";
export type { DepositStealthMatch, DerivePrivCredentials, ScanCredentials } from "./scan.js";

export { decodeStealthDepositPayload, encodeStealthDepositPayload } from "./depositPayload.js";
export type { StealthDepositPayload } from "./depositPayload.js";

export { buildAnnounceCall, ERC5564_ANNOUNCE_ABI } from "./announce.js";
export type { EvmCall } from "./announce.js";

export { composeWithdrawalBundle } from "./bundle.js";
export type { DeclaredWithdrawCall, StealthWithdrawalBundle } from "./bundle.js";

export { verifyAnnouncementBindsToWithdrawal } from "./discoveryBinding.js";
export type { WithdrawalLogEvent } from "./discoveryBinding.js";

export { resolveRecipient } from "./resolve.js";
export type { RecipientIdentifier } from "./resolve.js";

export { prepareStealthWithdrawal } from "./withdraw.js";
export type { StealthWithdrawalRequest, WithdrawCallGenerator } from "./withdraw.js";

export { computeViewTag, encodeViewTagAsMetadata, VIEW_TAG_BYTES } from "./viewTag.js";

export { toStealthAnnouncementFields } from "./relayBridge.js";

export type {
    Announcement,
    CanonicalAnnouncement,
    CanonicalMetaAddress,
    CompressedPubKey,
    EphemeralKeyPair,
    EvmAddress,
    FluidKeyAnnouncement,
    FluidKeyMetaAddress,
    Hex,
    MetaAddress,
    Scalar32,
    SchemeId,
    StealthDerivation,
    UncompressedPubKey,
} from "./types.js";

export { assertNever, SCHEME_CANONICAL, SCHEME_FLUIDKEY } from "./types.js";

export {
    StealthAddressAnnouncementError,
    StealthAddressDeriveError,
    StealthAddressError,
    StealthAddressScanIntegrityError,
    StealthAddressSchemeMismatchError,
    StealthAddressUnsupportedSchemeError,
} from "./errors.js";

export { assertCanonicalAnnouncer, CANONICAL_ANNOUNCER_ADDRESS } from "./constants.js";
