import { BadRequestException } from "@nestjs/common";
import { mock } from "jest-mock-extended";
import { TelegramChannel } from "../channel/telegram.channel";
import { ReportsController } from "./reports.controller";
import type { ReportEvent } from "./pubsub.schemas";

const EVENT: ReportEvent = {
    command: "native_asset_balances",
    status: "ok",
    text: "EVM chain 1: 1.2345 ETH",
    requestId: "req-abc123",
    timestamp: "2026-10-22T12:00:00.000Z",
};

const envelope = (payload: unknown) => ({ message: { data: Buffer.from(JSON.stringify(payload)).toString("base64") } });

describe("ReportsController", () => {
    let telegram: ReturnType<typeof mock<TelegramChannel>>;
    let controller: ReportsController;

    beforeEach(() => {
        telegram = mock<TelegramChannel>();
        telegram.sendReport.mockResolvedValue(undefined);
        controller = new ReportsController(telegram);
    });

    describe("malformed input -> 400, nothing sent", () => {
        it.each([
            ["a non-object body", "nope"],
            ["an envelope without message.data", { message: {} }],
        ])("rejects %s.", async (_d, body) => {
            await expect(controller.reports(body)).rejects.toThrow(BadRequestException);
            expect(telegram.sendReport).not.toHaveBeenCalled();
        });

        it("rejects data that is not base64 JSON.", async () => {
            const body = { message: { data: Buffer.from("not json {").toString("base64") } };
            await expect(controller.reports(body)).rejects.toThrow(/not valid base64-encoded JSON/);
        });

        it("rejects JSON that is not a ReportEvent.", async () => {
            await expect(controller.reports(envelope({ command: "native_asset_balances" }))).rejects.toThrow(/Invalid report event/);
            expect(telegram.sendReport).not.toHaveBeenCalled();
        });

        it("rejects an unknown command.", async () => {
            await expect(controller.reports(envelope({ ...EVENT, command: "drop_table" }))).rejects.toThrow(BadRequestException);
        });
    });

    it("delivers an ok report to Telegram and resolves (204).", async () => {
        await expect(controller.reports(envelope(EVENT))).resolves.toBeUndefined();
        expect(telegram.sendReport).toHaveBeenCalledWith(EVENT);
    });

    it("still delivers an error-status report — the operator must see a partial failure, not silence.", async () => {
        const errorEvent: ReportEvent = { ...EVENT, status: "error", text: "EVM chain 1: rpc down" };
        await expect(controller.reports(envelope(errorEvent))).resolves.toBeUndefined();
        expect(telegram.sendReport).toHaveBeenCalledWith(errorEvent);
    });

    it("rethrows (-> 500, Pub/Sub redelivers) when Telegram delivery fails. No cooldown to roll back.", async () => {
        telegram.sendReport.mockRejectedValue(new Error("Telegram sendMessage failed: HTTP 502"));
        await expect(controller.reports(envelope(EVENT))).rejects.toThrow("HTTP 502");
    });
});
