import { decodeAbiParameters, encodeAbiParameters } from "viem";

import type { Address, DecodedPayoutRouting, Hex, IPayoutRoutingCodec } from "../../internal.js";
import { PAYOUT_ROUTING_ABI, PAYOUT_ROUTING_ARRAY_ABI } from "../../internal.js";

/**
 * EVM implementation of {@link IPayoutRoutingCodec} — ABI-encodes/decodes the `PayoutRouting`
 * tuple the same way `IPrivacyPoolRelay.PayoutRouting` does on-chain. Extracted verbatim from
 * `TransactOrchestrator.getTransactParams`'s previously-inline `encodeAbiParameters` call and
 * `payoutRoutingGuard.ts`'s `decodeAbiParameters` call; behavior is unchanged, only relocated.
 */
export class EvmPayoutRoutingCodec implements IPayoutRoutingCodec {
    /** @inheritdoc IPayoutRoutingCodec.encode */
    encode(routing: DecodedPayoutRouting): Hex {
        return encodeAbiParameters(PAYOUT_ROUTING_ABI, [
            {
                recipient: routing.recipient,
                feeRecipient: routing.feeRecipient,
                feeAmount: routing.feeAmount,
                nativeGas: routing.nativeGas,
            },
        ]);
    }

    /** @inheritdoc IPayoutRoutingCodec.decode */
    decode(data: Hex): DecodedPayoutRouting {
        const [tuple] = decodeAbiParameters(PAYOUT_ROUTING_ABI, data);
        return tuple as {
            recipient: Address;
            feeRecipient: Address;
            feeAmount: bigint;
            nativeGas: bigint;
        };
    }

    /** @inheritdoc IPayoutRoutingCodec.decodeArray */
    decodeArray(data: Hex): DecodedPayoutRouting[] {
        const [routings] = decodeAbiParameters(PAYOUT_ROUTING_ARRAY_ABI, data);
        return routings as {
            recipient: Address;
            feeRecipient: Address;
            feeAmount: bigint;
            nativeGas: bigint;
        }[];
    }
}
