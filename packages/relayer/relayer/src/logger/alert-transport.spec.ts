import { AlertTransport, classifyAlert, stripAlertMarkers } from "./alert-transport";
import { publishAlert } from "./alert-publisher";

jest.mock("./alert-publisher", () => ({
    publishAlert: jest.fn().mockResolvedValue(undefined),
}));

const publish = publishAlert as jest.MockedFunction<typeof publishAlert>;

function logThrough(info: Record<string, unknown>): jest.Mock {
    const callback = jest.fn();
    new AlertTransport().log(info, callback);
    return callback;
}

describe("AlertTransport", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("publishes a turbo record as severity turbo, with context and requestId.", () => {
        const callback = logThrough({ level: "turbo", message: "out of gas", context: "EVMChainService", requestId: "r1" });
        expect(publish).toHaveBeenCalledWith({
            severity: "turbo",
            message: "out of gas",
            context: "EVMChainService",
            dedupKey: "EVMChainService",
            requestId: "r1",
        });
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it("publishes an error record carrying alert:true as severity warn, with its dedupKey.", () => {
        logThrough({ level: "error", message: "dust failed", context: "EvmRelayService", alert: true, dedupKey: "dustRescue.8453" });
        expect(publish).toHaveBeenCalledWith({
            severity: "warn",
            message: "dust failed",
            context: "EvmRelayService",
            dedupKey: "dustRescue.8453",
        });
    });

    it("lets an explicit dedupKey override the default on a turbo record.", () => {
        logThrough({ level: "turbo", message: "m", context: "C", dedupKey: "C.custom.1" });
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ dedupKey: "C.custom.1" }));
    });

    it("falls back to context 'unknown' when there is none.", () => {
        logThrough({ level: "turbo", message: "m" });
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ context: "unknown", dedupKey: "unknown" }));
    });

    it("forwards remaining meta but not reserved or marker keys.", () => {
        logThrough({ level: "turbo", message: "m", context: "C", timestamp: "t", alert: true, dedupKey: "k", chainId: 1, extra: { a: 1 } });
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ meta: { chainId: 1, extra: { a: 1 } } }));
    });

    it.each(["error", "warn", "info", "debug", "verbose"])("ignores a plain %s record.", (level) => {
        const callback = logThrough({ level, message: "m", context: "C" });
        expect(publish).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it("does not treat alert:'true' (non-boolean) as the marker.", () => {
        logThrough({ level: "error", message: "m", alert: "true" });
        expect(publish).not.toHaveBeenCalled();
    });

    it("never throws out of log() and always invokes the callback when publishAlert throws.", () => {
        const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
        publish.mockImplementationOnce(() => {
            throw new Error("bug");
        });
        const callback = logThrough({ level: "turbo", message: "m", context: "C" });
        expect(callback).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("bug"));
        consoleError.mockRestore();
    });
});

describe("classifyAlert", () => {
    it("classifies by level and marker.", () => {
        expect(classifyAlert({ level: "turbo" })).toBe("turbo");
        expect(classifyAlert({ level: "error", alert: true })).toBe("warn");
        expect(classifyAlert({ level: "turbo", alert: true })).toBe("turbo");
        expect(classifyAlert({ level: "error" })).toBeUndefined();
    });
});

describe("stripAlertMarkers", () => {
    it("removes the marker keys and keeps everything else.", () => {
        const info = { level: "error", message: "m", alert: true, dedupKey: "k", chainId: 1 };
        const out = stripAlertMarkers().transform({ ...info }, {});
        expect(out).toEqual({ level: "error", message: "m", chainId: 1 });
    });
});
