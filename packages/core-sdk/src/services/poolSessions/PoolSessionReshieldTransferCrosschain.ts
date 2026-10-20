import type {
    Address,
    EstimateReshieldCrosschainParams,
    IAddressEqualityComparator,
    ILogger,
    IPoolSessionReshieldCrosschain,
    IPoolSessionReshieldTransferCrosschain,
    PoolSessionReshieldTransferCrosschainConfig,
    PoolSessionReshieldTransferCrosschainDependencies,
    PrepareDepositResult,
    PreparedReshieldCrosschainQuote,
    PreparedTransaction,
    PrepareReshieldCrosschainQuoteParams,
    PrepareReshieldTransferCrosschainDepositParams,
    ReshieldCrosschainEstimate,
    ReshieldTransferCrosschainParams,
    TxLog,
    TxReceipt,
    YieldDepositForRecipient,
    YieldSwapDepositTarget,
} from "../../internal.js";
import {
    CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
    InvalidTransactParams,
    yieldSwapDepositTargetFor,
    YieldTargetNotConfigured,
} from "../../internal.js";

/**
 * {@link IPoolSessionReshieldTransferCrosschain} implementation, chain-agnostic. Composes an
 * existing {@link IPoolSessionReshieldCrosschain} delegate for estimate/quote/relay (already
 * fully recipient-agnostic — see the interface docs) and adds only the destination-chain
 * yield-share deposit-for leg.
 */
export class PoolSessionReshieldTransferCrosschain<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
> implements IPoolSessionReshieldTransferCrosschain<TTx, TAddress, TLog>
{
    private readonly reshieldCrosschainDelegate: IPoolSessionReshieldCrosschain<TTx, TAddress, TLog>;
    private readonly destinationYieldDepositTargets: YieldSwapDepositTarget<TTx, TAddress>[];
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly logger?: ILogger;

    constructor(
        config: PoolSessionReshieldTransferCrosschainConfig<TTx, TAddress, TLog>,
        deps?: PoolSessionReshieldTransferCrosschainDependencies,
    ) {
        this.reshieldCrosschainDelegate = config.reshieldCrosschainDelegate;
        this.destinationYieldDepositTargets = config.destinationYieldDepositTargets;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransferCrosschain.estimateReshieldTransferCrosschainAmount
     * @throws {YieldTargetNotConfigured} When `outputToken` has no configured destination yield-share target.
     */
    async estimateReshieldTransferCrosschainAmount(
        params: EstimateReshieldCrosschainParams<TAddress>,
    ): Promise<ReshieldCrosschainEstimate<TAddress>> {
        this.assertYieldTargetConfigured(params.outputToken);
        return this.reshieldCrosschainDelegate.estimateReshieldCrosschainAmount(params);
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransferCrosschain.prepareReshieldTransferCrosschainDeposit
     * @throws {YieldTargetNotConfigured} When `outputToken` has no configured destination yield-share target.
     * @throws {DepositRecipientViewingKeyUnregistered} When `discoveryData.evmAddress` has no
     *   registered viewing key on the destination chain and `allowOutOfBandFallback` was not set.
     */
    async prepareReshieldTransferCrosschainDeposit(
        params: PrepareReshieldTransferCrosschainDepositParams<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>> {
        const target = this.assertYieldTargetConfigured(params.outputToken);
        const recipient: YieldDepositForRecipient<TAddress> = params.noteAddressHash
            ? {
                  noteAddressHash: params.noteAddressHash,
                  noteData: params.noteData,
                  depositSecret: params.depositSecret,
              }
            : { discoveryData: params.discoveryData };

        this.logger?.info("Preparing reshield-transfer-crosschain deposit", {
            outputToken: params.outputToken,
        });
        // Cross-chain sizing always carries the wider rate-drift reserve (bridge + destination
        // execution take longer than a same-chain swap) — mirrors
        // PoolSessionReshieldCrosschain's own estimateReshieldCrosschainAmount sizing.
        return target.prepareSwapDeposit(
            BigInt(params.totalDepositCost),
            CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
            recipient,
        );
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransferCrosschain.prepareReshieldTransferCrosschainQuote
     * @throws {InvalidTransactParams} When `params.depositResult.pendingNote.isOwned` is true —
     *   a self-owned deposit result means the caller built it via a self-deposit path instead of
     *   `prepareReshieldTransferCrosschainDeposit`, which would silently reshield to the caller's
     *   own session instead of transferring to the intended recipient.
     */
    async prepareReshieldTransferCrosschainQuote(
        params: PrepareReshieldCrosschainQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldCrosschainQuote<TAddress>> {
        if (params.depositResult.pendingNote.isOwned) {
            throw new InvalidTransactParams(
                "depositResult is self-owned — build it via prepareReshieldTransferCrosschainDeposit(), " +
                    "not a self-deposit path, or this would silently reshield instead of transfer",
            );
        }
        return this.reshieldCrosschainDelegate.prepareReshieldCrosschainQuote(params);
    }

    /** @inheritdoc IPoolSessionReshieldTransferCrosschain.relayReshieldTransferCrosschain */
    relayReshieldTransferCrosschain(
        params: ReshieldTransferCrosschainParams<TAddress>,
    ): Promise<TxReceipt<TLog>> {
        return this.reshieldCrosschainDelegate.relayReshieldCrosschain(params);
    }

    /**
     * @throws {YieldTargetNotConfigured} When `outputToken` has no configured destination
     *   yield-share target.
     */
    private assertYieldTargetConfigured(outputToken: TAddress): YieldSwapDepositTarget<TTx, TAddress> {
        const target = yieldSwapDepositTargetFor(
            this.destinationYieldDepositTargets,
            outputToken,
            (a, b) => this.addressEqualityComparator.equals(a, b),
        );
        if (!target) {
            throw new YieldTargetNotConfigured(String(outputToken));
        }
        return target;
    }
}
