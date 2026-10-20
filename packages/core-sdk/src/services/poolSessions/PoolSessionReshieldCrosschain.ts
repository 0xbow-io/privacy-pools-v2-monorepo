import type {
    Address,
    EstimateReshieldCrosschainParams,
    EVMProof,
    Hex,
    IAddressEqualityComparator,
    IEntrypointInteractor,
    ILogger,
    IPoolSessionReshieldCrosschain,
    IRelayerInteractor,
    ISwapAndDepositQuoteProvider,
    ISwapChainAdapter,
    ISwapQuoteProvider,
    ITransactOrchestrator,
    ITxReceiptWaiter,
    PendingNote,
    PoolSessionReshieldCrosschainConfig,
    PoolSessionReshieldCrosschainDependencies,
    PreparedReshieldCrosschainQuote,
    PrepareReshieldCrosschainQuoteParams,
    RelayerCaps,
    RelayerChainDetails,
    RelayerInfo,
    ReshieldCrosschainEstimate,
    ReshieldCrosschainParams,
    SwapAndDepositQuoteResult,
    SwapQuoteResult,
    SwapRelayerQuote,
    RelaySwapDustRescue,
    SwapRouting,
    TxLog,
    TxReceipt,
    YieldSwapDepositTarget,
    YieldSwapWrapper,
} from "../../internal.js";
import {
    assertDepositCalldataEmbedded,
    assertNoSwapExecutor,
    CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
    CROSS_CHAIN_DESTINATION_GAS_LIMIT,
    assertFeeCommitmentLive,
    assertLifiBudget,
    AssetNotSupported,
    bigintToHex,
    capBridgeOutputToInput,
    DepositBelowMinimum,
    DestinationCallsUnsupported,
    DestinationChainNotSupported,
    DestinationDepositTargetMismatch,
    DestinationDepositUnaffordable,
    DustRescueRecipientConflict,
    InvalidPoolSessionConfig,
    InvalidTransactParams,
    LiFiDepositTargetNotFound,
    NativeDestinationDepositUnsupported,
    notifyBroadcast,
    RelayFeeExceedsMax,
    relayerCapsFromDetails,
    SwapQuoteMismatch,
    SwapValueExceedsRelayerCap,
    UnallowedLiFiAddress,
    UnexpectedTransactionTarget,
} from "../../internal.js";
import {
    assertZapApproved,
    previewRedeemNet,
    yieldSwapDepositTargetFor,
    yieldWrapperFor,
} from "../../utils/index.js";

// -========- B2: self-funded LayerZero fee for a Mainnet-destination reshield (EVM-only) -========-
// A reshield whose destination is Ethereum Mainnet gets a Stargate V2 / LayerZero route
// from the aggregator that needs a native `msg.value` fee. RelaySwaps mints that fee in-contract
// (step 9.5) from a slice of the withdrawal; this session sizes the slice. This entire mechanism
// (LayerZero fee funding via an in-contract gas swap) is specific to the EVM RelaySwaps contract
// and its Ethereum-Mainnet deployment — it stays inline here (not behind swapChainAdapter) since
// it's business logic about THIS protocol's fee-funding design, not a chain-encoding concern; it
// is simply inert (the `b2` branch never triggers) for any chain whose swapQuoteProvider never
// quotes a nonzero `transactionValue` — i.e. every route where the size-B2 gate below doesn't fire.
const ETHEREUM_MAINNET_CHAIN_ID = 1;
/**
 * How long a relayer's published caps are reused before `/v1/details` is read again. Spans an
 * estimate -> prepare round trip without a second fetch, yet picks up an operator raising
 * `max_swap_value_wei` within minutes instead of falsely refusing until the session is rebuilt.
 */
const RELAYER_CAPS_TTL_MS = 5 * 60_000;
/**
 * 1.2x headroom on the aggregator's quoted `transactionValue`, absorbing LZ-fee drift between
 * quote and relay (minutes). Stargate refunds whatever `msg.value` exceeds the real fee in-frame,
 * and the relay contract's dust sweep sends that refund (plus the gas swap's own overshoot) to
 * `dustRecipient` — the relayer, not the user — so every point of headroom above the drift is
 * principal the user silently loses. 2x cost ~52% of the slice (minr #14); 1.2x keeps a
 * fee-spike margin no observed quote-to-relay window has needed.
 */
const B2_SWAP_VALUE_HEADROOM_BPS = 12_000n;
/**
 * How many times a B2 gas swap is sized before giving up when LiFi's re-quote of the main leg
 * on the reduced budget drifts from the quote the gas swap was sized from (a higher native
 * fee, or a different router). Each retry re-sizes from the newest quote; a sizing is only
 * ever used once its own re-quote satisfies every invariant, so retrying never relaxes one.
 */
const B2_RESIZE_ATTEMPTS = 3;
/** 5% headroom on the gas swap's OUTPUT target so it reliably yields >= swapValue after its own slippage. */
const B2_GAS_SWAP_OUT_HEADROOM_BPS = 10_500n;
/** 1% slack on the bounded on-chain approval (`gasSwapMaxInput`) for the gas swap. */
const B2_GAS_SWAP_MAX_INPUT_SLACK_BPS = 10_100n;
/**
 * Extra principal haircut applied in `estimateReshieldCrosschainAmount` for a Mainnet
 * destination. The exact gas-swap slice can only be sized in
 * `prepareReshieldCrosschainQuote` (it needs a contractCalls quote for `transactionValue`
 * and the real deposit calldata), so `estimate` reserves a conservative flat 3% instead;
 * `prepare` is authoritative and re-checks the budget against the real slice.
 */
const B2_ESTIMATE_MAINNET_RESERVE_BPS = 300n;
/**
 * Margin kept under the contractCalls route's guaranteed delivery when sizing the destination
 * deposit. LiFi re-quotes the route between `estimate` and `prepare`, and the guarantee drifts
 * by a few tenths of a percent between two quotes (measured 2026-09-24); the margin keeps the
 * prepared cost under the fresh guarantee so `DestinationDepositUnaffordable` refits stay rare.
 */
const DESTINATION_GUARANTEE_MARGIN_BPS = 100n;
/**
 * Placeholder destination calldata for the estimate's contractCalls probe. LiFi does not
 * simulate the destination call at quote time (verified 2026-09-23 with arbitrary bytes), it
 * only needs SOME calldata to build the route; the real proof-bound calldata only exists once
 * `noteValue` is known, which is what the probe is sizing.
 */
const ESTIMATE_PROBE_CALLDATA = ("0xd3f0f1de" + "00".repeat(64)) as Hex;
/**
 * Native input: headroom on the bridge's native fee when shrinking fromAmount to fund it
 * (1.02x the quoted fee), so fee drift between the first quote and the re-quote still fits.
 * RelaySwaps forwards the whole netSwapAmount as msg.value; LiFi refunds what the route does
 * not use to the processor, and the delta-only sweep (step 13) sends it to `dustRecipient`
 * (the relayer unless the caller passes one). Kept small for that reason, and bounded by
 * assertLifiBudget's dust cap.
 */
const NATIVE_FEE_HEADROOM_BPS = 10_200n;
/** Native input: extra margin off the whole budget on the re-quote, on top of the fee headroom. */
const NATIVE_FEE_BUDGET_MARGIN_BPS = 2n;

/**
 * Native input: the fromAmount to re-quote with so that fromAmount + the route's native fee
 * fits `netSwapAmount` (the exact msg.value RelaySwaps' native branch forwards).
 * `quotedValue - quotedFrom` is the fee stacked on top. Returns `undefined` when nothing
 * would be left to bridge.
 */
function nativeFeeFundedFromAmount(
    quotedValue: bigint,
    quotedFrom: bigint,
    netSwapAmount: bigint,
): bigint | undefined {
    const nativeFee = quotedValue > quotedFrom ? quotedValue - quotedFrom : quotedValue - netSwapAmount;
    if (nativeFee <= 0n) return undefined;
    const reserved =
        (nativeFee * NATIVE_FEE_HEADROOM_BPS) / 10_000n +
        (netSwapAmount * NATIVE_FEE_BUDGET_MARGIN_BPS) / 10_000n;
    const reduced = netSwapAmount - reserved;
    return reduced > 0n ? reduced : undefined;
}

function unfundableNativeValue(required: bigint, netSwapAmount: bigint, tool?: string): InvalidTransactParams {
    return new InvalidTransactParams(
        `This route needs ${required.toString()} wei of native msg.value` +
            `${tool ? ` (via ${tool})` : ""}, which the relayer's swap contract ` +
            `can only forward up to ${netSwapAmount.toString()} wei of. ` +
            `Nothing was signed or spent. Try a different destination or asset.`,
    );
}

interface B2GasSwap<TAddress> {
    swapValue: bigint;
    gasSwapMaxInput: bigint;
    gasSwapCalldata: Hex;
    /** Input-token units the gas swap consumes — carved out of the main-swap budget. */
    gasSwapInput: bigint;
    swapTarget: TAddress;
    approvalAddress: TAddress;
}

/** What the estimate's contractCalls probe returns: the guarantee, plus what B2 sizing needs. */
/**
 * Why a re-quoted B2 main leg cannot run with a gas swap sized from `sizedFrom`, or undefined
 * when it can: RelaySwaps runs the gas swap and the main leg against one `swapTarget` /
 * `approvalAddress`, and forwards exactly `swapValue` as the main leg's msg.value.
 */
function b2QuoteDrift<TAddress>(
    comparator: { equals(a: TAddress, b: TAddress): boolean },
    requoted: { transactionTo: TAddress; approvalAddress: TAddress; transactionValue?: Hex },
    sizedFrom: { transactionTo: TAddress; approvalAddress: TAddress },
    swapValue: bigint,
): string | undefined {
    if (!comparator.equals(requoted.transactionTo, sizedFrom.transactionTo)) {
        return `router ${String(requoted.transactionTo)} != ${String(sizedFrom.transactionTo)}`;
    }
    if (!comparator.equals(requoted.approvalAddress, sizedFrom.approvalAddress)) {
        return `approval ${String(requoted.approvalAddress)} != ${String(sizedFrom.approvalAddress)}`;
    }
    const value = BigInt(requoted.transactionValue ?? "0x0");
    if (value > swapValue) return `native fee ${value} > sized swapValue ${swapValue}`;
    return undefined;
}

interface DestinationGuaranteeProbe<TAddress> {
    /** The route's guaranteed delivery to the destination call, when readable. */
    budget: bigint | undefined;
    /** Native fee the route wants as msg.value (non-zero means B2 applies to an ERC-20 input). */
    transactionValue: Hex;
    /** Source amount the route bridges (native input: transactionValue minus the bridge fee). */
    fromAmount: string;
    transactionTo: TAddress;
    approvalAddress: TAddress;
}

