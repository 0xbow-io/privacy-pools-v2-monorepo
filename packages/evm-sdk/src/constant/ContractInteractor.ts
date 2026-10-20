/**
 * Minimal ABI fragment for read-only Entrypoint calls.
 *
 * NOTE: The `assets` tuple field order is (enabled, minAmount, vettingFeeBPS, maxRelayFee)
 * and all numeric fields are uint256. Earlier SDK versions used uint16 for vettingFeeBPS,
 * which returned `number`; the current version returns `bigint` via uint256. External
 * consumers of the `AssetConfig` type should account for this.
 */
export const ENTRYPOINT_ABI = [
    {
        type: "function",
        name: "poolVault",
        inputs: [],
        outputs: [{ name: "_poolVault", type: "address" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "aspRegistry",
        inputs: [],
        outputs: [{ name: "_aspRegistry", type: "address" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "assets",
        inputs: [{ name: "_asset", type: "address" }],
        outputs: [
            {
                name: "config_",
                type: "tuple",
                components: [
                    { name: "enabled", type: "bool" },
                    { name: "minAmount", type: "uint256" },
                    { name: "vettingFeeBPS", type: "uint256" },
                    { name: "maxRelayFee", type: "uint256" },
                ],
            },
        ],
        stateMutability: "view",
    },
] as const;

/** Minimal ABI fragment for read-only PoolVault calls. */
export const POOL_VAULT_ABI = [
    {
        type: "function",
        name: "commitments",
        inputs: [{ name: "_commitmentHash", type: "uint256" }],
        outputs: [{ name: "createdAt_", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "spentNullifiers",
        inputs: [{ name: "_nullifierHash", type: "uint256" }],
        outputs: [{ name: "when_", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "isKnownRoot",
        inputs: [{ name: "_root", type: "uint256" }],
        outputs: [{ name: "isKnown_", type: "bool" }],
        stateMutability: "view",
    },
] as const;

/** Minimal ABI fragment for read-only Keystore calls. */
export const KEYSTORE_ABI = [
    {
        type: "function",
        name: "nullifyingKeys",
        inputs: [{ name: "_account", type: "address" }],
        outputs: [{ name: "nullifyingKeyHash_", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "viewingKeys",
        inputs: [{ name: "_account", type: "address" }],
        outputs: [{ name: "viewingKey_", type: "bytes32" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "isKnownRoot",
        inputs: [{ name: "_root", type: "uint256" }],
        outputs: [{ name: "isKnown_", type: "bool" }],
        stateMutability: "view",
    },
] as const;

/** ABI event fragments for Keystore tree leaf updates (from ITreeUpdates). */
export const KEYSTORE_EVENTS_ABI = [
    {
        type: "event",
        name: "LeafInserted",
        inputs: [
            { name: "_newLeaf", type: "uint256", indexed: false },
            { name: "_root", type: "uint256", indexed: false },
            { name: "_leafIndex", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "LeafUpdated",
        inputs: [
            { name: "_newLeaf", type: "uint256", indexed: false },
            { name: "_root", type: "uint256", indexed: false },
            { name: "_leafIndex", type: "uint256", indexed: false },
        ],
    },
] as const;

/** ABI event fragments for per-account auth-policy lifecycle (used by revocable-key index discovery). */
export const KEYSTORE_AUTH_EVENTS_ABI = [
    {
        type: "event",
        name: "AuthPolicySet",
        inputs: [
            { name: "_account", type: "address", indexed: true },
            { name: "_nullifyingKeyHash", type: "uint256", indexed: false },
            { name: "_authDigest", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "AuthPolicyUpdated",
        inputs: [
            { name: "_account", type: "address", indexed: true },
            { name: "_oldAuthDigest", type: "uint256", indexed: false },
            { name: "_authDigest", type: "uint256", indexed: false },
        ],
    },
] as const;

/** Minimal ABI fragment for read-only ASPRegistry calls. */
export const ASP_REGISTRY_ABI = [
    {
        type: "function",
        name: "latestASPRoot",
        inputs: [],
        outputs: [{ name: "root_", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "latestIPFSCID",
        inputs: [],
        outputs: [{ name: "ipfsCID_", type: "bytes" }],
        stateMutability: "view",
    },
] as const;

/** Minimal ABI fragment for the Entrypoint deposit function. */
export const ENTRYPOINT_DEPOSIT_ABI = [
    {
        type: "function",
        name: "deposit",
        inputs: [
            {
                name: "_proof",
                type: "tuple",
                components: [
                    { name: "pA", type: "uint256[2]" },
                    { name: "pB", type: "uint256[2][2]" },
                    { name: "pC", type: "uint256[2]" },
                    { name: "pubSignals", type: "uint256[4]" },
                ],
            },
            {
                name: "_noteData",
                type: "tuple",
                components: [
                    { name: "hint", type: "bytes32" },
                    { name: "data", type: "bytes" },
                ],
            },
            { name: "_aspCiphertext", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "payable",
    },
] as const;

/** Minimal ABI fragment for the PoolVault ragequit function. */
export const POOL_VAULT_RAGEQUIT_ABI = [
    {
        type: "function",
        name: "ragequit",
        inputs: [
            {
                name: "_proof",
                type: "tuple",
                components: [
                    { name: "pA", type: "uint256[2]" },
                    { name: "pB", type: "uint256[2][2]" },
                    { name: "pC", type: "uint256[2]" },
                    { name: "pubSignals", type: "uint256[7]" },
                ],
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

/** ABI event fragments for PoolVault state tree leaf updates (from ITreeUpdates). */
export const POOL_VAULT_EVENTS_ABI = [
    {
        type: "event",
        name: "LeafInserted",
        inputs: [
            { name: "_newLeaf", type: "uint256", indexed: false },
            { name: "_root", type: "uint256", indexed: false },
            { name: "_leafIndex", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "LeavesInserted",
        inputs: [
            { name: "_newLeaves", type: "uint256[]", indexed: false },
            { name: "_root", type: "uint256", indexed: false },
            { name: "_startIndex", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "LeafUpdated",
        inputs: [
            { name: "_newLeaf", type: "uint256", indexed: false },
            { name: "_root", type: "uint256", indexed: false },
            { name: "_leafIndex", type: "uint256", indexed: false },
        ],
    },
] as const;

/**
 * Narrow ABI for state-tree leaf reconstruction. PoolVault emits
 * `LeavesInserted` for every tree mutation (deposit, transact, ragequit), so
 * this single event is sufficient to rebuild the leaf array. Used by the
 * paginated leaf-fetch path; keeping the ABI narrow reduces per-chunk response
 * size and lowers the chance of hitting RPC log-count limits.
 */
export const POOL_VAULT_LEAVES_INSERTED_ABI = [
    {
        type: "event",
        name: "LeavesInserted",
        inputs: [
            { name: "_newLeaves", type: "uint256[]", indexed: false },
            { name: "_root", type: "uint256", indexed: false },
            { name: "_startIndex", type: "uint256", indexed: false },
        ],
    },
] as const;

/**
 * Combined ABI event fragments covering all PoolVault tree-mutation events.
 * Retained for callers that need the full event set; leaf reconstruction uses
 * {@link POOL_VAULT_LEAVES_INSERTED_ABI} instead.
 */
export const POOL_VAULT_ALL_EVENTS_ABI = [
    ...POOL_VAULT_EVENTS_ABI,
    {
        type: "event",
        name: "Transacted",
        inputs: [
            { name: "outputCommitments", type: "uint256[]", indexed: false },
            { name: "nullifierHashes", type: "uint256[]", indexed: false },
            { name: "asset", type: "address", indexed: true },
            { name: "withdrawnValue", type: "uint256", indexed: false },
            { name: "caller", type: "address", indexed: true },
        ],
    },
    {
        type: "event",
        name: "Ragequit",
        inputs: [
            { name: "ragequitter", type: "address", indexed: true },
            { name: "asset", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
            { name: "commitment", type: "uint256", indexed: false },
            { name: "nullifierHash", type: "uint256", indexed: false },
            { name: "label", type: "uint256", indexed: false },
        ],
    },
] as const;

/** ABI event fragment for the PoolVault Note event (emitted per output note). */
export const POOL_VAULT_NOTE_EVENT_ABI = [
    {
        type: "event",
        name: "Note",
        inputs: [
            { name: "hint", type: "bytes32", indexed: true },
            { name: "data", type: "bytes", indexed: false },
        ],
    },
] as const;

/** ABI event fragment for the PoolVault Transacted event (emitted per successful transact call). */
export const POOL_VAULT_TRANSACTED_EVENT_ABI = [
    {
        type: "event",
        name: "Transacted",
        inputs: [
            { name: "outputCommitments", type: "uint256[]", indexed: false },
            { name: "nullifierHashes", type: "uint256[]", indexed: false },
            { name: "asset", type: "address", indexed: true },
            { name: "withdrawnValue", type: "uint256", indexed: false },
            { name: "caller", type: "address", indexed: true },
        ],
    },
] as const;

/** ABI event fragment for the PoolVault Deposited event (emitted per successful deposit). */
export const POOL_VAULT_DEPOSITED_EVENT_ABI = [
    {
        type: "event",
        name: "Deposited",
        inputs: [
            { name: "outputCommitment", type: "uint256", indexed: false },
            { name: "asset", type: "address", indexed: true },
            { name: "depositedValue", type: "uint256", indexed: false },
            { name: "caller", type: "address", indexed: true },
        ],
    },
] as const;

/** ABI event fragment for the PoolVault Ragequit event (emitted per successful ragequit call). */
export const POOL_VAULT_RAGEQUIT_EVENT_ABI = [
    {
        type: "event",
        name: "Ragequit",
        inputs: [
            { name: "ragequitter", type: "address", indexed: true },
            { name: "asset", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
            { name: "commitment", type: "uint256", indexed: false },
            { name: "nullifierHash", type: "uint256", indexed: false },
            { name: "label", type: "uint256", indexed: false },
        ],
    },
] as const;

/** Minimal ABI fragment for the PoolVault transact function. */
export const POOL_VAULT_TRANSACT_ABI = [
    {
        type: "function",
        name: "transact",
        inputs: [
            {
                name: "_proof",
                type: "tuple",
                components: [
                    { name: "pA", type: "uint256[2]" },
                    { name: "pB", type: "uint256[2][2]" },
                    { name: "pC", type: "uint256[2]" },
                    { name: "pubSignals", type: "uint256[][]" },
                ],
            },
            {
                name: "_transactParams",
                type: "tuple",
                components: [
                    { name: "processor", type: "address" },
                    { name: "data", type: "bytes" },
                ],
            },
            {
                name: "_noteData",
                type: "tuple[]",
                components: [
                    { name: "hint", type: "bytes32" },
                    { name: "data", type: "bytes" },
                ],
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

/**
 * Minimal ABI for `PrivacyPoolRelay.relayBatch` — the array form of transact used by
 * the self-submit batch path (a gas-paying user submits their own atomic batch with a
 * zero fee, instead of routing through a relayer). Mirrors the on-chain
 * `relayBatch(TransactProof[], TransactParams[], NoteData[][])`; each `TransactProof`
 * tuple is identical to the single `transact` proof, just wrapped in an array.
 */
export const PP_RELAY_BATCH_ABI = [
    {
        type: "function",
        name: "relayBatch",
        inputs: [
            {
                name: "_proofs",
                type: "tuple[]",
                components: [
                    { name: "pA", type: "uint256[2]" },
                    { name: "pB", type: "uint256[2][2]" },
                    { name: "pC", type: "uint256[2]" },
                    { name: "pubSignals", type: "uint256[][]" },
                ],
            },
            {
                name: "_transactParams",
                type: "tuple[]",
                components: [
                    { name: "processor", type: "address" },
                    { name: "data", type: "bytes" },
                ],
            },
            {
                name: "_noteData",
                type: "tuple[][]",
                components: [
                    { name: "hint", type: "bytes32" },
                    { name: "data", type: "bytes" },
                ],
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
] as const;

/** Minimal ABI fragment for ERC20 allowance reads. */
export const ERC20_ABI = [
    {
        type: "function",
        name: "allowance",
        inputs: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
] as const;

/** Minimal ABI fragment for ERC20 approve writes. */
export const ERC20_APPROVE_ABI = [
    {
        type: "function",
        name: "approve",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "nonpayable",
    },
] as const;
