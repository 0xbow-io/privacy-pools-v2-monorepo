import type {
    Address,
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
    SwapExecutorAddresses,
    TxLog,
    YieldSwapDepositTarget,
    YieldSwapWrapper,
} from "../internal.js";
// DustRescueOptIn predates same-chain support (added for PoolSessionReshieldCrosschain) but is
// not cross-chain-specific — the on-chain SwapRouting.dustRescue field it rides on on-chain
// is generic (RelaySwaps.sol never reads it either way), and the relayer's own gate is
// `recipient === ZERO_ADDRESS`, which same-chain reshield already satisfies. Defined where it
// was first needed rather than relocated, to avoid unrelated churn in PoolSessionReshieldCrosschain.ts.
import type { DustRescueOptIn } from "./PoolSessionReshieldCrosschain.js";

/**
 * Configuration for PoolSessionReshield construction, generic over the chain's prepared-
 * transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and raw
 * receipt-log type `TLog`.
 */
export interface PoolSessionReshieldConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** Chain ID this session operates on. */
    chainId: number;
    /** Yield-share deposit targets on this chain: an output token equal to a target's share is funded via the share's router. */
    yieldDepositTargets?: YieldSwapDepositTarget<TTx, TAddress>[];
    /** Shared transact infrastructure (notes, keys, witness, proof, vault). */
    core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    /** Relayer interactor for submitting to the relayer. */
    relayerInteractor: IRelayerInteractor<TAddress>;
    /** Waits for the relayer's submitted transaction receipt. */
    rpcInteractor: ITxReceiptWaiter<TLog>;
    /** Entrypoint interactor for pre-flight asset config and deposit-target validation. */
    entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    /** Compares two `TAddress` values for equality (chain-specific canonicalization rules). */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    /** The chain's "no address" sentinel. */
    emptyAddress: TAddress;
    /** Optional swap quote provider for estimateReshieldAmount(). */
    swapQuoteProvider?: ISwapQuoteProvider<TAddress>;
    /** Optional swap-and-deposit quote provider for prepareReshieldQuote(). */
    swapAndDepositQuoteProvider?: ISwapAndDepositQuoteProvider<TAddress>;
    /**
     * Chain-specific routing-decode/router-allowlist/token-identity capability. Required at
     * construction — PoolSessionFactory only builds this session at all when one is supplied
     * (same gating as `core`/`relayerInteractor`).
     */
    swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
    /**
     * Yield wrappers whose share notes (`shareToken`) this session can reshield. When the
     * spent `tokenId` matches a wrapper's share, the swap legs are quoted on the wrapper's
     * `underlying` (sized via `previewRedeem`) because the processor redeems the shares
     * on-chain first; the relayer fee and the note stay share-denominated. Unset/empty:
     * share notes have no swap route.
     */
    yieldWrappers?: YieldSwapWrapper<TAddress>[];
    /**
     * The chain's RelaySwaps deployment — the contract that executes a relayed reshield on-chain
     * (`RelaySwaps.execute()` calls `PoolVault.transact()` internally, so `msg.sender` there is
     * RelaySwaps, not the relayer or its withdrawal-only relay contract). Used as the proof's
     * bound processor, as the swap quote's `fromAddress`, and as the registry whose
     * `approvedRouters`/`approvedZaps` allowlists vet the aggregator quote. Optional at
     * construction (a deployment without RelaySwaps can still build a session); the reshield
     * methods throw {@link InvalidTransactParams} if it is unset.
     */
    relaySwapsAddress?: TAddress;
    /**
     * The aggregator's swap executor on this chain. The aggregator routes a swap-then-deposit
     * through it, and its own executor transaction is never signed (the executor runs arbitrary
     * calls). With this set, such a quote is replaced by the session's own composition: an
     * ordinary swap paid to the executor, then the deposit, fully decoded and pinned. Unset: such
     * a quote is refused, as before. Composing also needs `swapQuoteProvider` and
     * `nativeAssetAddress`; with either missing such a quote is refused.
     */
    swapExecutor?: SwapExecutorAddresses<TAddress>;
    /** The chain's native-coin sentinel, needed to compose a native output or input. */
    nativeAssetAddress?: TAddress;
}

/** Optional dependencies for PoolSessionReshield. */
export interface PoolSessionReshieldDependencies {
    logger?: ILogger;
}

