import type { AspChainEventSource, MockAspHttpServerConfig } from "../internal.js";
import { MockAspHttpServer, StellarAspRootPublisher } from "../internal.js";

export interface StartStellarMockAspConfig {
    rpcUrl: string;
    networkPassphrase: string;
    /** The chain id `HttpASPDataProvider` scopes its requests to (e.g. the relayer config's `id`). */
    chainId: number;
    aspRegistryContractId: string;
    /** Enforced against `?entrypoint=`; omit to accept any. On Stellar this is the pool contract id. */
    entrypointAddress?: string;
    /** Raw StrKey secret seed ("S...") for the identity holding the registry's `postman` role. */
    signerSecretKey: string;
    /** Serves `note-events` / `event-snapshot`; omit and both answer `501`. */
    eventSource?: AspChainEventSource;
    seedPublishedRoot?: boolean;
    host?: string;
    port?: number;
    log?: (line: string) => void;
}

/**
 * Wires the chain-agnostic {@link MockAspHttpServer} to a Stellar `asp-registry` contract and
 * starts it.
 *
 * @throws {Error} When the port cannot be bound.
 */
export function startStellarMockAsp(config: StartStellarMockAspConfig): Promise<MockAspHttpServer> {
    const serverConfig: MockAspHttpServerConfig = {
        scope: { chainId: config.chainId, entrypoint: config.entrypointAddress },
        publisher: new StellarAspRootPublisher({
            rpcUrl: config.rpcUrl,
            networkPassphrase: config.networkPassphrase,
            aspRegistryContractId: config.aspRegistryContractId,
            signerSecretKey: config.signerSecretKey,
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
