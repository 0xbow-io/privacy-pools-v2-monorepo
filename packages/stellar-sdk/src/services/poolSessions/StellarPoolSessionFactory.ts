import type {
    Address,
    ChainSessionBuildContext,
    ChainSessionExtensions,
    ICryptoService,
    IStellarRPCInteractor,
    PoolSessionConfig,
    PoolSessionDependencies,
    StellarAddress,
    StellarChainExtensions,
    StellarDeriveFromSignatureConfig,
    StellarLog,
    StellarProof,
    StellarYieldSessionConfig,
    StellarYieldSessions,
} from "../../internal.js";
import {
    createStellarEntrypointInteractor,
    DuplicateYieldDeployment,
    PoolSessionYieldDeposit,
    PoolSessionYieldEarned,
    PoolSessionYieldWithdraw,
    StellarPoolSession,
    StellarYieldRouterCodec,
    StellarYieldRouterInteractor,
    StellarYieldTokenInteractor,
    InMemoryStorageService,
    PaymentRequestService,
    PaymentRequestStorageAdapter,
    PoolSessionFactory,
    STELLAR_EMPTY_ADDRESS,
    StellarAddressEqualityComparator,
    StellarAddressFieldConverter,
    StellarAddressSchema,
    StellarContextHashService,
    StellarPayoutRoutingCodec,
    StellarPreparedTxVerifier,
    StellarRelayBatchCodec,
} from "../../internal.js";

/**
 * Configuration for {@link createStellarPoolSession} — `PoolSessionConfig` plus the one piece of
 * chain config every other chain's factory doesn't need: `StellarPreparedTxVerifier` must parse
 * the built transaction's XDR envelope, which needs the network passphrase it was built against.
 */
export type StellarPoolSessionConfig = PoolSessionConfig<
    string,
    StellarAddress,
    StellarProof,
    StellarLog,
    StellarDeriveFromSignatureConfig
> & {
    /** The network passphrase (e.g. `Networks.TESTNET`) this session's transactions are built against. */
    networkPassphrase: string;
    /**
     * Yield deployments and the Soroban reads/writes their sessions need. When set, the session
     * exposes `yield`/`yields`/`yieldFor` (see {@link StellarPoolSession}).
     */
    yield?: StellarYieldSessionConfig;
};

/**
 * Builds a fully-wired Stellar {@link PoolSession}: supplies Stellar defaults for every
 * chain-specific codec/comparator/schema {@link PoolSessionFactory.create} otherwise requires
 * explicitly, then delegates to it — the Stellar counterpart to {@link createEvmPoolSession},
 * same "one factory function per chain, generic core untouched" split.
 *
 * `relayBatchCodec` defaults to {@link StellarRelayBatchCodec} over the session's own RPC, with the
 * owner as the submitting account — the relay contract's `relay_batch` for a self-submitted batch.
 *
 * `noteDiscovery` is wired on the resulting session whenever `config.poolVaultInteractor` is
 * set — `PoolSessionNoteDiscovery` no longer needs an EVM-shaped `rpcInteractor` at all (it reads
 * the current cursor from `poolVaultInteractor.getCurrentCursor()` instead of
 * `rpcInteractor.getBlockNumber()`), so it works for Stellar the same way it does for EVM.
 *

 * This function is synchronous, so — like {@link createEvmPoolSession} — its `paymentRequestService`
 * default is always in-memory, never hydrated from storage; pass a pre-loaded one via
 * `config.paymentRequestService` for persistence.
 *
 * @param config - Unified configuration plus `networkPassphrase`; every chain-specific field is
 *   optional here and defaults to its Stellar implementation when omitted.
 * @param deps - Optional shared dependencies (e.g. logger).
 * @returns A fully initialized PoolSession.
 */
