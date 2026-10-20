import type {
    Address,
    EVMProof,
    ExecuteWithdrawAndSwapRelayerParams,
    Hex,
    IAddressEqualityComparator,
    IEntrypointInteractor,
    ILogger,
    IPoolSessionWithdrawAndSwap,
    IRelayerInteractor,
    ISwapChainAdapter,
    ISwapQuoteProvider,
    ITransactOrchestrator,
    ITxReceiptWaiter,
    PoolSessionWithdrawAndSwapConfig,
    PoolSessionWithdrawAndSwapDependencies,
    PreparedSwapQuote,
    PreparedTransaction,
    PrepareSwapQuoteParams,
    SwapRouting,
    SwapQuoteResult,
    SwapRelayerQuote,
    TxLog,
    TxReceipt,
    YieldSwapWrapper,
} from "../../internal.js";
import {
    assertFeeCommitmentLive,
    assertNoSwapExecutor,
    assertLifiBudget,
    bigintToHex,
    InvalidTransactParams,
    LiFiRecipientNotFound,
    RelayFeeExceedsMax,
    SwapQuoteMismatch,
} from "../../internal.js";
import { assertZapApproved, yieldWrapperFor } from "../../utils/index.js";

/**
 * Fee over-estimate (basis points of the gross withdrawal) applied when sizing the LiFi
 * swap input. The relayer prices its fee per call from live gas, so the binding (commit)
 * fee can drift above the preliminary one between quotes. The LiFi calldata bakes a fixed
 * `fromAmount = amount − inflatedFee`; over-estimating the fee guarantees `fromAmount ≤ net`
 * (funded from the committed fee), so the router's input `transferFrom` never reverts for a
 * fee wiggle. The small surplus is swept to `dustRecipient` — same-chain that defaults back
 * to the recipient, so the buffer is nearly free; cross-chain callers should pass a
 * source-chain `dustRecipient` to reclaim it. Kept well under SWAP_DUST_TOLERANCE_BPS so the
 * over-estimate itself never trips the dust bound.
 */
const WITHDRAW_SWAP_FEE_BUFFER_BPS = 30n;

/**
 * Orchestrates the withdraw-and-swap flow via a relayer, generic over the chain's prepared-
 * transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and raw
 * receipt-log type `TLog`.
 *
 * A withdraw-and-swap moves value out of the pool to the WithdrawAndSwap
 * processor, which executes a DEX swap (via aggregator calldata) and sends the
 * output tokens to the recipient. The caller provides swap calldata
 * externally; this session handles proof generation, commitment validation,
 * relayer submission, and receipt polling.
 *
 * Every operation that varies by chain (decoding the relayer-signed routing blob, checking a
 * router allowlist, verifying the swap recipient is embedded in aggregator calldata) is
 * delegated to the injected `swapChainAdapter` ({@link ISwapChainAdapter}) — this class itself
 * has no chain-specific runtime dependency, even though (per its own doc) there is currently
 * only one real adapter implementation (evm-sdk's `EvmSwapChainAdapter`).
 */
export class PoolSessionWithdrawAndSwap<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionWithdrawAndSwap<TAddress, TLog>
{
    private readonly chainId: number;
    private readonly core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    private readonly relayerInteractor: IRelayerInteractor<TAddress>;
    private readonly rpcInteractor: ITxReceiptWaiter<TLog>;
    private readonly entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly emptyAddress: TAddress;
    private readonly swapQuoteProvider?: ISwapQuoteProvider<TAddress>;
    private readonly swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
    private readonly yieldWrappers: YieldSwapWrapper<TAddress>[];
    private readonly relaySwapsAddress?: TAddress;
    private readonly logger?: ILogger;

