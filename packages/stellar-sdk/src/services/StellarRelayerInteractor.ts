import type {
    BatchWithdrawalQuoteParams,
    BatchWithdrawalRelayerQuote,
    BatchWithdrawalRelayParams,
    Hex,
    IHTTPClient,
    ILogger,
    IProofService,
    IRelayerInteractor,
    RegisterAndWithdrawalRelayParams,
    RegisterKeystoreRelayParams,
    RelayAndAnnounceRelayParams,
    RelayerChainDetails,
    RelayerEndpoint,
    RelayerInfo,
    StellarAddress,
    StellarProof,
    StellarRelayerInteractorConfig,
    StellarRelayerInteractorDependencies,
    SwapQuoteParams,
    SwapRelayerQuote,
    SwapRelayParams,
    TransferQuoteParams,
    TransferRelayerQuote,
    TransferRelayParams,
    UncommittedQuote,
    WithdrawalQuoteParams,
    WithdrawalRelayerQuote,
    WithdrawalRelayParams,
} from "../internal.js";
import {
    assertFeeCommitmentLive,
    InvalidRelayerConfig,
    makeRelayerAddressSchemas,
    makeRelayerChainDetailsSchemas,
    RelayerRejected,
    RelayerRequestFailed,
    stellarErrorMessage,
    StellarBatchQuoteResponseWireSchema,
    StellarTransferQuoteResponseWireSchema,
    StellarRelayResponseWireSchema,
    StellarWithdrawalQuoteResponseWireSchema,
} from "../internal.js";

/**
 * Stellar implementation of {@link IRelayerInteractor}, speaking the real relayer's wire protocol
 * — verified directly against `packages/relayer/relayer`'s actual Stellar routes/schemas
 * (`src/relay/stellar/`, `src/quote/stellar/`, `src/details/stellar.details.service.ts`), the
 * same package family and route convention as evm-sdk's `RelayerInteractor` (`/v1/quote/...`,
 * `/v1/relay/...`, `/v1/details/...`, versioned via NestJS URI versioning in the relayer's
 * `main.ts`).
 *
 * Relayed routes: withdrawal (including a yield withdrawal through the share's `yield-router`,
 * when `processorAddress` names it), batch withdrawal (the relay contract's `relay_batch`), and
 * private transfer. A relayed transfer's only public outflow is the relayer's fee: the proof
 * releases exactly `amountOut == feeAmount` and the relayer submits the pool's own `transact` as
 * the gated processor, which is paid that amount — the same shape as EVM, where the relayer calls
 * `PoolVault.transact` with itself as processor.
 *
 * Swaps and ERC-5564 stealth announcements have no Soroban counterpart and throw.
 */
export class StellarRelayerInteractor implements IRelayerInteractor<StellarAddress> {
    private readonly relayers: RelayerInfo<StellarAddress>[];
    private readonly httpClient: IHTTPClient;
    private readonly proofService: IProofService<StellarProof>;
    private readonly logger?: ILogger;
    private readonly schemas: ReturnType<typeof makeRelayerAddressSchemas<StellarAddress>>;
    private readonly chainDetailsSchemas: ReturnType<typeof makeRelayerChainDetailsSchemas<StellarAddress>>;

    /**
     * @throws {InvalidRelayerConfig} If the configuration is invalid.
     */
    constructor(
        config: StellarRelayerInteractorConfig,
        dependencies?: StellarRelayerInteractorDependencies,
    ) {
        this.schemas = makeRelayerAddressSchemas(config.addressSchema);
        this.chainDetailsSchemas = makeRelayerChainDetailsSchemas(config.addressSchema);

        const validated = this.schemas.relayerInteractorConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidRelayerConfig(
                `StellarRelayerInteractor initialization error: ${validated.error.issues[0]!.message}`,
            );
        }

