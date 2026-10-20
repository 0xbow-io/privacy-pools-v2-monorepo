import type {
    Address,
    EstimateReshieldParams,
    EVMProof,
    Hex,
    IAddressEqualityComparator,
    IEntrypointInteractor,
    ILogger,
    IPoolSessionReshield,
    IRelayerInteractor,
    ISwapAndDepositQuoteProvider,
    ISwapChainAdapter,
    ISwapQuoteProvider,
    ITransactOrchestrator,
    ITxReceiptWaiter,
    PendingNote,
    PoolSessionReshieldConfig,
    PoolSessionReshieldDependencies,
    PreparedReshieldQuote,
    PrepareReshieldQuoteParams,
    PreparedTransaction,
    RelaySwapDustRescue,
    ReshieldEstimate,
    ReshieldParams,
    SwapAndDepositQuoteResult,
    SwapQuoteResult,
    SwapRelayerQuote,
    SwapRouting,
    ReshieldExecutorCall,
    ExecutorCallContext,
    SwapExecutorAddresses,
    TxLog,
    TxReceipt,
    YieldSwapDepositTarget,
    YieldSwapWrapper,
} from "../../internal.js";
import {
    assertDepositCalldataEmbedded,
    assertExecutorCallMatches,
    assertNoSwapExecutor,
    assertFeeCommitmentLive,
    assertLifiBudget,
    lifiBudgetViolation,
    AssetNotSupported,
    bigintToHex,
    composeExecutorSwapThenCall,
    DepositBelowMinimum,
    DepositTargetMismatch,
    DustRescueRecipientConflict,
    InvalidPoolSessionConfig,
    InvalidTransactParams,
    LiFiDepositTargetNotFound,
    NativeSwapDepositUnavailable,
    notifyBroadcast,
    RelayFeeExceedsMax,
    SWAP_DUST_TOLERANCE_BPS,
    SwapQuoteMismatch,
    SwapRouteUnavailable,
    UnallowedLiFiAddress,
    UnexpectedTransactionTarget,
} from "../../internal.js";
import {
    assertZapApproved,
    previewRedeemNet,
    yieldSwapDepositTargetFor,
    yieldWrapperFor,
} from "../../utils/index.js";

/**
 * Gas the aggregator's executor gives the embedded deposit call. Entrypoint.deposit (a Groth16
 * verification plus a tree insert) measured ~574k on BSC, where it reverts
 * PoolVault_InvalidDepositProof at the aggregator's 300k default. Same as the cross-chain budget.
 */
const DEPOSIT_CALL_GAS_LIMIT = "800000";

/**
 * Room (bps of the net swap budget) the estimate leaves between the executor route's input and the
 * budget, so the re-quote at prepare can move a little and still pass assertLifiBudget.
 */
const EXECUTOR_ROUTE_HEADROOM_BPS = 15n;
/** Where a rescale aims the route input: inside the headroom, far inside the dust tolerance. */
const EXECUTOR_ROUTE_TARGET_BPS = 30n;
/** Exact-output quotes the estimate may spend fitting the deposit to the budget. */
const EXECUTOR_ROUTE_MAX_ROUNDS = 4;

/**
 * Orchestrates the reshield (withdraw + swap + deposit) flow via a relayer, generic over the
 * chain's prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type
 * `TProof`, and raw receipt-log type `TLog`.
 *
 * With the RelaySwaps contract, deposit is embedded in the swap calldata via an aggregator's
 * contract-calls quote. The routing recipient is the chain's empty-address sentinel — the
 * contract's "no source-chain recipient" mode — since output goes back into the pool via the
 * aggregator's contractCalls, not to an external recipient. Output sufficiency is enforced by
 * `Entrypoint.deposit()` reverting, so `minOutputAmount` and `nativeGas` are always 0.
 *
 * The caller generates the deposit proof first, then builds contract-calls calldata and gets a
 * relayer quote committing to the full calldata. The session validates the committed calldata
 * byte-equals the caller's and submits via the unified `relaySwap()` endpoint.
 *
 * Every operation that varies by chain (decoding the relayer-signed routing blob, checking a
 * router allowlist) is delegated to the injected `swapChainAdapter` ({@link ISwapChainAdapter}).
 */
