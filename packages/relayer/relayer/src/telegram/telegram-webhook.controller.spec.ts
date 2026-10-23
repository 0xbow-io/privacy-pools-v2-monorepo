import { Test, TestingModule } from "@nestjs/testing";
import { mock } from "jest-mock-extended";
import { TelegramWebhookController } from "./telegram-webhook.controller";
import { TelegramConfigService } from "./telegram-config.service";
import { ReportsService } from "../report/reports.service";
import { createMockLoggerProvider } from "../test/mocks";

const SECRET = "s3cr3t-token";
const CHAT_ID = "-100123456789";

function validUpdate(text: string) {
    return { update_id: 1, message: { message_id: 2, chat: { id: Number(CHAT_ID) }, text } };
}

describe("TelegramWebhookController", () => {
    let controller: TelegramWebhookController;
    const config = mock<TelegramConfigService>();
    const reports = mock<ReportsService>();

    beforeEach(async () => {
        jest.clearAllMocks();
        jest.useRealTimers();
        config.isConfigured.mockReturnValue(true);
        config.webhookSecret.mockReturnValue(SECRET);
        config.authorizedChatId.mockReturnValue(CHAT_ID);
        reports.handle.mockResolvedValue(undefined);

        const module: TestingModule = await Test.createTestingModule({
            controllers: [TelegramWebhookController],
            providers: [
                { provide: TelegramConfigService, useValue: config },
                { provide: ReportsService, useValue: reports },
                createMockLoggerProvider(),
            ],
        }).compile();

        controller = module.get(TelegramWebhookController);
    });

    it("dispatch a recognized command to ReportsService with no arguments", async () => {
        await controller.webhook(SECRET, validUpdate("/native_asset_balances"));
        await Promise.resolve();

        expect(reports.handle).toHaveBeenCalledWith("native_asset_balances", []);
    });

    it("pass through any trailing arguments unparsed", async () => {
        await controller.webhook(SECRET, validUpdate("/current_profit_margins 5"));
        await Promise.resolve();

        expect(reports.handle).toHaveBeenCalledWith("current_profit_margins", ["5"]);
    });

    it("do nothing when the secret token is missing", async () => {
        await controller.webhook(undefined, validUpdate("/native_asset_balances"));
        expect(reports.handle).not.toHaveBeenCalled();
    });

    it("do nothing when the secret token does not match", async () => {
        await controller.webhook("wrong-token", validUpdate("/native_asset_balances"));
        expect(reports.handle).not.toHaveBeenCalled();
    });

    it("do nothing when the secret token has a different length (no timingSafeEqual crash)", async () => {
        await expect(controller.webhook("short", validUpdate("/native_asset_balances"))).resolves.toBeUndefined();
        expect(reports.handle).not.toHaveBeenCalled();
    });

    it("do nothing when the Telegram webhook is not configured", async () => {
        config.isConfigured.mockReturnValue(false);
        await controller.webhook(SECRET, validUpdate("/native_asset_balances"));
        expect(reports.handle).not.toHaveBeenCalled();
    });

    it("do nothing when the chat id is not the authorized one", async () => {
        await controller.webhook(SECRET, { update_id: 1, message: { message_id: 2, chat: { id: 1 }, text: "/native_asset_balances" } });
        expect(reports.handle).not.toHaveBeenCalled();
    });

    it("do nothing for an update with no message text", async () => {
        await controller.webhook(SECRET, { update_id: 1 });
        expect(reports.handle).not.toHaveBeenCalled();
    });

    it("do nothing for an unrecognized command", async () => {
        await controller.webhook(SECRET, validUpdate("/drop_everything"));
        expect(reports.handle).not.toHaveBeenCalled();
    });

    it("do nothing for a malformed body", async () => {
        await controller.webhook(SECRET, { not: "a telegram update" });
        expect(reports.handle).not.toHaveBeenCalled();
    });

    it("enforce a per-command cooldown so a repeated command within the window is ignored", async () => {
        await controller.webhook(SECRET, validUpdate("/native_asset_balances"));
        await controller.webhook(SECRET, validUpdate("/native_asset_balances"));
        await Promise.resolve();

        expect(reports.handle).toHaveBeenCalledTimes(1);
    });

    it("not block the webhook response on a slow ReportsService.handle", async () => {
        let resolveHandle!: () => void;
        reports.handle.mockReturnValue(new Promise((resolve) => (resolveHandle = resolve)));

        await expect(controller.webhook(SECRET, validUpdate("/current_profit_margins"))).resolves.toBeUndefined();
        resolveHandle();
    });
});
