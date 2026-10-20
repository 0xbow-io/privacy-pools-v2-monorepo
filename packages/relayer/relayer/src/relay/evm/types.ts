import { z } from "zod";
import {
    zTransactProof,
    zTransactParams,
    zNoteData,
    zEvmRelayWithdrawalRequest,
    zEvmRelayTransferRequest,
    zEvmRelaySwapRequest,
    zEvmRelayResponse,
    zEvmRelayBatchRequest,
    zEvmRelayRegisterAndWithdrawalRequest,
    zKeystoreRegistration,
    zEvmRelayAndAnnounceRequest,
    zAnnouncement,
} from "./schemas";
import { EvmAddress } from "../../config/evm/evm.types";

//  transact(
//      TransactProof memory _proof,
//      Transact memory _transact,
//      bytes memory _ciphertext
//  )

// - TransactProof -
//  {
//      pA[2],                        // [Hash, Hash]
//      pB[2][2],                     // [Hash, Hash]
//      pC[2],                        // [[Hash, Hash], [string, string]]
//      pubSignals[][]: [
//          [0] nullifierHashes[],    // uint256[]    // Hash[]
//          [1] outputCommitments[]   // uint256[]    // Hash[]
//          [2] stateRoot,            // uint256      // Hash
//          [3] keyRegistryRoot,      // uint256      // Hash
//          [4] associationSetRoot,   // uint256      // Hash
//          [5] amountOut,            // uint256      // bigint
//          [6] tokenIdOut,           // uint256      // bigint (Address encoded)
//          [7] context,              // uint256      // Hash
//      ]
//  }

// -========- Inferred types -========-

export type TransactProof = z.infer<typeof zTransactProof>;
export type ReshapedProof = EvmRelayWithdrawalRequest["proof"];
export type ParsedPubSignals = ReshapedProof["parsedPubSignals"];
export type RawPubSignals = ReshapedProof["pubSignals"];
export type TransactParams = z.infer<typeof zTransactParams>;
export type NoteData = z.infer<typeof zNoteData>;
export type Bytes = `0x${string}`;
export type EvmRelayWithdrawalRequest = z.infer<typeof zEvmRelayWithdrawalRequest>;
export type EvmRelayTransferRequest = z.infer<typeof zEvmRelayTransferRequest>;
export type EvmRelayBatchRequest = z.infer<typeof zEvmRelayBatchRequest>;
export type KeystoreRegistration = z.infer<typeof zKeystoreRegistration>;
export type EvmRelayRegisterAndWithdrawalRequest = z.infer<typeof zEvmRelayRegisterAndWithdrawalRequest>;
export type Announcement = z.infer<typeof zAnnouncement>;
export type EvmRelayAndAnnounceRequest = z.infer<typeof zEvmRelayAndAnnounceRequest>;
export type EvmRelayBatchItem = EvmRelayBatchRequest["items"][number];
export type EvmRelaySwapRequest = z.infer<typeof zEvmRelaySwapRequest>;
export type EvmRelayResponse = z.infer<typeof zEvmRelayResponse>;
export interface EvmRelaySDKPayload {
    proof: ReshapedProof;
    noteData: NoteData[];
    data: Bytes;
    // Optional alternate transact processor (e.g. PPRouter). When set, the
    // withdrawal is routed via `withdrawToUnderlying` on this address instead of
    // the default PrivacyPoolRelay `relay`. Already validated against allowlist.
    processorAddress?: EvmAddress;
    // Slippage floor for PPRouter `withdrawToUnderlying` (underlying out).
    minUnderlyingOut?: bigint;
}

// Payload for an atomic on-chain `registerAndRelay` submission: the same shape as
// a withdrawal relay (proof, noteData, encoded fee data) plus the keystore auth-policy
// registration leg. The registration fields are threaded straight to the contract call
// args; they are not part of the fee quote.
export interface EvmRelayRegisterSDKPayload extends EvmRelaySDKPayload {
    registration: KeystoreRegistration;
}

// Payload for an atomic on-chain `relayAndAnnounce` submission: the same shape as
// a withdrawal relay (proof, noteData, encoded fee data) plus the ERC-5564 stealth
// announcement leg. The announcement fields are threaded straight to the contract
// call args; they are not part of the fee quote. No processor/minUnderlyingOut —
// stealth×yield is unsupported, so this is standard-relay only.
export interface EvmRelayAndAnnounceSDKPayload extends EvmRelaySDKPayload {
    announcement: Announcement;
}

// Payload for a single on-chain `relayBatch` submission: N proofs, N encoded
// PayoutRouting transactParams, and N per-item noteData arrays (all same length).
export interface EvmRelayBatchSDKPayload {
    proofs: ReshapedProof[];
    transactParams: TransactParams[];
    noteData: NoteData[][];
}
export interface EvmRelaySwapPayload extends EvmRelaySDKPayload {
    nativeGas: bigint;
    // Set when the withdrawn asset is a yield share: RelaySwaps.executeUnwrapped(…, zap) is
    // called instead of execute(), redeeming the shares through this allowlisted zap first.
    zap?: EvmAddress;
    // True when SwapRouting.swapValue > 0 (B2 in-contract gas swap): the broadcast gas cap
    // then includes the surcharge the quote priced for it (relay_gas_budget.ts).
    b2GasSwap?: boolean;
}

// -========- Aliases -========-

export type EvmRelayWithdrawalResponse = EvmRelayResponse;
export type EvmRelayRegisterAndWithdrawalResponse = EvmRelayResponse;
export type EvmRelayAndAnnounceResponse = EvmRelayResponse;
export type EvmRelayTransferResponse = EvmRelayResponse;
export type EvmRelayBatchResponse = EvmRelayResponse;
export type EvmRelaySendRequest = EvmRelayTransferRequest;
export type EvmRelaySendResponse = EvmRelayResponse;
export interface FeeSplit {
    recipient: EvmAddress;
    feeRecipient: EvmAddress;
    feeAmount: bigint;
    nativeGas: bigint;
}

// -========- Example data -========-

export const transactParamsExample = {
    processor: "0x0000000000000000000000000000000000000000",
    data: "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000000",
};
