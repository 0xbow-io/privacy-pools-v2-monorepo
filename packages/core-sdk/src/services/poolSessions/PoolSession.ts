import type {
    AccountExport,
    AddNoteParams,
    Address,
    BatchWithdrawSessionParams,
    ColdStartTransferParams,
    DepositForParams,
    DepositParams,
    DeriveFromSignatureConfig,
    DiscoverNotesParams,
    EstimateReshieldCrosschainParams,
    EstimateReshieldParams,
    EVMProof,
    ExecuteRegisterAndWithdrawRelayerParams,
    ExecuteTransferParams,
    ExecuteWithdrawAndSwapRelayerParams,
    ExecuteWithdrawRelayerParams,
    FulfillPaymentRequestParams,
    GeneratePaymentRequestParams,
    Hash,
    Hex,
    IKeystoreInteractor,
    IPoolSession,
    IPoolSessionBatchWithdraw,
    IPoolSessionDeposit,
    IPoolSessionExport,
    IPoolSessionKeystore,
    IPoolSessionNoteDiscovery,
    IPoolSessionNoteManager,
    IPoolSessionRagequit,
    IPoolSessionReshield,
    IPoolSessionReshieldCrosschain,
    IPoolSessionReshieldTransfer,
    IPoolSessionReshieldTransferCrosschain,
    IPoolSessionSwapDeposit,
    IPoolSessionTransfer,
    IPoolSessionWithdraw,
    IPoolSessionWithdrawAndSwap,
    IPoolVaultInteractor,
    ISwapProvider,
    LeafCacheSeed,
    MarkNoteExitedParams,
    MarkNoteSpentParams,
    Note,
    PaymentRequest,
    PrepareBatchWithdrawResult,
    PrepareDepositResult,
    PreparedRelayedRegistration,
    PreparedReshieldCrosschainQuote,
    PreparedReshieldQuote,
    PreparedSwapQuote,
    PreparedTransaction,
    PrepareRageQuitResult,
    PrepareRegisterAndWithdrawResult,
    PrepareReshieldCrosschainQuoteParams,
    PrepareReshieldQuoteParams,
    PrepareReshieldTransferCrosschainDepositParams,
    PrepareReshieldTransferDepositParams,
    PrepareSwapAndDepositResult,
    PrepareSwapQuoteParams,
    PrepareTransferResult,
    PrepareWithdrawResult,
    PurgePhantomNotesParams,
    RageQuitParams,
    RegisterKeystoreOptions,
    RegisterKeystoreResult,
    RelayedRegistrationOptions,
    RelayTransferParams,
    ReshieldCrosschainEstimate,
    ReshieldCrosschainParams,
    ReshieldEstimate,
    ReshieldParams,
    ReshieldTransferCrosschainParams,
    ReshieldTransferParams,
    RotateRevocableKeyConfig,
    RotateRevocableKeyOutcome,
    RotateRevocableKeyResult,
    SealedEnvelope,
    SelfSubmitBatchParams,
    SelfSubmitBatchPrepareResult,
    SetAuthPolicyTypedData,
    SwapAndDepositParams,
    SwapStatusRequest,
    SwapStatusResult,
    TransferParams,
    TransferResult,
    TxLog,
    TxReceipt,
    WithdrawParams,
} from "../../internal.js";
import {
    NoteDiscoveryScanFailed,
    PoolSessionDepositBaseError,
    PoolSessionLeafCacheBaseError,
    PoolSessionNoteManagerBaseError,
    PoolSessionRagequitBaseError,
    PoolSessionSwapDepositBaseError,
    PoolSessionTransactBaseError,
    SwapQuoteProviderBaseError,
} from "../../internal.js";

/**
 * Internal session delegates used by PoolSession, generic over the chain's prepared-transaction
 * type `TTx`, address type `TAddress`, on-chain proof type `TProof`, raw receipt-log type `TLog`,
 * opaque chain-extensions bag type `TExtensions`, and signature-derivation config type
 * `TDeriveConfig` (trailing so every existing 5-arg call site stays valid unchanged).
 */
export interface PoolSessionDelegates<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
    TExtensions = unknown,
    TDeriveConfig = DeriveFromSignatureConfig,
