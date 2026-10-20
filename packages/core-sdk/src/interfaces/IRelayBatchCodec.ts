import type { Address, EVMProof, NoteData, PreparedTransaction, TransactParams } from "../internal.js";

/** One formatted, ready-to-encode item of a relay batch. */
export interface RelayBatchEncodeItem<TAddress = Address, TProof = EVMProof> {
    /** The chain-formatted proof (already run through `IProofService.formatForChain`). */
    proof: TProof;
    /** The restructured 2D public signals for this item's transact circuit variant. */
    pubSignals: bigint[][];
    /** This item's processor routing params. */
    transactParams: TransactParams<TAddress>;
    /** This item's encrypted note-data payloads. */
    noteData: NoteData[];
}

/**
 * Encodes a batch of already-proven, already-formatted transact items into a single relay-batch
 * transaction, generic over the chain's prepared-transaction type `TTx`, address type
 * `TAddress`, and on-chain proof type `TProof`. Chains differ enough here (ABI calldata vs.
 * Soroban XDR) that there is no shared implementation between chains — a plain interface with
 * one independent implementation per chain, matching {@link IContextHashService}/
 * {@link IPayoutRoutingCodec}.
 */
export interface IRelayBatchCodec<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
> {
    /**
     * Encodes calldata for a relay-batch call from a set of already-built transact items — the
     * array form of a single transact. Used by the self-submit batch path where a gas-paying
     * user submits their own atomic batch (zero relayer fee) instead of routing through a relayer.
     *
     * Asynchronous because a chain whose transactions must be simulated before they can be signed
     * (Soroban) builds the call against the RPC here.
     *
     * @param relayAddress - The batch-relay contract address (the transaction target).
     * @param items - One formatted proof + routing + discovery-data entry per batch item.
     * @param asset - The asset every item withdraws (Soroban's `relay_batch` takes it explicitly;
     *   an item's `tokenIdOut` is a one-way hash of it). EVM derives it on-chain and ignores this.
     * @returns The prepared relay-batch transaction (value `0x0`; the caller pays gas).
     */
    encodeRelayBatch(
        relayAddress: TAddress,
        items: RelayBatchEncodeItem<TAddress, TProof>[],
        asset: TAddress,
    ): Promise<TTx>;
}
