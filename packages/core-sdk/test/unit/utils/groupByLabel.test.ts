import { describe, expect, it } from "vitest";

import { groupByLabel, Label } from "../../../src/internal.js";

const LABEL_A = "0x1111111111111111111111111111111111111111111111111111111111111111" as Label;
const LABEL_B = "0x2222222222222222222222222222222222222222222222222222222222222222" as Label;

describe("groupByLabel", () => {
    it("group items sharing a label into the same bucket", () => {
        const items = [
            { label: LABEL_A, n: 1 },
            { label: LABEL_B, n: 2 },
            { label: LABEL_A, n: 3 },
        ];

        const grouped = groupByLabel(items);

        expect(grouped.get(LABEL_A)).toEqual([
            { label: LABEL_A, n: 1 },
            { label: LABEL_A, n: 3 },
        ]);
        expect(grouped.get(LABEL_B)).toEqual([{ label: LABEL_B, n: 2 }]);
    });

    it("preserve first-occurrence order of labels", () => {
        const grouped = groupByLabel([
            { label: LABEL_B, n: 1 },
            { label: LABEL_A, n: 2 },
        ]);
        expect([...grouped.keys()]).toEqual([LABEL_B, LABEL_A]);
    });

    // Labels come from discovered on-chain notes. On a plain `{}` accumulator a label of
    // "__proto__" or "constructor" collides with an inherited prototype member: the bucket
    // lookup returns a non-array and the push throws, blocking the victim from spending. A Map
    // keys on the raw value, so these are ordinary keys.
    it("group reserved-name labels without crashing", () => {
        const items = [
            { label: "__proto__" as Label, n: 1 },
            { label: "constructor" as Label, n: 2 },
            { label: "prototype" as Label, n: 3 },
            { label: "__proto__" as Label, n: 4 },
        ];

        const grouped = groupByLabel(items);

        expect(grouped.get("__proto__" as Label)).toEqual([
            { label: "__proto__", n: 1 },
            { label: "__proto__", n: 4 },
        ]);
        expect(grouped.get("constructor" as Label)).toEqual([{ label: "constructor", n: 2 }]);
        expect(grouped.get("prototype" as Label)).toEqual([{ label: "prototype", n: 3 }]);
    });

    it("leave Object.prototype unpolluted after grouping a __proto__ label", () => {
        groupByLabel([{ label: "__proto__" as Label, n: 1 }]);

        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.prototype).not.toHaveProperty("n");
    });
});
