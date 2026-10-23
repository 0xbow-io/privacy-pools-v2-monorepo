import { readFileSync } from "fs";
import { resolve } from "path";

const publishMessage = jest.fn();
const topic = jest.fn();

jest.mock("@google-cloud/pubsub", () => ({
    PubSub: jest.fn().mockImplementation(() => ({ topic })),
}));

type PublisherModule = typeof import("./report-publisher");
type RedactModule = typeof import("../errors/redact");

// The publisher caches its Topic at module scope, so load a fresh copy per test. The redact module
// is loaded inside the same isolated registry, so secrets registered on it are the ones the
// publisher sees — same pattern as logger/alert-publisher.spec.ts.
let registerKnownSecrets: RedactModule["registerKnownSecrets"] = () => undefined;
function loadPublisher(): PublisherModule {
    let mod!: PublisherModule;
    jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        registerKnownSecrets = (require("../errors/redact") as RedactModule).registerKnownSecrets;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require("./report-publisher");
    });
    return mod;
}

const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../alert-fixtures/report-events.json"), "utf-8")) as {
    valid: { command: "native_asset_balances" | "current_profit_margins"; status: "ok" | "error"; text: string; requestId: string; timestamp: string }[];
};

describe("report-publisher", () => {
    const originalEnv = { ...process.env };
    let consoleError: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv, NODE_ENV: "production" };
        delete process.env.RELAYER_REPORTS_DISABLED;
        delete process.env.RELAYER_REPORTS_PUBSUB_TOPIC;
        publishMessage.mockResolvedValue("message-id");
        topic.mockReturnValue({ publishMessage });
        consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        consoleError.mockRestore();
        process.env = originalEnv;
    });

    const baseInput = { command: "native_asset_balances" as const, status: "ok" as const, text: "EVM chain 1: 1.0 ETH", requestId: "req-1" };

    it("publishes to the default topic name.", async () => {
        await loadPublisher().publishReport(baseInput);
        expect(topic).toHaveBeenCalledWith("relayer-reports");
        expect(publishMessage).toHaveBeenCalledTimes(1);
    });

    it("publishes to RELAYER_REPORTS_PUBSUB_TOPIC when set.", async () => {
        process.env.RELAYER_REPORTS_PUBSUB_TOPIC = "custom-reports";
        await loadPublisher().publishReport(baseInput);
        expect(topic).toHaveBeenCalledWith("custom-reports");
    });

    it("creates the Topic once and reuses it.", async () => {
        const { publishReport } = loadPublisher();
        await publishReport(baseInput);
        await publishReport(baseInput);
        expect(topic).toHaveBeenCalledTimes(1);
        expect(publishMessage).toHaveBeenCalledTimes(2);
    });

    it("is a no-op under NODE_ENV=test.", async () => {
        process.env.NODE_ENV = "test";
        await loadPublisher().publishReport(baseInput);
        expect(topic).not.toHaveBeenCalled();
    });

    it("is a no-op when RELAYER_REPORTS_DISABLED=true.", async () => {
        process.env.RELAYER_REPORTS_DISABLED = "true";
        await loadPublisher().publishReport(baseInput);
        expect(publishMessage).not.toHaveBeenCalled();
    });

    it("redacts configured secrets from the report text.", async () => {
        const publisher = loadPublisher();
        registerKnownSecrets(["https://eth-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123"]);
        await publisher.publishReport({ ...baseInput, text: "RPC failed at https://eth-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123 badly" });
        const json = JSON.stringify(publishMessage.mock.calls[0][0]);
        expect(json).not.toContain("SUPERSECRETKEY123");
    });

    it("swallows a publish failure and reports it via console.error only.", async () => {
        publishMessage.mockRejectedValue(new Error("pubsub down"));
        await expect(loadPublisher().publishReport(baseInput)).resolves.toBeUndefined();
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("pubsub down"));
    });

    it("flushReports waits for in-flight publishes.", async () => {
        let release!: () => void;
        publishMessage.mockReturnValue(new Promise<void>((r) => (release = r)));
        const { publishReport, flushReports } = loadPublisher();
        void publishReport(baseInput);
        let flushed = false;
        const flushing = flushReports().then(() => (flushed = true));
        await new Promise((r) => setImmediate(r));
        expect(flushed).toBe(false);
        release();
        await flushing;
        expect(flushed).toBe(true);
    });

    it("flushReports returns immediately with nothing in flight.", async () => {
        await expect(loadPublisher().flushReports()).resolves.toBeUndefined();
    });

    describe("shared contract fixture (alert-fixtures/report-events.json)", () => {
        it.each(fixture.valid.map((event, i) => [i, event] as const))("publishes valid fixture event #%i byte-for-byte.", async (_i, event) => {
            jest.useFakeTimers({
                now: new Date(event.timestamp),
                doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "hrtime", "performance"],
            });
            const { timestamp: _timestamp, ...input } = event;
            await loadPublisher().publishReport(input);
            expect(publishMessage).toHaveBeenCalledWith({ json: event });
        });
    });
});
