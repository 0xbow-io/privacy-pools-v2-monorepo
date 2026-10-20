import type { Address } from "../internal.js";

/** Default LiFi integrator identifier sent with API requests. */
export const DEFAULT_LIFI_INTEGRATOR = "privacy-pools-v2";

/**
 * Minimal ABI fragment for RelaySwaps.approvedRouters(address).
 * Used by both PoolSessionSwapDeposit and PoolSessionReshield to validate
 * that a LiFi quote's transactionTo / approvalAddress is on the protocol
 * owner's vetted router allowlist before submitting or proof-binding it.
 */
export const RELAY_SWAPS_APPROVED_ROUTERS_ABI = [
    {
        name: "approvedRouters",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "bool" }],
    },
] as const;

/**
 * Minimal ABI fragment for RelaySwaps.ROUTING_TYPEHASH(). RC-32: SwapRouting is never part
 * of any external function's ABI (execute() decodes it from opaque bytes), so a client and
 * an older deployed RelaySwaps can silently disagree on its shape until a proof has already
 * been spent on a call that panics mid-decode. Read alongside RELAY_SWAPS_APPROVED_ROUTERS_ABI
 * before proving and compare against RELAY_SWAP_ROUTING_TYPEHASH.
 */
export const RELAY_SWAPS_ROUTING_TYPEHASH_ABI = [
    {
        name: "ROUTING_TYPEHASH",
        type: "function",
        stateMutability: "pure",
        inputs: [],
        outputs: [{ name: "", type: "bytes32" }],
    },
] as const;

/**
 * `RelaySwaps.approvedZaps(zap)` — the owner allowlist of PPYieldTokenZaps that
 * `executeUnwrapped()` may redeem yield shares through. The SDK reads it pre-proof so a yield
 * note is never bound to a swap the processor will refuse.
 */
export const RELAY_SWAPS_APPROVED_ZAPS_ABI = [
    {
        type: "function",
        name: "approvedZaps",
        stateMutability: "view",
        inputs: [{ name: "zap", type: "address" }],
        outputs: [{ name: "", type: "bool" }],
    },
] as const;

/**
 * ABI fragment for CalldataVerificationFacet.extractMainParameters.
 * Used by PoolSessionWithdrawAndSwap to verify the swap output recipient
 * on cross-chain paths by decoding BridgeData.receiver from transactionData.
 * Confirmed live on the LiFi Diamond on Arbitrum mainnet (2026-07-23).
 */
export const CALLDATA_VERIFICATION_EXTRACT_MAIN_ABI = [
    {
        name: "extractMainParameters",
        type: "function",
        stateMutability: "pure",
        inputs: [{ name: "data", type: "bytes" }],
        outputs: [
            { name: "bridge", type: "string" },
            { name: "sendingAssetId", type: "address" },
            { name: "receiver", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "destinationChainId", type: "uint256" },
            { name: "hasSourceSwaps", type: "bool" },
            { name: "hasDestinationCall", type: "bool" },
        ],
    },
] as const;

/**
 * ABI fragment for CalldataVerificationFacet.extractGenericSwapParameters.
 * Used by PoolSessionWithdrawAndSwap to verify the swap output recipient
 * on same-chain paths by decoding the GenericSwapFacet receiver param.
 * Confirmed live on the LiFi Diamond on Arbitrum mainnet (2026-07-23).
 */
export const CALLDATA_VERIFICATION_EXTRACT_SWAP_ABI = [
    {
        name: "extractGenericSwapParameters",
        type: "function",
        stateMutability: "pure",
        inputs: [{ name: "data", type: "bytes" }],
        outputs: [
            { name: "sendingAssetId", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "receiver", type: "address" },
            { name: "receivingAssetId", type: "address" },
            { name: "receivingAmount", type: "uint256" },
        ],
    },
] as const;

/**
 * LiFi's Executor and the ERC20Proxy it pulls the caller's tokens through, by chain id
 * (lifinance/contracts `deployments/<chain>.json`; each `Executor.erc20Proxy()` read on-chain
 * 2026-10-02). Used to compose a same-chain swap into a native-coin deposit as one
 * `swapAndExecute` call. A chain absent here refuses that deposit.
 */
export const LIFI_SWAP_EXECUTORS: Readonly<Record<number, { executor: Address; erc20Proxy: Address }>> = {
    1: {
        executor: "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88",
        erc20Proxy: "0x68E1Acfa805dcA813116Ed6507E01c38D44318f0",
    },
    10: {
        executor: "0xC9E66aa9b08EB667e450e072E96F7086AD9f2c91",
        erc20Proxy: "0x314bE5fcf0A204837896e6028C47A9e1FC2919c7",
    },
    56: {
        executor: "0x2dfaDAB8266483beD9Fd9A292Ce56596a2D1378D",
        erc20Proxy: "0x5741A7FfE7c39Ca175546a54985fA79211290b51",
    },
    8453: {
        executor: "0x4DaC9d1769b9b304cb04741DCDEb2FC14aBdF110",
        erc20Proxy: "0x74a55CaDb12501A3707E9F3C5dfd8b563C6A5940",
    },
};

/** `Executor.swapAndExecute`: each `LibSwap.SwapData` call is sent its `fromAmount` as `msg.value` when native. */
export const LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI = [
    {
        name: "swapAndExecute",
        type: "function",
        stateMutability: "payable",
        inputs: [
            { name: "_transactionId", type: "bytes32" },
            {
                name: "_swapData",
                type: "tuple[]",
                components: [
                    { name: "callTo", type: "address" },
                    { name: "approveTo", type: "address" },
                    { name: "sendingAssetId", type: "address" },
                    { name: "receivingAssetId", type: "address" },
                    { name: "fromAmount", type: "uint256" },
                    { name: "callData", type: "bytes" },
                    { name: "requiresDeposit", type: "bool" },
                ],
            },
            { name: "_transferredAssetId", type: "address" },
            { name: "_receiver", type: "address" },
            { name: "_amount", type: "uint256" },
        ],
        outputs: [],
    },
] as const;

/**
 * The rest of LiFi's Executor surface the SDK screens for. `swapAndCompleteBridgeTokens` pulls
 * the caller's whole allowance to the Executor itself; `erc20Proxy()` identifies an Executor
 * on-chain (the Diamond and the ERC20Proxy revert on it).
 */
export const LIFI_EXECUTOR_SCREENING_ABI = [
    {
        name: "swapAndCompleteBridgeTokens",
        type: "function",
        stateMutability: "payable",
        inputs: [
            { name: "_transactionId", type: "bytes32" },
            {
                name: "_swapData",
                type: "tuple[]",
                components: [
                    { name: "callTo", type: "address" },
                    { name: "approveTo", type: "address" },
                    { name: "sendingAssetId", type: "address" },
                    { name: "receivingAssetId", type: "address" },
                    { name: "fromAmount", type: "uint256" },
                    { name: "callData", type: "bytes" },
                    { name: "requiresDeposit", type: "bool" },
                ],
            },
            { name: "_transferredAssetId", type: "address" },
            { name: "_receiver", type: "address" },
        ],
        outputs: [],
    },
    {
        name: "erc20Proxy",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
] as const;
