import type { ZodType } from "zod";

import type {
    Address,
    DepositForRecipient,
    Hex,
    IAddressEqualityComparator,
    IEntrypointInteractor,
    ILogger,
    INoteManager,
    IPoolSessionDeposit,
    IPoolVaultInteractor,
    ISwapAndDepositQuoteProvider,
    ISwapChainAdapter,
    ISwapQuoteProvider,
    ITxReceiptWaiter,
    IWalletInteractor,
    PendingNote,
    PreparedTransaction,
    YieldSwapDepositTarget,
} from "../internal.js";

/**
 * Source-chain attachment enabling cross-chain swap-and-deposit: the input token,
 * the approval, and the LiFi transaction all live on this chain, while the deposit
 * lands on the session's pool chain via LiFi's destination executor.
 *
 * LiFi's `transactionTo`/`approvalAddress` are validated against THIS chain's
 * RelaySwaps `approvedRouters` — that is where the transaction executes, so the
 * pool chain's allowlist would be the wrong trust anchor.
 */
export interface SwapDepositSourceChainConfig<TTx = PreparedTransaction, TAddress = Address> {
    /** Chain ID the input token and wallet live on. Must differ from the pool chain. */
    chainId: number;
    /** Wallet used to sign/send the approval and swap transactions on the source chain. */
    walletInteractor: IWalletInteractor<TTx, TAddress>;
    /** RPC connection for source-chain receipt waits. */
    rpcInteractor: ITxReceiptWaiter;
    /** Source-chain RelaySwaps deployment — its approvedRouters is the LiFi allowlist. */
    relaySwapsAddress: TAddress;
    /** Chain-specific routing-decode/router-allowlist/approval capability for the source chain. */
    swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
}

/** An aggregator's swap executor and the ERC-20 proxy it pulls the caller's tokens through. */
export interface SwapExecutorAddresses<TAddress = Address> {
    executor: TAddress;
    /** The only address the user approves: the executor pulls the input through it. */
    erc20Proxy: TAddress;
}

/**
 * Configuration for PoolSessionSwapDeposit construction, generic over the chain's prepared-
 * transaction type `TTx` and address type `TAddress`.
 */
export interface PoolSessionSwapDepositConfig<TTx = PreparedTransaction, TAddress = Address> {
    /** The depositor's address. */
    ownerAddress: TAddress;
    /** The chain ID this session operates on. */
    chainId: number;
    /** Yield-share deposit targets on this chain: a deposit token equal to a target's share is funded via the share's router. */
    yieldDepositTargets?: YieldSwapDepositTarget<TTx, TAddress>[];
    /** Deposit delegate for generating deposit proofs. */
    depositDelegate: IPoolSessionDeposit<TTx, TAddress>;
    /** Quote provider for LiFi contract-calls quotes. */
    swapAndDepositQuoteProvider: ISwapAndDepositQuoteProvider<TAddress>;
    /**
     * Ordinary swap quotes, for a same-chain deposit into the plain native coin. With
     * `swapExecutor` it lets that deposit run as one executor transaction: the swap, then the
     * deposit with its exact `msg.value`. Without both, such a deposit is refused.
     */
    swapQuoteProvider?: ISwapQuoteProvider<TAddress>;
    /** The aggregator's swap executor on this chain and the ERC-20 proxy it pulls through. */
    swapExecutor?: SwapExecutorAddresses<TAddress>;
    /** Entrypoint interactor for submitting transactions and reading allowances. */
    entrypointInteractor: IEntrypointInteractor<TTx, TAddress>;
    /** RPC interactor for awaiting transaction receipts. */
    rpcInteractor: ITxReceiptWaiter;
    /** Note state manager for persisting deposit notes. */
    noteManager: INoteManager<TAddress>;
    /** PoolVault interactor for resolving commitment timestamps. */
    poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress>;
    /** RelaySwaps contract address — queried for the approved router allowlist. */
    relaySwapsAddress: TAddress;
    /** The chain's native-asset sentinel address (never needs an ERC-20-style approval). */
    nativeAssetAddress: TAddress;
    /** The chain's "no address" sentinel — rejected as an explicit `fallbackAddress`. */
    emptyAddress: TAddress;
    /** Compares two `TAddress` values for equality (chain-specific canonicalization rules). */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    /** Validates the `TAddress`-typed fields carried by per-call swap-and-deposit params. */
    addressSchema: ZodType<TAddress>;
    /** Chain-specific routing-decode/router-allowlist/approval-building capability. */
    swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
    /**
     * Optional source-chain attachment for cross-chain swap-and-deposit. Absent →
     * cross-chain requests throw InvalidSwapAndDepositParams (same-chain only).
     */
    sourceChain?: SwapDepositSourceChainConfig<TTx, TAddress>;
}

/** Optional dependencies for PoolSessionSwapDeposit. */
export interface PoolSessionSwapDepositDependencies {
    logger?: ILogger;
}