> {
    chainId: number;
    /** Always present — every session has a keystore interactor. */
    keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    /** Present only when `poolVaultInteractor` was supplied in `PoolSessionConfig`. */
    poolVaultInteractor?: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    deposit?: IPoolSessionDeposit<TTx, TAddress, TProof, TLog>;
    transfer?: IPoolSessionTransfer<TTx, TAddress, TProof, TLog>;
    withdraw?: IPoolSessionWithdraw<TTx, TAddress, TProof, TLog>;
    batchWithdraw?: IPoolSessionBatchWithdraw<TTx, TAddress, TLog>;
    withdrawAndSwap?: IPoolSessionWithdrawAndSwap<TAddress, TLog>;
    swapDeposit?: IPoolSessionSwapDeposit<TTx, TAddress>;
    reshield?: IPoolSessionReshield<TTx, TAddress, TLog>;
    reshieldCrosschain?: IPoolSessionReshieldCrosschain<TTx, TAddress, TLog>;
    reshieldTransfer?: IPoolSessionReshieldTransfer<TTx, TAddress, TLog>;
    reshieldTransferCrosschain?: IPoolSessionReshieldTransferCrosschain<TTx, TAddress, TLog>;
    swapProvider?: ISwapProvider;
    keystore: IPoolSessionKeystore<TTx, TAddress, TLog, TDeriveConfig>;
    ragequit?: IPoolSessionRagequit<TTx, TAddress, TProof, TLog>;
    noteDiscovery?: IPoolSessionNoteDiscovery<TAddress>;
    noteManager?: IPoolSessionNoteManager<TAddress>;
    export: IPoolSessionExport<TAddress>;
    /**
     * Opaque chain-specific extensions bag (e.g. evm-sdk's Aave-yield sessions) — core-sdk's
     * `PoolSession` never looks inside it; a chain-specific subclass (e.g. evm-sdk's
     * `EvmPoolSession`) reads {@link PoolSession.chainExtensions} and casts to its own shape.
     */
    chainExtensions?: TExtensions;
}

/**
 * Unified pool session — the sole public-facing entry point of the SDK. Generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, raw
 * receipt-log type `TLog`, and opaque chain-extensions bag type `TExtensions` (all default to
 * their EVM shapes / `unknown`).
 *
 * Delegates each operation to its specialized internal session while
 * presenting a single cohesive API surface to integrators.
 *
 * Does not itself expose yield (Aave-backed ppUSDC) methods — that's a specific EVM smart-contract
 * product feature, not a generic chain capability (see `PoolSessionConfig.buildChainExtensions`'s
 * own doc). evm-sdk's `EvmPoolSession` subclasses this, reading `chainExtensions` to add
 * `yield`/`yields`/`yieldFor`.
 */
export class PoolSession<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
    TExtensions = unknown,
    TDeriveConfig = DeriveFromSignatureConfig,
