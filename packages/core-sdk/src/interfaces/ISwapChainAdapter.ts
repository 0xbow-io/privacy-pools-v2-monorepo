import type { Address, Hex, PreparedTransaction } from "../internal.js";

/**
 * One same-chain transaction that runs an ordinary aggregator swap into `outputToken` (the native
 * coin or an ERC-20) and then a contract call handed an exact amount of that output, generic over
 * `TAddress`. See {@link ISwapChainAdapter.encodeSwapThenCall}.
 */
export interface SwapThenCallParams<TAddress = Address> {
    /** The aggregator swap's own target, approval address and calldata, used unchanged. */
    swapTarget: TAddress;
    swapApprovalAddress: TAddress;
    swapCallData: Hex;
    /**
     * The token the swap spends and how much of it. An ERC-20 is pulled from the caller through
     * the executor's proxy (the caller's approval); the native coin rides as the transaction's
     * own value, so no approval exists at all.
     */
    inputToken: TAddress;
    inputAmount: bigint;
    /**
     * What the swap delivers to the executor and the call then spends: the native coin (sent as
     * the call's value) or an ERC-20 (approved by the executor to `callTarget`, which pulls it).
     */
    outputToken: TAddress;
    /** The call made after the swap, handed exactly `callValue` of `outputToken`. */
    callTarget: TAddress;
    callData: Hex;
    callValue: bigint;
    /** Receives whatever input token, output token or native coin is left over. */
    receiver: TAddress;
}

/**
 * Generic decoded relay-swap routing tuple — the relayer-signed routing blob committed in the ZK
 * proof via context hash, generic over the chain's address type `TAddress`. Mirrors the EVM
 * `RelaySwaps.SwapRouting` contract struct field-for-field; a chain without an equivalent
 * contract/protocol has no way to produce one, which is exactly why decoding it is delegated to
 * {@link ISwapChainAdapter.decodeSwapRouting} rather than done inline here.
 */
export interface SwapRouting<TAddress = Address> {
    swapTarget: TAddress;
    approvalAddress: TAddress;
    outputToken: TAddress;
    recipient: TAddress;
    feeRecipient: TAddress;
    fallbackAddress: TAddress;
    dustRecipient: TAddress;
    feeAmount: bigint;
    minOutputAmount: bigint;
    nativeGas: bigint;
    /** B2 (EVM-only Mainnet-destination reshield) — native wei forwarded as msg.value to the main bridge call. 0 on every other path. */
    swapValue: bigint;
    /** B2 — upper bound on input-token units the contract may approve for the step-9.5 gas swap. */
    gasSwapMaxInput: bigint;
    /** B2 — same-chain input-token→native-asset swap calldata run against `swapTarget`. `0x` when unused. */
    gasSwapCalldata: Hex;
    swapCalldata: Hex;
    /**
     * RC-10: opt-in cross-chain "dust rescue", carried here purely to inherit this struct's
     * proof-context binding — the contract never reads it. `chainId === 0n` means none was
     * requested; `viewingPubKey` is empty unless `isCanonical` is true.
     */
    dustRescue: {
        chainId: bigint;
        tokenId: TAddress;
        isCanonical: boolean;
        spendingPubKey: Hex;
        viewingPubKey: Hex;
    };
}

/** Result of {@link ISwapChainAdapter.parseApprovalTx}. */
export interface ParsedApprovalTx<TAddress = Address> {
    /** The transaction's target address — the token contract being approved. */
    target: TAddress;
    /** The approved spender. */
    spender: TAddress;
    /** The approved amount. */
    amount: bigint;
}

