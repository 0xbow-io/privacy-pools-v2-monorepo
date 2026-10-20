import { decodeFunctionData, encodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hex,
    ILogger,
    IPoolSessionDeposit,
    IPPRouterInteractor,
    IPPYieldTokenInteractor,
    PendingNote,
} from "../../../src/internal.js";
import {
    bigintToHex,
    CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
    defaultMaxUnderlyingIn,
    ENTRYPOINT_DEPOSIT_ABI,
    ERC20_APPROVE_ABI,
    hasErrorAmounts,
    inferVettingFeeBps,
    InvalidYieldAmount,
    LOCAL_FORK_YIELD_DEPLOYMENT,
    EvmPoolSessionYieldDeposit,
    PP_ROUTER_DEPOSIT_ABI,
    PP_ROUTER_DEPOSIT_NATIVE_ABI,
    ppmHeadroom,
    UnexpectedDepositCalldata,
} from "../../../src/internal.js";

const DEP = LOCAL_FORK_YIELD_DEPLOYMENT;

// A representative deposit proof/noteData/ciphertext to round-trip through the re-encode.
const PROOF = {
    pA: [1n, 2n],
    pB: [
        [3n, 4n],
        [5n, 6n],
    ],
    pC: [7n, 8n],
    pubSignals: [9n, 10n, 11n, 12n],
} as const;
const NOTE_DATA = { hint: `0x${"11".repeat(32)}` as Hex, data: "0xabcd" as Hex };
const ASP_CIPHERTEXT = "0xdeadbeef" as Hex;

function entrypointDepositCalldata(): Hex {
    return encodeFunctionData({
        abi: ENTRYPOINT_DEPOSIT_ABI,
        functionName: "deposit",
        args: [PROOF, NOTE_DATA, ASP_CIPHERTEXT] as never,
    });
}

const PENDING_NOTE = { commitment: "0x01", tokenId: DEP.ppUSDC } as unknown as PendingNote;

function mockDeposit(callData: Hex): IPoolSessionDeposit {
    return {
        prepareDeposit: vi.fn(async () => ({
            depositTx: { data: callData, to: DEP.ppRouter, value: "0x0" as Hex },
            pendingNote: PENDING_NOTE,
            approvalTx: null,
        })),
    } as unknown as IPoolSessionDeposit;
}

/** Like {@link mockDeposit}, plus a `prepareDepositFor` stub for prepareYieldDepositFor tests. */
function mockDepositFor(callData: Hex, noteSecret?: Hex): IPoolSessionDeposit {
    return {
        prepareDeposit: vi.fn(async () => ({
            depositTx: { data: callData, to: DEP.ppRouter, value: "0x0" as Hex },
            pendingNote: PENDING_NOTE,
            approvalTx: null,
        })),
        prepareDepositFor: vi.fn(async () => ({
            depositTx: { data: callData, to: DEP.ppRouter, value: "0x0" as Hex },
            pendingNote: PENDING_NOTE,
            approvalTx: null,
            noteSecret,
        })),
    } as unknown as IPoolSessionDeposit;
}

function mockRouter(underlyingNeeded: bigint): IPPRouterInteractor {
    return {
        getAddress: () => DEP.ppRouter,
        quote: vi.fn(async () => ({ underlyingNeeded, total: underlyingNeeded })),
        quoteWithdraw: vi.fn(async () => 0n),
        supplyBufferUnits: vi.fn(async () => 2n),
    };
}

function mockYieldToken(previewShares: bigint): IPPYieldTokenInteractor {
    return {
        getAddress: () => DEP.ppUSDC,
        exchangeRate: vi.fn(async () => 0n),
        previewDeposit: vi.fn(async () => previewShares),
        previewRedeem: vi.fn(async () => 0n),
        encodeRedeem: vi.fn(() => ({ to: DEP.ppUSDC, data: "0x" as Hex, value: "0x0" as Hex })),
    };
}

const SHARES = 1_000_000_000_000_000_000n; // 1 ppUSDC
const UNDERLYING_NEEDED = 1_000_000n; // 1 USDC (6dp)

