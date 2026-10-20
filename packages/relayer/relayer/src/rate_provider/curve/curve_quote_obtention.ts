// This file deals with the task of homogeneizing the interfaces for different contracts used by providers.
// You will typically need to address tasks such as targetting the adequate contracct method and shaping whatever request
// you get into our expected `Quote` type.

// You will feed the module with a getRcpFunction factory that transforms the viem `readContract` method into a simply typed function that the DynamicModule takes as input, plus
import type { Address } from "viem";
import { TokenDescription, Quote, RateProvider, RateGetterFunction } from "../rate_types";
import { ChainType } from "../../config/enums";
import { RATE_PROVIDER_ABI } from "./abi";
import { getWallet } from "../utilities";

// https://docs.curve.finance/developer/integration/rate-provider
// For each quote, the balances of the source and destination tokens in the pool are normalized to a scale of 18 decimals.
export const decimal_precission = 18;

interface CurveChainConfig {
    oracleAddress: Address;
    anchor: { address: Address; ticker: string; decimals: number };
    // How far back the historic self-comparison reads (see validateAgainstHistoricRate).
    // Must stay within the ~128-block state window a default (non-archive) full node
    // serves, or every quote on that chain fails the historic read.
    historicLookbackBlocks: bigint;
}

// One entry per chain Curve's rate-provider oracle is actually deployed on and verified
// for. A chain missing here throws explicitly below rather than reusing another chain's
// oracle/anchor by accident. See oracle_addresses.md for how each address was verified.
const CURVE_CONFIG_BY_CHAIN_ID: Partial<Record<number, CurveChainConfig>> = {
    1: {
        // from https://github.com/curvefi/curve-core/blob/main/deployments/prod/stable.yaml
        oracleAddress: "0xA834f3d23749233c9B61ba723588570A1cCA0Ed7",
        anchor: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", ticker: "WETH", decimals: 18 },
        historicLookbackBlocks: 50n, // ~10 min at 12s blocks
    },
    42161: {
        // Not in curve-core's deployments/prod/ (no arbitrum.yaml there) — found via
        // Arbitrum's own AddressProvider instance (0x5ffe7FB8...e35E98, distinct from the
        // canonical 0x0000...4383 one, which has no ID 18 registered on Arbitrum),
        // get_address(18). See oracle_addresses.md for the full on-chain verification.
        oracleAddress: "0xcbc1BE39ba277525E774976c61660f29fA75C5a4",
        anchor: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", ticker: "WETH", decimals: 18 },
        // ~25s at 250ms blocks: short, but the attack this guards against is
        // single-block flash manipulation, and 100 stays inside the 128-block
        // state window so a non-archive RPC can still serve the historic read.
        historicLookbackBlocks: 100n,
    },
};

// Deviation threshold for the historic self-comparison, in basis points.
// 10% absorbs honest market movement over the lookback window (minutes) while
// still rejecting the order-of-magnitude skews rate manipulation produces.
export const DEFAULT_MAX_HISTORIC_DEVIATION_BPS = 1_000n;
const BPS_DENOMINATOR = 10_000n;

