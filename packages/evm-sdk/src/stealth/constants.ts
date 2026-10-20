import type { EvmAddress } from "./types.js";
import { StealthAddressAnnouncementError } from "./errors.js";

/**
 * STLTH-20: canonical ERC-5564 Announcer.
 *
 * Deployed via the deterministic CREATE2 deployer `0x4e59b44847b379578588920ca78fbf26c0b4956c`
 * at the SAME address on every chain that supports the standard (Mainnet, Sepolia, Base,
 * Arbitrum, Optimism, Polygon, ...). All EIP-5564 traffic flows through this single instance;
 * using a different address narrows the anonymity set to "users of that other deployment" and
 * is therefore a STLTH-20 violation.
 *
 * VERIFIED (L-1, 2026-07-09) against the EIP-5564 spec's deployment section and the on-chain
 * ScopeLift `ERC5564Announcer` singleton on Etherscan — this checksums to
 * `0x55649E01B5Df198D18D95b5cc5051630cfD45564`.
 * Reference: https://eips.ethereum.org/EIPS/eip-5564 (Deployment Method) ·
 * https://etherscan.io/address/0x55649E01B5Df198D18D95b5cc5051630cfD45564
 */
export const CANONICAL_ANNOUNCER_ADDRESS =
    "0x55649e01b5df198d18d95b5cc5051630cfd45564" as EvmAddress;

/**
 * STLTH-20 enforcement helper. Throws if the caller hands us an announcer
 * address other than the canonical CREATE2 deployment.
 */
export const assertCanonicalAnnouncer = (announcer: EvmAddress): void => {
    if (announcer.toLowerCase() !== CANONICAL_ANNOUNCER_ADDRESS.toLowerCase()) {
        throw new StealthAddressAnnouncementError(
            `STLTH-20: announcer address must be the canonical EIP-5564 deployment ` +
                `(${CANONICAL_ANNOUNCER_ADDRESS}); got ${announcer}. Targeting any other ` +
                `Announcer narrows the anonymity set and is refused by the SDK.`,
        );
    }
};
