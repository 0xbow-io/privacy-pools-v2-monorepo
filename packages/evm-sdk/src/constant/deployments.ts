import type { Address, DeploymentAddresses } from "../internal.js";

/** Sepolia chain ID (EIP-155). */
export const SEPOLIA_CHAIN_ID = 11155111;

/**
 * Canonical Privacy Pools V2 contract addresses by chainId.
 *
 * `PoolSessionBuilder` reads this map when no `deployment` is supplied in
 * config. Consumers can still override by passing `config.deployment`
 * explicitly.
 *
 * Sepolia entry is the V9 deployment (proxy addresses — they survive
 * implementation upgrades). Source of truth: `sepolia-deployment-v9.md` at
 * the repo root; update this map whenever a re-deployment doc lands.
 * Mainnet is not yet deployed.
 */
export const DEPLOYMENTS: Readonly<Record<number, DeploymentAddresses>> = Object.freeze({
    [SEPOLIA_CHAIN_ID]: {
        poolAddress: "0x09b94d3127019298757A6ceeB7911922085f7C01" as Address,
        entrypointAddress: "0xEB3e3961008952348445513e418ad6F43C23ca9a" as Address,
        keystoreAddress: "0x6d264aCb9C3A7A3105c29470AfE2F5F1EC203C73" as Address,
        aspRegistryAddress: "0x35D29EFDCf067599ab4A53cf40229477f0b1cA9c" as Address,
        // TODO: populate with the deployed RelaySwaps address once Sepolia deployment lands.
        relaySwapsAddress: "0x0000000000000000000000000000000000000000" as Address,
    },
});
