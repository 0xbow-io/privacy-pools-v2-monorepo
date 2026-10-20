import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import type { Hex, IAddressFieldConverter, StellarAddress } from "../../internal.js";
import { BN254_SCALAR_MODULUS, bytesToBigIntBE } from "../../internal.js";

/** `2^160 - 1` — masks a 256-bit value down to its low 160 bits. */
const TOKEN_ID_MASK = (1n << 160n) - 1n;

/**
 * Stellar implementation of {@link IAddressFieldConverter}. Two distinct conversions, matching
 * the pool contract's on-chain Rust exactly (`contracts/soroban-v2-utils/src/lib.rs`):
 *
 * - `toField`: `keccak256(strkey) % BN254_SCALAR_MODULUS` (`address_to_field`) — full-field,
 *   for owner/recipient addresses, which the circuit does not range-check.
 * - `toTokenIdField`: `keccak256(strkey) & (2^160 - 1)` (`encode_token_id`) — the low 160 bits
 *   only, NOT a modulo reduction. Confirmed via a real local-network deposit failing the
 *   circuit's `Num2Bits(160)` range check before this existed — `toField`'s full-~254-bit output
 *   almost always exceeds 2^160, since Stellar addresses (unlike EVM's, which are natively
 *   160 bits) have no natural bound under a full-field hash-mod reduction.
 *
 * Same formulas as `StellarCryptoService.stellarAddressToField` (duplicated here rather than
 * injected — this seam needs no other capability from that service, so a whole crypto-service
 * dependency would be overkill for a few lines); keep both in sync if either formula changes.
 */
export class StellarAddressFieldConverter implements IAddressFieldConverter<StellarAddress> {
    /** @inheritdoc IAddressFieldConverter.toField */
    toField(address: StellarAddress): Hex {
        const hash = keccak_256(utf8ToBytes(address));
        const field = bytesToBigIntBE(hash) % BN254_SCALAR_MODULUS;
        return ("0x" + field.toString(16).padStart(64, "0")) as Hex;
    }

    /**
     * @inheritdoc IAddressFieldConverter.toTokenIdField
     *
     * Deliberately NOT zero-padded to a fixed width (unlike {@link toField}): this value also
     * flows through `NoteComputationService`'s RLP-encoded note payload (`NotePayload.tokenId`),
     * which — like EVM's `Address`, itself never padded beyond its natural 20 bytes — round-trips
     * exactly the bytes it's given with no stripping or re-padding on decode. A forced 32-byte
     * `padStart` here decoded back with its 12 leading zero bytes still intact (verified live
     * against a real local-network deposit), overflowing `TokenIdFieldSchema`'s 20-byte bound.
     */
    toTokenIdField(tokenId: StellarAddress): Hex {
        const hash = keccak_256(utf8ToBytes(tokenId));
        const field = bytesToBigIntBE(hash) & TOKEN_ID_MASK;
        return ("0x" + field.toString(16)) as Hex;
    }
}
