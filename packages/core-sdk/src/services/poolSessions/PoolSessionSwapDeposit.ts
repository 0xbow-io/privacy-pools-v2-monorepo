import type {
    Address,
    Hex,
    IAddressEqualityComparator,
    IEntrypointInteractor,
    ILogger,
    INoteManager,
    IPoolSessionDeposit,
    IPoolSessionSwapDeposit,
    IPoolVaultInteractor,
    ISwapAndDepositQuoteProvider,
    ISwapChainAdapter,
    ISwapQuoteProvider,
    ITxReceiptWaiter,
    PendingNote,
    PoolSessionSwapDepositConfig,
    PoolSessionSwapDepositDependencies,
    PrepareDepositResult,
    PreparedTransaction,
    PrepareSwapAndDepositResult,
    SwapAndDepositParams,
    SwapAndDepositQuoteResult,
    SwapDepositSourceChainConfig,
    ExecutorCallContext,
    SwapExecutorAddresses,
    TxReceipt,
    YieldSwapDepositTarget,
} from "../../internal.js";
import {
    assertDepositCalldataEmbedded,
    assertExecutorCallMatches,
    assertNoSwapExecutor,
    bigintToHex,
    composeExecutorSwapThenCall,
    CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
    CROSS_CHAIN_DESTINATION_GAS_LIMIT,
    DestinationDepositUnaffordable,
    InvalidPoolSessionConfig,
    InvalidSwapAndDepositParams,
    LiFiDepositTargetNotFound,
    makeSwapAndDepositParamsSchema,
    NativeDestinationDepositUnsupported,
    NativeSwapDepositUnavailable,
    NoteStatus,
    PoolSessionSwapDepositBaseError,
    resolveCommitmentTimestamp,
    SwapQuoteMismatch,
    UnallowedLiFiAddress,
    UnexpectedTransactionTarget,
    yieldSwapDepositTargetFor,
} from "../../internal.js";

/**
 * Orchestrates the swap-and-deposit flow, generic over the chain's prepared-transaction type
 * `TTx` (constrained to a `{to, data}` contract-call shape — the reshield/swap-deposit protocol
 * is inherently "call this contract with this calldata") and address type `TAddress`.
 *
 * Swaps token X into token Y externally (via a DEX aggregator), then deposits token Y
 * into the privacy pool atomically. The deposit proof is generated first
 * (locking the exact deposit amount), then the aggregator's contract-calls quote
 * wraps the swap + deposit into a single transaction.
 *
 * Every operation that varies by chain (decoding/checking the router allowlist, verifying a
 * deposit target is embedded in aggregator calldata, building/parsing a token-approval
 * transaction) is delegated to the injected `swapChainAdapter` ({@link ISwapChainAdapter}).
 */
/**
 * Margin kept under the route's guaranteed delivery in the `DestinationDepositUnaffordable`
 * refit value, so the caller's re-prepare (a fresh quote, a fresh guarantee) does not trip the
 * check again. Same figure as the cross-chain reshield.
 */
const DESTINATION_GUARANTEE_MARGIN_BPS = 100n;

/**
 * How far the shares an executor router budget buys at execute may exceed the note's shares: the
 * router's rate moves between prepare and execute, a budget inflated past this is refused.
 */
const ROUTER_BUDGET_SHARE_TOLERANCE_BPS = 50n;

/** Decimal wei string for the aggregator's fromAmount; a non-positive budget is a caller bug. */
function crossChainInputBudget(inputAmount: Hex): string {
    const value = BigInt(inputAmount);
    if (value <= 0n) {
        throw new InvalidSwapAndDepositParams(
            `inputAmount must be positive for a cross-chain swap-and-deposit, got ${inputAmount}`,
        );
    }
    return value.toString();
}

export class PoolSessionSwapDeposit<
    TTx extends { to: TAddress; data: Hex; value: Hex },
    TAddress = Address,
