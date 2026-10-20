import type {
    Address,
    RelayerChainDetails,
    EVMProof,
    Hash,
    Hex,
    IAddressEqualityComparator,
    IEntrypointInteractor,
    ILogger,
    IRelayerInteractor,
    ISwapAndDepositQuoteProvider,
    ISwapChainAdapter,
    ISwapQuoteProvider,
    ITransactOrchestrator,
    ITxReceiptWaiter,
    PendingNote,
    PreparedTransaction,
    PrepareDepositResult,
    PrepareSwapRelayerQuotes,
    RelayerInfo,
    StealthRecipientIdentifier,
    TxLog,
    YieldSwapDepositTarget,
    YieldSwapWrapper,
} from "../internal.js";

/**
 * Opt-in dust-rescue instruction for a cross-chain reshield. The amount is
 * deliberately absent: the client cannot know the destination-chain leftover
 * in advance (if it could, it would simply size the withdrawal to avoid
 * leaving any) — see `docs/tech-design/sdk/withdraw-and-swap.md` §Cross-Chain
 * Reshield for the accepted trust extension this implies. The relayer alone
 * observes the actual swept amount, decides whether it clears its own
 * worth-it threshold, and — if so — generates and submits the rescue deposit
 * itself.
 */
export interface DustRescueOptIn {
    /** Recipient identifier the relayer derives the rescue note's owner from — chain-specific, opaque here. */
    recipientIdentifier: StealthRecipientIdentifier;
}

/**
 * Configuration for PoolSessionReshieldCrosschain construction, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and raw
 * receipt-log type `TLog`.
 *
 * A session is pinned to one (source chain, destination chain) pair at
 * construction time — mirrors how every other interactor in the SDK is bound
 * to a single chain's RPC connection; there is no existing mechanism for a
 * session to read state from a chain other than the one it was built for.
 * Integrators reshielding into multiple destination chains construct one
 * session per destination.
 */
export interface PoolSessionReshieldCrosschainConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** Chain ID this session withdraws from (source chain). */
    chainId: number;
    /** Yield-share deposit targets on the DESTINATION chain: an output token equal to a target's share is funded via the share's router there. */
    destinationYieldDepositTargets?: YieldSwapDepositTarget<TTx, TAddress>[];
    /**
     * `/v1/details` answers the caller already holds (e.g. from `PoolSessionBuilder.withRelayerDetails`).
     * Seeds the B2 `max_swap_value_wei` check so it does not re-fetch details for a relayer it
     * already knows; matched to a `RelayerInfo` by `chainId` + `relayerAddress`.
     */
    relayerChainDetails?: RelayerChainDetails<TAddress>[];
    /** Chain ID this session deposits into (destination chain). Must differ from `chainId`. */
    destinationChainId: number;
    /**
     * Chain type `destinationChainId` is scoped to (e.g. "evm", "stellar") — a bare numeric
     * chain ID is ambiguous once more than one chain type exists (an EVM chain and a chain of
     * another type can be assigned the same numeric ID). Every caller (`estimateReshieldCrosschainAmount`
     * / `prepareReshieldCrosschainQuote` / `relayReshieldCrosschain`) must echo this back via
     * their own `toChainType`, mirroring the existing `toChainId` check.
     */
    destinationChainType: string;
    /** Shared transact infrastructure (notes, keys, witness, proof, vault) — source chain. */
    core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    /** Relayer interactor for submitting to the relayer. */
    relayerInteractor: IRelayerInteractor<TAddress>;
    /** Waits for the relayer's submitted transaction receipt (source chain). */
    rpcInteractor: ITxReceiptWaiter<TLog>;
    /** Entrypoint interactor for pre-flight asset config validation (source chain). */
    entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    /**
     * Entrypoint interactor for the destination chain — used to validate the
     * deposit target and read asset config (`minAmount`, `vettingFeeBPS`,
     * `enabled`) on `destinationChainId`. Requires its own RPC connection to
     * that chain, wired by the caller (e.g. via a second `PoolSessionBuilder`
     * scoped to the destination chain).
     */
    destinationEntrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    /** Compares two `TAddress` values for equality (chain-specific canonicalization rules). */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    /** The chain's "no address" sentinel. */
    emptyAddress: TAddress;
    /** The chain's native-asset sentinel address. */
    nativeAssetAddress: TAddress;
    /** Optional swap quote provider for estimateReshieldCrosschainAmount(). */
    swapQuoteProvider?: ISwapQuoteProvider<TAddress>;
    /** Optional swap-and-deposit quote provider for prepareReshieldCrosschainQuote(). */
    swapAndDepositQuoteProvider?: ISwapAndDepositQuoteProvider<TAddress>;
    /**
     * Chain-specific routing-decode/router-allowlist/token-identity capability. Required at
     * construction — PoolSessionFactory only builds this session at all when one is supplied
     * (same gating as `core`/`relayerInteractor`).
     */
    swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
    /**
     * Yield wrappers whose share notes (`shareToken`) this session can reshield. When the
     * spent `tokenId` matches a wrapper's share, the DEX/swap legs are quoted on the
     * wrapper's `underlying` (sized via `previewRedeem`) because the processor redeems the
     * shares on-chain first; the relayer fee and the note stay share-denominated. The
     * wrapper's `previewRedeem` reads on the SOURCE chain (where the spent note lives).
     * Unset/empty: share notes have no swap route.
     */
    yieldWrappers?: YieldSwapWrapper<TAddress>[];
}

