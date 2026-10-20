import type { EvmCall } from "./announce.js";
import type { StealthWithdrawalBundle } from "./bundle.js";
import type { RecipientIdentifier } from "./resolve.js";
import type { EvmAddress, SchemeId } from "./types.js";
import { composeWithdrawalBundle } from "./bundle.js";
import { deriveStealthAddress, generateEphemeralKeyPair } from "./derive.js";
import { resolveRecipient } from "./resolve.js";

/**
 * Caller-supplied PP withdraw-call generator. Given a stealth EVM address
 * (the destination), the caller returns the proof-bearing `EvmCall` to the
 * PoolVault that withdraws funds there. The orchestrator does NOT decode or
 * inspect the calldata; it trusts the caller to bind the stealth address
 * into the proof's public signals.
 *
 * STLTH-04 (no PP-contract changes) means the orchestrator can't synthesize
 * the proof itself; PP's existing SDK is the only party that knows the
 * withdrawal arg layout for any given pool. So this is a callback.
 */
export type WithdrawCallGenerator = (stealthAddress: EvmAddress) => Promise<EvmCall> | EvmCall;

/**
 * Input to `prepareStealthWithdrawal`.
 *
 * - `recipient`           - identifier resolved to a MetaAddress via `resolveRecipient`
 * - `generateWithdrawCall` - caller-supplied PP withdraw proof generator
 * - `announcerAddress`    - the deployed ERC-5564 Announcer contract address
 * - `schemeId`            - OPTIONAL. If passed, defensive check against
 *   `resolveRecipient(recipient).scheme`; mismatch hard-errors (STLTH-19).
 *   If omitted, the resolved meta-address's declared scheme is used.
 *
 * STLTH-13 / v5 audit ENTROPY-08: the orchestrator does NOT accept a
 * caller-supplied ephemeral keypair. A caller passing a deterministic /
 * reused keypair would silently collapse the unlinkability property. Tests
 * that need a fixed ephemeral should call the low-level `deriveStealthAddress`
 * directly (which exposes the seam) and bypass this orchestrator.
 */
export interface StealthWithdrawalRequest {
    readonly recipient: RecipientIdentifier;
    readonly generateWithdrawCall: WithdrawCallGenerator;
    readonly announcerAddress: EvmAddress;
    readonly schemeId?: SchemeId;
}

/**
 * Top-level orchestrator for the SDK's stealth-withdrawal flow.
 *
 * Sequence (DESIGN.md §4):
 *   1. Resolve the recipient identifier to a MetaAddress.
 *   2. Generate (or accept) a CSPRNG-fresh ephemeral keypair.
 *   3. Derive the stealth address + announcement payload.
 *   4. Ask the caller for the PP withdraw call bound to that destination.
 *   5. Compose the atomic (withdraw, announce) bundle. STLTH-18 binding
 *      check runs in `composeWithdrawalBundle`.
 *   6. Return the bundle. Caller hands it to the relayer.
 *
 * STLTH-14: the returned bundle never contains the recipient meta-address.
 * The orchestrator passes `metaAddress` to `deriveStealthAddress` and drops
 * its reference; downstream functions only see the stealth address.
 */
export const prepareStealthWithdrawal = async (
    request: StealthWithdrawalRequest,
): Promise<StealthWithdrawalBundle> => {
    const metaAddress = resolveRecipient(request.recipient);
    // v6: the scheme is determined by the resolved meta-address, not a separate
    // caller argument. The caller's optional `schemeId` is a defensive sanity
    // check; if present, it must match the meta-address's declared scheme
    // (STLTH-19). `deriveStealthAddress` enforces the same check internally.
    const scheme = request.schemeId ?? metaAddress.scheme;
    // STLTH-13: the orchestrator's ephemeral is always CSPRNG-fresh + matches
    // the scheme's announcement format (compressed for canonical, uncompressed
    // for FluidKey).
    const ephemeral = generateEphemeralKeyPair(scheme);
    const { stealthAddress, announcement } = deriveStealthAddress(metaAddress, ephemeral, scheme);
    const withdrawCall = await request.generateWithdrawCall(stealthAddress);
    return composeWithdrawalBundle(
        {
            to: withdrawCall.to,
            data: withdrawCall.data,
            declaredDestination: stealthAddress,
        },
        announcement,
        request.announcerAddress,
    );
};
