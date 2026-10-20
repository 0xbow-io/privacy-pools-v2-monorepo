import type { Address } from "./Address.js";
import type { Hash } from "./Hash.js";
import type { Hex } from "./Hex.js";

/**
 * Fields typed `| null` below are the ones the SDK's snapshot consumers do not
 * need: rather than discard a whole row (and the state it carries) over one
 * unusable value, per-row validation nulls the field and keeps the row. See
 * `tolerantField` in `schemas/EventSnapshot.ts`. Whatever is *not* nullable is
 * load-bearing — a row that loses one of those is dropped instead.
 *
 * Every `Address` field below stays concretely EVM-typed, not generic over `TAddress`: this is
 * the ASP's own HTTP wire format (`IASPDataProvider.getEventSnapshot`), an external system this
 * SDK does not control. A non-EVM chain needs its own ASP snapshot schema, not a type parameter
 * here.
 */

/**
 * A deposit event from the ASP event snapshot.
 */
export interface SnapshotDeposit {
    /** Transaction hash of the deposit. */
    txHash: Hash | null;
    /** Log index within the transaction. */
    logIndex: number | null;
    /** Address that performed the deposit. */
    depositAddress: Address | null;
    /** Poseidon commitment of the deposited note. */
    outputCommitment: Hex;
    /** Deposited amount in smallest unit. */
    depositedValue: Hex | null;
    /** Fee paid for the deposit. */
    fee: Hex | null;
    /** Block number where the deposit occurred. */
    blockNumber: Hex | null;
    /** ISO-8601 timestamp of the block. */
    blockTimestamp: string | null;
    /** Token address. */
    asset: Address | null;
}

/**
 * A transact event from the ASP event snapshot.
 */
export interface SnapshotTransact {
    /** Transaction hash. */
    txHash: Hash | null;
    /** Log index within the transaction. */
    logIndex: number | null;
    /** Output commitment hashes produced by the transact. */
    outputCommitments: Hex[];
    /** Nullifier hashes consumed by the transact. */
    nullifierHashes: Hex[];
    /** Caller address. */
    caller: Address | null;
    /** Withdrawn value in smallest unit. */
    withdrawnValue: Hex | null;
    /** Encrypted payload for note discovery, or null. */
    encryptedPayload: Hex | null;
    /** Block number, or null if not yet confirmed. */
    blockNumber: Hex | null;
    /** ISO-8601 timestamp of the block. */
    blockTimestamp: string | null;
    /** Token address. */
    asset: Address | null;
}

/**
 * A ragequit event from the ASP event snapshot.
 */
export interface SnapshotRagequit {
    /** Transaction hash. */
    txHash: Hash | null;
    /** Log index within the transaction. */
    logIndex: number | null;
    /** Address of the ragequitter. */
    ragequitter: Address | null;
    /** Withdrawn value in smallest unit. */
    withdrawnValue: Hex | null;
    /** Commitment that was exited. */
    commitment: Hex;
    /** Nullifier hash published. */
    nullifierHash: Hex | null;
    /** Label of the ragequitted note. */
    label: Hex | null;
    /**
     * Block number of the ragequit. NOT nullable, unlike its siblings.
     *
     * Corroboration reads the chain AT this block, so a row without one can never
     * be confirmed. Leaving it nullable here would keep the invariant confined to
     * the HTTP parser: any custom `IASPDataProvider` could still hand back a null,
     * discovery would discard the uncorroborable claim, and `snapshotBlockNumber`
     * would still be trusted as full coverage — so the chain-tail pass could skip
     * the real ragequit indefinitely. A provider that meets a malformed wire value
     * must drop the row and report it in `drops`, which narrows coverage and is
     * what forces the rescan.
     */
    blockNumber: Hex;
    /** ISO-8601 timestamp. */
    blockTimestamp: string | null;
    /** Token address. */
    asset: Address | null;
}

/**
 * A leaf event from the ASP event snapshot.
 */
export interface SnapshotLeaf {
    /** The leaf value. */
    leaf: Hex | null;
    /** Index of the leaf in the tree. */
    leafIndex: Hex | null;
    /** Merkle root after insertion. */
    root: Hash | null;
    /** Block number of the insertion. */
    blockNumber: Hex | null;
    /** ISO-8601 timestamp. */
    blockTimestamp: string | null;
    /** Type of leaf event. */
    eventType: string | null;
}

/** The row arrays carried by an {@link EventSnapshot}. */
export type SnapshotArrayName =
    | "deposits"
    | "transacts"
    | "ragequits"
    | "leaves"
    | "keystoreLeaves";

/**
 * What per-row validation discarded from one snapshot array.
 *
 * A dropped row is *missing* state, not absent state: a consumer that keeps
 * treating `snapshotBlockNumber` as fully covered would skip the very range
 * whose row was lost. `earliestDroppedBlock` is what lets the consumer pull its
 * coverage back to just below the first gap instead of distrusting everything.
 */
export interface SnapshotArrayDrops {
    /** Number of rows dropped from this array. */
    dropped: number;
    /**
     * Lowest `blockNumber` among the dropped rows, or `null` when at least one
     * dropped row's own `blockNumber` was unusable — the array then has a gap at
     * an unknown height and no part of it can be treated as covered.
     */
    earliestDroppedBlock: Hex | null;
}

/** Per-array drop record, present only for arrays that lost at least one row. */
export type EventSnapshotDrops = Partial<Record<SnapshotArrayName, SnapshotArrayDrops>>;

/**
 * Full event snapshot response from the ASP endpoint.
 */
export interface EventSnapshot {
    /** Chain ID the snapshot belongs to. */
    chainId: Hex;
    /** Block number up to which the snapshot is valid. */
    snapshotBlockNumber: Hex;
    /** ISO-8601 timestamp when the snapshot was generated. */
    generatedAt: string;
    /** All deposit events. */
    deposits: SnapshotDeposit[];
    /** All transact events. */
    transacts: SnapshotTransact[];
    /** All ragequit events. */
    ragequits: SnapshotRagequit[];
    /** Pool vault leaves. */
    leaves: SnapshotLeaf[];
    /** Keystore leaves. */
    keystoreLeaves: SnapshotLeaf[];
    /**
     * Set only when per-row validation dropped malformed rows. Absent means the
     * payload validated in full and `snapshotBlockNumber` is covered end to end.
     */
    drops?: EventSnapshotDrops;
}
