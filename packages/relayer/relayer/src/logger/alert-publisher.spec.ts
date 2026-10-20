import { readFileSync } from "fs";
import { resolve } from "path";

const publishMessage = jest.fn();
const topic = jest.fn();

jest.mock("@google-cloud/pubsub", () => ({
    PubSub: jest.fn().mockImplementation(() => ({ topic })),
}));

type PublisherModule = typeof import("./alert-publisher");
type RedactModule = typeof import("../errors/redact");

// The publisher caches its Topic at module scope, so load a fresh copy per test. The redact module is
// loaded inside the same isolated registry, so secrets registered on it are the ones the publisher sees.
let registerKnownSecrets: RedactModule["registerKnownSecrets"] = () => undefined;
function loadPublisher(): PublisherModule {
    let mod!: PublisherModule;
    jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        registerKnownSecrets = (require("../errors/redact") as RedactModule).registerKnownSecrets;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require("./alert-publisher");
    });
    return mod;
}

const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../alert-fixtures/alert-events.json"), "utf-8")) as {
    valid: {
        severity: "turbo" | "warn";
        message: string;
        context: string;
        dedupKey: string;
        timestamp: string;
        requestId?: string;
        meta?: Record<string, unknown>;
    }[];
};

describe("alert-publisher", () => {
    const originalEnv = { ...process.env };
    let consoleError: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv, NODE_ENV: "production" };
        delete process.env.RELAYER_ALERTS_DISABLED;
        delete process.env.RELAYER_ALERTS_PUBSUB_TOPIC;
        publishMessage.mockResolvedValue("message-id");
        topic.mockReturnValue({ publishMessage });
        consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        consoleError.mockRestore();
        process.env = originalEnv;
    });

    const baseInput = { severity: "turbo" as const, message: "boom", context: "Ctx", dedupKey: "Ctx.boom" };

    it("publishes to the default topic name.", async () => {
        await loadPublisher().publishAlert(baseInput);
        expect(topic).toHaveBeenCalledWith("relayer-alerts");
        expect(publishMessage).toHaveBeenCalledTimes(1);
    });

    it("publishes to RELAYER_ALERTS_PUBSUB_TOPIC when set.", async () => {
        process.env.RELAYER_ALERTS_PUBSUB_TOPIC = "custom-alerts";
        await loadPublisher().publishAlert(baseInput);
        expect(topic).toHaveBeenCalledWith("custom-alerts");
    });

    it("creates the Topic once and reuses it.", async () => {
        const { publishAlert } = loadPublisher();
        await publishAlert(baseInput);
        await publishAlert(baseInput);
        expect(topic).toHaveBeenCalledTimes(1);
        expect(publishMessage).toHaveBeenCalledTimes(2);
    });

    it("is a no-op under NODE_ENV=test.", async () => {
        process.env.NODE_ENV = "test";
        await loadPublisher().publishAlert(baseInput);
        expect(topic).not.toHaveBeenCalled();
        expect(publishMessage).not.toHaveBeenCalled();
    });

    it("is a no-op when RELAYER_ALERTS_DISABLED=true.", async () => {
        process.env.RELAYER_ALERTS_DISABLED = "true";
        await loadPublisher().publishAlert(baseInput);
        expect(publishMessage).not.toHaveBeenCalled();
    });

    it("redacts URLs and configured secrets from message and meta.", async () => {
        const publisher = loadPublisher();
        registerKnownSecrets(["https://eth-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123"]);
        await publisher.publishAlert({
            ...baseInput,
            message: "RPC failed at https://eth-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123 badly",
            meta: { url: "https://rpc.example.com/path?apikey=SUPERSECRETKEY123", nested: { token: "SUPERSECRETKEY123" } },
        });
        const json = JSON.stringify(publishMessage.mock.calls[0][0]);
        expect(json).not.toContain("SUPERSECRETKEY123");
        expect(json).not.toContain("/v2/");
    });

    it("converts raw Error and bigint meta values to safe primitives.", async () => {
        await loadPublisher().publishAlert({ ...baseInput, meta: { err: new Error("kaput"), amount: 5n } });
        const event = publishMessage.mock.calls[0][0].json;
        expect(event.meta).toEqual({ err: "kaput", amount: "5" });
    });

    it("swallows a publish failure and reports it via console.error only.", async () => {
        publishMessage.mockRejectedValue(new Error("pubsub down"));
        await expect(loadPublisher().publishAlert(baseInput)).resolves.toBeUndefined();
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("pubsub down"));
    });

    it("flushAlerts waits for in-flight publishes.", async () => {
        let release!: () => void;
        publishMessage.mockReturnValue(new Promise<void>((r) => (release = r)));
        const { publishAlert, flushAlerts } = loadPublisher();
        void publishAlert(baseInput);
        let flushed = false;
        const flushing = flushAlerts().then(() => (flushed = true));
        await new Promise((r) => setImmediate(r));
        expect(flushed).toBe(false);
        release();
        await flushing;
        expect(flushed).toBe(true);
    });

    it("flushAlerts gives up after its timeout and never rejects.", async () => {
        publishMessage.mockReturnValue(new Promise(() => undefined));
        const { publishAlert, flushAlerts } = loadPublisher();
        void publishAlert(baseInput);
        await expect(flushAlerts(20)).resolves.toBeUndefined();
    });

    it("flushAlerts returns immediately with nothing in flight.", async () => {
        await expect(loadPublisher().flushAlerts()).resolves.toBeUndefined();
    });

    describe("shared contract fixture (alert-fixtures/alert-events.json)", () => {
        it.each(fixture.valid.map((event, i) => [i, event] as const))(
            "publishes valid fixture event #%i byte-for-byte.",
            async (_i, event) => {
                // Only Date is faked, so the stamped timestamp equals the fixture's.
                jest.useFakeTimers({
                    now: new Date(event.timestamp),
                    doNotFake: [
                        "nextTick",
                        "setImmediate",
                        "clearImmediate",
                        "setTimeout",
                        "clearTimeout",
                        "setInterval",
                        "clearInterval",
                        "queueMicrotask",
                        "hrtime",
                        "performance",
                    ],
                });
                const { timestamp: _timestamp, ...input } = event;
                await loadPublisher().publishAlert(input);
                expect(publishMessage).toHaveBeenCalledWith({ json: event });
            },
        );
    });
});
