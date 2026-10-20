import type {
    Address,
    ChainSessionExtensions,
    DeriveFromSignatureConfig,
    EVMProof,
    ICryptoService,
    IEntrypointInteractor,
    IPoolSessionKeystore,
    PoolSessionConfig,
    PoolSessionDelegates,
    PoolSessionDependencies,
    PreparedTransaction,
    TxLog,
    IRPCInteractor,
} from "../../internal.js";
import {
    BatchWithdrawOrchestrator,
    NoteDiscoveryService,
    PoolSession,
    PoolSessionBatchWithdraw,
    PoolSessionDeposit,
    PoolSessionExport,
    PoolSessionKeystore,
    PoolSessionNoteDiscovery,
    PoolSessionNoteManager,
    PoolSessionRagequit,
    PoolSessionTransfer,
    PoolSessionWithdraw,
    PoolSessionWithdrawAndSwap,
    TransactOrchestrator,
} from "../../internal.js";

/**
 * Factory for creating a fully-wired {@link PoolSession} from a chain-agnostic config — the
 * pure, generic core. Every chain-specific codec/comparator/schema
 * (`contextHashService`, `payoutRoutingCodec`, `addressFieldConverter`, `relayBatchCodec`,
 * `preparedTxVerifier`, `addressEqualityComparator`, `addressSchema`, `paymentRequestService`)
 * must be supplied explicitly — this class has zero knowledge of any concrete chain, so it never
 * imports an `Evm*`/`Stellar*` implementation and never pulls one into a bundle that doesn't
 * already need it.
 *
 * Builds every session whose concrete class can be constructed generically — including, now,
 * `withdrawAndSwap` (its class has no `TTx` shape requirement) — directly. `reshield`/
 * `reshieldCrosschain`/`swapDeposit` (whose concrete classes need `TTx` to carry `{to, data}` —
 * a shape a chain whose `TTx` isn't a contract-call tuple, e.g. Stellar's XDR-envelope string,
 * cannot satisfy) and any genuinely chain-specific product feature (e.g. Aave-yield) are instead
 * built by the caller-supplied `config.buildChainExtensions` hook and merged in at the end — see
 * {@link ChainSessionExtensions}'s own doc for why that split is necessary, not just historical.
 *
 * For EVM, use `createEvmPoolSession` (evm-sdk's `EvmPoolSessionFactory.ts`), which supplies EVM
 * defaults for all of the above (including `buildChainExtensions`) and delegates here — the same
 * "generic core + one factory function per chain" split already used for
 * `PoolVaultInteractor`/`EntrypointInteractor`/`KeystoreInteractor`. `createStellarPoolSession`
 * follows the identical shape for Stellar (simply omitting `buildChainExtensions`, since none of
 * its extensions exist for Stellar yet).
 *
 * `create` is synchronous, so it cannot `await` any service's `loadFromStorage` — a caller
 * needing a hydrated `paymentRequestService`/`noteManager` must construct and load it before
 * calling in (which is what each chain's builder does via its `create*PoolSession`).
 *
 * Deliberately a static-factory class, not a plain exported function (this package's own
 * CLAUDE.md §2 lists "static factory methods" as an allowed class shape) — keeps the established
 * `PoolSessionFactory.create(...)` call-site convention used throughout this migration.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- see class doc comment above.
export class PoolSessionFactory {
    /**
     * Creates a new {@link PoolSession} from a unified configuration.
     *
     * Each internal session receives only the dependencies it needs,
     * extracted from the shared config.
     *
     * @param config - Unified configuration with every dependency supplied explicitly, including
     *   every chain-specific codec (`contextHashService`, `payoutRoutingCodec`,
     *   `addressFieldConverter`, `relayBatchCodec`, `preparedTxVerifier`,
     *   `addressEqualityComparator`, `addressSchema`, `paymentRequestService`) — there is no
     *   chain-agnostic fallback for any of them, so this class never defaults them itself.
     * @param deps - Optional shared dependencies (e.g. logger).
     * @param SessionClass - Optional session subclass to construct instead of the base
     *   `PoolSession` — used by `createEvmPoolSession` to return an `EvmPoolSession` (which adds
     *   `yield`/`yields`/`yieldFor`, reading `chainExtensions`) without this class needing to know
     *   `EvmPoolSession` exists. Defaults to `PoolSession` itself.
     * @returns A fully initialized session of type `TSession` (`PoolSession` unless overridden).
     */
    static create<
        TTx = PreparedTransaction,
        TAddress = Address,
        TProof = EVMProof,
        TLog = TxLog,
        TExtensions = unknown,
        TDeriveConfig = DeriveFromSignatureConfig,
        TSession extends PoolSession<
            TTx,
            TAddress,
            TProof,
            TLog,
            TExtensions,
            TDeriveConfig
        > = PoolSession<TTx, TAddress, TProof, TLog, TExtensions, TDeriveConfig>,
    >(
        config: PoolSessionConfig<TTx, TAddress, TProof, TLog, TDeriveConfig> &
            Required<
                Pick<
                    PoolSessionConfig<TTx, TAddress, TProof, TLog, TDeriveConfig>,
                    | "contextHashService"
                    | "payoutRoutingCodec"
                    | "addressFieldConverter"
                    | "relayBatchCodec"
                    | "preparedTxVerifier"
                    | "addressEqualityComparator"
                    | "addressSchema"
                    | "emptyAddress"
                    | "paymentRequestService"
                >
            >,
        deps?: PoolSessionDependencies,
        SessionClass?: new (
            delegates: PoolSessionDelegates<TTx, TAddress, TProof, TLog, TExtensions, TDeriveConfig>,
        ) => TSession,
    ): TSession {
        const logger = deps?.logger;
        const {
            preparedTxVerifier,
            payoutRoutingCodec,
            addressFieldConverter,
            addressEqualityComparator,
            contextHashService,
            relayBatchCodec,
            addressSchema,
            emptyAddress,
            paymentRequestService,
        } = config;
        // Every sub-session but PoolSessionKeystore only uses ICryptoService's chain-agnostic
        // members (ecdh/encrypt/generateSecret/...), never `deriveKeysFromSignature` — so they
        // stay typed against the plain default (`ICryptoService<DeriveFromSignatureConfig>`)
        // rather than threading `TDeriveConfig` everywhere. The real object always satisfies
        // both; only PoolSessionKeystore gets `config.cryptoService` untouched, still fully
        // `ICryptoService<TDeriveConfig>`-typed.
        const genericCryptoService = config.cryptoService as ICryptoService;

        // One deposit session per entrypoint: the generic one below, plus any a chain extension
        // needs over a different entrypoint (Stellar's yield deposit encodes the share-token
        // deposit without simulating it — see stellar-sdk's StellarYieldRouterCodec).
        const poolVaultInteractor = config.poolVaultInteractor;
        const buildDeposit = poolVaultInteractor
            ? (
                  entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>,
              ): PoolSessionDeposit<TTx, TAddress, TProof, TLog> =>
                  new PoolSessionDeposit<TTx, TAddress, TProof, TLog>(
                      {
                          ownerAddress: config.ownerAddress,
                          cryptoService: genericCryptoService,
                          witnessPreparationService: config.witnessPreparationService,
                          proofService: config.proofService,
                          entrypointInteractor,
                          noteManager: config.noteManager,
                          aspClient: config.aspClient,
                          keystoreManager: config.keystoreManager,
                          keystoreInteractor: config.keystoreInteractor,
                          noteComputationService: config.noteComputationService,
                          poolVaultInteractor,
                          rpcInteractor: config.rpcInteractor,
                          contextHashService,
                          preparedTxVerifier,
                          addressFieldConverter,
                          addressEqualityComparator,
                          addressSchema,
                      },
                      { logger },
                  )
            : undefined;
        const deposit = buildDeposit?.(config.entrypointInteractor);

        const keystore = new PoolSessionKeystore<TTx, TAddress, TLog, TDeriveConfig>(
            {
                ownerAddress: config.ownerAddress,
                chainId: config.chainId,
                keystoreManager: config.keystoreManager,
                keystoreInteractor: config.keystoreInteractor,
                noteComputationService: config.noteComputationService,
                hashService: config.hashService,
                merkleService: config.merkleService,
                cryptoService: config.cryptoService,
                rpcInteractor: config.rpcInteractor,
                preparedTxVerifier,
                addressFieldConverter,
                addressSchema,
            },
            { logger },
        );

        const ragequit = config.poolVaultInteractor
            ? new PoolSessionRagequit<TTx, TAddress, TProof, TLog>(
                  {
                      ownerAddress: config.ownerAddress,
                      poolVaultInteractor: config.poolVaultInteractor,
                      noteManager: config.noteManager,
                      keystoreManager: config.keystoreManager,
                      witnessPreparationService: config.witnessPreparationService,
                      proofService: config.proofService,
                      keystoreInteractor: config.keystoreInteractor,
                      rpcInteractor: config.rpcInteractor,
                      preparedTxVerifier,
                      addressFieldConverter,
                      addressSchema,
                  },
                  { logger },
              )
            : undefined;

        const transactCore =
            config.poolVaultInteractor && config.aspClient
                ? new TransactOrchestrator<TTx, TAddress, TProof, TLog>(
                      {
                          ownerAddress: config.ownerAddress,
                          noteManager: config.noteManager,
                          keystoreManager: config.keystoreManager,
                          witnessPreparationService: config.witnessPreparationService,
                          proofService: config.proofService,
                          keystoreInteractor: config.keystoreInteractor,
                          poolVaultInteractor: config.poolVaultInteractor,
                          aspClient: config.aspClient,
                          cryptoService: genericCryptoService,
                          noteComputationService: config.noteComputationService,
                          rpcInteractor: config.rpcInteractor,
                          contextHashService,
                          payoutRoutingCodec,
                          relayBatchCodec,
                          addressFieldConverter,
                          addressEqualityComparator,
                          addressSchema,
                      },
                      { logger },
                  )
                : undefined;

        const transfer = transactCore
            ? new PoolSessionTransfer<TTx, TAddress, TProof, TLog>(
                  {
                      ownerAddress: config.ownerAddress,
                      core: transactCore,
                      relayerInteractor: config.relayerInteractor,
                      rpcInteractor: config.rpcInteractor,
                      cryptoService: genericCryptoService,
                      noteComputationService: config.noteComputationService,
                      keystoreInteractor: config.keystoreInteractor,
                      paymentRequestService,
                      preparedTxVerifier,
                      addressFieldConverter,
                      addressSchema,
                  },
                  { logger },
              )
            : undefined;

        const withdraw = transactCore
            ? new PoolSessionWithdraw<TTx, TAddress, TProof, TLog>(
                  {
                      core: transactCore,
                      relayerInteractor: config.relayerInteractor,
                      rpcInteractor: config.rpcInteractor,
                      // PoolSessionWithdrawConfig.keystore is concretely EVM-typed by design (its
                      // relayed-registration flow signs EIP-712 typed data — see this class's own
                      // doc comment); a Stellar keystore has no equivalent yet, so this cast is a
                      // documented EVM-only boundary, not a real widening.
                      keystore: keystore as IPoolSessionKeystore,
                      preparedTxVerifier,
                      payoutRoutingCodec,
                      addressSchema,
                      emptyAddress,
                  },
                  { logger },
              )
            : undefined;

        const batchWithdraw = transactCore
            ? new PoolSessionBatchWithdraw<TTx, TAddress, TLog>(
                  {
                      orchestrator: new BatchWithdrawOrchestrator<TTx, TAddress, TProof, TLog>(
                          {
                              core: transactCore,
                              noteManager: config.noteManager,
                              payoutRoutingCodec,
                              addressEqualityComparator,
                              preparedTxVerifier,
                              emptyAddress,
                          },
                          { logger },
                      ),
                      noteManager: config.noteManager,
                      relayerInteractor: config.relayerInteractor,
                      rpcInteractor: config.rpcInteractor,
                  },
                  { logger },
              )
            : undefined;

        // withdrawAndSwap's concrete class has no `TTx` shape requirement (unlike reshield/
        // reshieldCrosschain/swapDeposit, which read `depositTx.to`/`.data` — see this file's own
        // class doc), so — unlike those three — it can be built directly here, generically, for
        // any chain. Gated on transactCore (same prerequisite as transfer/withdraw) and on the
        // caller having supplied a swapChainAdapter (Stellar doesn't yet, so this stays
        // `undefined` for it, exactly like every other optional session above).
        const withdrawAndSwap =
            transactCore && config.swapChainAdapter
                ? new PoolSessionWithdrawAndSwap<TTx, TAddress, TProof, TLog>(
                      {
                          chainId: config.chainId,
                          core: transactCore,
                          relayerInteractor: config.relayerInteractor,
                          rpcInteractor: config.rpcInteractor,
                          entrypointInteractor: config.entrypointInteractor,
                          addressEqualityComparator,
                          emptyAddress,
                          swapQuoteProvider: config.swapQuoteProvider,
                          swapChainAdapter: config.swapChainAdapter,
                          relaySwapsAddress: config.relaySwapsAddress,
                      },
                      { logger },
                  )
                : undefined;

        const noteDiscoveryService =
            config.noteDiscoveryService ??
            new NoteDiscoveryService<TAddress>(
                {
                    cryptoService: genericCryptoService,
                    hashService: config.hashService,
                    noteComputationService: config.noteComputationService,
                    addressFieldConverter,
                },
                { logger },
            );

        const noteDiscovery = config.poolVaultInteractor
            ? new PoolSessionNoteDiscovery<TTx, TAddress, TProof, TLog>(
                  {
                      ownerAddress: config.ownerAddress,
                      noteDiscoveryService,
                      noteManager: config.noteManager,
                      keystoreManager: config.keystoreManager,
                      poolVaultInteractor: config.poolVaultInteractor,
                      aspDataProvider: config.aspDataProvider,
                      aspClient: config.aspClient,
                      noteComputationService: config.noteComputationService,
                      addressFieldConverter,
                      paymentRequestService,
                      // Only an interactor that can actually report finality (EVM's) is passed
                      // on; the narrowed `ITxReceiptWaiter` other chains supply has no such
                      // method and gets the `unsupported` rule.
                      rpcInteractor:
                          typeof (config.rpcInteractor as Partial<IRPCInteractor>)
                              .getFinalizedBlockNumber === "function"
                              ? (config.rpcInteractor as unknown as IRPCInteractor)
                              : undefined,
                  },
                  { logger },
              )
            : undefined;

        const exportSession = new PoolSessionExport<TAddress>(
            {
                noteManager: config.noteManager,
                noteComputationService: config.noteComputationService,
                addressFieldConverter,
                addressEqualityComparator,
                paymentRequestService,
                ownerAddress: config.ownerAddress,
                chainId: config.chainId,
                addressSchema,
            },
            { logger },
        );

        const noteManager = config.poolVaultInteractor
            ? new PoolSessionNoteManager<TTx, TAddress, TProof, TLog>(
                  {
                      noteManager: config.noteManager,
                      poolVaultInteractor: config.poolVaultInteractor,
                      addressSchema,
                  },
                  { logger },
              )
            : undefined;

        // Chain-specific extensions the generic core cannot build itself — reshield/
        // reshieldCrosschain/swapDeposit (TTx-shape constraint) and any genuinely chain-specific
        // product feature (Aave-yield). Absent for a chain that supplies no hook (e.g. Stellar
        // today) — every extension field then stays `undefined`, a compile-time-visible "not
        // supported" rather than a runtime cast/throw.
        const extensions: ChainSessionExtensions<TTx, TAddress, TProof, TLog> =
            config.buildChainExtensions?.({
                // Same documented EVM-only boundary as `genericCryptoService` above —
                // `buildChainExtensions` is only ever supplied by EVM's own factory, whose
                // config is always the default-shaped `ICryptoService<DeriveFromSignatureConfig>`.
                config: config as PoolSessionConfig<TTx, TAddress, TProof, TLog>,
                deposit,
                buildDeposit: buildDeposit
                    ? (overrides) => buildDeposit(overrides.entrypointInteractor)
                    : undefined,
                transactCore,
                logger,
            }) ?? {};

        const Session = (SessionClass ?? PoolSession) as new (
            delegates: PoolSessionDelegates<TTx, TAddress, TProof, TLog, TExtensions, TDeriveConfig>,
        ) => TSession;

        return new Session({
            chainId: config.chainId,
            keystoreInteractor: config.keystoreInteractor,
            poolVaultInteractor: config.poolVaultInteractor,
            deposit,
            transfer,
            withdraw,
            batchWithdraw,
            withdrawAndSwap: extensions.withdrawAndSwap ?? withdrawAndSwap,
            swapDeposit: extensions.swapDeposit,
            reshield: extensions.reshield,
            reshieldCrosschain: extensions.reshieldCrosschain,
            reshieldTransfer: extensions.reshieldTransfer,
            reshieldTransferCrosschain: extensions.reshieldTransferCrosschain,
            swapProvider: config.swapAndDepositQuoteProvider ?? config.swapQuoteProvider,
            keystore,
            ragequit,
            noteDiscovery,
            noteManager,
            export: exportSession,
            // `ChainSessionExtensions.chainExtensions` stays `unknown` at the config-type level
            // (PoolSessionConfig isn't itself parameterized by TExtensions — see its own doc); the
            // caller passing a `SessionClass` is the one asserting what TExtensions actually is.
            chainExtensions: extensions.chainExtensions as TExtensions,
        });
    }
}
