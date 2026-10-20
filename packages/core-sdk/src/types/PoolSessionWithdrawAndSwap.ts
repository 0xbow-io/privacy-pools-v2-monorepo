import type {
    Address,
    EVMProof,
    Hash,
    Hex,
    IAddressEqualityComparator,
    IEntrypointInteractor,
    ILogger,
    IRelayerInteractor,
    ISwapChainAdapter,
    ISwapQuoteProvider,
    ITransactOrchestrator,
    ITxReceiptWaiter,
    PreparedTransaction,
    PrepareDepositResult,
    PrepareTransactBase,
    RelayerInfo,
    SwapRelayerQuote,
    TxLog,
    YieldDepositForRecipient,
} from "../internal.js";

/**
 * One yield wrapper a swap/reshield session knows how to spend: when the withdrawn `tokenId`
 * equals `shareToken`, the session sizes the swap leg in `underlying` (via `previewRedeem`)
 * because the processor unwraps the shares (through `zap`) before swapping. Generic over the
 * chain's address type `TAddress` — evm-sdk builds these from its EVM-specific
 * `YieldDeployment` + `PPYieldTokenInteractor`, keeping core-sdk itself chain-agnostic.
 */
export interface YieldSwapWrapper<TAddress = Address> {
    /** The yield-share token this wrapper spends (e.g. ppUSDC). */
    shareToken: TAddress;
    /** The token the share redeems to — what the swap is actually quoted/executed on. */
    underlying: TAddress;
    /** Zap contract that must be allowlisted (`ISwapChainAdapter.isApprovedZap`) to redeem the shares before the swap. */
    zap?: TAddress;
    /** Reads the underlying amount `shares` currently redeem to (ERC-4626 `previewRedeem` or equivalent). */
    previewRedeem(shares: bigint): Promise<bigint>;
}

/**
 * One yield-share deposit target a swap/reshield/swap-deposit session can fund: when the output
 * (deposit) token equals `shareToken`, the aggregator delivers `fundingToken` (the underlying, or
 * the native sentinel for a native-mode router) to the share's router instead of the share itself,
 * and the redeposit is the router's `depositExactShares` call rather than `Entrypoint.deposit`.
 * Generic over the chain's prepared-transaction type `TTx` and address type `TAddress` — evm-sdk
 * builds these from its `YieldSessions` entries (`toYieldDepositTarget`), so core-sdk itself never
 * touches the router ABI.
 */
