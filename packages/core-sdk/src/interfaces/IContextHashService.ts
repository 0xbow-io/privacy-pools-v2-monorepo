import type { Address, Hex, NoteData, TransactParams } from "../internal.js";

/**
 * Computes the proof-context hash bound into deposit/transact circuits, generic over the chain's
 * address type `TAddress`. Chains differ enough here (ABI-`keccak256` vs. a Soroban hash) that
 * there is no shared implementation between chains — this is a plain interface with one
 * independent implementation per chain, not an abstract base.
 */
export interface IContextHashService<TAddress = Address> {
    /**
     * Computes the deposit context hash from note data. Mirrors the on-chain PoolVault
     * computation; the circuit performs the modular reduction (`% SNARK_SCALAR_FIELD`) itself.
     *
     * @param noteData - The note discovery data (hint + encrypted payload).
     * @returns The context hash as a Hex string.
     */
    computeDepositContext(noteData: NoteData): Hex;

    /**
     * Computes the transact context hash from the processor routing params and output note
     * data. Mirrors the on-chain PoolVault computation.
     *
     * @param transactParams - The processor routing parameters.
     * @param noteData - The output notes' discovery data.
     * @returns The context hash as a Hex string.
     */
    computeTransactContext(transactParams: TransactParams<TAddress>, noteData: NoteData[]): Hex;
}
