import type { Hex } from "../internal.js";

/** Authorization type for direct key authorization (v2.0). */
const AUTH_TYPE_DIRECT_KEY: Hex = "0x0";

/** Standard note metadata (v2.0). */
const METADATA_STANDARD: Hex = "0x0";

/**
 * Domain-separation tag for commitment leaves in the state tree.
 * Poseidon(BigInt(Buffer.from("privacy_pools_note","utf-8")))
 */
const COMMITMENT_LEAF_TAG: Hex =
    "0x086205d9d9e32ce53fc309585685ddb629e878ddd2dd04f575089c3a421342d9";

/**
 * Maximum keystore Merkle tree depth — matches the circuit parameter `keystoreMaxDepth`.
 * @see circuits/main/ragequit.circom — Ragequit(18)
 * @see circuits/templates/Transact.circom — Transact(…, keystoreMaxDepth=18, …)
 */
const KEYSTORE_MAX_DEPTH = 18;

/**
 * Maximum state Merkle tree depth — matches the circuit parameter `stateMaxDepth`.
 * @see circuits/templates/Transact.circom — Transact(…, stateMaxDepth=22, …)
 */
const STATE_MAX_DEPTH = 22;

/**
 * Maximum association set Merkle tree depth — matches the circuit parameter `associationSetMaxDepth`.
 * @see circuits/templates/Transact.circom — Transact(…, associationSetMaxDepth=18)
 */
const ASSOCIATION_SET_MAX_DEPTH = 18;

export {
    AUTH_TYPE_DIRECT_KEY,
    METADATA_STANDARD,
    COMMITMENT_LEAF_TAG,
    KEYSTORE_MAX_DEPTH,
    STATE_MAX_DEPTH,
    ASSOCIATION_SET_MAX_DEPTH,
};
