import type { Address, YieldDeployment } from "../internal.js";

/**
 * Aave-yield (ppUSDC) constants: on-chain ABIs, per-chain deployment addresses, and the sizing
 * margins the deposit/withdraw flows apply.
 *
 * ppUSDC is an ERC-4626-style yield-bearing wrapper around Aave-supplied USDC. The pool shields
 * the *shares*; the user holds/withdraws the *underlying* (USDC). The combined `PPRouter` bridges
 * the two — `depositExactShares` (USDC -> ppUSDC + shield) and `withdrawToUnderlying`
 * (shielded ppUSDC -> USDC -> recipient). See docs and the `scripts/e2e-yield` reference flows.
 */

// ---------------------------------------------------------------------------
// ABIs (read surface — Phase 1). Deposit/withdraw encode ABIs land with the
// deposit/withdraw sessions.
// ---------------------------------------------------------------------------

/**
 * ppUSDC (PPYieldToken) ERC-4626 read surface:
 *   - `exchangeRate()`     — live underlying value of one whole ppUSDC (10**18 shares),
 *                            asset-denominated (scaled to 10**underlyingDecimals).
 *   - `previewDeposit(a)`  — shares minted for depositing `a` underlying (USDC->ppUSDC, fee-excl).
 *   - `previewRedeem(s)`   — underlying redeemable for `s` shares (ppUSDC->USDC); the value of a note.
 *   - `decimals()`         — share decimals (18); usually read from {@link YieldDeployment} instead.
 */
