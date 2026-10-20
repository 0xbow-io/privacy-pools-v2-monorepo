/** Default scan window for {@link IPoolSessionKeystore.discoverRevocableKeyIndex}. */
export const DEFAULT_REVOCABLE_KEY_GAP_LIMIT = 20;

/**
 * EIP-712 domain name for the Keystore, matching `__EIP712_init('PrivacyPoolsKeystore', '1')`
 * in `Keystore.sol`. Used to build the `setAuthPolicyWithSig` signing payload for the relayed
 * registration path.
 */
export const KEYSTORE_EIP712_DOMAIN_NAME = "PrivacyPoolsKeystore";

/** EIP-712 domain version for the Keystore, matching `Keystore.sol`. */
export const KEYSTORE_EIP712_DOMAIN_VERSION = "1";

/**
 * EIP-712 struct types for `setAuthPolicyWithSig`, matching `SET_AUTH_POLICY_TYPEHASH` in
 * `Keystore.sol`: `SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)`.
 * Field order is significant — it must match the on-chain `abi.encode` order exactly.
 */
export const SET_AUTH_POLICY_TYPES = {
    SetAuthPolicy: [
        { name: "account", type: "address" },
        { name: "authDigest", type: "uint256" },
        { name: "nullifyingKeyHash", type: "uint256" },
        { name: "deadline", type: "uint256" },
    ],
} as const;

/** Primary type name for the `setAuthPolicyWithSig` EIP-712 payload. */
export const SET_AUTH_POLICY_PRIMARY_TYPE = "SetAuthPolicy";

/** ABI fragments for Keystore write functions used in keystore registration and rotation. */
export const KEYSTORE_WRITE_ABI = [
    {
        type: "function",
        name: "setAuthPolicy",
        inputs: [
            { name: "_authDigest", type: "uint256" },
            { name: "_nullifyingKeyHash", type: "uint256" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "updateAuthPolicy",
        inputs: [
            { name: "_oldAuthDigest", type: "uint256" },
            { name: "_updatedAuthDigest", type: "uint256" },
            { name: "_siblingNodes", type: "uint256[]" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "setViewingKey",
        inputs: [{ name: "_viewingKey", type: "bytes32" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;