/**
 * Chain-specific capabilities the swap/reshield/swap-deposit sessions
 * ({@link PoolSessionWithdrawAndSwap}, {@link PoolSessionReshield},
 * {@link PoolSessionReshieldCrosschain}, {@link PoolSessionSwapDeposit}) need beyond the generic
 * interactor set: decoding the relayer-signed routing blob, checking a router allowlist on-chain,
 * verifying a swap recipient is embedded in aggregator calldata, and building/parsing a
 * token-approval transaction.
 *
 * These four operations are chain-agnostic in *shape* (any chain could in principle implement
 * them) but today have exactly one real implementation: evm-sdk's `EvmSwapChainAdapter`, backed
 * by viem ABI encode/decode against `RELAY_SWAPS_APPROVED_ROUTERS_ABI` /
 * `CALLDATA_VERIFICATION_*_ABI` / `ERC20_ABI` / `ERC20_APPROVE_ABI`. There is no non-EVM
 * swap/bridge capability yet (LiFi itself is EVM/bridge-centric) — this interface keeps that
 * dependency out of core-sdk's bundle and type surface, so a future chain-specific
 * implementation can be added without touching core-sdk again, but does not itself provide one.
 */
export interface ISwapChainAdapter<TTx = PreparedTransaction, TAddress = Address> {
    /**
     * Decodes a relayer-signed routing blob (`feeCommitment.data`).
     *
     * @throws {InvalidTransactParams} If the blob cannot be decoded.
     */
    decodeSwapRouting(data: Hex): SwapRouting<TAddress>;

    /**
     * Returns whether `address` is approved in the chain's router allowlist for
     * `relaySwapsAddress` (implementations typically cache this per address pair).
     */
    isApprovedRouter(address: TAddress, relaySwapsAddress: TAddress): Promise<boolean>;

    /**
     * Asserts the deployed relay-swaps contract at `relaySwapsAddress` encodes its routing struct
     * the way this SDK build does (RC-32: the struct is opaque bytes on the wire, so an older
     * deployment can silently disagree on its shape until a proof has already been spent).
     * Implementations typically cache a positive result per address.
     *
     * @throws {RelaySwapsLayoutMismatch} If the deployed layout disagrees with this SDK's.
     */
    assertRoutingLayoutMatches(relaySwapsAddress: TAddress, chainId: number): Promise<void>;

    /**
     * Returns whether `zap` is approved in the chain's yield-unwrap zap allowlist for
     * `relaySwapsAddress` — what lets the processor redeem a yield-share note into its
     * underlying (e.g. via `RelaySwaps.executeUnwrapped`) before swapping it (implementations
     * typically cache this per address pair).
     */
    isApprovedZap(zap: TAddress, relaySwapsAddress: TAddress): Promise<boolean>;

    /**
     * Extracts the swap output recipient the aggregator's transaction data actually embeds
     * (queried against `transactionTo`, e.g. via a Diamond's on-chain calldata-verification
     * facet on EVM), so the caller can compare it against the recipient it requested before the
     * quote is proof-bound.
     */
    extractEmbeddedRecipient(
        transactionData: Hex,
        transactionTo: TAddress,
        isCrossChain: boolean,
    ): Promise<TAddress>;

    /**
     * Builds the token-approval transactions letting `spender` pull up to `amount` of `token` from
     * `owner`, in submission order: empty when no approval is needed (native asset, or an existing
     * allowance already covers `amount` — the adapter reads current allowance itself), one
     * `approve(amount)` normally, and `[approve(0), approve(amount)]` on a residual allowance (a
     * Tether-style token reverts a non-zero re-approve, vuln-mining #28).
     */
    buildTokenApprovalTxs(params: {
        token: TAddress;
        owner: TAddress;
        spender: TAddress;
        amount: Hex;
    }): Promise<TTx[]>;

    /** Parses a prepared approval tx built by {@link buildTokenApprovalTxs}, for pre-sign validation. */
    parseApprovalTx(tx: TTx): ParsedApprovalTx<TAddress>;

