/**
 * DEV-ONLY TOOLING — NOT SHIPPED SDK CODE.
 *
 * Deploys MockERC20 + MockRouter + RelaySwaps against the local anvil fork of real Sepolia (see
 * ../local-mock-asp/server.ts's doc comment for the fork setup), so withdraw-and-swap /
 * swap-and-deposit can be exercised locally without a real LiFi quote (LiFi has no
 * solver/liquidity on local/test chains — see packages/evm-sdk/e2e/fakeSwapQuoteProviders.ts,
 * which this same directory's quote-provider port is adapted from).
 *
 * Unlike packages/swaps/contracts/script/DeployE2ELocalSwaps.s.sol (which this mirrors), this
 * does NOT call Entrypoint.setAssetConfiguration for a new depositable asset — deliberately.
 * fakeSwapQuoteProviders.ts's swap-and-deposit direction always swaps INTO native ETH before the
 * embedded deposit (`MockRouter.swapAndCall` forwards its own pre-funded native balance), and ETH
 * is already a configured Entrypoint asset on real Sepolia — so no privileged call is needed
 * (real Sepolia's ENTRYPOINT_MANAGER role isn't something this deploy key holds, and forge
 * script's `--broadcast` can't use anvil's impersonation cheat code — signing needs a real key).
 *
 * Deploys via a plain viem walletClient reading the already-compiled artifacts from
 * packages/swaps/contracts/out/ (`pnpm --filter @privacy-pools-v2/swaps-contracts build` if
 * missing) rather than shelling out to forge, so it can fund the deploy key with
 * `anvil_setBalance` first (a fresh key, never a real Sepolia account, so it has zero real
 * balance on the fork) — a forge `--broadcast` run has no equivalent pre-funding hook.
 *
 * Run: npx tsx scripts/local-swap-mocks/deploy.ts   (from packages/evm-sdk/)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import type { Address, Hex } from "../../src/internal.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWAPS_OUT_DIR = join(__dirname, "../../../swaps/contracts/out");

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";

// Real Sepolia deployment (DEPLOYMENTS[11155111] in @privacy-pools-v2/evm-sdk) — this fork has
// the real deployed contracts at these addresses.
const POOL_ADDRESS = "0x09b94d3127019298757A6ceeB7911922085f7C01" as const;
const ENTRYPOINT_ADDRESS = "0xEB3e3961008952348445513e418ad6F43C23ca9a" as const;

// Fresh local-only key (never a real Sepolia account) — funded via anvil_setBalance below, same
// pattern as local-mock-asp/server.ts's postman impersonation script.
const DEPLOYER_PRIVATE_KEY = "0x9f8c2a3d5e1b7c4a6f0d8e2b1a9c7f5d3e6b4a8c0f2d5e7b1a3c6f9d2e4b7a1c" as Hex;

function loadArtifact(contractName: string): { abi: unknown; bytecode: Hex } {
    const path = join(SWAPS_OUT_DIR, `${contractName}.sol`, `${contractName}.json`);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { abi: unknown; bytecode: { object: Hex } };
    return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    return json.result;
}

async function main(): Promise<void> {
    const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
    console.log(`[deploy-swaps] deployer: ${account.address}`);

    await rpcCall("anvil_setBalance", [account.address, "0x8AC7230489E80000"]); // 10 ETH

    const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
    const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) });

    const mockErc20 = loadArtifact("MockERC20");
    const mockRouter = loadArtifact("MockRouter");
    const relaySwaps = loadArtifact("RelaySwaps");

    console.log("[deploy-swaps] deploying MockERC20...");
    const erc20Hash = await walletClient.deployContract({
        abi: mockErc20.abi as never,
        bytecode: mockErc20.bytecode,
        args: ["Mock USD", "mUSD", 18],
    });
    const erc20Receipt = await publicClient.waitForTransactionReceipt({ hash: erc20Hash });
    const mockErc20Address = erc20Receipt.contractAddress as Address;
    console.log(`[deploy-swaps] MOCKERC20 ${mockErc20Address}`);

    console.log("[deploy-swaps] deploying MockRouter...");
    const routerHash = await walletClient.deployContract({
        abi: mockRouter.abi as never,
        bytecode: mockRouter.bytecode,
        args: [],
    });
    const routerReceipt = await publicClient.waitForTransactionReceipt({ hash: routerHash });
    const mockRouterAddress = routerReceipt.contractAddress as Address;
    console.log(`[deploy-swaps] MOCKROUTER ${mockRouterAddress}`);

    console.log("[deploy-swaps] deploying RelaySwaps...");
    const relaySwapsHash = await walletClient.deployContract({
        abi: relaySwaps.abi as never,
        bytecode: relaySwaps.bytecode,
        args: [POOL_ADDRESS, ENTRYPOINT_ADDRESS, account.address, mockRouterAddress],
    });
    const relaySwapsReceipt = await publicClient.waitForTransactionReceipt({ hash: relaySwapsHash });
    const relaySwapsAddress = relaySwapsReceipt.contractAddress as Address;
    console.log(`[deploy-swaps] RELAYSWAPS ${relaySwapsAddress}`);

    // MockRouter.swapAndCall forwards its OWN pre-funded native balance into the embedded
    // Entrypoint.deposit() call (see MockRouter.sol's doc comment) — needed for swap-and-deposit.
    await rpcCall("anvil_setBalance", [mockRouterAddress, "0x8AC7230489E80000"]); // 10 ETH
    console.log(`[deploy-swaps] funded MockRouter with 10 ETH`);

    // mint(...) is deliberately permissionless (MockERC20.sol) — this gives the wallet-app's own
    // test account (environment.evm.walletPrivateKey's derived address) mUSD to test
    // swap-and-deposit (mUSD -> ETH -> deposit) with, without needing a prior swap to obtain any.
    const TEST_WALLET_ADDRESS = "0x48CBF851c9f619359D9152240d3df7e5c2a437fB" as const;
    const mintAbi = parseAbi(["function mint(address _to, uint256 _amount) external"]);
    const mintHash = await walletClient.writeContract({
        address: mockErc20Address,
        abi: mintAbi,
        functionName: "mint",
        args: [TEST_WALLET_ADDRESS, 1_000_000_000_000_000_000_000n], // 1000 mUSD
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    console.log(`[deploy-swaps] minted 1000 mUSD to ${TEST_WALLET_ADDRESS}`);

    console.log("\n[deploy-swaps] done. Add to environment.ts's evm.ppv2 block:");
    console.log(
        JSON.stringify(
            { relaySwapsAddress, mockRouterAddress, mockErc20Address },
            null,
            4,
        ),
    );
}

main().catch((error) => {
    console.error("[deploy-swaps] fatal error", error);
    process.exit(1);
});
