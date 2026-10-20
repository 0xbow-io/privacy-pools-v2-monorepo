import { decodeAbiParameters } from "viem";

import type { Address, DecodedPayoutRouting, Hex } from "../../internal.js";
import { assertDecodedPayoutRoutingMatchesQuote, InvalidTransactParams } from "../../internal.js";
import { PAYOUT_ROUTING_ABI } from "../../internal.js";

// NOTE (core-sdk split): core-sdk's services/poolSessions/payoutRoutingGuard.ts kept only the
// chain-agnostic `assertDecodedPayoutRoutingMatchesQuote` comparison and dropped this decode-then-
// assert EVM wrapper (see the NOTE at the top of that file) — it lives here instead, alongside
// EvmPreparedTxVerifier / EvmRelayBatchCodec / EvmPayoutRoutingCodec.

/**
 * Decodes a relayer-signed `PayoutRouting` tuple and asserts each slot the caller
 * cares about matches the user's intent, BEFORE a proof is authorized over it.
 * EVM-only (ABI-decodes directly via viem) — see {@link assertDecodedPayoutRoutingMatchesQuote}
 * for the chain-agnostic comparison this wraps.
 *
 * Shared by the plain (`PoolSessionWithdraw`) and yield (`PoolSessionYieldWithdraw`)
 * relayed-withdraw paths so the theft guard cannot drift between them.
 *
 * @param data - The relayer's ABI-encoded `PayoutRouting` (`feeCommitment.data`).
 * @param expectedRecipient - The recipient the caller intends to pay.
 * @param expectedFeeAmount - The fee the caller agreed to in the quote.
 * @param expectedNativeGas - The exact native-gas amount the caller expects, or
 *   `{ requested }` to assert only whether a top-up is present.
 * @throws {InvalidTransactParams} If decoding fails or any field diverges.
 */
export function assertPayoutRoutingMatchesQuote(
    data: Hex,
    expectedRecipient: Address,
    expectedFeeAmount: bigint,
    expectedNativeGas: bigint | { requested: boolean },
): void {
    let decoded: DecodedPayoutRouting<Address>;
    try {
        const [tuple] = decodeAbiParameters(PAYOUT_ROUTING_ABI, data);
        decoded = tuple as unknown as DecodedPayoutRouting<Address>;
    } catch (error) {
        throw new InvalidTransactParams(
            `Failed to decode relayer feeCommitment.data: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    assertDecodedPayoutRoutingMatchesQuote(
        decoded,
        expectedRecipient,
        expectedFeeAmount,
        expectedNativeGas,
    );
}
