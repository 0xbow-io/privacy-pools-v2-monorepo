import { decodeFunctionData, encodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hex,
    PrepareDepositResult,
    YieldDepositTarget,
} from "../../../src/internal.js";
import {
    InvalidTransactParams,
    NATIVE_ASSET_ADDRESS,
    PP_ROUTER_DEPOSIT_ABI,
    PP_ROUTER_DEPOSIT_NATIVE_ABI,
} from "../../../src/internal.js";
import {
    assertYieldDepositMatches,
    prepareYieldSwapDeposit,
    yieldDepositFundingToken,
    yieldDepositTargetFor,
    toYieldSwapDepositTarget,
} from "../../../src/utils/YieldSwapOutput.js";

const SHARE = "0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6" as Address;
const ROUTER = "0xe76E793d776c1e207aD7a7fa7C57d27420d85110" as Address;
const UNDERLYING = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const OTHER = "0x1111111111111111111111111111111111111111" as Address;
const BUDGET = 1_000_000n;
const SHARES = 990_000n;

interface ProofTuple {
    pA: [bigint, bigint];
    pB: [[bigint, bigint], [bigint, bigint]];
    pC: [bigint, bigint];
    pubSignals: [bigint, bigint, bigint, bigint];
}
function proofFor(tokenId: Address, value: bigint): ProofTuple {
    return {
        pA: [1n, 2n] as [bigint, bigint],
        pB: [
            [3n, 4n],
            [5n, 6n],
        ] as [[bigint, bigint], [bigint, bigint]],
        pC: [7n, 8n] as [bigint, bigint],
        pubSignals: [9n, BigInt(tokenId), value, 0n] as [bigint, bigint, bigint, bigint],
    };
}
const NOTE_DATA = { hint: `0x${"ab".repeat(32)}` as Hex, data: "0x1234" as Hex };

function erc20Calldata(tokenId: Address, value: bigint, cap: bigint): Hex {
    return encodeFunctionData({
        abi: PP_ROUTER_DEPOSIT_ABI,
        functionName: "depositExactShares",
        args: [proofFor(tokenId, value), NOTE_DATA, "0x" as Hex, cap],
    });
}
function nativeCalldata(tokenId: Address, value: bigint): Hex {
    return encodeFunctionData({
        abi: PP_ROUTER_DEPOSIT_NATIVE_ABI,
        functionName: "depositExactSharesNative",
        args: [proofFor(tokenId, value), NOTE_DATA, "0x" as Hex],
    });
}

function makeTarget(
    nativeMode: boolean,
    forNoteSecret?: Hex,
): YieldDepositTarget & { deposit: { calls: unknown[]; forCalls: unknown[] } } {
    const calls: unknown[] = [];
    const forCalls: unknown[] = [];
    const buildResult = (
        params: { value: Hex; maxUnderlyingIn?: bigint; fundingSource?: string },
        noteSecret?: Hex,
    ): {
        pendingNote: { tokenId: Address; value: Hex };
        depositTx: { to: Address; data: Hex; value: Hex };
        approvalTxs: unknown[];
        approvalTx: null;
        sharesValue: bigint;
        underlyingNeeded: bigint;
        maxUnderlyingIn: bigint;
        noteSecret?: Hex;
    } => {
        const value = BigInt(params.value);
        const cap = params.maxUnderlyingIn ?? 0n;
        return {
            pendingNote: { tokenId: SHARE, value: params.value },
            depositTx: nativeMode
                ? {
                      to: ROUTER,
                      data: nativeCalldata(SHARE, value),
                      value: `0x${cap.toString(16)}` as Hex,
                  }
                : {
                      to: ROUTER,
                      data: erc20Calldata(SHARE, value, cap),
                      value: "0x0" as Hex,
                  },
            approvalTxs: [],
            approvalTx: null,
            sharesValue: value,
            underlyingNeeded: cap - 10n,
            maxUnderlyingIn: cap,
            noteSecret,
        };
    };
    const deposit = {
        calls,
        forCalls,
        sizeSharesForBudget: vi.fn(async (budget: bigint) => ({
            shares: SHARES,
            underlyingNeeded: budget - 10n,
            maxUnderlyingIn: budget,
            headroom: 1n,
        })),
        prepareYieldDeposit: vi.fn(
            async (params: { value: Hex; maxUnderlyingIn?: bigint; fundingSource?: string }) => {
                calls.push(params);
                return buildResult(params);
            },
        ),
        prepareYieldDepositFor: vi.fn(
            async (params: { value: Hex; maxUnderlyingIn?: bigint; fundingSource?: string }) => {
                forCalls.push(params);
                return buildResult(params, forNoteSecret);
            },
        ),
    };
    return {
        chainId: 1,
        deployment: {
            ppRouter: ROUTER,
            zap: OTHER,
            ppUSDC: SHARE,
            ppUSDCDecimals: 18,
            underlying: UNDERLYING,
            underlyingDecimals: 6,
            underlyingSymbol: "USDC",
            ...(nativeMode ? { nativeMode: true } : {}),
        },
        deposit,
    } as unknown as YieldDepositTarget & { deposit: { calls: unknown[]; forCalls: unknown[] } };
}

