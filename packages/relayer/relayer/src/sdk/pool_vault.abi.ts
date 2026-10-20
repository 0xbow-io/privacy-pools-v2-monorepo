// PoolVault ABI — synced from v2-monorepo contracts IPoolVault interface
export const POOL_VAULT_ABI = [
    {
        type: "function",
        name: "transact",
        inputs: [
            {
                name: "_proof",
                type: "tuple",
                internalType: "struct ProofLibV2.TransactProof",
                components: [
                    {
                        name: "pA",
                        type: "uint256[2]",
                        internalType: "uint256[2]",
                    },
                    {
                        name: "pB",
                        type: "uint256[2][2]",
                        internalType: "uint256[2][2]",
                    },
                    {
                        name: "pC",
                        type: "uint256[2]",
                        internalType: "uint256[2]",
                    },
                    {
                        name: "pubSignals",
                        type: "uint256[][]",
                        internalType: "uint256[][]",
                    },
                ],
            },
            {
                name: "_transactParams",
                type: "tuple",
                internalType: "struct IPoolVault.TransactParams",
                components: [
                    {
                        name: "processor",
                        type: "address",
                        internalType: "address",
                    },
                    {
                        name: "data",
                        type: "bytes",
                        internalType: "bytes",
                    },
                ],
            },
            {
                name: "_noteData",
                type: "tuple[]",
                internalType: "struct IPoolVault.NoteData[]",
                components: [
                    {
                        name: "hint",
                        type: "bytes32",
                        internalType: "bytes32",
                    },
                    {
                        name: "data",
                        type: "bytes",
                        internalType: "bytes",
                    },
                ],
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "rootHistorySize",
        inputs: [],
        outputs: [{ name: "_size", type: "uint32", internalType: "uint32" }],
        stateMutability: "view",
    },
] as const;
