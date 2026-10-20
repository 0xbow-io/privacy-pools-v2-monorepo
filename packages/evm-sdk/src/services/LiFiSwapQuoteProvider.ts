import type { QuoteRequestFromAmount, QuoteRequestToAmount, SDKClient } from "@lifi/sdk";
import type { ContractCallsQuoteRequest, LiFiStep } from "@lifi/types";
import { createClient, getContractCallsQuote, getQuote } from "@lifi/sdk";

import type {
    Address,
    Hex,
    ILogger,
    ISwapAndDepositQuoteProvider,
    ISwapQuoteProvider,
    LiFiSwapQuoteProviderConfig,
    LiFiSwapQuoteProviderDependencies,
    SwapAndDepositQuoteRequest,
    SwapAndDepositQuoteResult,
    SwapQuoteRequest,
    SwapQuoteResult,
    SwapStatus,
    SwapStatusRequest,
    SwapStatusResult,
    SwapSubstatus,
    SwapTransactionInfo,
} from "../internal.js";
import {
    acrossFillHeadroomFor,
    acrossFillHeadroomInputFor,
    applyAcrossFillHeadroom,
    canonicalTokenAddress,
    DEFAULT_LIFI_INTEGRATOR,
    hasAcrossDestinationSwap,
    spliceAcrossFillHeadroom,
    SwapQuoteFailed,
    SwapStatusFailed,
} from "../internal.js";

/**
 * LiFi-backed implementation of {@link ISwapQuoteProvider}.
 *
 * Calls the LiFi API via `@lifi/sdk` to obtain swap quotes and extract
 * the transaction calldata needed for on-chain execution. The calldata
 * can then be passed to {@link PoolSessionWithdrawAndSwap.relayWithdrawAndSwap} for
 * relayer-mediated withdraw-and-swap operations.
 */
export class LiFiSwapQuoteProvider implements ISwapQuoteProvider, ISwapAndDepositQuoteProvider {
    private readonly integrator: string;
    private readonly fee?: number;
    private readonly apiUrl: string;
    private readonly apiKey?: string;
    private readonly allowBridges?: string[];
    private readonly logger?: ILogger;
    private readonly client: SDKClient;

    constructor(config: LiFiSwapQuoteProviderConfig, deps?: LiFiSwapQuoteProviderDependencies) {
        this.integrator = config.integrator ?? DEFAULT_LIFI_INTEGRATOR;
        this.fee = config.fee;
        this.apiUrl = config.apiUrl ?? "https://li.quest/v1";
        this.apiKey = config.apiKey;
        this.allowBridges = config.allowBridges?.length ? [...config.allowBridges] : undefined;
        this.logger = deps?.logger;
        this.client = createClient({
            integrator: this.integrator,
            ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        });
    }

    /**
     * @inheritdoc ISwapProvider.getSwapStatus
     * @throws {SwapStatusFailed} If the LiFi status API call fails or returns an unparseable response.
     */
    async getSwapStatus(params: SwapStatusRequest): Promise<SwapStatusResult> {
        this.logger?.debug("Requesting LiFi swap status...", {
            txHash: params.txHash,
            fromChainId: params.fromChainId,
            toChainId: params.toChainId,
        });

        const url = new URL(`${this.apiUrl}/status`);
        url.searchParams.set("txHash", params.txHash);
        url.searchParams.set("fromChain", params.fromChainId.toString());
        url.searchParams.set("toChain", params.toChainId.toString());
        if (params.bridge) {
            url.searchParams.set("bridge", params.bridge);
        }

        try {
            // Reuse the same API key header the SDK client sends on quote calls, so
            // /status shares the authenticated rate limit instead of the anonymous one.
            const response = await fetch(url.toString(), {
                headers: this.apiKey ? { "x-lifi-api-key": this.apiKey } : {},
            });
            if (!response.ok) {
                // 429/5xx are rate-limit/upstream faults; a 404 here means "not indexed
                // yet", not "never existed" — all three are worth a caller retrying
                // rather than treating as a permanent verdict.
                const retryable =
                    response.status === 429 || response.status === 404 || response.status >= 500;
                throw new SwapStatusFailed(
                    `LiFi status API returned ${response.status}: ${response.statusText}`,
                    retryable,
                );
            }

            const data = (await response.json()) as Record<string, unknown>;
            return this.mapStatusResponse(data);
        } catch (error) {
            if (error instanceof SwapStatusFailed) {
                throw error;
            }
            this.logger?.error("LiFi swap status request failed", { error });
            const message = error instanceof Error ? error.message : String(error);
            // A network-level failure (timeout, DNS, connection reset) is always worth
            // retrying — it says nothing about the transfer itself.
            throw new SwapStatusFailed(message, true);
        }
    }

