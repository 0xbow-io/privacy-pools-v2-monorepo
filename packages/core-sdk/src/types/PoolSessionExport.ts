import type { ZodType } from "zod";

import type {
    Address,
    IAddressEqualityComparator,
    IAddressFieldConverter,
    ILogger,
    INoteComputationService,
    INoteManager,
    IPaymentRequestService,
    SerializedPaymentRequestRecord,
} from "../internal.js";
import type { NoteManagerExport } from "./NoteManager.js";

/**
 * Full account state export, generic over the chain's address type `TAddress`.
 *
 * Extends {@link NoteManagerExport} (notes, lineage relationships, sync cursor)
 * with recipient-side payment requests and the owner/chain the blob belongs to.
 * Keys are excluded — they are always provided at construction time.
 *
 * `owner` and `chainId` let `importAccount` reject a blob produced for a
 * different account or chain. They are optional on the wire so exports written
 * before this envelope existed still import.
 */
export interface AccountExport<TAddress = Address> extends NoteManagerExport<TAddress> {
    /** Owner address the export was produced for. */
    owner?: TAddress;
    /** Chain id the export was produced for. */
    chainId?: number;
    /** Pending recipient-side payment requests, JSON-safe (Map as array-of-entries). */
    paymentRequests?: SerializedPaymentRequestRecord[];
}

/** Configuration for PoolSessionExport, generic over the chain's address type `TAddress`. */
export interface PoolSessionExportConfig<TAddress = Address> {
    /** The NoteManager to export/import note state from. */
    noteManager: INoteManager<TAddress>;
    /** Recomputes commitment / noteAddressHash to verify a received note's internals. */
    noteComputationService: INoteComputationService;
    /** Converts `TAddress` values into the field-sized `Hex` the Poseidon-hash layer expects. */
    addressFieldConverter: IAddressFieldConverter<TAddress>;
    /** Compares two `TAddress` values for equality (chain-specific canonicalization rules). */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    /** The PaymentRequestService to export/import pending requests from. */
    paymentRequestService: IPaymentRequestService;
    /** Owner stamped into the export envelope, checked on import, and required for received-note ownership. */
    ownerAddress: TAddress;
    /** Chain id stamped into the export envelope and checked on import. */
    chainId: number;
    /** Validates a received note's `tokenId`/`ownerAddress` against the chain's real address shape. */
    addressSchema: ZodType<TAddress>;
}

/** Optional dependencies for PoolSessionExport. */
export interface PoolSessionExportDependencies {
    /** Optional logger for debug output. */
    logger?: ILogger;
}
