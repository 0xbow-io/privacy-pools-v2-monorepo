import { startStellarMockAsp } from "@privacy-pools-v2/mock-asp/stellar";
import type { MockAspHttpServer } from "@privacy-pools-v2/mock-asp";

import type { Hash, Hex } from "../src/internal.js";
import { bigintToHex } from "../src/internal.js";
import type { StellarE2ENetwork } from "./network.js";

export interface MockAspServerConfig {
    network: StellarE2ENetwork;
}

/**
 * Thin e2e controller over `@privacy-pools-v2/mock-asp`: a real HTTP ASP that writes association
 * roots on-chain and is read by the SDK through the genuine `HttpASPDataProvider` (sessions are
 * configured with {@link MockAspServer.url} as their ASP source).
 *
 * Signs `update_asp_root` directly with `network.adminSecret` — the deploy admin already holds
 * the asp-registry's `postman` role (see `initialize.mts`'s `--postman deployer`), so no
 * impersonation step is needed, matching EVM's own from-genesis-deploy precedent.
 */
export class MockAspServer {
    private constructor(private readonly server: MockAspHttpServer) {}

    static async create(config: MockAspServerConfig): Promise<MockAspServer> {
        const { network } = config;
        const server = await startStellarMockAsp({
            rpcUrl: network.rpcUrl,
            networkPassphrase: network.networkPassphrase,
            chainId: 1,
            aspRegistryContractId: network.aspRegistryId,
            entrypointAddress: network.poolId,
            signerSecretKey: network.adminSecret,
        });
        return new MockAspServer(server);
    }

    /** Base URL to pass as a session's ASP source. */
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