> implements IPoolSessionSwapDeposit<TTx, TAddress>
{
    private readonly yieldDepositTargets: YieldSwapDepositTarget<TTx, TAddress>[];
    private readonly ownerAddress: TAddress;
    private readonly chainId: number;
    private readonly depositDelegate: IPoolSessionDeposit<TTx, TAddress>;
    private readonly swapAndDepositQuoteProvider: ISwapAndDepositQuoteProvider<TAddress>;
    private readonly swapQuoteProvider?: ISwapQuoteProvider<TAddress>;
    private readonly swapExecutor?: SwapExecutorAddresses<TAddress>;
    private readonly entrypointInteractor: IEntrypointInteractor<TTx, TAddress>;
    private readonly rpcInteractor: ITxReceiptWaiter;
    private readonly noteManager: INoteManager<TAddress>;
    private readonly poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress>;
    private readonly relaySwapsAddress: TAddress;
    private readonly nativeAssetAddress: TAddress;
    private readonly emptyAddress: TAddress;
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
    private readonly sourceChain?: SwapDepositSourceChainConfig<TTx, TAddress>;
    private readonly logger?: ILogger;
    private readonly swapAndDepositParamsSchema: ReturnType<
        typeof makeSwapAndDepositParamsSchema<TAddress>
    >;

    constructor(
        config: PoolSessionSwapDepositConfig<TTx, TAddress>,
        deps?: PoolSessionSwapDepositDependencies,
    ) {
        this.ownerAddress = config.ownerAddress;
        this.yieldDepositTargets = config.yieldDepositTargets ?? [];
        for (const target of this.yieldDepositTargets) {
            if (target.chainId !== config.chainId) {
                throw new InvalidPoolSessionConfig(
                    `yield deposit target ${String(target.shareToken)} is bound to chain ${target.chainId}; this session is chain ${config.chainId}`,
                );
            }
        }
        this.chainId = config.chainId;
        this.depositDelegate = config.depositDelegate;
        this.swapAndDepositQuoteProvider = config.swapAndDepositQuoteProvider;
        this.swapQuoteProvider = config.swapQuoteProvider;
        this.swapExecutor = config.swapExecutor;
        this.entrypointInteractor = config.entrypointInteractor;
        this.rpcInteractor = config.rpcInteractor;
        this.noteManager = config.noteManager;
        this.poolVaultInteractor = config.poolVaultInteractor;
        this.relaySwapsAddress = config.relaySwapsAddress;
        this.nativeAssetAddress = config.nativeAssetAddress;
        this.emptyAddress = config.emptyAddress;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.swapChainAdapter = config.swapChainAdapter;
        this.sourceChain = config.sourceChain;
        this.logger = deps?.logger;
        this.swapAndDepositParamsSchema = makeSwapAndDepositParamsSchema(config.addressSchema);
    }

    /**
     * @inheritdoc IPoolSessionSwapDeposit.prepareSwapAndDeposit
     * @throws {InvalidSwapAndDepositParams} When params fail validation.
     * @throws {SwapAndDepositQuoteFailed} When the aggregator contract-calls quote fails.
     * @throws {UnallowedLiFiAddress} If transactionTo or approvalAddress is not in RelaySwaps.approvedRouters.
     * @throws {LiFiDepositCalldataNotFound} If the deposit proof calldata is not found verbatim in transactionData.
     * @throws {LiFiDepositTargetNotFound} If the Entrypoint address is not found in transactionData.
     * @throws {DestinationDepositUnaffordable} When the cross-chain deposit cost exceeds the bridge's guaranteed delivery (retry with the carried `affordableNoteValue` as depositAmount).
     * @throws {NativeDestinationDepositUnsupported} When a cross-chain deposit targets the plain native coin.
     * @throws {NativeSwapDepositUnavailable} When a same-chain native deposit cannot be composed as one executor transaction.
     */
    async prepareSwapAndDeposit(
        params: SwapAndDepositParams<TAddress>,
    ): Promise<PrepareSwapAndDepositResult<TTx, TAddress>> {
        const validated = this.swapAndDepositParamsSchema.safeParse(params);
        if (!validated.success) {
            throw new InvalidSwapAndDepositParams(validated.error.issues[0].message);
        }

        const { fromChainId, inputToken, depositToken, depositAmount, inputAmount, recipient } =
            params;

        // An explicit zero fallbackAddress would tell the aggregator to send bridged tokens to
        // the burn address if the destination deposit cannot execute — permanent loss. Reject
        // it; omitting the field defaults to ownerAddress (a recoverable destination).
        if (
            params.fallbackAddress !== undefined &&
            this.addressEqualityComparator.equals(params.fallbackAddress, this.emptyAddress)
        ) {
            throw new InvalidSwapAndDepositParams(
                "fallbackAddress must not be the empty-address sentinel (bridged funds would be unrecoverable on a failed destination deposit); omit it to default to the owner address",
            );
        }

        const isCrossChain = fromChainId !== this.chainId;
        if (isCrossChain && this.sourceChain?.chainId !== fromChainId) {
            throw new InvalidSwapAndDepositParams(
                `Cross-chain swap-and-deposit requires a sourceChain config matching ` +
                    `fromChainId ${fromChainId} (pool chainId ${this.chainId}` +
                    (this.sourceChain
                        ? `, configured sourceChain ${this.sourceChain.chainId}`
                        : `, no sourceChain configured`) +
                    `). Set fromChainId to the pool chain for same-chain swaps.`,
            );
        }

        this.logger?.info("Preparing swap-and-deposit", {
            fromChainId,
            inputToken,
            depositToken,
            depositAmount,
        });

        // A share output is funded with the share's underlying (or native coin): the aggregator
        // delivers that to the router, and `depositAmount` is that budget, not a share count.
        const yieldTarget = this.yieldTargetFor(depositToken);
        const swapOutputToken = yieldTarget ? yieldTarget.fundingToken : depositToken;
        // With a recipient the embedded proof is THEIR depositFor (same forms prepareDepositFor
        // takes), so the note is unowned and executeSwapAndDeposit never persists it here.
        // Everything after this point (the quote, or the same-chain native Executor composition,
        // embedding checks, approvals) is identical: the calldata differs only in the commitment
        // and noteData the proof binds.
        const depositResult = yieldTarget
            ? await yieldTarget.prepareSwapDeposit(
                  BigInt(depositAmount),
                  isCrossChain ? CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM : undefined,
                  recipient,
              )
            : recipient
              ? await this.depositDelegate.prepareDepositFor({
                    // Recipient first: a stray tokenId/value on it must never override the
                    // deposit this swap is quoted and checked for.
                    ...recipient,
                    tokenId: depositToken,
                    value: depositAmount,
                })
              : await this.depositDelegate.prepareDeposit({
                    tokenId: depositToken,
                    value: depositAmount,
                });
        // A recipient deposit must never come back owned (it would be persisted as the payer's).
        if (recipient && depositResult.pendingNote.isOwned) {
            throw new InvalidSwapAndDepositParams(
                "a deposit prepared for a recipient came back owned by this session",
            );
        }

        // The Entrypoint pulls `value + vettingFee` from its caller (fee on top of the
        // note value — see Entrypoint.deposit), so the aggregator must deliver and approve the
        // TOTAL cost, not just the note value. Quoting the bare depositAmount leaves the
        // executor short by the fee and the embedded deposit call reverts on transferFrom.
        const assetConfig = await this.entrypointInteractor.getAssetConfig(depositToken);
        const vettingFeeBPS = BigInt(assetConfig.vettingFeeBPS);
        const depositValue = BigInt(depositAmount);
        const totalDepositCost = yieldTarget
            ? depositValue
            : depositValue + (depositValue * vettingFeeBPS) / 10_000n;

        // A native Entrypoint.deposit{value} needs msg.value to equal its cost exactly, and a
        // contract-calls quote never sends that: LiFi's Executor forwards the route's guaranteed
        // delivery instead (see `decodeLiFiDestinationCallAmount`), and LiFi now refuses to quote
        // the call at all because it simulates it with that value. Cross-chain the amount rides
        // in the bridge message, so refuse before any network call. Same-chain, compose the
        // executor transaction ourselves. The native-mode yield router is exempt: msg.value is
        // a cap there and the surplus is refunded.
        const isNativeEntrypointDeposit =
            !yieldTarget && this.addressEqualityComparator.equals(depositToken, this.nativeAssetAddress);
        if (isNativeEntrypointDeposit && isCrossChain) {
            throw new NativeDestinationDepositUnsupported(
                String(depositToken),
                totalDepositCost.toString(),
            );
        }
        if (isNativeEntrypointDeposit) {
            return this.prepareExecutorSwapDeposit({
                inputToken,
                depositToken,
                outputToken: this.nativeAssetAddress,
                depositResult,
                totalDepositCost,
            });
        }

        const quoteResult = await this.swapAndDepositQuoteProvider.getSwapAndDepositQuote({
            fromChainId,
            toChainId: this.chainId,
            fromToken: inputToken,
            toToken: swapOutputToken,
            fromAddress: this.ownerAddress,
            depositAmount: totalDepositCost.toString(),
            depositCalldata: depositResult.depositTx.data,
            poolAddress: depositResult.depositTx.to,
            // Cross-chain: if the destination deposit cannot execute, the aggregator delivers
            // the bridged tokens here instead. The user's own EOA exists on the destination,
            // so it is the natural default (unlike the relayer-mediated reshield flow).
            ...(isCrossChain
                ? {
                      fallbackAddress: params.fallbackAddress ?? this.ownerAddress,
                      // The destination leg is a LayerZero compose that runs
                      // Entrypoint.deposit — a Groth16 verification plus a tree
                      // insert, 542k gas measured on Optimism (tx 0x4875629c…).
                      // The aggregator's default budget is 300k, so every cross-chain
                      // deposit reverted out of gas and the receiver recovered
                      // the bridged funds to the wallet instead (status DONE/PARTIAL).
                      // One flat budget for every destination call, see
                      // CrossChainDestinationGas.ts.
                      depositGasLimit: CROSS_CHAIN_DESTINATION_GAS_LIMIT,
                      // fromAmount mode when the caller states its budget: the aggregator
                      // routes the whole input, feeds depositAmount into the call,
                      // surplus goes to fallbackAddress. Exact-out (toAmount) is
                      // unsolvable through a bridge at small sizes (404 code 1003
                      // for 2.4 USDC; fine from ~25 USDC), while fromAmount routes
                      // the same 0.001 ETH cleanly. Mirrors the cross-chain reshield.
                      ...(inputAmount !== undefined
                          ? { netFromAmount: crossChainInputBudget(inputAmount) }
                          : {}),
                  }
                : {}),
        });

        // A same-chain contract-calls quote that targets the swap executor (the aggregator's answer
        // for a native-coin input) is the aggregator's own executor call, in a layout the session
        // will not sign: the executor runs arbitrary calls. Rebuild it as the session's own
        // composition, which pins every argument, instead of refusing a route that exists.
        if (
            !isCrossChain &&
            this.swapExecutor &&
            this.addressEqualityComparator.equals(quoteResult.transactionTo, this.swapExecutor.executor)
        ) {
            this.logger?.info("Contract-calls quote targets the swap executor; composing it instead", {
                inputToken,
                depositToken,
            });
            return this.prepareExecutorSwapDeposit({
                inputToken,
                depositToken,
                outputToken: swapOutputToken,
                depositResult,
                totalDepositCost,
            });
        }

        // Verify the aggregator actually routed the chains and tokens we asked for. The response
        // echoes them back; without this check a buggy or compromised quote could route
        // the deposit to a different chain — and because this protocol deploys the same
        // Entrypoint address on every chain and the deposit calldata carries no chain
        // binding, that wrong-chain deposit would land in a live but unintended pool the
        // session can never scan. Mirrors PoolSessionReshieldCrosschain.assertSwapQuoteMatchesRequest.
        this.assertQuoteRoutedAsRequested(quoteResult, {
            fromToken: inputToken,
            toToken: swapOutputToken,
            fromChainId,
            toChainId: this.chainId,
        });

        await this.assertSwapTxTrusted(
            {
                transactionTo: quoteResult.transactionTo,
                approvalAddress: quoteResult.approvalAddress,
                transactionData: quoteResult.transactionData,
                depositCallData: depositResult.depositTx.data,
                depositTarget: depositResult.depositTx.to,
                pendingNote: depositResult.pendingNote,
                depositMsgValue: depositResult.depositTx.value,
                inputToken,
                estimatedInputAmount: bigintToHex(BigInt(quoteResult.fromAmount)),
                msgValue: quoteResult.transactionValue,
            },
            isCrossChain,
        );

        // Destination affordability (Stargate routes): the aggregator caps the destination
        // contract-call's budget at the bridge's guaranteed delivery (minAmountLD). A
        // deposit costing more can NEVER execute on arrival — the destination executor's
        // call fails and the RAW bridged tokens go to fallbackAddress instead of a
        // shielded note (verified on a mainnet fork against real calldata, 2026-08-31,
        // in the reshield flow — same underlying bridge machinery). Across routes decode to
        // undefined and pass through: no native fee, no such cap observed.
        // Mirrors PoolSessionReshieldCrosschain's gate.
        if (isCrossChain) {
            // Every route, not only Stargate: LiFi encodes the destination call's budget as
            // the route's guaranteed delivery on Across too (measured 2026-09-24). Read it
            // off the built calldata; fall back to the provider's `destinationCallAmount`,
            // then to the Stargate `minAmountLD` decoder.
            const destBudget =
                this.swapChainAdapter.getDestinationCallAmount(
                    quoteResult.transactionData,
                    depositResult.depositTx.data,
                ) ??
                (quoteResult.destinationCallAmount !== undefined
                    ? BigInt(quoteResult.destinationCallAmount)
                    : undefined) ??
                this.swapChainAdapter.getDestinationDeliveryBudget(quoteResult.transactionData);
            if (destBudget !== undefined && totalDepositCost > destBudget) {
                const refitBudget =
                    (destBudget * (10_000n - DESTINATION_GUARANTEE_MARGIN_BPS)) / 10_000n;
                const affordableNoteValue = yieldTarget
                    ? refitBudget
                    : (refitBudget * 10_000n) / (10_000n + vettingFeeBPS);
                throw new DestinationDepositUnaffordable(
                    totalDepositCost.toString(),
                    destBudget.toString(),
                    `0x${affordableNoteValue.toString(16)}` as Hex,
                );
            }
        }

        const approvalTxs = await this.buildInputTokenApprovalTxs(
            inputToken,
            bigintToHex(BigInt(quoteResult.fromAmount)),
            quoteResult.approvalAddress,
            isCrossChain,
        );

        this.logger?.info("Swap-and-deposit prepared", {
            estimatedInputAmount: quoteResult.fromAmount,
            approvalAddress: quoteResult.approvalAddress,
        });

        return {
            pendingNote: depositResult.pendingNote,
            inputToken,
            estimatedInputAmount: bigintToHex(BigInt(quoteResult.fromAmount)),
            inputAmountUSD: quoteResult.fromAmountUSD,
            depositAmountUSD: quoteResult.toAmountUSD,
            approvalAddress: quoteResult.approvalAddress,
            approvalTxs,
            approvalTx: approvalTxs[approvalTxs.length - 1] ?? null,
            transactionData: quoteResult.transactionData,
            transactionTo: quoteResult.transactionTo,
            msgValue: quoteResult.transactionValue,
            estimatedDuration: quoteResult.estimatedDuration,
            fromChainId,
            depositCallData: depositResult.depositTx.data,
            depositTarget: depositResult.depositTx.to,
            depositMsgValue: depositResult.depositTx.value,
        };
    }

    /**
     * @inheritdoc IPoolSessionSwapDeposit.executeSwapAndDeposit
     * @throws {UnexpectedTransactionTarget} When approvalTx targets the wrong token, selector, or spender, or an executor transaction's decoded arguments differ from the validated deposit.
     * @throws {PoolSessionSwapDepositBaseError} When a submitted transaction reverts.
     */
    async executeSwapAndDeposit(result: PrepareSwapAndDepositResult<TTx, TAddress>): Promise<TxReceipt> {
        const isCrossChain = result.fromChainId !== this.chainId;
        if (isCrossChain && this.sourceChain?.chainId !== result.fromChainId) {
            throw new InvalidSwapAndDepositParams(
                `Prepared result targets chain ${result.fromChainId} but no matching ` +
                    `sourceChain is configured (pool chainId ${this.chainId}).`,
            );
        }

        // Re-validate the swap transaction against the on-chain allowlist and the session's
        // own Entrypoint before signing. A PrepareSwapAndDepositResult is plain serializable
        // data that may have round-tripped through UI state / storage / a backend, so the
        // prepare-time checks are not enough — the values actually being signed here must be
        // re-anchored to trusted sources (the chain's approvedRouters, this session's
        // Entrypoint address), not trusted because they came in the result object.
        await this.assertSwapTxTrusted(
            {
                transactionTo: result.transactionTo,
                approvalAddress: result.approvalAddress,
                transactionData: result.transactionData,
                depositCallData: result.depositCallData,
                depositTarget: result.depositTarget,
                pendingNote: result.pendingNote,
                depositMsgValue: result.depositMsgValue,
                inputToken: result.inputToken,
                estimatedInputAmount: result.estimatedInputAmount,
                msgValue: result.msgValue,
                depositCallValue: result.depositCallValue,
            },
            isCrossChain,
        );

        // Cross-chain, both transactions execute on the source chain: signed by the
        // source wallet, receipts awaited on the source RPC.
        const sendTransaction = isCrossChain
            ? (tx: TTx): Promise<Hex> => this.sourceChain!.walletInteractor.sendTransaction(tx)
            : (tx: TTx): Promise<Hex> => this.entrypointInteractor.submitTransaction(tx);
        const rpc = isCrossChain ? this.sourceChain!.rpcInteractor : this.rpcInteractor;

        // In order: a zero reset first on a residual allowance (Tether-style tokens), then the
        // real approval. Every approval the result names is validated and submitted:
        // `approvalTxs` in order, plus a legacy/single `approvalTx` when it is not already one of
        // them (results built by an older SDK carry only `approvalTx`) — so a tampered copy in
        // either field is caught, never silently skipped.
        const approvals = [
            ...(result.approvalTxs ?? []),
            ...(result.approvalTx ? [result.approvalTx] : []),
        ].filter(
            (tx, i, all) =>
                all.findIndex(
                    (o) =>
                        this.addressEqualityComparator.equals(o.to, tx.to) &&
                        o.data === tx.data &&
                        o.value === tx.value,
                ) === i,
        );
        // Validate every approval before signing any: a tampered one must never be preceded by a
        // genuine one already on-chain.
        for (const approvalTx of approvals) {
            this.assertApprovalTx(
                approvalTx,
                result.inputToken,
                result.approvalAddress,
                result.estimatedInputAmount,
                isCrossChain,
            );
        }
        for (const approvalTx of approvals) {
            const approvalHash = await sendTransaction(approvalTx);
            const approvalReceipt = await rpc.waitForTransactionReceipt(approvalHash);

            if (!approvalReceipt.status) {
                throw new PoolSessionSwapDepositBaseError(
                    "Input token approval transaction reverted",
                );
            }
        }

        const swapDepositTx = {
            to: result.transactionTo,
            data: result.transactionData,
            value: result.msgValue,
        } as unknown as TTx;
        const txHash = await sendTransaction(swapDepositTx);
        const txReceipt = await rpc.waitForTransactionReceipt(txHash);

        // Cross-chain, the receipt only proves the source chain accepted the swap — the
        // deposit lands on the pool chain minutes later via the aggregator's destination
        // executor, so there is no commitment timestamp to persist yet. The caller keeps the
        // pendingNote (secrets); the note becomes spendable via the session's normal
        // on-chain sync once the destination deposit exists.
        if (!isCrossChain && txReceipt.status && result.pendingNote.isOwned) {
            await this.persistDepositNote(result, txReceipt);
        }

        return txReceipt;
    }

    /**
     * @inheritdoc IPoolSessionSwapDeposit.swapAndDeposit
     */
    async swapAndDeposit(params: SwapAndDepositParams<TAddress>): Promise<TxReceipt> {
        const result = await this.prepareSwapAndDeposit(params);
        return this.executeSwapAndDeposit(result);
    }

    /**
     * Same-chain swap into a deposit, as one executor transaction the session composes itself:
     * an ordinary aggregator swap of `inputToken` into `outputToken`, paid to the executor and
     * used unchanged, then the deposit call handed exactly `callValue` of `outputToken` (the
     * native coin as the call's value, an ERC-20 as an executor approval the deposit target
     * pulls). The quote is exact-out on `totalDepositCost` grossed up for slippage, and its
     * guaranteed minimum must still cover that cost; the executor returns any surplus to the
     * owner. The aggregator never sees the deposit calldata.
     *
     * Two callers. A plain native-coin Entrypoint deposit always comes here (no contract-calls
     * quote can send its exact value). Any other same-chain deposit comes here only when the
     * aggregator's contract-calls quote itself targets the executor, which it does for a
     * native-coin INPUT: that transaction is the aggregator's own executor call, which the
     * session never signs (see `assertSwapTxTrusted`), so it is rebuilt in the session's own
     * fully-decoded layout instead. A native input rides as the transaction's value and needs
     * no approval at all.
     *
     * @throws {NativeSwapDepositUnavailable} If no executor or swap quote provider is configured,
     *   the input is already the output, the deposit call's value does not fit its output kind,
     *   the swap does not pay the executor, or its guaranteed output is below the deposit cost.
     *   (A native input's swap is sent exactly `fromAmount`; a quote that needed another value
     *   would revert on chain, never spend more.)
     * @throws {SwapQuoteMismatch} If the quote routes different tokens or chains than requested.
     * @throws {UnallowedLiFiAddress} If the swap, its approval address, the executor or its
     *   proxy is not in RelaySwaps.approvedRouters.
     */
    private async prepareExecutorSwapDeposit(args: {
        inputToken: TAddress;
        depositToken: TAddress;
        /** What the swap must deliver: the native coin, the plain deposit token, or a share's funding token. */
        outputToken: TAddress;
        depositResult: PrepareDepositResult<TTx, TAddress>;
        totalDepositCost: bigint;
    }): Promise<PrepareSwapAndDepositResult<TTx, TAddress>> {
        const { inputToken, depositToken, outputToken, depositResult, totalDepositCost } = args;
        const refuse = (reason: string): never => {
            throw new NativeSwapDepositUnavailable(String(depositToken), totalDepositCost.toString(), reason);
        };
        const executor = this.swapExecutor;
        if (!executor || !this.swapQuoteProvider) {
            return refuse(`no swap executor is configured for chain ${this.chainId}`);
        }
        const composed = await composeExecutorSwapThenCall(
            this.executorCallContext(executor),
            this.swapQuoteProvider,
            {
                inputToken,
                outputToken,
                callTarget: depositResult.depositTx.to,
                callData: depositResult.depositTx.data,
                depositValue: BigInt(depositResult.depositTx.value ?? "0x0"),
                totalDepositCost,
                receiver: this.ownerAddress,
            },
            refuse,
        );
        const { transactionData, inputAmount, callValue, quote } = composed;
        const nativeInput = this.swapChainAdapter.isSameToken(inputToken, this.nativeAssetAddress);
        const nativeOutput = this.swapChainAdapter.isSameToken(outputToken, this.nativeAssetAddress);
        // A native input is the transaction's own value: the executor forwards exactly that to
        // the swap, so nothing is approved and nothing else is sent.
        const msgValue = nativeInput ? bigintToHex(inputAmount) : ("0x0" as Hex);
        await this.assertSwapTxTrusted(
            {
                transactionTo: executor.executor,
                approvalAddress: executor.erc20Proxy,
                transactionData,
                depositCallData: depositResult.depositTx.data,
                depositTarget: depositResult.depositTx.to,
                pendingNote: depositResult.pendingNote,
                depositMsgValue: depositResult.depositTx.value,
                inputToken,
                estimatedInputAmount: bigintToHex(inputAmount),
                msgValue,
                depositCallValue: bigintToHex(callValue),
            },
            false,
        );

        const approvalTxs = await this.buildInputTokenApprovalTxs(
            inputToken,
            bigintToHex(inputAmount),
            executor.erc20Proxy,
            false,
        );
        this.logger?.info("Executor swap-and-deposit prepared", {
            estimatedInputAmount: quote.fromAmount,
            guaranteedOutput: quote.toAmountMin,
            nativeInput,
            nativeOutput,
            callValue: callValue.toString(),
        });

        return {
            pendingNote: depositResult.pendingNote,
            inputToken,
            estimatedInputAmount: bigintToHex(inputAmount),
            inputAmountUSD: quote.fromAmountUSD,
            depositAmountUSD: quote.toAmountUSD,
            approvalAddress: executor.erc20Proxy,
            approvalTxs,
            approvalTx: approvalTxs[approvalTxs.length - 1] ?? null,
            transactionData,
            transactionTo: executor.executor,
            msgValue,
            estimatedDuration: quote.estimatedDuration,
            fromChainId: this.chainId,
            depositCallData: depositResult.depositTx.data,
            depositTarget: depositResult.depositTx.to,
            depositMsgValue: depositResult.depositTx.value,
            depositCallValue: bigintToHex(callValue),
        };
    }

    /**
     * Re-anchors a swap transaction's trust to on-chain / session-held values: the aggregator's
     * `transactionTo` and `approvalAddress` must be approved routers on the executing
     * chain, the embedded deposit target must be THIS session's Entrypoint (not a value
     * trusted from the passed object), and the deposit calldata must be byte-embedded in
     * `transactionData`. Run at both prepare and execute so a tampered result is rejected
     * before signing.
     * The aggregator's swap executor runs arbitrary calls for anyone, so substring checks prove
     * nothing about an executor transaction: one is accepted only as the session's own composed
     * same-chain deposit, decoded and pinned argument-by-argument, and the user never approves
     * the executor itself (anyone could spend that allowance, e.g. after the swap reverts).
     *
     * @throws {UnallowedLiFiAddress} If transactionTo/approvalAddress is not on the allowlist.
     * @throws {UnexpectedTransactionTarget} If depositTarget is not the session's Entrypoint.
     * @throws {LiFiDepositCalldataNotFound} If the deposit calldata is absent from transactionData.
     * @throws {LiFiDepositTargetNotFound} If the Entrypoint address is absent from transactionData.
     * @throws {UnexpectedTransactionTarget} If the transaction calls a swap executor other than as
     *   the composed same-chain deposit, its approval spender is a swap executor, or executor
     *   arguments differ from the validated deposit.
     * @throws {UnallowedLiFiAddress} If an executor swap leg is not on the allowlist.
     */
    private async assertSwapTxTrusted(
        tx: {
            transactionTo: TAddress;
            approvalAddress: TAddress;
            transactionData: Hex;
            depositCallData: Hex;
            depositTarget: TAddress;
            pendingNote: PendingNote<TAddress>;
            depositMsgValue?: Hex;
            inputToken: TAddress;
            estimatedInputAmount: Hex;
            msgValue?: Hex;
            depositCallValue?: Hex;
        },
        isCrossChain: boolean,
    ): Promise<void> {
        const allowlist = this.selectAllowlist(isCrossChain);
        await allowlist.swapChainAdapter.assertRoutingLayoutMatches(
            allowlist.relaySwapsAddress,
            isCrossChain ? this.sourceChain!.chainId : this.chainId,
        );
        await this.assertLiFiAddressAllowed(tx.transactionTo, "transactionTo", allowlist);
        await this.assertLiFiAddressAllowed(tx.approvalAddress, "approvalAddress", allowlist);

        // The deposit must target this session's own Entrypoint. Anchoring to
        // entrypointInteractor (not tx.depositTarget) is what makes this robust against a
        // tampered result — the deposit lands on the pool chain regardless of source chain,
        // so the pool-chain Entrypoint is always the correct target.
        const sessionEntrypoint = this.entrypointInteractor.getAddress();
        const yieldTarget = this.yieldTargetFor(tx.pendingNote.tokenId);
        const routerTarget =
            yieldTarget && this.addressEqualityComparator.equals(tx.depositTarget, yieldTarget.router)
                ? yieldTarget
                : undefined;
        if (!this.addressEqualityComparator.equals(tx.depositTarget, sessionEntrypoint) && !routerTarget) {
            throw new UnexpectedTransactionTarget(
                `Deposit target ${tx.depositTarget} is not the session Entrypoint or the configured router for the output share.`,
            );
        }
        if (routerTarget) {
            routerTarget.assertDepositMatches({
                depositTx: {
                    to: tx.depositTarget,
                    data: tx.depositCallData,
                    value: tx.depositMsgValue ?? "0x0",
                } as unknown as TTx,
                pendingNote: tx.pendingNote,
            });
        }
        this.assertDepositIsEmbeddedInQuote(tx.transactionData, tx.depositCallData, tx.depositTarget);

        // The swap executor is on the router allowlist (the composed native deposit needs it), but
        // it runs arbitrary calls: an executor transaction can move the user's tokens anywhere
        // while merely embedding the deposit bytes, and an allowance granted to it can be spent by
        // anyone. Accept it only as this session's own composed same-chain deposit, fully decoded.
        const executor = isCrossChain ? undefined : this.swapExecutor;
        if (executor && this.addressEqualityComparator.equals(tx.approvalAddress, executor.executor)) {
            throw new UnexpectedTransactionTarget(
                `approval spender ${tx.approvalAddress} is a swap executor; anyone could spend an allowance granted to it`,
            );
        }
        if (executor && this.addressEqualityComparator.equals(tx.transactionTo, executor.executor)) {
            if (await allowlist.swapChainAdapter.isSwapExecutor(tx.approvalAddress)) {
                throw new UnexpectedTransactionTarget(
                    `approval spender ${tx.approvalAddress} is a swap executor; anyone could spend an allowance granted to it`,
                );
            }
            await this.assertSwapThenCallMatches(tx, executor);
            return;
        }
        await assertNoSwapExecutor(allowlist.swapChainAdapter, tx);
    }

    /**
     * Pins every executor argument to an explicit expected value before signing, through the one
     * validator every executor flow shares: the owner as receiver, the input and its exact
     * amount, the token the deposit needs as output, the exact validated deposit call, and the
     * exact amount that call is handed. That amount is the deposit's own value for the native
     * coin. For an ERC-20 it is the composed `depositCallValue`, and for an Entrypoint deposit
     * also the note value plus the vetting fee read from the Entrypoint, so the result object
     * alone cannot move it.
     *
     * @throws {UnexpectedTransactionTarget} If executor arguments differ from the validated transaction.
     * @throws {UnallowedLiFiAddress} If a swap-leg address is not approved on-chain.
     */
    private async assertSwapThenCallMatches(
        tx: {
            transactionTo: TAddress;
            transactionData: Hex;
            approvalAddress: TAddress;
            depositTarget: TAddress;
            depositCallData: Hex;
            pendingNote: PendingNote<TAddress>;
            inputToken: TAddress;
            estimatedInputAmount: Hex;
            depositMsgValue?: Hex;
            depositCallValue?: Hex;
            msgValue?: Hex;
        },
        executor: SwapExecutorAddresses<TAddress>,
    ): Promise<void> {
        const yieldTarget = this.yieldTargetFor(tx.pendingNote.tokenId);
        const outputToken = yieldTarget ? yieldTarget.fundingToken : tx.pendingNote.tokenId;
        const nativeOutput = this.swapChainAdapter.isSameToken(outputToken, this.nativeAssetAddress);
        const depositMsgValue = BigInt(tx.depositMsgValue ?? "0x0");
        let callValue: bigint;
        if (nativeOutput) {
            callValue = depositMsgValue;
        } else {
            if (depositMsgValue !== 0n || tx.depositCallValue === undefined) {
                throw new UnexpectedTransactionTarget(
                    `executor ERC-20 deposit must name the amount it hands the call and carry no native value (value ${depositMsgValue})`,
                );
            }
            callValue = BigInt(tx.depositCallValue);
            if (this.addressEqualityComparator.equals(tx.depositTarget, this.entrypointInteractor.getAddress())) {
                const { vettingFeeBPS } = await this.entrypointInteractor.getAssetConfig(tx.pendingNote.tokenId);
                const noteValue = BigInt(tx.pendingNote.value);
                const depositCost = noteValue + (noteValue * BigInt(vettingFeeBPS)) / 10_000n;
                if (callValue !== depositCost) {
                    throw new UnexpectedTransactionTarget(
                        `executor deposit amount ${callValue} does not match the deposit cost ${depositCost}`,
                    );
                }
            }
        }
        if (callValue === 0n) {
            throw new UnexpectedTransactionTarget("executor deposit call is handed nothing");
        }
        if (yieldTarget && this.addressEqualityComparator.equals(tx.depositTarget, yieldTarget.router)) {
            await this.assertRouterCallValueTrusted(yieldTarget, tx, callValue);
        }
        await assertExecutorCallMatches(this.executorCallContext(executor), tx, {
            receiver: this.ownerAddress,
            inputToken: tx.inputToken,
            inputAmount: BigInt(tx.estimatedInputAmount),
            outputToken,
            call: { target: tx.depositTarget, data: tx.depositCallData },
            callValue,
            msgValue: BigInt(tx.msgValue ?? "0x0"),
        });
    }

    /**
     * A router deposit's funding budget is not in the note, so the amount the call is handed is
     * anchored on chain instead: it must be the cap the router calldata encodes, and the shares
     * that amount buys at the router's current rate must not exceed the note's shares by more than
     * {@link ROUTER_BUDGET_SHARE_TOLERANCE_BPS}. Tampering the result, the router calldata and the
     * executor calldata together to hand the router more is therefore still refused.
     *
     * @throws {InvalidTransactParams} If the router calldata's cap is not `callValue`.
     * @throws {UnexpectedTransactionTarget} If `callValue` buys more shares than the note holds.
     */
    private async assertRouterCallValueTrusted(
        yieldTarget: YieldSwapDepositTarget<TTx, TAddress>,
        tx: { depositTarget: TAddress; depositCallData: Hex; depositMsgValue?: Hex; pendingNote: PendingNote<TAddress> },
        callValue: bigint,
    ): Promise<void> {
        yieldTarget.assertDepositMatches(
            {
                depositTx: {
                    to: tx.depositTarget,
                    data: tx.depositCallData,
                    value: tx.depositMsgValue ?? "0x0",
                } as unknown as TTx,
                pendingNote: tx.pendingNote,
            },
            callValue,
        );
        const noteShares = BigInt(tx.pendingNote.value);
        const { shares } = await yieldTarget.sizeSharesForBudget(callValue);
        const maxShares = noteShares + (noteShares * ROUTER_BUDGET_SHARE_TOLERANCE_BPS) / 10_000n;
        if (shares > maxShares) {
            throw new UnexpectedTransactionTarget(
                `executor router budget ${callValue} buys ${shares} shares, more than the note's ${noteShares}`,
            );
        }
    }

    /** The shared executor-call context, vetting against this pool chain's RelaySwaps allowlist. */
    private executorCallContext(executor: SwapExecutorAddresses<TAddress>): ExecutorCallContext<TTx, TAddress> {
        const allowlist = this.selectAllowlist(false);
        return {
            swapChainAdapter: this.swapChainAdapter,
            addressEqualityComparator: this.addressEqualityComparator,
            executor,
            nativeAssetAddress: this.nativeAssetAddress,
            chainId: this.chainId,
            assertAllowed: (address, role) => this.assertLiFiAddressAllowed(address, role, allowlist),
        };
    }

    /**
     * Selects the RelaySwaps allowlist to vet against: the source chain's for cross-chain
     * (where the swap tx executes), the pool chain's for same-chain.
     */
    private selectAllowlist(isCrossChain: boolean): {
        relaySwapsAddress: TAddress;
        swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
    } {
        return isCrossChain
            ? {
                  relaySwapsAddress: this.sourceChain!.relaySwapsAddress,
                  swapChainAdapter: this.sourceChain!.swapChainAdapter,
              }
            : {
                  relaySwapsAddress: this.relaySwapsAddress,
                  swapChainAdapter: this.swapChainAdapter,
              };
    }

    /**
     * Asserts the given aggregator quote address is approved in RelaySwaps.approvedRouters on
     * the chain the swap transaction executes on.
     *
     * @throws {UnallowedLiFiAddress} If the address is not approved on-chain.
     */
    private async assertLiFiAddressAllowed(
        address: TAddress,
        role: string,
        allowlist: { relaySwapsAddress: TAddress; swapChainAdapter: ISwapChainAdapter<TTx, TAddress> },
    ): Promise<void> {
        const approved = await allowlist.swapChainAdapter.isApprovedRouter(
            address,
            allowlist.relaySwapsAddress,
        );
        if (!approved) {
            throw new UnallowedLiFiAddress(String(address), role, this.chainId);
        }
    }

    /**
     * Asserts the aggregator routed the exact chains and tokens the quote was requested for. The
     * response echoes `fromChainId`/`toChainId`/`fromTokenAddress`/`toTokenAddress`; a
     * mismatch means the quote provider (buggy or compromised) routed somewhere other
     * than the caller intended.
     *
     * @throws {SwapQuoteMismatch} If any routed chain or token differs from the request.
     */
    private assertQuoteRoutedAsRequested(
        quote: Pick<
            SwapAndDepositQuoteResult<TAddress>,
            "fromTokenAddress" | "toTokenAddress" | "fromChainId" | "toChainId"
        >,
        expected: { fromToken: TAddress; toToken: TAddress; fromChainId: number; toChainId: number },
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
     * Asserts the aggregator quote's `transactionData` embeds both the deposit proof calldata
     * and the Entrypoint address verbatim at the raw byte level.
     *
     * A compromised quote source could return a `transactionData` that routes the swap
     * output to an attacker instead of calling `Entrypoint.deposit()`. This check runs
     * before the quote is returned for signing, ensuring what gets proof-bound actually
     * deposits into the pool.
     *
     * @throws {LiFiDepositCalldataNotFound} If the deposit calldata is absent from the transaction blob.
     * @throws {LiFiDepositTargetNotFound} If the Entrypoint address is absent.
     */
    private assertDepositIsEmbeddedInQuote(
        quoteTransactionData: Hex,
        depositCallData: Hex,
        depositTargetAddress: TAddress,
    ): void {
        assertDepositCalldataEmbedded(quoteTransactionData, depositCallData, this.chainId);
        if (!this.swapChainAdapter.isAddressEmbeddedInCalldata(quoteTransactionData, depositTargetAddress)) {
            throw new LiFiDepositTargetNotFound(String(depositTargetAddress), this.chainId);
        }
    }

    /**
     * Validates a prepared token approval before signing: it must target `inputToken`,
     * name `expectedSpender` (the aggregator's router) as the spender, and not
     * approve more than `expectedAmount` (the aggregator-estimated input). The spender check is
     * the load-bearing one — the router is separately allowlist-checked — but the amount
     * bound caps blast radius so a corrupted result cannot silently grant an unbounded
     * allowance to an otherwise-approved router.
     *
     * @throws {UnexpectedTransactionTarget} On token, spender, or excess-amount mismatch.
     */
    private assertApprovalTx(
        approvalTx: TTx,
        inputToken: TAddress,
        expectedSpender: TAddress,
        expectedAmount: Hex,
        isCrossChain: boolean,
    ): void {
        const adapter = isCrossChain ? this.sourceChain!.swapChainAdapter : this.swapChainAdapter;
        // A native input is the transaction's own value and is never approved: an "approval" to
        // the native placeholder address only sends whatever value it carries to an address with
        // no code. And no approval carries value at all.
        if (adapter.isSameToken(inputToken, this.nativeAssetAddress)) {
            throw new UnexpectedTransactionTarget("a native-coin input takes no approval transaction");
        }
        const approvalValue = BigInt((approvalTx as { value?: Hex | null }).value ?? "0x0");
        if (approvalValue !== 0n) {
            throw new UnexpectedTransactionTarget(`approval transaction carries ${approvalValue} native value`);
        }
        const parsed = adapter.parseApprovalTx(approvalTx);
        if (!this.addressEqualityComparator.equals(parsed.target, inputToken)) {
            throw new UnexpectedTransactionTarget(
                `approval target ${parsed.target} does not match input token ${inputToken}`,
            );
        }
        if (!this.addressEqualityComparator.equals(parsed.spender, expectedSpender)) {
            throw new UnexpectedTransactionTarget(
                `approval spender ${parsed.spender} does not match expected router ${expectedSpender}`,
            );
        }
        if (parsed.amount > BigInt(expectedAmount)) {
            throw new UnexpectedTransactionTarget(
                `approval amount ${parsed.amount} exceeds the estimated input ${BigInt(expectedAmount)}`,
            );
        }
    }

    /**
     * Builds a token-approval tx for the input token to the aggregator's approval address, via
     * the chain-specific swapChainAdapter (same-chain, or the source chain's for cross-chain).
     * Unlike the regular deposit flow (which approves to the entrypoint), swap-and-deposit
     * approves to the aggregator's router so it can pull tokens for the swap.
     *
     * @param token - The input token address.
     * @param amount - The amount to approve (hex-encoded).
     * @param spender - The aggregator's approval address.
     * @param isCrossChain - Whether to build against the source chain's adapter instead of this
     *   session's own.
     * @returns The approval transactions to submit in order — empty when none is needed (native
     *   asset, or the adapter finds an existing allowance already covers `amount`).
     */
    private async buildInputTokenApprovalTxs(
        token: TAddress,
        amount: Hex,
        spender: TAddress,
        isCrossChain: boolean,
    ): Promise<TTx[]> {
        if (this.addressEqualityComparator.equals(token, this.nativeAssetAddress)) {
            return [];
        }

        const adapter = isCrossChain ? this.sourceChain!.swapChainAdapter : this.swapChainAdapter;
        return adapter.buildTokenApprovalTxs({ token, owner: this.ownerAddress, spender, amount });
    }

    /** The configured yield-share deposit target whose share is `depositToken`, if any. */
    private yieldTargetFor(depositToken: TAddress): YieldSwapDepositTarget<TTx, TAddress> | undefined {
        return yieldSwapDepositTargetFor(this.yieldDepositTargets, depositToken, (a, b) =>
            this.swapChainAdapter.isSameToken(a, b),
        );
    }

    /**
     * Persists the deposit note after a successful on-chain transaction.
     * Mirrors the note persistence logic from {@link PoolSessionDeposit.executeDeposit}.
     *
     * @param result - The prepared swap-and-deposit result containing the pending note.
     * @param txReceipt - The confirmed transaction receipt.
     */
    private async persistDepositNote(
        result: PrepareSwapAndDepositResult<TTx, TAddress>,
        txReceipt: TxReceipt,
    ): Promise<void> {
        const blockTimestamp = await resolveCommitmentTimestamp(
            this.poolVaultInteractor,
            result.pendingNote.commitment,
            { logger: this.logger },
        );

        if (blockTimestamp === null) {
            this.logger?.warn(
                "Swap-and-deposit succeeded but commitment timestamp could not be resolved; " +
                    "note not persisted locally — discoverNotes() will recover it",
                {
                    commitment: result.pendingNote.commitment,
                    txHash: txReceipt.txHash,
                },
            );
            return;
        }

        this.noteManager.addNote({
            ...result.pendingNote,
            noteSecret: result.pendingNote.noteSecret!,
            status: NoteStatus.PENDING,
            createdAtBlock: blockTimestamp,
            spentAtBlock: null,
            txHash: txReceipt.txHash,
        } as PendingNote<TAddress> & { noteSecret: Hex; status: NoteStatus; createdAtBlock: Hex; spentAtBlock: null; txHash: Hex });
    }
}
