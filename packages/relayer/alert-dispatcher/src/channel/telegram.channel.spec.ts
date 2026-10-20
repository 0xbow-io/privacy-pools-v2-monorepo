import { mock } from "jest-mock-extended";
import type { AlertDispatcherConfigService } from "../config/alert-dispatcher-config.service";
import type { AlertEvent } from "../pubsub/pubsub.schemas";
import { TelegramChannel, escapeHtml, formatAlert } from "./telegram.channel";

const TOKEN = "123456:SECRET-BOT-TOKEN";
const event = (overrides: Partial<AlertEvent> = {}): AlertEvent => ({
    severity: "turbo",
    message: "Signer wallet is out of gas funds",
    context: "EVMChainService",
    dedupKey: "EVMChainService.signerOutOfGas.8453",
    timestamp: "2026-10-16T12:00:00.000Z",
    ...overrides,
});

describe("TelegramChannel", () => {
    let channel: TelegramChannel;
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
        const config = mock<AlertDispatcherConfigService>();
        config.telegramBotToken.mockReturnValue(TOKEN);
        config.telegramChatId.mockReturnValue("-100123");
        channel = new TelegramChannel(config);
        fetchSpy = jest.spyOn(globalThis, "fetch");
    });

    afterEach(() => fetchSpy.mockRestore());

    it("POSTs to the Bot API sendMessage endpoint with chat_id, HTML text and parse_mode.", async () => {
        fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

        await channel.send(event());

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
        expect(init.method).toBe("POST");
        const body = JSON.parse(init.body as string);
        expect(body.chat_id).toBe("-100123");
        expect(body.parse_mode).toBe("HTML");
        expect(body.text).toContain("🔴");
        expect(body.text).toContain("CRITICAL");
        expect(body.text).toContain("EVMChainService");
        expect(body.text).toContain("Signer wallet is out of gas funds");
    });

    it("uses the WARN prefix for warn alerts.", async () => {
        fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
        await channel.send(event({ severity: "warn" }));
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string).text).toContain("🟡 <b>WARN</b>");
    });

    it("throws on a non-2xx response, with the status and Telegram's description but never the token.", async () => {
        fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 }));

        const error = await channel.send(event()).catch((e: Error) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("HTTP 400");
        expect((error as Error).message).toContain("chat not found");
        expect((error as Error).message).not.toContain(TOKEN);
    });

    it("throws on a non-JSON error body using the status alone.", async () => {
        fetchSpy.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
        await expect(channel.send(event())).rejects.toThrow("Telegram sendMessage failed: HTTP 502");
    });

    it("throws on a network error without leaking the token.", async () => {
        fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
        const error = await channel.send(event()).catch((e: Error) => e);
        expect((error as Error).message).toBe("Telegram request failed: fetch failed");
        expect((error as Error).message).not.toContain(TOKEN);
    });
});

describe("formatAlert", () => {
    it("escapes HTML in context, message, dedupKey and requestId.", () => {
        const text = formatAlert(event({ context: "<ctx>", message: "a < b && c > d", requestId: "<r>" }));
        expect(text).not.toContain("<ctx>");
        expect(text).toContain("&lt;ctx&gt;");
        expect(text).toContain("a &lt; b &amp;&amp; c &gt; d");
        expect(text).toContain("req &lt;r&gt;");
    });

    it("stays within Telegram's 4096-character limit by shortening the message.", () => {
        const text = formatAlert(event({ message: "x".repeat(10_000) }));
        expect(text.length).toBeLessThanOrEqual(4096);
        expect(text).toContain("…");
        expect(text).toContain("<i>"); // the footer survives
    });
});

describe("escapeHtml", () => {
    it("escapes &, < and >.", () => {
        expect(escapeHtml("<a>&</a>")).toBe("&lt;a&gt;&amp;&lt;/a&gt;");
    });
});