export interface YieldSwapDepositTarget<TTx = PreparedTransaction, TAddress = Address> {
    /** Chain the deployment lives on: a swap flow accepts a target only from its own chain (the DESTINATION chain for a cross-chain reshield). */
    chainId: number;
    /** The yield-share token this target mints (e.g. ppUSDC) — the deposit note's tokenId. */
    shareToken: TAddress;
    /** The router the redeposit calls (`depositExactShares` / `depositExactSharesNative`). */
    router: TAddress;
    /** Token the aggregator must deliver to the router: the underlying, or the native sentinel for a native-mode router. */
    fundingToken: TAddress;
    /** Sizes the shares an all-in funding-token `budget` buys (vetting fee and rate headroom included). */
    sizeSharesForBudget(budget: bigint, headroomPpm?: bigint): Promise<{ shares: bigint }>;
    /**
     * Sizes and prepares a router deposit funded by the aggregator (executor funding: never
     * returns wallet approvals).
     *
     * @param recipient - Optional third-party recipient identity (reshield-and-transfer's
     *   yield-share output). Omitted: self-deposit, unchanged from before. Present: the deposit
     *   is built for the given recipient instead of the calling session's own owner, and the
     *   returned `noteSecret` (when the out-of-band fallback fired) is forwarded on the result.
     */
    prepareSwapDeposit(
        budget: bigint,
        headroomPpm?: bigint,
        recipient?: YieldDepositForRecipient<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>>;
    /**
     * Checks the deposit proof's share/value and the encoded spend cap against the prepared result.
     * When `budget` is given the cap must equal it exactly.
     *
     * @throws {InvalidTransactParams} If the router, calldata, proof signals or cap disagree.
     */
    assertDepositMatches(
        result: Pick<PrepareDepositResult<TTx, TAddress>, "depositTx" | "pendingNote">,
        budget?: bigint,
    ): void;
}

/** Parameters for relayWithdrawAndSwap. */
export type WithdrawAndSwapParams<TAddress = Address> = PrepareTransactBase<TAddress> & {
    /** Recipient address for the swap output. */
    recipientAddress: TAddress;
    /** Fallback address for cross-chain bridge failure refunds. Defaults to recipientAddress if omitted. */
    fallbackAddress?: TAddress;
    /** The desired output token address. */
    outputToken: TAddress;
    /** Minimum acceptable output amount (hex-encoded). */
    minOutputAmount: Hex;
    /** LiFi swap calldata (hex-encoded), provided by the caller. */
    swapCalldata: Hex;
};

/**
 * Configuration for PoolSessionWithdrawAndSwap construction, generic over the chain's prepared-
 * transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and raw
 * receipt-log type `TLog`.
 */
export interface PoolSessionWithdrawAndSwapConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** Chain ID of the pool (entrypoint contract chain). Used to validate relayer chain. */
    chainId: number;
    /** Shared transact infrastructure (notes, keys, witness, proof, vault). */
    core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    /** Relayer interactor for swap-specific quote/submit endpoints. */
    relayerInteractor: IRelayerInteractor<TAddress>;
    /** Waits for the relayer's submitted transaction receipt. */
    rpcInteractor: ITxReceiptWaiter<TLog>;
    /** Entrypoint interactor for pre-flight asset config validation. */
    entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    /** Compares two `TAddress` values for equality (chain-specific canonicalization rules). */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    /** The chain's "no address" sentinel. */
    emptyAddress: TAddress;
    /** Optional swap quote provider for prepareSwapQuote() convenience method. */
    swapQuoteProvider?: ISwapQuoteProvider<TAddress>;
    /**
     * Chain-specific routing-decode/router-allowlist/recipient-embedding/token-identity
     * capability. Required at construction — PoolSessionFactory only builds this session at all
     * when one is supplied (same gating as `core`/`relayerInteractor`).
     */
    swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
    /**
     * Yield wrappers whose shares can be withdrawn-and-swapped. A withdrawn `tokenId` matching a
     * wrapper's `shareToken` is quoted on the aggregator as its `underlying` (the processor
     * redeems the shares on-chain first). Unset/empty: shares are treated like any other token
     * and the aggregator will have no route for them.
     */
    yieldWrappers?: YieldSwapWrapper<TAddress>[];
    /**
     * The chain's RelaySwaps deployment — the contract that actually executes the relayed
     * withdraw-and-swap on-chain (`RelaySwaps.execute()`, which calls `PoolVault.transact()`
     * internally, so `msg.sender` there is RelaySwaps, not the relayer's own address or any
     * withdrawal-only relay contract). Required for `relayWithdrawAndSwap` to bind the correct
     * on-chain processor into the proof context and for the router-allowlist / zap-approval
     * checks; `prepareSwapQuote`/`relayWithdrawAndSwap` throw {@link InvalidTransactParams} if
     * unset. Optional at construction (like {@link PoolSessionSwapDepositConfig.relaySwapsAddress})
     * so a deployment without RelaySwaps yet (e.g. real Sepolia as of v9) can still build a
     * session — same-chain withdraw-and-swap just isn't usable on it.
     */
    relaySwapsAddress?: TAddress;
}

/** Optional dependencies for PoolSessionWithdrawAndSwap. */
export interface PoolSessionWithdrawAndSwapDependencies {
    logger?: ILogger;
}

export interface PrepareSwapRelayerQuotes<TAddress = Address> {
    /** Relayer information (name, URL, etc.) */
    relayerInfo: RelayerInfo<TAddress>;
    /** The fee quote returned by the relayer for this swap. */
    quote: SwapRelayerQuote<TAddress>;
}