describe("yieldDepositTargetFor / yieldDepositFundingToken", () => {
    it("resolves by the share address only, case-insensitively, and never by the underlying", () => {
        const target = makeTarget(false);
        expect(yieldDepositTargetFor([target], SHARE.toLowerCase() as Address)).toBe(target);
        expect(yieldDepositTargetFor([target], UNDERLYING)).toBeUndefined();
        expect(yieldDepositTargetFor([], SHARE)).toBeUndefined();
    });

    it("funds an ERC-20 router with its underlying and a native-mode router with the native coin", () => {
        expect(yieldDepositFundingToken(makeTarget(false))).toBe(UNDERLYING);
        expect(yieldDepositFundingToken(makeTarget(true))).toBe(NATIVE_ASSET_ADDRESS);
    });
});

describe("prepareYieldSwapDeposit", () => {
    it("sizes shares from the budget, asks for executor funding, and returns the router call with the budget as cap", async () => {
        const target = makeTarget(false);
        const result = await prepareYieldSwapDeposit(target, BUDGET);
        expect(target.deposit.sizeSharesForBudget).toHaveBeenCalledWith(BUDGET, undefined);
        const call = target.deposit.calls[0] as {
            value: Hex;
            maxUnderlyingIn?: bigint;
            fundingSource?: string;
        };
        expect(BigInt(call.value)).toBe(SHARES);
        expect(call.maxUnderlyingIn).toBe(BUDGET);
        expect(call.fundingSource).toBe("executor");
        expect(result.depositTx.to).toBe(ROUTER);
        expect(result.depositTx.value).toBe("0x0");
        expect(result.approvalTx).toBeNull();
        expect(result.approvalTxs).toEqual([]);
        expect(result.pendingNote.tokenId).toBe(SHARE);
        const decoded = decodeFunctionData({ abi: PP_ROUTER_DEPOSIT_ABI, data: result.depositTx.data });
        expect(decoded.functionName).toBe("depositExactShares");
        expect(decoded.args[3]).toBe(BUDGET);
        expect(decoded.args[0].pubSignals[1]).toBe(BigInt(SHARE));
        expect(decoded.args[0].pubSignals[2]).toBe(SHARES);
    });

    it("a native-mode router gets depositExactSharesNative with the budget as msg.value and no cap argument", async () => {
        const result = await prepareYieldSwapDeposit(makeTarget(true), BUDGET);
        expect(result.depositTx.to).toBe(ROUTER);
        expect(BigInt(result.depositTx.value)).toBe(BUDGET);
        const decoded = decodeFunctionData({
            abi: PP_ROUTER_DEPOSIT_NATIVE_ABI,
            data: result.depositTx.data,
        });
        expect(decoded.functionName).toBe("depositExactSharesNative");
        expect(decoded.args).toHaveLength(3);
    });

    it("omitting recipient calls prepareYieldDeposit (self), never prepareYieldDepositFor", async () => {
        const target = makeTarget(false);
        await prepareYieldSwapDeposit(target, BUDGET);
        expect(target.deposit.calls).toHaveLength(1);
        expect(target.deposit.forCalls).toHaveLength(0);
    });

    it("a blind noteAddressHash recipient routes through prepareYieldDepositFor", async () => {
        const target = makeTarget(false);
        const noteAddressHash =
            "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex;
        await prepareYieldSwapDeposit(target, BUDGET, undefined, { noteAddressHash });
        expect(target.deposit.calls).toHaveLength(0);
        expect(target.deposit.forCalls).toHaveLength(1);
        expect(target.deposit.forCalls[0]).toMatchObject({
            noteAddressHash,
            maxUnderlyingIn: BUDGET,
            fundingSource: "executor",
        });
    });

    it("a discoveryData recipient routes through prepareYieldDepositFor", async () => {
        const target = makeTarget(false);
        const discoveryData = { evmAddress: OTHER };
        await prepareYieldSwapDeposit(target, BUDGET, undefined, { discoveryData });
        expect(target.deposit.forCalls[0]).toMatchObject({ discoveryData });
    });

    it("forwards noteSecret from prepareYieldDepositFor onto the result", async () => {
        const secret = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
        const target = makeTarget(false, secret);
        const result = await prepareYieldSwapDeposit(target, BUDGET, undefined, {
            discoveryData: { evmAddress: OTHER, allowOutOfBandFallback: true },
        });
        expect(result.noteSecret).toBe(secret);
    });

    it("omits noteSecret from the result when recipient is omitted", async () => {
        const target = makeTarget(false);
        const result = await prepareYieldSwapDeposit(target, BUDGET);
        expect(result.noteSecret).toBeUndefined();
    });
});

