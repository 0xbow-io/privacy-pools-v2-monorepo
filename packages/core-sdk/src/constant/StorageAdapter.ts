/**
 * Storage keys used by NoteStorageAdapter when persisting state via IStorageService.
 * Consumers must use these constants — never raw strings.
 */
export const STORAGE_KEYS = {
    /** Key for persisting the full NoteManager state (notes + syncCursor). */
    NOTE_MANAGER_STATE: "note-manager-state",
    /** Key for persisting the full PaymentRequestService state (open + fulfilled requests). */
    PAYMENT_REQUEST_STATE: "payment-request-state",
} as const;

/**
 * One path segment, not dots-only. The name is interpolated into `{dirPath}/{filename}.json`, so
 * a separator or `..` could escape dirPath; `.`/`..` are contained only by the `.json` suffix.
 * Enforced in PersistentStorageConfigSchema and the FileStorageService constructor (direct
 * construction bypasses the builder).
 */
export const SAFE_STORAGE_FILENAME_PATTERN = /^(?!\.+$)[A-Za-z0-9._-]+$/;
