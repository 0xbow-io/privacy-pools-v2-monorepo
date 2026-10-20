import type {
    Address,
    ChainSessionExtensions,
    EvmPoolSessionConfig,
    IRPCInteractor,
    PoolSessionDependencies,
    YieldDeployment,
    YieldSwapWrapper,
} from "../../internal.js";
import {
    AddressSchema,
    DuplicateYieldDeployment,
    EMPTY_ADDRESS,
    EvmAddressEqualityComparator,
    EvmAddressFieldConverter,
    EvmContextHashService,
    EvmNoteDiscoveryService,
    EvmPayoutRoutingCodec,
    EvmPreparedTxVerifier,
    EvmRelayBatchCodec,
    EvmSwapChainAdapter,
    InMemoryStorageService,
    LIFI_SWAP_EXECUTORS,
    NATIVE_ASSET_ADDRESS,
    PaymentRequestService,
    PaymentRequestStorageAdapter,
    PoolSessionFactory,
    PoolSessionReshield,
    PoolSessionReshieldCrosschain,
    PoolSessionReshieldTransfer,
    PoolSessionReshieldTransferCrosschain,
    PoolSessionSwapDeposit,
    PoolSessionWithdrawAndSwap,
    EvmPoolSessionYieldDeposit,
    EvmPoolSessionYieldEarned,
    EvmPoolSessionYieldWithdraw,
    PPRouterInteractor,
    PPYieldTokenInteractor,
    toYieldSwapDepositTarget,
} from "../../internal.js";
import type { EvmChainExtensions } from "./EvmPoolSession.js";
import { EvmPoolSession } from "./EvmPoolSession.js";

/**
 * Builds a fully-wired EVM {@link EvmPoolSession}: supplies EVM defaults for every chain-specific
 * codec/comparator/schema {@link PoolSessionFactory.create} otherwise requires explicitly
 * (including the now-generic swap/reshield/swap-deposit sessions' `swapChainAdapter`), builds the
 * EVM-only extensions (reshield/reshieldCrosschain/swapDeposit — gated behind
 * `buildChainExtensions` purely because their concrete classes need a `TTx` shape not every
 * chain's `TTx` satisfies, not because they're EVM-specific in meaning — plus yield, which IS
 * genuinely EVM-only), then delegates to `PoolSessionFactory.create`. The EVM counterpart to
 * `createEvmPoolVaultInteractor`/`createEvmEntrypointInteractor`/`createEvmKeystoreInteractor` —
 * same "one factory function per chain, generic core untouched" split, kept in its own file so
 * importing `PoolSessionFactory` alone never pulls viem/ABI constants into a Stellar-only bundle.
 *
 * This function is synchronous, so it cannot `await` any service's `loadFromStorage`. The only
 * stateful default it builds — `PaymentRequestService` — is therefore always an in-memory one,
 * never a persistent one: a persistent service it could not hydrate would silently start empty
 * and overwrite saved requests on the next persist. Callers needing persistence construct the
 * service, call `loadFromStorage`, and pass it via `config.paymentRequestService` — which is what
 * `PoolSessionBuilder` (an async wrapper around this function) does.
 *
 * @param config - Unified configuration; every chain-specific field is optional here and
 *   defaults to its EVM implementation when omitted.
 * @param deps - Optional shared dependencies (e.g. logger).
 * @returns A fully initialized EvmPoolSession.
 */
