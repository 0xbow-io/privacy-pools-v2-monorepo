import type { Account, Chain, Transport, WalletClient } from "viem";

import type { Hex, ViemRPCInteractor } from "@privacy-pools-v2/evm-sdk";

/**
 * FakeRelayer — test-only stand-in for a real relayer.
 *
 * In production a relayer is a separate service that submits the prepared
 * `transact()` calldata on behalf of the user (paying gas) and forwards the
 * net amount to the recipient. This helper instead has the user's own wallet
 * call `transact()` directly — `msg.sender` becomes the user, the contract
 * sends the funds straight back, and there is no relayer fee.
 *
 * Used by `selfSubmitWithdraw.ts` and any cold-start flow where the recipient
 * needs to settle a withdrawal without depending on an external relayer.
 */
export class FakeRelayer {
    private readonly walletClient: WalletClient<Transport, Chain, Account>;
    private readonly rpcInteractor: ViemRPCInteractor;

    constructor(
        walletClient: WalletClient<Transport, Chain, Account>,
        rpcInteractor: ViemRPCInteractor,
    ) {
        this.walletClient = walletClient;
        this.rpcInteractor = rpcInteractor;
    }

    async relay(prepareResult: { callData: Hex; to: Hex }): Promise<{
        txHash: Hex;
        blockNumber: Hex;
        status: boolean;
    }> {
        const txHash = await this.walletClient.sendTransaction({
            to: prepareResult.to as `0x${string}`,
            data: prepareResult.callData as `0x${string}`,
        });
        const receipt = await this.rpcInteractor.waitForTransactionReceipt(txHash as Hex);
        return {
            txHash: txHash as Hex,
            blockNumber: receipt.blockNumber,
            status: receipt.status,
        };
    }
}
