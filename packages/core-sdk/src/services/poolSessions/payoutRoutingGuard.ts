import type { Address, DecodedPayoutRouting } from "../../internal.js";
import { InvalidTransactParams } from "../../internal.js";

// NOTE (core-sdk split): the original packages/sdk/src/services/poolSessions/payoutRoutingGuard.ts
// also exported `assertPayoutRoutingMatchesQuote` — an EVM-only wrapper that ABI-decodes
// `feeCommitment.data` via viem's `decodeAbiParameters` + `PAYOUT_ROUTING_ABI` before delegating
// to `assertDecodedPayoutRoutingMatchesQuote` below. That wrapper (and its viem/PAYOUT_ROUTING_ABI
// import) was dropped here — only the chain-agnostic comparison that `PoolSessionWithdraw` needs
// is chain-agnostic; the ABI-decode step belongs in evm-sdk (and a Stellar/XDR equivalent in
// stellar-sdk) alongside `EvmPreparedTxVerifier`/`EvmRelayBatchCodec`.

/**
 * Asserts each slot of an already-decoded `PayoutRouting` tuple the caller cares about matches
 * the user's intent, BEFORE a proof is authorized over it. Generic over the chain's address type
 * `TAddress` — the decode step is chain-specific (see {@link IPayoutRoutingCodec}), but this
 * comparison is not, so it's shared rather than duplicated per chain.
 *
 * - `recipient` — the on-chain payout destination MUST equal the caller's recipient.
 *   The proof binds whatever routing is in its context, so without this a malicious
 *   relayer could name its own address and the user would authorize paying the
 *   attacker (supplying `transactParams` bypasses the orchestrator's own recipient
 *   handling, so `recipientAddress` alone is not enforced).
 * - `feeAmount` — MUST equal the value the user agreed to in the quote.
 * - `nativeGas` — either MUST equal an exact `bigint`, or, when the caller passes
 *   `{ requested }`, MUST be non-zero iff the extra-gas top-up was requested. The
 *   top-up amount is relayer-computed and priced into `feeAmount`, so a caller can
 *   only pin its presence: flag off → the routing must carry `0`; flag on → it must
 *   carry a non-zero amount, since a zeroed-out top-up would mean the user paid for
 *   gas the recipient never gets. Nothing here bounds the amount itself, and nothing
 *   needs to: `PrivacyPoolRelay.relay` requires the RELAYER to attach exactly
 *   `nativeGas` as `msg.value` and forwards it to the recipient, so an inflated value
 *   costs the relayer, never the user, whose pool outflow stays `amount + feeAmount`.
 *
 * @param decoded - The already-decoded PayoutRouting tuple.
 * @param expectedRecipient - The recipient the caller intends to pay.
 * @param expectedFeeAmount - The fee the caller agreed to in the quote.
 * @param expectedNativeGas - The exact native-gas amount the caller expects, or
 *   `{ requested }` to assert only whether a top-up is present.
 * @throws {InvalidTransactParams} If any field diverges.
 */
export function assertDecodedPayoutRoutingMatchesQuote<TAddress = Address>(
    decoded: DecodedPayoutRouting<TAddress>,
    expectedRecipient: TAddress,
    expectedFeeAmount: bigint,
    expectedNativeGas: bigint | { requested: boolean },
): void {
    if (String(decoded.recipient).toLowerCase() !== String(expectedRecipient).toLowerCase()) {
        throw new InvalidTransactParams(
            `Relayer feeCommitment recipient ${decoded.recipient} does not match caller recipient ${expectedRecipient}`,
        );
    }
    if (decoded.feeAmount !== expectedFeeAmount) {
        throw new InvalidTransactParams(
            `Relayer feeCommitment feeAmount ${decoded.feeAmount} does not match quote.feeAmount ${expectedFeeAmount}`,
        );
    }
    if (typeof expectedNativeGas === "bigint") {
        if (decoded.nativeGas !== expectedNativeGas) {
            throw new InvalidTransactParams(
                `Relayer feeCommitment nativeGas ${decoded.nativeGas} does not match expected ${expectedNativeGas}`,
            );
        }
        return;
    }
    if (!expectedNativeGas.requested && decoded.nativeGas !== 0n) {
        throw new InvalidTransactParams(
            `Relayer feeCommitment nativeGas ${decoded.nativeGas} must be 0 when extraGas was not requested`,
        );
    }
    if (expectedNativeGas.requested && decoded.nativeGas === 0n) {
        throw new InvalidTransactParams(
            "Relayer feeCommitment nativeGas is 0 although extraGas was requested — the recipient would receive no gas top-up",
        );
    }
}

// `assertPayoutRoutingMatchesQuote` (decode-then-assert, EVM-only) was dropped along with the
// imports above — see the NOTE at the top of this file.
