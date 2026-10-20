import type {
    Hash,
    Hex,
    PoolSession,
    PrepareWithdrawResult,
    ViemRPCInteractor,
} from "@privacy-pools-v2/evm-sdk";
import type { Account, Chain, Transport, WalletClient } from "viem";

import { FakeRelayer } from "../util/FakeRelayer.js";

/**
 * Withdraw without a relayer — the user's own wallet submits `transact()`.
 *
 * `prepareWithdraw` is the same SDK call as the relayed variant, but here
 * the caller submits the prepared calldata directly via `FakeRelayer`
 * (a thin wrapper around `walletClient.sendTransaction`). `msg.sender` is
 * the user, the contract sends funds straight back, no relayer fee.
 *
 * Use when the user has a usable signer and doesn't need the privacy of
 * a third-party submitter, or for cold-start recipients with no relayer
 * relationship.
 *
 * Wallet client requirement: REQUIRED here — the caller is the submitter.
 *
 * @param session            PoolSession.
 * @param walletClient       Viem wallet client for the submitter.
 * @param rpcInteractor      RPC interactor (used by FakeRelayer to wait on the receipt).
 * @param params             `{ inputCommitment, recipientAddress, amount, tokenId }`.
 * @returns                  `{ prepared, receipt }` where receipt mirrors TxReceipt.
 */
export async function selfSubmitWithdraw(
    session: PoolSession,
    walletClient: WalletClient<Transport, Chain, Account>,
    rpcInteractor: ViemRPCInteractor,
    params: {
        inputCommitment: Hash;
        recipientAddress: Hex;
        amount: Hex;
        tokenId: Hex;
        /**
         * Address of an on-chain registered processor. Required even with `feeAmount=0` —
         * the PoolVault contract validates that `processorAddress` is a registered
         * processor on the AccessRouter, regardless of fee.
         */
        processorAddress: Hex;
    },
): Promise<{
    prepared: PrepareWithdrawResult;
    receipt: { txHash: Hex; blockNumber: Hex; status: boolean };
}> {
    const prepared = await session.prepareWithdraw({
        inputCommitments: [params.inputCommitment],
        amount: params.amount,
        tokenId: params.tokenId,
        recipientAddress: params.recipientAddress,
        relayAddress: params.recipientAddress,
        feeAmount: "0x0" as Hex,
        processorAddress: params.processorAddress,
    });
    const fakeRelayer = new FakeRelayer(walletClient, rpcInteractor);
    const receipt = await fakeRelayer.relay({ to: prepared.to, callData: prepared.callData });
    return { prepared, receipt };
}
