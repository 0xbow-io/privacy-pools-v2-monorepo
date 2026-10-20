import type { ZodType } from "zod";

import type {
    Address,
    DeriveFromSignatureConfig,
    EVMProof,
    Hex,
    IAddressEqualityComparator,
    IAddressFieldConverter,
    IASPClient,
    IASPDataProvider,
    IContextHashService,
    ICryptoService,
    IEntrypointInteractor,
    IHashService,
    IKeystoreInteractor,
    IKeystoreManager,
    ILogger,
    IMerkleService,
    INoteComputationService,
    INoteDiscoveryService,
    INoteManager,
    IPaymentRequestService,
    IPayoutRoutingCodec,
    IPoolSessionDeposit,
    IPoolSessionReshield,
    IPoolSessionReshieldCrosschain,
    IPoolSessionReshieldTransfer,
    IPoolSessionReshieldTransferCrosschain,
    IPoolSessionSwapDeposit,
    IPoolSessionWithdrawAndSwap,
    IPoolVaultInteractor,
    IPreparedTxVerifier,
    IProofService,
    IRelayBatchCodec,
    IRelayerInteractor,
    ISwapAndDepositQuoteProvider,
    ISwapChainAdapter,
    ISwapQuoteProvider,
    ITransactOrchestrator,
    ITxReceiptWaiter,
    IWitnessPreparationService,
    PreparedTransaction,
    SwapDepositSourceChainConfig,
    SwapExecutorAddresses,
    TxLog,
} from "../internal.js";

// NOTE (core-sdk split): the original packages/sdk/src/types/PoolSession.ts's PoolSessionConfig
// also carried `yieldDeployment`/`yieldDeployments` (Aave-yield, a specific EVM smart-contract
// product feature — see PoolSessionFactory.ts's own migration notes) — dropped here; yield stays
// an evm-sdk-only extension wired through `buildChainExtensions` below, not a core-sdk config
// field. Everything else (including swap/reshield/swap-deposit, now genericized) is restored.

/**
 * Configuration for constructing a unified {@link PoolSession}, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, raw
 * receipt-log type `TLog`, and signature-derivation config type `TDeriveConfig` (all default to
 * their EVM shapes, so existing EVM callers are unaffected).
 *
 * The five injectable codecs below (`contextHashService`, `payoutRoutingCodec`,
 * `addressFieldConverter`, `relayBatchCodec`, `preparedTxVerifier`) plus
 * `addressEqualityComparator`, `addressSchema`, and `paymentRequestService` are optional here
 * only in the sense that this type is shared with `createEvmPoolSession`, which defaults
 * each to its EVM implementation when omitted. {@link PoolSessionFactory.create} itself — the
 * pure, chain-agnostic core — requires every one of them explicitly; a non-EVM caller (e.g.
 * Stellar) supplies its own chain's implementations and calls that directly, the same way
 * `createEvmPoolSession` does for EVM.
 */
export interface PoolSessionConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
    TDeriveConfig = DeriveFromSignatureConfig,
