/** Base error class for all StorageAdapter-related errors. */
export class StorageAdapterBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "StorageAdapterBaseError";
    }
}

/** Thrown by LocalStorageService when the storage quota is exceeded. */
export class StorageQuotaError extends StorageAdapterBaseError {
    /** @param key - The key that triggered the quota error. */
    constructor(key: string) {
        super(`Storage quota exceeded while writing key: ${key}`);
        this.name = "StorageQuotaError";
    }
}

/** Thrown when persisted storage data fails schema validation. */
export class InvalidStorageStateError extends StorageAdapterBaseError {
    /** @param key - The storage key whose value failed validation. */
    constructor(key: string) {
        super(`Persisted state at key "${key}" failed schema validation`);
        this.name = "InvalidStorageStateError";
    }
}

/**
 * Thrown when a FileStorageService filename is not a bare basename. The filename is interpolated
 * into a filesystem path, so a value with a path separator or `..` could escape the configured
 * directory and read or overwrite arbitrary host files.
 */
export class InvalidStorageFilename extends StorageAdapterBaseError {
    /** @param filename - The rejected filename. */
    constructor(filename: string) {
        super(
            `Invalid storage filename "${filename}": must contain only [A-Za-z0-9._-] and not be dots-only`,
        );
        this.name = "InvalidStorageFilename";
    }
}

/**
 * Thrown when a store file will not parse AND could not be moved aside. Reporting the
 * store as empty is only safe once the existing bytes are preserved: every mutating
 * method writes back exactly what the read returned, so an "empty" answer over a file
 * still in place is what turns one unreadable store into an erased one.
 */
export class UnreadableStorageFile extends StorageAdapterBaseError {
    /**
     * @param filePath - The store file that could neither be parsed nor preserved.
     * @param reason - Why preserving it failed.
     */
    constructor(filePath: string, reason: string) {
        super(`Storage file "${filePath}" is unparseable and could not be set aside: ${reason}`);
        this.name = "UnreadableStorageFile";
    }
}
