import type { IHTTPClient, RelayerInfo, StellarAddress, StellarYieldDeployment } from "../../src/internal.js";
import {
    Groth16Prover,
    HTTPClient,
    HttpASPDataProvider,
    LocalCircuitArtifacts,
    StellarAddressSchema,
    StellarPoolSessionBuilder,
    StellarProofService,
    StellarRelayerInteractor,
} from "../../src/internal.js";
import type { Actor } from "./actors.js";
import type { E2EContext } from "./context.js";
import { E2E_RECEIPT_POLL_INTERVAL_MS } from "./context.js";
import { CIRCUIT_ARTIFACTS_DIR } from "./chain.js";
import { createNoRelayerInteractor } from "../noRelayerInteractor.js";

export type Session = Awaited<ReturnType<typeof StellarPoolSessionBuilder.create>>;

export interface RelayedSessionOptions {
    /** Point the session's relayer at another URL, e.g. a fault-injecting proxy. */
    relayerUrl?: string;
    /** Replace the HTTP client (fast timeouts, no retries) used for the relayer. */
    httpClient?: IHTTPClient;
}

/** The session config every helper starts from. */
export function sessionConfig(ctx: E2EContext, actor: Actor, options: { withYield?: boolean } = {}) {
    const { network } = ctx;
    const withYield = (options.withYield ?? true) && network.yields.length > 0;
    return {
        chainId: 1,
        ownerAddress: actor.address,
        rpcUrl: network.rpcUrl,
        receiptPollIntervalMs: E2E_RECEIPT_POLL_INTERVAL_MS,
        networkPassphrase: network.networkPassphrase,
        poolContractId: network.poolId,
        keystoreContractId: network.keystoreId,
        aspRegistryContractId: network.aspRegistryId,
        protocolKeys: actor.keys,
        walletInteractor: { type: "keypair" as const, secretKey: actor.keypair.secret() },
        // StellarPoolSessionBuilder's only built-in ASP path is IPFS (no `aspUrl` field exists on
        // its config) — override with the real HTTP path against the mock ASP server, the same way
        // a production integrator would, exactly like evm-sdk's session config does for EVM.
        ipfsGatewayUrl: "http://unused.invalid",
        aspDataProvider: new HttpASPDataProvider({
            aspUrl: ctx.aspUrl,
            chainId: 1,
            entrypointAddress: network.poolId,
            httpClient: new HTTPClient(),
        }),
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        // Every session carries every yield deployment the network has — they only add yield
        // namespaces, so suites that never read them are unaffected.
        yieldDeployments: withYield ? network.yields.map(yieldDeploymentOf) : undefined,
    };
}

/** The deployment file's yield record as sessions take it (`YieldDeploymentConfig<StellarAddress>`). */
export function yieldDeploymentOf(y: E2EContext["network"]["yields"][number]): StellarYieldDeployment {
    return {
        router: y.router,
        shareToken: y.shareToken,
        shareDecimals: y.shareDecimals,
        underlying: y.underlying,
        underlyingDecimals: y.underlyingDecimals,
        underlyingSymbol: y.underlyingSymbol,
    };
}

/** A session that submits its own transactions (no relayer). */
export function selfSubmitSession(
    ctx: E2EContext,
    actor: Actor,
    options: { withYield?: boolean } = {},
): Promise<Session> {
    return StellarPoolSessionBuilder.create({
        ...sessionConfig(ctx, actor, options),
        relayerInteractor: createNoRelayerInteractor(),
    });
}

/** A session wired to the locally running relayer (genuine relayed withdrawals). */
export function relayedSession(
    ctx: E2EContext,
    actor: Actor,
    options: RelayedSessionOptions = {},
): Promise<Session> {
    const relayer = { ...localRelayerInfo(ctx), ...(options.relayerUrl ? { url: options.relayerUrl } : {}) };
    return StellarPoolSessionBuilder.create({
        ...sessionConfig(ctx, actor),
        relayers: [relayer],
        // The builder's own relayer client uses its default HTTP client (15 s timeout, retries); a
        // caller's fast one (the relayer-fault suite's) only takes effect through an explicit interactor.
        ...(options.httpClient
            ? { relayerInteractor: relayerClient(ctx, { url: relayer.url, httpClient: options.httpClient }).interactor }
            : {}),
    });
}

/** The locally running relayer, described the way sessions and quote requests take it. */
export function localRelayerInfo(ctx: E2EContext, url: string = ctx.relayer.url): RelayerInfo<StellarAddress> {
    return {
        name: "e2e local relayer",
        url,
        address: ctx.relayer.address,
        processorAddress: ctx.relayer.processorAddress,
        chainId: 1,
        chainType: "stellar",
        status: "active",
    };
}

/**
 * A relayer client for asking the relayer for quotes directly — how an unregistered account, which
 * cannot build a session-level withdraw proof yet, obtains the quote it hands to `registerAndWithdraw`.
 * Stellar has no `registerAndWithdraw` support, but the same client also backs the driver's
 * `withdrawalQuote` capability member.
 */
export function relayerClient(
    ctx: E2EContext,
    options: { url?: string; httpClient?: IHTTPClient } = {},
): { interactor: StellarRelayerInteractor; info: RelayerInfo<StellarAddress> } {
    const info = localRelayerInfo(ctx, options.url);
    const circuitArtifacts = new LocalCircuitArtifacts({ baseDir: CIRCUIT_ARTIFACTS_DIR });
    const interactor = new StellarRelayerInteractor({
        relayers: [info],
        httpClient: options.httpClient ?? new HTTPClient(),
        addressSchema: StellarAddressSchema,
        proofService: new StellarProofService({ circuitArtifacts, groth16Prover: new Groth16Prover() }),
    });
    return { interactor, info };
}
