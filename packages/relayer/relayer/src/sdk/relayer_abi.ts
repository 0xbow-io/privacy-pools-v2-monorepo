// PrivacyPoolRelay ABI — synced from v2-monorepo compiled output
export const PP_RELAY_ABI = [
    {
        "type": "constructor",
        "inputs": [
            {
                "name": "_pool",
                "type": "address",
                "internalType": "contract IPoolVault",
            },
            {
                "name": "_entrypoint",
                "type": "address",
                "internalType": "contract IEntrypoint",
            },
            {
                "name": "_announcer",
                "type": "address",
                "internalType": "contract IERC5564Announcer",
            },
        ],
        "stateMutability": "nonpayable",
    },
    {
        "type": "receive",
        "stateMutability": "payable",
    },
    {
        "type": "function",
        "name": "ENTRYPOINT",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "contract IEntrypoint",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "POOL",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
                "internalType": "contract IPoolVault",
            },
        ],
        "stateMutability": "view",
    },
    {
        "type": "function",
        "name": "relay",
        "inputs": [
            {
                "name": "_proof",
                "type": "tuple",
                "internalType": "struct ProofLibV2.TransactProof",
                "components": [
                    {
                        "name": "pA",
                        "type": "uint256[2]",
                        "internalType": "uint256[2]",
                    },
                    {
                        "name": "pB",
                        "type": "uint256[2][2]",
                        "internalType": "uint256[2][2]",
                    },
                    {
                        "name": "pC",
                        "type": "uint256[2]",
                        "internalType": "uint256[2]",
                    },
                    {
                        "name": "pubSignals",
                        "type": "uint256[][]",
                        "internalType": "uint256[][]",
                    },
                ],
            },
            {
                "name": "_transactParams",
                "type": "tuple",
                "internalType": "struct IPoolVault.TransactParams",
                "components": [
                    {
                        "name": "processor",
                        "type": "address",
                        "internalType": "address",
                    },
                    {
                        "name": "data",
                        "type": "bytes",
                        "internalType": "bytes",
                    },
                ],
            },
            {
                "name": "_noteData",
                "type": "tuple[]",
                "internalType": "struct IPoolVault.NoteData[]",
                "components": [
                    {
                        "name": "hint",
                        "type": "bytes32",
                        "internalType": "bytes32",
                    },
                    {
                        "name": "data",
                        "type": "bytes",
                        "internalType": "bytes",
                    },
                ],
            },
        ],
        "outputs": [],
        "stateMutability": "payable",
    },
    {
        "type": "function",
        "name": "registerAndRelay",
        "inputs": [
            {
                "name": "_account",
                "type": "address",
                "internalType": "address",
            },
            {
                "name": "_authDigest",
                "type": "uint256",
                "internalType": "uint256",
            },
            {
                "name": "_nullifyingKeyHash",
                "type": "uint256",
                "internalType": "uint256",
            },
            {
                "name": "_deadline",
                "type": "uint256",
                "internalType": "uint256",
            },
            {
                "name": "_signature",
                "type": "bytes",
                "internalType": "bytes",
            },
            {
                "name": "_proof",
                "type": "tuple",
                "internalType": "struct ProofLibV2.TransactProof",
                "components": [
                    { "name": "pA", "type": "uint256[2]", "internalType": "uint256[2]" },
                    { "name": "pB", "type": "uint256[2][2]", "internalType": "uint256[2][2]" },
                    { "name": "pC", "type": "uint256[2]", "internalType": "uint256[2]" },
                    { "name": "pubSignals", "type": "uint256[][]", "internalType": "uint256[][]" },
                ],
            },
            {
                "name": "_transactParams",
                "type": "tuple",
                "internalType": "struct IPoolVault.TransactParams",
                "components": [
                    { "name": "processor", "type": "address", "internalType": "address" },
                    { "name": "data", "type": "bytes", "internalType": "bytes" },
                ],
            },
            {
                "name": "_noteData",
                "type": "tuple[]",
                "internalType": "struct IPoolVault.NoteData[]",
                "components": [
                    { "name": "hint", "type": "bytes32", "internalType": "bytes32" },
                    { "name": "data", "type": "bytes", "internalType": "bytes" },
                ],
            },
        ],
        "outputs": [],
        "stateMutability": "payable",
    },
    {
        "type": "function",
        "name": "relayAndAnnounce",
        "inputs": [
            {
                "name": "_proof",
                "type": "tuple",
                "internalType": "struct ProofLibV2.TransactProof",
                "components": [
                    { "name": "pA", "type": "uint256[2]", "internalType": "uint256[2]" },
                    { "name": "pB", "type": "uint256[2][2]", "internalType": "uint256[2][2]" },
                    { "name": "pC", "type": "uint256[2]", "internalType": "uint256[2]" },
                    { "name": "pubSignals", "type": "uint256[][]", "internalType": "uint256[][]" },
                ],
            },
            {
                "name": "_transactParams",
                "type": "tuple",
                "internalType": "struct IPoolVault.TransactParams",
                "components": [
                    { "name": "processor", "type": "address", "internalType": "address" },
                    { "name": "data", "type": "bytes", "internalType": "bytes" },
                ],
            },
            {
                "name": "_noteData",
                "type": "tuple[]",
                "internalType": "struct IPoolVault.NoteData[]",
                "components": [
                    { "name": "hint", "type": "bytes32", "internalType": "bytes32" },
                    { "name": "data", "type": "bytes", "internalType": "bytes" },
                ],
            },
            {
                "name": "_announcement",
                "type": "tuple",
                "internalType": "struct IPrivacyPoolRelay.Announcement",
                "components": [
                    { "name": "schemeId", "type": "uint256", "internalType": "uint256" },
                    { "name": "stealthAddress", "type": "address", "internalType": "address" },
                    { "name": "ephemeralPubKey", "type": "bytes", "internalType": "bytes" },
                    { "name": "metadata", "type": "bytes", "internalType": "bytes" },
                ],
            },
        ],
        "outputs": [],
        "stateMutability": "payable",
    },
    {
        "type": "event",
        "name": "Relayed",
        "inputs": [
            {
                "name": "_asset",
                "type": "address",
                "indexed": true,
                "internalType": "address",
            },
            {
                "name": "_recipient",
                "type": "address",
                "indexed": true,
                "internalType": "address",
            },
            {
                "name": "_recipientAmount",
                "type": "uint256",
                "indexed": false,
                "internalType": "uint256",
            },
            {
                "name": "_feeRecipient",
                "type": "address",
                "indexed": true,
                "internalType": "address",
            },
            {
                "name": "_fee",
                "type": "uint256",
                "indexed": false,
                "internalType": "uint256",
            },
            {
                "name": "_gasFunding",
                "type": "uint256",
                "indexed": false,
                "internalType": "uint256",
            },
        ],
        "anonymous": false,
    },
    {
        "type": "function",
        "name": "relayBatch",
        "inputs": [
            {
                "name": "_proofs",
                "type": "tuple[]",
                "internalType": "struct ProofLibV2.TransactProof[]",
                "components": [
                    { "name": "pA", "type": "uint256[2]", "internalType": "uint256[2]" },
                    { "name": "pB", "type": "uint256[2][2]", "internalType": "uint256[2][2]" },
                    { "name": "pC", "type": "uint256[2]", "internalType": "uint256[2]" },
                    { "name": "pubSignals", "type": "uint256[][]", "internalType": "uint256[][]" },
                ],
            },
            {
                "name": "_transactParams",
                "type": "tuple[]",
                "internalType": "struct IPoolVault.TransactParams[]",
                "components": [
                    { "name": "processor", "type": "address", "internalType": "address" },
                    { "name": "data", "type": "bytes", "internalType": "bytes" },
                ],
            },
            {
                "name": "_noteData",
                "type": "tuple[][]",
                "internalType": "struct IPoolVault.NoteData[][]",
                "components": [
                    { "name": "hint", "type": "bytes32", "internalType": "bytes32" },
                    { "name": "data", "type": "bytes", "internalType": "bytes" },
                ],
            },
        ],
        "outputs": [],
        "stateMutability": "payable",
    },
    {
        "type": "function",
        "name": "MAX_BATCH",
        "inputs": [],
        "outputs": [{ "name": "_maxBatch", "type": "uint256", "internalType": "uint256" }],
        "stateMutability": "pure",
    },
    {
        "type": "event",
        "name": "RelayedBatch",
        "inputs": [
            { "name": "_asset", "type": "address", "indexed": true, "internalType": "address" },
            { "name": "_recipient", "type": "address", "indexed": true, "internalType": "address" },
            { "name": "_recipientAmount", "type": "uint256", "indexed": false, "internalType": "uint256" },
            { "name": "_feeRecipient", "type": "address", "indexed": true, "internalType": "address" },
            { "name": "_fee", "type": "uint256", "indexed": false, "internalType": "uint256" },
            { "name": "_gasFunding", "type": "uint256", "indexed": false, "internalType": "uint256" },
            { "name": "_count", "type": "uint256", "indexed": false, "internalType": "uint256" },
        ],
        "anonymous": false,
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_BatchTooLarge",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_EmptyBatch",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_BatchLengthMismatch",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_InconsistentAsset",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_InconsistentRecipient",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_FeeExceedsMax",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_FeeExceedsWithdrawal",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_NativeGasMismatch",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_OnlyPoolCanSendETH",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_ZeroEntrypoint",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_ZeroPool",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_ZeroWithdrawal",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_ZeroRecipient",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_AnnouncementRecipientMismatch",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_ZeroAnnouncer",
        "inputs": [],
    },
    {
        "type": "error",
        "name": "PrivacyPoolRelay_RootHistoryTooSmall",
        "inputs": [],
    },
] as const;
