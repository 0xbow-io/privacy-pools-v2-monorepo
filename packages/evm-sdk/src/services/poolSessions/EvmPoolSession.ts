import type { Address, EVMProof, PreparedTransaction, TxLog, YieldSessions } from "../../internal.js";
import { PoolSession } from "../../internal.js";

/** Opaque chain-extensions bag `EvmPoolSession` reads — built by `createEvmPoolSession`. */
export interface EvmChainExtensions {
    yield?: YieldSessions;
    yields?: YieldSessions[];
}

/**
 * EVM `PoolSession` — extends core-sdk's chain-agnostic `PoolSession` with the Aave-yield
 * (ppUSDC) namespace, a specific EVM smart-contract product feature (an ERC-4626 Aave-backed
 * vault) that isn't a general chain capability core-sdk's own `PoolSession` doesn't know about.
 * `reshieldTransfer`/`reshieldTransferCrosschain` (withdraw + swap + deposit-for-a-recipient) are
 * NOT redeclared here — they're generic `ChainSessionExtensions` slots now (see
 * `EvmPoolSessionFactory`'s `buildChainExtensions`), inherited from the base `PoolSession` class
 * like `reshield`/`reshieldCrosschain` already were. Built by `createEvmPoolSession`, never
 * constructed directly.
 */
export class EvmPoolSession extends PoolSession<
    PreparedTransaction,
    Address,
    EVMProof,
    TxLog,
    EvmChainExtensions
> {
    /**
     * The Aave-yield (ppUSDC) sessions and interactors — present only when a `yieldDeployment` was
     * supplied in the config. Undefined otherwise.
     */
    get yield(): YieldSessions | undefined {
        return this.chainExtensions?.yield;
    }

    /**
     * Every yield namespace this session serves, in configuration order (`yieldDeployment` first,
     * then `yieldDeployments`). Empty when yield is not configured; `yield` is `yields[0]`.
     */
    get yields(): readonly YieldSessions[] {
        return this.chainExtensions?.yields ?? [];
    }

    /**
     * The yield namespace serving `tokenAddress`, matched (case-insensitively) against each
     * deployment's share token (`ppUSDC`) or its underlying. Undefined when none serves it.
     */
    yieldFor(tokenAddress: Address): YieldSessions | undefined {
        const key = tokenAddress.toLowerCase();
        return this.yields.find(
            (y) =>
                y.deployment.ppUSDC.toLowerCase() === key ||
                y.deployment.underlying.toLowerCase() === key,
        );
    }
}