describe("PoolSessionYieldDeposit", () => {
    let deposit: IPoolSessionDeposit;
    let router: IPPRouterInteractor;
    let yieldToken: IPPYieldTokenInteractor;
    let session: EvmPoolSessionYieldDeposit;

    beforeEach(() => {
        deposit = mockDeposit(entrypointDepositCalldata());
        router = mockRouter(UNDERLYING_NEEDED);
        yieldToken = mockYieldToken(0n);
        session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });
    });

    describe("prepareYieldDeposit", () => {
        it("builds the standard deposit proof for the ppUSDC token", async () => {
            await session.prepareYieldDeposit({ value: SHARES });
            expect(deposit.prepareDeposit).toHaveBeenCalledWith({
                tokenId: DEP.ppUSDC,
                value: bigintToHex(SHARES),
            });
        });

        it("re-encodes the same proof/noteData/ciphertext as depositExactShares", async () => {
            const result = await session.prepareYieldDeposit({ value: SHARES });

            expect(result.depositTx.to).toBe(DEP.ppRouter);
            const decoded = decodeFunctionData({
                abi: PP_ROUTER_DEPOSIT_ABI,
                data: result.depositTx.data,
            });
            expect(decoded.functionName).toBe("depositExactShares");
            const [proof, noteData, aspCiphertext, maxUnderlyingIn] = decoded.args;
            expect(proof).toEqual(PROOF);
            expect(noteData).toEqual(NOTE_DATA);
            expect(aspCiphertext).toBe(ASP_CIPHERTEXT);
            expect(maxUnderlyingIn).toBe(result.maxUnderlyingIn);
        });

        it("sizes maxUnderlyingIn as quoted underlying + 1 ppm rate headroom", async () => {
            const result = await session.prepareYieldDeposit({ value: SHARES });
            expect(result.underlyingNeeded).toBe(UNDERLYING_NEEDED);
            // 1_000_000 + ceil(1_000_000 × 1 / 1_000_000) = 1_000_001
            expect(result.maxUnderlyingIn).toBe(1_000_001n);
            expect(router.quote).toHaveBeenCalledWith(SHARES);
        });

        it("approves the underlying to the router for the spend cap", async () => {
            const result = await session.prepareYieldDeposit({ value: SHARES });
            expect(result.approvalTx!.to).toBe(DEP.underlying);
            const decoded = decodeFunctionData({
                abi: ERC20_APPROVE_ABI,
                data: result.approvalTx!.data,
            });
            expect(decoded.functionName).toBe("approve");
            const [spender, amount] = decoded.args;
            expect((spender as string).toLowerCase()).toBe(DEP.ppRouter.toLowerCase());
            expect(amount).toBe(1_000_001n);
        });

        it("plans a zero reset before the approval when the router already holds a residual allowance (mainnet USDT)", async () => {
            session = new EvmPoolSessionYieldDeposit({
                deployment: DEP,
                deposit,
                router,
                yieldToken,
                allowanceOf: vi.fn(async () => 5n), // leftover headroom from a previous deposit
            });
            const result = await session.prepareYieldDeposit({ value: SHARES });
            expect(result.approvalTxs).toHaveLength(2);
            const amounts = result.approvalTxs.map(
                (tx) => decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: tx.data }).args[1],
            );
            expect(amounts[0]).toBe(0n);
            expect(amounts[1]).toBe(result.maxUnderlyingIn);
            expect(result.approvalTx).toBe(result.approvalTxs[1]);
        });

        it("emits no approval when the current allowance already covers the spend cap", async () => {
            session = new EvmPoolSessionYieldDeposit({
                deployment: DEP,
                deposit,
                router,
                yieldToken,
                allowanceOf: vi.fn(async () => 10n ** 30n),
            });
            const result = await session.prepareYieldDeposit({ value: SHARES });
            expect(result.approvalTxs).toEqual([]);
            expect(result.approvalTx).toBeNull();
        });

        it("passes the deposit note through", async () => {
            const result = await session.prepareYieldDeposit({ value: SHARES });
            expect(result.pendingNote).toBe(PENDING_NOTE);
            expect(result.sharesValue).toBe(SHARES);
        });

        it("throws UnexpectedDepositCalldata when the base calldata is not a deposit", async () => {
            const notADeposit = encodeFunctionData({
                abi: ERC20_APPROVE_ABI,
                functionName: "approve",
                args: [DEP.ppRouter, 1n],
            });
            session = new EvmPoolSessionYieldDeposit({
                deployment: DEP,
                deposit: mockDeposit(notADeposit),
                router,
                yieldToken,
            });
            await expect(session.prepareYieldDeposit({ value: SHARES })).rejects.toBeInstanceOf(
                UnexpectedDepositCalldata,
            );
        });

        it("rejects a non-positive value", async () => {
            await expect(
                session.prepareYieldDeposit({ value: 0n }),
            ).rejects.toBeInstanceOf(InvalidYieldAmount);
        });
    });

    describe("prepareYieldDepositFor", () => {
        const RECIPIENT_ADDRESS = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
        const NOTE_ADDRESS_HASH =
            "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex;
        const RECIPIENT_SECRET =
            "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

        it("delegates to deposit.prepareDepositFor with the ppUSDC token, blind noteAddressHash", async () => {
            deposit = mockDepositFor(entrypointDepositCalldata());
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });

            await session.prepareYieldDepositFor({
                value: SHARES,
                noteAddressHash: NOTE_ADDRESS_HASH,
            });

            expect(deposit.prepareDepositFor).toHaveBeenCalledWith({
                tokenId: DEP.ppUSDC,
                value: bigintToHex(SHARES),
                noteAddressHash: NOTE_ADDRESS_HASH,
                noteData: undefined,
                depositSecret: undefined,
            });
        });

        it("delegates to deposit.prepareDepositFor with discoveryData", async () => {
            deposit = mockDepositFor(entrypointDepositCalldata());
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });
            const discoveryData = { evmAddress: RECIPIENT_ADDRESS };

            await session.prepareYieldDepositFor({ value: SHARES, discoveryData });

            expect(deposit.prepareDepositFor).toHaveBeenCalledWith({
                tokenId: DEP.ppUSDC,
                value: bigintToHex(SHARES),
                discoveryData,
            });
        });

        it("surfaces noteSecret on the result when the out-of-band fallback fired", async () => {
            deposit = mockDepositFor(entrypointDepositCalldata(), RECIPIENT_SECRET);
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });

            const result = await session.prepareYieldDepositFor({
                value: SHARES,
                discoveryData: { evmAddress: RECIPIENT_ADDRESS, allowOutOfBandFallback: true },
            });

            expect(result.noteSecret).toBe(RECIPIENT_SECRET);
        });

        it("omits noteSecret when the recipient is discoverable", async () => {
            deposit = mockDepositFor(entrypointDepositCalldata());
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });

            const result = await session.prepareYieldDepositFor({
                value: SHARES,
                discoveryData: { evmAddress: RECIPIENT_ADDRESS },
            });

            expect(result.noteSecret).toBeUndefined();
        });

        it("re-encodes as depositExactShares via the same shared pipeline as prepareYieldDeposit", async () => {
            deposit = mockDepositFor(entrypointDepositCalldata());
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });

            const result = await session.prepareYieldDepositFor({
                value: SHARES,
                noteAddressHash: NOTE_ADDRESS_HASH,
            });

            const decoded = decodeFunctionData({
                abi: PP_ROUTER_DEPOSIT_ABI,
                data: result.depositTx.data,
            });
            expect(decoded.functionName).toBe("depositExactShares");
            expect(result.pendingNote).toBe(PENDING_NOTE);
        });

        it("rejects a non-positive value the same way as prepareYieldDeposit", async () => {
            deposit = mockDepositFor(entrypointDepositCalldata());
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });

            await expect(
                session.prepareYieldDepositFor({
                    value: 0n,
                    noteAddressHash: NOTE_ADDRESS_HASH,
                }),
            ).rejects.toBeInstanceOf(InvalidYieldAmount);
        });

        it("regression: self-deposit still calls prepareDeposit, never prepareDepositFor", async () => {
            deposit = mockDepositFor(entrypointDepositCalldata());
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });

            await session.prepareYieldDeposit({ value: SHARES });

            expect(deposit.prepareDeposit).toHaveBeenCalledOnce();
            expect(deposit.prepareDepositFor).not.toHaveBeenCalled();
        });
    });

    describe("prepareYieldDeposit propagation & short-circuit", () => {
        it("does not build the proof when value is invalid", async () => {
            await expect(
                session.prepareYieldDeposit({ value: 0n }),
            ).rejects.toBeInstanceOf(InvalidYieldAmount);
            expect(deposit.prepareDeposit).not.toHaveBeenCalled();
        });

        it("propagates a base deposit error", async () => {
            const failing = {
                prepareDeposit: vi.fn(async () => {
                    throw new Error("deposit failed");
                }),
            } as unknown as IPoolSessionDeposit;
            session = new EvmPoolSessionYieldDeposit({
                deployment: DEP,
                deposit: failing,
                router,
                yieldToken,
            });
            await expect(session.prepareYieldDeposit({ value: SHARES })).rejects.toThrow(
                "deposit failed",
            );
        });

        it("propagates a router quote error", async () => {
            const badRouter = {
                getAddress: () => DEP.ppRouter,
                quote: vi.fn(async () => {
                    throw new Error("rpc down");
                }),
                quoteWithdraw: vi.fn(async () => 0n),
                supplyBufferUnits: vi.fn(async () => 2n),
            } as IPPRouterInteractor;
            session = new EvmPoolSessionYieldDeposit({
                deployment: DEP,
                deposit,
                router: badRouter,
                yieldToken,
            });
            await expect(session.prepareYieldDeposit({ value: SHARES })).rejects.toThrow(
                "rpc down",
            );
        });

        it("logs the sizing when a logger is supplied", async () => {
            const debug = vi.fn();
            const logger = {
                debug,
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
            } as unknown as ILogger;
            session = new EvmPoolSessionYieldDeposit(
                { deployment: DEP, deposit, router, yieldToken },
                { logger },
            );
            await session.prepareYieldDeposit({ value: SHARES });
            expect(debug).toHaveBeenCalledWith("prepared yield deposit", expect.any(Object));
        });
    });

    describe("sharesForUnderlying propagation", () => {
        it("propagates a previewDeposit error", async () => {
            const badToken = {
                getAddress: () => DEP.ppUSDC,
                exchangeRate: vi.fn(async () => 0n),
                previewDeposit: vi.fn(async () => {
                    throw new Error("rpc down");
                }),
                previewRedeem: vi.fn(async () => 0n),
                encodeRedeem: vi.fn(() => ({
                    to: DEP.ppUSDC,
                    data: "0x" as Hex,
                    value: "0x0" as Hex,
                })),
            } as IPPYieldTokenInteractor;
            session = new EvmPoolSessionYieldDeposit({
                deployment: DEP,
                deposit,
                router,
                yieldToken: badToken,
            });
            await expect(session.sharesForUnderlying(1_000_000n)).rejects.toThrow("rpc down");
        });
    });

    describe("prepareYieldDeposit edge cases", () => {
        it("rounds the headroom up to a whole underlying unit", async () => {
            router = mockRouter(999_999n);
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });
            const result = await session.prepareYieldDeposit({ value: SHARES });
            // 999_999 + ceil(0.999999) = 1_000_000
            expect(result.maxUnderlyingIn).toBe(1_000_000n);
        });

        it("binds a caller-supplied maxUnderlyingIn instead of the default headroom", async () => {
            const result = await session.prepareYieldDeposit({
                value: SHARES,
                maxUnderlyingIn: 1_000_100n,
            });
            expect(result.maxUnderlyingIn).toBe(1_000_100n);
            const decoded = decodeFunctionData({
                abi: PP_ROUTER_DEPOSIT_ABI,
                data: result.depositTx.data,
            });
            expect(decoded.args[3]).toBe(1_000_100n);
            const approval = decodeFunctionData({
                abi: ERC20_APPROVE_ABI,
                data: result.approvalTx!.data,
            });
            expect(approval.args[1]).toBe(1_000_100n);
        });

        it("rejects a caller cap below the quoted underlyingNeeded", async () => {
            await expect(
                session.prepareYieldDeposit({ value: SHARES, maxUnderlyingIn: 999_999n }),
            ).rejects.toBeInstanceOf(InvalidYieldAmount);
        });

        it("defaultMaxUnderlyingIn floors the headroom at one unit and keeps a zero quote at zero", () => {
            expect(defaultMaxUnderlyingIn(5n)).toBe(6n);
            expect(defaultMaxUnderlyingIn(0n)).toBe(0n);
            expect(defaultMaxUnderlyingIn(100_000_000n)).toBe(100_000_100n);
        });

        it("adds a whole unit per started ppm: 1_000_001 -> 1_000_003", async () => {
            router = mockRouter(1_000_001n);
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });
            const result = await session.prepareYieldDeposit({ value: SHARES });
            expect(result.maxUnderlyingIn).toBe(1_000_003n);
            expect(ppmHeadroom(1_000_001n)).toBe(2n);
        });

        it("accepts a caller cap exactly equal to the quote", async () => {
            const result = await session.prepareYieldDeposit({
                value: SHARES,
                maxUnderlyingIn: UNDERLYING_NEEDED,
            });
            expect(result.maxUnderlyingIn).toBe(UNDERLYING_NEEDED);
        });

        it("handles a zero router quote (maxUnderlyingIn = 0)", async () => {
            router = mockRouter(0n);
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });
            const result = await session.prepareYieldDeposit({ value: SHARES });
            expect(result.underlyingNeeded).toBe(0n);
            expect(result.maxUnderlyingIn).toBe(0n);
            // Nothing to approve for a zero cap — no approval tx at all (minr #28).
            expect(result.approvalTxs).toEqual([]);
            expect(result.approvalTx).toBeNull();
        });

        it("rejects a negative value", async () => {
            await expect(
                session.prepareYieldDeposit({ value: -1n }),
            ).rejects.toBeInstanceOf(InvalidYieldAmount);
        });
    });

    describe("sharesForUnderlying", () => {
        it("returns previewDeposit exactly: no discount on the shares", async () => {
            yieldToken = mockYieldToken(1_000_000_000_000_000_000n);
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });
            // The headroom lives in the spend cap, not in the shares (a discount here is an under-deposit).
            await expect(session.sharesForUnderlying(1_000_000n)).resolves.toBe(
                1_000_000_000_000_000_000n,
            );
            expect(yieldToken.previewDeposit).toHaveBeenCalledWith(1_000_000n);
        });

        it("rejects a non-positive underlying amount", async () => {
            await expect(session.sharesForUnderlying(0n)).rejects.toBeInstanceOf(
                InvalidYieldAmount,
            );
        });

        it("rejects a negative underlying amount", async () => {
            await expect(session.sharesForUnderlying(-5n)).rejects.toBeInstanceOf(
                InvalidYieldAmount,
            );
        });

        it("passes a tiny share count through unchanged", async () => {
            yieldToken = mockYieldToken(7n);
            session = new EvmPoolSessionYieldDeposit({ deployment: DEP, deposit, router, yieldToken });
            await expect(session.sharesForUnderlying(1n)).resolves.toBe(7n);
        });
    });
});

