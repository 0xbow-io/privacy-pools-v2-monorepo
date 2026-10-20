import { BadRequestException, Body, Controller, HttpCode, Inject, Logger, Post } from "@nestjs/common";
import { CHANNELS, type IAlertChannel } from "../channel/channel.interface";
import { COOLDOWN_STORE, type IAlertCooldownStore } from "../cooldown/cooldown-store.interface";
import { zAlertEvent, zPubSubPushEnvelope } from "./pubsub.schemas";

/**
 * Pub/Sub push endpoint for relayer alerts (topic `relayer-alerts`). Auth is Cloud Run's native IAM
 * invoker check (the push subscription's service account needs roles/run.invoker on this service) —
 * no app-level JWT verification, same as dust-rescue-service.
 *
 * Status codes:
 *   204 — handled: paged, OR correctly suppressed by the cooldown (Pub/Sub must never be told to
 *         retry a message that was just correctly suppressed).
 *   400 — malformed envelope / payload (permanently undeliverable; consider a dead-letter topic).
 *   500 — a channel failed to deliver: unlike dust-rescue-service's redelivery-as-no-op, "failed to
 *         page at all" must not be dropped, so the cooldown claim is rolled back and Pub/Sub retries.
 *
 * The relayer's redaction is trusted: the dispatcher does not re-scrub alert text.
 */
@Controller("pubsub")
export class PubSubController {
    private readonly logger = new Logger(PubSubController.name);

    constructor(
        @Inject(COOLDOWN_STORE) private readonly cooldown: IAlertCooldownStore,
        @Inject(CHANNELS) private readonly channels: IAlertChannel[],
    ) {}

    @Post("alerts")
    @HttpCode(204)
    async alerts(@Body() body: unknown): Promise<void> {
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

        const parsed = zAlertEvent.safeParse(decoded);
        if (!parsed.success) {
            throw new BadRequestException(`Invalid alert event: ${parsed.error.message}`);
        }
        const event = parsed.data;

        const claim = await this.cooldown.tryAcquire(event);
        if (!claim) {
            this.logger.log(`Alert ${event.dedupKey} suppressed by cooldown`);
            return;
        }

        try {
            await Promise.all(this.channels.map((channel) => channel.send(event)));
        } catch (e) {
            // Roll back so the redelivery isn't suppressed by this failed attempt's claim. (With several
            // channels a redelivery re-sends to the ones that already succeeded — acceptable for paging.)
            await this.cooldown.release(event, claim).catch((releaseError: unknown) => {
                this.logger.error(`Failed to release cooldown claim for ${event.dedupKey}: ${String(releaseError)}`);
            });
            this.logger.error(`Failed to deliver alert ${event.dedupKey}: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }
        this.logger.log(`Delivered ${event.severity} alert ${event.dedupKey}`);
    }
}
