import { encodeAbiParameters, keccak256 } from "viem";

import type { Hex, IContextHashService, NoteData, TransactParams } from "../../internal.js";

/**
 * EVM implementation of {@link IContextHashService} — ABI-encodes and `keccak256`-hashes the
 * same way the PoolVault contract does. Extracted verbatim from `PoolSessionDeposit` and
 * `TransactOrchestrator`'s previously-inline computations; behavior is unchanged, only relocated.
 */
export class EvmContextHashService implements IContextHashService {
    /** @inheritdoc IContextHashService.computeDepositContext */
    computeDepositContext(noteData: NoteData): Hex {
        const encoded = encodeAbiParameters(
            [
                {
                    type: "tuple",
                    components: [
                        { name: "hint", type: "bytes32" },
                        { name: "data", type: "bytes" },
                    ],
                },
            ],
            [{ hint: noteData.hint, data: noteData.data }],
        );

        return keccak256(encoded) as Hex;
    }

    /** @inheritdoc IContextHashService.computeTransactContext */
    computeTransactContext(transactParams: TransactParams, noteData: NoteData[]): Hex {
        const encoded = encodeAbiParameters(
            [
                {
                    type: "tuple",
                    components: [
                        { name: "processor", type: "address" },
                        { name: "data", type: "bytes" },
                    ],
                },
                {
                    type: "tuple[]",
                    components: [
                        { name: "hint", type: "bytes32" },
                        { name: "data", type: "bytes" },
                    ],
                },
            ],
            [{ processor: transactParams.processor, data: transactParams.data }, noteData],
        );

        return keccak256(encoded);
    }
}
