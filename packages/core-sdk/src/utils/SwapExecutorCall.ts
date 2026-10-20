import type {
    Hex,
    IAddressEqualityComparator,
    ISwapChainAdapter,
    ISwapQuoteProvider,
    SwapExecutorAddresses,
    SwapQuoteResult,
    SwapThenCallParams,
} from "../internal.js";
import { SwapQuoteMismatch, UnexpectedTransactionTarget } from "../internal.js";

/**
 * Slippage the composed executor swap is quoted with: the aggregator's same-chain default, passed
 * explicitly so the output padding below always matches the floor the provider applies.
 */
export const EXECUTOR_SWAP_SLIPPAGE_BPS = 50n;
/** Output padding beyond that slippage, absorbing rounding in the provider's `toAmountMin`. */
export const EXECUTOR_SWAP_OUTPUT_MARGIN_BPS = 10n;

/**
 * What every session that composes or vets an executor swap-then-call shares: the chain adapter,
 * the executor and its proxy, and the allowlist check of the caller's own chain.
 */
export interface ExecutorCallContext<TTx, TAddress> {
    swapChainAdapter: ISwapChainAdapter<TTx, TAddress>;
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    executor: SwapExecutorAddresses<TAddress>;
    nativeAssetAddress: TAddress;
    chainId: number;
    /**
     * Rejects an address that is not in RelaySwaps.approvedRouters.
     *
     * @throws {UnallowedLiFiAddress} If the address is not approved.
     */
    assertAllowed(address: TAddress, role: string): Promise<void>;
}

/** The composition {@link composeExecutorSwapThenCall} built, and the values it pinned. */
export interface ComposedExecutorCall<TAddress> {
    transactionData: Hex;
    inputAmount: bigint;
    callValue: bigint;
    /** The transaction's own value: the input amount for a native input, else 0. */
    msgValue: bigint;
    quote: SwapQuoteResult<TAddress>;
}

/**
 * Every argument of an executor swap-then-call, each pinned to an explicit expected value.
 * `call` is the exact deposit call when its calldata is in scope, else the set of targets it may
 * hit (the proof binds the calldata). `msgValue` is the transaction's own value when the caller
 * signs it (expected: the input amount for a native input, else 0); omitted when another contract
 * submits the call and sets its value.
 */
export interface ExecutorCallExpectations<TAddress> {
    receiver: TAddress;
    inputToken: TAddress;
    inputAmount: bigint;
    outputToken: TAddress;
    call: { target: TAddress; data: Hex } | { targets: TAddress[] };
    callValue: bigint;
    msgValue?: bigint;
}

/**
 * Quotes an ordinary exact-out swap of `inputToken` into `outputToken` paid to the executor, and
 * composes the one executor call that runs it unchanged, then the deposit call handed exactly
 * what it consumes: its own value for the native coin, `totalDepositCost` as an executor approval
 * for an ERC-20 (whose call must then carry no value). The target is that amount grossed up for
 * the quote's slippage plus a margin; the guaranteed minimum must still cover it. Leftovers go to
 * `receiver`.
 *
 * @param refuse - Throws the caller's own error for a composition that cannot be built.
 * @throws {SwapQuoteMismatch} If the quote routes different tokens or chains than requested.
 * @throws {UnallowedLiFiAddress} If the swap's target or approval address is not allowlisted.
 */
