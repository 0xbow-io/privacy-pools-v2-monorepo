import { describe, expect, it } from "vitest";

import {
    KeystoreEventLogArgsSchema,
    LeavesInsertedEventArgsSchema,
} from "../../../src/internal.js";

const KEYSTORE_CAP = 2 ** 18; // 2 ** KEYSTORE_MAX_DEPTH
const STATE_CAP = 2 ** 22; // 2 ** STATE_MAX_DEPTH

describe("KeystoreEventLogArgsSchema._leafIndex bounds", () => {
    it("accept an index inside the keystore tree", () => {
        const parsed = KeystoreEventLogArgsSchema.parse({
            _leafIndex: BigInt(KEYSTORE_CAP - 1),
            _newLeaf: 1n,
        });
        expect(parsed._leafIndex).toBe(KEYSTORE_CAP - 1);
    });

    it("reject an index at or beyond the keystore tree capacity", () => {
        expect(() =>
            KeystoreEventLogArgsSchema.parse({ _leafIndex: BigInt(KEYSTORE_CAP), _newLeaf: 1n }),
        ).toThrow();
    });

    it("reject a near-MAX_SAFE_INTEGER index that would allocate a huge sparse array", () => {
        expect(() =>
            KeystoreEventLogArgsSchema.parse({
                _leafIndex: BigInt(Number.MAX_SAFE_INTEGER),
                _newLeaf: 1n,
            }),
        ).toThrow();
    });
});

describe("LeavesInsertedEventArgsSchema._startIndex bounds", () => {
    it("accept a start index inside the state tree", () => {
        const parsed = LeavesInsertedEventArgsSchema.parse({
            _newLeaves: [1n],
            _startIndex: BigInt(STATE_CAP - 1),
        });
        expect(parsed._startIndex).toBe(STATE_CAP - 1);
    });

    it("reject a start index at or beyond the state tree capacity", () => {
        expect(() =>
            LeavesInsertedEventArgsSchema.parse({
                _newLeaves: [1n],
                _startIndex: BigInt(STATE_CAP),
            }),
        ).toThrow();
    });
});
