import { describe, expect, it, vi } from "vitest";

import type { Hash, Hex, IPoolVaultInteractor } from "../../../src/internal.js";
import { lookupCommitmentTimestamp, resolveCommitmentTimestamp } from "../../../src/internal.js";

const COMMITMENT = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hash;
const TIMESTAMP = "0x0000000000000000000000000000000000000000000000000000000067890abc" as Hex;
const ZERO = "0x0" as Hex;

function makeInteractor(impl: () => Promise<Hex>): IPoolVaultInteractor {
    return { getCommitmentTimestamp: vi.fn(impl) } as unknown as IPoolVaultInteractor;
}

describe("resolveCommitmentTimestamp", () => {
    it("return timestamp on first attempt", async () => {
        const interactor = makeInteractor(async () => TIMESTAMP);
        const result = await resolveCommitmentTimestamp(interactor, COMMITMENT, {
            backoffMs: 0,
        });
        expect(result).toBe(TIMESTAMP);
        expect(interactor.getCommitmentTimestamp).toHaveBeenCalledTimes(1);
    });

    it("retry on transient zero and succeed", async () => {
        let calls = 0;
        const interactor = makeInteractor(async () => {
            calls++;
            return calls === 1 ? ZERO : TIMESTAMP;
        });
        const result = await resolveCommitmentTimestamp(interactor, COMMITMENT, {
            backoffMs: 0,
        });
        expect(result).toBe(TIMESTAMP);
        expect(interactor.getCommitmentTimestamp).toHaveBeenCalledTimes(2);
    });

    it("retry on thrown error and succeed", async () => {
        let calls = 0;
        const interactor = makeInteractor(async () => {
            calls++;
            if (calls === 1) throw new Error("RPC down");
            return TIMESTAMP;
        });
        const result = await resolveCommitmentTimestamp(interactor, COMMITMENT, {
            backoffMs: 0,
        });
        expect(result).toBe(TIMESTAMP);
        expect(interactor.getCommitmentTimestamp).toHaveBeenCalledTimes(2);
    });

    it("return null after maxAttempts of zeros", async () => {
        const interactor = makeInteractor(async () => ZERO);
        const result = await resolveCommitmentTimestamp(interactor, COMMITMENT, {
            backoffMs: 0,
            maxAttempts: 3,
        });
        expect(result).toBeNull();
        expect(interactor.getCommitmentTimestamp).toHaveBeenCalledTimes(3);
    });

    it("return null after maxAttempts of throws", async () => {
        const interactor = makeInteractor(async () => {
            throw new Error("always fails");
        });
        const result = await resolveCommitmentTimestamp(interactor, COMMITMENT, {
            backoffMs: 0,
            maxAttempts: 3,
        });
        expect(result).toBeNull();
        expect(interactor.getCommitmentTimestamp).toHaveBeenCalledTimes(3);
    });

    it("respect maxAttempts override", async () => {
        const interactor = makeInteractor(async () => ZERO);
        await resolveCommitmentTimestamp(interactor, COMMITMENT, {
            backoffMs: 0,
            maxAttempts: 1,
        });
        expect(interactor.getCommitmentTimestamp).toHaveBeenCalledTimes(1);
    });

    it("emit warn log on exhaustion", async () => {
        const warn = vi.fn();
        const logger = {
            child: vi.fn(),
            level: "info",
            debug: vi.fn(),
            info: vi.fn(),
            warn,
            error: vi.fn(),
            fatal: vi.fn(),
        };
        const interactor = makeInteractor(async () => ZERO);
        await resolveCommitmentTimestamp(interactor, COMMITMENT, {
            backoffMs: 0,
            maxAttempts: 2,
            logger,
        });
        expect(warn).toHaveBeenCalledOnce();
    });
});

describe("lookupCommitmentTimestamp", () => {
    it("found carries the timestamp", async () => {
        const interactor = makeInteractor(async () => TIMESTAMP);
        expect(await lookupCommitmentTimestamp(interactor, COMMITMENT, { backoffMs: 0 })).toEqual({
            status: "found",
            timestamp: TIMESTAMP,
        });
    });

    it("absent when the node answered 0x0", async () => {
        const interactor = makeInteractor(async () => ZERO);
        expect(await lookupCommitmentTimestamp(interactor, COMMITMENT, { backoffMs: 0 })).toEqual({
            status: "absent",
        });
    });

    it("unknown when every attempt threw", async () => {
        const interactor = makeInteractor(async () => {
            throw new Error("RPC down");
        });
        expect(await lookupCommitmentTimestamp(interactor, COMMITMENT, { backoffMs: 0 })).toEqual({
            status: "unknown",
        });
        expect(interactor.getCommitmentTimestamp).toHaveBeenCalledTimes(3);
    });

    it("absent when one attempt answered 0x0 and the others threw", async () => {
        let calls = 0;
        const interactor = makeInteractor(async () => {
            calls++;
            if (calls === 2) return ZERO;
            throw new Error("RPC down");
        });
        expect(await lookupCommitmentTimestamp(interactor, COMMITMENT, { backoffMs: 0 })).toEqual({
            status: "absent",
        });
    });
});
