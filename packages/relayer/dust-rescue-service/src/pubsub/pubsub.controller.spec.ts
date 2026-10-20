import { BadRequestException } from "@nestjs/common";
import { mock } from "jest-mock-extended";
import { PubSubController } from "./pubsub.controller";
import { JobAlreadyExistsError, type IDustRescueJobStore } from "../jobs/job-store.interface";

const JOB = {
    sourceTxHash: "0xabc",
    fromChainId: 1,
    destinationChainId: 8453,
    tokenId: "0x0000000000000000000000000000000000000aaa",
    recipientIdentifier: { kind: "raw" as const, spendingPubKey: "0xdead" as const },
    usdRate: { source: "Curve" as const, microUsdPerWholeTokenX1e18: "0x1" as const, tokenDecimals: 18 },
};

function envelope(payload: unknown) {
    return {
        message: {
            data: Buffer.from(JSON.stringify(payload)).toString("base64"),
            messageId: "1",
            publishTime: "2026-08-17T00:00:00Z",
        },
        subscription: "projects/p/subscriptions/s",
    };
}

describe("PubSubController", () => {
    let jobStore: ReturnType<typeof mock<IDustRescueJobStore>>;
    let controller: PubSubController;

    beforeEach(() => {
        jobStore = mock<IDustRescueJobStore>();
        controller = new PubSubController(jobStore);
    });

    it("creates a job and advances it to AWAITING_DESTINATION on a valid envelope.", async () => {
        await controller.pending(envelope(JOB));

        expect(jobStore.createPending).toHaveBeenCalledWith(JOB);
        expect(jobStore.markAwaitingDestination).toHaveBeenCalledWith("0xabc");
    });

    it("throws BadRequestException on a malformed envelope (not the expected Pub/Sub shape).", async () => {
        await expect(controller.pending({ not: "an envelope" })).rejects.toThrow(BadRequestException);
        expect(jobStore.createPending).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when message.data isn't valid base64 JSON.", async () => {
        await expect(
            controller.pending({ message: { data: "not-base64-json!!!" } })
        ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when the decoded payload fails schema validation.", async () => {
        await expect(controller.pending(envelope({ ...JOB, destinationChainId: "not-a-number" }))).rejects.toThrow(
            BadRequestException
        );
    });

    it("treats a duplicate delivery (JobAlreadyExistsError) as a genuine no-op — does NOT advance the job's state.", async () => {
        jobStore.createPending.mockRejectedValue(new JobAlreadyExistsError("0xabc"));

        await expect(controller.pending(envelope(JOB))).resolves.toBeUndefined();
        expect(jobStore.markAwaitingDestination).not.toHaveBeenCalled();
    });

    it("rethrows a non-duplicate createPending error (so Pub/Sub retries).", async () => {
        const err = new Error("firestore unavailable");
        jobStore.createPending.mockRejectedValue(err);

        await expect(controller.pending(envelope(JOB))).rejects.toBe(err);
        expect(jobStore.markAwaitingDestination).not.toHaveBeenCalled();
    });
});