> {
    /** The account owner's address. */
    ownerAddress: TAddress;
    /**
     * The chain ID this session is operating on. Stays a numeric EIP-155 chain ID for now —
     * Stellar has no such identifier (a network passphrase + contract IDs instead), and
     * widening this cascades into every EVM-only subsystem that also takes a numeric
     * `chainId` (`IKeystoreManager`, storage adapters). That widening belongs with the Stellar
     * deployment registry (a `StellarChainId` type + `STELLAR_DEPLOYMENTS` map), not this
     * phase's TTx/TAddress/TProof/TLog seam.
     */
    chainId: number;
    /** Crypto service for secret generation. */
    cryptoService: ICryptoService<TDeriveConfig>;
    /** Witness builder for circuit inputs. */
    witnessPreparationService: IWitnessPreparationService;
    /** ZK proof generator. */
    proofService: IProofService<TProof>;
    /** Entrypoint interactor for reading asset configuration. */
    entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    /** Note state manager. */
    noteManager: INoteManager<TAddress>;
    /** Key material provider. */
    keystoreManager: IKeystoreManager;
    /** Keystore interactor for on-chain queries. */
    keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    /** Hash service for Poseidon hashes. */
    hashService: IHashService;
    /** Merkle service for keystore inclusion proofs (used by rotation). */
    merkleService: IMerkleService;
    /** PoolVault interactor for state tree queries. Required for transfer. */
    poolVaultInteractor?: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    /** ASP client for association set data. Required for deposit and transfer. */
    aspClient: IASPClient;
    /** Relayer interactor for submitting transactions via relayers. */
    relayerInteractor: IRelayerInteractor<TAddress>;
    /** HTTP data provider for the ASP. Required for note discovery. */
    aspDataProvider: IASPDataProvider;
    /**
     * Waits for a submitted transaction's receipt — the only RPC capability the generic core
     * sub-sessions actually call (see `ITxReceiptWaiter`'s own doc comment). Narrower than
     * `IRPCInteractor<TLog>` on purpose, matching every core sub-session's own already-narrowed
     * `rpcInteractor` field, including `PoolSessionNoteDiscovery` — it reads the current cursor
     * from `poolVaultInteractor.getCurrentCursor()` instead of `rpcInteractor.getBlockNumber()`,
     * so a future Stellar RPC interactor satisfies this without needing EVM-shaped methods
     * (`readContract`/`getLogsPaginated`/`getBlockNumber`) it has no use for.
     */
    rpcInteractor: ITxReceiptWaiter<TLog>;
    /** NoteComputationService shared across every sub-session. */
    noteComputationService: INoteComputationService;
    /**
     * Computes the proof-context hash bound into the deposit/transact circuits. Defaults to
     * `EvmContextHashService` when omitted.
     */
    contextHashService?: IContextHashService<TAddress>;
    /**
     * Encodes/decodes the `PayoutRouting` tuple carried in relay calldata. Defaults to
     * `EvmPayoutRoutingCodec` when omitted.
     */
    payoutRoutingCodec?: IPayoutRoutingCodec<TAddress>;
    /**
     * Converts `TAddress` values into the field-sized `Hex` the Poseidon-hash layer expects.
     * Defaults to `EvmAddressFieldConverter` when omitted.
     */
    addressFieldConverter?: IAddressFieldConverter<TAddress>;
    /**
     * Encodes a batch of already-proven transact items into one relay-batch transaction.
     * Defaults to `EvmRelayBatchCodec` when omitted.
     */
    relayBatchCodec?: IRelayBatchCodec<TTx, TAddress, TProof>;
    /**
     * Verifies prepared transactions target the expected contract/operation before signing.
     * Defaults to `EvmPreparedTxVerifier` when omitted.
     */
    preparedTxVerifier?: IPreparedTxVerifier<TTx, TAddress>;
    /**
     * Compares two `TAddress` values for equality (chain-specific canonicalization rules).
     * Defaults to `EvmAddressEqualityComparator` when omitted.
     */
    addressEqualityComparator?: IAddressEqualityComparator<TAddress>;
    /**
     * Validates the `TAddress`-typed fields carried by every sub-session's config and params.
     * Defaults to `AddressSchema` when omitted.
     */
    addressSchema?: ZodType<TAddress>;
    /**
     * The chain's "no address" sentinel — see `PoolSessionWithdrawConfig.emptyAddress`'s doc
     * comment. Defaults to `EMPTY_ADDRESS` when omitted.
     */
    emptyAddress?: TAddress;
    /** The chain's native-asset sentinel address. Defaults to `NATIVE_ASSET_ADDRESS` when omitted. */
    nativeAssetAddress?: TAddress;
    /**
     * Optional pre-constructed NoteDiscoveryService. When provided the factory uses it
     * directly; otherwise it instantiates a default from cryptoService/hashService/noteComputationService.
     */
    noteDiscoveryService?: INoteDiscoveryService<TAddress>;
    /**
     * Optional pre-constructed PaymentRequestService. The factory is synchronous and
     * cannot hydrate from storage, so it only ever builds an in-memory (ephemeral)
     * default. To get a persistent service, construct it, call `loadFromStorage`, and
     * pass it here — or use a chain-specific builder, which does both.
     */
    paymentRequestService?: IPaymentRequestService;
    /**
     * Optional swap-and-deposit quote provider. When provided, enables the
     * `swapAndDeposit` / `prepareSwapAndDeposit` / `executeSwapAndDeposit`
     * methods on PoolSession and reshield quote preparation.
     */
    swapAndDepositQuoteProvider?: ISwapAndDepositQuoteProvider<TAddress>;
    /**
     * Optional swap quote provider. When provided, enables `prepareSwapQuote()`
     * on withdraw-and-swap and `estimateReshieldAmount()` on reshield sessions.
     */
    swapQuoteProvider?: ISwapQuoteProvider<TAddress>;
    /**
     * Swap executor (and its ERC20 proxy) the same-chain swap-and-deposit and reshield sessions compose
     * their executor transactions through. Overrides the chain SDK's built-in table (EVM: `LIFI_SWAP_EXECUTORS`), for chains it
     * does not list. Must answer `erc20Proxy()` like LiFi's Executor, and both addresses must be on
     * the RelaySwaps router allowlist.
     */
    swapExecutor?: SwapExecutorAddresses<TAddress>;
    /**
     * Chain-specific routing-decode/router-allowlist/recipient-embedding/approval-building
     * capability the swap/reshield/swap-deposit sessions need. See {@link ISwapChainAdapter}.
     */
    swapChainAdapter?: ISwapChainAdapter<TTx, TAddress>;
    /**
     * RelaySwaps contract address for the session chain. When provided, swap/reshield/
     * swap-deposit sessions validate aggregator quote addresses against RelaySwaps.approvedRouters
     * before use.
     */
    relaySwapsAddress?: TAddress;
    /**
     * Optional source-chain attachment for cross-chain swap-and-deposit (input
     * token and wallet on another chain, deposit landing in this session's pool).
     * Without it, `swapAndDeposit` is same-chain only.
     */
    swapDepositSourceChain?: SwapDepositSourceChainConfig<TTx, TAddress>;
    /**
     * Optional destination chain ID for cross-chain reshield. When
     * provided together with `destinationEntrypointInteractor`, the factory
     * builds the cross-chain reshield session. Both must be present for
     * `reshieldCrosschain` to be available — either alone is not enough, since
     * the session needs both the target chain ID and a way to read its state.
     */
    destinationChainId?: number;
    /**
     * Chain type `destinationChainId` is scoped to (e.g. "evm", "stellar") — a bare numeric
     * chain ID is ambiguous once more than one chain type exists. Defaults to `"evm"` when
     * `destinationChainId` is supplied without it (every current caller's destination is EVM).
     */
    destinationChainType?: string;
    /**
     * Entrypoint interactor for `destinationChainId`, with its own RPC
     * connection to that chain. Required (with `destinationChainId`) for cross-chain reshield.
     */
    destinationEntrypointInteractor?: IEntrypointInteractor<TTx, TAddress, TProof>;
    /**
     * Builds chain-specific session extensions that the generic factory cannot construct
     * itself — either because the concrete class needs a `TTx` shape narrower than this
     * generic config's opaque `TTx` (reshield/reshieldCrosschain/swap-deposit all read
     * `depositTx.to`/`.data`, which a chain whose `TTx` isn't `{to, data}`-shaped — e.g.
     * Stellar's XDR-envelope string — cannot satisfy), or because the feature itself is a
     * specific product built on one chain's contracts (Aave-yield). Called once, after the
     * generic sessions are built, with the pieces those extensions typically need; its result is
     * merged into the constructed {@link PoolSession}. Chains that don't supply a hook simply
     * get `undefined` for every extension field — no cast, no runtime throw.
     */
    buildChainExtensions?: (
        ctx: ChainSessionBuildContext<TTx, TAddress, TProof, TLog>,
    ) => ChainSessionExtensions<TTx, TAddress, TProof, TLog>;
}

