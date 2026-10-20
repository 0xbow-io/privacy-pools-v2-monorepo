import type {
    Address,
    BudgetSizedYieldDeposit,
    EVMProof,
    ILogger,
    IPoolSessionDeposit,
    IPoolSessionYieldDeposit,
    IYieldRouterCodec,
    IYieldRouterInteractor,
    IYieldTokenInteractor,
    PoolSessionYieldDepositConfig,
    PoolSessionYieldDepositDependencies,
    PrepareDepositResult,
    PreparedTransaction,
    TxLog,
    PreparedYieldDeposit,
    YieldDeploymentConfig,
    YieldDepositForParams,
    YieldDepositParams,
} from "../../internal.js";
import {
    bigintToHex,
    DEPOSIT_RATE_HEADROOM_PPM,
    InvalidYieldAmount,
    YIELD_BPS_DENOMINATOR,
    YIELD_PPM_DENOMINATOR,
} from "../../internal.js";

/**
 * {@link IPoolSessionYieldDeposit} implementation, chain-agnostic. Composes the base deposit session
 * with the router/share-token interactors: build a standard share-token deposit proof, hand it to
 * the chain's {@link IYieldRouterCodec} to re-target at the router's exact-shares deposit, and bind
 * a `maxUnderlyingIn` spend cap: the caller's, else the router quote plus a parts-per-million rate
 * headroom (a wrap has no slippage).
 */
export class PoolSessionYieldDeposit<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionYieldDeposit<TTx, TAddress> {
    private readonly deployment: YieldDeploymentConfig<TAddress>;
    private readonly deposit: IPoolSessionDeposit<TTx, TAddress, TProof, TLog>;
    private readonly router: IYieldRouterInteractor<TAddress>;
    private readonly yieldToken: IYieldTokenInteractor<TAddress>;
    private readonly codec: IYieldRouterCodec<TTx, TAddress>;
    private readonly logger?: ILogger;