> implements IPoolSession<TTx, TAddress, TProof, TLog, TDeriveConfig>
{
    readonly chainId: number;
    private readonly delegates: PoolSessionDelegates<
        TTx,
        TAddress,
        TProof,
        TLog,
        TExtensions,
        TDeriveConfig
    >;

    /**
     * Opaque chain-specific extensions bag, for a chain-specific subclass to read. `undefined`
     * unless the chain's builder supplied `buildChainExtensions` returning one.
     */
    protected readonly chainExtensions?: TExtensions;

    /** @internal Use {@link PoolSessionFactory.create} instead. */
    constructor(
        delegates: PoolSessionDelegates<TTx, TAddress, TProof, TLog, TExtensions, TDeriveConfig>,
    ) {
        this.chainId = delegates.chainId;
        this.delegates = delegates;
        this.chainExtensions = delegates.chainExtensions;
    }

    /** @inheritdoc IPoolSession.exportKeystoreLeafCache */
    exportKeystoreLeafCache(): LeafCacheSeed | undefined {
        return this.delegates.keystoreInteractor.exportLeafCache();
    }

    /**
     * @inheritdoc IPoolSession.exportStateLeafCache
     * @throws {PoolSessionLeafCacheBaseError} When poolVaultInteractor delegate is not configured.
     */
    exportStateLeafCache(): LeafCacheSeed | undefined {
        if (!this.delegates.poolVaultInteractor) {
            throw new PoolSessionLeafCacheBaseError(
                "State leaf cache export is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.poolVaultInteractor.exportLeafCache();
    }

    /**
     * @inheritdoc IPoolSessionDeposit.prepareDeposit
     * @throws {PoolSessionDepositBaseError} When deposit delegate is not configured.
     */
    prepareDeposit(params: DepositParams<TAddress>): Promise<PrepareDepositResult<TTx, TAddress>> {
        if (!this.delegates.deposit) {
            throw new PoolSessionDepositBaseError(
                "Deposit is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.deposit.prepareDeposit(params);
    }

    /**
     * @inheritdoc IPoolSessionDeposit.prepareDepositFor
     * @throws {PoolSessionDepositBaseError} When deposit delegate is not configured.
     */
    prepareDepositFor(
        params: DepositForParams<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>> {
        if (!this.delegates.deposit) {
            throw new PoolSessionDepositBaseError(
                "Deposit is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.deposit.prepareDepositFor(params);
    }

    /**
     * @inheritdoc IPoolSessionDeposit.deposit
     * @throws {PoolSessionDepositBaseError} When deposit delegate is not configured.
     */
    deposit(params: DepositParams<TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.deposit) {
            throw new PoolSessionDepositBaseError(
                "Deposit is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.deposit.deposit(params);
    }

    /**
     * @inheritdoc IPoolSessionDeposit.executeDeposit
     * @throws {PoolSessionDepositBaseError} When deposit delegate is not configured.
     */
    executeDeposit(result: PrepareDepositResult<TTx, TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.deposit) {
            throw new PoolSessionDepositBaseError(
                "Deposit is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.deposit.executeDeposit(result);
    }

    /**
     * @inheritdoc IPoolSessionDeposit.depositFor
     * @throws {PoolSessionDepositBaseError} When deposit delegate is not configured.
     */
    depositFor(params: DepositForParams<TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.deposit) {
            throw new PoolSessionDepositBaseError(
                "Deposit is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.deposit.depositFor(params);
    }

    /**
     * @inheritdoc IPoolSessionTransfer.prepareColdStartTransfer
     * @throws {PoolSessionTransactBaseError} When transfer delegate is not configured.
     */
    prepareColdStartTransfer(
        params: ColdStartTransferParams<TAddress>,
    ): Promise<PrepareTransferResult<TTx, TAddress>> {
        if (!this.delegates.transfer) {
            throw new PoolSessionTransactBaseError(
                "Transfer is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.transfer.prepareColdStartTransfer(params);
    }

    /**
     * @inheritdoc IPoolSessionTransfer.prepareTransfer
     * @throws {PoolSessionTransactBaseError} When transfer delegate is not configured.
     */
    prepareTransfer(params: TransferParams<TAddress>): Promise<PrepareTransferResult<TTx, TAddress>> {
        if (!this.delegates.transfer) {
            throw new PoolSessionTransactBaseError(
                "Transfer is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.transfer.prepareTransfer(params);
    }

    /**
     * @inheritdoc IPoolSessionTransfer.relayTransfer
     * @throws {PoolSessionTransactBaseError} When transfer delegate is not configured.
     */
    relayTransfer(params: RelayTransferParams<TAddress>): Promise<TransferResult<TAddress, TLog>> {
        if (!this.delegates.transfer) {
            throw new PoolSessionTransactBaseError(
                "Transfer is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.transfer.relayTransfer(params);
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.prepareWithdraw
     * @throws {PoolSessionTransactBaseError} When withdraw delegate is not configured.
     */
    prepareWithdraw(params: WithdrawParams<TAddress>): Promise<PrepareWithdrawResult<TTx, TAddress>> {
        if (!this.delegates.withdraw) {
            throw new PoolSessionTransactBaseError(
                "Withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.withdraw.prepareWithdraw(params);
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.relayWithdraw
     * @throws {PoolSessionTransactBaseError} When withdraw delegate is not configured.
     */
    relayWithdraw(params: ExecuteWithdrawRelayerParams<TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.withdraw) {
            throw new PoolSessionTransactBaseError(
                "Withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.withdraw.relayWithdraw(params);
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.prepareRegisterAndWithdrawRelay
     * @throws {PoolSessionTransactBaseError} When withdraw delegate is not configured.
     */
    prepareRegisterAndWithdrawRelay(
        params: ExecuteWithdrawRelayerParams<TAddress>,
        registration: PreparedRelayedRegistration<TAddress>,
    ): Promise<PrepareRegisterAndWithdrawResult<TAddress>> {
        if (!this.delegates.withdraw) {
            throw new PoolSessionTransactBaseError(
                "Withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.withdraw.prepareRegisterAndWithdrawRelay(params, registration);
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.registerAndWithdraw
     * @throws {PoolSessionTransactBaseError} When withdraw delegate is not configured.
     */
    registerAndWithdraw(
        params: ExecuteRegisterAndWithdrawRelayerParams<TAddress>,
    ): Promise<TxReceipt<TLog>> {
        if (!this.delegates.withdraw) {
            throw new PoolSessionTransactBaseError(
                "Withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.withdraw.registerAndWithdraw(params);
    }

    /**
     * @inheritdoc IPoolSessionTransfer.transfer
     * @throws {PoolSessionTransactBaseError} When transfer delegate is not configured.
     */
    transfer(params: TransferParams<TAddress>): Promise<TransferResult<TAddress, TLog>> {
        if (!this.delegates.transfer) {
            throw new PoolSessionTransactBaseError(
                "Transfer is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.transfer.transfer(params);
    }

    /**
     * @inheritdoc IPoolSessionTransfer.executeTransfer
     * @throws {PoolSessionTransactBaseError} When transfer delegate is not configured.
     */
    executeTransfer(
        opts: ExecuteTransferParams<TTx, TAddress>,
    ): Promise<TransferResult<TAddress, TLog>> {
        if (!this.delegates.transfer) {
            throw new PoolSessionTransactBaseError(
                "Transfer is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.transfer.executeTransfer(opts);
    }

    /**
     * @inheritdoc IPoolSessionTransfer.generatePaymentRequest
     * @throws {PoolSessionTransactBaseError} When transfer delegate is not configured.
     */
    generatePaymentRequest(params: GeneratePaymentRequestParams): Promise<PaymentRequest> {
        if (!this.delegates.transfer) {
            throw new PoolSessionTransactBaseError(
                "Transfer is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.transfer.generatePaymentRequest(params);
    }

    /**
     * @inheritdoc IPoolSessionTransfer.prepareFulfillPaymentRequest
     * @throws {PoolSessionTransactBaseError} When transfer delegate is not configured.
     */
    prepareFulfillPaymentRequest(
        params: FulfillPaymentRequestParams,
    ): Promise<PrepareTransferResult<TTx, TAddress>> {
        if (!this.delegates.transfer) {
            throw new PoolSessionTransactBaseError(
                "Transfer is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.transfer.prepareFulfillPaymentRequest(params);
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.withdraw
     * @throws {PoolSessionTransactBaseError} When withdraw delegate is not configured.
     */
    withdraw(params: WithdrawParams<TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.withdraw) {
            throw new PoolSessionTransactBaseError(
                "Withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.withdraw.withdraw(params);
    }

    /**
     * @inheritdoc IPoolSessionWithdraw.executeWithdraw
     * @throws {PoolSessionTransactBaseError} When withdraw delegate is not configured.
     */
    executeWithdraw(result: PrepareWithdrawResult<TTx, TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.withdraw) {
            throw new PoolSessionTransactBaseError(
                "Withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.withdraw.executeWithdraw(result);
    }

    /**
     * @inheritdoc IPoolSessionBatchWithdraw.prepareBatchWithdraw
     * @throws {PoolSessionTransactBaseError} When batch withdraw delegate is not configured.
     */
    prepareBatchWithdraw(
        params: BatchWithdrawSessionParams<TAddress>,
    ): Promise<PrepareBatchWithdrawResult<TAddress>> {
        if (!this.delegates.batchWithdraw) {
            throw new PoolSessionTransactBaseError(
                "Batch withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.batchWithdraw.prepareBatchWithdraw(params);
    }

    /**
     * @inheritdoc IPoolSessionBatchWithdraw.relayBatchWithdraw
     * @throws {PoolSessionTransactBaseError} When batch withdraw delegate is not configured.
     */
    relayBatchWithdraw(params: PrepareBatchWithdrawResult<TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.batchWithdraw) {
            throw new PoolSessionTransactBaseError(
                "Batch withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.batchWithdraw.relayBatchWithdraw(params);
    }

    /**
     * @inheritdoc IPoolSessionWithdrawAndSwap.prepareSwapQuote
     * @throws {PoolSessionTransactBaseError} When swap delegate is not configured.
     */
    prepareSwapQuote(params: PrepareSwapQuoteParams<TAddress>): Promise<PreparedSwapQuote<TAddress>> {
        if (!this.delegates.withdrawAndSwap) {
            throw new PoolSessionTransactBaseError(
                "Withdraw-and-swap is not available. Provide a swapChainAdapter in PoolSessionConfig.",
            );
        }
        return this.delegates.withdrawAndSwap.prepareSwapQuote(params);
    }

    /**
     * @inheritdoc IPoolSessionWithdrawAndSwap.relayWithdrawAndSwap
     * @throws {PoolSessionTransactBaseError} When swap delegate is not configured.
     */
    relayWithdrawAndSwap(
        params: ExecuteWithdrawAndSwapRelayerParams<TAddress>,
    ): Promise<TxReceipt<TLog>> {
        if (!this.delegates.withdrawAndSwap) {
            throw new PoolSessionTransactBaseError(
                "Withdraw-and-swap is not available. Provide a swapChainAdapter in PoolSessionConfig.",
            );
        }
        return this.delegates.withdrawAndSwap.relayWithdrawAndSwap(params);
    }

    /**
     * @inheritdoc IPoolSessionReshield.estimateReshieldAmount
     * @throws {PoolSessionTransactBaseError} When reshield delegate is not configured.
     */
    estimateReshieldAmount(params: EstimateReshieldParams<TAddress>): Promise<ReshieldEstimate<TAddress>> {
        if (!this.delegates.reshield) {
            throw new PoolSessionTransactBaseError(
                "Reshield is not available. Provide poolVaultInteractor, aspClient, and a chain-extensions hook building it in PoolSessionConfig.",
            );
        }
        return this.delegates.reshield.estimateReshieldAmount(params);
    }

    /**
     * @inheritdoc IPoolSessionReshield.prepareReshieldQuote
     * @throws {PoolSessionTransactBaseError} When reshield delegate is not configured.
     */
    prepareReshieldQuote(
        params: PrepareReshieldQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldQuote<TAddress>> {
        if (!this.delegates.reshield) {
            throw new PoolSessionTransactBaseError(
                "Reshield is not available. Provide poolVaultInteractor, aspClient, and a chain-extensions hook building it in PoolSessionConfig.",
            );
        }
        return this.delegates.reshield.prepareReshieldQuote(params);
    }

    /**
     * @inheritdoc IPoolSessionReshield.relayReshield
     * @throws {PoolSessionTransactBaseError} When reshield delegate is not configured.
     */
    relayReshield(params: ReshieldParams<TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.reshield) {
            throw new PoolSessionTransactBaseError(
                "Reshield is not available. Provide poolVaultInteractor, aspClient, and a chain-extensions hook building it in PoolSessionConfig.",
            );
        }
        return this.delegates.reshield.relayReshield(params);
    }

    /**
     * @inheritdoc IPoolSessionReshieldCrosschain.estimateReshieldCrosschainAmount
     * @throws {PoolSessionTransactBaseError} When reshieldCrosschain delegate is not configured.
     */
    estimateReshieldCrosschainAmount(
        params: EstimateReshieldCrosschainParams<TAddress>,
    ): Promise<ReshieldCrosschainEstimate<TAddress>> {
        if (!this.delegates.reshieldCrosschain) {
            throw new PoolSessionTransactBaseError(
                "ReshieldCrosschain is not available. Provide destinationChainId and destinationEntrypointInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldCrosschain.estimateReshieldCrosschainAmount(params);
    }

    /**
     * @inheritdoc IPoolSessionReshieldCrosschain.prepareReshieldCrosschainQuote
     * @throws {PoolSessionTransactBaseError} When reshieldCrosschain delegate is not configured.
     */
    prepareReshieldCrosschainQuote(
        params: PrepareReshieldCrosschainQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldCrosschainQuote<TAddress>> {
        if (!this.delegates.reshieldCrosschain) {
            throw new PoolSessionTransactBaseError(
                "ReshieldCrosschain is not available. Provide destinationChainId and destinationEntrypointInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldCrosschain.prepareReshieldCrosschainQuote(params);
    }

    /**
     * @inheritdoc IPoolSessionReshieldCrosschain.relayReshieldCrosschain
     * @throws {PoolSessionTransactBaseError} When reshieldCrosschain delegate is not configured.
     */
    relayReshieldCrosschain(params: ReshieldCrosschainParams<TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.reshieldCrosschain) {
            throw new PoolSessionTransactBaseError(
                "ReshieldCrosschain is not available. Provide destinationChainId and destinationEntrypointInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldCrosschain.relayReshieldCrosschain(params);
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransfer.estimateReshieldTransferAmount
     * @throws {PoolSessionTransactBaseError} When reshieldTransfer delegate is not configured.
     */
    estimateReshieldTransferAmount(
        params: EstimateReshieldParams<TAddress>,
    ): Promise<ReshieldEstimate<TAddress>> {
        if (!this.delegates.reshieldTransfer) {
            throw new PoolSessionTransactBaseError(
                "ReshieldTransfer is not available. Provide poolVaultInteractor, aspClient, and a chain-extensions hook building it in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldTransfer.estimateReshieldTransferAmount(params);
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransfer.prepareReshieldTransferDeposit
     * @throws {PoolSessionTransactBaseError} When reshieldTransfer delegate is not configured.
     */
    prepareReshieldTransferDeposit(
        params: PrepareReshieldTransferDepositParams<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>> {
        if (!this.delegates.reshieldTransfer) {
            throw new PoolSessionTransactBaseError(
                "ReshieldTransfer is not available. Provide poolVaultInteractor, aspClient, and a chain-extensions hook building it in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldTransfer.prepareReshieldTransferDeposit(params);
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransfer.prepareReshieldTransferQuote
     * @throws {PoolSessionTransactBaseError} When reshieldTransfer delegate is not configured.
     */
    prepareReshieldTransferQuote(
        params: PrepareReshieldQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldQuote<TAddress>> {
        if (!this.delegates.reshieldTransfer) {
            throw new PoolSessionTransactBaseError(
                "ReshieldTransfer is not available. Provide poolVaultInteractor, aspClient, and a chain-extensions hook building it in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldTransfer.prepareReshieldTransferQuote(params);
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransfer.relayReshieldTransfer
     * @throws {PoolSessionTransactBaseError} When reshieldTransfer delegate is not configured.
     */
    relayReshieldTransfer(params: ReshieldTransferParams<TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.reshieldTransfer) {
            throw new PoolSessionTransactBaseError(
                "ReshieldTransfer is not available. Provide poolVaultInteractor, aspClient, and a chain-extensions hook building it in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldTransfer.relayReshieldTransfer(params);
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransferCrosschain.estimateReshieldTransferCrosschainAmount
     * @throws {PoolSessionTransactBaseError} When reshieldTransferCrosschain delegate is not configured.
     */
    estimateReshieldTransferCrosschainAmount(
        params: EstimateReshieldCrosschainParams<TAddress>,
    ): Promise<ReshieldCrosschainEstimate<TAddress>> {
        if (!this.delegates.reshieldTransferCrosschain) {
            throw new PoolSessionTransactBaseError(
                "ReshieldTransferCrosschain is not available. Provide destinationChainId, destinationEntrypointInteractor, and destinationYieldDepositTargets in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldTransferCrosschain.estimateReshieldTransferCrosschainAmount(
            params,
        );
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransferCrosschain.prepareReshieldTransferCrosschainDeposit
     * @throws {PoolSessionTransactBaseError} When reshieldTransferCrosschain delegate is not configured.
     */
    prepareReshieldTransferCrosschainDeposit(
        params: PrepareReshieldTransferCrosschainDepositParams<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>> {
        if (!this.delegates.reshieldTransferCrosschain) {
            throw new PoolSessionTransactBaseError(
                "ReshieldTransferCrosschain is not available. Provide destinationChainId, destinationEntrypointInteractor, and destinationYieldDepositTargets in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldTransferCrosschain.prepareReshieldTransferCrosschainDeposit(
            params,
        );
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransferCrosschain.prepareReshieldTransferCrosschainQuote
     * @throws {PoolSessionTransactBaseError} When reshieldTransferCrosschain delegate is not configured.
     */
    prepareReshieldTransferCrosschainQuote(
        params: PrepareReshieldCrosschainQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldCrosschainQuote<TAddress>> {
        if (!this.delegates.reshieldTransferCrosschain) {
            throw new PoolSessionTransactBaseError(
                "ReshieldTransferCrosschain is not available. Provide destinationChainId, destinationEntrypointInteractor, and destinationYieldDepositTargets in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldTransferCrosschain.prepareReshieldTransferCrosschainQuote(
            params,
        );
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransferCrosschain.relayReshieldTransferCrosschain
     * @throws {PoolSessionTransactBaseError} When reshieldTransferCrosschain delegate is not configured.
     */
    relayReshieldTransferCrosschain(
        params: ReshieldTransferCrosschainParams<TAddress>,
    ): Promise<TxReceipt<TLog>> {
        if (!this.delegates.reshieldTransferCrosschain) {
            throw new PoolSessionTransactBaseError(
                "ReshieldTransferCrosschain is not available. Provide destinationChainId, destinationEntrypointInteractor, and destinationYieldDepositTargets in PoolSessionConfig.",
            );
        }
        return this.delegates.reshieldTransferCrosschain.relayReshieldTransferCrosschain(params);
    }

    /**
     * @inheritdoc ISwapProvider.getSwapStatus
     * @throws {SwapQuoteProviderBaseError} When swap provider is not configured.
     */
    getSwapStatus(params: SwapStatusRequest): Promise<SwapStatusResult> {
        if (!this.delegates.swapProvider) {
            throw new SwapQuoteProviderBaseError(
                "Swap status tracking is not available. Provide swapAndDepositQuoteProvider in PoolSessionConfig.",
            );
        }
        return this.delegates.swapProvider.getSwapStatus(params);
    }

    /**
     * @inheritdoc IPoolSessionSwapDeposit.prepareSwapAndDeposit
     * @throws {PoolSessionSwapDepositBaseError} When swap-deposit delegate is not configured.
     */
    prepareSwapAndDeposit(
        params: SwapAndDepositParams<TAddress>,
    ): Promise<PrepareSwapAndDepositResult<TTx, TAddress>> {
        if (!this.delegates.swapDeposit) {
            throw new PoolSessionSwapDepositBaseError(
                "Swap-and-deposit is not available. Provide swapAndDepositQuoteProvider in PoolSessionConfig.",
            );
        }
        return this.delegates.swapDeposit.prepareSwapAndDeposit(params);
    }

    /**
     * @inheritdoc IPoolSessionSwapDeposit.executeSwapAndDeposit
     * @throws {PoolSessionSwapDepositBaseError} When swap-deposit delegate is not configured.
     */
    executeSwapAndDeposit(result: PrepareSwapAndDepositResult<TTx, TAddress>): Promise<TxReceipt> {
        if (!this.delegates.swapDeposit) {
            throw new PoolSessionSwapDepositBaseError(
                "Swap-and-deposit is not available. Provide swapAndDepositQuoteProvider in PoolSessionConfig.",
            );
        }
        return this.delegates.swapDeposit.executeSwapAndDeposit(result);
    }

    /**
     * @inheritdoc IPoolSessionSwapDeposit.swapAndDeposit
     * @throws {PoolSessionSwapDepositBaseError} When swap-deposit delegate is not configured.
     */
    swapAndDeposit(params: SwapAndDepositParams<TAddress>): Promise<TxReceipt> {
        if (!this.delegates.swapDeposit) {
            throw new PoolSessionSwapDepositBaseError(
                "Swap-and-deposit is not available. Provide swapAndDepositQuoteProvider in PoolSessionConfig.",
            );
        }
        return this.delegates.swapDeposit.swapAndDeposit(params);
    }

    /**
     * @inheritdoc IPoolSessionBatchWithdraw.selfSubmitBatchWithdraw
     * @throws {PoolSessionTransactBaseError} When batch withdraw delegate is not configured.
     */
    selfSubmitBatchWithdraw(params: SelfSubmitBatchParams<TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.batchWithdraw) {
            throw new PoolSessionTransactBaseError(
                "Batch withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.batchWithdraw.selfSubmitBatchWithdraw(params);
    }

    /**
     * @inheritdoc IPoolSessionBatchWithdraw.prepareSelfSubmitBatch
     * @throws {PoolSessionTransactBaseError} When batch withdraw delegate is not configured.
     */
    prepareSelfSubmitBatch(
        params: SelfSubmitBatchParams<TAddress>,
    ): Promise<SelfSubmitBatchPrepareResult<TTx, TAddress>> {
        if (!this.delegates.batchWithdraw) {
            throw new PoolSessionTransactBaseError(
                "Batch withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.batchWithdraw.prepareSelfSubmitBatch(params);
    }

    /**
     * @inheritdoc IPoolSessionBatchWithdraw.executeSelfSubmitBatch
     * @throws {PoolSessionTransactBaseError} When batch withdraw delegate is not configured.
     */
    executeSelfSubmitBatch(
        prepared: SelfSubmitBatchPrepareResult<TTx, TAddress>,
    ): Promise<TxReceipt<TLog>> {
        if (!this.delegates.batchWithdraw) {
            throw new PoolSessionTransactBaseError(
                "Batch withdraw is not available. Provide poolVaultInteractor and aspClient in PoolSessionConfig.",
            );
        }
        return this.delegates.batchWithdraw.executeSelfSubmitBatch(prepared);
    }

    /** @inheritdoc IPoolSessionKeystore.isKeystoreRegistered */
    isKeystoreRegistered(): Promise<boolean> {
        return this.delegates.keystore.isKeystoreRegistered();
    }

    /** @inheritdoc IPoolSessionKeystore.prepareRegisterKeystore */
    prepareRegisterKeystore(options?: RegisterKeystoreOptions): Promise<RegisterKeystoreResult<TTx>> {
        return this.delegates.keystore.prepareRegisterKeystore(options);
    }

    /** @inheritdoc IPoolSessionKeystore.prepareRelayedRegistration */
    prepareRelayedRegistration(
        options: RelayedRegistrationOptions,
    ): Promise<PreparedRelayedRegistration<TAddress>> {
        return this.delegates.keystore.prepareRelayedRegistration(options);
    }

    /** @inheritdoc IPoolSessionKeystore.buildSetAuthPolicyTypedData */
    buildSetAuthPolicyTypedData(deadline: Hex): SetAuthPolicyTypedData {
        return this.delegates.keystore.buildSetAuthPolicyTypedData(deadline);
    }

    /** @inheritdoc IPoolSessionKeystore.registerKeystore */
    registerKeystore(options?: RegisterKeystoreOptions): Promise<TxReceipt<TLog>[]> {
        return this.delegates.keystore.registerKeystore(options);
    }

    /** @inheritdoc IPoolSessionKeystore.executeRegisterKeystore */
    executeRegisterKeystore(result: RegisterKeystoreResult<TTx>): Promise<TxReceipt<TLog>[]> {
        return this.delegates.keystore.executeRegisterKeystore(result);
    }

    /** @inheritdoc IPoolSessionKeystore.getRevocableKeyIndex */
    getRevocableKeyIndex(): Hex {
        return this.delegates.keystore.getRevocableKeyIndex();
    }

    /** @inheritdoc IPoolSessionKeystore.discoverRevocableKeyIndex */
    discoverRevocableKeyIndex(
        config: Omit<TDeriveConfig, "revocableKeyIndex">,
        gapLimit?: number,
    ): Promise<Hex> {
        return this.delegates.keystore.discoverRevocableKeyIndex(config, gapLimit);
    }

    /** @inheritdoc IPoolSessionKeystore.prepareRotateRevocableKey */
    prepareRotateRevocableKey(
        config: RotateRevocableKeyConfig<TDeriveConfig>,
    ): Promise<RotateRevocableKeyResult<TTx>> {
        return this.delegates.keystore.prepareRotateRevocableKey(config);
    }

    /** @inheritdoc IPoolSessionKeystore.executeRotateRevocableKey */
    executeRotateRevocableKey(
        result: RotateRevocableKeyResult<TTx>,
    ): Promise<RotateRevocableKeyOutcome<TLog>> {
        return this.delegates.keystore.executeRotateRevocableKey(result);
    }

    /** @inheritdoc IPoolSessionKeystore.rotateRevocableKey */
    rotateRevocableKey(
        config: RotateRevocableKeyConfig<TDeriveConfig>,
    ): Promise<RotateRevocableKeyOutcome<TLog>> {
        return this.delegates.keystore.rotateRevocableKey(config);
    }

    /**
     * @inheritdoc IPoolSessionRagequit.prepareRageQuit
     * @throws {PoolSessionRagequitBaseError} When ragequit delegate is not configured.
     */
    prepareRageQuit(params: RageQuitParams): Promise<PrepareRageQuitResult<TTx, TAddress>> {
        if (!this.delegates.ragequit) {
            throw new PoolSessionRagequitBaseError(
                "Ragequit is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.ragequit.prepareRageQuit(params);
    }

    /**
     * @inheritdoc IPoolSessionRagequit.rageQuit
     * @throws {PoolSessionRagequitBaseError} When ragequit delegate is not configured.
     */
    rageQuit(params: RageQuitParams): Promise<TxReceipt<TLog>> {
        if (!this.delegates.ragequit) {
            throw new PoolSessionRagequitBaseError(
                "Ragequit is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.ragequit.rageQuit(params);
    }

    /**
     * @inheritdoc IPoolSessionRagequit.executeRageQuit
     * @throws {PoolSessionRagequitBaseError} When ragequit delegate is not configured.
     */
    executeRageQuit(result: PrepareRageQuitResult<TTx, TAddress>): Promise<TxReceipt<TLog>> {
        if (!this.delegates.ragequit) {
            throw new PoolSessionRagequitBaseError(
                "Ragequit is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.ragequit.executeRageQuit(result);
    }

    /**
     * @inheritdoc IPoolSessionNoteDiscovery.discoverNotes
     * @throws {NoteDiscoveryScanFailed} When note discovery delegate is not configured.
     */
    async discoverNotes(params?: DiscoverNotesParams): Promise<Note<TAddress>[]> {
        if (!this.delegates.noteDiscovery) {
            throw new NoteDiscoveryScanFailed(
                "Note discovery is not available. Provide poolVaultInteractor and dataService in PoolSessionConfig.",
            );
        }
        return this.delegates.noteDiscovery.discoverNotes(params);
    }

    /**
     * @inheritdoc IPoolSessionNoteDiscovery.purgePhantomNotes
     * @throws {NoteDiscoveryScanFailed} When note discovery delegate is not configured.
     */
    async purgePhantomNotes(params?: PurgePhantomNotesParams): Promise<Hash[]> {
        if (!this.delegates.noteDiscovery) {
            throw new NoteDiscoveryScanFailed(
                "Note discovery is not available. Provide poolVaultInteractor and dataService in PoolSessionConfig.",
            );
        }
        return this.delegates.noteDiscovery.purgePhantomNotes(params);
    }

    /**
     * @inheritdoc IPoolSessionNoteManager.addNotes
     * @throws {PoolSessionNoteManagerBaseError} When the note manager delegate is not configured.
     */
    addNotes(params: AddNoteParams<TAddress>[]): Promise<void> {
        if (!this.delegates.noteManager) {
            throw new PoolSessionNoteManagerBaseError(
                "addNotes is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.noteManager.addNotes(params);
    }

    /**
     * @inheritdoc IPoolSessionNoteManager.markNotesSpent
     * @throws {PoolSessionNoteManagerBaseError} When the note manager delegate is not configured.
     */
    markNotesSpent(params: MarkNoteSpentParams[]): Promise<void> {
        if (!this.delegates.noteManager) {
            throw new PoolSessionNoteManagerBaseError(
                "markNotesSpent is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.noteManager.markNotesSpent(params);
    }

    /**
     * @inheritdoc IPoolSessionNoteManager.markNotesExited
     * @throws {PoolSessionNoteManagerBaseError} When the note manager delegate is not configured.
     */
    markNotesExited(params: MarkNoteExitedParams[]): Promise<void> {
        if (!this.delegates.noteManager) {
            throw new PoolSessionNoteManagerBaseError(
                "markNotesExited is not available. Provide poolVaultInteractor in PoolSessionConfig.",
            );
        }
        return this.delegates.noteManager.markNotesExited(params);
    }

    /** @inheritdoc IPoolSessionExport.exportAccount */
    exportAccount(): Promise<AccountExport<TAddress>> {
        return this.delegates.export.exportAccount();
    }

    /** @inheritdoc IPoolSessionExport.importAccount */
    importAccount(data: AccountExport<TAddress>): Promise<void> {
        return this.delegates.export.importAccount(data);
    }

    /** @inheritdoc IPoolSessionExport.exportAccountSealed */
    exportAccountSealed(passphrase: string | Uint8Array): Promise<SealedEnvelope> {
        return this.delegates.export.exportAccountSealed(passphrase);
    }

    /** @inheritdoc IPoolSessionExport.importAccountSealed */
    importAccountSealed(sealed: SealedEnvelope, passphrase: string | Uint8Array): Promise<void> {
        return this.delegates.export.importAccountSealed(sealed, passphrase);
    }

    /** @inheritdoc IPoolSessionExport.importReceivedNote */
    importReceivedNote(note: Note<TAddress>): Promise<void> {
        return this.delegates.export.importReceivedNote(note);
    }
}