export function createStellarPoolSession(
    config: StellarPoolSessionConfig,
    deps?: PoolSessionDependencies,
): StellarPoolSession {
    const logger = deps?.logger;

    const paymentRequestService =
        config.paymentRequestService ??
        new PaymentRequestService(
            {
                // IPaymentRequestService stays concretely EVM-shaped by design (see
                // PoolSessionDeposit's own class doc) — same documented EVM-only-boundary cast
                // as PaymentRequestStorageAdapter below.
                ownerAddress: config.ownerAddress as Address,
                // PaymentRequestService only uses ICryptoService's chain-agnostic members, never
                // `deriveKeysFromSignature` — same documented EVM-only-boundary cast core-sdk's
                // own PoolSessionFactory.create uses for its equivalent `genericCryptoService`.
                cryptoService: config.cryptoService as unknown as ICryptoService,
                hashService: config.hashService,
                noteComputationService: config.noteComputationService,
                keystoreManager: config.keystoreManager,
                // PaymentRequestStorageAdapter is concretely EVM-shaped (numeric chainId,
                // case-folds ownerAddress via .toLowerCase() — harmless for a StrKey, which has
                // no case-insensitive alias, just an unusual-looking but stable storage key).
                // Not yet genericized; same documented EVM-only-boundary pattern used throughout
                // PoolSessionFactory.create for still-EVM-only sessions.
                storageAdapter: new PaymentRequestStorageAdapter(
                    config.chainId,
                    new InMemoryStorageService(),
                    config.ownerAddress as unknown as Address,
                ),
            },
            { logger },
        );

    return PoolSessionFactory.create(
        {
            ...config,
            preparedTxVerifier:
                config.preparedTxVerifier ??
                new StellarPreparedTxVerifier({ networkPassphrase: config.networkPassphrase }),
            payoutRoutingCodec: config.payoutRoutingCodec ?? new StellarPayoutRoutingCodec(),
            addressFieldConverter:
                config.addressFieldConverter ?? new StellarAddressFieldConverter(),
            addressEqualityComparator:
                config.addressEqualityComparator ?? new StellarAddressEqualityComparator(),
            contextHashService: config.contextHashService ?? new StellarContextHashService(),
            relayBatchCodec:
                config.relayBatchCodec ??
                new StellarRelayBatchCodec({
                    // The factory's rpcInteractor is narrowed to ITxReceiptWaiter generically; the
                    // runtime object a Stellar caller supplies is the full SorobanRPCInteractor.
                    rpcInteractor: config.rpcInteractor as unknown as IStellarRPCInteractor,
                    sourceAddress: config.ownerAddress,
                }),
            addressSchema: config.addressSchema ?? StellarAddressSchema,
            emptyAddress: config.emptyAddress ?? (STELLAR_EMPTY_ADDRESS as StellarAddress),
            paymentRequestService,
            buildChainExtensions: (ctx) => buildStellarYieldExtensions(config, ctx),
        },
        deps,
        StellarPoolSession,
    );
}

/**
 * Builds the yield namespace — one {@link StellarYieldSessions} per configured deployment — from
 * the core-sdk yield sessions over the Soroban interactors and {@link StellarYieldRouterCodec}.
 *
 * The yield deposit runs on its OWN deposit session, over an entrypoint that encodes the share-token
 * deposit without simulating it: the depositor holds no shares until the router mints them inside
 * `deposit_exact_shares`, so simulating the plain pool `deposit` would always fail. The codec lifts
 * that unsimulated call's arguments into the (simulated) router call.
 */
function buildStellarYieldExtensions(
    config: StellarPoolSessionConfig,
    ctx: ChainSessionBuildContext<string, StellarAddress, StellarProof, StellarLog>,
): ChainSessionExtensions<string, StellarAddress, StellarProof, StellarLog> {
    const y = config.yield;
    if (!y || y.deployments.length === 0 || !ctx.buildDeposit || !ctx.transactCore) return {};

    const seen = new Set<string>();
    for (const d of y.deployments) {
        if (seen.has(d.shareToken)) {
            throw new DuplicateYieldDeployment(
                `yield deployment for share ${d.shareToken} configured twice on chain ${config.chainId}`,
            );
        }
        seen.add(d.shareToken);
    }

    const deposit = ctx.buildDeposit({
        entrypointInteractor: createStellarEntrypointInteractor(
            {
                rpcInteractor: y.rpcInteractor,
                contractId: y.poolContractId,
                aspRegistryContractId: y.aspRegistryContractId,
                readSourcePublicKey: y.readSourcePublicKey,
                simulateDeposits: false,
                networkPassphrase: config.networkPassphrase,
            },
            { walletInteractor: y.walletInteractor },
        ),
    });
    const codec = new StellarYieldRouterCodec({
        rpcInteractor: y.rpcInteractor,
        networkPassphrase: config.networkPassphrase,
    });
    const logger = ctx.logger;

    const yields: StellarYieldSessions[] = y.deployments.map((deployment) => {
        const token = new StellarYieldTokenInteractor({
            rpcInteractor: y.rpcInteractor,
            contractId: deployment.shareToken,
            readSourcePublicKey: y.readSourcePublicKey,
        });
        const router = new StellarYieldRouterInteractor({
            rpcInteractor: y.rpcInteractor,
            contractId: deployment.router,
            readSourcePublicKey: y.readSourcePublicKey,
            poolContractId: y.poolContractId,
            yieldToken: token,
        });
        return {
            deployment,
            deposit: new PoolSessionYieldDeposit<string, StellarAddress, StellarProof, StellarLog>(
                { deployment, deposit, router, yieldToken: token, codec },
                { logger },
            ),
            withdraw: new PoolSessionYieldWithdraw<string, StellarAddress, StellarProof, StellarLog>(
                {
                    deployment,
                    orchestrator: ctx.transactCore!,
                    router,
                    codec,
                    payoutRoutingCodec: config.payoutRoutingCodec ?? new StellarPayoutRoutingCodec(),
                    addressEqualityComparator:
                        config.addressEqualityComparator ?? new StellarAddressEqualityComparator(),
                    emptyAddress: config.emptyAddress ?? (STELLAR_EMPTY_ADDRESS as StellarAddress),
                },
                { logger },
            ),
            earned: new PoolSessionYieldEarned<StellarAddress>(
                {
                    deployment,
                    noteManager: config.noteManager,
                    keystoreManager: config.keystoreManager,
                    noteComputationService: config.noteComputationService,
                    yieldToken: token,
                },
                { logger },
            ),
            token,
            router,
        };
    });

    return { chainExtensions: { yield: yields[0], yields } satisfies StellarChainExtensions };
}
