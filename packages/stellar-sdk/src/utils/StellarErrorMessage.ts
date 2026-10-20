/**
 * Extracts a human-readable message from an error thrown by `@stellar/stellar-sdk`'s `rpc.Server`
 * (or anything else in the Stellar call stack). Unlike viem (EVM), `stellar-sdk`'s RPC client
 * frequently rejects with a plain JSON-RPC error object (`{code, message}`), not an `Error`
 * instance — a naive `error instanceof Error ? error.message : String(error)` check (the pattern
 * used throughout the EVM side, where every thrown value genuinely is an `Error`) stringifies
 * that plain object to the unhelpful `"[object Object]"` instead of surfacing its real message,
 * verified live against a real "startLedger must be within the ledger range" RPC rejection.
 */
export function stellarErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { message: unknown }).message === "string"
    ) {
        return (error as { message: string }).message;
    }
    return String(error);
}
