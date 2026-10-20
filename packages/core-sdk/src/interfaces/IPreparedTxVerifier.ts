import type { Address, PreparedTransaction } from "../internal.js";

/**
 * The set of prepared-transaction shapes the SDK verifies before handing calldata to a wallet
 * for signing. An opaque identifier rather than a concrete ABI/function-name pair — each chain's
 * {@link IPreparedTxVerifier} implementation owns the mapping from operation to its own
 * chain-specific decode logic.
 */
export type PreparedTxOperation =
    | "deposit"
    | "approve"
    | "ragequit"
    | "transact"
    | "relayBatch"
    | "setAuthPolicy"
    | "setViewingKey"
    | "updateAuthPolicy";

/** The result of a successful {@link IPreparedTxVerifier.assertMatches} check. */
export interface PreparedTxVerification {
    /** The verified operation (echoes `expected.operation`). */
    operation: PreparedTxOperation;
    /** The decoded call arguments, for callers that need to inspect them further. */
    args: readonly unknown[];
}

/**
 * Verifies a prepared transaction targets the expected contract and calls the expected
 * operation before it is handed to a wallet for signing, generic over the chain's
 * prepared-transaction type `TTx` and address type `TAddress`. Chains differ enough here (ABI
 * decode vs. XDR/ScVal decode) that there is no shared implementation between chains — a plain
 * interface with one independent implementation per chain, matching {@link IContextHashService}
 * and {@link IPayoutRoutingCodec}.
 */
export interface IPreparedTxVerifier<TTx = PreparedTransaction, TAddress = Address> {
    /**
     * Asserts `tx` targets `expected.to` and invokes `expected.operation`.
     *
     * @param tx - The prepared transaction to verify.
     * @param expected - The contract address and operation the transaction must match.
     * @returns The verified operation and decoded call arguments.
     * @throws {UnexpectedTransactionTarget} If the transaction does not match.
     */
    assertMatches(
        tx: TTx,
        expected: { to: TAddress; operation: PreparedTxOperation },
    ): PreparedTxVerification;
}
