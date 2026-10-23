import { describe, expect, it } from "vitest";
import {
    RelayerQuoteUnavailable,
    RelayerRequestFailed,
} from "../../../src/errors/RelayerInteractor.js";
import { settleRelayerQuotes } from "../../../src/utils/RelayerQuotes.js";

const message =
    "Your funds are safe. The relayer is having issues. Try again later.";

describe("quote outage fan-out", () => {
    const relayers = [{ name: "one" }, { name: "two" }];

    it("keeps the short message and all causes when every relayer is unavailable", async () => {
        const first = new RelayerQuoteUnavailable(
            503,
            new Error("server diagnostic"),
        );
        const second = new RelayerQuoteUnavailable(
            502,
            new Error("proxy diagnostic"),
        );
        const error = await settleRelayerQuotes(relayers, async (relayer) => {
            throw relayer.name === "one" ? first : second;
        }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RelayerQuoteUnavailable);
        expect(error).toBeInstanceOf(RelayerRequestFailed);
        expect(error).toMatchObject({ message, status: 503 });
        expect(
            ((error as RelayerQuoteUnavailable).cause as AggregateError).errors,
        ).toEqual([first, second]);
    });

    it("does not mask validation failures as a confirmed outage", async () => {
        const error = await settleRelayerQuotes(relayers, async (relayer) => {
            if (relayer.name === "one")
                throw new RelayerQuoteUnavailable(503, new Error("server"));
            throw new RelayerRequestFailed("invalid withdrawal amount");
        }).catch((e: unknown) => e);
        expect(error).not.toBeInstanceOf(RelayerQuoteUnavailable);
        expect((error as Error).message).toContain("invalid withdrawal amount");
    });

    it("uses the healthy relayer without retrying the unavailable one", async () => {
        let calls = 0;
        const result = await settleRelayerQuotes(relayers, async (relayer) => {
            calls += 1;
            if (relayer.name === "one")
                throw new RelayerQuoteUnavailable(503, new Error("server"));
            return { fee: "123" };
        });
        expect(result).toEqual([{ fee: "123" }]);
        expect(calls).toBe(2);
    });

    it("keeps empty configuration behavior", async () => {
        expect(await settleRelayerQuotes([], async () => "unused")).toEqual([]);
    });
});
