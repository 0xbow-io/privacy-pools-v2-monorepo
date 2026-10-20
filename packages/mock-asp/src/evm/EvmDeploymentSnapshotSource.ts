import type { AspChainEventSource, WireEventSnapshot } from "../internal.js";

export interface EvmDeploymentSnapshotSourceConfig {
    chainId: number;
    /** Block the pool stack was deployed at (decimal number, bigint, or `0x` hex). */
    deploymentBlock: bigint | number | string;
}

/**
 * Serves an honestly EMPTY event snapshot covering everything through the deployment block, and
 * nothing else (`note-events` stays unimplemented → `501`).
 *
 * Why it exists: on a local anvil fork of a public chain, `eth_getLogs` only works from the fork
 * point onward. Note discovery's promotion-evidence and phantom-purge passes need a chain-side
 * commitment set; with no snapshot they fall back to a from-genesis log scan the fork cannot serve.
 * A snapshot ending at the deploy block is truthful — nothing can have been deposited before the
 * contracts existed — and makes those passes scan only the tail from there.
 */
export class EvmDeploymentSnapshotSource implements AspChainEventSource {
    private readonly config: EvmDeploymentSnapshotSourceConfig;

    constructor(config: EvmDeploymentSnapshotSourceConfig) {
        this.config = config;
    }

    getEventSnapshot(): Promise<WireEventSnapshot> {
        return Promise.resolve({
            chainId: String(this.config.chainId),
            snapshotBlockNumber: BigInt(this.config.deploymentBlock).toString(),
            generatedAt: new Date().toISOString(),
            deposits: [],
            transacts: [],
            ragequits: [],
            leaves: [],
            keystoreLeaves: [],
        });
    }
}
