// PPRouter `withdrawToUnderlying` ABI — jest/CJS-safe MIRROR of the SDK's
// canonical `PP_ROUTER_WITHDRAW_ABI` (`@privacy-pools-v2/evm-sdk`, defined in
// `packages/evm-sdk/src/constant/Yield.ts`).
//
// Why a local mirror instead of `import { PP_ROUTER_WITHDRAW_ABI } from
// "@privacy-pools-v2/evm-sdk"`: the SDK's MAIN entry (`dist/index.cjs`) transitively
// `require`s ESM-only packages (`@noble/ciphers`, `multiformats/cid`, ...). The
// relayer is a CommonJS NestJS app; under `node dist/main` (Node >= 22.12) the
// native `require(ESM)` handles this, but this package's `ts-jest` runtime does
// NOT — every spec that loads the chain service would die on `Cannot use import
// statement outside a module` / unresolved ESM subpaths. This is the SAME
// limitation the SDK-drift tests already document (`fee_abi.golden.spec.ts`,
// `schemas.batch-wire.spec.ts`). Those close the gap with golden/drift tests
// rather than importing the SDK main entry under jest; this file follows the
// same pattern.
//
// Drift guard: this fragment's shape (function name + input/output types) is
// pinned by `pprouter_abi.golden.spec.ts`. Keep it structurally identical to the
// SDK's `PP_ROUTER_WITHDRAW_ABI` (proof tuple / transactParams tuple / noteData
// tuple[] / `minUnderlyingOut` uint256 -> two uint256 outputs).
export const PP_ROUTER_WITHDRAW_ABI = [
    {
        type: "function",
        name: "withdrawToUnderlying",
        inputs: [
            {
                name: "proof",
                type: "tuple",
                components: [
                    { name: "pA", type: "uint256[2]" },
                    { name: "pB", type: "uint256[2][2]" },
                    { name: "pC", type: "uint256[2]" },
                    { name: "pubSignals", type: "uint256[][]" },
                ],
            },
            {
                name: "transactParams",
                type: "tuple",
                components: [
                    { name: "processor", type: "address" },
                    { name: "data", type: "bytes" },
                ],
            },
            {
                name: "noteData",
                type: "tuple[]",
                components: [
                    { name: "hint", type: "bytes32" },
                    { name: "data", type: "bytes" },
                ],
            },
            { name: "minUnderlyingOut", type: "uint256" },
        ],
        outputs: [
            { name: "toRecipient", type: "uint256" },
            { name: "fee", type: "uint256" },
        ],
        stateMutability: "payable",
    },
] as const;
