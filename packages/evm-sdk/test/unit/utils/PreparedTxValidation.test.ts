import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import type { Address, Hex, PreparedTransaction } from "../../../src/internal.js";
import {
    assertPreparedTxMatches,
    ENTRYPOINT_DEPOSIT_ABI,
    ERC20_APPROVE_ABI,
    POOL_VAULT_RAGEQUIT_ABI,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";

const POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const SPENDER = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;

const ragequitProof = {
    pA: [0n, 0n],
    pB: [
        [0n, 0n],
        [0n, 0n],
    ],
    pC: [0n, 0n],
    pubSignals: [0n, 0n, 0n, 0n, 0n, 0n, 0n],
} as const;

function ragequitCalldata(): Hex {
    return encodeFunctionData({
        abi: POOL_VAULT_RAGEQUIT_ABI,
        functionName: "ragequit",
        args: [ragequitProof],
    });
}

function approveCalldata(): Hex {
    return encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [SPENDER, 1000n],
    });
}

describe("assertPreparedTxMatches", () => {
    it("pass when both to and function selector match", () => {
        const tx: PreparedTransaction = { to: POOL, data: ragequitCalldata(), value: "0x0" as Hex };
        expect(() =>
            assertPreparedTxMatches(tx, {
                to: POOL,
                abi: POOL_VAULT_RAGEQUIT_ABI,
                functionName: "ragequit",
            }),
        ).not.toThrow();
    });

    it("be case-insensitive on the to comparison", () => {
        const tx: PreparedTransaction = {
            to: POOL.toUpperCase().replace("0X", "0x") as Address,
            data: ragequitCalldata(),
            value: "0x0" as Hex,
        };
        expect(() =>
            assertPreparedTxMatches(tx, {
                to: POOL,
                abi: POOL_VAULT_RAGEQUIT_ABI,
                functionName: "ragequit",
            }),
        ).not.toThrow();
    });

    it("throw when to does not match the expected contract", () => {
        const tx: PreparedTransaction = {
            to: TOKEN,
            data: ragequitCalldata(),
            value: "0x0" as Hex,
        };
        expect(() =>
            assertPreparedTxMatches(tx, {
                to: POOL,
                abi: POOL_VAULT_RAGEQUIT_ABI,
                functionName: "ragequit",
            }),
        ).toThrow(UnexpectedTransactionTarget);
    });

    it("throw when the calldata decodes to a different function on the same contract", () => {
        // approve calldata validated against the deposit ABI/function.
        const tx: PreparedTransaction = { to: POOL, data: approveCalldata(), value: "0x0" as Hex };
        expect(() =>
            assertPreparedTxMatches(tx, {
                to: POOL,
                abi: ENTRYPOINT_DEPOSIT_ABI,
                functionName: "deposit",
            }),
        ).toThrow(UnexpectedTransactionTarget);
    });

    it("throw when calldata cannot be decoded against the expected ABI", () => {
        const tx: PreparedTransaction = {
            to: POOL,
            data: "0xdeadbeef" as Hex,
            value: "0x0" as Hex,
        };
        expect(() =>
            assertPreparedTxMatches(tx, {
                to: POOL,
                abi: POOL_VAULT_RAGEQUIT_ABI,
                functionName: "ragequit",
            }),
        ).toThrow(UnexpectedTransactionTarget);
    });
});
