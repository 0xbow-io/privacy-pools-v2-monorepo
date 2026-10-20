import { Inject, Injectable, Logger } from "@nestjs/common";
import { proveDustRescueDeposit } from "@privacy-pools-v2/dust-rescue-prover";
import { DustRescueConfigService } from "../config/dust-rescue-config.service";
import { DetectionService } from "../detection/detection.service";
import { ChainWriteService } from "../chain-write/chain-write.service";
import { JOB_STORE, type IDustRescueJobStore } from "../jobs/job-store.interface";
import type { DustRescueJob } from "../jobs/job.types";
import { sweptAmountUsdMicros } from "./usd-worth";

/**
 * Walks every non-terminal job and advances each exactly one state
 * (dust_collection_service_detailed_design.org §6 / design doc §4). Jobs are processed
 * SEQUENTIALLY, never `Promise.all` — every rescue signs with the one Child 1 key
 * shared across every destination chain, so parallelizing would race nonces globally,
 * not just per-address.
 */
@Injectable()
export class SweepService {
    private readonly logger = new Logger(SweepService.name);

    constructor(
        @Inject(JOB_STORE) private readonly jobStore: IDustRescueJobStore,
        private readonly detection: DetectionService,
        private readonly chainWrite: ChainWriteService,
        private readonly config: DustRescueConfigService
    ) {}

    async run(): Promise<{ processed: number }> {
        const jobs = await this.jobStore.listNonTerminal(this.config.sweepBatchSize());
        for (const job of jobs) {
            await this.advance(job).catch((e: unknown) => this.recordFailure(job, e));
        }
        return { processed: jobs.length };
    }

    private async advance(job: DustRescueJob): Promise<void> {
        switch (job.state) {
            // PENDING is only ever a transient state written by the pubsub controller,
            // which immediately advances it to AWAITING_DESTINATION itself. The sweep
            // should never observe a job still in PENDING; if it does (a crash between
            // the controller's two writes), treat it identically rather than adding a
            // third code path.
            case "PENDING":
            case "AWAITING_DESTINATION":
                return this.handleAwaitingDestination(job);
            case "PROVING":
                return this.handleProving(job);
            case "SUBMITTING":
                return this.handleSubmitting(job);
            case "SUBMITTED":
                return this.handleSubmitted(job);
            default:
                return;
        }
    }

    private async handleAwaitingDestination(job: DustRescueJob): Promise<void> {
        const result = await this.detection.check(job);
        if (result.outcome === "WAIT") {
            // Bump updatedAt even though nothing else changed — round-robin fairness
            // (finding #10, Problem A) depends on every examined job's updatedAt
            // advancing, WAIT included, or a job that never resolves would keep the
            // oldest updatedAt forever and monopolize the front of listNonTerminal's
            // queue.
            await this.jobStore.touch(job.sourceTxHash);
            return;
        }
        if (result.outcome === "FAILED") {
            await this.jobStore.update(job.sourceTxHash, { state: "FAILED", lastError: result.reason });
            return;
        }

        // A swept amount above the ceiling the relayer derived from the reshield's own
        // principal is not dust — it is the principal (failed destination deposit, wrong
        // token delivered). Never deposit that automatically from the shared wallet (minr #2).
        if (job.maxDustAmount !== undefined && result.sweptAmount > BigInt(job.maxDustAmount)) {
            const reason =
                `swept ${result.sweptAmount} exceeds the dust ceiling ${BigInt(job.maxDustAmount)} — ` +
                `this is a stranded principal, not dust; needs manual handling`;
            this.logger.error(`PRINCIPAL_MAY_BE_STRANDED job ${job.sourceTxHash}: ${reason}`);
            await this.jobStore.update(job.sourceTxHash, {
                state: "FAILED",
                lastError: reason,
                sweptAmount: toHex(result.sweptAmount),
                receivingTxHash: result.receivingTxHash,
            });
            return;
        }
        // Pure arithmetic against the rate the relayer already priced at registration
        // time (§4b) — no RPC call, no RateProviderService here.
        const usdMicros = sweptAmountUsdMicros(result.sweptAmount, job.usdRate);
        const minWorthUsdMicros = this.config.minWorthUsdMicros(job.destinationChainId);
        const common = {
            sweptAmount: toHex(result.sweptAmount),
            receivingTxHash: result.receivingTxHash,
            sweptAmountUsdMicros: toHex(usdMicros),
            ...(result.dust1ReceivingTxHash ? { dust1ReceivingTxHash: result.dust1ReceivingTxHash } : {}),
        };

        // Nothing was actually swept (same-chain job with no dust1ForwardTxHash — see
        // DetectionService.checkSameChain) — terminal unconditionally, independent of
        // minWorthUsdMicros. A threshold configured to 0 would otherwise let this fall through
        // to PROVING and attempt to prove/submit a zero-value deposit.
        if (result.sweptAmount === 0n) {
            await this.jobStore.update(job.sourceTxHash, { state: "BELOW_THRESHOLD", ...common });
            return;
        }

        if (usdMicros < minWorthUsdMicros) {
            await this.jobStore.update(job.sourceTxHash, { state: "BELOW_THRESHOLD", ...common });
            return;
        }

        await this.jobStore.update(job.sourceTxHash, { state: "PROVING", ...common });
    }

