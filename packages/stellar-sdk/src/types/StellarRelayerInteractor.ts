import type {
    Hex,
    IHTTPClient,
    ILogger,
    IProofService,
    RelayerInfo,
    StellarAddress,
    StellarProof,
} from "../internal.js";
import type { ZodType } from "zod";

/**
 * Configuration for {@link StellarRelayerInteractor}, extending the generic relayer config with
 * the proof-formatting service its wire protocol needs (the relayer expects a `{a, b, c}` Groth16
 * proof, not the EVM verifier-calldata shape).
 */
export interface StellarRelayerInteractorConfig {
    /** Known relayers to use for transaction submission. */
    relayers: RelayerInfo<StellarAddress>[];
    /** HTTP client for making requests to relayer APIs. */
    httpClient: IHTTPClient;
    /** Validates the `StellarAddress`-typed fields carried by relayer requests/config. */
    addressSchema: ZodType<StellarAddress>;
    /** Reshapes a proof into the `{a, b, c}` byte layout the relayer expects. */
    proofService: IProofService<StellarProof>;
}

/**
 * Optional dependencies for {@link StellarRelayerInteractor}.
 */
export interface StellarRelayerInteractorDependencies {
    logger?: ILogger;
}

/**
 * The signed withdrawal fee commitment the relayer returns from
 * `POST /v1/quote/stellar/{chainId}/{send|receive}` when a `recipient` is supplied and
 * `commit: true` — `data` is the 128-byte `StellarPayoutRoutingCodec` encoding of the payout
 * routing, `signedRelayerCommitment` a raw ed25519 signature over the relayer's own canonical
 * byte encoding (both opaque to this client; round-tripped unchanged into `relayWithdrawal`).
 * Matches `packages/relayer/relayer/src/quote/stellar/schemas.ts`'s
 * `zStellarSignedWithdrawalFeeCommitment` field-for-field.
 */
export interface StellarWithdrawalFeeCommitmentWire {
    data: Hex;
    asset: string;
    expiration: number;
    feeAmount: string;
    recipient: string;
    amountSent: string;
    amountReceived: string;
    signedRelayerCommitment: Hex;
}

/**
 * The relayer's `POST /v1/quote/stellar/{chainId}/{send|receive}` response. No `txCost`/`gasPrice`
 * — Soroban resource fees are computed deterministically at simulate time, not a gas-price market
 * to quote ahead of time, so the relayer's own quote response carries none. `feeCommitment` is
 * present only when the request set `commit: true` (and supplied a `recipient`). Matches
 * `quote/stellar/schemas.ts`'s `zStellarQuoteResponse`.
 */
export interface StellarWithdrawalQuoteResponseWire {
    feeAmount: string;
    amountSent: string;
    amountReceived: string;
    feeCommitment?: StellarWithdrawalFeeCommitmentWire;
}

/** The relayer's `POST /v1/relay/stellar/{chainId}/withdrawal` response. Matches
 * `relay/stellar/schemas.ts`'s `zStellarRelayResponse`. */
export interface StellarRelayResponseWire {
    txHash: Hex;
    error?: string;
}