/**
 * Parameters for a reshield (withdraw + swap + deposit) operation, generic over the chain's
 * address type `TAddress`.
 *
 * With the RelaySwaps contract, the deposit is embedded in the LiFi swap
 * calldata via `getContractCallsQuote()`. The caller generates the deposit
 * proof first, then builds LiFi calldata with the deposit embedded.
 *
 * Flow: deposit proof → LiFi contractCalls quote → hash calldata →
 * relayer quote (with hash) → relayReshield().
 */
export interface ReshieldParams<TAddress = Address> {
    /** Commitment hashes of the input notes to spend. */
    inputCommitments: Hash[];
    /**
     * Net amount withdrawn into the swap (in input token units, hex-encoded): the
     * gross withdrawal minus the relayer fee. Pass `PreparedReshieldQuote.netAmount`.
     * Note `prepareReshieldQuote`'s `amount` is the **gross** withdrawal; this is that
     * value **minus** the fee (`amountSent − feeAmount`).
     */
    amount: Hex;
    /** Token identifier for the withdrawn asset. */
    tokenId: TAddress;
    /** The desired output token address (to deposit back into pool). */
    outputToken: TAddress;
    /** LiFi swap calldata with deposit embedded via contractCalls (hex-encoded). */
    swapCalldata: Hex;
    /** The selected relayer and its fee quote (routing includes the full swapCalldata). */
    selectedQuote: PrepareSwapRelayerQuotes<TAddress>;
    /** Expected dust recipient in the signed routing. Defaults to the relayer address. */
    dustRecipient?: TAddress;
    /**
     * Expected swap target in the signed routing (echo
     * `PreparedReshieldQuote.swapTarget`). Validated when provided — omitting
     * it skips the check, so pass it whenever a prepared quote is in scope.
     */
    swapTarget?: TAddress;
    /**
     * Expected approval address in the signed routing (echo
     * `PreparedReshieldQuote.approvalAddress`). Validated when provided.
     */
    approvalAddress?: TAddress;
    /**
     * Owned output note deposited by the reshield (echo
     * `PreparedReshieldQuote.depositNote`). Persisted locally once the receipt
     * succeeds so the note is spendable immediately instead of only after a
     * later discovery scan. Omitting it skips persistence — discovery recovers
     * the note on the next scan.
     */
    depositNote?: PendingNote<TAddress>;
    /** Dust-rescue opt-in to forward to the relayer (echo `PreparedReshieldQuote.dustRescue`). */
    dustRescue?: DustRescueOptIn;
    /**
     * The composed executor call's pinned amounts (echo `PreparedReshieldQuote.executorCall`).
     * Required when the signed routing targets the swap executor: relay refuses it without them.
     */
    executorCall?: ReshieldExecutorCall;
    /**
     * Called once with the relayed tx hash as soon as the relayer accepts it, before the
     * receipt wait. Local only, never sent to the relayer. A throw is logged and ignored.
     */
    onBroadcast?: (txHash: Hex) => void;
}

/**
 * The exact amounts a session-composed executor reshield was built with at prepare, pinned
 * against the decoded call again at relay.
 */
export interface ReshieldExecutorCall {
    /** Swap input the executor pulls, in `swapInputToken` units (hex). */
    inputAmount: Hex;
    /** Amount of the swap output the deposit call is handed (hex). */
    callValue: Hex;
}

/** Parameters for estimateReshieldAmount(). */
export interface EstimateReshieldParams<TAddress = Address> {
    /** Relayer to quote from. */
    relayerInfo: RelayerInfo<TAddress>;
    /** Withdrawal amount in input token units (hex-encoded). */
    amount: Hex;
    /** Input token address. */
    tokenId: TAddress;
    /** Desired output token address (deposit token). */
    outputToken: TAddress;
    /** Address to receive dust left on processor. Defaults to relayer address. */
    dustRecipient?: TAddress;
    /** Slippage tolerance (0-1 range). Defaults via swap quote provider. */
    slippage?: number;
}

/** Result of estimateReshieldAmount(). */
export interface ReshieldEstimate<TAddress = Address> {
    /** Relayer fee in input token units. */
    feeAmount: string;
    /** Net amount after fee, used for LiFi swap. */
    netSwapAmount: string;
    /** LiFi estimated output (informational). */
    estimatedOutput: string;
    /** LiFi minimum output accounting for slippage. */
    estimatedMinOutput: string;
    /** Recommended deposit note value (hex-encoded). */
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
     * Token the swap actually consumes. Equals `tokenId` for a plain note; for a yield
     * share it is the wrapper's `underlying` (the processor redeems the shares into it
     * first). `netSwapAmount` is denominated in this token.
     */
    swapInputToken: TAddress;
}

