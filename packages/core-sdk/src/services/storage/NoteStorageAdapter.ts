import type {
    Address,
    INoteStorageAdapter,
    IStorageService,
    NoteManagerState,
} from "../../internal.js";
import { InvalidStorageStateError, NoteManagerStateSchema, STORAGE_KEYS } from "../../internal.js";

/**
 * Domain-specific storage adapter for NoteManager.
 * Wraps IStorageService with typed methods, hiding raw storage key details.
 *
 * Storage key includes `ownerAddress` so multi-account sessions sharing a
 * single storage backend never collide on a chain-only key (paired fix
 * with the PaymentRequest adapter; see M-5 line 536 / L-17 line 3231).
 */
export class NoteStorageAdapter implements INoteStorageAdapter {
    private readonly version = "v1";
    private readonly key: string;
    private readonly defaultState: NoteManagerState = {
        notes: [],
        syncCursor: "0x0",
    };
    constructor(
        private readonly chainId: number,
        private readonly storage: IStorageService,
        private readonly ownerAddress: Address,
    ) {
        const owner = ownerAddress.toLowerCase();
        this.key = `${this.version}:${STORAGE_KEYS.NOTE_MANAGER_STATE}:${this.chainId}:${owner}`;
    }

    // -------------------------------------------------------------------------
    // Full-state operations
    // -------------------------------------------------------------------------

    /** @inheritdoc INoteStorageAdapter.saveState */
    async saveState(state: NoteManagerState): Promise<void> {
        return await this.storage.set(this.key, state);
    }

    /**
     * @inheritdoc INoteStorageAdapter.getState
     * @throws {InvalidStorageStateError} If persisted data fails schema validation.
     */
    async getState(): Promise<NoteManagerState | null> {
        const raw = await this.storage.get<unknown>(this.key);
        if (raw === null) return null;

        const result = NoteManagerStateSchema.safeParse(raw);
        if (!result.success) throw new InvalidStorageStateError(this.key);

        return result.data;
    }

    /** @inheritdoc INoteStorageAdapter.clearState */
    async clearState(): Promise<void> {
        return await this.storage.delete(this.key);
    }
}