/** Optional dependencies for PoolSessionReshieldCrosschain. */
export interface PoolSessionReshieldCrosschainDependencies {
    logger?: ILogger;
}

/** Parameters for estimateReshieldCrosschainAmount(). */
export interface EstimateReshieldCrosschainParams<TAddress = Address> {
    /** Relayer to quote from. */
    relayerInfo: RelayerInfo<TAddress>;
    /** Withdrawal amount in input token units (hex-encoded). */
    amount: Hex;
    /** Input token address (source chain). */
    tokenId: TAddress;
    /** Desired output token address (destination chain deposit token). */
    outputToken: TAddress;
    /** Destination chain ID the reshield deposits into. Must differ from the relayer's chain. */
    toChainId: number;
    /** Chain type `toChainId` is scoped to (e.g. "evm", "stellar") — see {@link PoolSessionReshieldCrosschainConfig.destinationChainType}. */
    toChainType: string;
    /**
     * Destination-chain address receiving bridged tokens if the destination
     * deposit call fails, and any successful-but-excess leftover LiFi's
     * executor doesn't consume (see `getSwapAndDepositQuote`'s `fallbackAddress`).
     * No end-user wallet exists on the destination chain for this flow —
     * defaults to the relayer's own address (transient design: the relayer
     * receives anything not redeposited and is expected to later turn it
     * into a deposit on the user's behalf; see the dust-rescue opt-in below
     * and `cross_chain_reshield_current_state_brief.org`).
     */
    fallbackAddress?: TAddress;
    /** Address to receive dust left on the source-chain processor. Defaults to relayer address. */
    dustRecipient?: TAddress;
    /** Slippage tolerance (0-1 range). Defaults via swap quote provider (cross-chain default). */
    slippage?: number;
    /**
     * LiFi tool/exchange names to exclude from routing (e.g. `["fly"]`).
     * Forwarded to the swap quote provider's `getSwapQuote()` — see
     * `SwapQuoteRequest.denyExchanges` for why this matters.
     */
    denyExchanges?: string[];
}

/** Result of estimateReshieldCrosschainAmount(). */
export interface ReshieldCrosschainEstimate<TAddress = Address> {
    /** Relayer fee in input token units. */
    feeAmount: string;
    /** Net amount after fee, used for LiFi swap. */
    netSwapAmount: string;
    /** LiFi estimated output on the destination chain (informational). */
    estimatedOutput: string;
    /** LiFi minimum output accounting for slippage (informational; not on-chain enforced cross-chain). */
    estimatedMinOutput: string;
    /** Recommended deposit note value on the destination chain (hex-encoded). */
    noteValue: Hex;
    /**
     * Vetting fee for the deposit (informational), in the output token. `"0"` for a yield share
     * output: the router takes that fee in shares inside `noteValue`'s sizing.
     */
    vettingFee: string;
    /**
     * What the aggregator must deliver to the deposit target. Plain output: noteValue + vettingFee
     * in the output token. Yield share output: the FUNDING-token budget (underlying, or native
     * coin for a native-mode router) that becomes the router's spend cap; `noteValue` is then in
     * shares.
     */
    totalDepositCost: string;
    /**
     * Token the source-chain swap actually consumes. Equals `tokenId` for a plain note; for
     * a yield share it is the wrapper's `underlying`, which the processor redeems the shares
     * into before the swap. `netSwapAmount` is denominated in this token.
     */
    swapInputToken: TAddress;
}