/** Parameters for the prepareSwapQuote() convenience method. */
export interface PrepareSwapQuoteParams<TAddress = Address> {
    /** Relayer to quote from. */
    relayerInfo: RelayerInfo<TAddress>;
    /** Withdrawal amount in input token units (hex-encoded). */
    amount: Hex;
    /** Input token address. */
    tokenId: TAddress;
    /** Desired output token address. */
    outputToken: TAddress;
    /**
     * Recipient address for swap output. For cross-chain swaps this is a
     * destination-chain address — it goes into the proof-bound LiFi calldata
     * (`toAddress`) only; the on-chain routing recipient is the zero address.
     */
    recipientAddress: TAddress;
    /**
     * Destination-chain address receiving bridged tokens if the destination
     * swap fails. Required for cross-chain swaps; defaults to recipientAddress
     * for same-chain swaps.
     */
    fallbackAddress?: TAddress;
    /**
     * Source-chain address to receive dust left on the processor. Defaults to
     * recipientAddress for same-chain swaps, and to the relayer address for
     * cross-chain swaps (recipientAddress is a destination-chain address).
     */
    dustRecipient?: TAddress;
    /**
     * Opt-in ETH gas top-up for the recipient (the relayer computes, caps, and
     * charges the amount via feeAmount). Not supported for cross-chain swaps.
     */
    extraGas?: boolean;
    /** Slippage tolerance (0-1 range). Defaults via swap quote provider. */
    slippage?: number;
    /**
     * Destination chain ID for cross-chain swaps. Defaults to the relayer's
     * chain (same-chain swap). When it differs, the on-chain routing recipient
     * is the zero address and minOutputAmount is 0 — slippage protection lives
     * in the proof-bound LiFi calldata, enforced by LiFi's destination executor.
     */
    toChainId?: number;
    /**
     * LiFi tool/exchange names to exclude from routing (e.g. `["fly"]`).
     * Forwarded verbatim to the configured swap quote provider's
     * `getSwapQuote()`. See {@link SwapQuoteRequest.denyExchanges} — LiFi's
     * "fly" tool embeds a transaction deadline shorter than this protocol's
     * proof generation + relayer round-trip, so quotes routed through it
     * reliably revert on-chain with `ExpiredTransaction()`.
     */
    denyExchanges?: string[];
}

/** Result of prepareSwapQuote() — everything needed for relayWithdrawAndSwap(). */
export interface PreparedSwapQuote<TAddress = Address> {
    /** Relayer info + signed fee commitment, ready for relayWithdrawAndSwap(). */
    selectedQuote: PrepareSwapRelayerQuotes<TAddress>;
    /** LiFi swap calldata (hex-encoded). */
    swapCalldata: Hex;
    /**
     * On-chain enforced minimum output amount (hex-encoded). `0x0` for
     * cross-chain swaps — the source chain cannot verify destination output;
     * use destinationMinOutputAmount for display.
     */
    minOutputAmount: Hex;
    /**
     * Minimum output amount from LiFi (hex-encoded, informational). For
     * cross-chain swaps this is enforced by LiFi's destination executor via
     * the proof-bound calldata, not by the source-chain contract.
     */
    destinationMinOutputAmount: Hex;
    /** Relayer fee in input token units. */
    feeAmount: string;
    /**
     * Net amount to forward as `relayWithdrawAndSwap`'s `amount` (hex-encoded):
     * the gross `amountSent` minus the relayer `feeAmount`. The prepare side
     * quotes a **gross** withdrawal (`amount`), but the relay side spends the
     * **net** (`gross − fee`) into the proof, so pass this value verbatim to
     * avoid the gross/net mismatch.
     */
    netAmount: Hex;
    /** Estimated output amount from LiFi (informational). */
    estimatedOutput: string;
    /**
     * Token the LiFi swap actually consumes on the source chain. Equals `tokenId` for a plain
     * note; for a yield share it is the wrapper's `underlying`, which RelaySwaps redeems the
     * shares into before the swap. `dustAmount` is denominated in this token.
     */
    swapInputToken: TAddress;
    /** Swap target from the LiFi quote, echoed from the validated routing. */
    swapTarget: TAddress;
    /** Approval address from the LiFi quote, echoed from the validated routing. */
    approvalAddress: TAddress;
    /**
     * Effective dust recipient committed in the signed routing (explicit
     * param, or the same-chain/cross-chain default). Pass through to
     * `relayWithdrawAndSwap` so relay-time validation checks the same value
     * the relayer signed.
     */
    dustRecipient: TAddress;
    /**
     * Input-token surplus (`netAmount − LiFi input`, hex-encoded) swept to `dustRecipient`
     * on-chain. The swap input is sized against an over-estimated fee so the fixed LiFi
     * `fromAmount` always fits the funded net; the small leftover is this dust. Same-chain
     * `dustRecipient` defaults to the recipient, so it returns to the user; cross-chain it
     * defaults to the relayer unless an explicit source-chain `dustRecipient` is passed.
     * Surfaced so the caller sees the amount; bounded by the SDK's dust tolerance.
     */
    dustAmount: Hex;
    /**
     * Destination chain ID this quote was prepared for (equals the relayer's
     * chain for same-chain swaps). Pass through to relayWithdrawAndSwap —
     * omitting it there would treat a cross-chain quote as same-chain and
     * fail validation against the zero-recipient routing.
     */
    toChainId: number;
}