    private async handleProving(job: DustRescueJob): Promise<void> {
        if (!job.sweptAmount) {
            await this.recordFailure(job, new Error("PROVING job has no sweptAmount recorded"));
            return;
        }
        const chainCfg = this.config.chain(job.destinationChainId);
        try {
            const result = await proveDustRescueDeposit(
                {
                    destinationChainId: job.destinationChainId,
                    tokenId: job.tokenId,
                    sweptAmount: job.sweptAmount,
                    recipientIdentifier: job.recipientIdentifier,
                },
                {
                    rpcUrl: chainCfg.rpcUrl,
                    aspUrl: chainCfg.aspUrl,
                    circuitArtifactsDir: chainCfg.circuitArtifactsDir,
                    deployment: chainCfg.deployment,
                }
            );
            // Recorded BEFORE signing anything — a crash between "built the call" and
            // "confirmed it landed" must not cause a double-submit on retry.
            await this.jobStore.update(job.sourceTxHash, {
                state: "SUBMITTING",
                depositCalldata: result.depositCallData,
                depositTarget: result.depositTarget,
                depositMsgValue: result.depositMsgValue,
                approvalTx: result.approvalTx,
                approvalTxs: result.approvalTxs,
            });
        } catch (e: unknown) {
            await this.recordFailure(job, e);
        }
    }

    private async handleSubmitting(job: DustRescueJob): Promise<void> {
        if (!job.depositCalldata || !job.depositTarget || !job.depositMsgValue) {
            await this.recordFailure(job, new Error("SUBMITTING job is missing recorded deposit calldata"));
            return;
        }

        // Independent backstop: a job that already recorded a depositTxHash has
        // already been broadcast once. Re-broadcasting would pay the rescued amount
        // a second time out of the shared signer wallet, so refuse rather than send —
        // this should be unreachable in normal operation, but costs nothing to check.
        if (job.depositTxHash) {
            await this.recordFailure(
                job,
                new Error(
                    `SUBMITTING job already has depositTxHash ${job.depositTxHash} recorded, refusing to re-deposit`
                )
            );
            return;
        }

        // Ordered approvals (minr #28): a zero reset then the real approval on a residual
        // allowance. Each hash is recorded before the next send so a crash cannot double-send.
        // Jobs recorded before `approvalTxs` existed fall back to the single `approvalTx`.
        const approvals = job.approvalTxs ?? (job.approvalTx ? [job.approvalTx] : []);
        const sentHashes = job.approvalTxHashes ?? (job.approvalTxHash ? [job.approvalTxHash] : []);
        for (let i = sentHashes.length; i < approvals.length; i++) {
            const approvalTxHash = await this.chainWrite.approve(job.destinationChainId, approvals[i]!);
            sentHashes.push(approvalTxHash);
            await this.jobStore.update(job.sourceTxHash, {
                approvalTxHashes: [...sentHashes],
                ...(i === approvals.length - 1 ? { approvalTxHash } : {}),
            });
        }

        const depositTxHash = await this.chainWrite.deposit(
            job.destinationChainId,
            job.depositTarget,
            job.depositCalldata,
            job.depositMsgValue
        );
        await this.jobStore.update(job.sourceTxHash, { state: "SUBMITTED", depositTxHash });
    }

    private async handleSubmitted(job: DustRescueJob): Promise<void> {
        if (!job.depositTxHash) {
            await this.recordFailure(job, new Error("SUBMITTED job has no depositTxHash recorded"));
            return;
        }
        const receipt = await this.chainWrite.waitForReceipt(job.destinationChainId, job.depositTxHash);
        if (!receipt) {
            await this.jobStore.touch(job.sourceTxHash); // Not mined yet — retried next sweep, same fairness reasoning as above.
            return;
        }
        if (receipt.status === "success") {
            await this.jobStore.update(job.sourceTxHash, { state: "CONFIRMED" });
        } else {
            await this.jobStore.update(job.sourceTxHash, {
                state: "FAILED",
                lastError: `Deposit tx ${job.depositTxHash} reverted`,
            });
        }
    }

    private async recordFailure(job: DustRescueJob, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = job.attempts + 1;
        this.logger.error(`Job ${job.sourceTxHash} attempt ${attempts} failed: ${message}`);
        if (attempts >= this.config.sweepMaxAttempts()) {
            await this.jobStore.update(job.sourceTxHash, { state: "FAILED", attempts, lastError: message });
        } else {
            await this.jobStore.update(job.sourceTxHash, { attempts, lastError: message });
        }
    }
}

function toHex(v: bigint): `0x${string}` {
    return `0x${v.toString(16)}`;
}
