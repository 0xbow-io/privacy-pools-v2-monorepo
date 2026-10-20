import type { Hex } from "viem";
import { createPublicClient, http } from "viem";

import type {
    DeploymentAddresses,
    IHTTPClient,
    RelayerInfo,
    ISwapAndDepositQuoteProvider,
    ISwapQuoteProvider,
    YieldDeployment,
} from "../../src/internal.js";
import {
    AddressSchema,
    HTTPClient,
    PoolSessionBuilder,
    RelayerInteractor,
    ViemRPCInteractor,
} from "../../src/internal.js";
import { createNoRelayerInteractor } from "../noRelayerInteractor.js";
import type { Actor } from "./actors.js";
import { walletFor } from "./actors.js";
import type { E2EContext } from "./context.js";
import { E2E_POLLING_INTERVAL_MS } from "./context.js";
import { CIRCUIT_ARTIFACTS_DIR } from "./chain.js";

export type Session = Awaited<ReturnType<ReturnType<typeof PoolSessionBuilder.fromConfig>["create"]>>;

export interface RelayedSessionOptions {
    swapQuoteProvider?: ISwapQuoteProvider;
    swapAndDepositQuoteProvider?: ISwapAndDepositQuoteProvider;
    yieldDeployment?: YieldDeployment;
    /** Point the session's relayer at another URL, e.g. the e2e-suite's fault-injecting `RelayerProxy`. */
    relayerUrl?: string;
    /** Replace the HTTP client (fast timeouts, no retries) used for the relayer and the ASP. */
    httpClient?: IHTTPClient;
    /** Construction-time destination-chain wiring for RelaySwaps' cross-chain reshield. */
    destination?: { chainId: number; rpcUrl: string; deployment: DeploymentAddresses };
}

/** The session config every helper starts from; exported so config-validation tests can break one field. */
export function sessionConfig(ctx: E2EContext, actor: Actor) {
    const { network } = ctx;
    return {
        chainId: network.chainId,
        deployment: {
            poolAddress: network.poolAddress,
            entrypointAddress: network.entrypointAddress,
            keystoreAddress: network.keystoreAddress,
            aspRegistryAddress: network.aspRegistryAddress,
            relaySwapsAddress: network.relaySwapsAddress,
        },
        rpcUrl: network.rpcUrl,
        // The real HTTP path: the session builds its own HttpASPDataProvider + HTTPClient against the
        // mock ASP server, exactly as a production integrator would.
        aspUrl: ctx.aspUrl,
        ownerAddress: actor.address,
        protocolKeys: actor.keys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        walletInteractor: { type: "viem" as const, walletClient: walletFor(ctx, actor) },
        // Bounds the Keystore/PoolVault leaf-cache scans to start at the deploy block: the anvil fork
        // cannot serve eth_getLogs from genesis. Must stay the deploy block — the trees need every leaf.
        deploymentBlock: network.deploymentBlock,
    };
}

/** The session's RPC, polling at {@link E2E_POLLING_INTERVAL_MS} instead of viem's 4 s default. */
function fastRpcInteractor(ctx: E2EContext): ViemRPCInteractor {
    return new ViemRPCInteractor({
        publicClient: createPublicClient({
            transport: http(ctx.network.rpcUrl),
            pollingInterval: E2E_POLLING_INTERVAL_MS,
        }),
    });
}

/** A session that submits its own transactions (no relayer). */
export function selfSubmitSession(
    ctx: E2EContext,
    actor: Actor,
    options: { yieldDeployment?: YieldDeployment; yieldDeployments?: YieldDeployment[] } = {},
): Promise<Session> {
    let builder = PoolSessionBuilder.fromConfig(sessionConfig(ctx, actor))
        .withRpcInteractor(fastRpcInteractor(ctx))
        .withRelayerInteractor(createNoRelayerInteractor());
    if (options.yieldDeployment) builder = builder.withYieldDeployment(options.yieldDeployment);
    if (options.yieldDeployments) builder = builder.withYieldDeployments(options.yieldDeployments);
    return builder.create();
}