describe("assertYieldDepositMatches", () => {
    const erc20Result = (
        over: { to?: Address; callData?: Hex; msgValue?: Hex } = {},
    ): PrepareDepositResult =>
        ({
            depositTx: {
                to: over.to ?? ROUTER,
                data: over.callData ?? erc20Calldata(SHARE, SHARES, BUDGET),
                value: over.msgValue ?? ("0x0" as Hex),
            },
            pendingNote: { tokenId: SHARE, value: `0x${SHARES.toString(16)}` as Hex },
            approvalTxs: [],
            approvalTx: null,
        }) as unknown as PrepareDepositResult;

    it("accepts a router deposit whose proof names the share and the sized value, with the cap equal to the budget", () => {
        expect(() =>
            assertYieldDepositMatches(makeTarget(false), erc20Result(), BUDGET),
        ).not.toThrow();
        expect(() => assertYieldDepositMatches(makeTarget(false), erc20Result())).not.toThrow();
    });

    it("rejects another target, another token, another value, a cap that is not the budget, and native value on an ERC-20 router", () => {
        const target = makeTarget(false);
        expect(() => assertYieldDepositMatches(target, erc20Result({ to: OTHER }), BUDGET)).toThrow(
            InvalidTransactParams,
        );
        expect(() =>
            assertYieldDepositMatches(
                target,
                erc20Result({ callData: erc20Calldata(OTHER, SHARES, BUDGET) }),
                BUDGET,
            ),
        ).toThrow(InvalidTransactParams);
        expect(() =>
            assertYieldDepositMatches(
                target,
                erc20Result({ callData: erc20Calldata(SHARE, SHARES + 1n, BUDGET) }),
                BUDGET,
            ),
        ).toThrow(InvalidTransactParams);
        expect(() =>
            assertYieldDepositMatches(
                target,
                erc20Result({ callData: erc20Calldata(SHARE, SHARES, BUDGET - 1n) }),
                BUDGET,
            ),
        ).toThrow(InvalidTransactParams);
        expect(() =>
            assertYieldDepositMatches(target, erc20Result({ msgValue: "0x1" as Hex }), BUDGET),
        ).toThrow(InvalidTransactParams);
        expect(() =>
            assertYieldDepositMatches(
                target,
                erc20Result({ callData: "0xdeadbeef" as Hex }),
                BUDGET,
            ),
        ).toThrow(InvalidTransactParams);
    });

    it("a native-mode router is checked against msg.value and rejects a zero or mismatched value", () => {
        const target = makeTarget(true);
        const nativeResult = (over: { callData?: Hex; msgValue?: Hex } = {}): PrepareDepositResult =>
            ({
                depositTx: {
                    to: ROUTER,
                    data: over.callData ?? nativeCalldata(SHARE, SHARES),
                    value: over.msgValue ?? (`0x${BUDGET.toString(16)}` as Hex),
                },
                pendingNote: { tokenId: SHARE, value: `0x${SHARES.toString(16)}` as Hex },
                approvalTxs: [],
                approvalTx: null,
            }) as unknown as PrepareDepositResult;
        const ok = nativeResult();
        expect(() => assertYieldDepositMatches(target, ok, BUDGET)).not.toThrow();
        expect(() =>
            assertYieldDepositMatches(target, nativeResult({ msgValue: "0x0" as Hex }), BUDGET),
        ).toThrow(InvalidTransactParams);
        expect(() =>
            assertYieldDepositMatches(
                target,
                nativeResult({ msgValue: `0x${(BUDGET + 1n).toString(16)}` as Hex }),
                BUDGET,
            ),
        ).toThrow(InvalidTransactParams);
        // ERC-20 calldata sent to a native router is a mode mismatch.
        expect(() =>
            assertYieldDepositMatches(
                target,
                nativeResult({ callData: erc20Calldata(SHARE, SHARES, BUDGET) }),
                BUDGET,
            ),
        ).toThrow(InvalidTransactParams);
    });
});

describe("toYieldSwapDepositTarget", () => {
    it("exposes the share, router and funding token and delegates sizing, preparing and verification", async () => {
        const evmTarget = makeTarget(false);
        const target = toYieldSwapDepositTarget(evmTarget);
        expect(target.chainId).toBe(1);
        expect(target.shareToken).toBe(SHARE);
        expect(target.router).toBe(ROUTER);
        expect(target.fundingToken).toBe(UNDERLYING);
        expect(toYieldSwapDepositTarget(makeTarget(true)).fundingToken).toBe(NATIVE_ASSET_ADDRESS);

        expect((await target.sizeSharesForBudget(BUDGET, 5n)).shares).toBe(SHARES);
        expect(evmTarget.deposit.sizeSharesForBudget).toHaveBeenCalledWith(BUDGET, 5n);

        const prepared = await target.prepareSwapDeposit(BUDGET);
        expect(prepared.depositTx.to).toBe(ROUTER);
        expect(() => target.assertDepositMatches(prepared, BUDGET)).not.toThrow();
        expect(() => target.assertDepositMatches(prepared, BUDGET - 1n)).toThrow(
            InvalidTransactParams,
        );
    });
});
