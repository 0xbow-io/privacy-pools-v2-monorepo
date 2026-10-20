import { isAddress, toFunctionSelector } from "viem";

import type { Address, Hex } from "../internal.js";
import { LIFI_EXECUTOR_SCREENING_ABI, LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI, LIFI_SWAP_EXECUTORS } from "../internal.js";

/**
 * Selectors of the Executor's two entry points, `swapAndExecute` and `swapAndCompleteBridgeTokens`,
 * and every configured LiFi Executor (lowercased, across chains). Built on first use: the
 * constants come through the barrel, which is not initialised yet when this module loads.
 */
let screening: { selectors: Set<string>; executors: Set<string> } | undefined;
function lifiExecutorScreening(): { selectors: Set<string>; executors: Set<string> } {
    screening ??= {
        selectors: new Set([
            toFunctionSelector(LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI[0]),
            toFunctionSelector(LIFI_EXECUTOR_SCREENING_ABI[0]),
        ]),
        executors: new Set(Object.values(LIFI_SWAP_EXECUTORS).map(({ executor }) => executor.toLowerCase())),
    };
    return screening;
}

/**
 * viem's errors for an `erc20Proxy()` call the chain answered without an address: a revert, with or
 * without data, or an empty return (no code at the address).
 */
const ERC20_PROXY_REVERT_NAMES = new Set([
    "ContractFunctionRevertedError",
    "ExecutionRevertedError",
    "ContractFunctionZeroDataError",
]);

/** Matched by name through `cause`: reads may be wrapped in ContractReadError or come from another viem copy. */
function isErc20ProxyRevert(error: unknown): boolean {
    let current: unknown = error;
    while (current instanceof Error) {
        if (ERC20_PROXY_REVERT_NAMES.has(current.name)) return true;
        current = current.cause;
    }
    return false;
}

/**
 * Whether `transactionData` calls one of LiFi Executor's entry points, whatever contract it targets.
 * The Executor runs arbitrary calls for anyone, so such a transaction can move funds anywhere.
 */
export function isLiFiExecutorCall(transactionData: Hex): boolean {
    return lifiExecutorScreening().selectors.has(transactionData.slice(0, 10).toLowerCase());
}

/**
 * Whether `address` is a LiFi Executor: any one in {@link LIFI_SWAP_EXECUTORS}, on any chain, or any
 * contract answering `erc20Proxy()` with a non-zero address (how every Executor version identifies
 * itself; the Diamond and the ERC20Proxy revert on it). Any allowance granted to it, or balance left
 * in it, can be taken by anyone. An `erc20Proxy()` revert or empty return means "not an executor";
 * any other read failure (transport, RPC, decoding) is rethrown so screening fails closed rather
 * than passing an unlisted Executor.
 *
 * @param readErc20Proxy - Reads `erc20Proxy()` on `address` (abi: {@link LIFI_EXECUTOR_SCREENING_ABI}).
 * @throws On read failures other than an `erc20Proxy()` revert or empty return.
 */
export async function isLiFiExecutor(
    address: Address,
    readErc20Proxy: (address: Address) => Promise<unknown>,
): Promise<boolean> {
    if (lifiExecutorScreening().executors.has(address.toLowerCase())) return true;
    try {
        const proxy = await readErc20Proxy(address);
        return typeof proxy === "string" && isAddress(proxy) && BigInt(proxy) !== 0n;
    } catch (error) {
        if (isErc20ProxyRevert(error)) return false;
        throw error;
    }
}