// Guard against transient (flash-loan style) manipulation of the pools Curve's
// aggregator reads: re-read the same oracle at a block `historicLookbackBlocks`
// back and refuse to quote if the two rates disagree beyond the threshold. The
// chain itself is the persistent store here — the relayer runs scale-to-zero
// (per-request cold starts on GCP), so an in-memory last-known-good cache would
// be empty on exactly the request an attacker times. A manipulated present
// sticks out against the un-manipulated past because the attacker's skew only
// exists in the manipulation block(s). This cannot catch a *persistently* wrong
// oracle (both reads share the source); that requires an independent witness.
async function validateAgainstHistoricRate(
    wallet: ReturnType<typeof getWallet>,
    config: CurveChainConfig,
    input_token: TokenDescription,
    chainId: number,
    current_rate: bigint,
): Promise<void> {
    if (process.env.DISABLE_CURVE_HISTORIC_RATE_CHECK === "true") return;

    // input_token IS the anchor (e.g. a caller quoting WETH itself, such as a native-asset
    // dust price substituting the anchor address for pricing purposes) — the manipulation
    // check below reads get_aggregated_rate(input_token, anchor), which degenerates to
    // anchor/anchor here. No pool trades a token against itself, so this always reverts
    // with "No available market" rather than validating anything; there is also nothing to
    // validate, since the anchor's rate against itself is trivially 1 and cannot itself be
    // flash-manipulated the way a real pool pair can.
    if (input_token.address.toLowerCase() === config.anchor.address.toLowerCase()) return;

    const maxDeviationBps = BigInt(
        process.env.CURVE_RATE_MAX_DEVIATION_BPS ?? DEFAULT_MAX_HISTORIC_DEVIATION_BPS
    );

    const currentBlock = await wallet.getBlockNumber();
    // Chains younger than the lookback window only occur on fresh local devnets;
    // production chains are far past it. Skip rather than read state at block 0.
    if (currentBlock <= config.historicLookbackBlocks) return;
    const historicBlock = currentBlock - config.historicLookbackBlocks;

    let historic_rate: unknown;
    try {
        historic_rate = await wallet.readContract({
            address: config.oracleAddress,
            abi: RATE_PROVIDER_ABI,
            functionName: "get_aggregated_rate",
            args: [input_token.address, config.anchor.address],
            blockNumber: historicBlock,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Historic rate read at block ${historicBlock} failed for ${input_token.ticker} on ` +
            `chainId=${chainId}: ${message}. The RPC must serve state ` +
            `${config.historicLookbackBlocks} blocks back (default full-node window is 128). ` +
            `Set DISABLE_CURVE_HISTORIC_RATE_CHECK=true to bypass this guard.`
        , { cause: err });
    }
    if (typeof historic_rate !== "bigint" || historic_rate === 0n) {
        // A zero/invalid historic rate means the oracle wasn't pricing this pair a few
        // minutes ago — no trustworthy baseline, so fail closed. For a newly listed
        // asset this self-resolves once the oracle is older than the lookback window.
        throw new Error(
            `No valid historic rate at block ${historicBlock} for ${input_token.ticker} on ` +
            `chainId=${chainId} (got ${String(historic_rate)}) — cannot validate the current ` +
            `rate against a baseline, refusing to quote.`
        );
    }

    const deviation = current_rate > historic_rate ? current_rate - historic_rate : historic_rate - current_rate;
    if (deviation * BPS_DENOMINATOR > maxDeviationBps * historic_rate) {
        throw new Error(
            `Curve rate for ${input_token.ticker} on chainId=${chainId} deviates more than ` +
            `${maxDeviationBps} bps from its value ${config.historicLookbackBlocks} blocks ago ` +
            `(current=${current_rate}, historic=${historic_rate}) — possible rate manipulation, ` +
            `refusing to quote.`
        );
    }
}

// Historic-rate validation only ever reads input_token's own price history against
// config.anchor — it's a flash-manipulation guard on the ORACLE's coverage of
// input_token, independent of what output_token a caller actually wants priced against.
// Kept keyed to the verified anchor even for arbitrary-output-token quotes below.
function currentConfig(chainId: number): CurveChainConfig {
    const config = CURVE_CONFIG_BY_CHAIN_ID[chainId];
    if (!config) {
        throw new Error(
            `Curve has no verified oracle contract for chainId=${chainId} yet — refusing to quote ` +
            `rather than reuse another chain's oracle/anchor.`
        );
    }
    return config;
}

/**
 * Generalized rate getter that actually respects `output_token`, unlike the legacy
 * `queryRate` below (which silently substitutes a hardcoded anchor). Curve's
 * `get_aggregated_rate` is Metaregistry-backed and genuinely prices arbitrary pairs —
 * confirmed against https://docs.curve.finance/developer/integration/rate-provider —
 * with one real constraint: no multi-hop routing, only pools that exist *directly*
 * between the two tokens. Coverage for a given (input, output) pair on a given chain is
 * not guaranteed and isn't validated ahead of time here; a missing direct pool surfaces
 * as the same zero-rate error below.
 */
export const queryRateForPair: RateGetterFunction = async function (
    input_token: TokenDescription,
    output_token: TokenDescription,
    chainType: ChainType,
    chainId: number,
    rpc_url: string,
): Promise<Quote> {
    const config = currentConfig(chainId);

    const wallet = getWallet(rpc_url);
    const aggregated_rate = await wallet.readContract({
        address: config.oracleAddress,
        abi: RATE_PROVIDER_ABI,
        functionName: "get_aggregated_rate",
        args: [input_token.address, output_token.address],
    });
    if (typeof aggregated_rate !== "bigint") {
        throw new Error(`Provider returned unexpected rate value`);
    }
    // A zero rate is a valid bigint but not a valid price — it means this oracle doesn't
    // actually track this token pair (verified for DAI/WETH on mainnet: distinct from an
    // unsupported chain, this asset just isn't in whatever pool set this specific oracle
    // aggregates over, or — for an arbitrary output_token — there's no direct pool
    // between input_token and output_token). Left unchecked, this flows into fee math as
    // a division by zero downstream instead of failing with a clear cause.
    if (aggregated_rate === 0n) {
        throw new Error(
            `Curve oracle returned a zero rate for ${input_token.ticker} (${input_token.address}) -> ` +
            `${output_token.ticker} (${output_token.address}) on chainId=${chainId} — no direct pool, ` +
            `or this asset isn't priced by this oracle.`
        );
    }

    // A nonzero rate can still be a *wrong* rate: the oracle aggregates spot pool
    // state, so a flash-manipulated pool yields a rate that flows straight into fee
    // math and collapses the relayer's gas-cost floor in token terms (fee is charged
    // in tokens; the 650k-gas floor only holds in wei). Validate before returning.
    await validateAgainstHistoricRate(wallet, config, input_token, chainId, aggregated_rate);

    return {
        source: RateProvider.CURVE,
        den: 1n,
        num: aggregated_rate,
        token_in: input_token,
        token_out: output_token,
        chainType,
        chainId,
    };
};

/**
 * Legacy name, preserved as a curried wrapper pinned to the verified per-chain WETH
 * anchor — zero behavior change for every existing caller (quoteInNativeToken,
 * RateProviderModule.register(RateProvider.CURVE, ...)). This is a deliberate safety
 * boundary, not just an API nicety: the existing native-gas-cost conversion path must
 * keep using the hardcoded, independently-verified anchor address (oracle_addresses.md),
 * never whatever output_token a caller happens to pass.
 */
export const queryRate: RateGetterFunction = async function (
    input_token: TokenDescription,
    _output_token: TokenDescription,
    chainType: ChainType,
    chainId: number,
    rpc_url: string,
): Promise<Quote> {
    const config = currentConfig(chainId);
    const anchorDescription: TokenDescription = {
        address: config.anchor.address,
        ticker: config.anchor.ticker,
        quoter: RateProvider.CURVE,
        decimals: config.anchor.decimals,
        chainType,
        chainId,
    };
    return queryRateForPair(input_token, anchorDescription, chainType, chainId, rpc_url);
};
