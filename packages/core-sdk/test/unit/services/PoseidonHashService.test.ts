import { describe, expect, it } from "vitest";

import { PoseidonHashService } from "../../../src/internal.js";

describe("PoseidonHashService", () => {
    describe("hash", () => {
        it("throw an error if no inputs are provided", async () => {
            const service = await PoseidonHashService.create();
            expect(() => service.hash([])).toThrow(
                "Invalid inputs: At least one input is required",
            );
        });

        it("throw an error if an invalid input is provided", async () => {
            const service = await PoseidonHashService.create();
            expect(() => service.hash(["0x1", "0x2", "0xf", "0xinvalid"])).toThrow(
                "Invalid inputs: Must represent a valid hexadecimal integer value with 0x prefix",
            );
        });

        it("hash inputs correctly", async () => {
            const service = await PoseidonHashService.create();
            const hash = service.hash(["0x1", "0x2", "0xf"]);
            expect(hash).toBe("0x004ad22dd028590cc1e4c21d1aa5c62e8f628ff65cf14e91e6d23eecff31103d");
        });

        it("hash inputs deterministically", async () => {
            const service = await PoseidonHashService.create();
            const hash1 = service.hash(["0x1", "0x2", "0xf"]);
            const hash2 = service.hash(["0x1", "0x2", "0xf"]);
            expect(hash1).toBe(hash2);
        });

        it("hash inputs case insensitively", async () => {
            const service = await PoseidonHashService.create();
            const hash1 = service.hash(["0xA", "0xABC", "0xF"]);
            const hash2 = service.hash(["0xa", "0xAbC", "0xf"]);
            expect(hash1).toBe(hash2);
        });
    });
});
