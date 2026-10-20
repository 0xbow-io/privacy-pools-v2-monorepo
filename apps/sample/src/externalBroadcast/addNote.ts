import type {
    DepositParams,
    Hash,
    PoolSession,
    PrepareDepositResult,
} from "@privacy-pools-v2/evm-sdk";

/**
 * Reference flow for integrators who broadcast through their own wallet
 * stack. Wait for the receipt before calling `addNotes` — `createdAtBlock`
 * is resolved from chain and throws `NoteCommitmentNotMined` if not yet
 * indexed.
 */
export async function prepareAndRegisterDeposit(
    session: PoolSession,
    params: DepositParams,
    broadcast: (prepared: PrepareDepositResult) => Promise<Hash>,
): Promise<{ prepared: PrepareDepositResult; txHash: Hash }> {
    const prepared = await session.prepareDeposit(params);
    const txHash = await broadcast(prepared);
    await session.addNotes([{ pendingNote: prepared.pendingNote, txHash }]);
    return { prepared, txHash };
}
