// Privacy Pools Entrypoint ABI
// TODO: Fill in the actual ABI entries for the entrypoint contract
export const ENTRYPOINT_ABI = [
    {
        name: "assets",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "_asset", type: "address" }],
        outputs: [
            {
                name: "config_",
                type: "tuple",
                components: [
                    { name: "_pool", type: "address" },
                    { name: "vettingFeeBPS", type: "uint16" },
                    { name: "minAmount", type: "uint256" },
                    { name: "maxRelayFee", type: "uint256" },
                ],
            },
        ],
    },
] as const;
