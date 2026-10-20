import type {
    Address,
    DecodedPayoutRouting,
    EVMProof,
    Hex,
    IAddressEqualityComparator,
    ILogger,
    IPayoutRoutingCodec,
    IPoolSessionYieldWithdraw,
    ITransactOrchestrator,
    IYieldRouterCodec,
    IYieldRouterInteractor,
    PoolSessionYieldWithdrawConfig,
    PoolSessionYieldWithdrawDependencies,
    PreparedTransaction,
    TxLog,
    PreparedYieldWithdraw,
    PreparedYieldWithdrawRelay,
    TransactParams,
    WithdrawalRelayParams,
    YieldDeploymentConfig,
    YieldWithdrawParams,
    YieldWithdrawRelayParams,
} from "../../internal.js";
import {
    assertDecodedPayoutRoutingMatchesQuote,
    assertFeeCommitmentLive,
    bigintToHex,
    InvalidTransactParams,
    InvalidYieldAddress,
    InvalidYieldAmount,
    WITHDRAW_SLIPPAGE_BPS,
    YIELD_BPS_DENOMINATOR,
} from "../../internal.js";

/**
 * {@link IPoolSessionYieldWithdraw} implementation, chain-agnostic. Builds the standard withdraw
 * proof with the router bound as the processor and the `PayoutRouting` bound into the proof
 * context, then either hands the transact to the chain's {@link IYieldRouterCodec} (self-submit) or
 * returns typed relayer params carrying the router as `processorAddress` (relayed).
 */
export class PoolSessionYieldWithdraw<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionYieldWithdraw<TTx, TAddress> {
    private readonly deployment: YieldDeploymentConfig<TAddress>;
    private readonly orchestrator: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    private readonly router: IYieldRouterInteractor<TAddress>;
    private readonly codec: IYieldRouterCodec<TTx, TAddress>;
    private readonly payoutRoutingCodec: IPayoutRoutingCodec<TAddress>;
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly emptyAddress: TAddress;
    private readonly logger?: ILogger;

