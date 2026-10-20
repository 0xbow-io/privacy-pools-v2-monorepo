import type {
    Address,
    BatchWithdrawalQuoteParams,
    BatchWithdrawalRelayerQuote,
    BatchWithdrawalRelayParams,
    Hex,
    IHTTPClient,
    ILogger,
    IRelayerInteractor,
    RegisterAndWithdrawalRelayParams,
    RegisterKeystoreRelayParams,
    RelayAndAnnounceRelayParams,
    RelayerChainDetails,
    RelayerEndpoint,
    RelayerInfo,
    RelayerInteractorConfig,
    RelayerInteractorDependencies,
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
    BatchWithdrawalRelayerQuoteSchema,
    BatchWithdrawalRelayParamsSchema,
    InvalidRelayerConfig,
    makeRelayerAddressSchemas,
    makeRelayerChainDetailsSchemas,
    RelayerRejected,
    RelayerRequestFailed,
    SwapRelayerQuoteSchema,
    UncommittedQuoteSchema,
} from "../internal.js";

/**
 * Handles communication with transaction relayers.
 * Manages the relayer interaction lifecycle: discovering available relayers,
 * requesting fee quotes, submitting transactions, and polling for confirmation.
 */
export class RelayerInteractor<TAddress = Address> implements IRelayerInteractor<TAddress> {
    private readonly relayers: RelayerInfo<TAddress>[];
    private readonly httpClient: IHTTPClient;
    private readonly logger?: ILogger;
    private readonly schemas: ReturnType<typeof makeRelayerAddressSchemas<TAddress>>;
    private readonly chainDetailsSchemas: ReturnType<typeof makeRelayerChainDetailsSchemas<TAddress>>;

    /**
     * Creates a new RelayerInteractor instance.
     * @param config - The configuration containing relayers, httpClient, and optional settings.
     * @param dependencies - Optional dependencies (logger).
     * @throws {InvalidRelayerConfig} If the configuration is invalid.
     */
    constructor(
        config: RelayerInteractorConfig<TAddress>,
        dependencies?: RelayerInteractorDependencies,
    ) {
        this.schemas = makeRelayerAddressSchemas(config.addressSchema);
        this.chainDetailsSchemas = makeRelayerChainDetailsSchemas(config.addressSchema);

        const validated = this.schemas.relayerInteractorConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidRelayerConfig(
                `RelayerInteractor initialization error: ${validated.error.issues[0]!.message}`,
            );
        }

        this.relayers = config.relayers;
        this.httpClient = config.httpClient;

