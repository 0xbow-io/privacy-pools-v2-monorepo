import { TokenDescription, Quote, RateProvider, RateGetterFunction } from "../rate_types";
import { ChainType } from "../../config/enums";
import type { Address } from "viem";
import { OrderBookApi, OrderBookApiError, SupportedChainId, OrderQuoteSideKindSell } from "@cowprotocol/cow-sdk";
import type { OrderQuoteRequest } from "@cowprotocol/cow-sdk";

// https://docs.cow.fi/cow-protocol/reference/apis/orderbook
// We only need a price quote — no signer required.

const DUMMY_FROM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// CoW Protocol's own SDK officially supports all 5 of these chains  — see anchor_tokens.md for the full information.
const ANCHOR_TOKEN_BY_CHAIN_ID: Partial<Record<number, { address: Address; ticker: string; decimals: number }>> = {
    [SupportedChainId.MAINNET]: {
        address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        ticker: "WETH",
        decimals: 18,
    },
    [SupportedChainId.GNOSIS_CHAIN]: {
        // Bridged WETH ("Wrapped Ether on xDai") — Gnosis Chain's native gas token is xDAI,
        // not ETH, so this is a legitimate bridged anchor rather than a wrapped-native-gas
        // token like the other four entries here.
        address: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1",
        ticker: "WETH",
        decimals: 18,
    },
    [SupportedChainId.ARBITRUM_ONE]: {
        address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        ticker: "WETH",
        decimals: 18,
    },
    [SupportedChainId.BASE]: {
        address: "0x4200000000000000000000000000000000000006",
        ticker: "WETH",
        decimals: 18,
    },
    [SupportedChainId.SEPOLIA]: {
        address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
        ticker: "WETH",
        decimals: 18,
    },
};

function toSupportedChainId(chainId: number): SupportedChainId {
    const supported = Object.values(SupportedChainId).filter((value): value is number => typeof value === "number");
    if (!supported.includes(chainId)) {
        throw new Error(`CowSwap does not support chainId=${chainId} (not a member of SupportedChainId)`);
    }
    return chainId as SupportedChainId;
}

// The orderbook API rejects a quote whose sellAmountBeforeFee doesn't cover the current
// network/protocol fee (SellAmountDoesNotCoverFee) — expected for a fixed 1-unit notional
// once gas costs exceed ~$1, and worse on congested chains. Its error body already carries
// the fee actually required right now, so retry once at a small multiple of that instead of
// guessing a fixed notional that would be wrong across different tokens/chains/gas markets.
interface SellAmountDoesNotCoverFeeBody {
    errorType?: string;
    data?: { fee_amount?: string };
}

const FEE_RETRY_SAFETY_MULTIPLIER = 10n;

// A notional of exactly 1 whole unit is routinely below the current network/protocol fee
// (verified: mainnet fee floor is commonly $2-4 equivalent), which would make the
// SellAmountDoesNotCoverFee retry below the common case instead of a rare fallback — doubling
// every quote's network round trips. Starting one order of magnitude higher keeps the retry
// as true defense-in-depth (gas spikes, unusually cheap-per-unit tokens) without meaningfully
// distorting the rate for the near-$1 stablecoins this is chiefly used against.
const BASE_NOTIONAL_MULTIPLIER = 100n;

// The only shape this helper is ever called with — narrowed from the full OrderQuoteRequest
// union so the sellAmountBeforeFee retry below type-checks against one concrete branch
// instead of all three (sell-before-fee / sell-after-fee / buy-after-fee).
type SellQuoteRequest = Extract<OrderQuoteRequest, { kind: OrderQuoteSideKindSell; sellAmountBeforeFee: string }>;

async function getQuoteAboveFee(orderBookApi: OrderBookApi, request: SellQuoteRequest) {
    try {
        return await orderBookApi.getQuote(request);
    } catch (err) {
        if (err instanceof OrderBookApiError) {
            const body = err.body as SellAmountDoesNotCoverFeeBody;
            if (body?.errorType === "SellAmountDoesNotCoverFee" && body.data?.fee_amount) {
                const retrySellAmount = BigInt(body.data.fee_amount) * FEE_RETRY_SAFETY_MULTIPLIER;
                return await orderBookApi.getQuote({ ...request, sellAmountBeforeFee: retrySellAmount.toString() });
            }
        }
        throw err;
    }
}

