import type {
    StellarAddress,
    StellarChainExtensions,
    StellarDeriveFromSignatureConfig,
    StellarLog,
    StellarProof,
    StellarYieldSessions,
} from "../../internal.js";
import { PoolSession } from "../../internal.js";

/**
 * The Stellar {@link PoolSession}: the generic session plus the yield namespace built by
 * `createStellarPoolSession` (the Stellar counterpart of evm-sdk's `EvmPoolSession`).
 */
export class StellarPoolSession extends PoolSession<
    string,
    StellarAddress,
    StellarProof,
    StellarLog,
    StellarChainExtensions,
    StellarDeriveFromSignatureConfig
> {
    /** The first configured yield deployment's sessions, if any. */
    get yield(): StellarYieldSessions | undefined {
        return this.chainExtensions?.yield;
    }

    /** Every configured yield deployment's sessions, in configuration order. */
    get yields(): readonly StellarYieldSessions[] {
        return this.chainExtensions?.yields ?? [];
    }

    /**
     * The yield sessions whose share token or underlying is `tokenAddress` (StrKeys compare
     * exactly).
     *
     * @param tokenAddress - A share-token or underlying contract address.
     * @returns The matching sessions, or undefined.
     */
    yieldFor(tokenAddress: StellarAddress): StellarYieldSessions | undefined {
        return this.yields.find(
            (y) => y.deployment.shareToken === tokenAddress || y.deployment.underlying === tokenAddress,
        );
    }
}
