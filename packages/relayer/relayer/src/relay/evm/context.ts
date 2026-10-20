import { encodeAbiParameters, keccak256 } from "viem";
import { EvmAddress } from "../../config/evm/evm.types";
import { Bytes, NoteData } from "./types";

/** BN254 scalar field modulus — must match PoolVault.SNARK_SCALAR_FIELD. */
export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const contextAbiParams = [
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
] as const;

/**
 * Compute the context a transact proof must bind, mirroring the on-chain check:
 * context = keccak256(abi.encode(TransactParams{processor, data}, NoteData[])) % SNARK_SCALAR_FIELD
 *
 * Returns a bigint; compare numerically — pubSignal hex parsing is not zero-padded.
 */
export function computeContext(processor: EvmAddress, data: Bytes, noteData: NoteData[]): bigint {
    const encoded = encodeAbiParameters(contextAbiParams, [{ processor, data }, noteData]);
    return BigInt(keccak256(encoded)) % SNARK_SCALAR_FIELD;
}
