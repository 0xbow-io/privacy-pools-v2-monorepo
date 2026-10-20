/** ABI for RelaySwaps.execute / executeUnwrapped — unified processor; swap calldata rides inside
 *  transactParams.data. executeUnwrapped redeems a yield share through the given allowlisted zap first. */
export const RELAY_SWAPS_ABI = [
    {
        type: "function",
        name: "execute",
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
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "executeUnwrapped",
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
            { name: "_zap", type: "address" },
        ],
        outputs: [],
        stateMutability: "payable",
    },
] as const;

