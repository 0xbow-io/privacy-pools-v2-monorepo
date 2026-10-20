import { installBigIntJson } from "./bigint-json";

describe("installBigIntJson", () => {
    it("serializes bigints as decimal strings, including values past Number.MAX_SAFE_INTEGER", () => {
        installBigIntJson();

        expect(JSON.stringify({ wei: 80_000_000_000_000_000n, zero: 0n })).toBe(
            '{"wei":"80000000000000000","zero":"0"}'
        );
    });
});
