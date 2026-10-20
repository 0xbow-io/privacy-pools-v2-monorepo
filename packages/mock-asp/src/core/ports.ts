import type { Hex } from "@privacy-pools-v2/core-sdk";

/**
 * Identifies the pool deployment this ASP serves. Requests whose `chainId` / `entrypoint`
 * do not match are rejected, so tests can prove `HttpASPDataProvider` scopes its calls.
 */
export interface ChainScope {
    /** Chain id as it appears in `/{chainId}/public/...` paths and `?chainId=` queries. */
    chainId: number;
    /** Entrypoint address the ASP is scoped to. When omitted, the `entrypoint` query is not enforced. */
    entrypoint?: string;
}

/**
 * The chain-specific "write" side: publishes an association-set root on-chain.
 * Implementations must resolve only once the publication is confirmed, so the next read
 * through the SDK always sees the freshly published root.
 */
export interface AspRootPublisher {
    /**
     * Publishes `root` (with a placeholder content id) to the chain's ASP registry.
     *
     * @param root - The association-set root.
     * @param cid - Opaque content id the registry requires to be non-empty.
     * @returns An identifier for the confirmed publication (a tx hash on EVM).
     */
    publishRoot(root: bigint, cid: Hex): Promise<{ txId: string }>;

    /**
     * Reads the latest root the registry holds, or `null` when none has been published yet.
     * Optional — used only to seed the served root on startup.
     */
    readLatestRoot?(): Promise<bigint | null>;
}

/** One `Note` event as it appears on the ASP wire (mirrors core-sdk's `NoteEventSchema`). */
export interface WireNoteEvent {
    /** Decimal string. */
    blockNumber: string;
    txHash: Hex;
    hint: Hex;
    ephemeralPubKey: Hex;
    encryptedPayload: Hex;
}

/** The `/{chainId}/public/note-events` response body. */
export interface WireNoteEventsPage {
    events: WireNoteEvent[];
    /** Highest block the source has indexed. */
    lastSyncedBlock: Hex;
}

/**
 * The `/{chainId}/public/event-snapshot/payload` body. Kept structurally open here: the
 * exact shape is owned by core-sdk's `EventSnapshot` schema, which the client validates.
 */
export type WireEventSnapshot = Record<string, unknown>;

/**
 * The chain-specific "read" side: serves indexed chain events. Every method is optional — a source
 * implements only what it can serve, and an endpoint it does not implement answers `501`, which
 * keeps the SDK's on-chain fallback testable.
 */
export interface AspChainEventSource {
    /**
     * @param range - Inclusive block range; either bound may be omitted.
     * @returns The events in range plus the highest block indexed.
     */
    getNoteEvents?(range: { since?: bigint; until?: bigint }): Promise<WireNoteEventsPage>;

    /** @returns A snapshot of deposits/transacts/ragequits/leaves up to a block. */
    getEventSnapshot?(): Promise<WireEventSnapshot>;
}
