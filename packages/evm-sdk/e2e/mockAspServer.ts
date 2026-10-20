import { EvmDeploymentSnapshotSource, startEvmMockAsp } from "@privacy-pools-v2/mock-asp/evm";
import type { MockAspHttpServer } from "@privacy-pools-v2/mock-asp";

import type { Address, Hash, Hex } from "../src/internal.js";
import { bigintToHex } from "../src/internal.js";
import type { EvmE2ENetwork } from "./network.js";

export interface MockAspServerConfig {
    network: EvmE2ENetwork;
}

/**
 * Thin e2e controller over `@privacy-pools-v2/mock-asp`: a real HTTP ASP that writes association
 * roots on-chain and is read by the SDK through the genuine `HttpASPDataProvider` + `HTTPClient`
 * (sessions are configured with {@link MockAspServer.url} as their `aspUrl`).
 *
 * Signs `updateASPRoot` directly with `network.deployerPrivateKey` — `DeployE2ELocal.s.sol`
 * deliberately made that same key the `postman` role holder, so no `anvil_impersonateAccount`.
 * Serves an honestly empty event snapshot through the deployment block (the anvil fork can't serve
 * `eth_getLogs` from genesis) and leaves `note-events` unimplemented, so discovery scans the chain.
 */
export class MockAspServer {
    private constructor(private readonly server: MockAspHttpServer) {}

    static async create(config: MockAspServerConfig): Promise<MockAspServer> {
        const { network } = config;
        const server = await startEvmMockAsp({
            rpcUrl: network.rpcUrl,
            chainId: network.chainId,
            aspRegistryAddress: network.aspRegistryAddress,
            entrypointAddress: network.entrypointAddress as Address,
            signer: { kind: "privateKey", privateKey: network.deployerPrivateKey },
            eventSource: new EvmDeploymentSnapshotSource({
                chainId: network.chainId,
                deploymentBlock: network.deploymentBlock,
            }),
        });
        return new MockAspServer(server);
    }

    /** Base URL to pass as a session's `aspUrl`. */
    get url(): string {
        return this.server.url;
    }

    /** Approves a deposit's `label` (as returned by `prepareDeposit`), pushing the new root on-chain. */
    async approveLabel(label: Hex): Promise<void> {
        await this.server.approveLabel(label);
    }

    getRoot(): Hash {
        return bigintToHex(this.server.state.publishedRoot) as Hash;
    }

    getLeaves(): Hex[] {
        return [...this.server.state.leaves];
    }

    async stop(): Promise<void> {
        await this.server.stop();
    }
}
