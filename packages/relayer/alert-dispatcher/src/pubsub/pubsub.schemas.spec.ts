import { readFileSync } from "fs";
import { resolve } from "path";
import { zAlertEvent, zPubSubPushEnvelope } from "./pubsub.schemas";

// Shared contract fixture: the relayer's alert-publisher.spec.ts asserts publishAlert produces the
// `valid` events; this spec asserts the dispatcher accepts them and rejects the `invalid` ones.
const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../alert-fixtures/alert-events.json"), "utf-8")) as {
    valid: unknown[];
    invalid: { description: string; value: unknown }[];
};

describe("zAlertEvent (shared contract fixture)", () => {
    it("has fixtures to check.", () => {
        expect(fixture.valid.length).toBeGreaterThan(0);
        expect(fixture.invalid.length).toBeGreaterThan(0);
    });

    it.each(fixture.valid.map((event, i) => [i, event] as const))("accepts valid fixture event #%i unchanged.", (_i, event) => {
        const parsed = zAlertEvent.safeParse(event);
        expect(parsed.success).toBe(true);
        expect(parsed.data).toEqual(event);
    });

    it.each(fixture.invalid.map((entry) => [entry.description, entry.value] as const))("rejects invalid fixture event: %s.", (_d, value) => {
        expect(zAlertEvent.safeParse(value).success).toBe(false);
    });
});

describe("zPubSubPushEnvelope", () => {
    it("accepts a standard push envelope.", () => {
        expect(zPubSubPushEnvelope.safeParse({ message: { data: "e30=", messageId: "1" }, subscription: "s" }).success).toBe(true);
    });

    it.each([{}, { message: {} }, { message: { data: 5 } }, null, "x"])("rejects a malformed envelope %j.", (body) => {
        expect(zPubSubPushEnvelope.safeParse(body).success).toBe(false);
    });
});
