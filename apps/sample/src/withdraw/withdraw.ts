import type {
    Hash,
    Hex,
    PoolSession,
    PrepareWithdrawResult,
    TxReceipt,
} from "@privacy-pools-v2/evm-sdk";

/**
 * Withdraw via the SDK relayer.
 *
 * The relayer pays gas and submits `transact()` on the PoolVault. The net
 * amount (after relayer fee) is forwarded to `recipientAddress`. Pass any
 * EVM address as the recipient — public withdrawals do not need to match
 * the session owner.
 *
 * Wallet client requirement: NOT needed — the relayer's signer pays gas.
 *
 * @param session            PoolSession (no wallet client required).
 * @param params             `{ inputCommitment, recipientAddress, amount, tokenId }`.
 * @returns                  `{ prepared, receipt }`. If you need to look up
 *                           the on-chain nullifier afterwards, compute
 *                           `Poseidon(privateNullifyingKey, inputCommitment)`.
 */
export async function withdraw(
    session: PoolSession,
    params: {
        inputCommitment: Hash;
        recipientAddress: Hex;
        amount: Hex;
        tokenId: Hex;
    },
): Promise<{ prepared: PrepareWithdrawResult; receipt: TxReceipt }> {
    const prepared = await session.prepareWithdraw({
        inputCommitments: [params.inputCommitment],
        amount: params.amount,
        tokenId: params.tokenId,
        recipientAddress: params.recipientAddress,
    });
    const receipt = await session.relayWithdraw(prepared.relayerOptions[0]);
    return { prepared, receipt };
}