/** Parameters for a swap-and-deposit operation, generic over the chain's address type `TAddress`. */
export interface SwapAndDepositParams<TAddress = Address> {
    /** Source chain ID where the input token resides. Can differ from pool chain for cross-chain swaps. */
    fromChainId: number;
    /** Address of the input token the user holds (token X). */
    inputToken: TAddress;
    /** Address of the deposit token (token Y) accepted by the pool. */
    depositToken: TAddress;
    /** Plain token note value, or the underlying/native budget for a configured share target. Hex encoded. */
    depositAmount: Hex;
    /**
     * Cross-chain only: destination-chain address receiving the bridged tokens when
     * the destination deposit cannot execute. Defaults to the session's ownerAddress
     * (the user's own EOA, which exists on the destination chain — unlike the
     * relayer-mediated reshield flow). Ignored for same-chain swaps.
     */
    fallbackAddress?: TAddress;
    /**
     * The caller's input-token budget (wei). CROSS-CHAIN ONLY.
     *
     * When set, the LiFi contract-calls quote is requested in fromAmount mode:
     * LiFi routes this whole budget, feeds `depositAmount` (+ vetting fee) into
     * the deposit call and sends any surplus to `fallbackAddress` — the same
     * shape the cross-chain reshield uses. Without it the request is exact-out
     * (`toAmount`), which LiFi can only solve backwards through a bridge for
     * larger sizes: 0.001 ETH → 2.4 USDC on Optimism answered 404 "Unable to
     * find quote to match expected output" while the identical fromAmount
     * request routed fine (Across). Same-chain requests ignore this field; the
     * exact-out solve works there and surplus must stay with the payer.
     */
    inputAmount?: Hex;
    /**
     * Deposit FOR someone else. Same forms `prepareDepositFor` accepts: `discoveryData` for a
     * registered recipient (the note is announced to their viewing key), or the blind cold-start
     * `noteAddressHash` form (optionally with `noteData` + `depositSecret`, or a `noteData`
     * builder when the committed value is sized by the SDK, as for a yield share).
     *
     * The embedded deposit (the plain `Entrypoint.deposit`, or the yield router's exact-shares
     * deposit) then carries the recipient's depositFor proof, so the note is theirs:
     * `pendingNote.isOwned` is false and `executeSwapAndDeposit` never persists it into this
     * session. Supported same-chain and cross-chain. The payer still signs, pays and is the
     * cross-chain `fallbackAddress` default: by default a failed destination deposit refunds
     * the payer, unless an explicit `fallbackAddress` redirects it. Omitted, the session owner
     * gets the note (unchanged behavior).
     */
    recipient?: DepositForRecipient<TAddress>;
}

/** Result of preparing a swap-and-deposit (ready for wallet submission), generic over `TTx`/`TAddress`. */
export interface PrepareSwapAndDepositResult<TTx = PreparedTransaction, TAddress = Address> {
    /**
     * Note data for deferred persistence after tx confirmation. For a `recipient` deposit it is
     * the recipient's unowned note (`isOwned: false`): its `commitment`, `label`, `value`,
     * `tokenId` and `depositSecret` are what a claim link for a blind recipient needs (the
     * caller holds the `noteSecret` it hashed into `noteAddressHash`).
     */
    pendingNote: PendingNote<TAddress>;
    /** The input token (token X) being swapped — used to validate approvalTx.to at execute time. */
    inputToken: TAddress;
    /** Amount of input token required (estimated by LiFi), hex-encoded wei. */
    estimatedInputAmount: Hex;
    /** Input amount in USD (informational). */
    inputAmountUSD?: string;
    /** Deposit amount in USD (informational). */
    depositAmountUSD?: string;
    /** Address to approve input tokens to (LiFi router). */
    approvalAddress: TAddress;
    /**
     * Every input-token approval to submit, in order, before the swap. Two on a token that
     * requires a zero reset before re-approving (mainnet USDT) when a residual allowance
     * exists; empty when the allowance suffices or the input is native. Prefer over `approvalTx`.
     */
    approvalTxs: TTx[];
    /** The last of `approvalTxs`, or null if none — kept for callers that submit a single approval. */
    approvalTx: TTx | null;
    /** The swap+deposit transaction calldata (targets LiFi router). */
    transactionData: Hex;
    /** The contract address to send the transaction to (LiFi router). */
    transactionTo: TAddress;
    /**
     * Chain the swap transaction executes on. Equals the pool chain for same-chain
     * swaps; the sourceChain.chainId for cross-chain. Drives execute-time submission
     * routing (which wallet/RPC sends the transactions).
     */
    fromChainId: number;
    /**
     * The deposit proof calldata (`Entrypoint.deposit(...)`) that must be embedded in
     * `transactionData`. Carried so `executeSwapAndDeposit` can re-verify the embedding
     * on a result that may have round-tripped through untrusted storage/transport.
     */
    depositCallData: Hex;
    /**
     * The Entrypoint address the embedded deposit must target (the pool-chain Entrypoint).
     * Re-checked at execute against the session's own Entrypoint, so a tampered value is
     * rejected before signing.
     */
    depositTarget: TAddress;
    /** Native value forwarded by the destination executor to the deposit call. */
    depositMsgValue?: Hex;
    /**
     * Set on a session-composed executor call only: the exact amount of the swap output the deposit
     * call is handed (its value for the native coin, an executor approval for an ERC-20). Pinned at
     * execute against the decoded call; an executor transaction without it is refused.
     */
    depositCallValue?: Hex;
    /** Native-asset value to send with the transaction (hex-encoded). */
    msgValue: Hex;
    /** Estimated execution duration in seconds. */
    estimatedDuration: number;
}
