import type {
    Address,
    EVMProof,
    PrepareRageQuitResult,
    PreparedTransaction,
    RageQuitParams,
    TxLog,
    TxReceipt,
} from "../internal.js";

/**
 * Orchestrates ragequit preparation: witness building, proof generation, and calldata encoding.
 * Generic over the chain's prepared-transaction type `TTx`, address type `TAddress`, on-chain
 * proof type `TProof`, and raw receipt-log type `TLog` (all default to their EVM shapes).
 */
export interface IPoolSessionRagequit<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /**
     * Prepares a ragequit by building the witness, generating a ZK proof,
     * and encoding the calldata for on-chain submission.
     *
     * The caller is responsible for submitting the returned calldata
     * to the PoolVault contract. The circuit enforces that funds go
     * to the note's ownerAddress.
     *
     * @param params - The ragequit parameters (commitment of the note to exit).
     * @returns The prepared ragequit result with calldata and metadata.
     * @throws {PoolSessionRagequitBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    prepareRageQuit(params: RageQuitParams): Promise<PrepareRageQuitResult<TTx, TAddress>>;

    /**
     * Prepares and executes a ragequit in one step.
     *
     * @param params - The ragequit parameters (commitment of the note to exit).
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionRagequitBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    rageQuit(params: RageQuitParams): Promise<TxReceipt<TLog>>;

    /**
     * Executes a previously prepared ragequit by submitting the transaction on-chain.
     *
     * @param result - The result from prepareRageQuit.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionRagequitBaseError}
     */
    executeRageQuit(result: PrepareRageQuitResult<TTx, TAddress>): Promise<TxReceipt<TLog>>;
}