        this.relayers = config.relayers;
        this.httpClient = config.httpClient;
        this.proofService = config.proofService;
        this.logger = dependencies?.logger;
        this.logger?.debug("StellarRelayerInteractor initialized", {
            relayerCount: this.relayers.length,
        });
    }

    /**
     * @inheritdoc IRelayerInteractor.getRelayers
     */
    async getRelayers(): Promise<RelayerInfo<StellarAddress>[]> {
        return this.relayers;
    }

    /**
     * @inheritdoc IRelayerInteractor.getChainDetails
     * @throws {RelayerRequestFailed} If the request fails or the response is malformed.
     */
    async getChainDetails(relayer: RelayerEndpoint): Promise<RelayerChainDetails<StellarAddress>> {
        try {
            this.logger?.debug("Requesting chain details from relayer...", { relayerUrl: relayer.url });
            const response = await this.httpClient.get<unknown>(
                `${relayer.url}/v1/details/${relayer.chainType}/${relayer.chainId}`,
            );
            const parsed = this.chainDetailsSchemas.relayerChainDetailsSchema.safeParse(response);
            if (!parsed.success) {
                throw new RelayerRequestFailed(
                    `Invalid chain details response: ${parsed.error.issues[0]!.message}`,
                );
            }
            if (parsed.data.id !== relayer.chainId) {
                throw new RelayerRequestFailed(
                    `Relayer answered for chain ${parsed.data.id}, asked for ${relayer.chainId}`,
                );
            }
            return parsed.data as RelayerChainDetails<StellarAddress>;
        } catch (error) {
            if (error instanceof RelayerRequestFailed) {
                throw error;
            }
            this.logger?.error("Failed to request chain details", { error });
            throw new RelayerRequestFailed(stellarErrorMessage(error));
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.getTransferQuote
     *
     * A relayed transfer's only public outflow is the relayer's fee (`amountOut == feeAmount`,
     * paid to the relayer as the pool's processor) — see the class doc.
     * @throws {RelayerRequestFailed} If the params, request or response are invalid, or the relayer
     *   returns no commitment.
     */
    async getTransferQuote(
        relayer: RelayerInfo<StellarAddress>,
        params: TransferQuoteParams<StellarAddress>,
    ): Promise<TransferRelayerQuote<StellarAddress>> {
        const validatedParams = this.schemas.transferQuoteParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRequestFailed(`Invalid transfer quote params: ${validatedParams.error.issues[0]!.message}`);
        }
        try {
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/quote/${relayer.chainType}/${relayer.chainId}/transfer`,
                { asset: validatedParams.data.asset, commit: validatedParams.data.commit },
            );
            const parsed = StellarTransferQuoteResponseWireSchema.safeParse(response);
            if (!parsed.success) {
                throw new RelayerRequestFailed(`Invalid transfer quote response: ${parsed.error.issues[0]!.message}`);
            }
            const commitment = parsed.data.feeCommitment;
            if (!commitment) {
                throw new RelayerRequestFailed("Relayer returned no fee commitment for a transfer quote");
            }
            return {
                txCost: parsed.data.txCost,
                gasPrice: parsed.data.gasPrice,
                feeAmount: parsed.data.feeAmount,
                feeCommitment: commitment,
            };
        } catch (error) {
            if (error instanceof RelayerRequestFailed) throw error;
            this.logger?.error("Failed to request transfer quote", { error });
            throw new RelayerRequestFailed(stellarErrorMessage(error));
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.getWithdrawalQuote
     * @throws {RelayerRequestFailed} If the quote request/response is invalid.
     */
    async getWithdrawalQuote(
        relayer: RelayerInfo<StellarAddress>,
        params: WithdrawalQuoteParams<StellarAddress>,
    ): Promise<WithdrawalRelayerQuote<StellarAddress>> {
        const validatedParams = this.schemas.withdrawalQuoteParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRequestFailed(
                `Invalid withdrawal quote params: ${validatedParams.error.issues[0]!.message}`,
            );
        }
        if (validatedParams.data.extraGas) {
            throw new RelayerRequestFailed(
                "extraGas is not supported: Stellar's PayoutRouting has no native-gas-reimbursement field",
            );
        }

        try {
            this.logger?.debug("Requesting withdrawal quote from relayer...", { relayerUrl: relayer.url });
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/quote/${relayer.chainType}/${relayer.chainId}/receive`,
                {
                    amount: validatedParams.data.amount,
                    asset: validatedParams.data.asset,
                    recipient: validatedParams.data.recipient,
                    commit: validatedParams.data.commit,
                },
            );

            const parsed = StellarWithdrawalQuoteResponseWireSchema.safeParse(response);
            if (!parsed.success) {
                throw new RelayerRequestFailed(
                    `Invalid withdrawal quote response: ${parsed.error.issues[0]!.message}`,
                );
            }
            const commitment = parsed.data.feeCommitment;
            if (!commitment) {
                throw new RelayerRequestFailed(
                    "Relayer returned no fee commitment for a withdrawal quote (recipient was supplied)",
                );
            }

            const quote: WithdrawalRelayerQuote<StellarAddress> = {
                // No gas-price-oracle equivalent exists on Soroban — see the class doc.
                txCost: "0",
                gasPrice: "0",
                feeAmount: parsed.data.feeAmount,
                amountSent: parsed.data.amountSent,
                amountReceived: parsed.data.amountReceived,
                feeCommitment: { ...commitment, extraGas: false },
            };

            this.logger?.debug("Withdrawal quote received", { feeAmount: quote.feeAmount });
            return quote;
        } catch (error) {
            if (error instanceof RelayerRequestFailed) {
                throw error;
            }
            this.logger?.error("Failed to request withdrawal quote", { error });
            throw new RelayerRequestFailed(stellarErrorMessage(error));
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.getBatchWithdrawalQuote
     * @throws {RelayerRequestFailed} If the params, the request or the response are invalid, or the
     *   relayer returns no commitment for a committing quote.
     */
    async getBatchWithdrawalQuote(
        relayer: RelayerInfo<StellarAddress>,
        params: BatchWithdrawalQuoteParams<StellarAddress>,
    ): Promise<BatchWithdrawalRelayerQuote> {
        const validatedParams = this.schemas.batchWithdrawalQuoteParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRequestFailed(
                `Invalid batch withdrawal quote params: ${validatedParams.error.issues[0]!.message}`,
            );
        }
        if (validatedParams.data.extraGas) {
            throw new RelayerRequestFailed(
                "extraGas is not supported: Stellar's PayoutRouting has no native-gas-reimbursement field",
            );
        }

        try {
            this.logger?.debug("Requesting batch withdrawal quote from relayer...", { relayerUrl: relayer.url });
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/quote/${relayer.chainType}/${relayer.chainId}/batch`,
                {
                    asset: validatedParams.data.asset,
                    recipient: validatedParams.data.recipient,
                    amounts: validatedParams.data.amounts,
                    commit: validatedParams.data.commit,
                },
            );
            const parsed = StellarBatchQuoteResponseWireSchema.safeParse(response);
            if (!parsed.success) {
                throw new RelayerRequestFailed(`Invalid batch quote response: ${parsed.error.issues[0]!.message}`);
            }
            const commitment = parsed.data.feeCommitment;
            if (!commitment) {
                throw new RelayerRequestFailed("Relayer returned no fee commitment for a committing batch quote");
            }
            return {
                txCost: parsed.data.txCost,
                gasPrice: parsed.data.gasPrice,
                totalFee: parsed.data.totalFee,
                maxRelayFee: parsed.data.maxRelayFee,
                feeCommitment: { ...commitment, asset: commitment.asset as Hex },
            };
        } catch (error) {
            if (error instanceof RelayerRequestFailed) throw error;
            this.logger?.error("Failed to request batch withdrawal quote", { error });
            throw new RelayerRequestFailed(stellarErrorMessage(error));
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.relayBatchWithdrawal
     * @throws {RelayerRejected} If the params are invalid or the relayer rejects the batch.
     * @throws {FeeCommitmentExpired} If the signed batch commitment has expired before submission.
     */
    async relayBatchWithdrawal(
        relayer: RelayerInfo<StellarAddress>,
        params: BatchWithdrawalRelayParams,
    ): Promise<Hex> {
        assertFeeCommitmentLive(params.signedBatchFeeCommitment.expiration);
        try {
            this.logger?.debug("Submitting batch withdrawal to relayer...", {
                relayerUrl: relayer.url,
                itemCount: params.items.length,
            });
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/relay/${relayer.chainType}/${relayer.chainId}/batch`,
                {
                    items: params.items.map((item) => {
                        const { a, b, c } = this.proofService.formatForChain(item.proof);
                        return {
                            proof: { a, b, c, publicSignals: item.proof.publicSignals },
                            inputNullifierNumber: item.inputNullifierNumber,
                            outputCommitmentNumber: item.outputCommitmentNumber,
                            noteData: item.noteData,
                        };
                    }),
                    signedBatchFeeCommitment: params.signedBatchFeeCommitment,
                },
            );
            const parsed = StellarRelayResponseWireSchema.safeParse(response);
            if (!parsed.success) {
                throw new RelayerRejected(`Invalid relay response: ${parsed.error.issues[0]!.message}`);
            }
            if (parsed.data.error) {
                throw new RelayerRejected(parsed.data.error);
            }
            return parsed.data.txHash as Hex;
        } catch (error) {
            if (error instanceof RelayerRejected) throw error;
            this.logger?.error("Relayer rejected batch withdrawal", { error });
            throw new RelayerRejected(stellarErrorMessage(error));
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.relayTransfer
     * @throws {RelayerRejected} If the relayer rejects the transfer.
     * @throws {FeeCommitmentExpired} If the signed fee commitment has expired before submission.
     */
    async relayTransfer(relayer: RelayerInfo<StellarAddress>, params: TransferRelayParams<StellarAddress>): Promise<Hex> {
        assertFeeCommitmentLive(params.signedFeeCommitment.expiration);
        const { a, b, c } = this.proofService.formatForChain(params.proof);
        try {
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/relay/${relayer.chainType}/${relayer.chainId}/transfer`,
                {
                    proof: { a, b, c, publicSignals: params.proof.publicSignals },
                    inputNullifierNumber: params.inputNullifierNumber,
                    outputCommitmentNumber: params.outputCommitmentNumber,
                    noteData: params.noteData,
                    signedFeeCommitment: params.signedFeeCommitment,
                },
            );
            const parsed = StellarRelayResponseWireSchema.safeParse(response);
            if (!parsed.success) {
                throw new RelayerRejected(`Invalid relay response: ${parsed.error.issues[0]!.message}`);
            }
            if (parsed.data.error) {
                throw new RelayerRejected(parsed.data.error);
            }
            return parsed.data.txHash as Hex;
        } catch (error) {
            if (error instanceof RelayerRejected) throw error;
            this.logger?.error("Relayer rejected transfer", { error });
            throw new RelayerRejected(stellarErrorMessage(error));
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.relayWithdrawal
     * @throws {RelayerRejected} If the params are invalid or the relayer rejects the transaction.
     * @throws {FeeCommitmentExpired} If the signed fee commitment has expired before submission.
     */
    async relayWithdrawal(
        relayer: RelayerInfo<StellarAddress>,
        params: WithdrawalRelayParams<StellarAddress>,
    ): Promise<Hex> {
        const validatedParams = this.schemas.withdrawalRelayParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRejected(
                `Invalid withdrawal relay params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        assertFeeCommitmentLive(validatedParams.data.signedFeeCommitment.expiration);

        const { a, b, c } = this.proofService.formatForChain(validatedParams.data.proof);

        try {
            this.logger?.debug("Submitting withdrawal to relayer...", { relayerUrl: relayer.url });
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/relay/${relayer.chainType}/${relayer.chainId}/withdrawal`,
                {
                    proof: {
                        a,
                        b,
                        c,
                        publicSignals: validatedParams.data.proof.publicSignals,
                    },
                    inputNullifierNumber: validatedParams.data.inputNullifierNumber,
                    outputCommitmentNumber: validatedParams.data.outputCommitmentNumber,
                    noteData: validatedParams.data.noteData,
                    signedFeeCommitment: validatedParams.data.signedFeeCommitment,
                    // A yield withdrawal: the share's `yield-router` processes it and unwraps to
                    // the underlying, holding the recipient to this floor.
                    ...(validatedParams.data.processorAddress
                        ? {
                              processorAddress: validatedParams.data.processorAddress,
                              minUnderlyingOut: BigInt(validatedParams.data.minUnderlyingOut ?? "0x0").toString(),
                          }
                        : {}),
                },
            );

            const parsed = StellarRelayResponseWireSchema.safeParse(response);
            if (!parsed.success) {
                throw new RelayerRejected(`Invalid relay response: ${parsed.error.issues[0]!.message}`);
            }
            if (parsed.data.error) {
                throw new RelayerRejected(parsed.data.error);
            }

            this.logger?.debug("Withdrawal submitted", { txHash: parsed.data.txHash });
            return parsed.data.txHash as Hex;
        } catch (error) {
            if (error instanceof RelayerRejected) {
                throw error;
            }
            this.logger?.error("Relayer rejected withdrawal", { error });
            throw new RelayerRejected(stellarErrorMessage(error));
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.submitRelayedRegistration
     * @throws {RelayerRequestFailed} Always — Stellar has no standalone relayed registration: the
     *   keystore's `set_auth_policy` needs the owner's own authorization and no contract submits it
     *   alone on the owner's behalf. Use {@link relayRegisterAndWithdrawal}, which registers and
     *   withdraws in one `relay.register_and_relay`.
     */
    async submitRelayedRegistration(
        _relayer: RelayerInfo<StellarAddress>,
        _params: RegisterKeystoreRelayParams<StellarAddress>,
    ): Promise<Hex> {
        throw new RelayerRequestFailed(
            "Standalone relayed registration is not supported on Stellar — use relayRegisterAndWithdrawal " +
                "(relay.register_and_relay registers and withdraws atomically)",
        );
    }

    /**
     * @inheritdoc IRelayerInteractor.relayRegisterAndWithdrawal
     *
     * The relayer calls `relay.register_and_relay`: the owner's keystore registration and the
     * withdrawal in one transaction. `registration.signature` is the owner's SIGNED Soroban auth
     * entry (hex of its XDR) over the nested `keystore.set_auth_policy` — the relayer attaches it to
     * the invocation and cannot alter it.
     * @throws {RelayerRejected} If the params are invalid or the relayer rejects the request.
     * @throws {FeeCommitmentExpired} If the signed fee commitment has expired before submission.
     */
    async relayRegisterAndWithdrawal(
        relayer: RelayerInfo<StellarAddress>,
        params: RegisterAndWithdrawalRelayParams<StellarAddress>,
    ): Promise<Hex> {
        const validatedParams = this.schemas.withdrawalRelayParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRejected(
                `Invalid register-and-withdrawal params: ${validatedParams.error.issues[0]!.message}`,
            );
        }
        assertFeeCommitmentLive(validatedParams.data.signedFeeCommitment.expiration);
        const { a, b, c } = this.proofService.formatForChain(validatedParams.data.proof);
        try {
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/relay/${relayer.chainType}/${relayer.chainId}/register-and-withdrawal`,
                {
                    proof: { a, b, c, publicSignals: validatedParams.data.proof.publicSignals },
                    inputNullifierNumber: validatedParams.data.inputNullifierNumber,
                    outputCommitmentNumber: validatedParams.data.outputCommitmentNumber,
                    noteData: validatedParams.data.noteData,
                    signedFeeCommitment: validatedParams.data.signedFeeCommitment,
                    registration: {
                        account: params.registration.account,
                        authDigest: params.registration.authDigest,
                        nullifyingKeyHash: params.registration.nullifyingKeyHash,
                        deadline: params.registration.deadline,
                        signature: params.registration.signature,
                    },
                },
            );
            const parsed = StellarRelayResponseWireSchema.safeParse(response);
            if (!parsed.success) {
                throw new RelayerRejected(`Invalid relay response: ${parsed.error.issues[0]!.message}`);
            }
            if (parsed.data.error) {
                throw new RelayerRejected(parsed.data.error);
            }
            return parsed.data.txHash as Hex;
        } catch (error) {
            if (error instanceof RelayerRejected) throw error;
            this.logger?.error("Relayer rejected register-and-withdrawal", { error });
            throw new RelayerRejected(stellarErrorMessage(error));
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.relayWithAnnounce
     * @throws {RelayerRejected} Always — ERC-5564 stealth-address announcements have no Soroban
     *   counterpart.
     */
    async relayWithAnnounce(
        _relayer: RelayerInfo<StellarAddress>,
        _params: RelayAndAnnounceRelayParams<StellarAddress>,
    ): Promise<Hex> {
        throw new RelayerRejected(
            "relayAndAnnounce is not supported on Stellar: ERC-5564 stealth announcements have " +
                "no Soroban counterpart",
        );
    }

    /**
     * @inheritdoc IRelayerInteractor.getSwapQuote
     * @throws {RelayerRequestFailed} Always — the swap subsystem is EVM-only.
     */
    async getSwapQuote(
        relayer: RelayerInfo<StellarAddress>,
        params: SwapQuoteParams<StellarAddress> & { commit: true },
    ): Promise<SwapRelayerQuote<StellarAddress>>;
    async getSwapQuote(
        relayer: RelayerInfo<StellarAddress>,
        params: SwapQuoteParams<StellarAddress> & { commit: false },
    ): Promise<UncommittedQuote>;
    async getSwapQuote(
        relayer: RelayerInfo<StellarAddress>,
        params: SwapQuoteParams<StellarAddress>,
    ): Promise<SwapRelayerQuote<StellarAddress> | UncommittedQuote>;
    async getSwapQuote(
        _relayer: RelayerInfo<StellarAddress>,
        _params: SwapQuoteParams<StellarAddress>,
    ): Promise<SwapRelayerQuote<StellarAddress> | UncommittedQuote> {
        throw new RelayerRequestFailed("Swap quoting is not supported on Stellar: the swap subsystem is EVM-only");
    }

    /**
     * @inheritdoc IRelayerInteractor.relaySwap
     * @throws {RelayerRejected} Always — the swap subsystem is EVM-only.
     */
    async relaySwap(
        _relayer: RelayerInfo<StellarAddress>,
        _params: SwapRelayParams<StellarAddress>,
    ): Promise<Hex> {
        throw new RelayerRejected("Swap relaying is not supported on Stellar: the swap subsystem is EVM-only");
    }
}
