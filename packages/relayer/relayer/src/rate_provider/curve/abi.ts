import type { Abi } from "viem";
// Curve Rate Provider ABI
// Contract address obtained from https://github.com/curvefi/curve-core/blob/main/deployments/prod/stable.yaml
export const RATE_PROVIDER_ABI: Abi = [
    {
        "stateMutability": "nonpayable",
        "type": "constructor",
        "inputs": [
            {
                "name": "address_provider",
                "type": "address",
            },
        ],
    },
    {
        "stateMutability": "view",
        "type": "function",
        "name": "get_quotes",
        "inputs": [
            {
                "name": "source_token",
                "type": "address",
            },
            {
                "name": "destination_token",
                "type": "address",
            },
            {
                "name": "amount_in",
                "type": "uint256",
            },
        ],
        "outputs": [
            {
                "name": "",
                "type": "tuple[]",
                "components": [
                    {
                        "name": "source_token_index",
                        "type": "uint256",
                    },
                    {
                        "name": "dest_token_index",
                        "type": "uint256",
                    },
                    {
                        "name": "is_underlying",
                        "type": "bool",
                    },
                    {
                        "name": "amount_out",
                        "type": "uint256",
                    },
                    {
                        "name": "pool",
                        "type": "address",
                    },
                    {
                        "name": "source_token_pool_balance",
                        "type": "uint256",
                    },
                    {
                        "name": "dest_token_pool_balance",
                        "type": "uint256",
                    },
                    {
                        "name": "pool_type",
                        "type": "uint8",
                    },
                ],
            },
        ],
    },
    {
        "stateMutability": "view",
        "type": "function",
        "name": "get_aggregated_rate",
        "inputs": [
            {
                "name": "source_token",
                "type": "address",
            },
            {
                "name": "destination_token",
                "type": "address",
            },
        ],
        "outputs": [
            {
                "name": "",
                "type": "uint256",
            },
        ],
    },
    {
        "stateMutability": "view",
        "type": "function",
        "name": "version",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "string",
            },
        ],
    },
    {
        "stateMutability": "view",
        "type": "function",
        "name": "ADDRESS_PROVIDER",
        "inputs": [],
        "outputs": [
            {
                "name": "",
                "type": "address",
            },
        ],
    },
];
