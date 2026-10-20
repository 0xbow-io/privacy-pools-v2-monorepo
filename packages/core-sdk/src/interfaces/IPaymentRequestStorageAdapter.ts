import type { PaymentRequestServiceState } from "../internal.js";

/**
 * Domain-specific storage interface for PaymentRequestService state.
 * Wraps IStorageService with typed, named methods.
 * Persists open + fulfilled payment requests as a single atomic state blob.
 */
export interface IPaymentRequestStorageAdapter {
    /**
     * Persists the full PaymentRequestService state atomically.
     * @param state - The service's request list.
     * @throws {StorageAdapterBaseError}
     */
    saveState(state: PaymentRequestServiceState): Promise<void>;

    /**
     * Retrieves the persisted PaymentRequestService state.
     * @returns The stored state, or null if none exists.
     * @throws {StorageAdapterBaseError} On storage errors or if persisted data fails schema validation.
     */
    getState(): Promise<PaymentRequestServiceState | null>;

    /**
     * Removes the persisted PaymentRequestService state.
     * @throws {StorageAdapterBaseError}
     */
    clearState(): Promise<void>;
}
