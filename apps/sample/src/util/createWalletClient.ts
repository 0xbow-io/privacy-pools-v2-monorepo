import type { Account, Chain, Transport, WalletClient } from "viem";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import type { Hex } from "@privacy-pools-v2/evm-sdk";

import { config } from "./config.js";

export function createSepoliaWalletClient(
    privateKey: Hex,
): WalletClient<Transport, Chain, Account> {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    return createWalletClient({
        account,
        chain: sepolia,
        transport: http(config.rpcUrl),
    });
}
