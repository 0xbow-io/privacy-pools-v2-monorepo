import type {
    Address,
    IPaymentRequestStorageAdapter,
    IStorageService,
    PaymentRequestServiceState,
} from "../../internal.js";
import {
    InvalidStorageStateError,
    PaymentRequestServiceStateSchema,
    STORAGE_KEYS,
} from "../../internal.js";

/**
 * Domain-specific storage adapter for PaymentRequestService.
 * Wraps IStorageService with typed methods, hiding raw storage key details.
 *
 * Storage key includes `ownerAddress` so multiple sessions on the same chain
 * (multi-account browser tab, shared FileStorageService backend) don't
 * collide on a chain-only key. Without owner-scoping, last-writer-wins
 * overwrites previously-persisted state and can destroy the ephemeral
 * `paymentPrivKey` / `noteSecretsMap` needed to decrypt incoming
 * payment-request notes — funds effectively frozen.
 */
export class PaymentRequestStorageAdapter implements IPaymentRequestStorageAdapter {
    private readonly version = "v1";
    private readonly key: string;

    constructor(
        chainId: number,
        private readonly storage: IStorageService,
        ownerAddress: Address,
    ) {
        const owner = ownerAddress.toLowerCase();
        this.key = `${this.version}:${STORAGE_KEYS.PAYMENT_REQUEST_STATE}:${chainId}:${owner}`;
    }

    /** @inheritdoc IPaymentRequestStorageAdapter.saveState */
    async saveState(state: PaymentRequestServiceState): Promise<void> {
        // Map serializes to `{}` under JSON.stringify, so JSON-backed
        // backends (LocalStorage, FileStorage) would silently drop every
        // noteSecretsMap entry. Convert Maps to array-of-entries before
        // persisting; the schema codec accepts that shape on load.
        const serialized = {
            ...state,
            requests: state.requests.map((r) => ({
                ...r,
                noteSecretsMap: Array.from(r.noteSecretsMap.entries()),
            })),
        };
        return await this.storage.set(this.key, serialized);
    }

    /**
     * @inheritdoc IPaymentRequestStorageAdapter.getState
     * @throws {InvalidStorageStateError} If persisted data fails schema validation.
     */
    async getState(): Promise<PaymentRequestServiceState | null> {
        const raw = await this.storage.get<unknown>(this.key);
        if (raw === null) return null;

        const result = PaymentRequestServiceStateSchema.safeParse(raw);
        if (!result.success) throw new InvalidStorageStateError(this.key);

        return result.data;
    }

    /** @inheritdoc IPaymentRequestStorageAdapter.clearState */
    async clearState(): Promise<void> {
        return await this.storage.delete(this.key);
    }
}