/** The fork's yield (ppUSDC over the mock `yUSDC`) deployment, as sessions take it. */
export function e2eYieldDeployment(ctx: E2EContext): YieldDeployment {
    return {
        ppRouter: ctx.network.yieldRouterAddress,
        zap: ctx.network.yieldZapAddress,
        ppUSDC: ctx.network.yieldTokenAddress,
        ppUSDCDecimals: 18,
        underlying: ctx.network.yieldUnderlyingAddress,
        underlyingDecimals: 6,
        underlyingSymbol: "yUSDC",
    };
}

/** The fork's native-coin yield (ppWETH over `MockWETH9`, router in native mode) deployment. */
export function e2eNativeYieldDeployment(ctx: E2EContext): YieldDeployment {
    return {
        ppRouter: ctx.network.nativeYieldRouterAddress,
        nativeMode: true,
        zap: ctx.network.nativeYieldZapAddress,
        ppUSDC: ctx.network.nativeYieldTokenAddress,
        ppUSDCDecimals: 18,
        underlying: ctx.network.nativeYieldUnderlyingAddress,
        underlyingDecimals: 18,
        underlyingSymbol: "WETH",
    };
}

/** A session wired to the locally running relayer (genuine relayed withdrawals). */
export function relayedSession(
    ctx: E2EContext,
    actor: Actor,
    options: RelayedSessionOptions = {},
): Promise<Session> {
    const { network } = ctx;
    const relayer = { ...localRelayerInfo(ctx), ...(options.relayerUrl ? { url: options.relayerUrl } : {}) };
    const cfg = {
        ...sessionConfig(ctx, actor),
        relayers: [relayer],
        ...(options.destination
            ? {
                  destinationChainId: options.destination.chainId,
                  destinationRpcUrl: options.destination.rpcUrl,
                  destinationDeployment: options.destination.deployment,
              }
            : {}),
    };
    let builder = PoolSessionBuilder.fromConfig(cfg)
        .withRpcInteractor(fastRpcInteractor(ctx))
        // LIFI_SWAP_EXECUTORS has no Sepolia entry; every chain the SDK ships for has one, so the
        // e2e stands one in rather than leaving native swap-and-deposit unavailable.
        .withSwapExecutor({ executor: network.mockExecutorAddress, erc20Proxy: network.mockErc20ProxyAddress });
    if (options.httpClient) builder = builder.withHttpClient(options.httpClient);
    if (options.swapQuoteProvider) builder = builder.withSwapQuoteProvider(options.swapQuoteProvider);
    if (options.swapAndDepositQuoteProvider) {
        builder = builder.withSwapAndDepositQuoteProvider(options.swapAndDepositQuoteProvider);
    }
    // Unlike the destination fields above, the builder only reads yieldDeployment off its overrides —
    // a raw config field would be silently ignored, so this MUST go through the builder method.
    if (options.yieldDeployment) builder = builder.withYieldDeployment(options.yieldDeployment);
    return builder.create();
}

export type { Hex };

/** The locally running relayer, described the way sessions and quote requests take it. */
export function localRelayerInfo(ctx: E2EContext, url: string = ctx.relayer.url): RelayerInfo {
    return {
        name: "e2e local relayer",
        url,
        address: ctx.relayer.address,
        processorAddress: ctx.relayer.processorAddress,
        chainId: ctx.network.chainId,
        chainType: "evm",
        status: "active",
    };
}

/**
 * A relayer client for asking the relayer for quotes directly — how an unregistered account, which
 * cannot build a session-level withdraw proof yet, obtains the quote it hands to `registerAndWithdraw`.
 */
export function relayerClient(
    ctx: E2EContext,
    options: { url?: string; httpClient?: IHTTPClient } = {},
): { interactor: RelayerInteractor; info: RelayerInfo } {
    const info = localRelayerInfo(ctx, options.url);
    const interactor = new RelayerInteractor({
        relayers: [info],
        httpClient: options.httpClient ?? new HTTPClient(),
        addressSchema: AddressSchema,
    });
    return { interactor, info };
}
