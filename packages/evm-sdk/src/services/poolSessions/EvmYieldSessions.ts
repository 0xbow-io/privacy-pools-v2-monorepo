import type {
    Address,
    EvmPoolSessionYieldDepositConfig,
    EvmPoolSessionYieldEarnedConfig,
    EvmPoolSessionYieldWithdrawConfig,
    PoolSessionYieldDepositDependencies,
    PoolSessionYieldEarnedDependencies,
    PoolSessionYieldWithdrawDependencies,
    YieldDeployment,
    YieldDeploymentConfig,
} from "../../internal.js";
import {
    EMPTY_ADDRESS,
    EvmAddressEqualityComparator,
    EvmPayoutRoutingCodec,
    EvmYieldRouterCodec,
    PoolSessionYieldDeposit,
    PoolSessionYieldEarned,
    PoolSessionYieldWithdraw,
} from "../../internal.js";

/**
 * The core-sdk view of an EVM yield deployment. `YieldDeployment` keeps its pre-split field names
 * (`ppRouter`, `ppUSDC`, `ppUSDCDecimals`) because they are this package's public configuration.
 */
export function toYieldDeploymentConfig(deployment: YieldDeployment): YieldDeploymentConfig<Address> {
    return {
        router: deployment.ppRouter,
        shareToken: deployment.ppUSDC,
        shareDecimals: deployment.ppUSDCDecimals,
        underlying: deployment.underlying,
        underlyingDecimals: deployment.underlyingDecimals,
        underlyingSymbol: deployment.underlyingSymbol,
    };
}

/**
 * The Aave-yield (ppUSDC) deposit session: core-sdk's chain-agnostic {@link PoolSessionYieldDeposit}
 * over {@link EvmYieldRouterCodec} (`Entrypoint.deposit` -> `PPRouter.depositExactShares[Native]`,
 * plus the ERC-20 approvals), configured from an EVM {@link YieldDeployment}.
 */
export class EvmPoolSessionYieldDeposit extends PoolSessionYieldDeposit {
    constructor(config: EvmPoolSessionYieldDepositConfig, deps?: PoolSessionYieldDepositDependencies) {
        super(
            {
                deployment: toYieldDeploymentConfig(config.deployment),
                deposit: config.deposit,
                router: config.router,
                yieldToken: config.yieldToken,
                codec: new EvmYieldRouterCodec({
                    nativeMode: config.deployment.nativeMode,
                    allowanceOf: config.allowanceOf,
                }),
            },
            deps,
        );
    }
}

/**
 * The Aave-yield (ppUSDC) withdraw session: core-sdk's chain-agnostic
 * {@link PoolSessionYieldWithdraw} over {@link EvmYieldRouterCodec}
 * (`PoolVault.transact` -> `PPRouter.withdrawToUnderlying`) and the ABI `PayoutRouting` codec.
 */
export class EvmPoolSessionYieldWithdraw extends PoolSessionYieldWithdraw {
    constructor(config: EvmPoolSessionYieldWithdrawConfig, deps?: PoolSessionYieldWithdrawDependencies) {
        super(
            {
                deployment: toYieldDeploymentConfig(config.deployment),
                orchestrator: config.orchestrator,
                router: config.router,
                codec: new EvmYieldRouterCodec({ nativeMode: config.deployment.nativeMode }),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                emptyAddress: EMPTY_ADDRESS,
            },
            deps,
        );
    }
}

/** The Aave-yield (ppUSDC) earned session, configured from an EVM {@link YieldDeployment}. */
export class EvmPoolSessionYieldEarned extends PoolSessionYieldEarned {
    constructor(config: EvmPoolSessionYieldEarnedConfig, deps?: PoolSessionYieldEarnedDependencies) {
        super({ ...config, deployment: toYieldDeploymentConfig(config.deployment) }, deps);
    }
}