export async function composeExecutorSwapThenCall<TTx, TAddress>(
    ctx: ExecutorCallContext<TTx, TAddress>,
    swapQuoteProvider: ISwapQuoteProvider<TAddress>,
    args: {
        inputToken: TAddress;
        outputToken: TAddress;
        callTarget: TAddress;
        callData: Hex;
        /** The deposit call's own native value. */
        depositValue: bigint;
        totalDepositCost: bigint;
        receiver: TAddress;
    },
    refuse: (reason: string) => never,
): Promise<ComposedExecutorCall<TAddress>> {
    const { swapChainAdapter: adapter, executor } = ctx;
    if (adapter.isSameToken(args.inputToken, args.outputToken)) {
        return refuse("the input is already the token the deposit needs");
    }
    const nativeInput = adapter.isSameToken(args.inputToken, ctx.nativeAssetAddress);
    const nativeOutput = adapter.isSameToken(args.outputToken, ctx.nativeAssetAddress);
    if (nativeOutput ? args.depositValue === 0n : args.depositValue !== 0n) {
        return refuse(
            nativeOutput
                ? "a native-coin deposit call carries no value"
                : "an ERC-20 deposit call carries native value",
        );
    }
    const callValue = nativeOutput ? args.depositValue : args.totalDepositCost;
    if (callValue === 0n) {
        return refuse("the deposit consumes nothing");
    }

    const floorBps = 10_000n - EXECUTOR_SWAP_SLIPPAGE_BPS - EXECUTOR_SWAP_OUTPUT_MARGIN_BPS;
    const target = (callValue * 10_000n + floorBps - 1n) / floorBps;
    const quote = await swapQuoteProvider.getSwapQuote({
        fromChainId: ctx.chainId,
        toChainId: ctx.chainId,
        fromToken: args.inputToken,
        toToken: args.outputToken,
        fromAddress: executor.executor,
        toAddress: executor.executor,
        amount: target.toString(),
        amountType: "to",
        slippage: Number(EXECUTOR_SWAP_SLIPPAGE_BPS) / 10_000,
    });
    assertExecutorSwapQuoteRouted(adapter, quote, {
        fromToken: args.inputToken,
        toToken: args.outputToken,
        chainId: ctx.chainId,
    });
    if (BigInt(quote.toAmountMin) < callValue) {
        return refuse(`the swap guarantees only ${quote.toAmountMin} of ${callValue}`);
    }
    if (!adapter.isAddressEmbeddedInCalldata(quote.transactionData, executor.executor)) {
        return refuse("the swap does not pay the executor");
    }
    await ctx.assertAllowed(quote.transactionTo, "swap transactionTo");
    await ctx.assertAllowed(quote.approvalAddress, "swap approvalAddress");

    const inputAmount = BigInt(quote.fromAmount);
    const transactionData = adapter.encodeSwapThenCall({
        swapTarget: quote.transactionTo,
        swapApprovalAddress: quote.approvalAddress,
        swapCallData: quote.transactionData,
        inputToken: args.inputToken,
        inputAmount,
        outputToken: args.outputToken,
        callTarget: args.callTarget,
        callData: args.callData,
        callValue,
        receiver: args.receiver,
    });
    return { transactionData, inputAmount, callValue, msgValue: nativeInput ? inputAmount : 0n, quote };
}

/**
 * The one validation of an executor transaction, shared by every session that signs or relays
 * one: it must be the executor called through its proxy, and its decoded swap-then-call must
 * match `expected` field by field, every value exactly. The swap leg must pay the executor, must
 * not itself call or approve an executor, and must be allowlisted.
 *
 * @throws {UnexpectedTransactionTarget} If any field differs from its expected value.
 * @throws {UnallowedLiFiAddress} If the swap leg's target or approval is not allowlisted.
 */
