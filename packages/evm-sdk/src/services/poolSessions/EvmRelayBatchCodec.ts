import { encodeFunctionData } from "viem";

import type {
    Address,
    Hex,
    IRelayBatchCodec,
    PreparedTransaction,
    RelayBatchEncodeItem,
} from "../../internal.js";
import { PP_RELAY_BATCH_ABI } from "../../internal.js";

/**
 * EVM implementation of {@link IRelayBatchCodec} — ABI-encodes a `PrivacyPoolRelay.relayBatch`
 * call. Extracted verbatim from `TransactOrchestrator.encodeRelayBatch`'s previously-inline
 * `encodeFunctionData` call; behavior is unchanged, only relocated.
 */
export class EvmRelayBatchCodec implements IRelayBatchCodec<PreparedTransaction> {
    /** @inheritdoc IRelayBatchCodec.encodeRelayBatch */
    async encodeRelayBatch(relayAddress: Address, items: RelayBatchEncodeItem[]): Promise<PreparedTransaction> {
        const proofArgs = items.map((item) => ({
            pA: item.proof.pA,
            pB: item.proof.pB,
            pC: item.proof.pC,
            pubSignals: item.pubSignals,
        }));
        const transactParamsArgs = items.map((item) => ({
            processor: item.transactParams.processor,
            data: item.transactParams.data,
        }));
        const noteDataArgs = items.map((item) => item.noteData);

        return {
            to: relayAddress,
            data: encodeFunctionData({
                abi: PP_RELAY_BATCH_ABI,
                functionName: "relayBatch",
                args: [proofArgs, transactParamsArgs, noteDataArgs],
            }) as Hex,
            value: "0x0" as Hex,
        };
    }
}