export class PoolSessionReshield<
    TTx extends { to: TAddress; data: Hex },
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionReshield<TTx, TAddress, TLog>
{
    private readonly chainId: number;
    private readonly core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    private readonly relayerInteractor: IRelayerInteractor<TAddress>;
    private readonly rpcInteractor: ITxReceiptWaiter<TLog>;
    private readonly entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly emptyAddress: TAddress;
    private readonly swapQuoteProvider?: ISwapQuoteProvider<TAddress>;
    private readonly swapAndDepositQuoteProvider?: ISwapAndDepositQuoteProvider<TAddress>;
    private readonly swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
    private readonly yieldDepositTargets: YieldSwapDepositTarget<TTx, TAddress>[];
    private readonly yieldWrappers: YieldSwapWrapper<TAddress>[];
    private readonly relaySwapsAddress?: TAddress;
    private readonly swapExecutor?: SwapExecutorAddresses<TAddress>;
    private readonly nativeAssetAddress?: TAddress;
    private readonly logger?: ILogger;

    constructor(config: PoolSessionReshieldConfig<TTx, TAddress, TProof, TLog>, deps?: PoolSessionReshieldDependencies) {
        this.chainId = config.chainId;
        this.core = config.core;
        this.relayerInteractor = config.relayerInteractor;
        this.rpcInteractor = config.rpcInteractor;
        this.entrypointInteractor = config.entrypointInteractor;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.emptyAddress = config.emptyAddress;
        this.swapQuoteProvider = config.swapQuoteProvider;
        this.swapAndDepositQuoteProvider = config.swapAndDepositQuoteProvider;
        this.swapChainAdapter = config.swapChainAdapter;
        this.yieldWrappers = config.yieldWrappers ?? [];
        this.yieldDepositTargets = config.yieldDepositTargets ?? [];
        for (const target of this.yieldDepositTargets) {
            if (target.chainId !== config.chainId) {
                throw new InvalidPoolSessionConfig(
                    `yield deposit target ${String(target.shareToken)} is bound to chain ${target.chainId}; this session is chain ${config.chainId}`,
                );
            }
        }
        this.relaySwapsAddress = config.relaySwapsAddress;
        this.swapExecutor = config.swapExecutor;
        this.nativeAssetAddress = config.nativeAssetAddress;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionReshield.estimateReshieldAmount
     * @throws {InvalidTransactParams} When swapQuoteProvider is not configured or the fee exceeds the amount.
     * @throws {AssetNotSupported} When the output token is not enabled on the Entrypoint.
     * @throws {RelayFeeExceedsMax} When the relayer fee exceeds the Entrypoint maxRelayFee.
     * @throws {DepositBelowMinimum} When the computed note value is below the Entrypoint minimum.
     * @throws {SwapRouteUnavailable} When the executor route prepare builds has no quote, or no deposit size fits the net budget.
     * @throws {SwapQuoteMismatch} When the aggregator quote routes different tokens/chains than requested.
     */
    async estimateReshieldAmount(
        params: EstimateReshieldParams<TAddress>,
    ): Promise<ReshieldEstimate<TAddress>> {
        if (!this.swapQuoteProvider) {
            throw new InvalidTransactParams(
                "swapQuoteProvider must be configured to use estimateReshieldAmount()",
            );
        }
        const relaySwapsAddress = this.requireRelaySwapsAddress();

        const { relayerInfo, amount, tokenId, outputToken, dustRecipient, slippage } = params;
        const yieldTarget = this.yieldTargetFor(outputToken);
        // A share output is funded with the share's underlying (or native coin): the aggregator
        // swaps into that, and the routing names it as the output token.
        const swapOutputToken = yieldTarget ? yieldTarget.fundingToken : outputToken;
        const routingOutputToken = swapOutputToken;

        const effectiveDustRecipient = dustRecipient ?? relayerInfo.address;

        // Pre-flight: output token must be depositable, input config bounds the fee.
        // vettingFeeBPS is read on-chain — the only value Entrypoint.deposit accepts.
        const [outputConfig, inputConfig] = await Promise.all([
            this.entrypointInteractor.getAssetConfig(outputToken),
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
            minOutputAmount: "0",
            dustRecipient: effectiveDustRecipient,
            commit: false,
        });

        this.assertFeeWithinBounds(prelimQuote.feeAmount, amount, inputConfig.maxRelayFee);
        const feeAmount = BigInt(prelimQuote.feeAmount);
        // Shares for a yield-share note, plain token units otherwise. The relayer fee is
        // priced (and stays committed) in this unit.
        const netShares = BigInt(amount) - feeAmount;

        // 1b. Yield share input: RelaySwaps redeems the shares into the wrapper's underlying
        //     before the swap (`executeUnwrapped`), so the DEX leg is quoted on the UNDERLYING
        //     for what those net shares redeem to. `previewRedeem` is the same read the zap
        //     performs; the rate only rises between quote and execution, so any surplus lands
        //     in the delta dust sweep, never a shortfall.
        const wrapper = yieldWrapperFor(this.yieldWrappers, tokenId, (a, b) =>
            this.swapChainAdapter.isSameToken(a, b),
        );
        const swapInputToken = wrapper ? wrapper.underlying : tokenId;
        if (wrapper) {
            await assertZapApproved(
                this.swapChainAdapter,
                relaySwapsAddress,
                tokenId,
                wrapper,
            );
        }
        const netSwapAmount = wrapper ? await previewRedeemNet(wrapper, netShares) : netShares;

        // 2. DEX swap quote for estimated output
        const swapEstimate = await this.swapQuoteProvider.getSwapQuote({
            fromChainId: relayerInfo.chainId,
            toChainId: relayerInfo.chainId,
            fromToken: swapInputToken,
            toToken: swapOutputToken,
            fromAddress: relaySwapsAddress,
            amount: netSwapAmount.toString(),
            amountType: "from",
            slippage,
        });

        this.assertSwapQuoteMatchesRequest(swapEstimate, {
            fromToken: swapInputToken,
            toToken: swapOutputToken,
            fromChainId: relayerInfo.chainId,
            toChainId: relayerInfo.chainId,
        });

        // 3. Work backwards from estimated min output to get note value.
        //    Apply 1% safety buffer: contractCalls quotes may need more input
        //    than simple swap quotes for the same output (different routing/fees).
        const estimatedMinOutput = BigInt(swapEstimate.toAmountMin);
        const bps = BigInt(outputConfig.vettingFeeBPS);
        const sizeFor = async (budget: bigint) => {
            const noteValue = yieldTarget
                ? (await yieldTarget.sizeSharesForBudget(budget)).shares
                : (budget * 10000n) / (10000n + bps);
            // A share target pays its vetting fee in shares inside the sizing, so no
            // funding-token figure exists to report; the plain path reports the Entrypoint fee.
            const vettingFee = yieldTarget ? 0n : (noteValue * bps) / 10000n;
            const totalDepositCost = yieldTarget ? budget : noteValue + vettingFee;
            return { noteValue, vettingFee, totalDepositCost };
        };
        let sized = await sizeFor((estimatedMinOutput * 99n) / 100n);

        // 4. When prepare will build the route through the swap executor, the plain quote above
        //    only seeds the size: the input the transaction really pulls is the composed
        //    exact-output swap's `fromAmount` for `totalDepositCost`. Ask that same question and
        //    rescale until it fits the net budget (and its dust tolerance), so prepare's
        //    assertLifiBudget holds for the same inputs.
        if (this.composesExecutorRoute(swapInputToken, swapOutputToken)) {
            sized = await this.fitDepositToExecutorRoute({
                netSwapAmount,
                swapInputToken,
                swapOutputToken,
                relaySwapsAddress,
                initial: sized,
                initialBudget: (estimatedMinOutput * 99n) / 100n,
                sizeFor,
            });
        }
        const { noteValue, vettingFee, totalDepositCost } = sized;

        if (noteValue < BigInt(outputConfig.minAmount)) {
            throw new DepositBelowMinimum(
                noteValue.toString(),
                BigInt(outputConfig.minAmount).toString(),
            );
        }

        return {
            feeAmount: prelimQuote.feeAmount,
            netSwapAmount: netSwapAmount.toString(),
            estimatedOutput: swapEstimate.toAmount,
            estimatedMinOutput: swapEstimate.toAmountMin,
            noteValue: `0x${noteValue.toString(16)}` as Hex,
            vettingFee: vettingFee.toString(),
            totalDepositCost: totalDepositCost.toString(),
            swapInputToken,
        };
    }

    /**
     * @inheritdoc IPoolSessionReshield.prepareReshieldQuote
     * @throws {InvalidTransactParams} When swapAndDepositQuoteProvider is not configured, params are inconsistent, or the signed routing diverges.
     * @throws {DepositTargetMismatch} When depositResult.depositTx.to is not the session Entrypoint.
     * @throws {AssetNotSupported} When the output token is not enabled on the Entrypoint.
     * @throws {DepositBelowMinimum} When the deposit note value is below the Entrypoint minimum.
     * @throws {RelayFeeExceedsMax} When the relayer fee exceeds the Entrypoint maxRelayFee.
     * @throws {SwapQuoteMismatch} When the aggregator quote routes different tokens/chains than requested.
     * @throws {DustRescueRecipientConflict} When an explicit dustRecipient conflicts with a dustRescue opt-in.
     * @throws {LiFiDepositCalldataNotFound} If the deposit proof calldata is not found verbatim in transactionData.
     * @throws {LiFiDepositTargetNotFound} If the Entrypoint address is not found in transactionData.
     */
    async prepareReshieldQuote(
        params: PrepareReshieldQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldQuote<TAddress>> {
        const relaySwapsAddress = this.requireRelaySwapsAddress();

        const {
            relayerInfo,
            amount,
            tokenId,
            outputToken,
            depositResult,
            totalDepositCost,
            dustRecipient,
            slippage,
            dustRescue,
        } = params;
        const yieldTarget = this.yieldTargetFor(outputToken);
        const swapOutputToken = yieldTarget ? yieldTarget.fundingToken : outputToken;
        const routingOutputToken = swapOutputToken;

        const effectiveDustRecipient = dustRecipient ?? relayerInfo.address;
        // The relayer must hold the swept leftover itself to fund the rescue deposit —
        // an explicit dustRecipient that isn't the relayer's own address while also
        // requesting a rescue is a contradictory request. Mirrors
        // PoolSessionReshieldCrosschain's identical guard.
        if (
            dustRescue &&
            !this.addressEqualityComparator.equals(effectiveDustRecipient, relayerInfo.address)
        ) {
            throw new DustRescueRecipientConflict(
                String(effectiveDustRecipient),
                String(relayerInfo.address),
            );
        }

        // Pre-flight 1: the deposit must target the session's Entrypoint — the target
        // is proof-bound via the aggregator calldata, so a wrong address is unrecoverable.
        const entrypointAddress = this.entrypointInteractor.getAddress();
        const routerTarget =
            yieldTarget &&
            this.addressEqualityComparator.equals(depositResult.depositTx.to, yieldTarget.router)
                ? yieldTarget
                : undefined;
        if (
            !this.addressEqualityComparator.equals(depositResult.depositTx.to, entrypointAddress) &&
            !routerTarget
        ) {
            throw new DepositTargetMismatch(String(depositResult.depositTx.to), String(entrypointAddress));
        }

        // Pre-flight 2: the deposited token must be accepted by the Entrypoint,
        // the note must clear the minimum, and totalDepositCost must match the
        // on-chain vetting fee — otherwise Entrypoint.deposit reverts inside the aggregator call.
        const [outputConfig, inputConfig] = await Promise.all([
            this.entrypointInteractor.getAssetConfig(outputToken),
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

        // Yield share input: the processor redeems the shares into the wrapper's underlying
        // before the swap, so the aggregator is quoted on the UNDERLYING while the relayer
        // fee and the proof-bound note stay share-denominated. `netUnderlyingFor(feeShares)`
        // maps a fee-adjusted net (shares) to what it redeems to; the identity for a plain
        // note.
        const wrapper = yieldWrapperFor(this.yieldWrappers, tokenId, (a, b) =>
            this.swapChainAdapter.isSameToken(a, b),
        );
        const swapInputToken = wrapper ? wrapper.underlying : tokenId;
        if (wrapper) {
            await assertZapApproved(
                this.swapChainAdapter,
                relaySwapsAddress,
                tokenId,
                wrapper,
            );
        }
        const netUnderlyingFor = async (feeShares: bigint): Promise<bigint> => {
            const net = BigInt(amount) - feeShares;
            return wrapper ? previewRedeemNet(wrapper, net) : net;
        };

        // A plain native-coin Entrypoint.deposit{value} needs msg.value to equal its cost
        // exactly. A contract-calls quote never sends that: LiFi's Executor forwards the route's
        // guaranteed delivery as the call's value, so LiFi's own simulation of the deposit
        // reverts (Entrypoint_InvalidETHAmount) and it refuses every amount with 422/1004
        // "Step simulation failed". Skip the aggregator's contract-calls leg and compose the
        // executor transaction ourselves (exact-out swap, then the deposit handed exactly its
        // value), as same-chain prepareSwapAndDeposit already does. The native-mode yield
        // router is exempt: msg.value is a cap there and the surplus is refunded.
        const nativeEntrypointDeposit =
            !routerTarget &&
            !!this.nativeAssetAddress &&
            this.swapChainAdapter.isSameToken(swapOutputToken, this.nativeAssetAddress);
        if (nativeEntrypointDeposit && (!this.swapExecutor || !this.swapQuoteProvider)) {
            throw new NativeSwapDepositUnavailable(
                String(outputToken),
                BigInt(totalDepositCost).toString(),
                `no swap executor is configured for chain ${this.chainId}`,
            );
        }
        const nativeDepositValue = BigInt((depositResult.depositTx as { value?: Hex | null }).value ?? "0x0");
        if (nativeEntrypointDeposit && nativeDepositValue !== BigInt(totalDepositCost)) {
            // The Entrypoint reverts unless msg.value is exactly the validated cost.
            throw new InvalidTransactParams(
                `native deposit value ${nativeDepositValue} does not match totalDepositCost ${BigInt(totalDepositCost)}`,
            );
        }
        if (!nativeEntrypointDeposit && !this.swapAndDepositQuoteProvider) {
            throw new InvalidTransactParams(
                "swapAndDepositQuoteProvider must be configured to use prepareReshieldQuote()",
            );
        }

        // The preliminary relayer fee (no commitment) prices the net swap budget. Fetched once,
        // when first needed: by the executor fallback below or the budget check in step 2.
        let prelimQuotePromise: ReturnType<IRelayerInteractor<TAddress>["getSwapQuote"]> | undefined;
        const prelimQuoteOnce = () =>
            (prelimQuotePromise ??= this.relayerInteractor.getSwapQuote(relayerInfo, {
                asset: tokenId,
                amount: BigInt(amount).toString(),
                outputToken: routingOutputToken,
                recipient: this.emptyAddress, // no source-chain recipient — output re-deposits via contractCalls
                minOutputAmount: "0",
                dustRecipient: effectiveDustRecipient,
                commit: false,
            }));
        const composeArgs = {
            swapInputToken,
            swapOutputToken,
            depositTo: depositResult.depositTx.to,
            depositData: depositResult.depositTx.data,
            depositValue: nativeDepositValue,
            totalDepositCost: BigInt(totalDepositCost),
            relaySwapsAddress,
        };
        const canCompose = this.composesExecutorRoute(swapInputToken, swapOutputToken);

        // 1. Get aggregator contractCalls quote (swap + deposit atomically)
        const nativeComposed = nativeEntrypointDeposit
            ? await this.composeExecutorQuote(undefined, composeArgs)
            : undefined;
        let executorCall: ReshieldExecutorCall | undefined = nativeComposed?.executorCall;
        let lifiQuote: SwapAndDepositQuoteResult<TAddress>;
        if (nativeComposed) {
            lifiQuote = nativeComposed.quote;
        } else {
            try {
                lifiQuote = await this.swapAndDepositQuoteProvider!.getSwapAndDepositQuote({
                    fromChainId: relayerInfo.chainId,
                    toChainId: relayerInfo.chainId,
                    fromToken: swapInputToken,
                    toToken: swapOutputToken,
                    fromAddress: relaySwapsAddress,
                    depositAmount: totalDepositCost,
                    depositCalldata: depositResult.depositTx.data,
                    poolAddress: depositResult.depositTx.to,
                    slippage,
                    depositGasLimit: DEPOSIT_CALL_GAS_LIMIT,
                });
            } catch (error) {
                // No contract-calls route (e.g. LiFi 404 "Unable to find quote to match expected
                // output") while the plain exact-output swap exists: the session's own executor
                // composition is the route estimateReshieldAmount sized this deposit against.
                if (!canCompose) throw error;
                this.logger?.info("No contract-calls route; composing the executor swap-then-deposit", {
                    swapInputToken,
                    swapOutputToken,
                    error: error instanceof Error ? error.message : String(error),
                });
                ({ quote: lifiQuote, executorCall } = await this.composeExecutorQuote(undefined, composeArgs));
            }
        }

        this.assertSwapQuoteMatchesRequest(lifiQuote, {
            fromToken: swapInputToken,
            toToken: swapOutputToken,
            fromChainId: relayerInfo.chainId,
            toChainId: relayerInfo.chainId,
        });

        // 1b. The aggregator routes a swap-then-deposit through its own executor, a transaction
        //     the session never signs (the executor runs arbitrary calls). With the executor
        //     configured, throw that quote away whole and compose the call ourselves: an ordinary
        //     swap paid to the executor, then the deposit, leftovers back to RelaySwaps (swept to
        //     the dust recipient by the contract's delta sweep). Unconfigured: refused below.
        if (!executorCall && this.isConfiguredExecutor(lifiQuote.transactionTo)) {
            this.logger?.info("Swap-and-deposit quote targets the swap executor; composing it instead", {
                swapInputToken,
                swapOutputToken,
            });
            ({ quote: lifiQuote, executorCall } = await this.composeExecutorQuote(lifiQuote, composeArgs));
        } else if (!executorCall && canCompose) {
            // 1c. The aggregator's own route would fail assertLifiBudget (input above the net budget,
            //     or leftover above the dust tolerance), while
            //     the estimate sized the deposit against the composed executor route: use that.
            const prelim = await prelimQuoteOnce();
            this.assertFeeWithinBounds(prelim.feeAmount, amount, inputConfig.maxRelayFee);
            const net = await netUnderlyingFor(BigInt(prelim.feeAmount));
            if (lifiBudgetViolation(BigInt(lifiQuote.fromAmount), net)) {
                this.logger?.info("Contract-calls route breaks the net budget or dust tolerance; composing the executor swap-then-deposit", {
                    swapInputToken,
                    swapOutputToken,
                });
                ({ quote: lifiQuote, executorCall } = await this.composeExecutorQuote(lifiQuote, composeArgs));
            }
        }

        await this.swapChainAdapter.assertRoutingLayoutMatches(relaySwapsAddress, this.chainId);
        await this.assertLiFiAddressAllowed(lifiQuote.transactionTo, "transactionTo", relaySwapsAddress);
        await this.assertLiFiAddressAllowed(
            lifiQuote.approvalAddress,
            "approvalAddress",
            relaySwapsAddress,
        );
        this.assertDepositIsEmbeddedInQuote(
            lifiQuote.transactionData,
            depositResult.depositTx.data,
            depositResult.depositTx.to,
        );
        // The embedding check proves nothing once the swap executor (arbitrary calls, on the
        // allowlist) is the target or the spender: it could send the withdrawn funds anywhere.
        // The one executor transaction accepted is our own composition, decoded and pinned.
        if (executorCall) {
            await this.assertComposedExecutorCall(
                {
                    swapTarget: lifiQuote.transactionTo,
                    approvalAddress: lifiQuote.approvalAddress,
                    swapCalldata: lifiQuote.transactionData,
                },
                {
                    swapInputToken,
                    swapOutputToken,
                    relaySwapsAddress,
                    executorCall,
                    call: { target: depositResult.depositTx.to, data: depositResult.depositTx.data },
                },
            );
        } else {
            await assertNoSwapExecutor(this.swapChainAdapter, lifiQuote);
        }

        // 2. Validate the aggregator's fromAmount fits within available budget
        const prelimQuote = await prelimQuoteOnce();
        this.assertFeeWithinBounds(prelimQuote.feeAmount, amount, inputConfig.maxRelayFee);
        // In underlying units for a yield share (`netUnderlyingFor` is `amount − fee` for a
        // plain note, so this is unchanged there).
        assertLifiBudget(
            lifiQuote.fromAmount,
            bigintToHex(await netUnderlyingFor(BigInt(prelimQuote.feeAmount))),
            "0",
        );

        // Wait for the keystore + state-tree leaf caches to finish warming BEFORE
        // requesting the committed quote below — that's what starts the relayer's
        // short-lived commitment clock. Usually a no-op; only waits if a scan is
        // still genuinely in flight (same fix as PoolSessionReshieldCrosschain).
        await this.core.warmMerkleCaches();

        // 3. Committed relayer quote with swap details
        const committedQuote = await this.relayerInteractor.getSwapQuote(relayerInfo, {
            asset: tokenId,
            amount: BigInt(amount).toString(),
            outputToken: routingOutputToken,
            recipient: this.emptyAddress, // no source-chain recipient — output re-deposits via contractCalls
            minOutputAmount: "0",
            swapCalldata: lifiQuote.transactionData,
            swapTarget: lifiQuote.transactionTo,
            approvalAddress: lifiQuote.approvalAddress,
            dustRecipient: effectiveDustRecipient,
            commit: true,
            // Bind the dustRescue opt-in into the commitment the relayer signs here, so
            // relayReshield's later relaySwap call (which decodes dustRescue back off this
            // same committed routing) can't diverge from what was actually priced.
            // destinationChainId is this session's own chain — a same-chain reshield has no
            // distinct destination to bridge to (see RelaySwapDustRescue.destinationChainId).
            ...(dustRescue
                ? {
                      dustRescue: {
                          destinationChainId: this.chainId,
                          destinationChainType: relayerInfo.chainType,
                          tokenId: swapOutputToken,
                          recipientIdentifier: dustRescue.recipientIdentifier,
                      },
                  }
                : {}),
        });

        // 4. Validate the relayer-signed routing tuple before returning it —
        //    the relayer could re-quote a different fee or tamper with any
        //    field of the routing blob it signs.
        this.assertFeeWithinBounds(committedQuote.feeAmount, amount, inputConfig.maxRelayFee);
        const committedNetSwapInput = await netUnderlyingFor(BigInt(committedQuote.feeAmount));
        assertLifiBudget(lifiQuote.fromAmount, bigintToHex(committedNetSwapInput), "0");
        this.assertGrossWithdrawal(committedQuote, BigInt(amount));
        const routing = this.swapChainAdapter.decodeSwapRouting(committedQuote.feeCommitment.data);
        this.assertSwapCalldataMatches(routing, lifiQuote.transactionData);
        this.assertReshieldRouting(routing, {
            outputToken: routingOutputToken,
            dustRecipient: effectiveDustRecipient,
            feeAmount: committedQuote.feeAmount,
            swapTarget: lifiQuote.transactionTo,
            approvalAddress: lifiQuote.approvalAddress,
            dustRescue: dustRescue
                ? {
                      destinationChainId: this.chainId,
                      destinationChainType: relayerInfo.chainType,
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
            swapCalldata: lifiQuote.transactionData,
            feeAmount: committedQuote.feeAmount,
            // Net amount the relay side spends into the proof: gross amountSent − fee.
            // Forwarded as relayReshield's `amount` (see PreparedReshieldQuote.netAmount).
            netAmount,
            swapTarget: routing.swapTarget,
            approvalAddress: routing.approvalAddress,
            dustRecipient: effectiveDustRecipient,
            // In swapInputToken units: committed net (redeemed to the underlying for a yield
            // share) minus the fixed LiFi input.
            dustAmount: bigintToHex(committedNetSwapInput - BigInt(lifiQuote.fromAmount)),
            depositNote: depositResult.pendingNote,
            dustRescue,
            swapInputToken,
            ...(executorCall ? { executorCall } : {}),
        };
    }

    /**
     * @inheritdoc IPoolSessionReshield.relayReshield
     * @throws {InvalidTransactParams} When commitment validation fails or the signed routing diverges.
     * @throws {DustRescueRecipientConflict} When an explicit dustRecipient conflicts with a dustRescue opt-in.
     */
    async relayReshield(params: ReshieldParams<TAddress>): Promise<TxReceipt<TLog>> {
        const {
            inputCommitments,
            amount,
            tokenId,
            outputToken,
            swapCalldata,
            selectedQuote,
            dustRecipient,
            depositNote,
            dustRescue,
            executorCall,
        } = params;
        const yieldTarget = this.yieldTargetFor(outputToken);
        const routingOutputToken = yieldTarget ? yieldTarget.fundingToken : outputToken;

        // A relayed reshield executes via `RelaySwaps.execute()`, which calls `PoolVault.transact()`
        // internally — `msg.sender` there is RelaySwaps, not `relayerInfo.processorAddress` (the
        // withdrawal-only relay contract). See PoolSessionWithdrawAndSwap.relayWithdrawAndSwap.
        const transactParams = {
            processor: this.requireRelaySwapsAddress(),
            data: selectedQuote.quote.feeCommitment.data,
        };

        this.assertRelayerChainMatchesPool(selectedQuote.relayerInfo.chainId);

        const effectiveDustRecipient = dustRecipient ?? selectedQuote.relayerInfo.address;
        if (
            dustRescue &&
            !this.addressEqualityComparator.equals(
                effectiveDustRecipient,
                selectedQuote.relayerInfo.address,
            )
        ) {
            throw new DustRescueRecipientConflict(
                String(effectiveDustRecipient),
                String(selectedQuote.relayerInfo.address),
            );
        }

        // Defense-in-depth: this method accepts hand-built params, so re-validate
        // the signed routing tuple even if prepareReshieldQuote already did.
        const routing = this.swapChainAdapter.decodeSwapRouting(selectedQuote.quote.feeCommitment.data);

        this.assertSwapCalldataMatches(routing, swapCalldata);
        // Hand-built or tampered params never went through prepare's quote checks.
        if (this.isConfiguredExecutor(routing.swapTarget)) {
            // Only our own composition is accepted: re-decoded and pinned here too. The deposit
            // calldata is not in these params, so the call is pinned to this session's Entrypoint
            // or the output share's router (the proof itself binds the exact calldata).
            const wrapper = yieldWrapperFor(this.yieldWrappers, tokenId, (a, b) =>
                this.swapChainAdapter.isSameToken(a, b),
            );
            // The input amount and call value are pinned to what prepare composed (echoed in
            // `executorCall`); without it there is nothing to pin, so the call is refused. A plain
            // note's swap can never spend more than the net withdrawn into RelaySwaps.
            if (!executorCall) {
                throw new UnexpectedTransactionTarget(
                    "executor reshield: relay params must echo PreparedReshieldQuote.executorCall",
                );
            }
            if (BigInt(executorCall.callValue) === 0n) {
                throw new UnexpectedTransactionTarget("executor reshield: the deposit call is handed nothing");
            }
            if (!wrapper && BigInt(executorCall.inputAmount) > BigInt(amount)) {
                throw new UnexpectedTransactionTarget(
                    `executor reshield: swap input ${BigInt(executorCall.inputAmount)} exceeds the net withdrawal ${BigInt(amount)}`,
                );
            }
            await this.assertComposedExecutorCall(routing, {
                swapInputToken: wrapper ? wrapper.underlying : tokenId,
                swapOutputToken: routingOutputToken,
                relaySwapsAddress: this.requireRelaySwapsAddress(),
                executorCall,
                call: {
                    targets: [
                        this.entrypointInteractor.getAddress(),
                        ...(yieldTarget ? [yieldTarget.router] : []),
                    ],
                },
            });
        } else {
            await assertNoSwapExecutor(this.swapChainAdapter, {
                transactionTo: routing.swapTarget,
                approvalAddress: routing.approvalAddress,
                transactionData: routing.swapCalldata,
            });
        }

        this.assertAmountSentMatchesAmountPlusFee(
            selectedQuote.quote.feeCommitment.amountSent,
            amount,
            selectedQuote.quote.feeAmount,
        );

        this.assertReshieldRouting(routing, {
            outputToken: routingOutputToken,
            dustRecipient: effectiveDustRecipient,
            feeAmount: selectedQuote.quote.feeAmount,
            swapTarget: params.swapTarget,
            approvalAddress: params.approvalAddress,
            dustRescue: dustRescue
                ? {
                      destinationChainId: this.chainId,
                      destinationChainType: selectedQuote.relayerInfo.chainType,
                      tokenId: routingOutputToken,
                      recipientIdentifier: dustRescue.recipientIdentifier,
                  }
                : undefined,
        });

        // The relayer's signed commitment must be for the withdrawn (input) token, otherwise the
        // proof binds a commitment whose asset differs from the proof's tokenIdOut.
        if (!this.addressEqualityComparator.equals(selectedQuote.quote.feeCommitment.asset, tokenId)) {
            throw new InvalidTransactParams(
                `feeCommitment.asset ${selectedQuote.quote.feeCommitment.asset} does not match withdraw tokenId ${tokenId}`,
            );
        }

        // Fail fast on an already-expired commitment, before the expensive prepareTransact
        // below. The relayer re-checks expiry at submission, so a quote that lapses during
        // proof generation is still rejected — this just avoids burning proof time up front.
        assertFeeCommitmentLive(selectedQuote.quote.feeCommitment.expiration);

        const feeAmount = bigintToHex(BigInt(selectedQuote.quote.feeAmount));
        const amountOut = bigintToHex(BigInt(selectedQuote.quote.feeCommitment.amountSent));

        this.logger?.info("Preparing reshield withdrawal proof", { tokenId, amount });

        const { proof, notesData, changePendingNotes, spentNotes, spentNullifiers } =
            await this.core.prepareTransact({
                inputCommitments,
                amount,
                tokenId,
                recipientAddress: this.emptyAddress, // ignored when transactParams is provided
                relayAddress: selectedQuote.relayerInfo.address,
                feeAmount,
                processorAddress: this.requireRelaySwapsAddress(),
                amountOut,
                transactParams,
            });

        this.logger?.info("Submitting reshield to relayer via relaySwap");

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
     * Returns the configured RelaySwaps address — the on-chain identity that submits
     * `PoolVault.transact()` for a relayed reshield and whose `approvedRouters`/`approvedZaps`
     * allowlists gate the aggregator quote (see {@link PoolSessionReshieldConfig.relaySwapsAddress}).
     *
     * @throws {InvalidTransactParams} If `relaySwapsAddress` was not configured.
     */
    /**
     * Whether this session can build the reshield as its own executor swap-then-deposit, which
     * prepare does for a native-coin output and whenever the aggregator's contract-calls route
     * targets the executor, is refused, or does not fit the net budget.
     */
    private composesExecutorRoute(swapInputToken: TAddress, swapOutputToken: TAddress): boolean {
        return (
            !!this.swapExecutor &&
            !!this.swapQuoteProvider &&
            !!this.nativeAssetAddress &&
            !this.swapChainAdapter.isSameToken(swapInputToken, swapOutputToken)
        );
    }

    /**
     * The input the composed executor swap pulls to deliver `totalDepositCost`: the very
     * exact-output quote {@link composeExecutorQuote} asks at prepare (same tokens, executor,
     * slippage and grossed-up target). Only the deposit call bytes differ, and those never leave
     * the session (they are encoded locally, not sent to the aggregator).
     *
     * @throws {SwapRouteUnavailable} When the aggregator has no route for that output.
     */
    private async executorRouteInput(
        swapInputToken: TAddress,
        swapOutputToken: TAddress,
        totalDepositCost: bigint,
        relaySwapsAddress: TAddress,
    ): Promise<bigint> {
        const provider = this.swapQuoteProvider!;
        const unavailable = (reason: string): SwapRouteUnavailable =>
            new SwapRouteUnavailable(String(swapInputToken), String(swapOutputToken), this.chainId, reason);
        const nativeOutput = this.swapChainAdapter.isSameToken(swapOutputToken, this.nativeAssetAddress!);
        const composed = await composeExecutorSwapThenCall(
            this.executorCallContext(relaySwapsAddress),
            {
                getSwapQuote: async (req) => {
                    try {
                        return await provider.getSwapQuote(req);
                    } catch (error) {
                        throw unavailable(error instanceof Error ? error.message : String(error));
                    }
                },
            } as ISwapQuoteProvider<TAddress>,
            {
                inputToken: swapInputToken,
                outputToken: swapOutputToken,
                callTarget: this.entrypointInteractor.getAddress(),
                callData: "0x" as Hex,
                depositValue: nativeOutput ? totalDepositCost : 0n,
                totalDepositCost,
                receiver: relaySwapsAddress,
            },
            (reason) => {
                throw unavailable(reason);
            },
        );
        return composed.inputAmount;
    }

    /**
     * Rescales a deposit until the composed executor route's input fits the net swap budget,
     * leaving {@link EXECUTOR_ROUTE_HEADROOM_BPS} for the quote to move before prepare, and stays
     * inside the dust tolerance prepare enforces. Each round scales the funding budget by
     * `goal / required` (the route is near-linear at these sizes), so it settles in a round or two.
     *
     * @throws {SwapRouteUnavailable} When the route is refused or no size converges.
     */
    private async fitDepositToExecutorRoute<S extends { totalDepositCost: bigint }>(args: {
        netSwapAmount: bigint;
        swapInputToken: TAddress;
        swapOutputToken: TAddress;
        relaySwapsAddress: TAddress;
        initial: S;
        initialBudget: bigint;
        sizeFor: (budget: bigint) => Promise<S>;
    }): Promise<S> {
        const net = args.netSwapAmount;
        const ceiling = (net * (10_000n - EXECUTOR_ROUTE_HEADROOM_BPS)) / 10_000n;
        const floor = (net * (10_000n - SWAP_DUST_TOLERANCE_BPS)) / 10_000n;
        const goal = (net * (10_000n - EXECUTOR_ROUTE_TARGET_BPS)) / 10_000n;
        let sized = args.initial;
        let budget = args.initialBudget;
        for (let round = 0; round < EXECUTOR_ROUTE_MAX_ROUNDS; round++) {
            const required = await this.executorRouteInput(
                args.swapInputToken,
                args.swapOutputToken,
                sized.totalDepositCost,
                args.relaySwapsAddress,
            );
            if (required <= ceiling && required >= floor) {
                return sized;
            }
            if (required === 0n) break;
            const next = (budget * goal) / required;
            if (next === budget || next === 0n) break;
            budget = next;
            sized = await args.sizeFor(budget);
        }
        throw new SwapRouteUnavailable(
            String(args.swapInputToken),
            String(args.swapOutputToken),
            this.chainId,
            `no deposit size fits the net swap budget ${net} after ${EXECUTOR_ROUTE_MAX_ROUNDS} quotes`,
        );
    }

    /** The configured yield-share deposit target whose share is `outputToken`, if any. */
    private yieldTargetFor(outputToken: TAddress): YieldSwapDepositTarget<TTx, TAddress> | undefined {
        return yieldSwapDepositTargetFor(this.yieldDepositTargets, outputToken, (a, b) =>
            this.swapChainAdapter.isSameToken(a, b),
        );
    }

    /** Whether `address` is this chain's configured swap executor (so: composed, never signed as given). */
    private isConfiguredExecutor(address: TAddress): boolean {
        return !!this.swapExecutor && this.addressEqualityComparator.equals(address, this.swapExecutor.executor);
    }

    /**
     * Replaces an aggregator quote that targets the swap executor with the session's own
     * executor call, built by the shared {@link composeExecutorSwapThenCall}: an ordinary exact-out
     * swap of the input into the token the deposit needs, paid to the executor and used unchanged,
     * then the deposit call handed exactly what it consumes. Leftovers go to RelaySwaps, whose
     * delta sweep sends them to the dust recipient. Nothing from the replaced quote is kept except
     * its echo fields, so nothing the aggregator put in its own executor payload can reach the
     * transaction. Also returns the exact input amount and call value composed, which prepare and
     * relay pin.
     *
     * @throws {InvalidTransactParams} When the session cannot compose (no swap quote provider or
     *   native sentinel), the deposit call's value does not fit its output kind, the swap does
     *   not pay the executor, or its guaranteed output is below what the deposit consumes.
     * @throws {SwapQuoteMismatch} When the swap quote routes different tokens or chains.
     * @throws {UnallowedLiFiAddress} When the swap's target or approval is not allowlisted.
     */
    private async composeExecutorQuote(
        replaced: SwapAndDepositQuoteResult<TAddress> | undefined,
        args: {
            swapInputToken: TAddress;
            swapOutputToken: TAddress;
            depositTo: TAddress;
            depositData: Hex;
            depositValue: bigint;
            totalDepositCost: bigint;
            relaySwapsAddress: TAddress;
        },
    ): Promise<{ quote: SwapAndDepositQuoteResult<TAddress>; executorCall: ReshieldExecutorCall }> {
        const executor = this.swapExecutor!;
        const refuse = (reason: string): never => {
            throw new InvalidTransactParams(`cannot compose the executor swap-and-deposit: ${reason}`);
        };
        if (!this.swapQuoteProvider || !this.nativeAssetAddress) {
            return refuse("no swap quote provider or native sentinel configured");
        }
        const composed = await composeExecutorSwapThenCall(
            this.executorCallContext(args.relaySwapsAddress),
            this.swapQuoteProvider,
            {
                inputToken: args.swapInputToken,
                outputToken: args.swapOutputToken,
                callTarget: args.depositTo,
                callData: args.depositData,
                depositValue: args.depositValue,
                totalDepositCost: args.totalDepositCost,
                receiver: args.relaySwapsAddress,
            },
            refuse,
        );
        return {
            quote: {
                ...replaced,
                fromTokenAddress: replaced?.fromTokenAddress ?? composed.quote.fromTokenAddress,
                toTokenAddress: replaced?.toTokenAddress ?? composed.quote.toTokenAddress,
                fromChainId: replaced?.fromChainId ?? composed.quote.fromChainId,
                toChainId: replaced?.toChainId ?? composed.quote.toChainId,
                fromAmount: composed.quote.fromAmount,
                toAmount: composed.quote.toAmount,
                transactionTo: executor.executor,
                approvalAddress: executor.erc20Proxy,
                transactionData: composed.transactionData,
                transactionValue: "0x0" as Hex,
                estimatedDuration: composed.quote.estimatedDuration,
            },
            executorCall: {
                inputAmount: bigintToHex(composed.inputAmount),
                callValue: bigintToHex(composed.callValue),
            },
        };
    }

    /**
     * The one executor transaction a reshield accepts: this session's own composition, checked by
     * the shared {@link assertExecutorCallMatches} with every field pinned: RelaySwaps as receiver,
     * the swap input and output tokens, and the exact input amount and call value composed at
     * prepare. Run at prepare (against the exact deposit) and at relay (against the session's
     * deposit targets, the proof binding the calldata), since relay params may be hand-built.
     * The transaction's own value is not checked here: RelaySwaps submits the call.
     *
     * @throws {UnexpectedTransactionTarget} When any decoded argument differs.
     * @throws {UnallowedLiFiAddress} When the swap leg's target or approval is not allowlisted.
     */
    private async assertComposedExecutorCall(
        tx: { swapTarget: TAddress; approvalAddress: TAddress; swapCalldata: Hex },
        expected: {
            swapInputToken: TAddress;
            swapOutputToken: TAddress;
            relaySwapsAddress: TAddress;
            executorCall: ReshieldExecutorCall;
            call: { target: TAddress; data: Hex } | { targets: TAddress[] };
        },
    ): Promise<void> {
        await assertExecutorCallMatches(
            this.executorCallContext(expected.relaySwapsAddress),
            {
                transactionTo: tx.swapTarget,
                approvalAddress: tx.approvalAddress,
                transactionData: tx.swapCalldata,
            },
            {
                receiver: expected.relaySwapsAddress,
                inputToken: expected.swapInputToken,
                inputAmount: BigInt(expected.executorCall.inputAmount),
                outputToken: expected.swapOutputToken,
                call: expected.call,
                callValue: BigInt(expected.executorCall.callValue),
            },
        );
    }

    /** The shared executor-call context, vetting against `relaySwapsAddress`'s allowlist. */
    private executorCallContext(relaySwapsAddress: TAddress): ExecutorCallContext<TTx, TAddress> {
        return {
            swapChainAdapter: this.swapChainAdapter,
            addressEqualityComparator: this.addressEqualityComparator,
            executor: this.swapExecutor!,
            nativeAssetAddress: this.nativeAssetAddress!,
            chainId: this.chainId,
            assertAllowed: (address, role) => this.assertLiFiAddressAllowed(address, role, relaySwapsAddress),
        };
    }

    private requireRelaySwapsAddress(): TAddress {
        if (!this.relaySwapsAddress) {
            throw new InvalidTransactParams("relaySwapsAddress must be configured to use reshield");
        }
        return this.relaySwapsAddress;
    }

    /**
     * Asserts the given aggregator quote address is approved in RelaySwaps.approvedRouters.
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
     * and the Entrypoint address verbatim at the raw byte level.
     *
     * A compromised quote source could return a `transactionData` that routes the swap
     * output to an attacker instead of calling `Entrypoint.deposit()`. This check runs
     * before the quote is committed with the relayer (and before proof generation), so
     * any manipulation is caught before value is irreversibly committed.
     *
     * @throws {LiFiDepositCalldataNotFound} If the deposit calldata is absent from the transaction blob.
     * @throws {LiFiDepositTargetNotFound} If the Entrypoint address is absent.
     */
    private assertDepositIsEmbeddedInQuote(
        lifiTransactionData: Hex,
        depositCallData: Hex,
        depositTargetAddress: TAddress,
    ): void {
        assertDepositCalldataEmbedded(lifiTransactionData, depositCallData, this.chainId);
        if (!this.swapChainAdapter.isAddressEmbeddedInCalldata(lifiTransactionData, depositTargetAddress)) {
            throw new LiFiDepositTargetNotFound(String(depositTargetAddress), this.chainId);
        }
    }

    /**
     * Asserts the relayer operates on the same chain as the pool.
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
     * Asserts the relayer-signed `amountSent` equals the caller's intended gross
     * withdrawal (the original, quote-independent `amount` passed to
     * `prepareReshieldQuote`) — preventing a relayer from inflating the pool
     * outflow and skimming the difference. `assertAmountSentMatchesAmountPlusFee`
     * (re-checked in `relayReshield`) only reconstitutes gross from `netAmount`,
     * which is itself derived from this same `amountSent` — it cannot anchor
     * `amountSent` to anything the relayer doesn't control, so this check against
     * the caller's own request is the one that actually does.
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
     * caller's swap calldata — so the relayer cannot substitute calldata that
     * redirects the swap output before the proof commits.
     *
     * @throws {InvalidTransactParams} If the calldata diverges.
     */
    private assertSwapCalldataMatches(routing: SwapRouting<TAddress>, swapCalldata: Hex): void {
        if (routing.swapCalldata.toLowerCase() !== swapCalldata.toLowerCase()) {
            throw new InvalidTransactParams(
                `Relayer swapCommitment swapCalldata ${routing.swapCalldata} does not match caller swapCalldata ${swapCalldata}`,
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
     * Runs before the calldata is proof-bound.
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
     * Asserts every reshield invariant on the relayer-signed routing tuple:
     * empty-address recipient sentinel, zero minOutputAmount/nativeGas, the
     * outputToken/dustRecipient/feeAmount (plus swapTarget/approvalAddress
     * when a swap quote is in scope) the caller expects, and the dustRescue
     * opt-in (or its all-zero absence).
     *
     * @throws {InvalidTransactParams} If any field diverges.
     */
    private assertReshieldRouting(
        routing: SwapRouting<TAddress>,
        expected: {
            outputToken: TAddress;
            dustRecipient: TAddress;
            feeAmount: string;
            swapTarget?: TAddress;
            approvalAddress?: TAddress;
            dustRescue?: RelaySwapDustRescue<TAddress>;
        },
    ): void {
        if (!this.addressEqualityComparator.equals(routing.recipient, this.emptyAddress)) {
            throw new InvalidTransactParams(
                `Reshield routing recipient ${routing.recipient} must be the empty-address sentinel`,
            );
        }
        if (routing.minOutputAmount !== 0n) {
            throw new InvalidTransactParams(
                `Reshield routing minOutputAmount ${routing.minOutputAmount} must be 0`,
            );
        }
        if (routing.nativeGas !== 0n) {
            throw new InvalidTransactParams(
                `Reshield routing nativeGas ${routing.nativeGas} must be 0`,
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
        // L-2: feeRecipient is the one routing field the field-by-field check omitted. A
        // nonzero fee to the empty-address sentinel would burn the fee (the contract reverts
        // RelaySwaps_ZeroFeeRecipient at step 9) — reject it before the ~30-60s proof.
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
        // Same field-by-field dustRescue validation as PoolSessionReshieldCrosschain's
        // assertReshieldCrosschainRouting — absence must decode to the all-zero sentinel
        // (chainId 0n), presence must match every sub-field exactly.
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
    }
}
