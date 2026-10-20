import type { StealthAnnouncementFields } from "@privacy-pools-v2/core-sdk";

import type { StealthDerivation } from "./types.js";
import { encodeViewTagAsMetadata } from "./viewTag.js";

/**
 * Bridges a sender-side {@link StealthDerivation} (from `deriveStealthAddress`) to the
 * {@link StealthAnnouncementFields} that `RelayerInteractor.relayWithAnnounce` submits, so the atomic
 * relayed stealth flow is reachable without hand-assembling the fields. Encodes the 1-byte view tag as
 * `metadata` and the numeric `schemeId` as hex; the stealth sub-package's branded `Hex`/`EvmAddress`
 * are structurally the SDK's `Hex`/`Address` (the cross-package cast is contained here so callers need
 * none). This is a type-only dependency on the SDK's relayer types — no runtime coupling (INTL-01).
 *
 * Usage: `relayWithAnnounce(relayer, { ...withdrawalRelayParams, announcement: toStealthAnnouncementFields(derivation) })`
 * where the withdrawal proof was built paying `derivation.stealthAddress`.
 */
export const toStealthAnnouncementFields = (
    derivation: StealthDerivation,
): StealthAnnouncementFields => {
    const { stealthAddress, announcement } = derivation;
    return {
        schemeId:
            `0x${announcement.schemeId.toString(16)}` as StealthAnnouncementFields["schemeId"],
        stealthAddress: stealthAddress as unknown as StealthAnnouncementFields["stealthAddress"],
        ephemeralPubKey:
            announcement.ephemeralPubKey as unknown as StealthAnnouncementFields["ephemeralPubKey"],
        metadata: encodeViewTagAsMetadata(
            announcement.viewTag,
        ) as unknown as StealthAnnouncementFields["metadata"],
    };
};