    /**
     * @inheritdoc ISwapQuoteProvider.getSwapQuote
     * @throws {SwapQuoteFailed} If the LiFi API call fails or returns no transaction data.
     */
    async getSwapQuote(params: SwapQuoteRequest): Promise<SwapQuoteResult> {
        this.logger?.debug("Requesting LiFi swap quote...", {
            fromToken: params.fromToken,
            toToken: params.toToken,
            amount: params.amount,
            amountType: params.amountType,
            denyExchanges: params.denyExchanges,
        });

        const defaultSlippage = params.fromChainId === params.toChainId ? 0.005 : 0.03;
        const slippage = params.slippage ?? defaultSlippage;

        const baseParams = {
            fromChain: params.fromChainId,
            fromToken: params.fromToken,
            toChain: params.toChainId,
            toToken: params.toToken,
            fromAddress: params.fromAddress,
            slippage,
            ...(params.toAddress ? { toAddress: params.toAddress } : {}),
            ...(params.fallbackAddress ? { toFallbackAddress: params.fallbackAddress } : {}),
            ...(this.integrator ? { integrator: this.integrator } : {}),
            ...(this.fee !== undefined ? { fee: this.fee } : {}),
            ...(params.denyExchanges ? { denyExchanges: params.denyExchanges } : {}),
            ...this.bridgeFilter(params.fromChainId, params.toChainId),
        };

        try {
            const step = await this.fetchQuote(baseParams, params.amount, params.amountType);
            return this.extractSwapResult(step);
        } catch (error) {
            if (error instanceof SwapQuoteFailed) {
                throw error;
            }
            this.logger?.error("LiFi swap quote failed", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new SwapQuoteFailed(message);
        }
    }

    /**
     * @inheritdoc ISwapAndDepositQuoteProvider.getSwapAndDepositQuote
     * @throws {SwapQuoteFailed} If the LiFi API call fails or returns no transaction data.
     */
    async getSwapAndDepositQuote(
        params: SwapAndDepositQuoteRequest,
    ): Promise<SwapAndDepositQuoteResult> {
        this.logger?.debug("Requesting LiFi swap-and-deposit quote...", {
            fromToken: params.fromToken,
            toToken: params.toToken,
            depositAmount: params.depositAmount,
            denyExchanges: params.denyExchanges,
            fallbackAddress: params.fallbackAddress,
        });

        const defaultSlippage = params.fromChainId === params.toChainId ? 0.005 : 0.03;
        const slippage = params.slippage ?? defaultSlippage;

        const quoteRequest: ContractCallsQuoteRequest = {
            fromChain: params.fromChainId,
            fromToken: params.fromToken,
            toChain: params.toChainId,
            toToken: params.toToken,
            fromAddress: params.fromAddress,
            // fromAmount mode: LiFi takes the full available net budget, routes it,
            // passes depositAmount to the contractCall, and sends surplus to fallbackAddress.
            // Required for cross-asset swaps where a toAmount quote would inflate the needed
            // source input above the available net (e.g. USDC→USDT cross-chain).
            // toAmount mode: LiFi targets an exact destination amount, computing required input.
            ...(params.netFromAmount
                ? { fromAmount: params.netFromAmount }
                : { toAmount: params.depositAmount }),
            slippage,
            ...(this.integrator ? { integrator: this.integrator } : {}),
            ...(this.fee !== undefined ? { fee: this.fee } : {}),
            ...(params.denyExchanges ? { denyExchanges: params.denyExchanges } : {}),
            ...this.bridgeFilter(params.fromChainId, params.toChainId),
            ...(params.fallbackAddress ? { toFallbackAddress: params.fallbackAddress } : {}),
            contractCalls: [
                {
                    fromAmount: params.depositAmount,
                    fromTokenAddress: params.toToken,
                    toContractAddress: params.poolAddress,
                    toApprovalAddress: params.poolAddress,
                    toContractCallData: params.depositCalldata,
                    toContractGasLimit: params.depositGasLimit ?? "300000",
                },
            ],
        };

        try {
            const step = await getContractCallsQuote(this.client, quoteRequest);
            return await this.extractContractCallsResult(
                step,
                params.depositCalldata,
                quoteRequest,
            );
        } catch (error) {
            if (error instanceof SwapQuoteFailed) {
                throw error;
            }
            this.logger?.error("LiFi swap-and-deposit quote failed", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new SwapQuoteFailed(message);
        }
    }

    /** The configured bridge allowlist, applied to cross-chain quotes only. */
    private bridgeFilter(fromChainId: number, toChainId: number): { allowBridges?: string[] } {
        if (!this.allowBridges || fromChainId === toChainId) return {};
        return { allowBridges: this.allowBridges };
    }

    private async fetchQuote(
        baseParams: Record<string, unknown>,
        amount: string,
        amountType: "from" | "to",
    ): Promise<LiFiStep> {
        if (amountType === "to") {
            return getQuote(this.client, {
                ...baseParams,
                toAmount: amount,
            } as QuoteRequestToAmount);
        }
        return getQuote(this.client, {
            ...baseParams,
            fromAmount: amount,
        } as QuoteRequestFromAmount);
    }

    private async extractContractCallsResult(
        step: LiFiStep,
        depositCalldata: Hex,
        quoteRequest: ContractCallsQuoteRequest,
    ): Promise<SwapAndDepositQuoteResult> {
        const { transactionRequest } = step;
        let estimate = step.estimate;

        if (!transactionRequest?.data || !transactionRequest?.to) {
            throw new SwapQuoteFailed("LiFi contract-calls quote did not return transaction data.");
        }

        // The destination contract call is LiFi's `custom` step (the last step on the
        // destination chain). Its `fromAmount` is the route's guaranteed delivery, which
        // LiFi encodes in place of the `contractCalls[].fromAmount` we asked for.
        const customStep = step.includedSteps?.find(
            (s) => s.tool === "custom" && s.action?.fromChainId === step.action.toChainId,
        );

        // An Across leg that ends in our call leaves the filler more than LiFi priced
        // (utils/LiFiAcrossHeadroom.ts); the call's guaranteed delivery drops by the same amount.
        let transactionData = transactionRequest.data as Hex;
        let destinationCallAmount = customStep?.estimate?.fromAmount;
        if (step.action.fromChainId !== step.action.toChainId) {
            const headroom = acrossFillHeadroomFor(step.includedSteps);
            const patched =
                headroom !== undefined
                    ? applyAcrossFillHeadroom(transactionData, depositCalldata, headroom)
                    : undefined;
            if (patched) {
                transactionData = patched.transactionData;
                destinationCallAmount = patched.destinationCallAmount.toString();
                // The guaranteed delivery drops with it; never report what the calldata no longer delivers.
                const less = (v: string | undefined) =>
                    v === undefined
                        ? v
                        : (BigInt(v) > patched.reduction
                              ? BigInt(v) - patched.reduction
                              : 0n
                          ).toString();
                estimate = {
                    ...step.estimate,
                    toAmount: less(step.estimate.toAmount) ?? step.estimate.toAmount,
                    ...(step.estimate.toAmountMin !== undefined
                        ? { toAmountMin: less(step.estimate.toAmountMin) }
                        : {}),
                };
            } else if (
                headroom !== undefined &&
                hasAcrossDestinationSwap(transactionData, depositCalldata)
            ) {
                const spliced = await this.spliceAcrossFillHeadroom(
                    step,
                    depositCalldata,
                    quoteRequest,
                );
                transactionData = spliced.transactionData;
                destinationCallAmount = spliced.destinationCallAmount.toString();
                // What arrives is the reduced quote's delivery; what leaves is the full input.
                estimate = {
                    ...step.estimate,
                    toAmount: spliced.estimate.toAmount,
                    toAmountMin: spliced.estimate.toAmountMin,
                    toAmountUSD: spliced.estimate.toAmountUSD,
                };
            } else if (step.includedSteps?.some((s) => s.tool === "across")) {
                this.logger?.warn("Across leg left without fill headroom", {
                    headroom: headroom?.toString(),
                });
            }
        }

        const result: SwapAndDepositQuoteResult = {
            fromAmount: estimate.fromAmount,
            toAmount: estimate.toAmount,
            ...(estimate.toAmountMin ? { toAmountMin: estimate.toAmountMin } : {}),
            ...(destinationCallAmount ? { destinationCallAmount } : {}),
            fromAmountUSD: estimate.fromAmountUSD,
            toAmountUSD: estimate.toAmountUSD,
            approvalAddress: (estimate.approvalAddress ?? transactionRequest.to) as Address,
            transactionData,
            transactionTo: transactionRequest.to as Address,
            transactionValue: (transactionRequest.value as Hex) ?? ("0x0" as Hex),
            estimatedDuration: estimate.executionDuration,
            tool: step.tool,
            // Canonicalise LiFi's zero-address spelling of native to NATIVE_ASSET_ADDRESS
            // here, at the boundary, so no SwapQuoteResult carries it downstream (see
            // utils/TokenIdentity.ts). ERC20 addresses pass through untouched.
            fromTokenAddress: canonicalTokenAddress(step.action.fromToken.address),
            toTokenAddress: canonicalTokenAddress(step.action.toToken.address),
            fromChainId: step.action.fromChainId,
            toChainId: step.action.toChainId,
        };

        this.logger?.debug("LiFi swap-and-deposit quote received", {
            fromAmount: result.fromAmount,
            toAmount: result.toAmount,
            toAmountMin: result.toAmountMin,
            destinationCallAmount: result.destinationCallAmount,
        });

        return result;
    }

    /**
     * Re-quotes an Across route whose destination swap fixes its own amount, for the input less
     * the fill headroom, and combines the two quotes (utils/LiFiAcrossHeadroom.ts): the full
     * input leaves the source chain, the destination side is LiFi's own build for the smaller
     * delivery, and the filler keeps the difference.
     *
     * @throws {SwapQuoteFailed} If the re-quote cannot be combined with the first quote (a
     *   different bridge, router or bridged token), so nothing is signed on a route that would
     *   leave the filler no headroom.
     */
    private async spliceAcrossFillHeadroom(
        step: LiFiStep,
        depositCalldata: Hex,
        quoteRequest: ContractCallsQuoteRequest,
    ): Promise<{
        transactionData: Hex;
        destinationCallAmount: bigint;
        estimate: LiFiStep["estimate"];
    }> {
        const fromAmount = BigInt(step.estimate.fromAmount);
        const inputHeadroom = acrossFillHeadroomInputFor(step.includedSteps, fromAmount);
        if (inputHeadroom === undefined || inputHeadroom <= 0n || inputHeadroom >= fromAmount) {
            throw new SwapQuoteFailed(
                "Across route: no fill headroom could be sized for its input.",
            );
        }
        const { contractCalls, ...rest } = quoteRequest;
        const {
            toAmount: _toAmount,
            fromAmount: _fromAmount,
            ...base
        } = rest as typeof rest & {
            toAmount?: string;
            fromAmount?: string;
        };
        const reduced = await getContractCallsQuote(this.client, {
            ...base,
            contractCalls,
            fromAmount: (fromAmount - inputHeadroom).toString(),
        });
        const spliced =
            reduced.transactionRequest?.data &&
            reduced.transactionRequest.to?.toLowerCase() ===
                step.transactionRequest?.to?.toLowerCase()
                ? spliceAcrossFillHeadroom(
                      step.transactionRequest?.data as Hex,
                      reduced.transactionRequest.data as Hex,
                      depositCalldata,
                  )
                : undefined;
        if (!spliced) {
            this.logger?.warn("Across re-quote for fill headroom could not be combined", {
                tool: reduced.tool,
                inputHeadroom: inputHeadroom.toString(),
            });
            throw new SwapQuoteFailed(
                `Across route: the re-quote for fill headroom (${reduced.tool}) cannot be combined with the first quote; request a new quote.`,
            );
        }
        return { ...spliced, estimate: reduced.estimate };
    }

    private extractSwapResult(step: LiFiStep): SwapQuoteResult {
        const { estimate, transactionRequest } = step;

        if (!transactionRequest?.data || !transactionRequest?.to) {
            throw new SwapQuoteFailed(
                "LiFi quote did not return transaction data. Multi-step routes are not supported for withdraw-and-swap.",
            );
        }

        const result: SwapQuoteResult = {
            fromAmount: estimate.fromAmount,
            toAmount: estimate.toAmount,
            toAmountMin: estimate.toAmountMin,
            fromAmountUSD: estimate.fromAmountUSD,
            toAmountUSD: estimate.toAmountUSD,
            approvalAddress: (estimate.approvalAddress ?? transactionRequest.to) as Address,
            transactionData: transactionRequest.data as Hex,
            transactionTo: transactionRequest.to as Address,
            estimatedDuration: estimate.executionDuration,
            tool: step.tool,
            // Canonicalise LiFi's zero-address spelling of native to NATIVE_ASSET_ADDRESS
            // here, at the boundary, so no SwapQuoteResult carries it downstream (see
            // utils/TokenIdentity.ts). ERC20 addresses pass through untouched.
            fromTokenAddress: canonicalTokenAddress(step.action.fromToken.address),
            toTokenAddress: canonicalTokenAddress(step.action.toToken.address),
            fromChainId: step.action.fromChainId,
            toChainId: step.action.toChainId,
            // Symbol + decimals, so a caller can tell a same-asset bridge from a
            // genuine swap. Addresses cannot: the same asset has different
            // addresses on different chains, which is exactly the case that
            // matters (USDC on Optimism vs USDC on Ethereum).
            fromTokenSymbol: step.action.fromToken.symbol,
            toTokenSymbol: step.action.toToken.symbol,
            fromTokenDecimals: step.action.fromToken.decimals,
            toTokenDecimals: step.action.toToken.decimals,
        };

        this.logger?.debug("LiFi swap quote received", {
            fromAmount: result.fromAmount,
            toAmount: result.toAmount,
            toAmountMin: result.toAmountMin,
        });

        return result;
    }

    private mapStatusResponse(data: Record<string, unknown>): SwapStatusResult {
        const rawStatus = data.status as string;
        // LiFi's INVALID (unrecognized/expired transfer) is passed through as its own
        // status rather than folded into NOT_FOUND — see SwapStatus's doc comment for why
        // conflating the two is wrong (finding #10, Problem C).
        if (!this.isSwapStatus(rawStatus)) {
            throw new SwapStatusFailed(`LiFi status API returned an unknown status: ${rawStatus}`);
        }
        const status: SwapStatus = rawStatus;

        const result: SwapStatusResult = {
            status,
            substatus: data.substatus as SwapSubstatus | undefined,
            substatusMessage: data.substatusMessage as string | undefined,
        };

        if (data.sending && typeof data.sending === "object") {
            result.sending = this.mapTransactionInfo(data.sending as Record<string, unknown>);
        }

        if (data.receiving && typeof data.receiving === "object") {
            result.receiving = this.mapTransactionInfo(data.receiving as Record<string, unknown>);
        }

        if (typeof data.bridgeExplorerLink === "string") {
            result.explorerLink = data.bridgeExplorerLink;
        }

        return result;
    }

    private isSwapStatus(value: string): value is SwapStatus {
        return (
            value === "NOT_FOUND" ||
            value === "PENDING" ||
            value === "DONE" ||
            value === "FAILED" ||
            value === "INVALID"
        );
    }

    private mapTransactionInfo(data: Record<string, unknown>): SwapTransactionInfo {
        return {
            txHash: data.txHash as Hex | undefined,
            chainId: data.chainId as number,
            txLink: data.txLink as string | undefined,
            amount: data.amount as string | undefined,
            amountUSD: data.amountUSD as string | undefined,
        };
    }
}
