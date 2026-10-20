import { z } from "zod";
import { ChainType } from "../config/enums";
import {
    EvmRelayWithdrawalRequest,
    EvmRelayWithdrawalResponse,
    EvmRelaySendRequest,
    EvmRelaySendResponse,
    EvmRelayBatchRequest,
    EvmRelayBatchResponse,
    EvmRelaySwapRequest,
    EvmRelayResponse,
    EvmRelayRegisterAndWithdrawalRequest,
    EvmRelayAndAnnounceRequest,
    EvmRelayAndAnnounceResponse,
} from "./evm/types";
import {
    StarknetRelayWithdrawalRequest,
    StarknetRelayWithdrawalResponse,
    StarknetRelaySendRequest,
    StarknetRelaySendResponse,
} from "./starknet/types";
import {
    StellarRelayWithdrawalRequest,
    StellarRelayWithdrawalResponse,
    StellarRelayNotImplementedRequest,
    StellarRelayBatchRequest,
    StellarRelayRegisterAndWithdrawalRequest,
    StellarRelaySendRequest,
    StellarRelaySendResponse,
} from "./stellar/types";

export interface RelaySwapRequestBodies {
    [ChainType.EVM]: EvmRelaySwapRequest;
    [ChainType.STARKNET]: never;
    [ChainType.SOLANA]: never;
    [ChainType.STELLAR]: never; // no swap subsystem on Stellar
}

export interface RelaySwapResponseBodies {
    [ChainType.EVM]: EvmRelayResponse;
    [ChainType.STARKNET]: never;
    [ChainType.SOLANA]: never;
    [ChainType.STELLAR]: never;
}

export interface RelayWithdrawalRequestBodies {
    [ChainType.EVM]: EvmRelayWithdrawalRequest;
    [ChainType.STARKNET]: StarknetRelayWithdrawalRequest;
    [ChainType.SOLANA]: StarknetRelayWithdrawalRequest; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarRelayWithdrawalRequest;
}

export interface RelayWithdrawalResponseBodies {
    [ChainType.EVM]: EvmRelayWithdrawalResponse;
    [ChainType.STARKNET]: StarknetRelayWithdrawalResponse;
    [ChainType.SOLANA]: StarknetRelayWithdrawalResponse; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarRelayWithdrawalResponse;
}

export interface RelayRegisterAndWithdrawalRequestBodies {
    [ChainType.EVM]: EvmRelayRegisterAndWithdrawalRequest;
    [ChainType.STARKNET]: StarknetRelayWithdrawalRequest;
    [ChainType.SOLANA]: StarknetRelayWithdrawalRequest; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarRelayRegisterAndWithdrawalRequest;
}

export interface RelayRelayAndAnnounceRequestBodies {
    [ChainType.EVM]: EvmRelayAndAnnounceRequest;
    [ChainType.STARKNET]: StarknetRelayWithdrawalRequest; // TODO: not supported on Starknet
    [ChainType.SOLANA]: StarknetRelayWithdrawalRequest; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarRelayNotImplementedRequest; // no ERC-5564 equivalent on Stellar
}

export interface RelayRelayAndAnnounceResponseBodies {
    [ChainType.EVM]: EvmRelayAndAnnounceResponse;
    [ChainType.STARKNET]: StarknetRelayWithdrawalResponse; // TODO: not supported on Starknet
    [ChainType.SOLANA]: StarknetRelayWithdrawalResponse; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarRelayWithdrawalResponse;
}

export interface RelaySendRequestBodies {
    [ChainType.EVM]: EvmRelaySendRequest;
    [ChainType.STARKNET]: StarknetRelaySendRequest;
    [ChainType.SOLANA]: StarknetRelaySendRequest; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarRelaySendRequest;
}

export interface RelaySendResponseBodies {
    [ChainType.EVM]: EvmRelaySendResponse;
    [ChainType.STARKNET]: StarknetRelaySendResponse;
    [ChainType.SOLANA]: StarknetRelaySendResponse; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarRelaySendResponse;
}

export interface RelayBatchRequestBodies {
    [ChainType.EVM]: EvmRelayBatchRequest;
    [ChainType.STARKNET]: StarknetRelayWithdrawalRequest; // TODO: batch not supported on Starknet
    [ChainType.SOLANA]: StarknetRelayWithdrawalRequest; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarRelayBatchRequest;
}

export interface RelayBatchResponseBodies {
    [ChainType.EVM]: EvmRelayBatchResponse;
    [ChainType.STARKNET]: StarknetRelayWithdrawalResponse; // TODO: batch not supported on Starknet
    [ChainType.SOLANA]: StarknetRelayWithdrawalResponse; // TODO: replace when Solana is implemented
    [ChainType.STELLAR]: StellarRelayWithdrawalResponse;
}

export type RelayWithdrawalRequestBody = EvmRelayWithdrawalRequest | StarknetRelayWithdrawalRequest;
export type RelayWithdrawalResponseBody = EvmRelayWithdrawalResponse | StarknetRelayWithdrawalResponse;
export type RelaySendRequestBody = EvmRelaySendRequest | StarknetRelaySendRequest;
export type RelaySendResponseBody = EvmRelaySendResponse | StarknetRelaySendResponse;

// Per-operation request schemas, resolved per-chain via RELAY_SERVICE so each relay
// validation pipe (relay-validation.pipe.ts) can validate against the right chain's
// shape instead of a hardcoded EVM one — the same pattern IQuoteService.schema already
// used for the withdrawal-quote pipe (quote.interface.ts).
type AnyZodType = z.ZodType<unknown, z.ZodTypeDef, unknown>;

export interface IRelayService<TChainType extends ChainType = ChainType> {
    withdrawalSchema: AnyZodType;
    transferSchema: AnyZodType;
    batchSchema: AnyZodType;
    relaySwapSchema?: AnyZodType;
    registerAndWithdrawalSchema: AnyZodType;
    relayAndAnnounceSchema: AnyZodType;

    withdrawal(request: RelayWithdrawalRequestBodies[TChainType]): Promise<RelayWithdrawalResponseBodies[TChainType]>;
    transfer(request: RelaySendRequestBodies[TChainType]): Promise<RelaySendResponseBodies[TChainType]>;
    batchWithdrawal(request: RelayBatchRequestBodies[TChainType]): Promise<RelayBatchResponseBodies[TChainType]>;
    relaySwap?(request: RelaySwapRequestBodies[TChainType]): Promise<RelaySwapResponseBodies[TChainType]>;
    // Registers a fresh, unfunded recipient in the keystore (via an off-chain signature) and withdraws
    // their note atomically, so the recipient never has to fund their address to pay registration gas.
    registerAndWithdrawal(
        request: RelayRegisterAndWithdrawalRequestBodies[TChainType]
    ): Promise<RelayWithdrawalResponseBodies[TChainType]>;
    // Atomically relays a withdrawal to a stealth address then publishes its ERC-5564 announcement.
    relayAndAnnounce(
        request: RelayRelayAndAnnounceRequestBodies[TChainType]
    ): Promise<RelayRelayAndAnnounceResponseBodies[TChainType]>;
}

export type ChainedRelayService<TChainType extends ChainType> = IRelayService<TChainType>;

// injection token for NestJS DI
export const RELAY_SERVICE = Symbol("RELAY_SERVICE");
