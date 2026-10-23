import { BadRequestException, Body, Controller, HttpCode, Logger, Post } from "@nestjs/common";
import { TelegramChannel } from "../channel/telegram.channel";
import { zReportEvent, zPubSubPushEnvelope } from "./pubsub.schemas";

/**
 * Pub/Sub push endpoint for on-demand report results (topic `relayer-reports`), the reverse
 * direction of the alert path: an operator asks the relayer a question via Telegram
 * (`/native_asset_balances`, `/current_profit_margins`), the relayer gathers the (read-only) answer
 * and publishes it here, and this delivers it to the same Telegram chat alerts already page into.
 * See `docs/tech-design/relayer/relayer-reports.md`.
 *
 * Auth is Cloud Run's native IAM invoker check, exactly like `/pubsub/alerts` — no app-level JWT
 * verification, and no change at all to this service's ingress (still `--no-allow-unauthenticated`,
 * still zero public routes). The only new public surface this feature introduces lives on the
 * relayer (`POST /telegram/webhook`), not here.
 *
 * Status codes:
 *   204 — delivered to Telegram (even a `status: "error"` report still gets delivered — the operator
 *         should see that the gather partially or fully failed, not silence).
 *   400 — malformed envelope / payload (permanently undeliverable).
 *   500 — Telegram delivery failed: Pub/Sub retries. Unlike alerts there is no cooldown claim to
 *         roll back — reports aren't rate-limited, a redelivery is just a harmless duplicate message.
 */
@Controller("pubsub")
export class ReportsController {
    private readonly logger = new Logger(ReportsController.name);

    constructor(private readonly telegram: TelegramChannel) {}

    @Post("reports")
    @HttpCode(204)
    async reports(@Body() body: unknown): Promise<void> {
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

        const parsed = zReportEvent.safeParse(decoded);
        if (!parsed.success) {
            throw new BadRequestException(`Invalid report event: ${parsed.error.message}`);
        }
        const event = parsed.data;

        try {
            await this.telegram.sendReport(event);
        } catch (e) {
            this.logger.error(`Failed to deliver report ${event.requestId}: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }
        this.logger.log(`Delivered ${event.command} report ${event.requestId} (${event.status})`);
    }
}
