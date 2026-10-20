// ILogger / Hex are chain-agnostic and live in core-sdk now (not stellar-sdk's own
// interfaces/types) — imported directly from the dependency's package entry, matching evm-sdk's
// identical types/RPCInteractor.ts precedent.
import type { Hex, ILogger } from "@privacy-pools-v2/core-sdk";

/**
 * A raw Soroban contract event, undecoded — matches `IStellarRPCInteractor.getEvents`'s output.
 * Mirrors EVM's {@link TxLog} role (raw, chain-native, decoded later by domain-specific code —
 * `EventService.parseEvent`'s own choice in the reference implementation too), except topics/data stay as
 * base64-encoded ScVal XDR strings rather than `Hex` — that's Soroban's own wire representation
 * for these values, not a hex-encoded byte string, so forcing them into `Hex`'s `0x`-prefix shape
 * would misrepresent the encoding.
 */
export interface StellarLog {
    /** Soroban event ID (ledger/tx/event-index composite, e.g. `"0000001234-0000000001"`). */
    id: string;
    /** The decoded event-name Symbol (e.g. `"Transacted"`, `"LeafInserted"`). */
    type: string;
    /** Ledger sequence in which the event was emitted (hex-encoded). */
    ledger: Hex;
    /**
     * Wall-clock close time of `ledger`, ISO 8601-encoded (as returned by Soroban RPC) — the
     * same value `env.ledger().timestamp()` reads on-chain (Unix seconds; parse via
     * `Math.floor(Date.parse(ledgerClosedAt) / 1000)`), used to reconstruct a leaf's insertion
     * timestamp from event history since Stellar has no direct storage getter for it (unlike
     * EVM's `PoolVault.commitments(hash)`/`spentNullifiers(hash)`).
     */
    ledgerClosedAt: string;
    /** Contract that emitted the event. */
    contractId: string;
    /** Raw event topics, each a base64-encoded ScVal XDR string (undecoded). */
    topics: string[];
    /** Raw event data, a base64-encoded ScVal XDR string (undecoded). */
    data: string;
    /** Transaction hash that emitted the event. */
    transactionHash: Hex;
}

/** Parameters for {@link IStellarRPCInteractor.getEvents}. */
export interface StellarGetEventsParams {
    /** The contract to fetch events for. */
    contractId: string;
    /** First page only: ledger to start scanning from. Mutually exclusive with `cursor`. */
    startLedger?: Hex;
    /** Subsequent pages: an opaque cursor from a prior result. Mutually exclusive with `startLedger`. */
    cursor?: string;
    /** Max events per RPC page (server-capped at 100 either way; paginated internally to exhaustion). */
    limit?: number;
}

/** Result of {@link IStellarRPCInteractor.getEvents} — already paginated to exhaustion. */
export interface StellarGetEventsResult {
    /** Every event in the requested range, in chronological order. */
    events: StellarLog[];
    /** Ledger sequence the RPC node considered "latest" as of this call. */
    latestLedger: Hex;
    /** Cursor to resume from for a later fetch, chronologically after the last returned event. */
    cursor?: string;
}

/** A Soroban account's current sequence number — the minimum needed to build a new transaction. */
export interface StellarAccountInfo {
    /** The account's StrKey public key (`"G..."`). */
    publicKey: string;
    /** Current sequence number, as a decimal string (matches stellar-sdk's own `Account` shape). */
    sequence: string;
}

/** Configuration for {@link SorobanRPCInteractor}. */
export interface SorobanRPCInteractorConfig {
    /** The Soroban RPC endpoint URL. */
    rpcUrl: string;
    /** The network passphrase (e.g. `Networks.TESTNET`) transactions are built/submitted against. */
    networkPassphrase: string;
    /**
     * How often `waitForTransactionReceipt` re-checks a submitted transaction, in ms. Default 2000;
     * a local standalone network closes ledgers about every second, so a shorter interval returns sooner.
     */
    receiptPollIntervalMs?: number;
}

/** Optional dependencies for {@link SorobanRPCInteractor}. */
export interface SorobanRPCInteractorDependencies {
    logger?: ILogger;
}