export async function assertExecutorCallMatches<TTx, TAddress>(
    ctx: ExecutorCallContext<TTx, TAddress>,
    tx: { transactionTo: TAddress; approvalAddress: TAddress; transactionData: Hex },
    expected: ExecutorCallExpectations<TAddress>,
): Promise<SwapThenCallParams<TAddress>> {
    const { swapChainAdapter: adapter, addressEqualityComparator: eq, executor } = ctx;
    const fail = (reason: string): never => {
        throw new UnexpectedTransactionTarget(`executor call: ${reason}`);
    };
    if (!eq.equals(tx.transactionTo, executor.executor)) {
        return fail(`target ${String(tx.transactionTo)} is not the executor`);
    }
    if (!eq.equals(tx.approvalAddress, executor.erc20Proxy)) {
        return fail(`approval address ${String(tx.approvalAddress)} is not the executor's ERC20Proxy ${String(executor.erc20Proxy)}`);
    }
    const decoded = adapter.decodeSwapThenCall(tx.transactionData);
    if (!decoded) {
        return fail("calldata is not a swap-then-call with the expected layout");
    }
    if (!eq.equals(decoded.receiver, expected.receiver)) {
        return fail(`receiver ${String(decoded.receiver)} is not ${String(expected.receiver)}`);
    }
    if (!adapter.isSameToken(decoded.inputToken, expected.inputToken) || decoded.inputAmount !== expected.inputAmount) {
        return fail(
            `input ${String(decoded.inputToken)} / ${decoded.inputAmount} is not ${String(expected.inputToken)} / ${expected.inputAmount}`,
        );
    }
    if (!adapter.isSameToken(decoded.outputToken, expected.outputToken)) {
        return fail(`output ${String(decoded.outputToken)} is not ${String(expected.outputToken)}`);
    }
    if ("target" in expected.call) {
        if (
            !eq.equals(decoded.callTarget, expected.call.target) ||
            decoded.callData.toLowerCase() !== expected.call.data.toLowerCase()
        ) {
            return fail(`deposit call to ${String(decoded.callTarget)} is not the validated deposit to ${String(expected.call.target)}`);
        }
    } else if (!expected.call.targets.some((t) => eq.equals(decoded.callTarget, t))) {
        return fail(`deposit call target ${String(decoded.callTarget)} is not an expected deposit target`);
    }
    if (decoded.callValue !== expected.callValue) {
        return fail(`deposit call is handed ${decoded.callValue}, expected exactly ${expected.callValue}`);
    }
    if (expected.msgValue !== undefined) {
        const nativeInput = adapter.isSameToken(decoded.inputToken, ctx.nativeAssetAddress);
        const expectedMsgValue = nativeInput ? decoded.inputAmount : 0n;
        if (expected.msgValue !== expectedMsgValue) {
            return fail(`transaction must carry ${expectedMsgValue} native value, got ${expected.msgValue}`);
        }
    }
    if (!adapter.isAddressEmbeddedInCalldata(decoded.swapCallData, executor.executor)) {
        return fail(`swap leg does not pay ${String(executor.executor)}`);
    }
    if (
        adapter.isSwapExecutorCall(decoded.swapCallData) ||
        (await adapter.isSwapExecutor(decoded.swapTarget)) ||
        (await adapter.isSwapExecutor(decoded.swapApprovalAddress))
    ) {
        return fail("swap leg must not itself call or approve a swap executor");
    }
    await ctx.assertAllowed(decoded.swapTarget, "executor swap target");
    await ctx.assertAllowed(decoded.swapApprovalAddress, "executor swap approvalAddress");
    return decoded;
}

/**
 * Asserts a same-chain swap quote routed the tokens and chain requested.
 *
 * @throws {SwapQuoteMismatch} If any routed field differs.
 */
function assertExecutorSwapQuoteRouted<TTx, TAddress>(
    adapter: ISwapChainAdapter<TTx, TAddress>,
    quote: SwapQuoteResult<TAddress>,
    expected: { fromToken: TAddress; toToken: TAddress; chainId: number },
): void {
    if (!adapter.isSameToken(quote.fromTokenAddress, expected.fromToken)) {
        throw new SwapQuoteMismatch("fromToken", String(expected.fromToken), String(quote.fromTokenAddress));
    }
    if (!adapter.isSameToken(quote.toTokenAddress, expected.toToken)) {
        throw new SwapQuoteMismatch("toToken", String(expected.toToken), String(quote.toTokenAddress));
    }
    if (quote.fromChainId !== expected.chainId) {
        throw new SwapQuoteMismatch("fromChainId", String(expected.chainId), String(quote.fromChainId));
    }
    if (quote.toChainId !== expected.chainId) {
        throw new SwapQuoteMismatch("toChainId", String(expected.chainId), String(quote.toChainId));
    }
}
