import { BadRequestException, Body, Controller, HttpCode, Inject, Logger, Post } from "@nestjs/common";
import { JOB_STORE, JobAlreadyExistsError, type IDustRescueJobStore } from "../jobs/job-store.interface";
import { zPendingDustRescueMessage, zPubSubPushEnvelope } from "./pubsub.schemas";

/**
 * Pub/Sub push endpoint — wakes the service from zero when the relayer registers a
 * new pending rescue (dust_collection_service_detailed_design.org §7 / design doc §5).
 * Auth is Cloud Run's native IAM invoker check (the push subscription's service
 * account needs roles/run.invoker on this service) — no app-level JWT verification.
 */
@Controller("pubsub")
export class PubSubController {
    private readonly logger = new Logger(PubSubController.name);

    constructor(@Inject(JOB_STORE) private readonly jobStore: IDustRescueJobStore) {}

    @Post("pending")
    @HttpCode(204)
    async pending(@Body() body: unknown): Promise<void> {
        const envelope = zPubSubPushEnvelope.safeParse(body);
        if (!envelope.success) {
            throw new BadRequestException("Malformed Pub/Sub push envelope");
        }

        let decoded: unknown;
        try {
            decoded = JSON.parse(Buffer.from(envelope.data.message.data, "base64").toString("utf-8"));
        } catch {
            throw new BadRequestException("Pub/Sub message.data is not valid base64-encoded JSON");
        }

        const parsed = zPendingDustRescueMessage.safeParse(decoded);
        if (!parsed.success) {
            throw new BadRequestException(`Invalid pending dust rescue message: ${parsed.error.message}`);
        }
        const job = parsed.data;

        try {
            await this.jobStore.createPending(job);
            // Only the delivery that actually just created the doc advances it. A
            // redelivery lands in the catch below and must NOT run this write — the
            // job may since have progressed arbitrarily far (even to a terminal
            // state), and this call has no precondition on the state it overwrites,
            // so running it unconditionally would rewind an already-finished job
            // back to AWAITING_DESTINATION and cause the sweep to re-submit it.
            await this.jobStore.markAwaitingDestination(job.sourceTxHash);
        } catch (e: unknown) {
            if (!(e instanceof JobAlreadyExistsError)) throw e;
            // Redelivery of a job we already durably wrote — ack (204) as a genuine
            // no-op rather than erroring, matching Pub/Sub's at-least-once contract.
            this.logger.log(`Duplicate delivery for ${job.sourceTxHash}, treating as no-op`);
        }
    }
}
