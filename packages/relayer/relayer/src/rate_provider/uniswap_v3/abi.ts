import type { Abi } from "viem";

// Uniswap V3 Pool ABI (subset). JuiceSwap on Citrea is a Uniswap V3-style concentrated
// liquidity AMM (see pool_addresses.md for the on-chain verification), so its pools
// implement the standard V3 pool interface. Only `observe` is needed here — pool/token
// addresses and decimals are pinned in UNISWAP_V3_POOLS (quote_obtention.ts) from
// independently verified on-chain data, not read from the contract at request time.
export const UNISWAP_V3_POOL_ABI: Abi = [
    {
        stateMutability: "view",
        type: "function",
        name: "observe",
        inputs: [{ name: "secondsAgos", type: "uint32[]" }],
        outputs: [
            { name: "tickCumulatives", type: "int56[]" },
            { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
        ],
    },
];
