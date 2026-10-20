import { BadRequestException } from "@nestjs/common";
import { mock } from "jest-mock-extended";
import type { IAlertChannel } from "../channel/channel.interface";
import type { CooldownClaim, IAlertCooldownStore } from "../cooldown/cooldown-store.interface";
import { PubSubController } from "./pubsub.controller";
import type { AlertEvent } from "./pubsub.schemas";

const EVENT: AlertEvent = {
    severity: "turbo",
    message: "Signer wallet is out of gas funds",
    context: "EVMChainService",
    dedupKey: "EVMChainService.signerOutOfGas.8453",
    timestamp: "2026-10-16T12:00:00.000Z",
};
const CLAIM: CooldownClaim = { claimedAt: 5, previousLastSentAt: 0 };

const envelope = (payload: unknown) => ({ message: { data: Buffer.from(JSON.stringify(payload)).toString("base64") } });

describe("PubSubController", () => {
    let cooldown: ReturnType<typeof mock<IAlertCooldownStore>>;
    let channelA: ReturnType<typeof mock<IAlertChannel>>;
    let channelB: ReturnType<typeof mock<IAlertChannel>>;
    let controller: PubSubController;

    beforeEach(() => {
        cooldown = mock<IAlertCooldownStore>();
        channelA = mock<IAlertChannel>();
        channelB = mock<IAlertChannel>();
        cooldown.tryAcquire.mockResolvedValue(CLAIM);
        cooldown.release.mockResolvedValue(undefined);
        channelA.send.mockResolvedValue(undefined);
        channelB.send.mockResolvedValue(undefined);
        controller = new PubSubController(cooldown, [channelA, channelB]);
    });

    describe("malformed input -> 400, nothing sent", () => {
        it.each([
            ["a non-object body", "nope"],
            ["an envelope without message.data", { message: {} }],
        ])("rejects %s.", async (_d, body) => {
            await expect(controller.alerts(body)).rejects.toThrow(BadRequestException);
            expect(cooldown.tryAcquire).not.toHaveBeenCalled();
        });

        it("rejects data that is not base64 JSON.", async () => {
            const body = { message: { data: Buffer.from("not json {").toString("base64") } };
            await expect(controller.alerts(body)).rejects.toThrow(/not valid base64-encoded JSON/);
            expect(cooldown.tryAcquire).not.toHaveBeenCalled();
        });

        it("rejects JSON that is not an AlertEvent.", async () => {
            await expect(controller.alerts(envelope({ severity: "turbo" }))).rejects.toThrow(/Invalid alert event/);
            expect(cooldown.tryAcquire).not.toHaveBeenCalled();
            expect(channelA.send).not.toHaveBeenCalled();
        });
    });

    it("sends to every channel and resolves (204) when the cooldown grants the alert.", async () => {
        await expect(controller.alerts(envelope(EVENT))).resolves.toBeUndefined();

        expect(cooldown.tryAcquire).toHaveBeenCalledWith(EVENT);
        expect(channelA.send).toHaveBeenCalledWith(EVENT);
        expect(channelB.send).toHaveBeenCalledWith(EVENT);
        expect(cooldown.release).not.toHaveBeenCalled();
    });

    it("resolves (204) WITHOUT sending when the alert is within its cooldown.", async () => {
        cooldown.tryAcquire.mockResolvedValue(undefined);

        await expect(controller.alerts(envelope(EVENT))).resolves.toBeUndefined();

        expect(channelA.send).not.toHaveBeenCalled();
        expect(channelB.send).not.toHaveBeenCalled();
    });

    it("rethrows (-> 500, Pub/Sub redelivers) and rolls back the claim when a channel fails.", async () => {
        channelA.send.mockRejectedValue(new Error("Telegram sendMessage failed: HTTP 502"));

        await expect(controller.alerts(envelope(EVENT))).rejects.toThrow("HTTP 502");

        expect(cooldown.release).toHaveBeenCalledWith(EVENT, CLAIM);
    });

    it("still rethrows the delivery error if releasing the claim also fails.", async () => {
        channelA.send.mockRejectedValue(new Error("Telegram down"));
        cooldown.release.mockRejectedValue(new Error("firestore down"));

        await expect(controller.alerts(envelope(EVENT))).rejects.toThrow("Telegram down");
    });

    it("propagates a cooldown-store failure (-> 500) without sending.", async () => {
        cooldown.tryAcquire.mockRejectedValue(new Error("firestore unavailable"));

        await expect(controller.alerts(envelope(EVENT))).rejects.toThrow("firestore unavailable");
        expect(channelA.send).not.toHaveBeenCalled();
    });
});

// Regression: the redelivery after a failed send must page, even though the failed attempt had claimed the key.
describe("PubSubController redelivery after a failed send", () => {
    it("pages on the retry because the failed attempt's claim was rolled back.", async () => {
        let lastSentAt = 0;
        const store: IAlertCooldownStore = {
            tryAcquire: async () => {
                if (lastSentAt !== 0) return undefined; // inside the window
                lastSentAt = 100;
                return { claimedAt: 100, previousLastSentAt: 0 };
            },
            release: async (_event, claim) => {
                if (lastSentAt === claim.claimedAt) lastSentAt = claim.previousLastSentAt;
            },
        };
        const channel = mock<IAlertChannel>();
        channel.send.mockRejectedValueOnce(new Error("Telegram 502")).mockResolvedValue(undefined);
        const controller = new PubSubController(store, [channel]);

        await expect(controller.alerts(envelope(EVENT))).rejects.toThrow("Telegram 502");
        await expect(controller.alerts(envelope(EVENT))).resolves.toBeUndefined(); // the redelivery
        await expect(controller.alerts(envelope(EVENT))).resolves.toBeUndefined(); // a later repeat: suppressed

        expect(channel.send).toHaveBeenCalledTimes(2); // failed attempt + the retry; the repeat is suppressed
    });
});
