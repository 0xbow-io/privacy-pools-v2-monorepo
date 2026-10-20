import type {
    DepositParams,
    PoolSession,
    PrepareDepositResult,
    TxReceipt,
} from "@privacy-pools-v2/evm-sdk";

/**
 * Self-deposit, one-shot.
 *
 * Runs prepare → submit → wait → persist-note in a single call. The owner of
 * the session is both the depositor and the recipient — the SDK persists the
 * resulting note in the local NoteManager, so subsequent `discoverNotes()` /
 * `prepareTransfer` / `prepareWithdraw` calls can spend it.
 *
 * Wallet client requirement: the session MUST be built with a wallet
 * interactor (e.g. `createBobPoolSession({ withWalletClient: true })`).
 * Without one, the SDK has no way to sign and send the transaction.
 *
 * @param session  PoolSession built with a wallet client.
 * @param params   `{ tokenId, value }` — `value` is hex-encoded wei.
 * @returns        TxReceipt: `{ txHash, blockNumber, status }`.
 */
export async function depositOneShot(
    session: PoolSession,
    params: DepositParams,
): Promise<TxReceipt> {
    return session.deposit(params);
}

/**
 * Self-deposit, split prepare/execute.
 *
 * Same effect as `depositOneShot`, but split into two steps so the caller can
 * inspect the prepared payload (commitment, label, calldata, msgValue, optional
 * ERC-20 approval tx) before submitting — useful when you want to display the
 * commitment to the user, or simulate the tx, before going on-chain.
 *
 * **Important:** local note persistence happens inside `executeDeposit`, NOT
 * `prepareDeposit`. Calling `prepareDeposit` and skipping `executeDeposit`
 * leaves no local state — `discoverNotes()` would be your only way to recover
 * the note later. So if you split, always call `executeDeposit` (or fall back
 * to `depositOneShot`).
 *
 * Wallet client requirement: same as `depositOneShot` — `executeDeposit` uses
 * the wallet interactor to send the tx.
 *
 * @param session  PoolSession built with a wallet client.
 * @param params   `{ tokenId, value }`.
 * @returns        `{ prepared, receipt }`. `prepared.pendingNote.commitment`
 *                 is the new note's commitment.
 */
export async function depositPrepareExecute(
    session: PoolSession,
    params: DepositParams,
): Promise<{ prepared: PrepareDepositResult; receipt: TxReceipt }> {
    const prepared = await session.prepareDeposit(params);
    const receipt = await session.executeDeposit(prepared);
    return { prepared, receipt };
}
