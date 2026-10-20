import type { Address } from "viem";

import type { AspChainEventSource, EvmPublisherSigner, MockAspHttpServerConfig } from "../internal.js";
import { EvmAspRootPublisher, MockAspHttpServer } from "../internal.js";

export interface StartEvmMockAspConfig {
    rpcUrl: string;
    chainId: number;
    aspRegistryAddress: Address;
    /** Enforced against `?entrypoint=`; omit to accept any. */
    entrypointAddress?: Address;
    signer: EvmPublisherSigner;
    forkMode?: boolean;
    /** Serves `note-events` / `event-snapshot`; omit and both answer `501`. */
    eventSource?: AspChainEventSource;
    seedPublishedRoot?: boolean;
    host?: string;
    port?: number;
    log?: (line: string) => void;
}

/**
 * Wires the chain-agnostic {@link MockAspHttpServer} to an EVM `ASPRegistry` and starts it.
 *
 * @throws {Error} When the port cannot be bound.
 */
export function startEvmMockAsp(config: StartEvmMockAspConfig): Promise<MockAspHttpServer> {
    const serverConfig: MockAspHttpServerConfig = {
        scope: { chainId: config.chainId, entrypoint: config.entrypointAddress },
        publisher: new EvmAspRootPublisher({
            rpcUrl: config.rpcUrl,
            chainId: config.chainId,
            aspRegistryAddress: config.aspRegistryAddress,
            signer: config.signer,
            forkMode: config.forkMode,
            log: config.log,
        }),
        eventSource: config.eventSource,
        seedPublishedRoot: config.seedPublishedRoot,
        host: config.host,
        port: config.port,
        log: config.log,
    };
    return MockAspHttpServer.start(serverConfig);
}