/**
 * Generalized rate getter that actually respects `output_token`, unlike the legacy
 * `queryRate` below (which silently substitutes a hardcoded anchor). No coverage caveat
 * to speak of here, unlike Curve — CowSwap is a general aggregator, `buyToken` is
 * already just a parameter to its own API.
 */
export const queryRateForPair: RateGetterFunction = async function (
    input_token: TokenDescription,
    output_token: TokenDescription,
    chainType: ChainType,
    chainId: number,
    _rpc_url: string,
): Promise<Quote> {
    // toSupportedChainId already throws for a chain CowSwap doesn't support at all;
    // no separate anchor-coverage check needed once output_token is a real parameter.
    const orderBookApi = new OrderBookApi({ chainId: toSupportedChainId(chainId) });

    const quoteResponse = await getQuoteAboveFee(orderBookApi, {
        sellToken: input_token.address,
        buyToken: output_token.address,
        from: DUMMY_FROM,
        kind: OrderQuoteSideKindSell.SELL,
        sellAmountBeforeFee: (BASE_NOTIONAL_MULTIPLIER * 10n ** BigInt(input_token.decimals)).toString(),
    });

    const sellAmount = BigInt(quoteResponse.quote.sellAmount);
    const buyAmount = BigInt(quoteResponse.quote.buyAmount);

    // Both must be strictly positive: a zero buyAmount would divide-by-zero downstream
    // (nativeToToken divides by num); a zero sellAmount wouldn't crash but would silently
    // zero out the computed relay fee instead (den is a multiplicand there, not a divisor) —
    // mirrors the equivalent guard in curve_quote_obtention.ts.
    if (buyAmount <= 0n || sellAmount <= 0n) {
        throw new Error(
            `CowSwap returned a non-positive quote for ${input_token.ticker} (${input_token.address}) -> ` +
            `${output_token.ticker} (${output_token.address}) on chainId=${chainId}: ` +
            `sellAmount=${sellAmount}, buyAmount=${buyAmount}.`
        );
    }

    // Normalize the raw base-unit trade amounts to the shared Quote convention
    // (Curve's): num/den = whole-output-token per whole-input-token, scaled by 1e18.
    // Consumers (nativeToToken, microUsdPerWholeTokenX1e18) rely on this being
    // decimals-invariant; returning raw buyAmount/sellAmount here made nativeToToken
    // re-apply 10^tokenDecimals and overcharge non-18-decimal assets by that factor
    // (observed live: ~437,000 USDT fee quoted on a 5 USDT withdrawal). Kept as an
    // exact fraction — both sides multiplied, never divided — so no precision is lost
    // before the consumer's own division.
    return {
        source: RateProvider.COWSWAP,
        den: sellAmount * 10n ** BigInt(output_token.decimals),
        num: buyAmount * 10n ** BigInt(input_token.decimals) * 10n ** 18n,
        token_in: input_token,
        token_out: output_token,
        chainType,
        chainId,
    };
};

/**
 * Legacy name, preserved as a curried wrapper pinned to the verified per-chain WETH
 * anchor — zero behavior change for every existing caller (quoteInNativeToken,
 * RateProviderModule.register(RateProvider.COWSWAP, ...)). This is a deliberate safety
 * boundary, not just an API nicety: the existing native-gas-cost conversion path must
 * keep using the hardcoded, independently-verified anchor address (anchor_tokens.md),
 * never whatever output_token a caller happens to pass.
 */
export const queryRate: RateGetterFunction = async function (
    input_token: TokenDescription,
    _output_token: TokenDescription,
    chainType: ChainType,
    chainId: number,
    rpc_url: string,
): Promise<Quote> {
    const anchor = ANCHOR_TOKEN_BY_CHAIN_ID[chainId];
    if (!anchor) {
        throw new Error(
            `CowSwap has no verified anchor token for chainId=${chainId} yet — refusing to quote ` +
            `rather than reuse another chain's anchor address.`
        );
    }
    const anchorDescription: TokenDescription = {
        address: anchor.address,
        ticker: anchor.ticker,
        quoter: RateProvider.COWSWAP,
        decimals: anchor.decimals,
        chainType,
        chainId,
    };
    return queryRateForPair(input_token, anchorDescription, chainType, chainId, rpc_url);
};