/**
 * The generic pieces {@link PoolSessionConfig.buildChainExtensions} receives — everything the
 * factory has already built by the time chain-specific extensions are assembled, plus the full
 * config for reading whatever chain-specific fields (e.g. `destinationChainId`, a yield
 * deployment) the hook's own implementation needs.
 *
 * `deposit`/`transactCore` are passed through as already-built instances (not rebuilt from
 * `config`) since yield and the reshield/swap-deposit family compose them directly (e.g. a yield
 * deposit delegates its base deposit proof to the same `deposit` instance the generic factory
 * already built) — reconstructing them in the hook would both duplicate work and risk a second,
 * inconsistent instance.
 */
export interface ChainSessionBuildContext<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    config: PoolSessionConfig<TTx, TAddress, TProof, TLog>;
    /** Present whenever `config.poolVaultInteractor` was supplied. */
    deposit?: IPoolSessionDeposit<TTx, TAddress, TProof, TLog>;
    /**
     * Builds another deposit session identical to `deposit` except for its entrypoint — for an
     * extension whose deposit must be encoded differently (e.g. Stellar yield, whose share-token
     * deposit cannot be simulated before the router mints the shares). Present whenever `deposit` is.
     */
    buildDeposit?: (overrides: {
        entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    }) => IPoolSessionDeposit<TTx, TAddress, TProof, TLog>;
    /** Present whenever `config.poolVaultInteractor` and `config.aspClient` were both supplied. */
    transactCore?: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    logger?: ILogger;
}

