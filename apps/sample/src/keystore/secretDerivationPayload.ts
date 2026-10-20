import { APP_IDENTIFIER } from "@privacy-pools-v2/evm-sdk";
import type { Hex } from "@privacy-pools-v2/evm-sdk";
import type { Address } from "viem";
import { keccak256, toBytes, toHex } from "viem";

/**
 * Human-readable purpose string shown to the user by the wallet during the
 * EIP-712 prompt. Must stay byte-for-byte stable across SDK releases — the
 * string is part of the typed-data hash and thus part of the derivation key.
 */
const SECRET_DERIVATION_PURPOSE =
    "This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.";

export type SecretDerivationTypedData = {
    readonly domain: {
        readonly name: "Standardized Secret Derivation";
        readonly version: "1";
        readonly verifyingContract: Hex;
        readonly salt: Hex;
    };
    readonly message: {
        readonly purpose: string;
        readonly addressHash: Hex;
    };
    readonly primaryType: "SecretDerivation";
    readonly types: {
        readonly EIP712Domain: ReadonlyArray<{ readonly name: string; readonly type: string }>;
        readonly SecretDerivation: ReadonlyArray<{ readonly name: string; readonly type: string }>;
    };
};

/**
 * Builds the spec-compliant EIP-712 payload for the Signature-Based Derivation
 * flow.
 *
 * Lives here (not in the SDK) per the "no key derivation in SDK" contract: the
 * SDK consumes the resulting `(signature, signerAddress, addressHash)` tuple
 * only. Integrators that want a different prompt string or domain must build
 * their own typed data — this helper is the reference shape used by the sample
 * scripts.
 */
export function buildSecretDerivationPayload(signerAddress: Address): SecretDerivationTypedData {
    const addressHash = keccak256(toBytes(signerAddress));
    const salt = keccak256(toHex(APP_IDENTIFIER));

    return {
        domain: {
            name: "Standardized Secret Derivation",
            version: "1",
            verifyingContract: "0x0000000000000000000000000000000000000000",
            salt,
        },
        message: {
            purpose: SECRET_DERIVATION_PURPOSE,
            addressHash,
        },
        primaryType: "SecretDerivation",
        types: {
            EIP712Domain: [
                { name: "name", type: "string" },
                { name: "version", type: "string" },
                { name: "verifyingContract", type: "address" },
                { name: "salt", type: "bytes32" },
            ],
            SecretDerivation: [
                { name: "purpose", type: "string" },
                { name: "addressHash", type: "bytes32" },
            ],
        },
    };
}