        this.logger = dependencies?.logger;
        this.logger?.debug("RelayerInteractor initialized", {
            relayerCount: this.relayers.length,
        });
    }

    /**
     * @inheritdoc IRelayerInteractor.getRelayers
     */
    async getRelayers(): Promise<RelayerInfo<TAddress>[]> {
        return this.relayers;
    }

    /**
     * @inheritdoc IRelayerInteractor.getChainDetails
     * @throws {RelayerRequestFailed} If the request fails or the response is malformed.
     */
    async getChainDetails(relayer: RelayerEndpoint): Promise<RelayerChainDetails<TAddress>> {
        try {
            this.logger?.debug("Requesting chain details from relayer...", {
                relayerUrl: relayer.url,
            });
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
            return parsed.data as RelayerChainDetails<TAddress>;
        } catch (error) {
            if (error instanceof RelayerRequestFailed) {
                throw error;
            }
            this.logger?.error("Failed to request chain details", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRequestFailed(message);
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.getTransferQuote
     * @throws {RelayerRequestFailed} If the quote request fails.
     */
    async getTransferQuote(
        relayer: RelayerInfo<TAddress>,
        params: TransferQuoteParams<TAddress>,
    ): Promise<TransferRelayerQuote<TAddress>> {
        const validatedParams = this.schemas.transferQuoteParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRequestFailed(
                `Invalid transfer quote params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        try {
            this.logger?.debug("Requesting transfer quote from relayer...", {
                relayerUrl: relayer.url,
            });
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/quote/${relayer.chainType}/${relayer.chainId}/transfer`,
                validatedParams.data,
            );

            const parsed = this.schemas.transferRelayerQuoteSchema.safeParse(response);
            if (!parsed.success) {
                throw new RelayerRequestFailed(
                    `Invalid transfer quote response: ${parsed.error.issues[0]!.message}`,
                );
            }

            this.logger?.debug("Transfer quote received", {
                txCost: parsed.data.txCost,
            });
            return parsed.data;
        } catch (error) {
            if (error instanceof RelayerRequestFailed) {
                throw error;
            }
            this.logger?.error("Failed to request transfer quote", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRequestFailed(message);
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.getWithdrawalQuote
     * @throws {RelayerRequestFailed} If the quote request fails.
     */
    async getWithdrawalQuote(
        relayer: RelayerInfo<TAddress>,
        params: WithdrawalQuoteParams<TAddress>,
    ): Promise<WithdrawalRelayerQuote<TAddress>> {
        const validatedParams = this.schemas.withdrawalQuoteParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRequestFailed(
                `Invalid withdrawal quote params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        try {
            this.logger?.debug("Requesting withdrawal quote from relayer...", {
                relayerUrl: relayer.url,
            });
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/quote/${relayer.chainType}/${relayer.chainId}/receive`,
                validatedParams.data,
            );

            const parsed = this.schemas.withdrawalRelayerQuoteSchema.safeParse(response);
            if (!parsed.success) {
                this.logger?.error("Invalid withdrawal quote response", { response });
                throw new RelayerRequestFailed(
                    `Invalid withdrawal quote response: ${parsed.error.issues[0]!.message}`,
                );
            }

            this.logger?.debug("Withdrawal quote received", {
                txCost: parsed.data.txCost,
            });
            return parsed.data;
        } catch (error) {
            if (error instanceof RelayerRequestFailed) {
                throw error;
            }
            this.logger?.error("Failed to request withdrawal quote", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRequestFailed(message);
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.getBatchWithdrawalQuote
     * @throws {RelayerRequestFailed} If the quote request fails.
     */
    async getBatchWithdrawalQuote(
        relayer: RelayerInfo<TAddress>,
        params: BatchWithdrawalQuoteParams<TAddress>,
    ): Promise<BatchWithdrawalRelayerQuote> {
        const validatedParams = this.schemas.batchWithdrawalQuoteParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRequestFailed(
                `Invalid batch withdrawal quote params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        try {
            this.logger?.debug("Requesting batch withdrawal quote from relayer...", {
                relayerUrl: relayer.url,
            });
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/quote/${relayer.chainType}/${relayer.chainId}/batch`,
                validatedParams.data,
            );

            const parsed = BatchWithdrawalRelayerQuoteSchema.safeParse(response);
            if (!parsed.success) {
                this.logger?.error("Invalid batch withdrawal quote response", { response });
                throw new RelayerRequestFailed(
                    `Invalid batch withdrawal quote response: ${parsed.error.issues[0]!.message}`,
                );
            }

            this.logger?.debug("Batch withdrawal quote received", {
                totalFee: parsed.data.totalFee,
            });
            return parsed.data;
        } catch (error) {
            if (error instanceof RelayerRequestFailed) {
                throw error;
            }
            this.logger?.error("Failed to request batch withdrawal quote", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRequestFailed(message);
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.relayTransfer
     * @throws {RelayerRejected} If the relayer rejects the transaction.
     * @throws {FeeCommitmentExpired} If the signed fee commitment has expired before submission.
     */
    async relayTransfer(
        relayer: RelayerInfo<TAddress>,
        params: TransferRelayParams<TAddress>,
    ): Promise<Hex> {
        const validatedParams = this.schemas.transferRelayParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRejected(
                `Invalid transfer relay params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        assertFeeCommitmentLive(validatedParams.data.signedFeeCommitment.expiration);

        try {
            this.logger?.debug("Submitting transfer to relayer...", {
                relayerUrl: relayer.url,
            });
            const response = await this.httpClient.post<{ txHash: string }>(
                `${relayer.url}/v1/relay/${relayer.chainType}/${relayer.chainId}/transfer`,
                {
                    ...validatedParams.data,
                    proof: {
                        ...validatedParams.data.proof.proof,
                        publicSignals: validatedParams.data.proof.publicSignals,
                    },
                },
            );

            this.logger?.debug("Transfer submitted", { txHash: response.txHash });
            return response.txHash as Hex;
        } catch (error) {
            if (error instanceof RelayerRejected) {
                throw error;
            }
            this.logger?.error("Relayer rejected transfer", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRejected(message);
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.relayWithdrawal
     * @throws {RelayerRejected} If the relayer rejects the transaction.
     * @throws {FeeCommitmentExpired} If the signed fee commitment has expired before submission.
     */
    async relayWithdrawal(
        relayer: RelayerInfo<TAddress>,
        params: WithdrawalRelayParams<TAddress>,
    ): Promise<Hex> {
        const validatedParams = this.schemas.withdrawalRelayParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRejected(
                `Invalid withdrawal relay params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        assertFeeCommitmentLive(validatedParams.data.signedFeeCommitment.expiration);

        try {
            this.logger?.debug("Submitting withdrawal to relayer...", {
                relayerUrl: relayer.url,
            });
            const response = await this.httpClient.post<{ txHash: string }>(
                `${relayer.url}/v1/relay/${relayer.chainType}/${relayer.chainId}/withdrawal`,
                {
                    ...validatedParams.data,
                    proof: {
                        ...validatedParams.data.proof.proof,
                        publicSignals: validatedParams.data.proof.publicSignals,
                    },
                },
            );

            this.logger?.debug("Withdrawal submitted", { txHash: response.txHash });
            return response.txHash as Hex;
        } catch (error) {
            if (error instanceof RelayerRejected) {
                throw error;
            }
            this.logger?.error("Relayer rejected withdrawal", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRejected(message);
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.submitRelayedRegistration
     * @throws {RelayerRequestFailed} The standalone relayed-registration endpoint is not yet
     *   supported by the relayer (INTL-05 deferral) — use `relayRegisterAndWithdrawal` instead.
     * @throws {RelayerRejected} If the params are invalid or the relayer rejects the registration.
     */
    async submitRelayedRegistration(
        _relayer: RelayerInfo<TAddress>,
        _params: RegisterKeystoreRelayParams<TAddress>,
    ): Promise<Hex> {
        // The relayer exposes no standalone `register` route (only `register-and-relay`), so a real
        // submission would POST to a 404. Fail loudly with an actionable error instead of a raw HTTP
        // failure, and point at the supported atomic path. INTL-05 defers the standalone endpoint
        // pending the fee-commitment economics of a registration that carries no withdrawal.
        throw new RelayerRequestFailed(
            "Standalone relayed registration is not yet supported by the relayer (INTL-05). " +
                "Use relayRegisterAndWithdrawal for the atomic register-and-withdraw path.",
        );
    }

    /**
     * @inheritdoc IRelayerInteractor.relayRegisterAndWithdrawal
     * @throws {RelayerRejected} If the params are invalid or the relayer rejects the transaction.
     * @throws {FeeCommitmentExpired} If the signed fee commitment has expired before submission.
     */
    async relayRegisterAndWithdrawal(
        relayer: RelayerInfo<TAddress>,
        params: RegisterAndWithdrawalRelayParams<TAddress>,
    ): Promise<Hex> {
        const validatedParams =
            this.schemas.registerAndWithdrawalRelayParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRejected(
                `Invalid register-and-withdraw relay params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        assertFeeCommitmentLive(validatedParams.data.signedFeeCommitment.expiration);

        try {
            this.logger?.debug("Submitting register-and-withdrawal to relayer...", {
                relayerUrl: relayer.url,
            });
            const response = await this.httpClient.post<{ txHash: string }>(
                `${relayer.url}/v1/relay/${relayer.chainType}/${relayer.chainId}/register-and-withdrawal`,
                {
                    ...validatedParams.data,
                    proof: {
                        ...validatedParams.data.proof.proof,
                        publicSignals: validatedParams.data.proof.publicSignals,
                    },
                },
            );

            this.logger?.debug("Register-and-withdrawal submitted", { txHash: response.txHash });
            return response.txHash as Hex;
        } catch (error) {
            if (error instanceof RelayerRejected) {
                throw error;
            }
            this.logger?.error("Relayer rejected register-and-withdrawal", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRejected(message);
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.relayWithAnnounce
     * @throws {RelayerRejected} If the params are invalid or the relayer rejects the transaction.
     * @throws {FeeCommitmentExpired} If the signed fee commitment has expired before submission.
     */
    async relayWithAnnounce(
        relayer: RelayerInfo<TAddress>,
        params: RelayAndAnnounceRelayParams<TAddress>,
    ): Promise<Hex> {
        const validatedParams = this.schemas.relayAndAnnounceRelayParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRejected(
                `Invalid relay-and-announce params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        assertFeeCommitmentLive(validatedParams.data.signedFeeCommitment.expiration);

        try {
            this.logger?.debug("Submitting relay-and-announce to relayer...", {
                relayerUrl: relayer.url,
            });
            const response = await this.httpClient.post<{ txHash: string }>(
                `${relayer.url}/v1/relay/${relayer.chainType}/${relayer.chainId}/relay-and-announce`,
                {
                    ...validatedParams.data,
                    proof: {
                        ...validatedParams.data.proof.proof,
                        publicSignals: validatedParams.data.proof.publicSignals,
                    },
                },
            );

            this.logger?.debug("Relay-and-announce submitted", { txHash: response.txHash });
            return response.txHash as Hex;
        } catch (error) {
            if (error instanceof RelayerRejected) {
                throw error;
            }
            this.logger?.error("Relayer rejected relay-and-announce", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRejected(message);
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.getSwapQuote
     * @throws {RelayerRequestFailed} If the quote request fails.
     */
    async getSwapQuote(
        relayer: RelayerInfo<TAddress>,
        params: SwapQuoteParams<TAddress> & { commit: true },
    ): Promise<SwapRelayerQuote<TAddress>>;
    async getSwapQuote(
        relayer: RelayerInfo<TAddress>,
        params: SwapQuoteParams<TAddress> & { commit: false },
    ): Promise<UncommittedQuote>;
    async getSwapQuote(
        relayer: RelayerInfo<TAddress>,
        params: SwapQuoteParams<TAddress>,
    ): Promise<SwapRelayerQuote<TAddress> | UncommittedQuote>;
    async getSwapQuote(
        relayer: RelayerInfo<TAddress>,
        params: SwapQuoteParams<TAddress>,
    ): Promise<SwapRelayerQuote<TAddress> | UncommittedQuote> {
        const validatedParams = this.schemas.swapQuoteParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRequestFailed(
                `Invalid swap quote params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        try {
            this.logger?.debug("Requesting swap quote from relayer...", {
                relayerUrl: relayer.url,
            });
            const response = await this.httpClient.post<unknown>(
                `${relayer.url}/v1/quote/${relayer.chainType}/${relayer.chainId}/swap`,
                validatedParams.data,
            );

            // A non-committed request is a fee estimate only — the relayer returns
            // no signed `feeCommitment`, so validate against the narrower schema.
            const schema = params.commit ? SwapRelayerQuoteSchema : UncommittedQuoteSchema;
            const parsed = schema.safeParse(response);
            if (!parsed.success) {
                this.logger?.error("Invalid swap quote response", { response });
                throw new RelayerRequestFailed(
                    `Invalid swap quote response: ${parsed.error.issues[0]!.message}`,
                );
            }

            this.logger?.debug("Swap quote received", {
                txCost: parsed.data.txCost,
            });
            return parsed.data;
        } catch (error) {
            if (error instanceof RelayerRequestFailed) {
                throw error;
            }
            this.logger?.error("Failed to request swap quote", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRequestFailed(message);
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.relaySwap
     * @throws {RelayerRejected} If the relayer rejects the transaction.
     * @throws {FeeCommitmentExpired} If the signed swap commitment has expired before submission.
     */
    async relaySwap(relayer: RelayerInfo<TAddress>, params: SwapRelayParams<TAddress>): Promise<Hex> {
        const validatedParams = this.schemas.swapRelayParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRejected(
                `Invalid relay swap params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        assertFeeCommitmentLive(validatedParams.data.signedSwapCommitment.expiration);

        try {
            this.logger?.debug("Submitting relay-swap to relayer...", {
                relayerUrl: relayer.url,
            });
            const response = await this.httpClient.post<{ txHash: string }>(
                `${relayer.url}/v1/relay/${relayer.chainType}/${relayer.chainId}/relay-swap`,
                {
                    ...validatedParams.data,
                    proof: {
                        ...validatedParams.data.proof.proof,
                        publicSignals: validatedParams.data.proof.publicSignals,
                    },
                },
            );

            this.logger?.debug("Relay-swap submitted", { txHash: response.txHash });
            return response.txHash as Hex;
        } catch (error) {
            if (error instanceof RelayerRejected) {
                throw error;
            }
            this.logger?.error("Relayer rejected relay-swap", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRejected(message);
        }
    }

    /**
     * @inheritdoc IRelayerInteractor.relayBatchWithdrawal
     * @throws {RelayerRejected} If the relayer rejects the batch.
     * @throws {FeeCommitmentExpired} If the signed batch fee commitment has expired before submission.
     */
    async relayBatchWithdrawal(
        relayer: RelayerInfo<TAddress>,
        params: BatchWithdrawalRelayParams,
    ): Promise<Hex> {
        const validatedParams = BatchWithdrawalRelayParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new RelayerRejected(
                `Invalid batch withdrawal relay params: ${validatedParams.error.issues[0]!.message}`,
            );
        }

        assertFeeCommitmentLive(validatedParams.data.signedBatchFeeCommitment.expiration);

        try {
            this.logger?.debug("Submitting batch withdrawal to relayer...", {
                relayerUrl: relayer.url,
                itemCount: validatedParams.data.items.length,
            });
            const response = await this.httpClient.post<{ txHash: string }>(
                `${relayer.url}/v1/relay/${relayer.chainType}/${relayer.chainId}/batch`,
                {
                    ...validatedParams.data,
                    items: validatedParams.data.items.map((item) => ({
                        ...item,
                        proof: {
                            ...item.proof.proof,
                            publicSignals: item.proof.publicSignals,
                        },
                    })),
                },
            );

            this.logger?.debug("Batch withdrawal submitted", { txHash: response.txHash });
            return response.txHash as Hex;
        } catch (error) {
            if (error instanceof RelayerRejected) {
                throw error;
            }
            this.logger?.error("Relayer rejected batch withdrawal", { error });
            const message = error instanceof Error ? error.message : String(error);
            throw new RelayerRejected(message);
        }
    }
}