export function createEvmPoolSession(
    config: EvmPoolSessionConfig,
    deps?: PoolSessionDependencies,
): EvmPoolSession {
    const logger = deps?.logger;

    const paymentRequestService =
        config.paymentRequestService ??
        new PaymentRequestService(
            {
                ownerAddress: config.ownerAddress,
                cryptoService: config.cryptoService,
                hashService: config.hashService,
                noteComputationService: config.noteComputationService,
                keystoreManager: config.keystoreManager,
                storageAdapter: new PaymentRequestStorageAdapter(
                    config.chainId,
                    new InMemoryStorageService(),
                    config.ownerAddress,
                ),
            },
            { logger },
        );

    // config.rpcInteractor is narrowed generically to ITxReceiptWaiter<TLog> (see
    // PoolSessionConfig's own doc) — the swap-chain adapter and yield interactors need the wider
    // EVM-shaped IRPCInteractor (readContract). This cast is safe for the same documented reason
    // the pre-split PoolSessionFactory.create() already relied on: the actual runtime object an
    // EVM caller supplies always implements the wider interface too.
    const evmRpcInteractor = config.rpcInteractor as unknown as IRPCInteractor;
    const swapChainAdapter =
        config.swapChainAdapter ?? new EvmSwapChainAdapter({ rpcInteractor: evmRpcInteractor });
    const addressFieldConverter = config.addressFieldConverter ?? new EvmAddressFieldConverter();
    // Defaults to the stealth-aware subclass so ERC-5564 dust-rescue deposits (see
    // EvmNoteDiscoveryService's own doc) are discoverable out of the box — matching this
    // package's own pre-split behavior, where the one concrete NoteDiscoveryService always had
    // scanStealthDeposits built in. A caller not needing it still gets it for free (it only
    // activates on a positive stealth-scan match, an extra no-op check on every ordinary note).
    const noteDiscoveryService =
        config.noteDiscoveryService ??
        new EvmNoteDiscoveryService(
            {
                cryptoService: config.cryptoService,
                hashService: config.hashService,
                noteComputationService: config.noteComputationService,
                addressFieldConverter,
            },
            { logger },
        );

    return PoolSessionFactory.create(
        {
            ...config,
            preparedTxVerifier: config.preparedTxVerifier ?? new EvmPreparedTxVerifier(),
            payoutRoutingCodec: config.payoutRoutingCodec ?? new EvmPayoutRoutingCodec(),
            addressFieldConverter,
            addressEqualityComparator:
                config.addressEqualityComparator ?? new EvmAddressEqualityComparator(),
            contextHashService: config.contextHashService ?? new EvmContextHashService(),
            relayBatchCodec: config.relayBatchCodec ?? new EvmRelayBatchCodec(),
            addressSchema: config.addressSchema ?? AddressSchema,
            emptyAddress: config.emptyAddress ?? EMPTY_ADDRESS,
            nativeAssetAddress: config.nativeAssetAddress ?? NATIVE_ASSET_ADDRESS,
            swapChainAdapter,
            paymentRequestService,
            noteDiscoveryService,
            buildChainExtensions: (ctx): ChainSessionExtensions => {
                const extensions: ChainSessionExtensions = {};

                // Yield deployments are resolved up front — before reshield/reshieldCrosschain/
                // withdrawAndSwap — so all three can share the same `yieldWrappers` array the
                // yield namespace itself uses (one PPYieldTokenInteractor per share, not one per
                // consumer). One namespace per deployment: `yieldDeployment` (single) stays
                // supported and comes first, `yieldDeployments` adds the rest, so a chain with two
                // shares (mainnet ppUSDC + ppUSDT) is one session, not two. The same share twice
                // is a configuration error, not a silent override.
                const yieldDeployments: YieldDeployment[] = [
                    ...(config.yieldDeployment ? [config.yieldDeployment] : []),
                    ...(config.yieldDeployments ?? []),
                ];
                const yieldTokens = new Map<string, PPYieldTokenInteractor>();
                for (const yieldDeployment of yieldDeployments) {
                    const shareKey = yieldDeployment.ppUSDC.toLowerCase();
                    if (yieldTokens.has(shareKey)) {
                        throw new DuplicateYieldDeployment(
                            `yield deployment for share ${yieldDeployment.ppUSDC} configured twice on chain ${config.chainId}`,
                        );
                    }
                    yieldTokens.set(
                        shareKey,
                        new PPYieldTokenInteractor(
                            { rpcInteractor: evmRpcInteractor, contractAddress: yieldDeployment.ppUSDC },
                            { logger },
                        ),
                    );
                }
                const yieldTokenFor = (d: YieldDeployment): PPYieldTokenInteractor =>
                    yieldTokens.get(d.ppUSDC.toLowerCase())!;
                // Yield wrappers the swap/reshield sessions can spend as inputs. Reads the wrapper
                // on THIS chain (the source chain), where a spent yield-share note lives for both
                // same-chain and cross-chain flows.
                const yieldWrappers: YieldSwapWrapper<Address>[] = yieldDeployments.map((d) => ({
                    shareToken: d.ppUSDC,
                    underlying: d.underlying,
                    zap: d.zap,
                    previewRedeem: (shares: bigint) => yieldTokenFor(d).previewRedeem(shares),
                }));

                // Yield namespace: only when a deployment is configured AND the base deposit
                // session and transact core it composes are both available.
                const yields: NonNullable<EvmChainExtensions["yields"]> = [];
                if (yieldDeployments.length > 0 && ctx.deposit && ctx.transactCore) {
                    const deposit = ctx.deposit;
                    const transactCore = ctx.transactCore;
                    for (const yieldDeployment of yieldDeployments) {
                        const router = new PPRouterInteractor(
                            { rpcInteractor: evmRpcInteractor, contractAddress: yieldDeployment.ppRouter },
                            { logger },
                        );
                        const token = yieldTokenFor(yieldDeployment);
                        yields.push({
                            chainId: config.chainId,
                            deployment: yieldDeployment,
                            deposit: new EvmPoolSessionYieldDeposit(
                                {
                                    deployment: yieldDeployment,
                                    deposit,
                                    router,
                                    yieldToken: token,
                                    allowanceOf: async (spender): Promise<bigint> =>
                                        BigInt(
                                            await config.entrypointInteractor.getAllowance(
                                                yieldDeployment.underlying,
                                                config.ownerAddress,
                                                spender,
                                            ),
                                        ),
                                },
                                { logger },
                            ),
                            withdraw: new EvmPoolSessionYieldWithdraw(
                                { deployment: yieldDeployment, orchestrator: transactCore, router },
                                { logger },
                            ),
                            earned: new EvmPoolSessionYieldEarned(
                                {
                                    deployment: yieldDeployment,
                                    noteManager: config.noteManager,
                                    keystoreManager: config.keystoreManager,
                                    noteComputationService: config.noteComputationService,
                                    yieldToken: token,
                                },
                                { logger },
                            ),
                            token,
                            router,
                        });
                    }
                    extensions.chainExtensions = {
                        yield: yields[0],
                        yields,
                    } satisfies EvmChainExtensions;
                }

                if (ctx.transactCore) {
                    const adaptedYieldDepositTargets = yields.map(toYieldSwapDepositTarget);
                    const evmAddressEqualityComparator =
                        config.addressEqualityComparator ?? new EvmAddressEqualityComparator();
                    extensions.reshield = new PoolSessionReshield(
                        {
                            chainId: config.chainId,
                            core: ctx.transactCore,
                            relayerInteractor: config.relayerInteractor,
                            rpcInteractor: config.rpcInteractor,
                            entrypointInteractor: config.entrypointInteractor,
                            addressEqualityComparator: evmAddressEqualityComparator,
                            emptyAddress: config.emptyAddress ?? EMPTY_ADDRESS,
                            swapQuoteProvider: config.swapQuoteProvider,
                            swapAndDepositQuoteProvider: config.swapAndDepositQuoteProvider,
                            swapChainAdapter,
                            yieldWrappers,
                            yieldDepositTargets: adaptedYieldDepositTargets,
                            relaySwapsAddress: config.relaySwapsAddress,
                            swapExecutor: config.swapExecutor ?? LIFI_SWAP_EXECUTORS[config.chainId],
                            nativeAssetAddress: config.nativeAssetAddress ?? NATIVE_ASSET_ADDRESS,
                        },
                        { logger },
                    );

                    // Reshield-and-transfer composes the same `reshield` delegate and adapted target
                    // list already built above (zero new EVM-concrete knowledge). A configured
                    // yield-share output is deposited as that share; any other pool asset is a plain
                    // deposit-for built with the session's own `deposit` delegate, so it exists
                    // whenever either is available.
                    if (adaptedYieldDepositTargets.length > 0 || ctx.deposit) {
                        extensions.reshieldTransfer = new PoolSessionReshieldTransfer(
                            {
                                reshieldDelegate: extensions.reshield,
                                yieldDepositTargets: adaptedYieldDepositTargets,
                                ...(ctx.deposit ? { depositDelegate: ctx.deposit } : {}),
                                addressEqualityComparator: evmAddressEqualityComparator,
                            },
                            { logger },
                        );
                    }

                    if (config.destinationChainId !== undefined && config.destinationEntrypointInteractor) {
                        const adaptedDestinationYieldDepositTargets = (
                            config.destinationYieldDepositTargets ?? []
                        ).map(toYieldSwapDepositTarget);
                        extensions.reshieldCrosschain = new PoolSessionReshieldCrosschain(
                            {
                                chainId: config.chainId,
                                destinationChainId: config.destinationChainId,
                                destinationChainType: config.destinationChainType ?? "evm",
                                core: ctx.transactCore,
                                relayerInteractor: config.relayerInteractor,
                                rpcInteractor: config.rpcInteractor,
                                entrypointInteractor: config.entrypointInteractor,
                                destinationEntrypointInteractor: config.destinationEntrypointInteractor,
                                addressEqualityComparator: evmAddressEqualityComparator,
                                emptyAddress: config.emptyAddress ?? EMPTY_ADDRESS,
                                nativeAssetAddress: config.nativeAssetAddress ?? NATIVE_ASSET_ADDRESS,
                                swapQuoteProvider: config.swapQuoteProvider,
                                swapAndDepositQuoteProvider: config.swapAndDepositQuoteProvider,
                                swapChainAdapter,
                                yieldWrappers,
                                destinationYieldDepositTargets: adaptedDestinationYieldDepositTargets,
                                relayerChainDetails: config.relayerChainDetails,
                            },
                            { logger },
                        );

                        // Cross-chain counterpart of reshieldTransfer above — same reasoning.
                        if (adaptedDestinationYieldDepositTargets.length > 0) {
                            extensions.reshieldTransferCrosschain = new PoolSessionReshieldTransferCrosschain(
                                {
                                    reshieldCrosschainDelegate: extensions.reshieldCrosschain,
                                    destinationYieldDepositTargets: adaptedDestinationYieldDepositTargets,
                                    addressEqualityComparator: evmAddressEqualityComparator,
                                },
                                { logger },
                            );
                        }
                    }

                    // Overrides PoolSessionFactory's default (yieldWrappers-less) withdrawAndSwap
                    // — same construction, plus the wrappers — only when there's something to
                    // add; otherwise the generic default (built without this chain's knowledge of
                    // yield at all) stands.
                    if (yieldWrappers.length > 0) {
                        extensions.withdrawAndSwap = new PoolSessionWithdrawAndSwap(
                            {
                                chainId: config.chainId,
                                core: ctx.transactCore,
                                relayerInteractor: config.relayerInteractor,
                                rpcInteractor: config.rpcInteractor,
                                entrypointInteractor: config.entrypointInteractor,
                                addressEqualityComparator:
                                    config.addressEqualityComparator ?? new EvmAddressEqualityComparator(),
                                emptyAddress: config.emptyAddress ?? EMPTY_ADDRESS,
                                swapQuoteProvider: config.swapQuoteProvider,
                                swapChainAdapter,
                                yieldWrappers,
                                relaySwapsAddress: config.relaySwapsAddress,
                            },
                            { logger },
                        );
                    }
                }

                if (
                    ctx.deposit &&
                    config.swapAndDepositQuoteProvider &&
                    config.poolVaultInteractor &&
                    config.relaySwapsAddress
                ) {
                    extensions.swapDeposit = new PoolSessionSwapDeposit(
                        {
                            ownerAddress: config.ownerAddress,
                            chainId: config.chainId,
                            depositDelegate: ctx.deposit,
                            swapAndDepositQuoteProvider: config.swapAndDepositQuoteProvider,
                            swapQuoteProvider: config.swapQuoteProvider,
                            swapExecutor: config.swapExecutor ?? LIFI_SWAP_EXECUTORS[config.chainId],
                            entrypointInteractor: config.entrypointInteractor,
                            rpcInteractor: config.rpcInteractor,
                            noteManager: config.noteManager,
                            poolVaultInteractor: config.poolVaultInteractor,
                            relaySwapsAddress: config.relaySwapsAddress,
                            nativeAssetAddress: config.nativeAssetAddress ?? NATIVE_ASSET_ADDRESS,
                            emptyAddress: config.emptyAddress ?? EMPTY_ADDRESS,
                            addressEqualityComparator:
                                config.addressEqualityComparator ?? new EvmAddressEqualityComparator(),
                            addressSchema: config.addressSchema ?? AddressSchema,
                            swapChainAdapter,
                            yieldDepositTargets: yields.map(toYieldSwapDepositTarget),
                            sourceChain: config.swapDepositSourceChain,
                        },
                        { logger },
                    );
                }

                return extensions;
            },
        },
        deps,
        EvmPoolSession,
    );
}