/** Parameters for prepareReshieldCrosschainQuote(). */
export interface PrepareReshieldCrosschainQuoteParams<TTx = PreparedTransaction, TAddress = Address> {
    /** Relayer to quote from. */
    relayerInfo: RelayerInfo<TAddress>;
    /** Withdrawal amount in input token units (hex-encoded). */
    amount: Hex;
    /** Input token address (source chain). */
    tokenId: TAddress;
    /** Desired output token address (destination chain deposit token). */
    outputToken: TAddress;
    /** Destination chain ID the reshield deposits into. Must differ from the relayer's chain. */
    toChainId: number;
    /** Chain type `toChainId` is scoped to (e.g. "evm", "stellar") — see {@link PoolSessionReshieldCrosschainConfig.destinationChainType}. */
    toChainType: string;
    /**
     * Destination-chain fallback address if the destination deposit call
     * fails, or for any successful-but-excess leftover. Defaults to the
     * relayer's own address — see `EstimateReshieldCrosschainParams.fallbackAddress`.
     */
    fallbackAddress?: TAddress;
    /**
     * Result of a deposit proof prepared against the **destination** chain's
     * Entrypoint (i.e. a `PoolSession` scoped to `toChainId`, not this
     * session's own `chainId`). Callers must generate this proof against the
     * destination deployment before calling this method.
     */
    depositResult: PrepareDepositResult<TTx, TAddress>;
    /** Total deposit cost from ReshieldCrosschainEstimate.totalDepositCost. */
    totalDepositCost: string;
    /** Address to receive dust left on the source-chain processor. Defaults to relayer address. */
    dustRecipient?: TAddress;
    /** Slippage tolerance (0-1 range). Defaults via swap quote provider (cross-chain default). */
    slippage?: number;
    /**
     * Opt in to rescuing the destination-chain leftover above the relayer's
     * own worth-it threshold into a stealth-owned shielded deposit, instead
     * of forfeiting it as ordinary dust. See {@link DustRescueOptIn}.
     */
    dustRescue?: DustRescueOptIn;
    /**
     * LiFi tool/exchange names to exclude from routing (e.g. `["fly"]`).
     * Forwarded to the swap-and-deposit quote provider's `getSwapAndDepositQuote()`.
     */
    denyExchanges?: string[];
}