/** Parameters for prepareReshieldQuote(). */
export interface PrepareReshieldQuoteParams<TTx = PreparedTransaction, TAddress = Address> {
    /** Relayer to quote from. */
    relayerInfo: RelayerInfo<TAddress>;
    /** Withdrawal amount in input token units (hex-encoded). */
    amount: Hex;
    /** Input token address. */
    tokenId: TAddress;
    /** Desired output token address (deposit token). */
    outputToken: TAddress;
    /**
     * The redeposit the aggregator leg executes: `session.prepareDeposit()` for a plain output;
     * `target.prepareSwapDeposit(BigInt(estimate.totalDepositCost))` for a yield share.
     */
    depositResult: PrepareDepositResult<TTx, TAddress>;
    /** Total deposit cost from ReshieldEstimate.totalDepositCost. */
    totalDepositCost: string;
    /** Address to receive dust left on processor. Defaults to relayer address. */
    dustRecipient?: TAddress;
    /** Slippage tolerance (0-1 range). Defaults via swap quote provider. */
    slippage?: number;
    /**
     * Opt in to rescuing, above the relayer's own worth-it threshold, the **swap-input**
     * portion of the leftover swept to `dustRecipient` into a stealth-owned shielded deposit,
     * instead of forfeiting it as ordinary dust. Same mechanism as
     * `PoolSessionReshieldCrosschain`'s `dustRescue` (`DustRescueOptIn`) — the leftover lands
     * on this session's own chain rather than a distinct destination chain — but narrower on
     * same-chain: only the amount forwarded via `dust1ForwardTxHash` is rescued. Output-token
     * and native-ETH leftover from the same sweep are not covered and remain with the relayer.
     * Requires `dustRecipient` to be omitted or equal to the relayer's own address (the relayer
     * must hold the leftover itself to fund the rescue deposit).
     */
    dustRescue?: DustRescueOptIn;
}

/** Result of prepareReshieldQuote(). */
export interface PreparedReshieldQuote<TAddress = Address> {
    /** Relayer info + signed fee commitment, ready for relayReshield(). */
    selectedQuote: PrepareSwapRelayerQuotes<TAddress>;
    /** LiFi swap+deposit calldata (hex-encoded). */
    swapCalldata: Hex;
    /** Relayer fee in input token units. */
    feeAmount: string;
    /**
     * Net amount to forward as `relayReshield`'s `amount` (hex-encoded): the gross
     * `amountSent` minus the relayer `feeAmount`. The prepare side quotes a **gross**
     * withdrawal, but the relay side spends the **net** (`gross − fee`) into the proof,
     * so pass this value verbatim to avoid the gross/net mismatch.
     */
    netAmount: Hex;
    /** Swap target from the LiFi quote, echoed from the validated routing. */
    swapTarget: TAddress;
    /** Approval address from the LiFi quote, echoed from the validated routing. */
    approvalAddress: TAddress;
    /**
     * Effective dust recipient committed in the signed routing (explicit
     * param, or the relayer-address default). Pass through to `relayReshield`
     * so relay-time validation checks the same value the relayer signed.
     */
    dustRecipient: TAddress;
    /**
     * Leftover value swept to `dustRecipient`, in `swapInputToken` units: the committed
     * net (`gross − fee`, redeemed to the underlying for a yield share) minus the LiFi
     * `fromAmount`. Surfaced so callers can inspect what they forfeit before the relay.
     */
    dustAmount: Hex;
    /**
     * Token the swap consumes — `tokenId` for a plain note, the wrapper's `underlying` for
     * a yield share. `dustAmount` is denominated in this token.
     */
    swapInputToken: TAddress;
    /**
     * Owned output note the deposit proof commits to (`depositResult.pendingNote`).
     * Pass through to `relayReshield` so it is persisted locally once the receipt
     * succeeds, making the note spendable without waiting for a discovery scan.
     */
    depositNote: PendingNote<TAddress>;
    /** Echoed dust-rescue opt-in, if any, for `relayReshield` to forward to the relayer. */
    dustRescue?: DustRescueOptIn;
    /** Set when the quote was composed as an executor call: pass through to `relayReshield`. */
    executorCall?: ReshieldExecutorCall;
}