    constructor(
        config: PoolSessionYieldWithdrawConfig<TTx, TAddress, TProof, TLog>,
        deps?: PoolSessionYieldWithdrawDependencies,
    ) {
        this.deployment = config.deployment;
        this.orchestrator = config.orchestrator;
        this.router = config.router;
        this.codec = config.codec;
        this.payoutRoutingCodec = config.payoutRoutingCodec;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.emptyAddress = config.emptyAddress;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionYieldWithdraw.prepareYieldWithdraw
     * @throws {InvalidYieldAddress} When `recipient` is the empty address.
     * @throws {InvalidYieldAmount} When an amount is non-positive or the fee exceeds `amountOut`.
     * @throws {UnexpectedWithdrawCalldata} When the codec cannot read the base transact transaction.
     */
    async prepareYieldWithdraw(
        params: YieldWithdrawParams<TAddress>,
    ): Promise<PreparedYieldWithdraw<TTx, TAddress>> {
        this.assertRecipient(params.recipient);
        const amountOutShares = this.parsePositive(params.amountOut, "amountOut");
        const feeShares = this.parseNonNegative(params.feeAmount ?? 0n, "feeAmount");
        if (feeShares > amountOutShares) {
            throw new InvalidYieldAmount(
                `feeAmount (${feeShares}) exceeds amountOut (${amountOutShares})`,
                // Share-denominated: the relayer fee on this route is taken in shares and converted
                // pro-rata on-chain, so neither figure is in the underlying the recipient receives.
                {
                    code: "yieldFeeExceedsAmountOut",
                    side: "spent",
                    values: { fee: feeShares, amountOut: amountOutShares },
                },
            );
        }
        const recipientShares = amountOutShares - feeShares;

        const nativeGas = params.nativeGas ?? 0n;
        if (nativeGas < 0n) {
            throw new InvalidYieldAmount(`nativeGas must be >= 0, got ${nativeGas}`);
        }
        const nativeGasHex = `0x${nativeGas.toString(16)}` as Hex;
        const feeRecipient = params.feeRecipient ?? params.recipient;

        // Validate slippage up front so bad input is rejected before the expensive proof build.
        const slippageBps = this.parseSlippage(params.slippageBps);

        // Bind the payout routing into the proof context so a submitter cannot tamper with it.
        const transactParams: TransactParams<TAddress> = {
            processor: this.deployment.router,
            data: this.payoutRoutingCodec.encode({
                recipient: params.recipient,
                feeRecipient,
                feeAmount: feeShares,
                nativeGas,
            }),
        };

        // Build the standard withdraw proof with the router as processor.
        const tx = await this.orchestrator.prepareTransact({
            inputCommitments: params.inputCommitments,
            amount: bigintToHex(params.amount),
            tokenId: this.deployment.shareToken,
            relayAddress: this.deployment.router,
            feeAmount: bigintToHex(feeShares),
            processorAddress: this.deployment.router,
            amountOut: bigintToHex(amountOutShares),
            recipientAddress: params.recipient,
            nativeGas: nativeGasHex,
            feeRecipient,
            transactParams,
        });

        // Size the recipient slippage floor from the router quote.
        const quotedUnderlyingOut = await this.router.quoteWithdraw(recipientShares);
        const minUnderlyingOut =
            (quotedUnderlyingOut * (YIELD_BPS_DENOMINATOR - slippageBps)) / YIELD_BPS_DENOMINATOR;

        // Re-target at the router's withdraw-to-underlying — same proof context, plus unwrap + floor.
        const withdrawTx = await this.codec.encodeWithdrawToUnderlying(tx.transactTx, {
            deployment: this.deployment,
            minUnderlyingOut,
            nativeGas,
        });

        this.logger?.debug("prepared yield withdraw", {
            recipientShares: recipientShares.toString(),
            quotedUnderlyingOut: quotedUnderlyingOut.toString(),
            minUnderlyingOut: minUnderlyingOut.toString(),
        });

        return {
            withdrawTx,
            changePendingNotes: tx.changePendingNotes,
            spentNotes: tx.spentNotes,
            recipientShares,
            quotedUnderlyingOut,
            minUnderlyingOut,
        };
    }

    /**
     * @inheritdoc IPoolSessionYieldWithdraw.prepareYieldWithdrawRelay
     * @throws {InvalidYieldAddress} When `recipient` is the empty address.
     * @throws {InvalidYieldAmount} When `amountOut` is malformed/non-positive or `slippageBps` is out of range.
     * @throws {InvalidTransactParams} When the signed commitment's asset, amounts or routing diverge
     *   from the caller's intent.
     * @throws {FeeCommitmentExpired} When the signed commitment has already expired.
     */
    async prepareYieldWithdrawRelay(
        params: YieldWithdrawRelayParams<TAddress>,
    ): Promise<PreparedYieldWithdrawRelay<TAddress>> {
        this.assertRecipient(params.recipient);
        // Validate amountOut up front so bad input is rejected before the expensive proof build.
        const amountOutShares = this.parsePositive(params.amountOut, "amountOut");
        const slippageBps = this.parseSlippage(params.slippageBps);

        // Fail fast on an already-expired commitment, before the expensive proof build. The relayer
        // rechecks at submission too.
        assertFeeCommitmentLive(params.signedFeeCommitment.expiration);

        // SECURITY: the proof below binds the relayer's PayoutRouting verbatim, and supplying
        // `transactParams` bypasses the orchestrator's own recipient handling — so `params.recipient`
        // is NOT otherwise enforced on-chain, and the router takes no signed commitment to check.
        // Without this guard a malicious relayer could encode its own address as the routing
        // `recipient` and the user would authorize a proof paying the attacker. Bind the signed
        // routing to the caller's intent up front (mirrors PoolSessionWithdraw.relayWithdraw): the
        // committed asset must be the share, the routing recipient must equal the caller's
        // recipient, the routing fee must equal the quoted fee, and the native-gas top-up must be
        // present iff the caller asked the relayer for it (`extraGas`).
        // NOTE: feeCommitment.asset is a wire-protocol string, compared case-insensitively as the
        // plain relayed-withdraw path does.
        if (
            String(params.signedFeeCommitment.asset).toLowerCase() !==
            String(this.deployment.shareToken).toLowerCase()
        ) {
            throw new InvalidTransactParams(
                `signedFeeCommitment.asset ${String(params.signedFeeCommitment.asset)} does not match share token ${String(this.deployment.shareToken)}`,
            );
        }
        // Parse the relayer-supplied commitment amounts into typed non-negative bigints (they are
        // plain strings on the wire and are otherwise fed straight to BigInt(), which throws untyped
        // on malformed input and treats "" as 0).
        const feeShares = this.parseCommitmentAmount(params.signedFeeCommitment.feeAmount, "feeAmount");
        const amountSentShares = this.parseCommitmentAmount(
            params.signedFeeCommitment.amountSent,
            "amountSent",
        );
        // The committed total-out must equal the caller's amountOut, and the fee cannot exceed it —
        // else the relayer's own on-chain submit reverts AFTER the expensive proof build. Fail fast.
        if (amountSentShares !== amountOutShares) {
            throw new InvalidTransactParams(
                `signedFeeCommitment.amountSent ${amountSentShares} does not match amountOut ${amountOutShares}`,
                {
                    code: "commitmentAmountSentMismatch",
                    side: "spent",
                    values: { amountSent: amountSentShares, expected: amountOutShares },
                },
            );
        }
        if (feeShares > amountOutShares) {
            throw new InvalidTransactParams(
                `signedFeeCommitment.feeAmount ${feeShares} exceeds amountOut ${amountOutShares}`,
                {
                    code: "commitmentFeeExceedsAmountOut",
                    side: "spent",
                    values: { fee: feeShares, amountOut: amountOutShares },
                },
            );
        }
        // The top-up amount is relayer-computed and priced into `feeAmount`, so only its PRESENCE
        // can be pinned here. The router forwards exactly the committed `nativeGas`, which the
        // submitting relayer attaches, so an inflated amount costs the relayer, never the user.
        assertDecodedPayoutRoutingMatchesQuote(
            this.decodeRouting(params.signedFeeCommitment.data),
            params.recipient,
            feeShares,
            { requested: params.extraGas ?? false },
        );

        // Bind the proof context to the relayer's signed PayoutRouting verbatim; the in-pool fee is
        // 0 because the router splits the relayer fee from the withdrawn shares after the exit.
        const transactParams: TransactParams<TAddress> = {
            processor: this.deployment.router,
            data: params.signedFeeCommitment.data,
        };

        const { proof, notesData, changePendingNotes, spentNotes } = await this.orchestrator.prepareTransact({
            inputCommitments: params.inputCommitments,
            amount: bigintToHex(params.amount),
            tokenId: this.deployment.shareToken,
            relayAddress: this.deployment.router,
            feeAmount: "0x0" as Hex,
            processorAddress: this.deployment.router,
            amountOut: bigintToHex(amountOutShares),
            recipientAddress: params.recipient,
            transactParams,
        });

        // Size the recipient slippage floor from the CALLER's own amountOut minus the guard-bound
        // committed fee — the on-chain recipient leg — NOT the relayer's unverified
        // `signedFeeCommitment.amountReceived`, which a relayer could under-report to size the
        // floor to ~0 and silently neuter the user's slippage protection.
        const recipientShares = amountOutShares - feeShares;
        const quotedUnderlyingOut = await this.router.quoteWithdraw(recipientShares);
        const minUnderlyingOut =
            (quotedUnderlyingOut * (YIELD_BPS_DENOMINATOR - slippageBps)) / YIELD_BPS_DENOMINATOR;

        const relayParams: WithdrawalRelayParams<TAddress> = {
            proof,
            noteData: notesData,
            signedFeeCommitment: params.signedFeeCommitment,
            inputNullifierNumber: spentNotes.length,
            outputCommitmentNumber: changePendingNotes.length,
            processorAddress: this.deployment.router,
            minUnderlyingOut: bigintToHex(minUnderlyingOut),
        };

        this.logger?.debug("prepared relayed yield withdraw", {
            recipientShares: recipientShares.toString(),
            quotedUnderlyingOut: quotedUnderlyingOut.toString(),
            minUnderlyingOut: minUnderlyingOut.toString(),
        });

        return {
            relayParams,
            changePendingNotes,
            spentNotes,
            recipientShares,
            quotedUnderlyingOut,
            minUnderlyingOut,
        };
    }

    /** @throws {InvalidYieldAddress} When `recipient` is the chain's empty address. */
    private assertRecipient(recipient: TAddress): void {
        if (this.addressEqualityComparator.equals(recipient, this.emptyAddress)) {
            throw new InvalidYieldAddress("withdraw recipient is the zero address");
        }
    }

    /** @throws {InvalidYieldAmount} When `value` is not strictly positive. */
    private parsePositive(value: bigint, label: string): bigint {
        const parsed = this.parseNonNegative(value, label);
        if (parsed <= 0n) {
            throw new InvalidYieldAmount(`${label} must be > 0, got ${parsed}`);
        }
        return parsed;
    }

    /** @throws {InvalidYieldAmount} When `value` is negative. */
    private parseNonNegative(value: bigint, label: string): bigint {
        if (value < 0n) {
            throw new InvalidYieldAmount(`${label} must be >= 0, got ${value}`);
        }
        return value;
    }

    /** @throws {InvalidYieldAmount} When the slippage is outside [0, 10000] bps. */
    private parseSlippage(slippageBps: bigint | undefined): bigint {
        const bps = slippageBps ?? WITHDRAW_SLIPPAGE_BPS;
        if (bps < 0n || bps > YIELD_BPS_DENOMINATOR) {
            throw new InvalidYieldAmount(`slippageBps out of range: ${bps}`);
        }
        return bps;
    }

    /** @throws {InvalidTransactParams} When the relayer's routing cannot be decoded. */
    private decodeRouting(data: Hex): DecodedPayoutRouting<TAddress> {
        try {
            return this.payoutRoutingCodec.decode(data);
        } catch (error) {
            throw new InvalidTransactParams(
                `Failed to decode relayer feeCommitment.data: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /** @throws {InvalidTransactParams} When a commitment amount is empty, malformed or negative. */
    private parseCommitmentAmount(value: string, field: string): bigint {
        if (value === undefined || value === null || value === "") {
            throw new InvalidTransactParams(`signedFeeCommitment.${field} is empty`);
        }
        let parsed: bigint;
        try {
            parsed = BigInt(value);
        } catch {
            throw new InvalidTransactParams(`signedFeeCommitment.${field} is not a valid integer: ${value}`);
        }
        if (parsed < 0n) {
            throw new InvalidTransactParams(`signedFeeCommitment.${field} is negative: ${value}`);
        }
        return parsed;
    }
}
