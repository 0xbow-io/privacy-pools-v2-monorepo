import type { ZodType } from "zod";

import type { ILogger, INoteStorageAdapter } from "../internal.js";
import { Address } from "./Address.js";
import { Hash } from "./Hash.js";
import { Hex } from "./Hex.js";
import { Label } from "./Label.js";
import { Note } from "./Note.js";
import { NoteStatus } from "./NoteStatus.js";
import { Secret } from "./Secret.js";

/**
 * Configuration options for NoteManager, generic over the chain's address type `TAddress`.
 */
export interface NoteManagerConfig<TAddress = Address> {
    /**
     * Validates `tokenId`/`ownerAddress`-shaped fields against the chain's real address shape.
     * Defaults to the EVM-shaped `AddressSchema` when omitted, so existing EVM call sites that
     * pass `{}` are unaffected.
     */
    addressSchema?: ZodType<TAddress>;
}

/**
 * Determines whether two notes sharing the same commitment carry the same identity (a reorg can
 * re-deliver a note the manager already holds — see `NoteManager.addNote`), generic over the
 * chain's address type `TAddress`. Chain-specific: an implementation typically compares
 * `tokenId`/`ownerAddress` alongside the chain-agnostic hash fields
 * (`noteAddressHash`/`value`/`label`/`noteSecret`), but HOW two addresses compare as equal
 * differs by chain (e.g. EVM hex is case/padding-insensitive; Stellar's StrKey is a
 * case-sensitive checksummed string, not numeric, so it cannot go through `BigInt()`).
 */
export type NoteIdentityComparator<TAddress = Address> = (
    a: Note<TAddress>,
    b: Note<TAddress>,
) => boolean;

/**
 * Dependency injection container for NoteManager, generic over the chain's address type
 * `TAddress`.
 * Provides optional logger for debugging and monitoring.
 */
export interface NoteManagerDependencies<TAddress = Address> {
    /** Optional logger for debug output and monitoring. */
    logger?: ILogger;
    /** Optional storage adapter for persisting NoteManager state. */
    storageAdapter?: INoteStorageAdapter<TAddress>;
    /**
     * Determines whether a re-added note (same commitment) is identical to the one already
     * held. Defaults to `defaultNoteIdentityComparator` (EVM-shaped: compares `tokenId`/
     * `ownerAddress` via `BigInt()`) when omitted — a non-EVM `TAddress` MUST supply its own,
     * since the EVM default throws on a non-numeric address string.
     */
    noteIdentityComparator?: NoteIdentityComparator<TAddress>;
}

/**
 * Optional filtering criteria for querying notes, generic over the chain's address type
 * `TAddress`.
 * All provided filters are combined with AND logic.
 */
export interface NoteFilters<TAddress = Address> {
    /** Filter by lifecycle status. */
    status?: NoteStatus;
    /** Filter by label (all notes in a specific deposit lineage). */
    label?: Label;
    /** Filter by token identifier. */
    tokenId?: TAddress;
}

/**
 * Complete NoteManager state for account export and backup, generic over the chain's address
 * type `TAddress`.
 */
export interface NoteManagerExport<TAddress = Address> {
    /** All tracked notes. */
    notes: Note<TAddress>[];
    /** Last synced block number. */
    syncCursor: Hex;
}

/**
 * Internal lightweight representation of a lineage, generic over the chain's address type
 * `TAddress`.
 * Stores commitment hashes instead of full Note objects.
 * The full NoteLineage (with Note objects) is built on demand.
 */
export interface InternalLineage<TAddress = Address> {
    /** Label shared by every note in this lineage. */
    label: Label;
    /** Token identifier for all notes in this lineage. */
    tokenId: TAddress;
    /**
     * The secret that produced this lineage's label. Present only when this
     * wallet originated the lineage via deposit; absent on received-only
     * lineages (transfer, payment request, discovery).
     */
    depositSecret?: Secret;
    /** Commitment hashes of all notes in this lineage. */
    noteHashes: Hash[];
    /** Commitment hashes of all ACTIVE notes in the lineage. */
    activeNoteHashes: Hash[];
    /** Sum of all ACTIVE note values. */
    totalValue: Hex;
}
