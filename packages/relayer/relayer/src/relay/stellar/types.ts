import { z } from "zod";
import {
    zStellarRelayWithdrawalRequest,
    zStellarRelayResponse,
    zStellarNoteData,
    zStellarRelayNotImplemented,
    zStellarRelayBatchRequest,
    zStellarRelayTransferRequest,
    zStellarRelayRegisterAndWithdrawalRequest,
} from "./schemas";

export type StellarRelayWithdrawalRequest = z.infer<typeof zStellarRelayWithdrawalRequest>;
export type StellarRelayResponse = z.infer<typeof zStellarRelayResponse>;
export type StellarNoteData = z.infer<typeof zStellarNoteData>;

export type StellarRelayWithdrawalResponse = StellarRelayResponse;

// Placeholder request/response types for operations with no Stellar wire shape — mirrors
// relay/starknet/types.ts's empty-object placeholders for the same reason (unimplemented, not
// merely unbuilt; see the Stellar plan's Scope section).
export type StellarRelayNotImplementedRequest = z.infer<typeof zStellarRelayNotImplemented>;
export type StellarRelaySendRequest = z.infer<typeof zStellarRelayTransferRequest>;
export type StellarRelaySendResponse = StellarRelayResponse;

export type StellarRelayBatchRequest = z.infer<typeof zStellarRelayBatchRequest>;
export type StellarRelayRegisterAndWithdrawalRequest = z.infer<typeof zStellarRelayRegisterAndWithdrawalRequest>;
