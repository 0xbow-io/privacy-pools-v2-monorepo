// TODO starknet

import { Hash } from "viem";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StarknetRelayWithdrawalRequest {}

export interface StarknetRelayWithdrawalResponse {
    txHash: Hash;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StarknetRelaySendRequest {}

export interface StarknetRelaySendResponse {
    txHash: Hash;
}