describe("sizeSharesForBudget", () => {
    const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
    /**
     * A vault at a fixed rational rate: previewDeposit floors assets × num/den into shares,
     * previewMint ceils shares × den/num into assets (OpenZeppelin ERC-4626 rounding).
     */
    function modelVault(
        num: bigint,
        den: bigint,
    ): {
        yieldToken: IPPYieldTokenInteractor;
        router: (feeBps: bigint) => IPPRouterInteractor;
    } {
        const previewDeposit = (assets: bigint): bigint => (assets * num) / den;
        const previewMint = (shares: bigint): bigint => ceilDiv(shares * den, num);
        return {
            yieldToken: {
                getAddress: () => DEP.ppUSDC,
                exchangeRate: vi.fn(async () => previewMint(10n ** 18n)),
                previewDeposit: vi.fn(async (assets: bigint) => previewDeposit(assets)),
                previewRedeem: vi.fn(async (shares: bigint) => (shares * den) / num),
                encodeRedeem: vi.fn(() => ({
                    to: DEP.ppUSDC,
                    data: "0x" as Hex,
                    value: "0x0" as Hex,
                })),
            },
            // The router prices value + floor(value × fee / 10000) shares, plus the zap's 2 units.
            router: (feeBps: bigint) => ({
                getAddress: () => DEP.ppRouter,
                quote: vi.fn(async (value: bigint) => {
                    const total = value + (value * feeBps) / 10_000n;
                    return { underlyingNeeded: previewMint(total) + 2n, total };
                }),
                quoteWithdraw: vi.fn(async () => 0n),
                supplyBufferUnits: vi.fn(async () => 2n),
            }),
        };
    }
    const deposit = mockDeposit(entrypointDepositCalldata());
    const ONE_TO_ONE = modelVault(1_000_000_000_000n, 1n); // 1 USDC unit = 1e12 share units
    const SEVEN_THIRDS = modelVault(3_000_000_000_000n, 7n); // A/V = 7 / 3e12: fractional previews

    it("no fee, 1:1: the budget minus 1 ppm headroom and the zap buffer buys the shares, cap = budget", async () => {
        const router = ONE_TO_ONE.router(0n);
        const session = new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router,
            yieldToken: ONE_TO_ONE.yieldToken,
        });
        const sized = await session.sizeSharesForBudget(100_000_000n);
        expect(sized.headroom).toBe(100n);
        expect(sized.maxUnderlyingIn).toBe(100_000_000n);
        expect(sized.shares).toBe(99_999_898n * 1_000_000_000_000n); // principal = budget − 100 − 2
        expect(sized.underlyingNeeded).toBe(99_999_900n); // fits budget − headroom exactly
        expect(router.quote).toHaveBeenCalledTimes(1);
        const prep = await session.prepareYieldDeposit({
            value: sized.shares,
            maxUnderlyingIn: sized.maxUnderlyingIn,
        });
        expect(prep.maxUnderlyingIn).toBe(100_000_000n);
    });

    it("non-1:1 rate, no fee: exact floor of the fractional preview", async () => {
        const session = new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router: SEVEN_THIRDS.router(0n),
            yieldToken: SEVEN_THIRDS.yieldToken,
        });
        const sized = await session.sizeSharesForBudget(100_000_000n);
        expect(sized.shares).toBe(42_857_099_142_857_142_857n);
        expect(sized.underlyingNeeded).toBe(99_999_900n);
    });

    it("non-1:1 rate, 50 bps: the greatest value whose value + fee shares fit, not a proportional guess", async () => {
        const router = SEVEN_THIRDS.router(50n);
        const session = new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router,
            yieldToken: SEVEN_THIRDS.yieldToken,
        });
        const sized = await session.sizeSharesForBudget(100_000_000n);
        expect(sized.shares).toBe(42_643_879_744_136_460_555n);
        expect(sized.underlyingNeeded).toBe(99_999_900n);
        // one more share unit would not fit
        const { underlyingNeeded: over } = await router.quote(sized.shares + 1n);
        expect(over).toBeGreaterThan(99_999_900n);
        expect(router.quote).toHaveBeenCalledTimes(3); // fee probe, final, and this test's own
    });

    it("tiny budget, high fee: still finds the feasible deposit the scaling heuristic missed", async () => {
        const session = new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router: ONE_TO_ONE.router(8_000n),
            yieldToken: ONE_TO_ONE.yieldToken,
        });
        const sized = await session.sizeSharesForBudget(4n); // headroom 1, spendNow 3, principal 1
        expect(sized.shares).toBe(555_555_555_556n);
        expect(sized.underlyingNeeded).toBe(3n);
    });

    it("tiny budget, 1 bp: no undersizing", async () => {
        const session = new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router: ONE_TO_ONE.router(1n),
            yieldToken: ONE_TO_ONE.yieldToken,
        });
        const sized = await session.sizeSharesForBudget(4n);
        expect(sized.shares).toBe(999_900_009_999n);
        expect(sized.underlyingNeeded).toBe(3n);
    });

    it("tiny capacity, 50 bps: probes the fee at 10000 share units so the inverse is exact", async () => {
        // capacity 409 < 10000: a probe AT the capacity would read 49 bps and pick 408 shares,
        // whose quote (4) exceeds spendNow (3); codex round 3.
        const SMALL = modelVault(409n, 1n);
        const router = SMALL.router(50n);
        const session = new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router,
            yieldToken: SMALL.yieldToken,
        });
        const sized = await session.sizeSharesForBudget(4n);
        expect(sized.shares).toBe(407n);
        expect(sized.underlyingNeeded).toBe(3n);
        expect(router.quote).toHaveBeenNthCalledWith(1, 10_000n);
    });

    it("tiny capacity, no fee: the larger probe is not mistaken for the shares' own quote", async () => {
        const SMALL = modelVault(409n, 1n);
        const router = SMALL.router(0n);
        const session = new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router,
            yieldToken: SMALL.yieldToken,
        });
        const sized = await session.sizeSharesForBudget(4n);
        expect(sized.shares).toBe(409n);
        expect(sized.underlyingNeeded).toBe(3n);
        expect(router.quote).toHaveBeenCalledTimes(2); // probe at 10000, then the 409 shares themselves
    });

    it("refuses a budget that cannot cover the fixed costs", async () => {
        const session = new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router: ONE_TO_ONE.router(0n),
            yieldToken: ONE_TO_ONE.yieldToken,
        });
        await expect(session.sizeSharesForBudget(0n)).rejects.toBeInstanceOf(InvalidYieldAmount);
        await expect(session.sizeSharesForBudget(3n)).rejects.toBeInstanceOf(InvalidYieldAmount); // 1 headroom + 2 zap

        // The three figures travel as fields. They are the UNDERLYING the wallet
        // spends, not the ppUSDC shares it would receive, so an embedder must
        // format them with the underlying's decimals and ticker.
        const error = await session.sizeSharesForBudget(3n).catch((e: unknown) => e);
        expect(hasErrorAmounts(error) && error.amounts).toEqual({
            code: "yieldBudgetBelowFixedCosts",
            side: "spent",
            values: { budget: 3n, headroom: 1n, zapBuffer: 2n },
        });
        // A bare bounds check keeps reporting only its message: `budget must be > 0`
        // echoes the caller's own input and is not a figure to render as money.
        const zero = await session.sizeSharesForBudget(0n).catch((e: unknown) => e);
        expect(hasErrorAmounts(zero)).toBe(false);
    });

    it("refuses a re-quote that no longer fits the spendable budget, with both figures", async () => {
        // headroomPpm 0 still reserves the 1-unit floor ppmHeadroom keeps, so spendNow is
        // budget − 1 and the payload is exact. The probe prices
        // `capacity` shares 100 bps above their value, so the sized shares differ from the
        // probe and a SECOND quote is taken — that is the one that comes back unaffordable,
        // which is what happens when the rate or the vetting fee moves mid-sizing.
        const quote = vi
            .fn()
            .mockResolvedValueOnce({ underlyingNeeded: 500_000n, total: 505_000n })
            .mockResolvedValue({ underlyingNeeded: 2_000_000n, total: 2_000_000n });
        const session = new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router: {
                getAddress: (): typeof DEP.ppRouter => DEP.ppRouter,
                quote,
                quoteWithdraw: vi.fn(async () => 0n),
                supplyBufferUnits: vi.fn(async () => 2n),
            },
            yieldToken: mockYieldToken(500_000n),
        });

        const error = await session.sizeSharesForBudget(1_000_000n, 0n).catch((e: unknown) => e);
        expect((error as Error).message).toBe(
            "Invalid yield amount: router quote 2000000 exceeds the spendable budget 999999: the rate or fee moved while sizing, size again",
        );
        // UNDERLYING units (what the wallet spends), not the ppUSDC shares bought.
        expect(hasErrorAmounts(error) && error.amounts).toEqual({
            code: "invalidYieldAmount",
            side: "spent",
            values: { quote: 2_000_000n, budget: 999_999n },
        });
    });

    it("infers the vetting fee from one quote exactly", () => {
        const cap = 1_000_000_000_000n;
        expect(inferVettingFeeBps(cap, cap)).toBe(0n);
        expect(inferVettingFeeBps(cap, cap + (cap * 8_000n) / 10_000n)).toBe(8_000n);
        expect(inferVettingFeeBps(cap, cap + (cap * 1n) / 10_000n)).toBe(1n);
        const big = 42_857_099_142_857_142_857n;
        expect(inferVettingFeeBps(big, big + (big * 50n) / 10_000n)).toBe(50n);
        expect(inferVettingFeeBps(0n, 5n)).toBe(0n);
    });
});