/**
 * Orchestrates the cross-chain reshield (withdraw source chain + swap + deposit destination
 * chain) flow via a relayer, mirroring {@link "./PoolSessionReshield.js".PoolSessionReshield}
 * with a real `destinationChainId`. Generic over the chain's prepared-transaction type `TTx`,
 * address type `TAddress`, on-chain proof type `TProof`, and raw receipt-log type `TLog`.
 *
 * Output-sufficiency on the destination leg is enforced the same way as
 * same-chain reshield — `Entrypoint.deposit()` reverting on the destination
 * chain if the swap output is insufficient — but there is no protocol-owned
 * destination verifier yet (`docs/tech-design/future-ideas/cross-chain-destination-verifier.md`),
 * so a failed destination call falls back to the aggregator delivering raw bridged
 * tokens to `fallbackAddress` rather than a shielded note. See
 * `docs/tech-design/sdk/withdraw-and-swap.md` §Cross-Chain Reshield.
 *
 * Optionally carries a stealth dust-rescue opt-in (`dustRescue`): unlike
 * every other field this session validates, the rescue deposit's amount is
 * never client-known in advance (if it were, the caller would simply size
 * the withdrawal to avoid leaving any) — the relayer alone observes the
 * actual destination-chain leftover and, at its own discretion, generates
 * and submits the rescue deposit later. This session only forwards the
 * caller's opt-in; it does not and cannot validate the outcome.
 *
 * Every operation that varies by chain (decoding the relayer-signed routing blob, checking a
 * router allowlist) is delegated to the injected `swapChainAdapter` ({@link ISwapChainAdapter}).
 */