export const PP_YIELD_TOKEN_ABI = [
    {
        type: "function",
        name: "exchangeRate",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "previewDeposit",
        inputs: [{ name: "assets", type: "uint256" }],
        outputs: [{ name: "shares", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "previewRedeem",
        inputs: [{ name: "shares", type: "uint256" }],
        outputs: [{ name: "assets", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "decimals",
        inputs: [],
        outputs: [{ name: "", type: "uint8" }],
        stateMutability: "view",
    },
] as const;

/**
 * ppUSDC (PPYieldToken) ERC-4626 `redeem` write surface. Redeems `shares` directly at the wrapper
 * for the aToken (aUSDC) — the always-available exit that never calls Aave, so it cannot be blocked
 * by Aave liquidity or the pool. Use it to exit to aUSDC instead of unwrapping to USDC via the zap.
 */
export const PP_YIELD_TOKEN_REDEEM_ABI = [
    {
        type: "function",
        name: "redeem",
        inputs: [
            { name: "shares", type: "uint256" },
            { name: "receiver", type: "address" },
            { name: "owner", type: "address" },
        ],
        outputs: [{ name: "assets", type: "uint256" }],
        stateMutability: "nonpayable",
    },
] as const;

/**
 * `PPYieldTokenZap.redeemToUnderlying(shares, receiver)` — the one-call exit for a holder of LOOSE
 * ppUSDC shares (notably after a ragequit) back to the UNDERLYING (USDC), unwrapping the aToken via
 * Aave. Distinct from `PPYieldToken.redeem`, which yields the aToken, not the underlying.
 */
export const PP_YIELD_TOKEN_ZAP_REDEEM_ABI = [
    {
        type: "function",
        name: "redeemToUnderlying",
        inputs: [
            { name: "shares", type: "uint256" },
            { name: "receiver", type: "address" },
        ],
        outputs: [{ name: "underlyingOut", type: "uint256" }],
        stateMutability: "nonpayable",
    },
] as const;

/**
 * `PPRouter` read surface used to size deposits and withdrawals:
 *   - `quote(value)`         — (underlyingNeeded, total) to mint `value` ppUSDC shares.
 *   - `quoteWithdraw(shares)`— underlying redeemable for `shares` (aToken is ~1:1 with underlying).
 */
export const PP_ROUTER_ABI = [
    {
        type: "function",
        name: "quote",
        inputs: [{ name: "value", type: "uint256" }],
        outputs: [
            { name: "underlyingNeeded", type: "uint256" },
            { name: "total", type: "uint256" },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "quoteWithdraw",
        inputs: [{ name: "shares", type: "uint256" }],
        outputs: [{ name: "underlyingOut", type: "uint256" }],
        stateMutability: "view",
    },
] as const;

/**
 * `PPRouter.depositExactShares` write surface. Mints exactly `value` ppUSDC shares (bound in the
 * deposit proof) and shields them, pulling at most `maxUnderlyingIn` of the underlying from the
 * caller. The proof/noteData/aspCiphertext are forwarded verbatim to `Entrypoint.deposit`, so they
 * are the same args a standard SDK deposit produces — the router only adds the wrap + the spend cap.
 */
export const PP_ROUTER_DEPOSIT_ABI = [
    {
        type: "function",
        name: "depositExactShares",
        inputs: [
            {
                name: "proof",
                type: "tuple",
                components: [
                    { name: "pA", type: "uint256[2]" },
                    { name: "pB", type: "uint256[2][2]" },
                    { name: "pC", type: "uint256[2]" },
                    { name: "pubSignals", type: "uint256[4]" },
                ],
            },
            {
                name: "noteData",
                type: "tuple",
                components: [
                    { name: "hint", type: "bytes32" },
                    { name: "data", type: "bytes" },
                ],
            },
            { name: "aspCiphertext", type: "bytes" },
            { name: "maxUnderlyingIn", type: "uint256" },
        ],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "nonpayable",
    },
] as const;

/** Payable exact-share deposit. The native value is the spend cap. */
export const PP_ROUTER_DEPOSIT_NATIVE_ABI = [
    {
        ...PP_ROUTER_DEPOSIT_ABI[0],
        name: "depositExactSharesNative",
        inputs: [
            PP_ROUTER_DEPOSIT_ABI[0].inputs[0],
            PP_ROUTER_DEPOSIT_ABI[0].inputs[1],
            PP_ROUTER_DEPOSIT_ABI[0].inputs[2],
        ],
        stateMutability: "payable",
    },
] as const;

/**
 * `PPRouter.withdrawToUnderlying` write surface. Unshields `proof.amountOut` ppUSDC shares to the
 * router (bound as processor in the transact proof), unwraps them to the underlying, and forwards
 * at least `minUnderlyingOut` to the recipient. The proof/transactParams/noteData are the same args
 * a standard SDK withdraw (`PoolVault.transact`) produces; the router adds the unwrap + slippage floor.
 */
export const PP_ROUTER_WITHDRAW_ABI = [
    {
        type: "function",
        name: "withdrawToUnderlying",
        inputs: [
            {
                name: "proof",
                type: "tuple",
                components: [
                    { name: "pA", type: "uint256[2]" },
                    { name: "pB", type: "uint256[2][2]" },
                    { name: "pC", type: "uint256[2]" },
                    { name: "pubSignals", type: "uint256[][]" },
                ],
            },
            {
                name: "transactParams",
                type: "tuple",
                components: [
                    { name: "processor", type: "address" },
                    { name: "data", type: "bytes" },
                ],
            },
            {
                name: "noteData",
                type: "tuple[]",
                components: [
                    { name: "hint", type: "bytes32" },
                    { name: "data", type: "bytes" },
                ],
            },
            { name: "minUnderlyingOut", type: "uint256" },
        ],
        outputs: [
            { name: "toRecipient", type: "uint256" },
            { name: "fee", type: "uint256" },
        ],
        stateMutability: "payable",
    },
] as const;

// ---------------------------------------------------------------------------
// Sizing margins
// ---------------------------------------------------------------------------

// YIELD_BPS_DENOMINATOR, WITHDRAW_SLIPPAGE_BPS, YIELD_PPM_DENOMINATOR and
// DEPOSIT_RATE_HEADROOM_PPM moved to core-sdk (constant/Yield.ts) with the chain-agnostic yield
// sessions; they reach this package's consumers through the core re-export.

/**
 * Underlying units the zap supplies to Aave on top of `previewMint` on every deposit, as a rounding
 * buffer (`PPYieldTokenZap._SUPPLY_ROUNDING_BUFFER`). The router quote includes them; a cap or a
 * budget sized from anything OTHER than the router quote must add them.
 */
export const ZAP_SUPPLY_BUFFER_UNITS = 2n;

/**
 * @deprecated No discount is applied to the shares any more: `sharesForUnderlying` returns
 * `previewDeposit(underlying)` exactly and the headroom lives in the spend cap
 * ({@link DEPOSIT_RATE_HEADROOM_PPM}). Kept exported, at 0, so callers that mirrored the old
 * formula compute the same figure the SDK does.
 */
export const DEPOSIT_SHARES_DISCOUNT_BPS = 0n;

/**
 * @deprecated The SDK no longer pads `maxUnderlyingIn` by a slippage margin; see
 * {@link DEPOSIT_RATE_HEADROOM_PPM}. Kept exported for source compatibility only.
 */
export const DEPOSIT_SLIPPAGE_BPS = 1000n;

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

/**
 * Canonical per-chain yield deployments.
 *
 * Empty by design: the Aave-yield module is not deployed to a public network yet. Supply your own
 * {@link YieldDeployment} (see {@link getYieldDeployment}'s `deployments` argument), or use
 * {@link LOCAL_FORK_YIELD_DEPLOYMENT} for the local anvil Sepolia fork.
 */
export const YIELD_DEPLOYMENTS: Readonly<Record<number, YieldDeployment>> = Object.freeze({});

/**
 * Local anvil Sepolia fork deployment — DEV/TEST ONLY.
 *
 * These addresses come from `docs/deployments.local.json` and are deterministic for the documented
 * deploy sequence, but are only valid while that fork runs. They are NOT a public Sepolia or
 * mainnet deployment; never treat them as canonical. Kept here as the reference the `e2e-yield`
 * scripts and the frontend exercise.
 */
export const LOCAL_FORK_YIELD_DEPLOYMENT: YieldDeployment = {
    ppRouter: "0x08e984a00E5575b366310f3dE7f53135e139F1b1" as Address,
    ppUSDC: "0x305E689dc6659273CAD6F5b43Ae4001f39D2519d" as Address,
    ppUSDCDecimals: 18,
    underlying: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8" as Address,
    underlyingDecimals: 6,
    underlyingSymbol: "USDC",
    apyLabel: "Aave",
};

/**
 * Display symbol for a shielded Aave-yield position. The note holds ppUSDC *shares*, but the user
 * thinks in USDC — so the UI presents the position as "USDC · Aave yield". The raw `ppUSDC` symbol
 * must never be shown to the user as a deposit/withdraw asset.
 */
export const YIELD_DISPLAY_SYMBOL = "USDC";
export const YIELD_DISPLAY_BADGE = "Aave yield";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Looks up the yield deployment for `chainId`.
 *
 * @param chainId - EIP-155 chain id.
 * @param deployments - Deployment map to read; defaults to the (empty) canonical {@link YIELD_DEPLOYMENTS}.
 *   Pass your own map (e.g. `{ 11155111: LOCAL_FORK_YIELD_DEPLOYMENT }`) until yield ships publicly.
 * @returns The deployment, or undefined if the chain has none.
 */
export function getYieldDeployment(
    chainId: number,
    deployments: Readonly<Record<number, YieldDeployment>> = YIELD_DEPLOYMENTS,
): YieldDeployment | undefined {
    return deployments[chainId];
}

/**
 * True if `tokenAddress` is the ppUSDC share token for `chainId` in `deployments` — i.e. a deposit
 * or withdraw that must route through the `PPRouter` rather than the plain Entrypoint/relay path.
 */
export function isYieldToken(
    chainId: number,
    tokenAddress: string,
    deployments: Readonly<Record<number, YieldDeployment>> = YIELD_DEPLOYMENTS,
): boolean {
    const dep = deployments[chainId];
    return !!dep && tokenAddress.toLowerCase() === dep.ppUSDC.toLowerCase();
}

/** True if `symbol` is the internal share-token symbol for a yield note (note bookkeeping only). */
export function isPpUsdcSymbol(symbol: string): boolean {
    return symbol.toUpperCase() === "PPUSDC";
}
