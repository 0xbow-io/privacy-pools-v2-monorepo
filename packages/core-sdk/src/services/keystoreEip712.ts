import type { Address, Eip712TypedData, Hex } from "../internal.js";
import {
    KEYSTORE_EIP712_DOMAIN_NAME,
    KEYSTORE_EIP712_DOMAIN_VERSION,
    SET_AUTH_POLICY_PRIMARY_TYPE,
    SET_AUTH_POLICY_TYPES,
} from "../internal.js";

/** Arguments for {@link buildSetAuthPolicyTypedData}. */
export interface BuildSetAuthPolicyTypedDataArgs {
    /** Address of the Keystore contract that will verify the signature. */
    keystoreAddress: Address;
    /** Chain the signature is valid on. */
    chainId: number;
    /** Account being registered (the signer). */
    account: Address;
    /** Authorization digest to register, as 0x-prefixed hex. */
    authDigest: Hex;
    /** Poseidon(privateNullifyingKey), as 0x-prefixed hex. */
    nullifyingKeyHash: Hex;
    /** Unix-seconds deadline after which the signature is rejected, as 0x-prefixed hex. */
    deadline: Hex;
}

/**
 * Builds the EIP-712 typed-data payload for `Keystore.setAuthPolicyWithSig`, matching
 * `SET_AUTH_POLICY_TYPEHASH` and the `PrivacyPoolsKeystore`/`1` domain in `Keystore.sol`.
 *
 * The account signs this payload; a relayer then submits it (standalone via
 * `setAuthPolicyWithSig`, or atomically via `PrivacyPoolRelay.registerAndRelay`). The
 * `uint256` fields are carried as `bigint` so the signature matches the contract's
 * `abi.encode(..., uint256, uint256, uint256)` exactly.
 */
export function buildSetAuthPolicyTypedData(
    args: BuildSetAuthPolicyTypedDataArgs,
): Eip712TypedData {
    return {
        domain: {
            name: KEYSTORE_EIP712_DOMAIN_NAME,
            version: KEYSTORE_EIP712_DOMAIN_VERSION,
            chainId: args.chainId,
            verifyingContract: args.keystoreAddress,
        },
        types: SET_AUTH_POLICY_TYPES,
        primaryType: SET_AUTH_POLICY_PRIMARY_TYPE,
        message: {
            account: args.account,
            authDigest: BigInt(args.authDigest),
            nullifyingKeyHash: BigInt(args.nullifyingKeyHash),
            deadline: BigInt(args.deadline),
        },
    };
}
