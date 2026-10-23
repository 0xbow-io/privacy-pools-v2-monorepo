import { parseCommand, zTelegramUpdate } from "./telegram-update.schemas";

describe("parseCommand", () => {
    // Regression: a plain-object lookup resolved these inherited Object.prototype keys to truthy
    // functions, so "/constructor" passed as a command and triggered a full profitability scan.
    it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])("rejects inherited key /%s", (word) => {
        expect(parseCommand(`/${word}`)).toBeNull();
    });

    it("parse a slash-prefixed known command with no arguments", () => {
        expect(parseCommand("/native_asset_balances")).toEqual({ command: "native_asset_balances", args: [] });
    });

    it("parse a bare (no slash) known command", () => {
        expect(parseCommand("current_profit_margins")).toEqual({ command: "current_profit_margins", args: [] });
    });

    it("capture trailing tokens as args without interpreting them", () => {
        expect(parseCommand("/current_profit_margins 5 1,56")).toEqual({
            command: "current_profit_margins",
            args: ["5", "1,56"],
        });
    });

    it("return null for an unknown command", () => {
        expect(parseCommand("/drop_table_users")).toBeNull();
    });

    it("map the /profiterol alias to current_profit_margins", () => {
        expect(parseCommand("/profiterol")).toEqual({ command: "current_profit_margins", args: [] });
    });

    it("keep the /current_profit_margins trigger working alongside the alias", () => {
        expect(parseCommand("/current_profit_margins")).toEqual({ command: "current_profit_margins", args: [] });
    });

    it("return null for an empty string", () => {
        expect(parseCommand("")).toBeNull();
    });

    it("trim surrounding whitespace before parsing", () => {
        expect(parseCommand("  /native_asset_balances  ")).toEqual({ command: "native_asset_balances", args: [] });
    });
});

describe("zTelegramUpdate", () => {
    it("accept a minimal valid update with a text message", () => {
        const result = zTelegramUpdate.safeParse({
            update_id: 1,
            message: { message_id: 2, chat: { id: 123 }, text: "/native_asset_balances" },
        });
        expect(result.success).toBe(true);
    });

    it("accept an update with no message (e.g. edited_message-only payloads)", () => {
        const result = zTelegramUpdate.safeParse({ update_id: 1 });
        expect(result.success).toBe(true);
    });

    it("reject a payload missing update_id", () => {
        const result = zTelegramUpdate.safeParse({ message: { message_id: 2, chat: { id: 123 } } });
        expect(result.success).toBe(false);
    });

    it("reject a message missing chat.id", () => {
        const result = zTelegramUpdate.safeParse({ update_id: 1, message: { message_id: 2, chat: {} } });
        expect(result.success).toBe(false);
    });
});