/**
 * Chain-specific session extensions merged into the constructed {@link PoolSession}. `reshield`/
 * `reshieldCrosschain`/`swapDeposit` are fully generic types (see {@link IPoolSessionReshield} et
 * al.) — they're built via this hook only because of the `TTx` constraint their concrete classes
 * need (see {@link PoolSessionConfig.buildChainExtensions}), not because they're chain-specific in
 * shape. `chainExtensions` is the true chain-specific escape hatch (e.g. evm-sdk's Aave-yield
 * `EvmChainExtensions`, holding `yield`/`yields`) — core-sdk's `PoolSession` never looks inside it.
 */
export interface ChainSessionExtensions<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    withdrawAndSwap?: IPoolSessionWithdrawAndSwap<TAddress, TLog>;
    reshield?: IPoolSessionReshield<TTx, TAddress, TLog>;
    reshieldCrosschain?: IPoolSessionReshieldCrosschain<TTx, TAddress, TLog>;
    swapDeposit?: IPoolSessionSwapDeposit<TTx, TAddress>;
    /**
     * Reshield-and-transfer (withdraw + swap + deposit on behalf of a recipient, always landing
     * as a configured yield share). Built via this hook alongside `reshield`, for the same
     * reason — its delegate (`reshield`) and the EVM `YieldDeployment`-derived deposit targets it
     * composes are only available where `reshield`/yield are themselves built.
     */
    reshieldTransfer?: IPoolSessionReshieldTransfer<TTx, TAddress, TLog>;
    /** Cross-chain counterpart of {@link ChainSessionExtensions.reshieldTransfer} — same reasoning. */
    reshieldTransferCrosschain?: IPoolSessionReshieldTransferCrosschain<TTx, TAddress, TLog>;
    /** Opaque chain-specific bag (e.g. evm-sdk's Aave-yield sessions). Unused by core-sdk itself. */
    chainExtensions?: unknown;
}

/** Optional dependencies for {@link PoolSession}. */
export interface PoolSessionDependencies {
    /** Optional logger shared across all internal sessions. */
    logger?: ILogger;
}

/**
 * Parameters encoding the processor routing for a transact call, generic over the chain's
 * address type `TAddress` (defaults to EVM's {@link Address}).
 */
export interface TransactParams<TAddress = Address> {
    /** Address of the processor contract that handles post-proof execution logic. */
    processor: TAddress;
    /** ABI-encoded data passed to the processor (e.g., payout routing). */
    data: Hex;
}
