import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
    MerkleService,
    PoseidonHashService,
    ViemRPCInteractor,
} from "@privacy-pools-v2/evm-sdk";
import type { Hash, Hex } from "@privacy-pools-v2/evm-sdk";

import { loadTestConfig } from "../setup/env.js";
import type { BoundWalletClient, TestContext } from "./types.js";

/**
 * Creates a fresh TestContext with faucet wallet, postman wallet,
 * shared services, and empty ASP state.
 */
export async function createTestContext(): Promise<TestContext> {
    const config = loadTestConfig();

    const faucetAccount = privateKeyToAccount(config.faucetPrivateKey as `0x${string}`);
    const faucetWallet = createWalletClient({
        account: faucetAccount,
        chain: sepolia,
        transport: http(config.rpcUrl),
    }) as BoundWalletClient;

    const postmanAccount = privateKeyToAccount(config.postmanPrivateKey as `0x${string}`);
    const postmanWallet = createWalletClient({
        account: postmanAccount,
        chain: sepolia,
        transport: http(config.rpcUrl),
    }) as BoundWalletClient;

    const rpcInteractor = ViemRPCInteractor.create({
        rpcUrl: config.rpcUrl,
        chain: sepolia,
    });

    const hashService = await PoseidonHashService.create();
    const merkleService = new MerkleService({ hashService });

    return {
        faucetWallet,
        faucetAddress: faucetAccount.address as Hex,
        postmanWallet,
        postmanAddress: postmanAccount.address as Hex,
        rpcInteractor,
        hashService,
        merkleService,
        actors: [],
        aspLeaves: [],
        aspRoot: "0x0" as Hash,
        config,
    };
}
