import type { ZodType } from "zod";

import type {
    Address,
    EVMProof,
    Hash,
    Hex,
    ILogger,
    INoteManager,
    IPoolVaultInteractor,
    PendingNote,
    PreparedTransaction,
    TxLog,
} from "../internal.js";

/**
 * Configuration for PoolSessionNoteManager construction, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and
 * raw receipt-log type `TLog`.
 */
export interface PoolSessionNoteManagerConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    noteManager: INoteManager<TAddress>;
    /** Used to resolve `createdAtBlock` on-chain — witness-critical, must come from the chain. */
    poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    /** Validates `tokenId`/`ownerAddress`-shaped fields against the chain's real address shape. */
    addressSchema: ZodType<TAddress>;
}

export interface PoolSessionNoteManagerDependencies {
    logger?: ILogger;
}

/** Single entry of {@link IPoolSessionNoteManager.addNotes}, generic over the chain's address type `TAddress`. */
export interface AddNoteParams<TAddress = Address> {
    /** From a `prepare*` result. Must have `isOwned === true`. */
    pendingNote: PendingNote<TAddress>;
    /** Hash of the externally-broadcast transaction that created the commitment on-chain. */
    txHash: Hash;
}

/** Single entry of {@link IPoolSessionNoteManager.markNotesSpent}. */
export interface MarkNoteSpentParams {
    commitment: Hash;
    /** Metadata only — recorded as `spentAtBlock`, never hashed into a witness. Caller supplies from the broadcast receipt to avoid an extra RPC. */
    spentAtBlock: Hex;
}

/** Single entry of {@link IPoolSessionNoteManager.markNotesExited}. */
export interface MarkNoteExitedParams {
    commitment: Hash;
    /** Metadata only — recorded as `spentAtBlock` (NoteManager reuses the field for terminal states). Never hashed into a witness. */
    exitedAtBlock: Hex;
}
