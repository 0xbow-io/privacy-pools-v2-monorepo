import type { ZodType } from "zod";

import type {
    Address,
    EVMProof,
    ExecuteRegisterAndWithdrawRelayerParams,
    ExecuteWithdrawRelayerParams,
    Hex,
    ILogger,
    IPayoutRoutingCodec,
    IPoolSessionKeystore,
    IPoolSessionWithdraw,
    IPreparedTxVerifier,
    IRelayerInteractor,
    ITxReceiptWaiter,
    ITransactOrchestrator,
    PoolSessionWithdrawConfig,
    PoolSessionWithdrawDependencies,
    PreparedRelayedRegistration,
    PreparedTransaction,
    PrepareRegisterAndWithdrawResult,
    PrepareTransactParams,
    PrepareTransactResult,
    PrepareWithdrawRelayerQuotes,
    PrepareWithdrawResult,
    TxLog,
    TxReceipt,
    WithdrawParams,
} from "../../internal.js";
import {
    assertDecodedPayoutRoutingMatchesQuote,
    assertFeeCommitmentLive,
    bigintToHex,
    InvalidTransactParams,
    makeWithdrawParamsSchema,
    RegistrationDeadlineInPast,
    settleWithdrawRelayerQuotes,
} from "../../internal.js";

/**
 * Orchestrates the transact flow for public withdrawals (amountOut > 0), generic over the
 * chain's prepared-transaction type `TTx`, address type `TAddress`, and on-chain proof type
 * `TProof`.
 *
 * A public withdrawal moves value out of the pool to the PrivacyPoolRelay
 * processor, which deducts the fee from amountOut, sends it to feeRecipient,
 * and forwards the remaining amount to the recipient address.
 *
 * `executeWithdraw` verifies the prepared transaction via the injected `preparedTxVerifier`
 * ({@link IPreparedTxVerifier}); `buildGuardedWithdrawTransact` decodes the relayer's fee
 * commitment via the injected `payoutRoutingCodec` ({@link IPayoutRoutingCodec}) rather than
 * calling EVM-only guards directly. The `registerAndWithdraw`/`prepareRegisterAndWithdrawRelay`
 * flows still go through the concrete, EVM-only `IPoolSessionKeystore`'s EIP-712 `SetAuthPolicy`
 * signing — a Stellar keystore registration would need an entirely different signing scheme, not
 * just a cast, so that stays a documented EVM-only boundary rather than being genericized here.
 */
export class PoolSessionWithdraw<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionWithdraw<TTx, TAddress, TProof, TLog>
{
    private readonly core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    private readonly relayerInteractor: IRelayerInteractor<TAddress>;
    private readonly rpcInteractor: ITxReceiptWaiter<TLog>;
    private readonly keystore?: IPoolSessionKeystore;
    private readonly preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    private readonly payoutRoutingCodec: IPayoutRoutingCodec<TAddress>;
    private readonly withdrawParamsSchema: ReturnType<
        typeof makeWithdrawParamsSchema<TAddress & string>
    >;
    private readonly logger?: ILogger;