describe("PoolSessionYieldDeposit native mode and executor funding", () => {
    function build(nativeMode: boolean, allowance = 0n): EvmPoolSessionYieldDeposit {
        return new EvmPoolSessionYieldDeposit(
            {
                deployment: { ...DEP, ...(nativeMode ? { nativeMode: true } : {}) },
                deposit: mockDeposit(entrypointDepositCalldata()),
                router: mockRouter(UNDERLYING_NEEDED),
                yieldToken: mockYieldToken(SHARES),
                allowanceOf: async () => allowance,
            },
            {},
        );
    }

    it("a native-mode router gets depositExactSharesNative carrying the cap as value and no approvals", async () => {
        const prepared = await build(true).prepareYieldDeposit({
            value: SHARES,
            maxUnderlyingIn: 1_500_000n,
        });
        const decoded = decodeFunctionData({
            abi: PP_ROUTER_DEPOSIT_NATIVE_ABI,
            data: prepared.depositTx.data,
        });
        expect(decoded.functionName).toBe("depositExactSharesNative");
        expect(decoded.args).toHaveLength(3);
        expect(BigInt(prepared.depositTx.value)).toBe(1_500_000n);
        expect(prepared.depositTx.to).toBe(DEP.ppRouter);
        expect(prepared.approvalTxs).toEqual([]);
        expect(prepared.approvalTx).toBeNull();
    });

    it("executor funding skips the wallet approval on an ERC-20 router; wallet funding still plans it", async () => {
        const executor = await build(false).prepareYieldDeposit({
            value: SHARES,
            maxUnderlyingIn: 1_500_000n,
            fundingSource: "executor",
        });
        expect(executor.approvalTxs).toEqual([]);
        expect(executor.approvalTx).toBeNull();
        expect(BigInt(executor.depositTx.value)).toBe(0n);
        const decoded = decodeFunctionData({
            abi: PP_ROUTER_DEPOSIT_ABI,
            data: executor.depositTx.data,
        });
        expect(decoded.functionName).toBe("depositExactShares");
        expect(decoded.args[3]).toBe(1_500_000n);
        const wallet = await build(false).prepareYieldDeposit({
            value: SHARES,
            maxUnderlyingIn: 1_500_000n,
        });
        expect(wallet.approvalTxs.length).toBeGreaterThan(0);
    });

    it("sizeSharesForBudget honours a larger headroom for a cross-chain leg", async () => {
        // A router quote well under the budget, so both sizings succeed and only the reserve differs.
        const session = new EvmPoolSessionYieldDeposit(
            {
                deployment: DEP,
                deposit: mockDeposit(entrypointDepositCalldata()),
                router: mockRouter(500_000n),
                yieldToken: mockYieldToken(SHARES),
            },
            {},
        );
        const tight = await session.sizeSharesForBudget(1_000_000n);
        const loose = await session.sizeSharesForBudget(
            1_000_000n,
            CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
        );
        expect(tight.headroom).toBe(1n);
        expect(loose.headroom).toBe(500n);
        expect(loose.maxUnderlyingIn).toBe(1_000_000n);
        expect(ppmHeadroom(1_000_000n, CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM)).toBe(500n);
    });
});
