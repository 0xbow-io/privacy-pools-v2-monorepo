import { z } from "zod";
import { zEvmAddress, zHexString } from "../config/config.schemas";

const zStealthRecipientIdentifier = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("raw"), spendingPubKey: zHexString }),
    z.object({ kind: z.literal("canonical"), spendingPubKey: zHexString, viewingPubKey: zHexString }),
]);

/**
 * The dust asset's USD price, computed once by the relayer at registration time via its
 * own RateProviderService (see dust_collection_service_detailed_design.org §4b) —
 * dust-rescue-service never calls that service itself, only does arithmetic against
 * this once `sweptAmount` is known. See job.types.ts's `DustAssetUsdRate` for the exact
 * arithmetic `microUsdPerWholeTokenX1e18` is meant for.
 */
const zDustAssetUsdRate = z.object({
    source: z.enum(["Curve", "Cowswap"]),
    microUsdPerWholeTokenX1e18: zHexString,
    tokenDecimals: z.number().int().nonnegative(),
});

/**
 * The pending-rescue job message the relayer's DustRescueOrchestratorService
 * publishes to the `dust-rescue.pending` Pub/Sub topic (see
 * dust_collection_service_detailed_design.org §9). `fromChainId` is server-derived on
 * the relayer side, not client wire data — see design doc §3's note that it's
 * "trivially available at registration time."
 */
export const zPendingDustRescueMessage = z.object({
    sourceTxHash: zHexString,
    fromChainId: z.number().int().positive(),
    destinationChainId: z.number().int().positive(),
    tokenId: zEvmAddress,
    recipientIdentifier: zStealthRecipientIdentifier,
    usdRate: zDustAssetUsdRate,
    // Source-chain swap-input dust ("dust #1") forward tx hash, if the relayer fired
    // one — see dust-rescue-orchestrator.service.ts's PendingDustRescue and issue #222.
    dust1ForwardTxHash: zHexString.optional(),
    // Dust ceiling in base units (hex) — see job.types.ts `maxDustAmount` (minr #2).
    maxDustAmount: zHexString.optional(),
});

export type PendingDustRescueMessage = z.infer<typeof zPendingDustRescueMessage>;

/** Standard Pub/Sub push subscription envelope shape. */
export const zPubSubPushEnvelope = z.object({
    message: z.object({
        data: z.string(), // base64
        messageId: z.string().optional(),
        publishTime: z.string().optional(),
    }),
    subscription: z.string().optional(),
});