    /**
     * Whether two token addresses denote the same asset for the purpose of cross-checking a
     * swap-quote-provider's echoed route against the one requested. Beyond plain address
     * equality, a provider may echo its own alternate spelling of the chain's native asset (e.g.
     * LiFi always echoes the zero address for native, even when Privacy Pools' own
     * `nativeAssetAddress` sentinel was requested) — reconciling that provider-specific quirk is
     * this adapter's job, not the session classes'.
     */
    isSameToken(a: TAddress, b: TAddress): boolean;

    /**
     * Whether `address`, encoded the way the chain's contract-call ABI represents an address
     * argument, appears verbatim inside `transactionData` — used to confirm a deposit/target
     * address is genuinely embedded in aggregator calldata before it is proof-bound (on EVM: the
     * address left-padded to a 32-byte ABI word). A plain hex substring search over the raw
     * address bytes (no encoding) is chain-agnostic and handled by core-sdk directly — see
     * `isDepositCalldataEmbedded` in utils — this method exists only for the encoding step that
     * varies by chain.
     */
    isAddressEmbeddedInCalldata(transactionData: Hex, address: TAddress): boolean;

    /**
     * Extracts the bridge's guaranteed destination-delivery amount from a cross-chain
     * aggregator transaction blob, when the route is one whose destination-side execution
     * budget is capped at that amount (on EVM: LiFi's Stargate-V2 facet calls, where the
     * destination contract call can never succeed above `sendParams.minAmountLD`). Returns
     * `undefined` when the route isn't a recognized budget-capped bridge (e.g. no native fee,
     * no such cap observed) — the caller then skips the destination-affordability check.
     */
    getDestinationDeliveryBudget(transactionData: Hex): bigint | undefined;

    /**
     * Extracts the amount the aggregator encoded for OUR destination contract call from a
     * cross-chain transaction blob, by locating the destination payload that embeds
     * `depositCallData` verbatim (on EVM: LiFi's `abi.encode(transactionId, SwapData[], receiver)`
     * receiver payload; the matching `SwapData.fromAmount`). This is the route's guaranteed
     * delivery — what the destination executor hands the call as `msg.value` for a native-coin
     * call — for every bridge, not only Stargate. Returns `undefined` when no destination
     * payload embedding `depositCallData` is found (a same-chain quote, or an unrecognised layout).
     */
    getDestinationCallAmount(transactionData: Hex, depositCallData: Hex): bigint | undefined;

    /**
     * Encodes {@link SwapThenCallParams} as one call to the aggregator's swap executor (on EVM:
     * LiFi's `Executor.swapAndExecute`, which takes `inputAmount` (through its ERC-20 proxy, or as
     * the transaction's value for the native coin), runs the swap, hands `callValue` of
     * `outputToken` to `callTarget`, and returns any leftover to `receiver`).
     */
    encodeSwapThenCall(params: SwapThenCallParams<TAddress>): Hex;

    /**
     * Inverse of {@link encodeSwapThenCall}, for pre-sign validation: the params `transactionData`
     * encodes, or `undefined` when it is not exactly what `encodeSwapThenCall` would produce for
     * them (another function or call layout, or any argument the params do not carry differs) — so
     * the returned params describe every effect of the transaction.
     */
    decodeSwapThenCall(transactionData: Hex): SwapThenCallParams<TAddress> | undefined;

    /**
     * Whether `transactionData` calls an entry point of the aggregator's swap executor (on EVM:
     * LiFi's `Executor.swapAndExecute` or `swapAndCompleteBridgeTokens`), whatever its target.
     * The executor runs arbitrary calls, so a byte-embedded deposit proves nothing about where
     * such a transaction sends the funds.
     */
    isSwapExecutorCall(transactionData: Hex): boolean;

    /**
     * Whether `address` is an aggregator swap executor: a contract that runs arbitrary calls for
     * anyone, so any allowance granted to it, or balance left in it, can be taken by anyone. A
     * user must never approve it. Rejects when the check cannot be completed (e.g. an RPC failure)
     * rather than resolving `false`, so callers fail closed.
     */
    isSwapExecutor(address: TAddress): Promise<boolean>;
}
