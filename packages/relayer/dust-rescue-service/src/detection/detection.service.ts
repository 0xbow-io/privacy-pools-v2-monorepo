import { Injectable, Logger } from "@nestjs/common";
import { LiFiSwapQuoteProvider, SwapStatusFailed, type SwapStatusResult } from "@privacy-pools-v2/evm-sdk";
import { createPublicClient, http, TransactionReceiptNotFoundError, type Hex } from "viem";
import { DustRescueConfigService } from "../config/dust-rescue-config.service";
import type { DustRescueJob } from "../jobs/job.types";

export type DetectionResult =
    | { outcome: "WAIT" }
    | { outcome: "FAILED"; reason: string }
    | { outcome: "READY"; sweptAmount: bigint; receivingTxHash: Hex; dust1ReceivingTxHash?: Hex };

type LegResult =
    | { outcome: "WAIT" }
    | { outcome: "FAILED"; reason: string }
    | { outcome: "DONE"; amount: bigint; receivingTxHash: Hex };

/**
 * Detects whether a job's dust has landed and is ready to deposit, per
 * dust_collection_service_detailed_design.org §4a and issue #222
 * (dust_unification_feasibility_and_plan.org): poll LiFi's own status API keyed by a tx
 * hash (not balance-polling — can't disambiguate concurrent jobs at the same rescue
 * address), then read the swept amount directly off LiFi's own `receiving.amount` —
 * asset-agnostic (works identically for ERC-20 and native ETH), no on-chain log
 * decoding. A cheap receipt-status check guards against LiFi reporting DONE for a
 * transaction that actually reverted.
 *
 * Cross-chain jobs track up to two independent legs this way: the always-present
 * destination-chain leftover off `job.sourceTxHash` ("dust #2"), and, when the relayer
 * forwarded source-chain swap-input dust, a second leg off `job.dust1ForwardTxHash`
 * ("dust #1"). Never balance-based, even with two legs landing at the same shared wallet
 * address — each leg is read off its own specific LiFi status, so there's no ambiguity
 * about which job an inbound transfer belongs to.
 *
 * Same-chain jobs (`fromChainId === destinationChainId`) skip `job.sourceTxHash`
 * entirely — see `checkSameChain`.
 */
@Injectable()
export class DetectionService {
    private readonly logger = new Logger(DetectionService.name);
    private readonly lifi = new LiFiSwapQuoteProvider({ apiKey: process.env.LIFI_API_KEY });

    constructor(private readonly config: DustRescueConfigService) {}

    async check(job: DustRescueJob): Promise<DetectionResult> {
        if (job.fromChainId === job.destinationChainId) {
            return this.checkSameChain(job);
        }

        const leg2 = await this.checkLeg(job.sourceTxHash, job.fromChainId, job.destinationChainId, job.createdAt);
        if (leg2.outcome === "WAIT") return { outcome: "WAIT" };
        if (leg2.outcome === "FAILED") return { outcome: "FAILED", reason: leg2.reason };

        let sweptAmount = leg2.amount;
        let dust1ReceivingTxHash: Hex | undefined;

        if (job.dust1ForwardTxHash) {
            const leg1 = await this.checkLeg(
                job.dust1ForwardTxHash,
                job.fromChainId,
                job.destinationChainId,
                job.createdAt
            );
            if (leg1.outcome === "WAIT") {
                // Don't advance off AWAITING_DESTINATION until dust #1 resolves too —
                // once PROVING captures sweptAmount, there's no mechanism to add more
                // to an already-built deposit. Re-checked next sweep.
                return { outcome: "WAIT" };
            }
            if (leg1.outcome === "DONE") {
                sweptAmount += leg1.amount;
                dust1ReceivingTxHash = leg1.receivingTxHash;
            }
            // leg1 FAILED: not fatal to the job — dust #1 simply contributes nothing,
            // dust #2 alone still rescues fine (issue #222's "additive, never worse"
            // requirement).
        }

        return { outcome: "READY", sweptAmount, receivingTxHash: leg2.receivingTxHash, dust1ReceivingTxHash };
    }

    /**
     * A same-chain reshield sweeps its leftover synchronously into `job.sourceTxHash`
     * itself — there is no separate destination-chain arrival to await, so polling LiFi's
     * bridge-status API for that hash (the cross-chain "leg 2") is the wrong tool: at best
     * it resolves to the reshield's own main swap delivery, not the dust left over from
     * it. `job.dust1ForwardTxHash`, when present, is still a genuine LiFi swap
     * (`DustRescueForwardingService.forward()` routes source-chain swap-input dust through
     * LiFi even when source and destination chain match), so it stays on the LiFi-status
     * leg check unchanged — and since it's the only leg a same-chain job has, its failure
     * fails the job outright, unlike a cross-chain job's non-fatal leg 1.
     *
     * `_sweepDust` also sweeps output-token and native-ETH balance deltas to
     * `dustRecipient`, but only the swap-input pool has a forwarding path (`forward()`)
     * into the shared rescue wallet — the other two are out of scope here, same boundary
     * this file already draws around native-ETH dust #1.
     */
    private async checkSameChain(job: DustRescueJob): Promise<DetectionResult> {
        if (!job.dust1ForwardTxHash) {
            return { outcome: "READY", sweptAmount: 0n, receivingTxHash: job.sourceTxHash };
        }
        const leg1 = await this.checkLeg(
            job.dust1ForwardTxHash,
            job.fromChainId,
            job.destinationChainId,
            job.createdAt
        );
        if (leg1.outcome === "WAIT") return { outcome: "WAIT" };
        if (leg1.outcome === "FAILED") return { outcome: "FAILED", reason: leg1.reason };
        return { outcome: "READY", sweptAmount: leg1.amount, receivingTxHash: leg1.receivingTxHash };
    }