    constructor(
        config: PoolSessionWithdrawConfig<TTx, TAddress, TProof, TLog>,
        deps?: PoolSessionWithdrawDependencies,
    ) {
        this.core = config.core;
        this.relayerInteractor = config.relayerInteractor;
        this.rpcInteractor = config.rpcInteractor;
        this.keystore = config.keystore;
        this.preparedTxVerifier = config.preparedTxVerifier;
        this.payoutRoutingCodec = config.payoutRoutingCodec;
        this.withdrawParamsSchema = makeWithdrawParamsSchema(
            config.addressSchema as ZodType<TAddress & string>,
            config.emptyAddress as TAddress & string,
        );
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.prepareWithdraw
     * @throws {InvalidTransactParams} When the parameters fail validation.
     * @throws {TransactNoteNotActive} When an input note is not ACTIVE.
     * @throws {InsufficientTransactValue} When input notes don't cover the withdrawal amount.
     */
    async prepareWithdraw(
        params: WithdrawParams<TAddress>,
    ): Promise<PrepareWithdrawResult<TTx, TAddress>> {
        const validatedParams = this.withdrawParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new InvalidTransactParams(validatedParams.error.issues[0].message);
        }

        const { tokenId, amount, recipientAddress, feeAmount, extraGas } = validatedParams.data;

        // Wait for the keystore + state-tree leaf caches to finish warming BEFORE
        // requesting the committed quote below — that's what starts the relayer's
        // short-lived commitment clock. Usually a no-op; only waits if a scan is
        // still genuinely in flight (same fix as PoolSessionReshieldCrosschain).
        await this.core.warmMerkleCaches();

        const relayerQuotes = await this.getWithdrawRelayerQuotes(
            tokenId,
            recipientAddress,
            amount,
            extraGas,
        );

        const amountOut = bigintToHex(BigInt(amount) + BigInt(feeAmount ?? "0x0"));

        // Cast through the schema-validated data (not the raw params) so the relayAddress/
        // feeAmount/processorAddress defaults WithdrawParamsSchema fills in are preserved —
        // same EVM-schema-boundary pattern as NoteManager.importState.
        const { changePendingNotes, transactTx, spentNotes, spentNullifiers } =
            await this.core.prepareTransact({
                ...(validatedParams.data as WithdrawParams<TAddress>),
                amountOut,
            } as PrepareTransactParams<TAddress>);

        return {
            changePendingNotes,
            transactTx,
            spentNotes,
            spentNullifiers,
            relayerOptions: this.prepareWithdrawRelayerOptions(params, relayerQuotes),
        };
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.relayWithdraw
     * @throws {PoolSessionTransactBaseError} When relay execution fails.
     */
    async relayWithdraw(params: ExecuteWithdrawRelayerParams<TAddress>): Promise<TxReceipt<TLog>> {
        const { selectedQuote } = params;

        const { proof, notesData, changePendingNotes, spentNotes, spentNullifiers } =
            await this.buildGuardedWithdrawTransact(params, false);

        const relayerResult = await this.relayerInteractor.relayWithdrawal(
            selectedQuote.relayerInfo,
            {
                signedFeeCommitment: selectedQuote.quote.feeCommitment,
                proof,
                noteData: notesData,
                inputNullifierNumber: spentNotes.length,
                outputCommitmentNumber: changePendingNotes.length,
            },
        );

        const txRecipt = await this.rpcInteractor.waitForTransactionReceipt(relayerResult);

        if (!txRecipt.status) return txRecipt;

        await this.core.persistNoteUpdates(spentNotes, changePendingNotes, txRecipt.txHash, {
            expectedNullifiers: spentNullifiers,
            receiptLogs: txRecipt.logs,
        });

        return txRecipt;
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.prepareRegisterAndWithdrawRelay
     * @throws {InvalidTransactParams} When the registration is unsigned, the quote is invalid, or
     *   the quoted asset does not match the withdrawn token.
     * @throws {RegistrationDeadlineInPast} When the registration signature's deadline has passed.
     * @throws {FeeCommitmentExpired} When the signed fee commitment has already expired.
     */
    async prepareRegisterAndWithdrawRelay(
        params: ExecuteWithdrawRelayerParams<TAddress>,
        registration: PreparedRelayedRegistration<TAddress>,
    ): Promise<PrepareRegisterAndWithdrawResult<TAddress>> {
        if (registration.signature === null) {
            throw new InvalidTransactParams(
                "Relayed registration is unsigned; sign the typed-data payload before assembling registerAndRelay",
            );
        }

        // Fail fast on an already-expired registration signature, before the ~30-60s proof
        // generation below. The contract enforces `block.timestamp <= deadline`
        // (Keystore_SignatureExpired), so an expired deadline would otherwise burn proof-gen
        // time only to produce a registerAndRelay request the relayer must reject on-chain.
        // Mirrors the fee-commitment liveness check in buildGuardedWithdrawTransact.
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (BigInt(registration.deadline) <= BigInt(nowSeconds)) {
            throw new RegistrationDeadlineInPast(registration.deadline, nowSeconds);
        }

        const { selectedQuote } = params;

        // Build the withdrawal proof against the PREDICTED post-insertion keystore root: the
        // account's leaf is inserted by the relayer's registerAndRelay in the SAME transaction, so
        // the current on-chain tree does not yet contain it. Same fee guards as relayWithdraw.
        const { proof, notesData, changePendingNotes, spentNotes } =
            await this.buildGuardedWithdrawTransact(params, true);

        const relayParams = {
            signedFeeCommitment: selectedQuote.quote.feeCommitment,
            proof,
            noteData: notesData,
            inputNullifierNumber: spentNotes.length,
            outputCommitmentNumber: changePendingNotes.length,
            registration: {
                account: registration.account,
                authDigest: registration.authDigest,
                nullifyingKeyHash: registration.nullifyingKeyHash,
                deadline: registration.deadline,
                signature: registration.signature,
            },
        };

        return {
            relayer: selectedQuote.relayerInfo,
            relayParams,
            spentNotes,
            changePendingNotes,
        };
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.registerAndWithdraw
     * @throws {InvalidTransactParams} When no keystore is wired, the account is already
     *   registered, the quote is stale/mismatched, or the fee commitment asset differs from token.
     * @throws {RegistrationDeadlineInPast} When the registration signature's deadline has passed.
     * @throws {FeeCommitmentExpired} When the signed fee commitment has already expired.
     */
    async registerAndWithdraw(
        params: ExecuteRegisterAndWithdrawRelayerParams<TAddress>,
    ): Promise<TxReceipt<TLog>> {
        const { selectedQuote, signature, deadline } = params;

        if (!this.keystore) {
            throw new InvalidTransactParams(
                "registerAndWithdraw requires a keystore session; construct PoolSessionWithdraw with a keystore",
            );
        }

        // The relayed registration inserts a fresh leaf; if the account is already registered the
        // on-chain setAuthPolicyWithSig reverts (AuthPolicyAlreadySet) and the appended predicted
        // leaf would be a duplicate. Use relayWithdraw instead.
        if (await this.keystore.isKeystoreRegistered()) {
            throw new InvalidTransactParams(
                "Account is already registered; use relayWithdraw instead of registerAndWithdraw",
            );
        }

        // Fail fast on an already-expired signature deadline, before the ~30-60s proof generation
        // below. The contract enforces `block.timestamp <= deadline` (Keystore_SignatureExpired),
        // so an expired deadline would otherwise burn proof-gen time only to be rejected on-chain.
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (BigInt(deadline) <= BigInt(nowSeconds)) {
            throw new RegistrationDeadlineInPast(deadline, nowSeconds);
        }

        // Build the withdrawal proof against the PREDICTED post-insertion keystore root: the
        // account's leaf is inserted by the relayer's registerAndRelay in the SAME transaction, so
        // the current on-chain tree does not yet contain it. Same fee guards as relayWithdraw.
        const { proof, notesData, changePendingNotes, spentNotes, spentNullifiers } =
            await this.buildGuardedWithdrawTransact(params, true);

        // Rebuild the exact typed data the integrator signed (bound to `deadline`); its message
        // carries the account/authDigest/nullifyingKeyHash the signature commits to, so the relayer
        // receives registration values consistent with the signature.
        const { message } = this.keystore.buildSetAuthPolicyTypedData(deadline);
        const registration = {
            account: message.account as TAddress,
            authDigest: bigintToHex(message.authDigest),
            nullifyingKeyHash: bigintToHex(message.nullifyingKeyHash),
            deadline,
            signature,
        };

        const relayerResult = await this.relayerInteractor.relayRegisterAndWithdrawal(
            selectedQuote.relayerInfo,
            {
                signedFeeCommitment: selectedQuote.quote.feeCommitment,
                proof,
                noteData: notesData,
                inputNullifierNumber: spentNotes.length,
                outputCommitmentNumber: changePendingNotes.length,
                registration,
            },
        );

        const txReceipt = await this.rpcInteractor.waitForTransactionReceipt(relayerResult);

        if (!txReceipt.status) return txReceipt;

        await this.core.persistNoteUpdates(spentNotes, changePendingNotes, txReceipt.txHash, {
            expectedNullifiers: spentNullifiers,
            receiptLogs: txReceipt.logs,
        });

        return txReceipt;
    }

    /**
     * Runs the shared fee/routing guards on the selected relayer quote and builds the withdrawal
     * transact proof. `pendingKeystoreRegistration` selects the predicted-post-insertion keystore
     * root (bundled registerAndRelay) vs. the current on-chain root (plain relayed withdrawal).
     *
     * @throws {FeeCommitmentExpired} When the fee commitment has expired.
     * @throws {InvalidTransactParams} When routing/amount/asset checks fail.
     */
    private async buildGuardedWithdrawTransact(
        params: ExecuteWithdrawRelayerParams<TAddress>,
        pendingKeystoreRegistration: boolean,
    ): Promise<PrepareTransactResult<TTx, TAddress>> {
        const { inputCommitments, amount, tokenId, recipientAddress, selectedQuote, extraGas } =
            params;

        // Fail fast on an already-expired quote, before the expensive prepareTransact below. The
        // relayer also rechecks at submission (catching expiry during proof gen).
        assertFeeCommitmentLive(selectedQuote.quote.feeCommitment.expiration);

        const transactParams = {
            processor: selectedQuote.relayerInfo.processorAddress,
            data: selectedQuote.quote.feeCommitment.data,
        };

        // The top-up amount is relayer-computed and priced into feeAmount, so the
        // caller can only pin its PRESENCE: requested → the routing must carry a
        // non-zero nativeGas (a zeroed top-up would mean the user paid for gas the
        // recipient never receives); not requested → it must carry 0.
        const decodedPayoutRouting = this.payoutRoutingCodec.decode(
            selectedQuote.quote.feeCommitment.data,
        );
        assertDecodedPayoutRoutingMatchesQuote(
            decodedPayoutRouting,
            recipientAddress,
            BigInt(selectedQuote.quote.feeAmount),
            { requested: extraGas ?? false },
        );

        this.assertAmountSentMatchesAmountPlusFee(
            selectedQuote.quote.amountSent,
            amount,
            selectedQuote.quote.feeAmount,
        );

        // The relayer's signed commitment must be for the withdrawn token, otherwise the proof
        // binds a commitment for a different asset.
        // NOTE: feeCommitment.asset is a wire-protocol `Hex` field (always hex-encoded
        // regardless of chain), not `TAddress` — a plain string compare, not
        // addressEqualityComparator, until the relayer wire protocol itself is genericized.
        const quotedAsset = selectedQuote.quote.feeCommitment.asset;
        if (String(quotedAsset).toLowerCase() !== String(tokenId).toLowerCase()) {
            throw new InvalidTransactParams(
                `feeCommitment.asset ${quotedAsset} does not match withdraw tokenId ${tokenId}`,
            );
        }

        const feeAmount = bigintToHex(BigInt(selectedQuote.quote.feeAmount));
        const amountOut = bigintToHex(BigInt(selectedQuote.quote.amountSent));

        return this.core.prepareTransact({
            inputCommitments,
            amount,
            tokenId,
            recipientAddress,
            relayAddress: selectedQuote.relayerInfo.address,
            feeAmount,
            processorAddress: selectedQuote.relayerInfo.processorAddress,
            amountOut,
            transactParams,
            pendingKeystoreRegistration,
        });
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.withdraw
     */
    async withdraw(params: WithdrawParams<TAddress>): Promise<TxReceipt<TLog>> {
        // The top-up is relayer-funded (PrivacyPoolRelay takes it as msg.value from the
        // relayer). A self-submitted transact carries value 0 and has no relayer, so
        // accepting the flag here would be the same silent no-op this option exists to
        // remove. Callers who want the top-up go through prepareWithdraw + relayWithdraw.
        if (params.extraGas) {
            throw new InvalidTransactParams(
                "extraGas is relayer-funded and cannot be honoured by a self-submitted withdrawal; use prepareWithdraw + relayWithdraw",
            );
        }
        const result = await this.prepareWithdraw(params);
        return this.executeWithdraw(result);
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.executeWithdraw
     */
    async executeWithdraw(result: PrepareWithdrawResult<TTx, TAddress>): Promise<TxReceipt<TLog>> {
        this.preparedTxVerifier.assertMatches(result.transactTx, {
            to: this.core.poolAddress,
            operation: "transact",
        });

        const txHash = await this.core.submit(result.transactTx);

        const txReceipt = await this.rpcInteractor.waitForTransactionReceipt(txHash);

        if (!txReceipt.status) return txReceipt;

        await this.core.persistNoteUpdates(
            result.spentNotes,
            result.changePendingNotes.filter((p) => p.isOwned),
            txReceipt.txHash,
            { expectedNullifiers: result.spentNullifiers, receiptLogs: txReceipt.logs },
        );

        return txReceipt;
    }

    /**
     * Asserts the relayer-quoted `amountSent` (the value the user's proof
     * commits to releasing from the pool) equals `amount + feeAmount`. A
     * mismatch means a malicious relayer inflated `amountSent` so the proof
     * authorizes a larger pool outflow than the caller intended; if the
     * relayer also inflates the encoded `data.feeAmount` symmetrically, the
     * recipient still receives `amount` but the relayer skims the inflation
     * delta as fee — and the caller's change note is silently smaller.
     * Strict equality matches the self-submit path's local computation.
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
                {
                    code: "commitmentAmountSentMismatch",
                    side: "spent",
                    values: { amountSent: actual, expected },
                },
            );
        }
    }

    private getWithdrawRelayerQuotes = (
        tokenId: TAddress,
        recipient: TAddress,
        amount: Hex,
        extraGas: boolean,
    ): Promise<PrepareWithdrawRelayerQuotes<TAddress>[]> =>
        settleWithdrawRelayerQuotes(
            this.relayerInteractor,
            {
                asset: tokenId,
                commit: true,
                recipient,
                extraGas,
                amount: BigInt(amount).toString(),
            },
            this.logger,
        );

    private prepareWithdrawRelayerOptions(
        inputParams: WithdrawParams<TAddress>,
        relayerQuotes: PrepareWithdrawRelayerQuotes<TAddress>[],
    ): ExecuteWithdrawRelayerParams<TAddress>[] {
        // Carry the caller's opt-in onto every option so relayWithdraw's routing
        // guard checks the commitment against what was actually requested.
        const extraGas = inputParams.extraGas ?? false;
        return relayerQuotes.map(({ relayerInfo, quote }) => ({
            inputCommitments: inputParams.inputCommitments,
            amount: inputParams.amount,
            tokenId: inputParams.tokenId,
            recipientAddress: inputParams.recipientAddress,
            selectedQuote: { relayerInfo, quote },
            extraGas,
        }));
    }
}