    constructor(
        config: PoolSessionYieldDepositConfig<TTx, TAddress, TProof, TLog>,
        deps?: PoolSessionYieldDepositDependencies,
    ) {
        this.deployment = config.deployment;
        this.deposit = config.deposit;
        this.router = config.router;
        this.yieldToken = config.yieldToken;
        this.codec = config.codec;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionYieldDeposit.sharesForUnderlying
     * @throws {InvalidYieldAmount} When `underlyingAmount` is not positive.
     */
    async sharesForUnderlying(underlyingAmount: bigint): Promise<bigint> {
        if (underlyingAmount <= 0n) {
            throw new InvalidYieldAmount(`underlyingAmount must be > 0, got ${underlyingAmount}`);
        }
        // Exactly the shares the budget buys. The rate headroom belongs in the spend cap
        // (prepareYieldDeposit), not here: with exact-shares deposits a discount on the shares
        // is an under-deposit, never a protection.
        return this.yieldToken.previewDeposit(underlyingAmount);
    }

    /**
     * @inheritdoc IPoolSessionYieldDeposit.sizeSharesForBudget
     * @throws {InvalidYieldAmount} When `budget` cannot cover the deposit's fixed costs.
     */
    async sizeSharesForBudget(
        budget: bigint,
        headroomPpm: bigint = DEPOSIT_RATE_HEADROOM_PPM,
    ): Promise<BudgetSizedYieldDeposit> {
        if (budget <= 0n) {
            throw new InvalidYieldAmount(`budget must be > 0, got ${budget}`);
        }
        const headroom = ppmHeadroom(budget, headroomPpm);
        // What the router may charge NOW: the budget minus the reserve for the rate moving before
        // execution. The venue's supply buffer is a fixed cost inside that, so the shares are sized
        // from the remainder.
        const spendNow = budget - headroom;
        const supplyBuffer = await this.router.supplyBufferUnits();
        const principal = spendNow - supplyBuffer;
        if (principal <= 0n) {
            throw new InvalidYieldAmount(
                `budget ${budget} cannot cover the deposit's fixed costs (${headroom} headroom + ${supplyBuffer} supply buffer)`,
                {
                    code: "yieldBudgetBelowFixedCosts",
                    side: "spent",
                    values: { budget, headroom, zapBuffer: supplyBuffer },
                },
            );
        }
        // N = the most TOTAL shares (committed value + vetting-fee shares) whose mint fits in
        // `principal`: previewMint(t) <= principal exactly when t <= previewDeposit(principal),
        // by the vault's rounding (previewDeposit floors, previewMint ceils).
        const capacity = await this.yieldToken.previewDeposit(principal);
        if (capacity <= 0n) {
            throw new InvalidYieldAmount(`budget ${budget} buys no shares at the current rate`);
        }
        // The router adds floor(value × fee / 10000) fee shares and has no fee getter, so the fee
        // is read off one quote: total − value = floor(value × f / 10000) pins the integer f
        // exactly only once value >= 10000 share units, so the probe is taken at least there
        // (a tiny capacity would otherwise infer a lower bound and oversize; codex round 3).
        const probeValue = capacity > 10_000n ? capacity : 10_000n;
        const probe = await this.router.quote(probeValue);
        const feeBps = inferVettingFeeBps(probeValue, probe.total);
        // Greatest v with v + floor(v × f / 10000) <= capacity, in one step: v × (10000 + f) <
        // 10000 × (capacity + 1). Exact for the fee floor and both vault roundings; the old
        // proportional scaling could both refuse a feasible deposit and undersize one.
        const shares =
            feeBps === 0n
                ? capacity
                : (YIELD_BPS_DENOMINATOR * (capacity + 1n) - 1n) / (YIELD_BPS_DENOMINATOR + feeBps);
        if (shares <= 0n) {
            throw new InvalidYieldAmount(`budget ${budget} buys no shares once fees are paid`);
        }
        // The quote the caller will see prepareYieldDeposit re-take. The probe is only reusable
        // when it priced these very shares. At a fixed state the result fits by construction, so
        // a miss means the rate or the fee configuration moved between the reads.
        const { underlyingNeeded } = shares === probeValue ? probe : await this.router.quote(shares);
        if (underlyingNeeded > spendNow) {
            throw new InvalidYieldAmount(
                `router quote ${underlyingNeeded} exceeds the spendable budget ${spendNow}: the rate or fee moved while sizing, size again`,
                // Both figures are the UNDERLYING the wallet pays (`budget` is documented as "the
                // underlying the wallet may spend"), not the shares being bought.
                {
                    code: "invalidYieldAmount",
                    side: "spent",
                    values: { quote: underlyingNeeded, budget: spendNow },
                },
            );
        }
        return { shares, underlyingNeeded, maxUnderlyingIn: budget, headroom };
    }

    /**
     * @inheritdoc IPoolSessionYieldDeposit.prepareYieldDeposit
     * @throws {InvalidYieldAmount} When the requested share `value` is not positive, or `maxUnderlyingIn`
     *   is below the router's quoted `underlyingNeeded`.
     * @throws {UnexpectedDepositCalldata} When the codec cannot read the base deposit transaction.
     */
    async prepareYieldDeposit(params: YieldDepositParams): Promise<PreparedYieldDeposit<TTx, TAddress>> {
        const sharesValue = this.parseShareValue(params.value);

        // Build the STANDARD share-token deposit proof; its transaction targets the pool.
        const prep = await this.deposit.prepareDeposit({
            tokenId: this.deployment.shareToken,
            value: bigintToHex(sharesValue),
        });
        return this.prepareYieldDepositInternal(prep, sharesValue, params);
    }

    /**
     * @inheritdoc IPoolSessionYieldDeposit.prepareYieldDepositFor
     * @throws {InvalidYieldAmount} When the requested share `value` is not positive, or `maxUnderlyingIn`
     *   is below the router's quoted `underlyingNeeded`.
     * @throws {UnexpectedDepositCalldata} When the codec cannot read the base deposit transaction.
     * @throws {DepositRecipientViewingKeyUnregistered} When `discoveryData.evmAddress` has no
     *   registered viewing key and `allowOutOfBandFallback` was not set.
     */
    async prepareYieldDepositFor(params: YieldDepositForParams<TAddress>): Promise<PreparedYieldDeposit<TTx, TAddress>> {
        const sharesValue = this.parseShareValue(params.value);
        // Build the share-token deposit-for proof, owned by the recipient instead of this session.
        const prep = params.noteAddressHash
            ? await this.deposit.prepareDepositFor({
                  tokenId: this.deployment.shareToken,
                  value: bigintToHex(sharesValue),
                  noteAddressHash: params.noteAddressHash,
                  noteData: params.noteData,
                  depositSecret: params.depositSecret,
              })
            : await this.deposit.prepareDepositFor({
                  tokenId: this.deployment.shareToken,
                  value: bigintToHex(sharesValue),
                  discoveryData: params.discoveryData,
              });

        const prepared = await this.prepareYieldDepositInternal(prep, sharesValue, params);
        return prep.noteSecret ? { ...prepared, noteSecret: prep.noteSecret } : prepared;
    }

    /**
     * Shared pipeline behind both `prepareYieldDeposit` and `prepareYieldDepositFor`: re-targets
     * the base deposit at the router via the chain's {@link IYieldRouterCodec}, binds the spend
     * cap, and plans the underlying approval.
     *
     * @param prep - The base deposit result (self-owned or deposit-for).
     * @param sharesValue - The already-validated share value (`parseShareValue(params.value)`),
     *   parsed by the caller before building `prep` so an invalid value short-circuits ahead of
     *   the witness + ZK proof, not after.
     * @param params - The share value and optional spend cap / funding source.
     * @throws {InvalidYieldAmount} When `maxUnderlyingIn` is below the router's quoted `underlyingNeeded`.
     * @throws {UnexpectedDepositCalldata} When the codec cannot read the base deposit transaction.
     */
    private async prepareYieldDepositInternal(
        prep: PrepareDepositResult<TTx, TAddress>,
        sharesValue: bigint,
        params: YieldDepositParams,
    ): Promise<PreparedYieldDeposit<TTx, TAddress>> {
        // The spend cap. A wrap has no slippage; only interest accrual and rounding move the
        // price of a fixed share amount between quote and execution, so the default headroom is
        // parts per million, not percent (DEPOSIT_RATE_HEADROOM_PPM). A caller that holds the
        // user's budget passes it as maxUnderlyingIn so the router enforces THAT.
        const { underlyingNeeded } = await this.router.quote(sharesValue);
        const maxUnderlyingIn = params.maxUnderlyingIn ?? defaultMaxUnderlyingIn(underlyingNeeded);
        if (maxUnderlyingIn < underlyingNeeded) {
            throw new InvalidYieldAmount(
                `maxUnderlyingIn ${maxUnderlyingIn} is below the quoted underlyingNeeded ${underlyingNeeded}`,
            );
        }

        // Re-target at the router's exact-shares deposit — identical proof context, plus wrap +
        // spend cap — and plan whatever must land first for the router to pull the underlying.
        const depositTx = await this.codec.encodeDepositExactShares(prep.depositTx, {
            deployment: this.deployment,
            sharesValue,
            maxUnderlyingIn,
        });
        const approvalTxs = await this.codec.planDepositFunding({
            deployment: this.deployment,
            maxUnderlyingIn,
            fundingSource: params.fundingSource ?? "wallet",
        });
        const approvalTx = approvalTxs[approvalTxs.length - 1] ?? null;

        this.logger?.debug("prepared yield deposit", {
            sharesValue: sharesValue.toString(),
            underlyingNeeded: underlyingNeeded.toString(),
            maxUnderlyingIn: maxUnderlyingIn.toString(),
        });

        return {
            pendingNote: prep.pendingNote,
            approvalTxs,
            approvalTx,
            depositTx,
            sharesValue,
            underlyingNeeded,
            maxUnderlyingIn,
        };
    }

    /**
     * Validates the requested share `value`.
     *
     * @throws {InvalidYieldAmount} When the value is not positive.
     */
    private parseShareValue(value: bigint): bigint {
        if (value <= 0n) {
            throw new InvalidYieldAmount(`value must be > 0, got ${value}`);
        }
        return value;
    }
}

/**
 * Default spend cap for an exact-shares deposit: the quoted underlying plus
 * {@link DEPOSIT_RATE_HEADROOM_PPM}, rounded up and floored at one whole unit (a zero quote stays
 * zero). Exported so a caller that funds the underlying itself can size the same figure.
 */
export function defaultMaxUnderlyingIn(underlyingNeeded: bigint): bigint {
    if (underlyingNeeded <= 0n) return 0n;
    return underlyingNeeded + ppmHeadroom(underlyingNeeded);
}

/**
 * {@link DEPOSIT_RATE_HEADROOM_PPM} of `amount`, rounded up and floored at one whole underlying
 * unit: the rate reserve a cap or a budget carries for the time between quote and execution.
 */
export function ppmHeadroom(amount: bigint, ppm: bigint = DEPOSIT_RATE_HEADROOM_PPM): bigint {
    const ceilHeadroom = (amount * ppm + YIELD_PPM_DENOMINATOR - 1n) / YIELD_PPM_DENOMINATOR;
    return ceilHeadroom > 0n ? ceilHeadroom : 1n;
}

/**
 * The pool vetting fee (bps) implied by a router quote: `total − value` is floor(value × fee /
 * 10000), which pins the integer fee exactly once `value >= 10000` share units. Below that only a
 * lower bound is known, so callers probe at least 10000 (sizeSharesForBudget).
 */
export function inferVettingFeeBps(value: bigint, total: bigint): bigint {
    if (value <= 0n || total <= value) return 0n;
    const feeShares = total - value;
    return (feeShares * YIELD_BPS_DENOMINATOR + value - 1n) / value;
}