    private async checkLeg(txHash: Hex, fromChainId: number, toChainId: number, createdAt: number): Promise<LegResult> {
        let status: SwapStatusResult;
        try {
            status = await this.lifi.getSwapStatus({ txHash, fromChainId, toChainId });
        } catch (e: unknown) {
            if (e instanceof SwapStatusFailed && e.retryable) {
                // Transient upstream fault (429/5xx, or a plain not-yet-indexed 404) —
                // don't let it consume a sweep attempt via recordFailure, just retry
                // next pass (finding #10, Problem C).
                return { outcome: "WAIT" };
            }
            throw e;
        }

        if (status.status === "INVALID") {
            // LiFi's own terminal verdict for an unrecognized/expired transfer — unlike
            // NOT_FOUND below, this never resolves with more waiting, so it doesn't need
            // (or get) the age-out treatment.
            return { outcome: "FAILED", reason: "INVALID: unrecognized or expired transfer" };
        }
        if (status.status === "PENDING") {
            return { outcome: "WAIT" };
        }
        if (status.status === "NOT_FOUND") {
            // Genuine NOT_FOUND ages out on the job's own age (not `attempts`, which a
            // WAIT outcome never increments) — indexing lag is normal for a while, but a
            // hash LiFi never recognizes shouldn't consume sweeps forever.
            if (Date.now() - createdAt > this.config.notFoundAgeOutMs()) {
                return { outcome: "FAILED", reason: "gave up waiting for the bridge to recognize this transfer" };
            }
            return { outcome: "WAIT" };
        }
        if (status.status === "FAILED") {
            return { outcome: "FAILED", reason: status.substatus ?? "FAILED" };
        }

        // status.status === "DONE" — but DONE alone is not "delivered as requested" (minr #2).
        // LiFi's DONE substatus is COMPLETED for a clean delivery, PARTIAL when the
        // destination contract call failed or a different token was delivered (the
        // Executor then drops the WHOLE bridged principal at the fallback, our shared
        // rescue wallet), and REFUNDED when the funds went back on the source chain.
        // Reading `receiving.amount` off either of those would turn a user's principal
        // into a "dust" deposit sized off the shared wallet, or chase a source-chain tx
        // on the destination client. Both are operator work, never an automatic rescue.
        if (status.substatus !== undefined && status.substatus !== "COMPLETED") {
            const reason = `DONE/${status.substatus}: not a clean delivery, needs manual handling`;
            this.logger.error(
                `PRINCIPAL_MAY_BE_STRANDED tx ${txHash} (${fromChainId} -> ${toChainId}): ${reason}; ` +
                    `receiving=${JSON.stringify(status.receiving ?? null)}`
            );
            return { outcome: "FAILED", reason };
        }
        if (!status.receiving?.txHash || !status.receiving?.amount) {
            // DONE but LiFi hasn't fully populated the record yet — retry next sweep.
            return { outcome: "WAIT" };
        }
        if (status.receiving.chainId !== undefined && status.receiving.chainId !== toChainId) {
            const reason = `receiving leg landed on chain ${status.receiving.chainId}, expected ${toChainId}`;
            this.logger.error(`PRINCIPAL_MAY_BE_STRANDED tx ${txHash}: ${reason}`);
            return { outcome: "FAILED", reason };
        }

        let amount: bigint;
        try {
            amount = BigInt(status.receiving.amount);
        } catch {
            return {
                outcome: "FAILED",
                reason: `Malformed receiving.amount: ${status.receiving.amount}`,
            };
        }
        if (amount === 0n) {
            return { outcome: "FAILED", reason: "DONE but reported amount is 0" };
        }

        // Cheap, asset-agnostic sanity gate: confirms the tx LiFi points at actually
        // succeeded on-chain, without decoding anything asset-specific out of it.
        const rpcUrl = this.config.chain(toChainId).rpcUrl;
        const client = createPublicClient({ transport: http(rpcUrl) });
        let receipt: { status: string };
        try {
            receipt = await client.getTransactionReceipt({ hash: status.receiving.txHash });
        } catch (e: unknown) {
            if (e instanceof TransactionReceiptNotFoundError) {
                // LiFi is ahead of our RPC's view of the destination chain — retry next sweep.
                return { outcome: "WAIT" };
            }
            throw e;
        }
        if (receipt.status !== "success") {
            this.logger.warn(
                `Tx ${txHash}: LiFi reports DONE but receiving.txHash ${status.receiving.txHash} reverted on-chain`
            );
            return {
                outcome: "FAILED",
                reason: `receiving.txHash ${status.receiving.txHash} reverted on-chain`,
            };
        }

        return { outcome: "DONE", amount, receivingTxHash: status.receiving.txHash };
    }
}
