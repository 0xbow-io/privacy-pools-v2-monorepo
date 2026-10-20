import type { Address } from "./Address.js";
import type { Hex } from "./Hex.js";

// NOTE (core-sdk split): the original packages/sdk/src/types/RPCInteractor.ts also defined
// ViemRPCInteractorConfig / CreateViemRPCInteractorConfig / ViemRPCInteractorDependencies —
// viem-specific config shapes for ViemRPCInteractor (an EVM-only service, not copied here).
// Those three types were dropped (and the `viem`/ILogger imports they required) so this file
// stays chain-agnostic; IRPCInteractor and the generic contract interactors only need the
// library-agnostic types below. Re-add the dropped types to evm-sdk's own RPCInteractor types
// file alongside ViemRPCInteractor.

/** Library-agnostic parameters for a read-only contract call. */
export interface ReadContractParams {
    /** Contract address (0x-prefixed). */
    address: Address;
    /** Contract ABI as a JSON array. */
    abi: readonly Record<string, unknown>[];
    /** Name of the function to call. */
    functionName: string;
    /** Optional function arguments. */
    args?: readonly unknown[];
}

/** Library-agnostic parameters for fetching contract event logs. */
export interface GetLogsParams {
    /** Contract address (0x-prefixed). */
    address: Address;
    /** Event ABI items to filter by. */
    events: readonly Record<string, unknown>[];
    /** Start block number (defaults to 0n). */
    fromBlock?: bigint;
    /** End block number (defaults to 'latest'). */
    toBlock?: bigint;
}

/** A decoded event log entry. */
export interface DecodedEventLog {
    /** Event name. */
    eventName: string;
    /** Decoded event arguments keyed by name. */
    args: Record<string, unknown>;
    /** Block number where the event was emitted. */
    blockNumber: Hex;
    /** Transaction hash that emitted the event. */
    transactionHash: Hex;
}

/**
 * A transaction receipt returned by waitForTransaction, generic over the chain's raw log type
 * `TLog` (defaults to EVM's {@link TxLog}). Only `logs` varies by chain — `status`/`blockNumber`/
 * `txHash` are already chain-agnostic (a Stellar receipt has the same shape, `blockNumber`
 * holding a ledger sequence number instead of a block number).
 */
export interface TxReceipt<TLog = TxLog> {
    /** Whether the transaction succeeded. */
    status: boolean;
    /** Block in which the transaction was mined (hex-encoded). */
    blockNumber: Hex;
    /** Transaction hash. */
    txHash: Hex;
    /** Raw event logs emitted by the transaction. */
    logs: TLog[];
}

/**
 * A raw event log from a transaction receipt.
 */
export interface TxLog {
    /** The contract address that emitted the log. */
    address: Hex;
    /** Indexed event topics. */
    topics: Hex[];
    /** Non-indexed event data. */
    data: Hex;
    /** Block number in which the log was emitted (hex-encoded). */
    blockNumber: Hex;
    /** Hash of the transaction that emitted the log. */
    transactionHash: Hex;
    /** Index of the log within the block. */
    logIndex: number;
}

/**
 * Outcome of a `finalized` block-tag read.
 *
 * Three-way rather than `Hex | null` so callers cannot accidentally treat a
 * momentary failure as a permanent provider limitation. See
 * {@link IRPCInteractor.getFinalizedBlockNumber}.
 */
export type FinalizedBlockResult =
    /** The chain answered: this block and everything below it is final. */
    | { status: "finalized"; blockNumber: Hex }
    /** The provider does not serve the tag at all. A permanent property of it. */
    | { status: "unsupported" }
    /** The read failed this time. Says nothing about the chain or the provider. */
    | { status: "unavailable"; reason: string };