    constructor(
        config: PoolSessionWithdrawAndSwapConfig<TTx, TAddress, TProof, TLog>,
        deps?: PoolSessionWithdrawAndSwapDependencies,
    ) {
        this.chainId = config.chainId;
        this.core = config.core;
        this.relayerInteractor = config.relayerInteractor;
        this.rpcInteractor = config.rpcInteractor;
        this.entrypointInteractor = config.entrypointInteractor;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.emptyAddress = config.emptyAddress;
        this.swapQuoteProvider = config.swapQuoteProvider;
        this.swapChainAdapter = config.swapChainAdapter;
        this.yieldWrappers = config.yieldWrappers ?? [];
        this.relaySwapsAddress = config.relaySwapsAddress;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionWithdrawAndSwap.prepareSwapQuote
     * @throws {InvalidTransactParams} When swapQuoteProvider/relaySwapsAddress is not configured, cross-chain params are inconsistent, or the signed routing diverges.
     * @throws {RelayFeeExceedsMax} When the relayer fee exceeds the Entrypoint maxRelayFee.
     * @throws {SwapQuoteMismatch} When the aggregator quote routes different tokens/chains than requested.
     * @throws {LiFiRecipientNotFound} When the aggregator's transaction data decodes a different recipient than requested.
     */
    async prepareSwapQuote(params: PrepareSwapQuoteParams<TAddress>): Promise<PreparedSwapQuote<TAddress>> {
        if (!this.swapQuoteProvider) {
            throw new InvalidTransactParams(
                "swapQuoteProvider must be configured to use prepareSwapQuote()",
            );
        }
        const relaySwapsAddress = this.requireRelaySwapsAddress();

        const {
            relayerInfo,
            amount,
            tokenId,
            outputToken,
            recipientAddress,
            fallbackAddress,
            dustRecipient,
            extraGas,
            slippage,
            toChainId,
            denyExchanges,
        } = params;

        const destinationChainId = toChainId ?? relayerInfo.chainId;
        const isCrossChain = destinationChainId !== relayerInfo.chainId;

        if (isCrossChain) {
            if (!fallbackAddress) {
                throw new InvalidTransactParams(
                    "fallbackAddress is required for cross-chain swaps — destination-chain address receiving bridged tokens if the destination swap fails",
                );
            }
            if (this.addressEqualityComparator.equals(fallbackAddress, this.emptyAddress)) {
                throw new InvalidTransactParams(
                    "fallbackAddress must not be the empty-address sentinel (bridged funds would be unrecoverable on a failed destination swap)",
                );
            }
            if (extraGas) {
                throw new InvalidTransactParams(
                    "extraGas is not supported for cross-chain swaps — no source-chain recipient to forward it to",
                );
            }
        }

        // Cross-chain: no source-chain recipient — the real recipient lives only in
        // the proof-bound aggregator calldata (toAddress); routing recipient is zero.
        const routingRecipient = isCrossChain ? this.emptyAddress : recipientAddress;
        // Cross-chain: recipientAddress is a destination-chain address, invalid as a
        // source-chain dust target — default to the relayer (matches reshield).
        const effectiveDustRecipient =
            dustRecipient ?? (isCrossChain ? relayerInfo.address : recipientAddress);

        // Pre-flight: input asset config bounds the relayer fee.
        const inputConfig = await this.entrypointInteractor.getAssetConfig(tokenId);

        // 1. Preliminary relayer quote (no commitment) — get fee amount
        const prelimQuote = await this.relayerInteractor.getSwapQuote(relayerInfo, {
            asset: tokenId,
            amount: BigInt(amount).toString(),
            outputToken,
            recipient: routingRecipient,
            // As the amount will get deposited into the contract, the output is 0.
            minOutputAmount: "0",
            dustRecipient: effectiveDustRecipient,
            extraGas: extraGas ?? false,
            commit: false,
        });

        this.assertFeeWithinBounds(prelimQuote.feeAmount, amount, inputConfig.maxRelayFee);

        // 2. Size the swap input against an OVER-ESTIMATED fee. The aggregator calldata bakes a
        //    fixed fromAmount = amount − inflatedFee; funding it on-chain from the (possibly
        //    higher) committed fee still leaves net ≥ fromAmount, so the router can pull its
        //    input. The surplus (net − fromAmount) sweeps to dustRecipient as bounded dust.
        const inflatedFee =
            BigInt(prelimQuote.feeAmount) +
            (BigInt(amount) * WITHDRAW_SWAP_FEE_BUFFER_BPS) / 10000n;
        if (inflatedFee >= BigInt(amount)) {
            throw new InvalidTransactParams(
                `Fee buffer makes the swap input non-positive: inflated fee ${inflatedFee} >= withdrawal amount ${BigInt(amount)}. Withdraw a larger amount.`,
                // Note-denominated: on a yield share this is shares, and the
                // underlying the swap is quoted on only appears further down.
                {
                    code: "swapInputNonPositive",
                    side: "spent",
                    values: { fee: inflatedFee, amount: BigInt(amount) },
                },
            );
        }
        const netShares = BigInt(amount) - inflatedFee;

        // 2b. Yield share input: the processor redeems the shares into the wrapper's underlying
        //     before the swap (owner-allowlisted zap), so the swap is quoted on the UNDERLYING
        //     for what those net shares redeem to. previewRedeem is the same read the
        //     processor's zap performs; the share rate only rises between quote and execution
        //     (yield accrual), so any surplus lands in the delta dust sweep, never a shortfall.
        //     The relayer fee stays in shares (proof-bound; converted pro-rata on-chain).
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
        const netSwapAmount = wrapper ? await wrapper.previewRedeem(netShares) : netShares;
        if (netSwapAmount <= 0n) {
            throw new InvalidTransactParams(
                `Net swap input is zero: ${netShares} shares of ${tokenId} redeem to ${netSwapAmount} ${swapInputToken}. Withdraw a larger amount.`,
                // Only the share figure travels: the message's two numbers are in
                // two different tokens, and `netSwapAmount` is non-positive here.
                {
                    code: "yieldRedeemsToNothing",
                    side: "spent",
                    values: { shares: netShares },
                },
            );
        }

        // 3. Get DEX swap quote with net amount
        const swapQuote = await this.swapQuoteProvider.getSwapQuote({
            fromChainId: relayerInfo.chainId,
            toChainId: destinationChainId,
            fromToken: swapInputToken,
            toToken: outputToken,
            fromAddress: relaySwapsAddress,
            toAddress: recipientAddress,
            fallbackAddress,
            amount: netSwapAmount.toString(),
            amountType: "from",
            slippage,
            denyExchanges,
        });

        // 4. Cross-check the aggregator route against the request before the calldata
        //    is proof-bound
        this.assertSwapQuoteMatchesRequest(swapQuote, {
            fromToken: swapInputToken,
            toToken: outputToken,
            fromChainId: relayerInfo.chainId,
            toChainId: destinationChainId,
        });

        // 4a. Verify the swap output recipient is embedded in the aggregator's transaction data
        //     before proof-binding. For cross-chain there is no on-chain backstop; this is the
        //     only pre-proof defense. For same-chain the balance-delta guard also catches
        //     misrouting at execution time.
        await this.assertRecipientIsEmbeddedInQuote(
            swapQuote.transactionData,
            swapQuote.transactionTo,
            recipientAddress,
            isCrossChain,
        );

        // F-960: on the same-chain path the routing recipient is a real user address,
        // so the on-chain balance-delta guard in RelaySwaps.execute() must be armed.
        // That guard is gated on minOutputAmount > 0 — a quote returning "0" skips it
        // entirely, allowing the swap calldata to route output to an attacker.
        // Cross-chain and reshield paths legitimately carry toAmountMin = "0" because
        // their routing recipient is the empty-address sentinel (source-chain output goes to a
        // contract via contractCalls, not to a user wallet).
        if (!isCrossChain && BigInt(swapQuote.toAmountMin) === 0n) {
            throw new InvalidTransactParams(
                `Same-chain swap quote returned toAmountMin = 0 — the on-chain output ` +
                    `guard would be disabled, allowing swap output to be silently stolen. ` +
                    `Reject this quote and retry.`,
            );
        }

        // 5. Committed relayer quote with swap details.
        //    Cross-chain: minOutputAmount must be 0 — the source-chain contract cannot
        //    verify destination output; slippage protection is enforced by the aggregator's
        //    destination executor via the proof-bound calldata.
        const onChainMinOutput = isCrossChain ? "0" : swapQuote.toAmountMin;

        // The swap executor is on the router allowlist but runs arbitrary calls for anyone: as the
        // target or the spender it could move the withdrawn funds anywhere.
        await assertNoSwapExecutor(this.swapChainAdapter, swapQuote);

        // Wait for the keystore + state-tree leaf caches to finish warming BEFORE
        // requesting the committed quote below — that's what starts the relayer's
        // short-lived commitment clock. Usually a no-op; only waits if a scan is
        // still genuinely in flight (same fix as PoolSessionReshieldCrosschain).
        await this.core.warmMerkleCaches();

        const committedQuote = await this.relayerInteractor.getSwapQuote(relayerInfo, {
            asset: tokenId,
            amount: BigInt(amount).toString(),
            outputToken,
            recipient: routingRecipient,
            fallbackAddress,
            minOutputAmount: onChainMinOutput,
            swapCalldata: swapQuote.transactionData,
            swapTarget: swapQuote.transactionTo,
            approvalAddress: swapQuote.approvalAddress,
            dustRecipient: effectiveDustRecipient,
            extraGas: extraGas ?? false,
            commit: true,
        });

        // 6. Validate the relayer-signed routing tuple before returning it —
        //    the relayer could re-quote a different fee or tamper with any
        //    field of the routing blob it signs.
        this.assertFeeWithinBounds(committedQuote.feeAmount, amount, inputConfig.maxRelayFee);

        // The aggregator calldata was sized against inflatedFee (= prelimFee + buffer); the swap
        // is funded on-chain from net = amount − committedFee. assertLifiBudget enforces the two
        // bounds this needs: budget (swapQuote.fromAmount ≤ net ⟺ committedFee ≤ inflatedFee,
        // so the router can pull its fixed input) and dust (net − fromAmount = inflatedFee −
        // committedFee ≤ tolerance). A fee that spikes past the buffer trips budget; a grossly
        // under-quoted committed fee trips dust — both effectively unreachable in normal
        // operation, so no retry is needed.
        // Yield input: the LiFi leg is funded from what the COMMITTED net shares redeem to,
        // so the budget/dust bounds are checked in underlying units against that figure.
        const committedNetShares = BigInt(amount) - BigInt(committedQuote.feeAmount);
        const committedSwapInput = wrapper
            ? await wrapper.previewRedeem(committedNetShares)
            : committedNetShares;
        if (wrapper) {
            assertLifiBudget(swapQuote.fromAmount, bigintToHex(committedSwapInput), "0");
        } else {
            assertLifiBudget(swapQuote.fromAmount, amount, committedQuote.feeAmount);
        }

        this.assertGrossWithdrawal(committedQuote, BigInt(amount));

        const routing = this.swapChainAdapter.decodeSwapRouting(committedQuote.feeCommitment.data);
        this.assertSwapCalldataMatches(routing, swapQuote.transactionData);
        this.assertSwapRouting(routing, {
            recipient: routingRecipient,
            fallbackAddress: fallbackAddress ?? routingRecipient,
            outputToken,
            dustRecipient: effectiveDustRecipient,
            feeAmount: committedQuote.feeAmount,
            minOutputAmount: BigInt(onChainMinOutput),
            extraGas: extraGas ?? false,
            swapTarget: swapQuote.transactionTo,
            approvalAddress: swapQuote.approvalAddress,
        });

        // 7. Assemble result
        return {
            selectedQuote: {
                relayerInfo,
                quote: committedQuote,
            },
            swapCalldata: swapQuote.transactionData,
            minOutputAmount: `0x${BigInt(onChainMinOutput).toString(16)}` as Hex,
            destinationMinOutputAmount: `0x${BigInt(swapQuote.toAmountMin).toString(16)}` as Hex,
            feeAmount: committedQuote.feeAmount,
            // Net amount the relay side spends into the proof: gross amountSent − fee.
            // Forwarded as relayWithdrawAndSwap's `amount` (see PreparedSwapQuote.netAmount).
            netAmount: bigintToHex(
                BigInt(committedQuote.feeCommitment.amountSent) - BigInt(committedQuote.feeAmount),
            ),
            estimatedOutput: swapQuote.toAmount,
            swapTarget: routing.swapTarget,
            approvalAddress: routing.approvalAddress,
            dustRecipient: effectiveDustRecipient,
            // In swapInputToken units: what the committed net redeems/withdraws to, minus the
            // fixed LiFi input. For a yield share this is the underlying dust at the quoted
            // rate; on-chain accrual after this point only grows it.
            dustAmount: bigintToHex(committedSwapInput - BigInt(swapQuote.fromAmount)),
            swapInputToken,
            toChainId: destinationChainId,
        };
    }

    /**
     * @inheritdoc IPoolSessionWithdrawAndSwap.relayWithdrawAndSwap
     * @throws {InvalidTransactParams} When commitment validation fails or the signed routing diverges.
     * @throws {FeeCommitmentExpired} When the fee commitment has already expired.
     */
    async relayWithdrawAndSwap(
        params: ExecuteWithdrawAndSwapRelayerParams<TAddress>,
    ): Promise<TxReceipt<TLog>> {
        const {
            inputCommitments,
            amount,
            tokenId,
            recipientAddress,
            fallbackAddress,
            swapCalldata,
            selectedQuote,
            toChainId,
            dustRecipient,
        } = params;

        const isCrossChain =
            toChainId !== undefined && toChainId !== selectedQuote.relayerInfo.chainId;

        if (isCrossChain) {
            if (!fallbackAddress) {
                throw new InvalidTransactParams(
                    "fallbackAddress is required for cross-chain swaps — destination-chain address receiving bridged tokens if the destination swap fails",
                );
            }
            if (this.addressEqualityComparator.equals(fallbackAddress, this.emptyAddress)) {
                throw new InvalidTransactParams(
                    "fallbackAddress must not be the empty-address sentinel (bridged funds would be unrecoverable on a failed destination swap)",
                );
            }
            if (BigInt(params.minOutputAmount) !== 0n) {
                throw new InvalidTransactParams(
                    "minOutputAmount must be 0 for cross-chain swaps — the source chain cannot verify destination output; slippage protection lives in the proof-bound aggregator calldata",
                );
            }
        }

        // A relayed withdraw-and-swap executes via `RelaySwaps.execute()`, which calls
        // `PoolVault.transact()` internally — so `msg.sender` there is RelaySwaps, not
        // `relayerInfo.processorAddress` (that field means the withdrawal-only relay contract
        // for plain withdraw — a different, unrelated on-chain identity for this operation).
        const transactParams = {
            processor: this.requireRelaySwapsAddress(),
            data: selectedQuote.quote.feeCommitment.data,
        };

        this.assertRelayerChainMatchesPool(selectedQuote.relayerInfo.chainId);

        // Defense-in-depth: this method accepts hand-built params, so re-validate
        // the signed routing tuple even if prepareSwapQuote already did.
        const routing = this.swapChainAdapter.decodeSwapRouting(selectedQuote.quote.feeCommitment.data);

        this.assertSwapCalldataMatches(routing, swapCalldata);
        // Hand-built or tampered params never went through prepare's quote checks.
        await assertNoSwapExecutor(this.swapChainAdapter, {
            transactionTo: routing.swapTarget,
            approvalAddress: routing.approvalAddress,
            transactionData: routing.swapCalldata,
        });

        // Cross-chain: routing recipient must be the empty-address sentinel — the real
        // recipient is bound via the proof-bound aggregator calldata (assertSwapCalldataMatches).
        this.assertSwapRouting(routing, {
            recipient: isCrossChain ? this.emptyAddress : recipientAddress,
            fallbackAddress: fallbackAddress ?? recipientAddress,
            outputToken: params.outputToken,
            dustRecipient:
                dustRecipient ??
                (isCrossChain ? selectedQuote.relayerInfo.address : recipientAddress),
            feeAmount: selectedQuote.quote.feeAmount,
            minOutputAmount: BigInt(params.minOutputAmount),
            // Always validated: cross-chain forbids the top-up outright; same-chain
            // requires the routing to match the caller's extraGas opt-in (default
            // false → nativeGas must be 0). No skip path.
            extraGas: isCrossChain ? false : (params.extraGas ?? false),
            swapTarget: params.swapTarget,
            approvalAddress: params.approvalAddress,
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

        // amount here is the NET withdrawal (gross − fee); assertGrossWithdrawal expects
        // the gross, so we reconstitute it as amount + feeAmount.
        this.assertGrossWithdrawal(
            selectedQuote.quote,
            BigInt(amount) + BigInt(selectedQuote.quote.feeAmount),
        );

        const feeAmount = bigintToHex(BigInt(selectedQuote.quote.feeAmount));
        const amountOut = bigintToHex(BigInt(selectedQuote.quote.feeCommitment.amountSent));

        const { proof, notesData, changePendingNotes, spentNotes, spentNullifiers } =
            await this.core.prepareTransact({
                inputCommitments,
                amount,
                tokenId,
                recipientAddress,
                relayAddress: selectedQuote.relayerInfo.address,
                feeAmount,
                processorAddress: this.requireRelaySwapsAddress(),
                amountOut,
                transactParams,
            });

        const relayerResult = await this.relayerInteractor.relaySwap(selectedQuote.relayerInfo, {
            signedSwapCommitment: selectedQuote.quote.feeCommitment,
            proof,
            noteData: notesData,
            inputNullifierNumber: spentNotes.length,
            outputCommitmentNumber: changePendingNotes.length,
        });

        const txReceipt = await this.rpcInteractor.waitForTransactionReceipt(relayerResult);

        if (!txReceipt.status) return txReceipt;

        await this.core.persistNoteUpdates(spentNotes, changePendingNotes, txReceipt.txHash, {
            expectedNullifiers: spentNullifiers,
            receiptLogs: txReceipt.logs,
        });

        return txReceipt;
    }

    /**
     * Returns the configured RelaySwaps address — the on-chain identity that actually submits
     * `PoolVault.transact()` for a relayed withdraw-and-swap (see {@link PoolSessionWithdrawAndSwapConfig.relaySwapsAddress}).
     *
     * @throws {InvalidTransactParams} If `relaySwapsAddress` was not configured.
     */
    private requireRelaySwapsAddress(): TAddress {
        if (!this.relaySwapsAddress) {
            throw new InvalidTransactParams(
                "relaySwapsAddress must be configured to use withdraw-and-swap",
            );
        }
        return this.relaySwapsAddress;
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
     * withdrawal — preventing a relayer from inflating the pool outflow and sweeping
     * the difference as uncapped dust to `dustRecipient`.
     *
     * @throws {InvalidTransactParams} If `amountSent` differs from the requested gross withdrawal.
     */
    private assertGrossWithdrawal(committedQuote: SwapRelayerQuote<TAddress>, amount: bigint): void {
        if (BigInt(committedQuote.feeCommitment.amountSent) !== BigInt(amount)) {
            throw new InvalidTransactParams(
                `Committed amountSent ${committedQuote.feeCommitment.amountSent} does not match requested gross withdrawal ${BigInt(amount)}`,
                // The note being withdrawn, not the token the swap outputs.
                {
                    code: "commitmentAmountSentMismatch",
                    side: "spent",
                    values: {
                        amountSent: BigInt(committedQuote.feeCommitment.amountSent),
                        expected: BigInt(amount),
                    },
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
                // token and not in the token the swap outputs.
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
     * Confirms — via the injected `swapChainAdapter` — that `transactionData` encodes
     * `recipientAddress` as the swap output recipient, before the calldata is proof-bound in the
     * committed relayer quote.
     *
     * For same-chain paths the on-chain balance-delta guard provides a fund-safety
     * backstop (the transaction reverts). For cross-chain paths there is no
     * on-chain backstop — this is the only pre-proof defense.
     *
     * @throws {LiFiRecipientNotFound} If the embedded recipient differs from `recipientAddress`.
     */
    private async assertRecipientIsEmbeddedInQuote(
        transactionData: Hex,
        transactionTo: TAddress,
        recipientAddress: TAddress,
        isCrossChain: boolean,
    ): Promise<void> {
        const embeddedRecipient = await this.swapChainAdapter.extractEmbeddedRecipient(
            transactionData,
            transactionTo,
            isCrossChain,
        );
        if (!this.addressEqualityComparator.equals(embeddedRecipient, recipientAddress)) {
            throw new LiFiRecipientNotFound(
                String(recipientAddress),
                String(embeddedRecipient),
                this.chainId,
            );
        }
    }

    /**
     * Asserts the aggregator's quote actually routes the requested tokens and chains.
     * Runs before the calldata is proof-bound.
     *
     * @throws {SwapQuoteMismatch} If any routed field differs from the request.
     */
    private assertSwapQuoteMatchesRequest(
        quote: SwapQuoteResult<TAddress>,
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
     * Asserts every field of the relayer-signed routing tuple against the
     * caller's expectations: recipient, fallbackAddress, outputToken,
     * dustRecipient, feeAmount, minOutputAmount, extraGas, and optionally
     * swapTarget / approvalAddress (when a swap quote is in scope).
     *
     * @throws {InvalidTransactParams} If any field diverges.
     */
    private assertSwapRouting(
        routing: SwapRouting<TAddress>,
        expected: {
            recipient: TAddress;
            fallbackAddress: TAddress;
            outputToken: TAddress;
            dustRecipient: TAddress;
            feeAmount: string;
            minOutputAmount: bigint;
            extraGas: boolean;
            swapTarget?: TAddress;
            approvalAddress?: TAddress;
        },
    ): void {
        if (!this.addressEqualityComparator.equals(routing.recipient, expected.recipient)) {
            throw new InvalidTransactParams(
                `Relayer swapCommitment recipient ${routing.recipient} does not match caller recipientAddress ${expected.recipient}`,
            );
        }
        if (!this.addressEqualityComparator.equals(routing.fallbackAddress, expected.fallbackAddress)) {
            throw new InvalidTransactParams(
                `Relayer swapCommitment fallbackAddress ${routing.fallbackAddress} does not match expected ${expected.fallbackAddress}`,
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
        if (routing.minOutputAmount !== expected.minOutputAmount) {
            throw new InvalidTransactParams(
                `Relayer swapCommitment minOutputAmount ${routing.minOutputAmount} does not match expected ${expected.minOutputAmount}`,
            );
        }
        // The top-up amount is relayer-computed (extraGas flag), so the caller can
        // only pin its presence: flag off → routing must carry 0; flag on → routing
        // must carry a nonzero relayer-funded amount (a zeroed-out top-up would mean
        // the user pre-paid for gas the recipient never receives). The amount itself
        // is bounded by the fee checks (assertFeeWithinBounds folds it into feeAmount).
        if (!expected.extraGas && routing.nativeGas !== 0n) {
            throw new InvalidTransactParams(
                `Relayer swapCommitment nativeGas ${routing.nativeGas} must be 0 when extraGas was not requested`,
            );
        }
        if (expected.extraGas && routing.nativeGas === 0n) {
            throw new InvalidTransactParams(
                "Relayer swapCommitment nativeGas is 0 although extraGas was requested — the recipient would receive no gas top-up",
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
