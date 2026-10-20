import { hexToBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import type {
    Hex,
    IContextHashService,
    NoteData,
    StellarAddress,
    TransactParams,
} from "../../internal.js";
import { BN254_SCALAR_MODULUS, bytesToBigIntBE } from "../../internal.js";

/** Encodes `value` as 4 little-endian bytes — matches Rust's `u32::to_le_bytes()`. */
function u32LE(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/** Packs one note as `hint(32B) ‖ len(data)(4B LE) ‖ data` — matches the contract's per-note layout. */
function noteDataBytes(noteData: NoteData): Uint8Array {
    const dataBytes = hexToBytes(noteData.data.slice(2));
    return concatBytes(hexToBytes(noteData.hint.slice(2)), u32LE(dataBytes.length), dataBytes);
}

function keccakModField(bytes: Uint8Array): Hex {
    const hash = keccak_256(bytes);
    const field = bytesToBigIntBE(hash) % BN254_SCALAR_MODULUS;
    return ("0x" + field.toString(16).padStart(64, "0")) as Hex;
}

/**
 * Stellar implementation of {@link IContextHashService} — raw byte-packing + keccak256, matching
 * the pool contract's `compute_deposit_context`/`compute_transact_context` (Soroban has no
 * ABI-tuple-encoding equivalent to EVM's `abi.encode`, so the contract packs fields manually with
 * explicit little-endian length prefixes instead of `abi.encode`'s word-aligned tuples).
 */
export class StellarContextHashService implements IContextHashService<StellarAddress> {
    /** @inheritdoc IContextHashService.computeDepositContext */
    computeDepositContext(noteData: NoteData): Hex {
        return keccakModField(noteDataBytes(noteData));
    }

    /**
     * @inheritdoc IContextHashService.computeTransactContext
     *
     * Always packs the processor's real StrKey bytes, never the contract's 32-zero-byte
     * "permissionless" (`processor_gated = false`) variant —
     * `StellarPoolVaultChainAdapter.encodeTransact` always submits `processor_gated = true`, so
     * this must stay in lockstep with that; if that assumption ever changes, both call sites
     * need updating together.
     */
    computeTransactContext(
        transactParams: TransactParams<StellarAddress>,
        noteData: NoteData[],
    ): Hex {
        const processorBytes = utf8ToBytes(transactParams.processor);
        const processorDataBytes = hexToBytes(transactParams.data.slice(2));

        return keccakModField(
            concatBytes(
                processorBytes,
                u32LE(processorDataBytes.length),
                processorDataBytes,
                u32LE(noteData.length),
                ...noteData.map(noteDataBytes),
            ),
        );
    }
}
