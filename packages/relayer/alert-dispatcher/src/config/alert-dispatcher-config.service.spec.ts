import { AlertDispatcherConfigService } from "./alert-dispatcher-config.service";

describe("AlertDispatcherConfigService", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, TELEGRAM_BOT_TOKEN: "123:secret-token", TELEGRAM_CHAT_ID: "-100123" };
        delete process.env.ALERT_COOLDOWN_SECONDS;
        delete process.env.ALERT_COOLDOWN_COLLECTION;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it("reads the required variables and applies defaults (15 min cooldown, relayerAlertCooldowns).", () => {
        const config = new AlertDispatcherConfigService();
        expect(config.telegramBotToken()).toBe("123:secret-token");
        expect(config.telegramChatId()).toBe("-100123");
        expect(config.cooldownMs()).toBe(900_000);
        expect(config.cooldownCollection()).toBe("relayerAlertCooldowns");
    });

    it("honours ALERT_COOLDOWN_SECONDS and ALERT_COOLDOWN_COLLECTION.", () => {
        process.env.ALERT_COOLDOWN_SECONDS = "60";
        process.env.ALERT_COOLDOWN_COLLECTION = "customCollection";
        const config = new AlertDispatcherConfigService();
        expect(config.cooldownMs()).toBe(60_000);
        expect(config.cooldownCollection()).toBe("customCollection");
    });

    it("fails fast, naming the variable but never leaking values, when a required variable is missing.", () => {
        delete process.env.TELEGRAM_CHAT_ID;
        expect(() => new AlertDispatcherConfigService()).toThrow(/TELEGRAM_CHAT_ID/);
        try {
            new AlertDispatcherConfigService();
        } catch (e) {
            expect(String(e)).not.toContain("secret-token");
        }
    });

    it("rejects a non-numeric cooldown.", () => {
        process.env.ALERT_COOLDOWN_SECONDS = "soon";
        expect(() => new AlertDispatcherConfigService()).toThrow(/ALERT_COOLDOWN_SECONDS/);
    });
});
