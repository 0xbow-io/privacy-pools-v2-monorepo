import type {
    Address,
    DepositForParams,
    EstimateReshieldParams,
    IAddressEqualityComparator,
    ILogger,
    IPoolSessionReshield,
    IPoolSessionReshieldTransfer,
    PoolSessionReshieldTransferConfig,
    PoolSessionReshieldTransferDependencies,
    PrepareDepositResult,
    PreparedReshieldQuote,
    PreparedTransaction,
    PrepareReshieldQuoteParams,
    PrepareReshieldTransferDepositParams,
    ReshieldEstimate,
    ReshieldTransferParams,
    TxLog,
    TxReceipt,
    YieldDepositForRecipient,
    YieldSwapDepositTarget,
} from "../../internal.js";
import {
    InvalidTransactParams,
    yieldSwapDepositTargetFor,
    YieldTargetNotConfigured,
} from "../../internal.js";

/**
 * {@link IPoolSessionReshieldTransfer} implementation, chain-agnostic. Composes an existing
 * {@link IPoolSessionReshield} delegate for estimate/quote/relay (already fully
 * recipient-agnostic — see the interface docs) and adds only the yield-share deposit-for leg.
 */
export class PoolSessionReshieldTransfer<TTx = PreparedTransaction, TAddress = Address, TLog = TxLog>
    implements IPoolSessionReshieldTransfer<TTx, TAddress, TLog>
{
    private readonly reshieldDelegate: IPoolSessionReshield<TTx, TAddress, TLog>;
    private readonly yieldDepositTargets: YieldSwapDepositTarget<TTx, TAddress>[];
    private readonly depositDelegate?: PoolSessionReshieldTransferConfig<TTx, TAddress, TLog>["depositDelegate"];
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly logger?: ILogger;

    constructor(
        config: PoolSessionReshieldTransferConfig<TTx, TAddress, TLog>,
        deps?: PoolSessionReshieldTransferDependencies,
    ) {
        this.reshieldDelegate = config.reshieldDelegate;
        this.yieldDepositTargets = config.yieldDepositTargets;
        this.depositDelegate = config.depositDelegate;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransfer.estimateReshieldTransferAmount
     * @throws {YieldTargetNotConfigured} When `outputToken` has no configured yield-share target
     *   and the session has no `depositDelegate` to serve a plain output.
     * @throws {InvalidTransactParams} When `outputToken` is the underlying of a configured yield
     *   share (plain pool rule: pass the share instead).
     */
    async estimateReshieldTransferAmount(
        params: EstimateReshieldParams<TAddress>,
    ): Promise<ReshieldEstimate<TAddress>> {
        this.resolveOutput(params.outputToken);
        return this.reshieldDelegate.estimateReshieldAmount(params);
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransfer.prepareReshieldTransferDeposit
     * @throws {YieldTargetNotConfigured} When `outputToken` has no configured yield-share target
     *   and the session has no `depositDelegate` to serve a plain output.
     * @throws {InvalidTransactParams} When `outputToken` is the underlying of a configured yield
     *   share (plain pool rule), or for a plain output when `noteValue` is missing, or when the
     *   delegate returns a deposit owned by this session instead of the recipient.
     * @throws {DepositRecipientViewingKeyUnregistered} When `discoveryData.evmAddress` has no
     *   registered viewing key and `allowOutOfBandFallback` was not set.
     */
    async prepareReshieldTransferDeposit(
        params: PrepareReshieldTransferDepositParams<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>> {
        const output = this.resolveOutput(params.outputToken);
        const recipient: YieldDepositForRecipient<TAddress> = params.noteAddressHash
            ? {
                  noteAddressHash: params.noteAddressHash,
                  noteData: params.noteData,
                  depositSecret: params.depositSecret,
              }
            : { discoveryData: params.discoveryData };

        if (output.kind === "yield") {
            this.logger?.info("Preparing reshield-transfer deposit", {
                outputToken: params.outputToken,
            });
            return output.target.prepareSwapDeposit(BigInt(params.totalDepositCost), undefined, recipient);
        }

        // Plain output: the deposit is for exactly the estimate's note value, with the vetting fee
        // charged on top (already inside `totalDepositCost`, which `prepareReshieldQuote`
        // re-checks against `noteValue + fee`). Passing the budget here instead would double-count it.
        if (!params.noteValue) {
            throw new InvalidTransactParams(
                "noteValue is required for a plain reshield-transfer output — pass ReshieldEstimate.noteValue",
            );
        }
        this.logger?.info("Preparing reshield-transfer deposit (plain output)", {
            outputToken: params.outputToken,
        });
        const result = await output.delegate.prepareDepositFor({
            ...recipient,
            tokenId: params.outputToken,
            value: params.noteValue,
        } as DepositForParams<TAddress>);
        // The same guard prepareReshieldTransferQuote applies, raised where it is cheaper: a
        // deposit-for must never come back owned by the caller's own session.
        if (result.pendingNote.isOwned) {
            throw new InvalidTransactParams(
                "a deposit prepared for a recipient came back owned by this session — refusing to continue",
            );
        }
        return result;
    }

    /**
     * @inheritdoc IPoolSessionReshieldTransfer.prepareReshieldTransferQuote
     * @throws {InvalidTransactParams} When `params.depositResult.pendingNote.isOwned` is true —
     *   a self-owned deposit result means the caller built it via a self-deposit path instead of
     *   `prepareReshieldTransferDeposit`, which would silently reshield to the caller's own
     *   session instead of transferring to the intended recipient.
     * @throws {InvalidTransactParams} When `params.outputToken` or the deposit result's `tokenId` is the
     *   underlying of a configured yield share (plain pool rule: pass the share instead).
     */
    async prepareReshieldTransferQuote(
        params: PrepareReshieldQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldQuote<TAddress>> {
        if (params.depositResult.pendingNote.isOwned) {
            throw new InvalidTransactParams(
                "depositResult is self-owned — build it via prepareReshieldTransferDeposit(), " +
                    "not a self-deposit path, or this would silently reshield instead of transfer",
            );
        }
        // Same plain pool rule as the deposit step, so a hand-built plain deposit for a share's
        // underlying cannot reach the quote either.
        this.assertNotShareUnderlying(params.outputToken);
        this.assertNotShareUnderlying(params.depositResult.pendingNote?.tokenId);
        return this.reshieldDelegate.prepareReshieldQuote(params);
    }

    /** @inheritdoc IPoolSessionReshieldTransfer.relayReshieldTransfer */
    relayReshieldTransfer(params: ReshieldTransferParams<TAddress>): Promise<TxReceipt<TLog>> {
        return this.reshieldDelegate.relayReshield(params);
    }

    /**
     * How `outputToken` is served: as a configured yield share, or (with a `depositDelegate`) as a
     * plain pool asset. A yield share wins when both could apply. A plain output that is the
     * underlying (funding token) of a configured share is refused: that asset only lands as the share.
     *
     * @throws {YieldTargetNotConfigured} When it is neither.
     * @throws {InvalidTransactParams} When a plain output is the underlying of a configured share.
     */
    private resolveOutput(
        outputToken: TAddress,
    ):
        | { kind: "yield"; target: YieldSwapDepositTarget<TTx, TAddress> }
        | { kind: "plain"; delegate: NonNullable<PoolSessionReshieldTransferConfig<TTx, TAddress, TLog>["depositDelegate"]> } {
        const target = yieldSwapDepositTargetFor(this.yieldDepositTargets, outputToken, (a, b) =>
            this.addressEqualityComparator.equals(a, b),
        );
        if (target) return { kind: "yield", target };
        if (this.depositDelegate) {
            this.assertNotShareUnderlying(outputToken);
            return { kind: "plain", delegate: this.depositDelegate };
        }
        throw new YieldTargetNotConfigured(String(outputToken));
    }

    /**
     * Plain pool rule: an asset that has a yield share on this chain is only ever deposited as that
     * share, never into a plain pool. `fundingToken` is the share's underlying (or the native
     * sentinel for a native-mode share).
     *
     * @throws {InvalidTransactParams} When `token` is the funding token of a configured share.
     */
    private assertNotShareUnderlying(token: TAddress | undefined): void {
        if (token === undefined) return;
        const shareOf = this.yieldDepositTargets.find((t) =>
            this.addressEqualityComparator.equals(t.fundingToken, token),
        );
        if (shareOf) {
            throw new InvalidTransactParams(
                `outputToken ${String(token)} has a configured yield share ` +
                    `${String(shareOf.shareToken)} on this chain and is never deposited into a plain pool. ` +
                    "Pass the share as outputToken instead",
            );
        }
    }
}
