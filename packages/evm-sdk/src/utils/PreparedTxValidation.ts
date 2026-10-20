import type { Abi } from "viem";
import { decodeFunctionData } from "viem";

import type { Address, PreparedTransaction } from "../internal.js";
import { UnexpectedTransactionTarget } from "../internal.js";

/**
 * Asserts a prepared transaction targets the expected contract and calls the
 * expected function before it is handed to a wallet for signing. Defends the
 * prepare/execute split: an attacker-supplied or tampered `PrepareXResult`
 * could otherwise carry an arbitrary `to` + calldata (e.g. `to: token,
 * data: approve(attacker, MAX)`), and the execute step would sign it blindly.
 *
 * @returns The decoded function name and args. Callers that need argument
 *   values at execute time must read them from this return value, not from
 *   loose result fields — only the calldata has been validated.
 * @throws {UnexpectedTransactionTarget} If `tx.to` differs from `expected.to`
 *   (case-insensitive), the calldata fails to decode against `expected.abi`,
 *   or the decoded function name differs from `expected.functionName`.
 */
export function assertPreparedTxMatches(
    tx: PreparedTransaction,
    expected: { to: Address; abi: Abi; functionName: string },
): { functionName: string; args: readonly unknown[] } {
    if (tx.to.toLowerCase() !== expected.to.toLowerCase()) {
        throw new UnexpectedTransactionTarget(
            `transaction to ${tx.to} does not match expected ${expected.to}`,
        );
    }

    let decoded: { functionName: string; args: readonly unknown[] };
    try {
        const result = decodeFunctionData({ abi: expected.abi, data: tx.data });
        decoded = { functionName: result.functionName, args: result.args ?? [] };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UnexpectedTransactionTarget(
            `failed to decode calldata as "${expected.functionName}": ${message}`,
        );
    }

    if (decoded.functionName !== expected.functionName) {
        throw new UnexpectedTransactionTarget(
            `calldata calls "${decoded.functionName}", expected "${expected.functionName}"`,
        );
    }

    return decoded;
}
