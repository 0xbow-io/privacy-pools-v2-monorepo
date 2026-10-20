/** Base error class for all PoolSessionExport-related errors. */
export class PoolSessionExportBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "PoolSessionExportBaseError";
    }
}

/**
 * Thrown when an account export is imported into a session it does not belong to.
 *
 * The export envelope carries the owner address and chain id it was produced
 * for. Importing a blob from a different account or chain would load another
 * recipient's note secrets and payment-request secrets into this session, so
 * `importAccount` rejects the mismatch instead of restoring it.
 */
export class AccountExportMismatch extends PoolSessionExportBaseError {
    /**
     * @param field - Which envelope field disagreed: `owner` or `chainId`.
     * @param expected - Value the live session has.
     * @param actual - Value carried by the imported export.
     */
    constructor(field: "owner" | "chainId", expected: string, actual: string) {
        super(`Account export ${field} mismatch: session has ${expected}, export has ${actual}`);
        this.name = "AccountExportMismatch";
    }
}
