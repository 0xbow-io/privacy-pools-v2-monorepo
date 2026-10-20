import { FATLogger } from "./fat.logger";
import { publishAlert } from "./alert-publisher";

jest.mock("./alert-publisher", () => ({
    publishAlert: jest.fn().mockResolvedValue(undefined),
}));

const publish = publishAlert as jest.MockedFunction<typeof publishAlert>;

// A real FATLogger: these tests prove the logger -> AlertTransport -> publishAlert wiring end to end.
describe("FATLogger alerting", () => {
    let logger: FATLogger;
    let stdout: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
        logger = new FATLogger("TestContext");
    });

    afterEach(() => stdout.mockRestore());

    it("turbo() publishes a turbo alert with the logger's context.", () => {
        logger.turbo("signer is out of gas");
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({ severity: "turbo", message: "signer is out of gas", context: "TestContext", dedupKey: "TestContext" }),
        );
    });

    it("error() with alert:true publishes a warn alert using the supplied dedupKey.", () => {
        logger.error("dust rescue failed", { alert: true, dedupKey: "dustRescue.8453" });
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({ severity: "warn", context: "TestContext", dedupKey: "dustRescue.8453" }),
        );
    });

    it("a plain error()/warn()/info() publishes nothing.", () => {
        logger.error("ordinary error");
        logger.warn("ordinary warning");
        logger.info("ordinary info");
        expect(publish).not.toHaveBeenCalled();
    });
});
