import { Test, TestingModule } from "@nestjs/testing";
import { DustRescueOrchestratorService, dustRescueCeiling, DUST_RESCUE_MAX_DUST_BPS } from "./dust-rescue-orchestrator.service";

const publishMessage = jest.fn().mockResolvedValue("message-id");
const topic = jest.fn().mockReturnValue({ publishMessage });

jest.mock("@google-cloud/pubsub", () => ({
    PubSub: jest.fn().mockImplementation(() => ({ topic })),
}));

describe("DustRescueOrchestratorService", () => {
    let service: DustRescueOrchestratorService;

    beforeEach(async () => {
        jest.clearAllMocks();
        delete process.env.DUST_RESCUE_PUBSUB_TOPIC;

        const module: TestingModule = await Test.createTestingModule({
            providers: [DustRescueOrchestratorService],
        }).compile();

        service = await module.resolve<DustRescueOrchestratorService>(DustRescueOrchestratorService);
    });

    it("publishes to the default topic name when DUST_RESCUE_PUBSUB_TOPIC is unset.", () => {
        expect(topic).toHaveBeenCalledWith("dust-rescue.pending");
    });

    it("publishes the job as JSON, including fromChainId.", async () => {
        const job = {
            sourceTxHash: "0xabc",
            fromChainId: 42161,
            destinationChainId: 8453,
            tokenId: "0xdead",
            recipientIdentifier: { kind: "raw" as const, spendingPubKey: "0xbeef" as const },
        };

        await service.registerPending(job);

        expect(publishMessage).toHaveBeenCalledWith({ json: job });
    });
});

describe("DustRescueOrchestratorService with DUST_RESCUE_PUBSUB_TOPIC set", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.DUST_RESCUE_PUBSUB_TOPIC = "custom-topic";
    });

    afterEach(() => {
        delete process.env.DUST_RESCUE_PUBSUB_TOPIC;
    });

    it("publishes to the configured topic name instead of the default.", async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [DustRescueOrchestratorService],
        }).compile();
        await module.resolve<DustRescueOrchestratorService>(DustRescueOrchestratorService);

        expect(topic).toHaveBeenCalledWith("custom-topic");
    });

    it("dustRescueCeiling is 10% of the reshield principal (minr #2).", () => {
        expect(DUST_RESCUE_MAX_DUST_BPS).toBe(1_000n);
        expect(dustRescueCeiling(1_000_000n)).toBe(100_000n);
        expect(dustRescueCeiling(0n)).toBe(0n);
    });
});
