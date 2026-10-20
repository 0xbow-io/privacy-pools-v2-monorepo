/** Base error class for PoolSession leaf-cache export errors. */
export class PoolSessionLeafCacheBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "PoolSessionLeafCacheBaseError";
    }
}