/** Result of prepareReshieldCrosschainQuote(). */
export interface PreparedReshieldCrosschainQuote<TAddress = Address> {
    /** Relayer info + signed fee commitment, ready for relayReshieldCrosschain(). */
    selectedQuote: PrepareSwapRelayerQuotes<TAddress>;
    /** LiFi swap+deposit calldata (hex-encoded). */
    swapCalldata: Hex;
    /** Relayer fee in input token units. */
    feeAmount: string;
    /**
     * Net amount to forward as `relayReshieldCrosschain`'s `amount` (hex-encoded): the
     * gross `amountSent` minus the relayer `feeAmount`. Mirrors `PreparedReshieldQuote.netAmount`.
     */
    netAmount: Hex;
    /** Swap target from the LiFi quote, echoed from the validated routing. */
    swapTarget: TAddress;
    /** Approval address from the LiFi quote, echoed from the validated routing. */
    approvalAddress: TAddress;
    /**
     * Effective dust recipient committed in the signed routing. Pass through
     * to `relayReshieldCrosschain` so relay-time validation checks the same
     * value the relayer signed.
     */
    dustRecipient: TAddress;
    /** Destination chain ID this quote was prepared for. */
    toChainId: number;
    /** Chain type `toChainId` is scoped to (e.g. "evm", "stellar") — see {@link PoolSessionReshieldCrosschainConfig.destinationChainType}. */
    toChainType: string;
    /** Destination-chain fallback address, echoed from the validated routing. */
    fallbackAddress: TAddress;
    /**
     * Owned output note the destination-chain deposit proof commits to
     * (`depositResult.pendingNote`). Pass through to `relayReshieldCrosschain`
     * so it is persisted locally once the receipt succeeds.
     */
    depositNote: PendingNote<TAddress>;
    /** Echoed dust-rescue opt-in, if any, for `relayReshieldCrosschain` to forward to the relayer. */
    dustRescue?: DustRescueOptIn;
    /**
     * Token the source-chain swap consumes — `tokenId` for a plain note, the wrapper's
     * `underlying` for a yield share (the processor redeems the shares into it before the
     * swap).
     */
    swapInputToken: TAddress;
    /**
     * B2 (EVM-only Mainnet-destination reshield) — present only when a Mainnet-destination
     * gas-swap was sized: the SDK-sized native LayerZero fee `RelaySwaps` mints in-contract
     * (`swapValue`), the bounded gas-swap approval ceiling (`gasSwapMaxInput`), and the
     * proof-bound same-chain gas-swap calldata (`gasSwapCalldata`). Pass all three back into
     * `relayReshieldCrosschain`. `undefined`/absent on every non-EVM or non-Mainnet-destination
     * path.
     */
    swapValue?: bigint;
    gasSwapMaxInput?: bigint;
    gasSwapCalldata?: Hex;
}

/** Parameters for relayReshieldCrosschain(). */
export interface ReshieldCrosschainParams<TAddress = Address> {
    /** Commitment hashes of the input notes to spend (source chain). */
    inputCommitments: Hash[];
    /** Net amount withdrawn into the swap (source-chain token units, hex-encoded). Pass `PreparedReshieldCrosschainQuote.netAmount`. */
    amount: Hex;
    /** Token identifier for the withdrawn asset (source chain). */
    tokenId: TAddress;
    /** The desired output token address (destination chain). */
    outputToken: TAddress;
    /** Destination chain ID. */
    toChainId: number;
    /** Chain type `toChainId` is scoped to (e.g. "evm", "stellar") — see {@link PoolSessionReshieldCrosschainConfig.destinationChainType}. */
    toChainType: string;
    /** Destination-chain fallback address. */
    fallbackAddress: TAddress;
    /** LiFi swap+deposit calldata with the destination deposit embedded (hex-encoded). */
    swapCalldata: Hex;
    /** The selected relayer and its fee quote. */
    selectedQuote: PrepareSwapRelayerQuotes<TAddress>;
    /** Expected dust recipient in the signed routing. Defaults to the relayer address. */
    dustRecipient?: TAddress;
    /** Expected swap target in the signed routing (echo `PreparedReshieldCrosschainQuote.swapTarget`). */
    swapTarget?: TAddress;
    /** Expected approval address in the signed routing (echo `PreparedReshieldCrosschainQuote.approvalAddress`). */
    approvalAddress?: TAddress;
    /** Owned destination-chain deposit note (echo `PreparedReshieldCrosschainQuote.depositNote`). */
    depositNote?: PendingNote<TAddress>;
    /** Dust-rescue opt-in to forward to the relayer (echo `PreparedReshieldCrosschainQuote.dustRescue`). */
    dustRescue?: DustRescueOptIn;
    /**
     * B2 — echo `PreparedReshieldCrosschainQuote.{swapValue,gasSwapMaxInput,gasSwapCalldata}`.
     * Omit on a path with no sized gas swap (routing must then carry zero / "0x").
     */
    swapValue?: bigint;
    gasSwapMaxInput?: bigint;
    gasSwapCalldata?: Hex;
    /**
     * Called once with the relayed tx hash as soon as the relayer accepts it, before the
     * receipt wait. Local only, never sent to the relayer. A throw is logged and ignored.
     */
    onBroadcast?: (txHash: Hex) => void;
}
