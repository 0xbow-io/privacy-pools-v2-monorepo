import { Injectable, Logger, Scope } from "@nestjs/common";
import { PubSub, Topic } from "@google-cloud/pubsub";
import type { StealthRecipientIdentifier } from "@privacy-pools-v2/dust-rescue-prover";
import type { DustAssetUsdRate } from "./dust-rescue-pricing.service";

export interface PendingDustRescue {
    sourceTxHash: string;
    fromChainId: number;
    destinationChainId: number;
    tokenId: string;
    recipientIdentifier: StealthRecipientIdentifier;
    usdRate: DustAssetUsdRate;
    /** Source-chain broadcast tx hash of dust #1's LiFi forward (dust-rescue-forwarding.service.ts),
     * if one was fired. Absent when there was no dust #1 to forward, or forwarding failed at any
     * step — in either case dust #1 simply stays at the relayer's EOA, same as before this field
     * existed (issue #222). dust-rescue-service tracks it as a second LiFi-status leg alongside
     * sourceTxHash's own, summing whichever legs resolve DONE. */
    dust1ForwardTxHash?: string;
    /** Ceiling (hex, base units of tokenId) on what dust-rescue-service may treat as dust for this
     * job: `amountOut × DUST_RESCUE_MAX_DUST_BPS`. Destination dust is a slippage-band leftover, so
     * anything larger is the principal itself (failed destination deposit, wrong token delivered)
     * and must never be auto-deposited from the shared rescue wallet (minr #2). */
    maxDustAmount?: string;
}

/** Dust ceiling as a fraction of the reshield principal: 10% is many times any real slippage band. */
export const DUST_RESCUE_MAX_DUST_BPS = 1_000n;

export function dustRescueCeiling(amountOut: bigint): bigint {
    return (amountOut * DUST_RESCUE_MAX_DUST_BPS) / 10_000n;
}

/**
 * Publishes cross-chain-reshield stealth dust rescue jobs to the standalone
 * `dust-rescue-service` (packages/relayer/dust-rescue-service) for detection, proving,
 * and submission — see dust_collection_service_design.org and
 * dust_collection_service_detailed_design.org §9.
 *
 * This used to be a singleton that tracked pending rescues in-memory and computed the
 * rescue deposit itself (`attemptRescue()`), because its chain-write needs couldn't be
 * satisfied by the relayer's request-scoped `EVMChainService`. That whole concern has
 * moved to `dust-rescue-service`, which holds its own Firestore-backed job store and
 * its own chain-write client — so this service is now a thin, ordinary, request-scoped
 * publisher, same as every other relayer service (see packages/relayer/CLAUDE.md §5).
 */
@Injectable({ scope: Scope.REQUEST })
export class DustRescueOrchestratorService {
    private readonly logger = new Logger(DustRescueOrchestratorService.name);
    private readonly topic: Topic;

    constructor() {
        const topicName = process.env.DUST_RESCUE_PUBSUB_TOPIC ?? "dust-rescue.pending";
        this.topic = new PubSub().topic(topicName);
    }

    /** Publishes a reshield submission that opted into dust rescue, keyed by its source-chain tx hash. */
    async registerPending(job: PendingDustRescue): Promise<void> {
        await this.topic.publishMessage({ json: job });
        this.logger.log(
            `Published pending dust rescue for tx ${job.sourceTxHash} -> chain ${job.destinationChainId}`,
        );
    }
}