/** Parameters for executing a prepared withdraw-and-swap via a relayer. */
export interface ExecuteWithdrawAndSwapRelayerParams<TAddress = Address> {
    /** Commitment hashes of the input notes to spend. */
    inputCommitments: Hash[];
    /**
     * Net amount withdrawn into the swap (in input token units, hex-encoded):
     * the gross withdrawal minus the relayer fee. Pass `PreparedSwapQuote.netAmount`.
     * Note `prepareSwapQuote`'s `amount` is the **gross** withdrawal; this is that
     * value **minus** the fee (`amountSent − feeAmount`).
     */
    amount: Hex;
    /** Token identifier for the withdrawn asset. */
    tokenId: TAddress;
    /** Recipient address for the swap output (destination-chain address for cross-chain swaps). */
    recipientAddress: TAddress;
    /** Destination-chain fallback address. Required for cross-chain swaps; defaults to recipientAddress if omitted. */
    fallbackAddress?: TAddress;
    /** The desired output token address. */
    outputToken: TAddress;
    /** Minimum acceptable output amount (hex-encoded). Must be `0x0` for cross-chain swaps. */
    minOutputAmount: Hex;
    /** LiFi swap calldata (hex-encoded). */
    swapCalldata: Hex;
    /** The selected relayer and its fee quote for this swap. */
    selectedQuote: PrepareSwapRelayerQuotes<TAddress>;
    /** Destination chain ID for cross-chain swaps. Defaults to the relayer's chain (same-chain). */
    toChainId?: number;
    /**
     * Expected dust recipient in the signed routing. Defaults to
     * recipientAddress (same-chain) or the relayer address (cross-chain),
     * mirroring prepareSwapQuote.
     */
    dustRecipient?: TAddress;
    /**
     * Echo of the `extraGas` flag passed to prepareSwapQuote. Defaults to
     * false, which requires the signed routing's nativeGas to be zero; when
     * true the routing must carry a nonzero relayer-funded top-up. Always
     * validated — same-chain and cross-chain alike.
     */
    extraGas?: boolean;
    /**
     * Expected swap target in the signed routing (echo
     * `PreparedSwapQuote.swapTarget`). Validated when provided — omitting it
     * skips the check, so pass it whenever a prepared quote is in scope.
     */
    swapTarget?: TAddress;
    /**
     * Expected approval address in the signed routing (echo
     * `PreparedSwapQuote.approvalAddress`). Validated when provided.
     */
    approvalAddress?: TAddress;
}