export class PoolSessionReshieldCrosschain<
    TTx extends { to: TAddress; data: Hex },
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionReshieldCrosschain<TTx, TAddress, TLog>
{
    private readonly chainId: number;
    private readonly destinationChainId: number;
    private readonly destinationChainType: string;
    private readonly core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    private readonly relayerInteractor: IRelayerInteractor<TAddress>;
    private readonly rpcInteractor: ITxReceiptWaiter<TLog>;
    private readonly entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    private readonly destinationEntrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly emptyAddress: TAddress;
    private readonly nativeAssetAddress: TAddress;
    private readonly swapQuoteProvider?: ISwapQuoteProvider<TAddress>;
    private readonly swapAndDepositQuoteProvider?: ISwapAndDepositQuoteProvider<TAddress>;
    private readonly swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
    private readonly destinationYieldDepositTargets: YieldSwapDepositTarget<TTx, TAddress>[];
    private readonly yieldWrappers: YieldSwapWrapper<TAddress>[];
    /** Per-relayer caps keyed by {@link relayerCapsKey}; seeded from `relayerChainDetails`. */
    private readonly relayerCapsCache = new Map<string, { caps: RelayerCaps; fetchedAt: number }>();
    /** The destination chain's `destinationCallsSupported` from a seeded `relayerChainDetails` entry. */
    private readonly seededDestinationCallsSupported?: boolean;
    /** The destination chain's `destinationCallsSupported` per relayer URL, from `/v1/details`. */
    private readonly destinationCallsCache = new Map<string, { supported?: boolean; fetchedAt: number }>();
    private readonly logger?: ILogger;

    constructor(
        config: PoolSessionReshieldCrosschainConfig<TTx, TAddress, TProof, TLog>,
        deps?: PoolSessionReshieldCrosschainDependencies,
    ) {
        this.chainId = config.chainId;
        this.destinationChainId = config.destinationChainId;
        this.destinationChainType = config.destinationChainType;
        this.core = config.core;
        this.relayerInteractor = config.relayerInteractor;
        this.rpcInteractor = config.rpcInteractor;
        this.entrypointInteractor = config.entrypointInteractor;
        this.destinationEntrypointInteractor = config.destinationEntrypointInteractor;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.emptyAddress = config.emptyAddress;
        this.nativeAssetAddress = config.nativeAssetAddress;
        this.swapQuoteProvider = config.swapQuoteProvider;
        this.swapAndDepositQuoteProvider = config.swapAndDepositQuoteProvider;
        this.swapChainAdapter = config.swapChainAdapter;
        this.yieldWrappers = config.yieldWrappers ?? [];
        this.destinationYieldDepositTargets = config.destinationYieldDepositTargets ?? [];
        for (const target of this.destinationYieldDepositTargets) {
            if (target.chainId !== config.destinationChainId) {
                throw new InvalidPoolSessionConfig(
                    `destination yield deposit target ${String(target.shareToken)} is bound to chain ${target.chainId}; the destination is chain ${config.destinationChainId}`,
                );
            }
        }
        for (const details of config.relayerChainDetails ?? []) {
            this.cacheRelayerCaps(details);
        }
        this.seededDestinationCallsSupported = config.relayerChainDetails?.find(
            (details) => details.id === config.destinationChainId && details.type === config.destinationChainType,
        )?.destinationCallsSupported;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionReshieldCrosschain.estimateReshieldCrosschainAmount
     * @throws {InvalidTransactParams} When swapQuoteProvider is not configured, `toChainId` does not match the configured destination, or the fee exceeds the amount.
     * @throws {DestinationCallsUnsupported} When the destination chain's relayer reports `destinationCallsSupported: false`.
     * @throws {AssetNotSupported} When the output token is not enabled on the destination Entrypoint.
     * @throws {RelayFeeExceedsMax} When the relayer fee exceeds the Entrypoint maxRelayFee.
     * @throws {DepositBelowMinimum} When the computed note value is below the destination Entrypoint minimum.
     * @throws {SwapQuoteMismatch} When the aggregator quote routes different tokens/chains than requested.
     */
    async estimateReshieldCrosschainAmount(
        params: EstimateReshieldCrosschainParams<TAddress>,
    ): Promise<ReshieldCrosschainEstimate<TAddress>> {
        if (!this.swapQuoteProvider) {
            throw new InvalidTransactParams(
                "swapQuoteProvider must be configured to use estimateReshieldCrosschainAmount()",
            );
        }
        this.assertDestinationChainMatches(params.toChainId, params.toChainType);
        await this.assertDestinationAcceptsCalls(params.relayerInfo);

        const {
            relayerInfo,
            amount,
            tokenId,
            outputToken,
            fallbackAddress,
            dustRecipient,
            slippage,
            denyExchanges,
        } = params;
        const yieldTarget = this.yieldTargetFor(outputToken);
        // A share output is funded with the share's underlying (or native coin) on the
        // destination: the DEX leg buys that. The relayer routing names the NATIVE sentinel,
        // because RelaySwaps reads outputToken.balanceOf on the SOURCE chain even with a zero
        // recipient, and a destination-only token would revert there.
        const swapOutputToken = yieldTarget ? yieldTarget.fundingToken : outputToken;
        const routingOutputToken = yieldTarget ? this.nativeAssetAddress : outputToken;

        const effectiveDustRecipient = dustRecipient ?? relayerInfo.address;
        // No end-user wallet exists on the destination chain for this flow — defaults
        // to the relayer's own address (transient design: the relayer receives anything not
        // redeposited and is expected to later turn it into a deposit on the user's behalf).
        // An explicit empty-address fallbackAddress would tell the aggregator to send bridged
        // tokens to the burn address if the destination deposit cannot execute — permanent loss.
        // Reject it; omitting the field falls back to the relayer address instead.
        // (Same guard as PoolSessionSwapDeposit.)
        if (
            fallbackAddress !== undefined &&
            this.addressEqualityComparator.equals(fallbackAddress, this.emptyAddress)
        ) {
            throw new InvalidTransactParams(
                "fallbackAddress must not be the empty-address sentinel (bridged funds would be unrecoverable on a failed destination deposit); omit it to default to the relayer address",
            );
        }
        const effectiveFallbackAddress = fallbackAddress ?? relayerInfo.address;

        // Pre-flight: output token must be depositable on the DESTINATION Entrypoint;
        // input config (fee bound) is read from the SOURCE Entrypoint.
        const [outputConfig, inputConfig] = await Promise.all([
            this.destinationEntrypointInteractor.getAssetConfig(outputToken),
            this.entrypointInteractor.getAssetConfig(tokenId),
        ]);
        if (!outputConfig.enabled) {
            throw new AssetNotSupported(String(outputToken));
        }

        // 1. Preliminary relayer quote (no commitment) → fee amount
        const prelimQuote = await this.relayerInteractor.getSwapQuote(relayerInfo, {
            asset: tokenId,
            amount: BigInt(amount).toString(),
            outputToken: routingOutputToken,
            recipient: this.emptyAddress, // no source-chain recipient — output re-deposits via contractCalls
            fallbackAddress: effectiveFallbackAddress,
            minOutputAmount: "0",
            dustRecipient: effectiveDustRecipient,
            commit: false,
        });

        this.assertFeeWithinBounds(prelimQuote.feeAmount, amount, inputConfig.maxRelayFee);
        const feeAmount = BigInt(prelimQuote.feeAmount);
        // Shares when the note is a yield share; plain token units otherwise. The relayer
        // fee is priced (and stays committed) in this unit.
        const netShares = BigInt(amount) - feeAmount;

        // 1b. Yield share input: RelaySwaps redeems the shares into the wrapper's underlying
        //     before the swap (`executeUnwrapped`), so the DEX leg is quoted on the UNDERLYING
        //     for what those net shares redeem to. `previewRedeem` is the same read the zap
        //     performs on-chain; the share rate only rises between quote and execution, so any
        //     surplus lands in the delta dust sweep, never a shortfall.
        const wrapper = yieldWrapperFor(this.yieldWrappers, tokenId, (a, b) =>
            this.swapChainAdapter.isSameToken(a, b),
        );
        const swapInputToken = wrapper ? wrapper.underlying : tokenId;
        if (wrapper) {
            await assertZapApproved(
                this.swapChainAdapter,
                relayerInfo.processorAddress,
                tokenId,
                wrapper,
            );
        }
        const netSwapAmount = wrapper ? await previewRedeemNet(wrapper, netShares) : netShares;

        // 2. DEX swap quote for estimated output on the destination chain
        const swapEstimate = await this.swapQuoteProvider.getSwapQuote({
            fromChainId: relayerInfo.chainId,
            toChainId: this.destinationChainId,
            fromToken: swapInputToken,
            toToken: swapOutputToken,
            fromAddress: relayerInfo.processorAddress,
            amount: netSwapAmount.toString(),
            amountType: "from",
            slippage,
            denyExchanges,
        });

        this.assertSwapQuoteMatchesRequest(swapEstimate, {
            fromToken: swapInputToken,
            toToken: swapOutputToken,
            fromChainId: relayerInfo.chainId,
            toChainId: this.destinationChainId,
        });

        // 3. Work backwards from estimated min output to get note value, same
        //    safety buffer as same-chain reshield's estimator.
        const estimatedMinOutput = BigInt(swapEstimate.toAmountMin);
        // Cap at netSwapAmount for a SAME-ASSET bridge only: bridge execution always
        // returns ≤ input after fees, and temporarily-favorable LP rates (e.g. Across
        // incentives) can make toAmountMin exceed netSwapAmount; sizing a deposit beyond
        // it causes the aggregator's contractCall to fail when normal rates apply at execution.
        const cappedMinOutput = capBridgeOutputToInput(estimatedMinOutput, netSwapAmount, swapEstimate);
        // B2: a Mainnet-destination reshield pays the LayerZero fee out of the reshielded
        // principal via an in-contract gas swap (RelaySwaps step 9.5). The exact slice is
        // only knowable in prepareReshieldCrosschainQuote (needs a contractCalls quote for
        // `transactionValue` and the real deposit calldata); here, reserve a conservative
        // flat 3% so the estimated noteValue leaves room for it. prepare is authoritative.
        const b2Reserved =
            this.destinationChainId === ETHEREUM_MAINNET_CHAIN_ID
                ? (cappedMinOutput * (10_000n - B2_ESTIMATE_MAINNET_RESERVE_BPS)) / 10_000n
                : cappedMinOutput;
        // 98% instead of 99%: cross-asset contractCallsQuotes use a different route than the
        // preliminary simple getSwapQuote, producing a ~1% rate divergence. With 99% the
        // algebraic identity fromAmount_agg ≈ netSwapAmount holds exactly, leaving no margin
        // for the fee drift between estimate and commit. The extra ~1% becomes additional
        // Dust #2 at the fallback address and is swept by the existing dust rescue flow.
        let safeMinOutput = (b2Reserved * 98n) / 100n;
        // 3b. The single-hop plain quote above is not the route LiFi builds for a
        //     contractCalls quote (bridge + destination DEX), and LiFi encodes THAT route's
        //     guaranteed delivery — never the amount we request — as the destination call's
        //     budget (`ISwapChainAdapter.getDestinationCallAmount`). A deposit costing more than the
        //     guarantee fails on arrival and the bridged tokens land at the fallback
        //     address. Probe the real route with placeholder calldata and never size above
        //     its guarantee (minus a small margin for quote-to-quote drift).
        const depositTarget = yieldTarget
            ? yieldTarget.router
            : this.destinationEntrypointInteractor.getAddress();
        const probe = await this.probeDestinationGuarantee({
            relayerInfo,
            swapInputToken,
            swapOutputToken,
            netSwapAmount,
            requestedDepositCost: safeMinOutput,
            depositTarget,
            fallbackAddress: effectiveFallbackAddress,
            slippage,
            denyExchanges,
        });
        let guaranteed = probe?.budget;
        let reportedFeeAmount = prelimQuote.feeAmount;
        // What the main leg actually swaps: after a B2 fee re-quote it is the surcharged
        // net minus the gas-swap slice, and that is what the estimate reports.
        let reportedNetSwapAmount = netSwapAmount;
        // 3c. B2, sized the way prepare sizes it. When the real route wants a native fee
        //     (transactionValue > 0) for an ERC-20 input, prepare carves a gas-swap slice out
        //     of the budget and re-quotes the main leg on what is left, so the guaranteed
        //     delivery drops by that slice. The flat 3% reserve above is only a guess, and a
        //     small reshield on a route with a large native fee needs far more (a 20 USDT
        //     BSC -> Ethereum reshield lost ~15% to it, 2026-09-27): sized from the plain
        //     guarantee, prepare refused it every time with DestinationDepositUnaffordable.
        //     Size the gas swap for real and probe the reduced budget instead.
        const isNativeInput = this.addressEqualityComparator.equals(tokenId, this.nativeAssetAddress);
        if (probe && !isNativeInput && BigInt(probe.transactionValue ?? "0x0") > 0n) {
            // LiFi re-quotes on every call, so the reduced probe can come back on a different
            // native fee (Mainnet gas moves between two quotes, and the fee scales with the
            // destination gas budget) or route than the probe the gas swap was sized from.
            // That is drift, not an attack: re-size the gas swap from the reduced quote and
            // probe again. Only a sizing whose own re-quote satisfies every invariant is used.
            let sizedAgainst: DestinationGuaranteeProbe<TAddress> = probe;
            let reduced: DestinationGuaranteeProbe<TAddress> | undefined;
            let mainLegBudget: bigint;
            for (let attempt = 1; ; attempt++) {
                const b2 = await this.sizeB2GasSwap({
                    transactionValue: sizedAgainst.transactionValue,
                    tokenId: swapInputToken,
                    relayerInfo,
                    mainSwapTarget: sizedAgainst.transactionTo,
                    mainApprovalAddress: sizedAgainst.approvalAddress,
                    slippage,
                    denyExchanges,
                });
                // The relayer surcharges the gas-swap tx onto the fee when swapValue > 0 (as in prepare).
                const b2FeeQuote = await this.relayerInteractor.getSwapQuote(relayerInfo, {
                    asset: tokenId,
                    amount: BigInt(amount).toString(),
                    outputToken: routingOutputToken,
                    recipient: this.emptyAddress,
                    fallbackAddress: effectiveFallbackAddress,
                    minOutputAmount: "0",
                    dustRecipient: effectiveDustRecipient,
                    commit: false,
                    swapValue: b2.swapValue.toString(),
                    gasSwapMaxInput: b2.gasSwapMaxInput.toString(),
                    gasSwapCalldata: b2.gasSwapCalldata,
                });
                this.assertFeeWithinBounds(b2FeeQuote.feeAmount, amount, inputConfig.maxRelayFee);
                reportedFeeAmount = b2FeeQuote.feeAmount;
                const b2NetShares = BigInt(amount) - BigInt(b2FeeQuote.feeAmount);
                const b2NetUnderlying = wrapper ? await previewRedeemNet(wrapper, b2NetShares) : b2NetShares;
                mainLegBudget = b2NetUnderlying - b2.gasSwapInput;
                if (mainLegBudget <= 0n) {
                    throw new InvalidTransactParams(
                        "The bridge's native fee would consume the whole amount. Nothing was signed or spent. Try a larger amount.",
                    );
                }
                reduced = await this.probeDestinationGuarantee({
                    relayerInfo,
                    swapInputToken,
                    swapOutputToken,
                    netSwapAmount,
                    requestedDepositCost: safeMinOutput,
                    depositTarget,
                    fallbackAddress: effectiveFallbackAddress,
                    slippage,
                    denyExchanges,
                    netFromAmountOverride: mainLegBudget,
                });
                // Same B2 invariants prepare enforces on its re-quote: the main leg stays on the
                // router the gas swap was sized against, and its native fee fits the sized swapValue.
                // Otherwise the estimate would promise a deposit prepare cannot build.
                const drift = reduced && b2QuoteDrift(this.addressEqualityComparator, reduced, sizedAgainst, b2.swapValue);
                if (!drift) break;
                if (attempt >= B2_RESIZE_ATTEMPTS) {
                    throw new InvalidTransactParams(`B2: the reduced quote differs from the sized gas swap (${drift})`);
                }
                this.logger?.info("B2: reduced quote drifted from the sized gas swap, re-sizing", { drift, attempt });
                sizedAgainst = reduced!;
            }
            // Never fall back to the full-budget guarantee: it overstates what arrives by the
            // gas-swap slice. Without a readable reduced guarantee, scale the plain-quote
            // sizing down by the same slice instead.
            guaranteed = reduced?.budget;
            if (guaranteed === undefined) {
                safeMinOutput = (safeMinOutput * mainLegBudget) / netSwapAmount;
            }
            reportedNetSwapAmount = mainLegBudget;
        }
        // 3d. Native input whose route stacks a bridge fee on top of fromAmount (StargateV2's
        //     LayerZero fee): prepare re-quotes with fromAmount reduced so fromAmount + fee
        //     fits netSwapAmount. Size the estimate off that same reduced route, or it would
        //     promise a deposit the smaller bridged amount cannot cover.
        if (probe && isNativeInput && BigInt(probe.transactionValue ?? "0x0") > netSwapAmount) {
            const reducedFrom = nativeFeeFundedFromAmount(
                BigInt(probe.transactionValue),
                BigInt(probe.fromAmount),
                netSwapAmount,
            );
            if (reducedFrom === undefined) {
                throw new InvalidTransactParams(
                    "The bridge's native fee would consume the whole amount. Nothing was signed or spent. Try a larger amount.",
                );
            }
            const reduced = await this.probeDestinationGuarantee({
                relayerInfo,
                swapInputToken,
                swapOutputToken,
                netSwapAmount,
                requestedDepositCost: safeMinOutput,
                depositTarget,
                fallbackAddress: effectiveFallbackAddress,
                slippage,
                denyExchanges,
                netFromAmountOverride: reducedFrom,
            });
            // Same re-check prepare does: a reduced route that still wants more than the
            // forwarded msg.value cannot be built, so do not estimate a note for it.
            const reducedValue = BigInt(reduced?.transactionValue ?? "0x0");
            if (reducedValue > netSwapAmount) {
                throw unfundableNativeValue(reducedValue, netSwapAmount);
            }
            // And the same dust cap prepare applies: if the re-quoted fee shrank, the
            // unused headroom could exceed it and prepare would refuse.
            if (reduced) {
                const reducedFromAmount = BigInt(reduced.fromAmount);
                assertLifiBudget(
                    (reducedValue > reducedFromAmount ? reducedValue : reducedFromAmount).toString(),
                    bigintToHex(netSwapAmount),
                    "0",
                );
            }
            guaranteed = reduced?.budget;
            if (guaranteed === undefined) {
                safeMinOutput = (safeMinOutput * reducedFrom) / netSwapAmount;
            }
            reportedNetSwapAmount = reducedFrom;
        }
        if (guaranteed !== undefined) {
            const guaranteedSafe =
                (guaranteed * (10_000n - DESTINATION_GUARANTEE_MARGIN_BPS)) / 10_000n;
            if (guaranteedSafe < safeMinOutput) {
                this.logger?.info(
                    "Destination deposit sized down to the contractCalls route guarantee",
                    {
                        plainQuoteSizing: safeMinOutput.toString(),
                        routeGuarantee: guaranteed.toString(),
                        sizedTo: guaranteedSafe.toString(),
                    },
                );
                safeMinOutput = guaranteedSafe;
            }
        }
        const bps = BigInt(outputConfig.vettingFeeBPS);
        const noteValue = yieldTarget
            ? (
                  await yieldTarget.sizeSharesForBudget(
                      safeMinOutput,
                      CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
                  )
              ).shares
            : (safeMinOutput * 10000n) / (10000n + bps);
        // A share target pays its vetting fee in shares inside the sizing, so no
        // funding-token figure exists to report; the plain path reports the Entrypoint fee.
        const vettingFee = yieldTarget ? 0n : (noteValue * bps) / 10000n;
        const totalDepositCost = yieldTarget ? safeMinOutput : noteValue + vettingFee;

        if (noteValue < BigInt(outputConfig.minAmount)) {
            throw new DepositBelowMinimum(
                noteValue.toString(),
                BigInt(outputConfig.minAmount).toString(),
            );
        }

        return {
            feeAmount: reportedFeeAmount,
            netSwapAmount: reportedNetSwapAmount.toString(),
            estimatedOutput: swapEstimate.toAmount,
            estimatedMinOutput: swapEstimate.toAmountMin,
            noteValue: `0x${noteValue.toString(16)}` as Hex,
            vettingFee: vettingFee.toString(),
            totalDepositCost: totalDepositCost.toString(),
            swapInputToken,
        };
    }

    /**
     * Quotes the contractCalls route LiFi would build for this reshield (placeholder
     * destination calldata) and returns the destination call budget LiFi encodes for it —
     * the route's guaranteed delivery in output-token units — or `undefined` when no
     * `swapAndDepositQuoteProvider` is configured or the quote carries no readable budget.
     * Mirrors `prepareReshieldCrosschainQuote`'s request shape (fromAmount mode for a
     * cross-asset swap, toAmount mode otherwise) so the probed route matches the real one.
     */
    private async probeDestinationGuarantee(params: {
        relayerInfo: RelayerInfo<TAddress>;
        swapInputToken: TAddress;
        swapOutputToken: TAddress;
        netSwapAmount: bigint;
        requestedDepositCost: bigint;
        depositTarget: TAddress;
        fallbackAddress: TAddress;
        slippage?: number;
        denyExchanges?: string[];
        /** Source budget after a B2 gas-swap slice; forces netFromAmount mode, as prepare does. */
        netFromAmountOverride?: bigint;
    }): Promise<DestinationGuaranteeProbe<TAddress> | undefined> {
        if (!this.swapAndDepositQuoteProvider) return undefined;
        const isCrossAsset = !this.swapChainAdapter.isSameToken(params.swapInputToken, params.swapOutputToken);
        const quote = await this.swapAndDepositQuoteProvider.getSwapAndDepositQuote({
            fromChainId: params.relayerInfo.chainId,
            toChainId: this.destinationChainId,
            fromToken: params.swapInputToken,
            toToken: params.swapOutputToken,
            fromAddress: params.relayerInfo.processorAddress,
            depositAmount: params.requestedDepositCost.toString(),
            depositCalldata: ESTIMATE_PROBE_CALLDATA,
            poolAddress: params.depositTarget,
            slippage: params.slippage,
            fallbackAddress: params.fallbackAddress,
            denyExchanges: params.denyExchanges,
            // Same budget as prepare, so the probed route matches the real one.
            depositGasLimit: CROSS_CHAIN_DESTINATION_GAS_LIMIT,
            ...(isCrossAsset || params.netFromAmountOverride !== undefined
                ? { netFromAmount: (params.netFromAmountOverride ?? params.netSwapAmount).toString() }
                : {}),
        });
        const budget =
            this.swapChainAdapter.getDestinationCallAmount(quote.transactionData, ESTIMATE_PROBE_CALLDATA) ??
            (quote.destinationCallAmount !== undefined
                ? BigInt(quote.destinationCallAmount)
                : undefined);
        return {
            budget,
            transactionValue: quote.transactionValue,
            fromAmount: quote.fromAmount,
            transactionTo: quote.transactionTo,
            approvalAddress: quote.approvalAddress,
        };
    }

    /**
     * @inheritdoc IPoolSessionReshieldCrosschain.prepareReshieldCrosschainQuote
     * @throws {InvalidTransactParams} When swapAndDepositQuoteProvider is not configured, `toChainId` does not match the configured destination, params are inconsistent, or the signed routing diverges.
     * @throws {DestinationDepositTargetMismatch} When depositResult.depositTx.to is not the destination-chain Entrypoint.
     * @throws {DestinationDepositUnaffordable} When the deposit cost exceeds the bridge's guaranteed delivery (rebuild the deposit with the carried `affordableNoteValue` and re-prepare).
     * @throws {AssetNotSupported} When the output token is not enabled on the destination Entrypoint.
     * @throws {DepositBelowMinimum} When the deposit note value is below the destination Entrypoint minimum.
     * @throws {RelayFeeExceedsMax} When the relayer fee exceeds the Entrypoint maxRelayFee.
     * @throws {SwapQuoteMismatch} When the aggregator quote routes different tokens/chains than requested.
     * @throws {DustRescueRecipientConflict} When an explicit dustRecipient conflicts with a dustRescue opt-in.
     * @throws {DestinationCallsUnsupported} When the destination chain's relayer reports `destinationCallsSupported: false`.
     */
    async prepareReshieldCrosschainQuote(
        params: PrepareReshieldCrosschainQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldCrosschainQuote<TAddress>> {
        if (!this.swapAndDepositQuoteProvider) {
            throw new InvalidTransactParams(
                "swapAndDepositQuoteProvider must be configured to use prepareReshieldCrosschainQuote()",
            );
        }
        this.assertDestinationChainMatches(params.toChainId, params.toChainType);
        await this.assertDestinationAcceptsCalls(params.relayerInfo);

        const {
            relayerInfo,
            amount,
            tokenId,
            outputToken,
            fallbackAddress,
            depositResult,
            totalDepositCost,
            dustRecipient,
            slippage,
            dustRescue,
            denyExchanges,
        } = params;
        const yieldTarget = this.yieldTargetFor(outputToken);
        const swapOutputToken = yieldTarget ? yieldTarget.fundingToken : outputToken;
        const routingOutputToken = yieldTarget ? this.nativeAssetAddress : outputToken;

        const effectiveDustRecipient = dustRecipient ?? relayerInfo.address;
        if (
            dustRescue &&
            !this.addressEqualityComparator.equals(effectiveDustRecipient, relayerInfo.address)
        ) {
            throw new DustRescueRecipientConflict(
                String(effectiveDustRecipient),
                String(relayerInfo.address),
            );
        }
        if (
            fallbackAddress !== undefined &&
            this.addressEqualityComparator.equals(fallbackAddress, this.emptyAddress)
        ) {
            throw new InvalidTransactParams(
                "fallbackAddress must not be the empty-address sentinel (bridged funds would be unrecoverable on a failed destination deposit); omit it to default to the relayer address",
            );
        }
        const effectiveFallbackAddress = fallbackAddress ?? relayerInfo.address;

        // Pre-flight 1: the deposit must target the DESTINATION chain's Entrypoint —
        // proof-bound via the aggregator calldata, so a wrong address is unrecoverable.
        const destinationEntrypointAddress = this.destinationEntrypointInteractor.getAddress();
        const routerTarget =
            yieldTarget &&
            this.addressEqualityComparator.equals(depositResult.depositTx.to, yieldTarget.router)
                ? yieldTarget
                : undefined;
        if (
            !this.addressEqualityComparator.equals(depositResult.depositTx.to, destinationEntrypointAddress) &&
            !routerTarget
        ) {
            throw new DestinationDepositTargetMismatch(
                String(depositResult.depositTx.to),
                String(destinationEntrypointAddress),
                this.destinationChainId,
            );
        }

        // Pre-flight 2: the deposited token must be accepted by the destination Entrypoint,
        // the note must clear the minimum, and totalDepositCost must match its on-chain vetting fee.
        const [outputConfig, inputConfig] = await Promise.all([
            this.destinationEntrypointInteractor.getAssetConfig(outputToken),
            this.entrypointInteractor.getAssetConfig(tokenId),
        ]);
        if (!outputConfig.enabled) {
            throw new AssetNotSupported(String(outputToken));
        }
        if (!this.addressEqualityComparator.equals(depositResult.pendingNote.tokenId, outputToken)) {
            throw new InvalidTransactParams(
                `depositResult.pendingNote.tokenId ${depositResult.pendingNote.tokenId} does not match outputToken ${outputToken}`,
            );
        }
        const noteValue = BigInt(depositResult.pendingNote.value);
        if (noteValue < BigInt(outputConfig.minAmount)) {
            throw new DepositBelowMinimum(
                noteValue.toString(),
                BigInt(outputConfig.minAmount).toString(),
            );
        }
        const bps = BigInt(outputConfig.vettingFeeBPS);
        if (routerTarget) {
            routerTarget.assertDepositMatches(depositResult, BigInt(totalDepositCost));
        }
        const expectedDepositCost = routerTarget
            ? BigInt(totalDepositCost)
            : noteValue + (noteValue * bps) / 10000n;
        if (BigInt(totalDepositCost) !== expectedDepositCost) {
            throw new InvalidTransactParams(
                `totalDepositCost ${totalDepositCost} does not match noteValue + on-chain vetting fee ${expectedDepositCost}; the estimate may be stale`,
            );
        }

        // Pre-flight 3: a plain native-coin deposit can never land through LiFi. The Executor
        // sends the route's guaranteed delivery as msg.value (see
        // `ISwapChainAdapter.getDestinationCallAmount`), the Entrypoint requires msg.value to equal the
        // proof's amount exactly, and the two never coincide. Refuse before any network call.
        // The native-mode yield router (`depositExactSharesNative`) is exempt: msg.value is a
        // cap there, with the surplus refunded, so the affordability check below suffices.
        if (
            this.addressEqualityComparator.equals(outputToken, this.nativeAssetAddress) &&
            !routerTarget
        ) {
            // A native-coin deposit's msg.value is exactly its total cost (note value + vetting fee).
            throw new NativeDestinationDepositUnsupported(String(outputToken), totalDepositCost);
        }

        // 1. Preliminary relayer quote (no commitment) — needed first to compute the net
        // swap budget, which drives the aggregator's fromAmount for cross-asset swaps.
        const prelimQuote = await this.relayerInteractor.getSwapQuote(relayerInfo, {
            asset: tokenId,
            amount: BigInt(amount).toString(),
            outputToken: routingOutputToken,
            recipient: this.emptyAddress,
            fallbackAddress: effectiveFallbackAddress,
            minOutputAmount: "0",
            dustRecipient: effectiveDustRecipient,
            commit: false,
        });
        this.assertFeeWithinBounds(prelimQuote.feeAmount, amount, inputConfig.maxRelayFee);

        // 1b. Yield share input: the processor redeems the shares into the wrapper's underlying
        //     before the swap, so every leg — the main contractCalls quote and the B2 gas swap —
        //     is sized in the UNDERLYING. The relayer fee and the proof-bound note stay
        //     share-denominated. `netUnderlyingFor(feeShares)` maps a fee-adjusted net (shares)
        //     to what it redeems to; the identity for a plain note.
        const wrapper = yieldWrapperFor(this.yieldWrappers, tokenId, (a, b) =>
            this.swapChainAdapter.isSameToken(a, b),
        );
        const swapInputToken = wrapper ? wrapper.underlying : tokenId;
        if (wrapper) {
            await assertZapApproved(
                this.swapChainAdapter,
                relayerInfo.processorAddress,
                tokenId,
                wrapper,
            );
        }
        const netUnderlyingFor = async (feeShares: bigint): Promise<bigint> => {
            const net = BigInt(amount) - feeShares;
            return wrapper ? previewRedeemNet(wrapper, net) : net;
        };

        // 2. Get a cross-chain contractCalls quote (bridge + swap + destination deposit).
        // For cross-asset swaps (fromToken ≠ toToken) the toAmount quote inflates the required
        // source input above the net budget (amount − fee), so switch to fromAmount mode:
        // the aggregator takes the full net, deposits depositAmount of the output, routes
        // surplus to fallbackAddress. For same-asset, toAmount is more capital-efficient.
        // `netSwapAmount` is underlying-denominated for a yield share (post-unwrap units).
        const netSwapAmount = await netUnderlyingFor(BigInt(prelimQuote.feeAmount));
        // Compare the SWAP tokens (underlying vs output), not the note's tokenId: a
        // ppUSDC → USDC reshield is a same-asset bridge once the shares are unwrapped, and
        // forcing netFromAmount mode on it would give up toAmount's capital efficiency.
        const isCrossAsset = !this.addressEqualityComparator.equals(swapInputToken, swapOutputToken);

        // The contractCalls request, parametrized on the source-token budget. Called
        // once as-is; then, for a Mainnet destination (B2), re-called with the budget
        // reduced by the gas-swap slice (`netFromAmount` mode) so the aggregator sizes the
        // main leg against what will actually be left after step 9.5.
        const requestContractCallsQuote = (
            netFromAmountOverride?: bigint,
        ): Promise<SwapAndDepositQuoteResult<TAddress>> =>
            this.swapAndDepositQuoteProvider!.getSwapAndDepositQuote({
                fromChainId: relayerInfo.chainId,
                toChainId: this.destinationChainId,
                fromToken: swapInputToken,
                toToken: swapOutputToken,
                fromAddress: relayerInfo.processorAddress,
                depositAmount: totalDepositCost,
                depositCalldata: depositResult.depositTx.data,
                poolAddress: depositResult.depositTx.to,
                slippage,
                fallbackAddress: effectiveFallbackAddress,
                denyExchanges,
                // Cross-chain reshield only: the destination call does a Groth16 verifyProof plus a
                // LeanIMT insert (and the vault supply + mint through the yield router), well above
                // the provider's shared 300000 default. One flat budget, see CrossChainDestinationGas.ts.
                // Same-chain reshield/withdraw-and-swap keep their own limit.
                depositGasLimit: CROSS_CHAIN_DESTINATION_GAS_LIMIT,
                ...(isCrossAsset || netFromAmountOverride !== undefined
                    ? { netFromAmount: (netFromAmountOverride ?? netSwapAmount).toString() }
                    : {}),
            });

        const validateQuote = async (quote: SwapAndDepositQuoteResult<TAddress>): Promise<void> => {
            this.assertSwapQuoteMatchesRequest(quote, {
                fromToken: swapInputToken,
                toToken: swapOutputToken,
                fromChainId: relayerInfo.chainId,
                toChainId: this.destinationChainId,
            });
            await this.swapChainAdapter.assertRoutingLayoutMatches(
                relayerInfo.processorAddress,
                this.chainId,
            );
            await this.assertLiFiAddressAllowed(quote.transactionTo, "transactionTo", relayerInfo.processorAddress);
            await this.assertLiFiAddressAllowed(
                quote.approvalAddress,
                "approvalAddress",
                relayerInfo.processorAddress,
            );
            this.assertDepositIsEmbeddedInQuote(
                quote.transactionData,
                depositResult.depositTx.data,
                depositResult.depositTx.to,
            );
            // The embedding check proves nothing once the swap executor (arbitrary calls, on the
            // allowlist) is the target or the spender: it could send the withdrawn funds anywhere.
            await assertNoSwapExecutor(this.swapChainAdapter, quote);
        };

        let contractCallsQuote = await requestContractCallsQuote();
        await validateQuote(contractCallsQuote);

        // NATIVE input only: refuse a route needing more msg.value than the relayer can
        // forward. RelaySwaps' native branch already forwards the swap amount itself
        // (`_r.swapTarget.call{value: _swapAmount}`, i.e. netSwapAmount here) — that part
        // must not be refused; only a fee stacked ON TOP (e.g. a LayerZero fee) is
        // unfundable, because B2's in-contract gas swap funds the fee for ERC20 input
        // only (native-input B2 is deferred — the contract rejects swapValue > 0 on the
        // native branch). An unfundable route surfaces as a reasonless
        // RelaySwaps_SwapFailed after a paid relayer round-trip; refusing here is free.
        // For ERC20 input a nonzero transactionValue is handled by the B2 sizing below.
        //
        // A native route's transactionValue is fromAmount + the bridge's native fee
        // (e.g. StargateV2's LayerZero fee), so a full-budget quote always overshoots by
        // the fee and lowering the amount never helps (netSwapAmount scales with it). Fund
        // the fee out of the budget instead: re-quote once with fromAmount reduced so that
        // fromAmount + fee fits netSwapAmount, then re-check. The deposit stays as the
        // caller built it; if the smaller bridged amount no longer covers it, the
        // destination-affordability gate below refuses with the refit note value, exactly
        // as it does after an ERC20 B2 re-quote.
        const isNativeInput = this.addressEqualityComparator.equals(tokenId, this.nativeAssetAddress);
        if (isNativeInput) {
            const firstRequired = BigInt(contractCallsQuote.transactionValue ?? "0x0");
            if (firstRequired > netSwapAmount) {
                const reducedFrom = nativeFeeFundedFromAmount(
                    firstRequired,
                    BigInt(contractCallsQuote.fromAmount),
                    netSwapAmount,
                );
                if (reducedFrom === undefined) {
                    throw unfundableNativeValue(firstRequired, netSwapAmount, contractCallsQuote.tool);
                }
                this.logger?.info("Native route fee re-quote: bridged amount reduced to fund the bridge fee", {
                    firstTransactionValue: firstRequired.toString(),
                    netSwapAmount: netSwapAmount.toString(),
                    reducedFromAmount: reducedFrom.toString(),
                });
                contractCallsQuote = await requestContractCallsQuote(reducedFrom);
                await validateQuote(contractCallsQuote);
                const requiredValue = BigInt(contractCallsQuote.transactionValue ?? "0x0");
                if (requiredValue > netSwapAmount) {
                    throw unfundableNativeValue(requiredValue, netSwapAmount, contractCallsQuote.tool);
                }
            }
        }

        // B2: a Mainnet-destination route carries a native LayerZero fee
        // (`transactionValue > 0`). Size the in-contract gas swap that funds it, then
        // re-quote the main leg against the reduced budget. ERC20 input only (above).
        let b2: B2GasSwap<TAddress> | undefined;
        let budgetFeeAmount = BigInt(prelimQuote.feeAmount);
        if (!isNativeInput && BigInt(contractCallsQuote.transactionValue) > 0n) {
            // Same drift handling as the estimate: the re-quote on the reduced budget may come
            // back on a higher native fee or another router than the quote the gas swap was
            // sized from. Re-size from the re-quote; a sizing is only kept once its own
            // re-quote passes every check below, so nothing is relaxed.
            let sizedFrom: SwapAndDepositQuoteResult<TAddress> = contractCallsQuote;
            for (let attempt = 1; ; attempt++) {
                b2 = await this.sizeB2GasSwap({
                    transactionValue: contractCallsQuote.transactionValue,
                    // Post-unwrap the contract runs the gas swap on the underlying, not the share.
                    tokenId: swapInputToken,
                    relayerInfo,
                    mainSwapTarget: sizedFrom.transactionTo,
                    mainApprovalAddress: sizedFrom.approvalAddress,
                    slippage,
                    denyExchanges,
                });

                // The relayer surcharges the gas-swap tx cost onto the fee only when the
                // request carries swapValue > 0 — the prelim quote can't include it. Re-quote
                // the fee with the B2 fields BEFORE freezing the main leg's fromAmount,
                // otherwise the committed fee comes back exactly one surcharge above the
                // budget the quote was sized against and assertLifiBudget trips on every attempt.
                const b2FeeQuote = await this.relayerInteractor.getSwapQuote(relayerInfo, {
                    asset: tokenId,
                    amount: BigInt(amount).toString(),
                    outputToken: routingOutputToken,
                    recipient: this.emptyAddress,
                    fallbackAddress: effectiveFallbackAddress,
                    minOutputAmount: "0",
                    dustRecipient: effectiveDustRecipient,
                    commit: false,
                    swapValue: b2.swapValue.toString(),
                    gasSwapMaxInput: b2.gasSwapMaxInput.toString(),
                    gasSwapCalldata: b2.gasSwapCalldata,
                });
                this.assertFeeWithinBounds(b2FeeQuote.feeAmount, amount, inputConfig.maxRelayFee);
                budgetFeeAmount = BigInt(b2FeeQuote.feeAmount);

                // netFromAmount is underlying units: what the committed net shares redeem to,
                // minus the gas-swap slice the contract carves out first.
                contractCallsQuote = await requestContractCallsQuote(
                    (await netUnderlyingFor(budgetFeeAmount)) - b2.gasSwapInput,
                );
                await validateQuote(contractCallsQuote);
                // The re-quoted main leg must still target the router the gas-swap calldata
                // was bound to (RelaySwaps runs both against `swapTarget` / `approvalAddress`),
                // and its native fee must fit the sized swapValue.
                const drift = b2QuoteDrift(this.addressEqualityComparator, contractCallsQuote, sizedFrom, b2.swapValue);
                if (!drift) break;
                if (attempt >= B2_RESIZE_ATTEMPTS) {
                    if (drift.startsWith("native fee")) {
                        throw new InvalidTransactParams(
                            `B2: re-quoted LZ fee ${contractCallsQuote.transactionValue} exceeds the sized swapValue ${b2.swapValue}`,
                        );
                    }
                    throw new InvalidTransactParams(
                        `B2: aggregator re-quoted the main leg on a different router than the gas swap (${drift})`,
                    );
                }
                this.logger?.info("B2: re-quoted main leg drifted from the sized gas swap, re-sizing", { drift, attempt });
                sizedFrom = contractCallsQuote;
            }
        }
        const gasSwapInput = b2?.gasSwapInput ?? 0n;

        // 2.7. Destination affordability (B2 / Stargate routes). The aggregator caps the
        // destination contract-call's budget at the bridge's guaranteed delivery
        // (sendParams.minAmountLD). A deposit costing more can NEVER succeed on
        // arrival — the executor's call fails, LiFi catches it, and the RAW bridged
        // tokens go to the fallback address instead of a shielded note (verified on
        // a mainnet fork against real calldata, 2026-08-31: full delivery, vault +0,
        // all funds to fallback). Fail loudly BEFORE signing a commitment, and hand
        // the caller the note value that would fit so it can rebuild the deposit.
        // Every route, not only Stargate: LiFi encodes the destination call's budget as the
        // route's guaranteed delivery on Across too (measured 2026-09-24 on Optimism, Base,
        // Arbitrum and BSC). Read it off the built calldata; fall back to the provider's
        // `destinationCallAmount`, then to the Stargate `minAmountLD` decoder.
        const destBudget =
            this.swapChainAdapter.getDestinationCallAmount(
                contractCallsQuote.transactionData,
                depositResult.depositTx.data,
            ) ??
            (contractCallsQuote.destinationCallAmount !== undefined
                ? BigInt(contractCallsQuote.destinationCallAmount)
                : undefined) ??
            this.swapChainAdapter.getDestinationDeliveryBudget(contractCallsQuote.transactionData);
        if (destBudget !== undefined && BigInt(totalDepositCost) > destBudget) {
            // Refit target: the guarantee minus the drift margin, so the caller's re-prepare
            // (a fresh quote, a fresh guarantee) does not trip this check again.
            const refitBudget =
                (destBudget * (10_000n - DESTINATION_GUARANTEE_MARGIN_BPS)) / 10_000n;
            // A budget too small to size at all is reported as 0 fitting shares; the
            // actionable error is the unaffordable deposit, not the sizing.
            const affordableNoteValue = yieldTarget
                ? await yieldTarget
                      .sizeSharesForBudget(refitBudget, CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM)
                      .then((sized) => sized.shares)
                      .catch(() => 0n)
                : (refitBudget * 10000n) / (10000n + bps);
            throw new DestinationDepositUnaffordable(
                totalDepositCost,
                destBudget.toString(),
                `0x${affordableNoteValue.toString(16)}` as Hex,
            );
        }

        // 3. Validate the aggregator's fromAmount fits within the budget left after the relay fee
        // AND (B2) the gas-swap slice. `budgetFeeAmount` already carries the B2 gas-swap
        // surcharge when the route needs one. In underlying units for a yield share:
        // `netUnderlyingFor(budgetFeeAmount)` is what the committed net shares redeem to;
        // for a plain note it is `amount − budgetFeeAmount`, so the check is unchanged.
        // Native input: the route consumes transactionValue (fromAmount + bridge fee), all of
        // it out of the forwarded msg.value, so only what is left after THAT is dust.
        const lifiConsumed =
            isNativeInput && BigInt(contractCallsQuote.transactionValue ?? "0x0") > BigInt(contractCallsQuote.fromAmount)
                ? BigInt(contractCallsQuote.transactionValue).toString()
                : contractCallsQuote.fromAmount;
        assertLifiBudget(
            lifiConsumed,
            bigintToHex(await netUnderlyingFor(budgetFeeAmount)),
            gasSwapInput.toString(),
        );

        // 2.5. Wait for the keystore + state-tree leaf caches to be fully
        // populated BEFORE requesting the committed quote below — that's what
        // starts the relayer's short-lived commitment clock
        // (feeCommitment.expiration). A session already kicks both scans off
        // in the background at build time; this just makes sure they're
        // actually finished first instead of racing them, so none of the
        // commitment's TTL is spent on an RPC scan that could have happened
        // earlier. Usually a no-op (already warm by the time
        // prepare/estimate/deposit-proof steps above finish) — only actually
        // waits if a scan is still genuinely in flight.
        await this.core.warmMerkleCaches();

        // 3. Committed relayer quote with swap details
        const committedQuote = await this.relayerInteractor.getSwapQuote(relayerInfo, {
            asset: tokenId,
            amount: BigInt(amount).toString(),
            outputToken: routingOutputToken,
            recipient: this.emptyAddress,
            fallbackAddress: effectiveFallbackAddress,
            minOutputAmount: "0",
            swapCalldata: contractCallsQuote.transactionData,
            swapTarget: contractCallsQuote.transactionTo,
            approvalAddress: contractCallsQuote.approvalAddress,
            dustRecipient: effectiveDustRecipient,
            commit: true,
            // RC-10: bind the dustRescue opt-in into the commitment the relayer signs.
            ...(dustRescue
                ? {
                      dustRescue: {
                          destinationChainId: this.destinationChainId,
                          destinationChainType: this.destinationChainType,
                          tokenId: swapOutputToken,
                          recipientIdentifier: dustRescue.recipientIdentifier,
                      },
                  }
                : {}),
            ...(b2
                ? {
                      swapValue: b2.swapValue.toString(),
                      gasSwapMaxInput: b2.gasSwapMaxInput.toString(),
                      gasSwapCalldata: b2.gasSwapCalldata,
                  }
                : {}),
        });

        // 4. Validate the relayer-signed routing tuple before returning it.
        this.assertFeeWithinBounds(committedQuote.feeAmount, amount, inputConfig.maxRelayFee);
        assertLifiBudget(
            lifiConsumed,
            bigintToHex(await netUnderlyingFor(BigInt(committedQuote.feeAmount))),
            gasSwapInput.toString(),
        );
        this.assertGrossWithdrawal(committedQuote, BigInt(amount));
        const routing = this.swapChainAdapter.decodeSwapRouting(committedQuote.feeCommitment.data);
        this.assertSwapCalldataMatches(routing, contractCallsQuote.transactionData, b2?.gasSwapCalldata);
        this.assertReshieldCrosschainRouting(routing, {
            outputToken: routingOutputToken,
            fallbackAddress: effectiveFallbackAddress,
            dustRecipient: effectiveDustRecipient,
            feeAmount: committedQuote.feeAmount,
            swapTarget: contractCallsQuote.transactionTo,
            approvalAddress: contractCallsQuote.approvalAddress,
            swapValue: b2?.swapValue,
            gasSwapMaxInput: b2?.gasSwapMaxInput,
            gasSwapCalldata: b2?.gasSwapCalldata,
            dustRescue: dustRescue
                ? {
                      destinationChainId: this.destinationChainId,
                      destinationChainType: this.destinationChainType,
                      tokenId: swapOutputToken,
                      recipientIdentifier: dustRescue.recipientIdentifier,
                  }
                : undefined,
        });

        const netAmount = bigintToHex(
            BigInt(committedQuote.feeCommitment.amountSent) - BigInt(committedQuote.feeAmount),
        );
        return {
            selectedQuote: {
                relayerInfo,
                quote: committedQuote,
            },
            swapCalldata: contractCallsQuote.transactionData,
            feeAmount: committedQuote.feeAmount,
            netAmount,
            swapTarget: routing.swapTarget,
            approvalAddress: routing.approvalAddress,
            dustRecipient: effectiveDustRecipient,
            toChainId: this.destinationChainId,
            toChainType: this.destinationChainType,
            fallbackAddress: effectiveFallbackAddress,
            depositNote: depositResult.pendingNote,
            dustRescue,
            swapInputToken,
            // B2 — present only for a Mainnet-destination reshield. Pass all three back into
            // `relayReshieldCrosschain` so relay-time validation checks the same values.
            swapValue: b2?.swapValue,
            gasSwapMaxInput: b2?.gasSwapMaxInput,
            gasSwapCalldata: b2?.gasSwapCalldata,
        };
    }

    /**
     * @inheritdoc IPoolSessionReshieldCrosschain.relayReshieldCrosschain
     * @throws {InvalidTransactParams} When commitment validation fails, `toChainId` does not match the configured destination, or the signed routing diverges.
     * @throws {DustRescueRecipientConflict} When an explicit dustRecipient conflicts with a dustRescue opt-in.
     */
    async relayReshieldCrosschain(params: ReshieldCrosschainParams<TAddress>): Promise<TxReceipt<TLog>> {
        const {
            inputCommitments,
            amount,
            tokenId,
            outputToken,
            toChainId,
            toChainType,
            fallbackAddress,
            swapCalldata,
            selectedQuote,
            dustRecipient,
            depositNote,
            dustRescue,
            swapValue,
            gasSwapMaxInput,
            gasSwapCalldata,
        } = params;
        const yieldTarget = this.yieldTargetFor(outputToken);
        const swapOutputToken = yieldTarget ? yieldTarget.fundingToken : outputToken;
        const routingOutputToken = yieldTarget ? this.nativeAssetAddress : outputToken;

        this.assertDestinationChainMatches(toChainId, toChainType);

        const transactParams = {
            processor: selectedQuote.relayerInfo.processorAddress,
            data: selectedQuote.quote.feeCommitment.data,
        };

        this.assertRelayerChainMatchesPool(selectedQuote.relayerInfo.chainId);

        const effectiveDustRecipient = dustRecipient ?? selectedQuote.relayerInfo.address;
        if (
            dustRescue &&
            !this.addressEqualityComparator.equals(effectiveDustRecipient, selectedQuote.relayerInfo.address)
        ) {
            throw new DustRescueRecipientConflict(
                String(effectiveDustRecipient),
                String(selectedQuote.relayerInfo.address),
            );
        }

        // Defense-in-depth: this method accepts hand-built params, so re-validate
        // the signed routing tuple even if prepareReshieldCrosschainQuote already did.
        const routing = this.swapChainAdapter.decodeSwapRouting(selectedQuote.quote.feeCommitment.data);
        this.assertSwapCalldataMatches(routing, swapCalldata, gasSwapCalldata);
        // Hand-built or tampered params never went through prepare's quote checks.
        await assertNoSwapExecutor(this.swapChainAdapter, {
            transactionTo: routing.swapTarget,
            approvalAddress: routing.approvalAddress,
            transactionData: routing.swapCalldata,
        });
        if (this.swapChainAdapter.isSwapExecutorCall(routing.gasSwapCalldata)) {
            throw new UnexpectedTransactionTarget(
                "the B2 gas-swap calldata calls a swap executor, which runs arbitrary calls",
            );
        }
        this.assertAmountSentMatchesAmountPlusFee(
            selectedQuote.quote.feeCommitment.amountSent,
            amount,
            selectedQuote.quote.feeAmount,
        );
        this.assertReshieldCrosschainRouting(routing, {
            outputToken: routingOutputToken,
            fallbackAddress,
            dustRecipient: effectiveDustRecipient,
            feeAmount: selectedQuote.quote.feeAmount,
            swapTarget: params.swapTarget,
            approvalAddress: params.approvalAddress,
            // B2: undefined on a non-Mainnet-destination reshield => routing must carry
            // empty / "0x". A Mainnet reshield must pass all three back from the prepared
            // quote or this fails loudly.
            swapValue,
            gasSwapMaxInput,
            gasSwapCalldata,
            dustRescue: dustRescue
                ? {
                      destinationChainId: toChainId,
                      destinationChainType: toChainType,
                      tokenId: swapOutputToken,
                      recipientIdentifier: dustRescue.recipientIdentifier,
                  }
                : undefined,
        });

        if (!this.addressEqualityComparator.equals(selectedQuote.quote.feeCommitment.asset, tokenId)) {
            throw new InvalidTransactParams(
                `feeCommitment.asset ${selectedQuote.quote.feeCommitment.asset} does not match withdraw tokenId ${tokenId}`,
            );
        }

        assertFeeCommitmentLive(selectedQuote.quote.feeCommitment.expiration);

        const feeAmount = bigintToHex(BigInt(selectedQuote.quote.feeAmount));
        const amountOut = bigintToHex(BigInt(selectedQuote.quote.feeCommitment.amountSent));

        this.logger?.info("Preparing reshield-crosschain withdrawal proof", {
            tokenId,
            amount,
            toChainId,
        });

        const { proof, notesData, changePendingNotes, spentNotes, spentNullifiers } =
            await this.core.prepareTransact({
                inputCommitments,
                amount,
                tokenId,
                recipientAddress: this.emptyAddress, // ignored when transactParams is provided
                relayAddress: selectedQuote.relayerInfo.address,
                feeAmount,
                processorAddress: selectedQuote.relayerInfo.processorAddress,
                amountOut,
                transactParams,
            });

        this.logger?.info("Submitting reshield-crosschain to relayer via relaySwap");

        const relayerResult = await this.relayerInteractor.relaySwap(selectedQuote.relayerInfo, {
            signedSwapCommitment: selectedQuote.quote.feeCommitment,
            proof,
            noteData: notesData,
            inputNullifierNumber: spentNotes.length,
            outputCommitmentNumber: changePendingNotes.length,
        });

        notifyBroadcast(params.onBroadcast, relayerResult, this.logger);

        const txReceipt = await this.rpcInteractor.waitForTransactionReceipt(relayerResult);

        if (!txReceipt.status) return txReceipt;

        const outputNotes: PendingNote<TAddress>[] = depositNote?.isOwned
            ? [...changePendingNotes, depositNote]
            : changePendingNotes;
        await this.core.persistNoteUpdates(spentNotes, outputNotes, txReceipt.txHash, {
            expectedNullifiers: spentNullifiers,
            receiptLogs: txReceipt.logs,
        });

        return txReceipt;
    }

    /**
     * Asserts the caller-supplied `toChainId` matches the destination chain
     * this session was constructed for — every interactor/quote provider call
     * in this class assumes a single fixed destination.
     *
     * @throws {DestinationChainNotSupported} If `toChainId` diverges from the configured destination.
     */
    /** The configured destination-chain yield-share target whose share is `outputToken`, if any. */
    private yieldTargetFor(outputToken: TAddress): YieldSwapDepositTarget<TTx, TAddress> | undefined {
        return yieldSwapDepositTargetFor(this.destinationYieldDepositTargets, outputToken, (a, b) =>
            this.swapChainAdapter.isSameToken(a, b),
        );
    }

    private assertDestinationChainMatches(toChainId: number, toChainType: string): void {
        if (toChainId !== this.destinationChainId || toChainType !== this.destinationChainType) {
            throw new DestinationChainNotSupported(toChainId, toChainType);
        }
    }

    /**
     * Refuses, before any quote, a destination chain whose relayer publishes
     * `destinationCallsSupported: false`: no bridge can run the deposit call there, so the funds
     * would land on the fallback address. Read from a seeded `relayerChainDetails` entry for the
     * destination chain, else from the same relayer's `/v1/details/{destinationChainType}/{destinationChainId}`.
     * Allowed when the field is absent (relayer predating it) or details cannot be read; a
     * destination this relayer does not serve answers an error and is allowed too.
     *
     * @throws {DestinationCallsUnsupported} If the destination chain reports `false`.
     */
    private async assertDestinationAcceptsCalls(relayerInfo: RelayerInfo<TAddress>): Promise<void> {
        const supported = this.seededDestinationCallsSupported ?? (await this.destinationCallsSupportedFor(relayerInfo));
        if (supported === false) {
            throw new DestinationCallsUnsupported(this.destinationChainId, this.destinationChainType);
        }
    }

    /**
     * The destination chain's published `destinationCallsSupported`, cached per relayer URL for
     * {@link RELAYER_CAPS_TTL_MS}. Undefined when absent or unreadable; failures are not cached.
     */
    private async destinationCallsSupportedFor(relayerInfo: RelayerInfo<TAddress>): Promise<boolean | undefined> {
        const cached = this.destinationCallsCache.get(relayerInfo.url);
        if (cached && Date.now() - cached.fetchedAt < RELAYER_CAPS_TTL_MS) {
            return cached.supported;
        }
        try {
            const details = await this.relayerInteractor.getChainDetails({
                url: relayerInfo.url,
                chainType: this.destinationChainType,
                chainId: this.destinationChainId,
            });
            const supported = details.destinationCallsSupported;
            this.destinationCallsCache.set(relayerInfo.url, { supported, fetchedAt: Date.now() });
            return supported;
        } catch (error) {
            this.logger?.warn("Could not read the destination chain's destinationCallsSupported; allowing", {
                relayerUrl: relayerInfo.url,
                destinationChainId: this.destinationChainId,
                error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
        }
    }

    /**
     * Asserts the relayer operates on the same chain as the source pool.
     *
     * @throws {InvalidTransactParams} If chain IDs differ.
     */
    private assertRelayerChainMatchesPool(relayerChainId: number): void {
        if (relayerChainId !== this.chainId) {
            throw new InvalidTransactParams(
                `Relayer chain ${relayerChainId} does not match pool chain ${this.chainId}`,
            );
        }
    }

    /**
     * Asserts the given aggregator quote address is approved in RelaySwaps.approvedRouters
     * on the source chain.
     *
     * @throws {UnallowedLiFiAddress} If the address is not approved on-chain.
     */
    private async assertLiFiAddressAllowed(
        address: TAddress,
        role: string,
        relaySwapsAddress: TAddress,
    ): Promise<void> {
        const approved = await this.swapChainAdapter.isApprovedRouter(address, relaySwapsAddress);
        if (!approved) {
            throw new UnallowedLiFiAddress(String(address), role, this.chainId);
        }
    }

    /**
     * Asserts the aggregator quote's `transactionData` embeds both the deposit proof calldata
     * and the destination Entrypoint address verbatim at the raw byte level.
     *
     * @throws {LiFiDepositCalldataNotFound} If the deposit calldata is absent from the transaction blob.
     * @throws {LiFiDepositTargetNotFound} If the destination Entrypoint address is absent.
     */
    private assertDepositIsEmbeddedInQuote(
        transactionData: Hex,
        depositCallData: Hex,
        depositTargetAddress: TAddress,
    ): void {
        assertDepositCalldataEmbedded(transactionData, depositCallData, this.destinationChainId);
        if (!this.swapChainAdapter.isAddressEmbeddedInCalldata(transactionData, depositTargetAddress)) {
            throw new LiFiDepositTargetNotFound(String(depositTargetAddress), this.destinationChainId);
        }
    }

    /**
     * Asserts the relayer-signed `amountSent` equals the caller's intended gross
     * withdrawal (the original, quote-independent `amount` passed to
     * `prepareReshieldCrosschainQuote`) — preventing a relayer from inflating the
     * pool outflow and skimming the difference. `assertAmountSentMatchesAmountPlusFee`
     * (re-checked in `relayReshieldCrosschain`) only reconstitutes gross from
     * `netAmount`, which is itself derived from this same `amountSent` — it cannot
     * anchor `amountSent` to anything the relayer doesn't control, so this check
     * against the caller's own request is the one that actually does.
     *
     * @throws {InvalidTransactParams} If `amountSent` differs from the requested gross withdrawal.
     */
    private assertGrossWithdrawal(committedQuote: SwapRelayerQuote<TAddress>, amount: bigint): void {
        if (BigInt(committedQuote.feeCommitment.amountSent) !== amount) {
            throw new InvalidTransactParams(
                `Committed amountSent ${committedQuote.feeCommitment.amountSent} does not match requested gross withdrawal ${amount}`,
                // The note being reshielded, not the output token it lands in.
                {
                    code: "commitmentAmountSentMismatch",
                    side: "spent",
                    values: {
                        amountSent: BigInt(committedQuote.feeCommitment.amountSent),
                        expected: amount,
                    },
                },
            );
        }
    }

    /**
     * Asserts the relayer-quoted `amountSent` equals `amount + feeAmount`.
     *
     * @throws {InvalidTransactParams} If `amountSent !== amount + feeAmount`.
     */
    private assertAmountSentMatchesAmountPlusFee(
        amountSent: string,
        amount: Hex,
        feeAmount: string,
    ): void {
        const expected = BigInt(amount) + BigInt(feeAmount);
        const actual = BigInt(amountSent);
        if (actual !== expected) {
            throw new InvalidTransactParams(
                `Relayer quote.amountSent ${actual} does not match caller amount + quote.feeAmount ${expected}`,
                // The note being reshielded, not the output token it lands in.
                {
                    code: "commitmentAmountSentMismatch",
                    side: "spent",
                    values: { amountSent: actual, expected },
                },
            );
        }
    }

    /**
     * Asserts the decoded routing's embedded `swapCalldata` byte-equals the
     * caller's swap calldata.
     *
     * @throws {InvalidTransactParams} If the calldata diverges.
     */
    private assertSwapCalldataMatches(
        routing: SwapRouting<TAddress>,
        swapCalldata: Hex,
        gasSwapCalldata?: Hex,
    ): void {
        if (routing.swapCalldata.toLowerCase() !== swapCalldata.toLowerCase()) {
            throw new InvalidTransactParams(
                `Relayer swapCommitment swapCalldata ${routing.swapCalldata} does not match caller swapCalldata ${swapCalldata}`,
            );
        }
        // B2: the same-chain gas-swap calldata is also proof-bound; verify it round-tripped
        // through the relayer unchanged. `"0x"` on every non-Mainnet-destination reshield.
        const expectedGasSwap = (gasSwapCalldata ?? "0x").toLowerCase();
        if (routing.gasSwapCalldata.toLowerCase() !== expectedGasSwap) {
            throw new InvalidTransactParams(
                `Relayer swapCommitment gasSwapCalldata does not match the caller's gas-swap calldata`,
            );
        }
    }

    /**
     * Asserts the relayer-quoted fee does not consume the whole withdrawal and
     * respects the Entrypoint's maxRelayFee when one is configured.
     *
     * @throws {InvalidTransactParams} If the fee is not below the withdrawal amount.
     * @throws {RelayFeeExceedsMax} If the fee exceeds a nonzero maxRelayFee.
     */
    private assertFeeWithinBounds(feeAmount: string, amount: Hex, maxRelayFee: Hex): void {
        const fee = BigInt(feeAmount);
        if (fee >= BigInt(amount)) {
            throw new InvalidTransactParams(
                `Relayer fee ${fee} consumes the entire withdrawal amount ${BigInt(amount)}`,
                // The fee comes out of the note being spent, so it is in that
                // token and not in the reshield's output token.
                {
                    code: "relayFeeConsumesWithdrawal",
                    side: "spent",
                    values: { fee, amount: BigInt(amount) },
                },
            );
        }
        const maxFee = BigInt(maxRelayFee);
        if (maxFee > 0n && fee > maxFee) {
            throw new RelayFeeExceedsMax(fee.toString(), maxFee.toString());
        }
    }

    /**
     * Asserts the aggregator quote actually routes the requested tokens and chains.
     *
     * @throws {SwapQuoteMismatch} If any routed field differs from the request.
     */
    private assertSwapQuoteMatchesRequest(
        quote: SwapQuoteResult<TAddress> | SwapAndDepositQuoteResult<TAddress>,
        expected: {
            fromToken: TAddress;
            toToken: TAddress;
            fromChainId: number;
            toChainId: number;
        },
    ): void {
        if (!this.swapChainAdapter.isSameToken(quote.fromTokenAddress, expected.fromToken)) {
            throw new SwapQuoteMismatch(
                "fromToken",
                String(expected.fromToken),
                String(quote.fromTokenAddress),
            );
        }
        if (!this.swapChainAdapter.isSameToken(quote.toTokenAddress, expected.toToken)) {
            throw new SwapQuoteMismatch(
                "toToken",
                String(expected.toToken),
                String(quote.toTokenAddress),
            );
        }
        if (quote.fromChainId !== expected.fromChainId) {
            throw new SwapQuoteMismatch(
                "fromChainId",
                String(expected.fromChainId),
                String(quote.fromChainId),
            );
        }
        if (quote.toChainId !== expected.toChainId) {
            throw new SwapQuoteMismatch(
                "toChainId",
                String(expected.toChainId),
                String(quote.toChainId),
            );
        }
    }

    /**
     * B2: sizes the in-contract gas swap that funds a Mainnet-destination reshield's
     * LayerZero fee. Takes the aggregator's quoted `transactionValue` (the native fee it wants
     * as `msg.value`), applies 1.2x headroom -> `swapValue`, then quotes a same-chain
     * input-token -> native-asset swap sized to ~`swapValue x 1.05` out. Returns the swap
     * calldata, the input-token units it consumes (`gasSwapInput`, carved out of the main
     * budget) and a bounded approval ceiling (`gasSwapMaxInput`).
     *
     * RelaySwaps runs `gasSwapCalldata` against the main swap's `swapTarget` /
     * `approvalAddress`, so the same-chain quote MUST resolve to that same router.
     *
     * @throws {InvalidTransactParams}
     * @throws {SwapQuoteMismatch}
     * @throws {UnallowedLiFiAddress}
     */
    private async sizeB2GasSwap(args: {
        transactionValue: Hex;
        tokenId: TAddress;
        relayerInfo: RelayerInfo<TAddress>;
        mainSwapTarget: TAddress;
        mainApprovalAddress: TAddress;
        slippage?: number;
        denyExchanges?: string[];
    }): Promise<B2GasSwap<TAddress>> {
        if (!this.swapQuoteProvider) {
            throw new InvalidTransactParams(
                "swapQuoteProvider must be configured for a Mainnet-destination reshield (B2 gas swap)",
            );
        }
        const { relayerInfo } = args;
        const sourceChainId = relayerInfo.chainId;
        const processorAddress = relayerInfo.processorAddress;
        const rawValue = BigInt(args.transactionValue);
        const swapValue = (rawValue * B2_SWAP_VALUE_HEADROOM_BPS) / 10_000n;
        await this.assertSwapValueWithinRelayerCap(relayerInfo, swapValue);
        const gasSwapTargetOut = (swapValue * B2_GAS_SWAP_OUT_HEADROOM_BPS) / 10_000n;

        const gasSwapQuote = await this.swapQuoteProvider.getSwapQuote({
            fromChainId: sourceChainId,
            toChainId: sourceChainId,
            fromToken: args.tokenId,
            toToken: this.nativeAssetAddress,
            fromAddress: processorAddress,
            amount: gasSwapTargetOut.toString(),
            amountType: "to",
            slippage: args.slippage,
            denyExchanges: args.denyExchanges,
        });

        this.assertSwapQuoteMatchesRequest(gasSwapQuote, {
            fromToken: args.tokenId,
            toToken: this.nativeAssetAddress,
            fromChainId: sourceChainId,
            toChainId: sourceChainId,
        });
        await this.swapChainAdapter.assertRoutingLayoutMatches(processorAddress, this.chainId);
        await this.assertLiFiAddressAllowed(gasSwapQuote.transactionTo, "gas-swap transactionTo", processorAddress);
        await this.assertLiFiAddressAllowed(
            gasSwapQuote.approvalAddress,
            "gas-swap approvalAddress",
            processorAddress,
        );
        await assertNoSwapExecutor(this.swapChainAdapter, gasSwapQuote);
        if (!this.addressEqualityComparator.equals(gasSwapQuote.transactionTo, args.mainSwapTarget)) {
            throw new InvalidTransactParams(
                `B2 gas-swap router ${gasSwapQuote.transactionTo} differs from the main swap router ${args.mainSwapTarget}`,
            );
        }
        if (!this.addressEqualityComparator.equals(gasSwapQuote.approvalAddress, args.mainApprovalAddress)) {
            throw new InvalidTransactParams(
                `B2 gas-swap approval address ${gasSwapQuote.approvalAddress} differs from the main swap approval address ${args.mainApprovalAddress}`,
            );
        }

        const gasSwapInput = BigInt(gasSwapQuote.fromAmount);
        const gasSwapMaxInput = (gasSwapInput * B2_GAS_SWAP_MAX_INPUT_SLACK_BPS) / 10_000n;
        return {
            swapValue,
            gasSwapMaxInput,
            gasSwapCalldata: gasSwapQuote.transactionData,
            gasSwapInput,
            swapTarget: gasSwapQuote.transactionTo,
            approvalAddress: gasSwapQuote.approvalAddress,
        };
    }

    /**
     * Refuses, before the gas-swap quote and before proving, a B2 `swapValue` above the
     * relayer's published `max_swap_value_wei` — the relayer would 400 the quote anyway, but only
     * after the caller had built the route. Skipped (the relayer still enforces it) when the
     * relayer predates cap publication or its `/v1/details` cannot be read.
     *
     * @throws {SwapValueExceedsRelayerCap} If `swapValue` exceeds the published cap.
     */
    private async assertSwapValueWithinRelayerCap(
        relayerInfo: RelayerInfo<TAddress>,
        swapValue: bigint,
    ): Promise<void> {
        const caps = await this.relayerCapsFor(relayerInfo);
        const maxSwapValueWei = caps?.maxSwapValueWei;
        if (maxSwapValueWei !== undefined && swapValue > maxSwapValueWei) {
            throw new SwapValueExceedsRelayerCap(swapValue, maxSwapValueWei);
        }
    }

    /**
     * The relayer's published caps: from the cache while fresh (seeded details or an earlier
     * fetch), else from `/v1/details`. Undefined when details cannot be read — failures are not
     * cached, so the next B2 sizing retries.
     */
    private async relayerCapsFor(relayerInfo: RelayerInfo<TAddress>): Promise<RelayerCaps | undefined> {
        const cached = this.relayerCapsCache.get(this.relayerCapsKey(relayerInfo.chainId, relayerInfo.address));
        if (cached && Date.now() - cached.fetchedAt < RELAYER_CAPS_TTL_MS) {
            return cached.caps;
        }
        try {
            const details = await this.relayerInteractor.getChainDetails(relayerInfo);
            return this.cacheRelayerCaps(details, relayerInfo.address);
        } catch (error) {
            this.logger?.warn("Could not read relayer max_swap_value_wei; leaving the cap to the relayer", {
                relayerUrl: relayerInfo.url,
                error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
        }
    }

    /**
     * Caches `details`' caps under its chain + relayer address. A fetch passes the
     * `RelayerInfo.address` it was made for, so the entry is found by the same key lookups use
     * even if the published `relayerAddress` differs; a seeded entry (no `fetchedFor`) is keyed
     * by its `relayerAddress`, and one without it (relayer predating discovery) is not cached.
     */
    private cacheRelayerCaps(details: RelayerChainDetails<TAddress>, fetchedFor?: TAddress): RelayerCaps {
        const caps = relayerCapsFromDetails(details);
        const address = fetchedFor ?? details.relayerAddress;
        if (address !== undefined) {
            this.relayerCapsCache.set(this.relayerCapsKey(details.id, address), { caps, fetchedAt: Date.now() });
        }
        return caps;
    }

    private relayerCapsKey(chainId: number, relayerAddress: TAddress): string {
        return `${chainId}:${String(relayerAddress).toLowerCase()}`;
    }

    /**
     * Asserts every reshield-crosschain invariant on the relayer-signed
     * routing tuple: empty-address recipient sentinel, zero minOutputAmount/nativeGas,
     * fallbackAddress, and the outputToken/dustRecipient/feeAmount (plus
     * swapTarget/approvalAddress when a swap quote is in scope). The three B2
     * fields must match the SDK-sized values (`expected.swapValue` etc.) when a
     * gas swap was sized, and must be zero / "0x" otherwise.
     *
     * @throws {InvalidTransactParams} If any field diverges.
     */
    private assertReshieldCrosschainRouting(
        routing: SwapRouting<TAddress>,
        expected: {
            outputToken: TAddress;
            fallbackAddress: TAddress;
            dustRecipient: TAddress;
            feeAmount: string;
            swapTarget?: TAddress;
            approvalAddress?: TAddress;
            swapValue?: bigint;
            gasSwapMaxInput?: bigint;
            gasSwapCalldata?: Hex;
            // RC-10: absent means the routing's dustRescue must be the all-zero sentinel
            // (chainId 0n) — a relayer cannot smuggle in a rescue opt-in the caller never
            // requested, any more than it can smuggle in a gas swap.
            dustRescue?: RelaySwapDustRescue<TAddress>;
        },
    ): void {
        if (!this.addressEqualityComparator.equals(routing.recipient, this.emptyAddress)) {
            throw new InvalidTransactParams(
                `Reshield-crosschain routing recipient ${routing.recipient} must be the empty-address sentinel`,
            );
        }
        if (routing.minOutputAmount !== 0n) {
            throw new InvalidTransactParams(
                `Reshield-crosschain routing minOutputAmount ${routing.minOutputAmount} must be 0 — the source chain cannot verify destination output`,
            );
        }
        if (routing.nativeGas !== 0n) {
            throw new InvalidTransactParams(
                `Reshield-crosschain routing nativeGas ${routing.nativeGas} must be 0`,
            );
        }
        // B2 (self-funded bridge msg.value for a Mainnet-destination reshield): when the
        // SDK sized a gas swap, `expected.*` carry the SDK-computed values and the signed
        // routing must match them exactly. Otherwise all three must be zero / "0x" — a
        // relayer cannot introduce a gas swap the caller never asked for.
        const expectedSwapValue = expected.swapValue ?? 0n;
        const expectedGasSwapMaxInput = expected.gasSwapMaxInput ?? 0n;
        const expectedGasSwapCalldata = (expected.gasSwapCalldata ?? "0x").toLowerCase();
        if (routing.swapValue !== expectedSwapValue) {
            throw new InvalidTransactParams(
                `Reshield-crosschain routing swapValue ${routing.swapValue} does not match expected ${expectedSwapValue}`,
            );
        }
        if (routing.gasSwapMaxInput !== expectedGasSwapMaxInput) {
            throw new InvalidTransactParams(
                `Reshield-crosschain routing gasSwapMaxInput ${routing.gasSwapMaxInput} does not match expected ${expectedGasSwapMaxInput}`,
            );
        }
        if (routing.gasSwapCalldata.toLowerCase() !== expectedGasSwapCalldata) {
            throw new InvalidTransactParams(
                `Reshield-crosschain routing gasSwapCalldata does not match the SDK-sized gas swap`,
            );
        }
        const expectedDustRescueChainId = expected.dustRescue
            ? BigInt(expected.dustRescue.destinationChainId)
            : 0n;
        if (routing.dustRescue.chainId !== expectedDustRescueChainId) {
            throw new InvalidTransactParams(
                `Routing dustRescue.chainId ${routing.dustRescue.chainId} does not match expected ${expectedDustRescueChainId}`,
            );
        }
        if (expected.dustRescue) {
            const { tokenId, recipientIdentifier } = expected.dustRescue;
            const isCanonical = recipientIdentifier.kind === "canonical";
            const expectedViewingPubKey = isCanonical ? recipientIdentifier.viewingPubKey : "0x";
            if (!this.addressEqualityComparator.equals(routing.dustRescue.tokenId, tokenId)) {
                throw new InvalidTransactParams(
                    `Routing dustRescue.tokenId ${routing.dustRescue.tokenId} does not match expected ${tokenId}`,
                );
            }
            if (routing.dustRescue.isCanonical !== isCanonical) {
                throw new InvalidTransactParams(
                    `Routing dustRescue.isCanonical ${routing.dustRescue.isCanonical} does not match expected recipientIdentifier.kind`,
                );
            }
            if (
                routing.dustRescue.spendingPubKey.toLowerCase() !==
                recipientIdentifier.spendingPubKey.toLowerCase()
            ) {
                throw new InvalidTransactParams(
                    "Routing dustRescue.spendingPubKey does not match expected",
                );
            }
            if (
                routing.dustRescue.viewingPubKey.toLowerCase() !==
                expectedViewingPubKey.toLowerCase()
            ) {
                throw new InvalidTransactParams(
                    "Routing dustRescue.viewingPubKey does not match expected",
                );
            }
        }
        if (!this.addressEqualityComparator.equals(routing.fallbackAddress, expected.fallbackAddress)) {
            throw new InvalidTransactParams(
                `Routing fallbackAddress ${routing.fallbackAddress} does not match expected ${expected.fallbackAddress}`,
            );
        }
        if (!this.addressEqualityComparator.equals(routing.outputToken, expected.outputToken)) {
            throw new InvalidTransactParams(
                `Routing outputToken ${routing.outputToken} does not match expected ${expected.outputToken}`,
            );
        }
        if (!this.addressEqualityComparator.equals(routing.dustRecipient, expected.dustRecipient)) {
            throw new InvalidTransactParams(
                `Routing dustRecipient ${routing.dustRecipient} does not match expected ${expected.dustRecipient}`,
            );
        }
        if (routing.feeAmount !== BigInt(expected.feeAmount)) {
            throw new InvalidTransactParams(
                `Routing feeAmount ${routing.feeAmount} does not match quote feeAmount ${expected.feeAmount}`,
            );
        }
        if (
            routing.feeAmount > 0n &&
            this.addressEqualityComparator.equals(routing.feeRecipient, this.emptyAddress)
        ) {
            throw new InvalidTransactParams(
                `Routing feeRecipient is the empty-address sentinel while feeAmount ${routing.feeAmount} > 0 (the fee would be burned)`,
            );
        }
        if (
            expected.swapTarget !== undefined &&
            !this.addressEqualityComparator.equals(routing.swapTarget, expected.swapTarget)
        ) {
            throw new InvalidTransactParams(
                `Routing swapTarget ${routing.swapTarget} does not match aggregator transactionTo ${expected.swapTarget}`,
            );
        }
        if (
            expected.approvalAddress !== undefined &&
            !this.addressEqualityComparator.equals(routing.approvalAddress, expected.approvalAddress)
        ) {
            throw new InvalidTransactParams(
                `Routing approvalAddress ${routing.approvalAddress} does not match aggregator approvalAddress ${expected.approvalAddress}`,
            );
        }
    }
}
