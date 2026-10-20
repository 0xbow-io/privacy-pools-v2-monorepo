export const FeeDataAbi = [
    {
        name: "FeeData",
        type: "tuple",
        components: [
            { name: "recipient", type: "address" },
            { name: "feeRecipient", type: "address" },
            { name: "relayFeeAmount", type: "uint256" },
        ],
    },
] as const;
