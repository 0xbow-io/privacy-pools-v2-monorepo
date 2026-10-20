/**
 * Idempotent bootstrap for a local relayer instance the evm-sdk e2e suite can relay a real
 * withdrawal through — no mock: this spawns the actual `packages/relayer/relayer` NestJS service
 * pointed at the local anvil fork `network.ts` deployed to, the same way
 * `scripts/e2e-registration/README.md` already documents doing by hand.
 */
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";

import { privateKeyToAccount } from "viem/accounts";

import type { Address, Hex } from "../src/internal.js";
import type { EvmE2ENetwork } from "./network.js";
import { stopProcessGroup } from "./processGroup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAYER_DIR = join(__dirname, "../../relayer/relayer");

/** Lane k listens on BASE_PORT + k — dedicated, so it never clashes with a manually-run relayer on :3000. */
const BASE_PORT = 3210;

/** Lane 0 keeps the single-relayer config name; every config name matches the relayer's .gitignore. */
function configPath(lane: number): string {
    return join(RELAYER_DIR, lane === 0 ? "relayer.config.e2e.local.json" : `relayer.config.e2e.local.lane${lane}.json`);
}

/**
 * e2e-suite-only test key — see {@link "./network.js".DEPLOYER_PRIVATE_KEY} for why this isn't
 * one of anvil's default genesis accounts. Used as both the relayer's signer and its fee
 * receiver, funded via `anvil_setBalance` by the global setup. Every lane's relayer uses it — each
 * lane is its own chain, so they never share a nonce.
 */
export const RELAYER_SIGNER_PRIVATE_KEY: Hex =
    "0xb9dacf9a665e631e115b28d780600d4238ff202e6c37c661d5c20c86005ec0f8" as Hex;

export interface EvmE2ERelayer {
    url: string;
    address: Address;
    processorAddress: Address;
}

export interface EnsureRelayerRunningResult {
    relayer: EvmE2ERelayer;
    /** Present only when this call actually started the relayer — see network.ts's matching
     * `stopAnvil` doc comment for the same "only if we started it" rule. */
    stopRelayer?: () => Promise<void>;
}

/** Opt-in: leave the relayers this run started running afterwards. */
const KEEP_ALIVE = process.env.EVM_E2E_KEEP_ALIVE === "1";

export interface EnsureRelayersRunningResult {
    /** By lane: each lane's network with the relayer pointed at it. */
    lanes: { network: EvmE2ENetwork; relayer: EvmE2ERelayer }[];
    /** Stops every relayer this call started. */
    stopRelayers: () => Promise<void>;
}

/** One relayer per lane, each pointed at its own lane's anvil (the relayer config holds one RPC per chain id). */
export async function ensureRelayersRunning(networks: EvmE2ENetwork[]): Promise<EnsureRelayersRunningResult> {
    // Once, up front: concurrent `nest build`s into the same dist would race.
    if (process.env.EVM_E2E_RELAYER_WATCH !== "1" && relayerBuildIsStale()) {
        execFileSync("pnpm", ["exec", "nest", "build"], { cwd: RELAYER_DIR, stdio: "ignore" });
    }
    const started = await Promise.allSettled(networks.map((network, lane) => ensureRelayerRunning(network, lane)));
    const stopRelayers = async (): Promise<void> => {
        await Promise.all(started.map((result) => (result.status === "fulfilled" ? result.value.stopRelayer?.() : undefined)));
    };
    const failed = started.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) {
        await stopRelayers();
        throw failed.reason;
    }
    return {
        lanes: started.map((result, lane) => ({
            network: networks[lane] as EvmE2ENetwork,
            relayer: (result as PromiseFulfilledResult<EnsureRelayerRunningResult>).value.relayer,
        })),
        stopRelayers,
    };
}

async function ensureRelayerRunning(network: EvmE2ENetwork, lane: number): Promise<EnsureRelayerRunningResult> {
    const port = BASE_PORT + lane;
    const url = `http://localhost:${port}`;
    const relayer: EvmE2ERelayer = {
        url,
        address: privateKeyToAccount(RELAYER_SIGNER_PRIVATE_KEY).address as Address,
        processorAddress: network.privacyPoolRelayAddress,
    };
    const config = configPath(lane);
    writeConfig(network, config);

    if (await isHealthy(url)) {
        return { relayer };
    }

    // Always detached (own process group), regardless of KEEP_ALIVE: `pnpm start:dev` → `nest
    // start --watch` is a multi-level process tree, and `child.kill()` on just the top-level pnpm
    // PID leaves the actual nest/node process (and its watch-mode children) running orphaned —
    // killing the whole group via `process.kill(-child.pid, ...)` is the only reliable way to tear
    // it down. `.unref()` is what actually controls whether it outlives this process.
    // `start:dev` is `nest start --watch` (a tsc watcher plus node — several of these piled up and
    // exhausted RAM). Default to the built `node dist/main`, rebuilding first only when the relayer's
    // own sources are newer than the build (the SDKs are not bundled — they load from their own
    // dists at runtime); opt back in to the watcher with EVM_E2E_RELAYER_WATCH=1 when iterating on
    // relayer source.
    // (The build itself is checked once, by `ensureRelayersRunning`.)
    const watch = process.env.EVM_E2E_RELAYER_WATCH === "1";
    const relayerArgs = watch ? ["start:dev"] : ["start"];
    const child = spawn("pnpm", relayerArgs, {
        cwd: RELAYER_DIR,
        stdio: "ignore",
        detached: true,
        // ALLOW_MOCK_RATE_PROVIDER: the "Mock" quoter (mUSD, and the yield share's underlying)
        // is fail-closed by default (issue #961) — without this, boot fails loudly the moment a
        // configured asset names quoter "Mock". Safe here: this relayer only ever points at a
        // throwaway local anvil fork, never a real deployment.
        env: { ...process.env, CONFIG_PATH: config, PORT: String(port), ALLOW_MOCK_RATE_PROVIDER: "true" },
    });
    if (KEEP_ALIVE) {
        child.unref();
    }

    for (let attempt = 0; attempt < 120; attempt++) {
        if (await isHealthy(url)) {
            return {
                relayer,
                stopRelayer: KEEP_ALIVE
                    ? undefined
                    : () => stopProcessGroup(child.pid),
            };
        }
        await sleep(1000);
    }
    // The spawn succeeded but health-checking never did — without this, the child (and its
    // `nest`/node descendants) leaks past this function returning, orphaned and undetected,
    // regardless of KEEP_ALIVE (a timeout is not a "keep it running" outcome for anyone).
    await stopProcessGroup(child.pid);
    throw new Error(`relayer did not become ready at ${url}/v1/ping within 120s`);
}

function writeConfig(network: EvmE2ENetwork, path: string): void {
    const config = {
        chains: {
            evm: [
                {
                    id: network.chainId,
                    name: "sepolia",
                    rpc_url: network.rpcUrl,
                    entrypoint_contract: network.entrypointAddress,
                    relay_contract: network.privacyPoolRelayAddress,
                    pool_vault_contract: network.poolAddress,
                    relay_swaps_contract: network.relaySwapsAddress,
                    // The yield shares below are quoted "Underlying", so the relayer's boot-time yield
                    // discovery requires the PPRouter that wraps each to be allowlisted here.
                    allowed_processors: [network.yieldRouterAddress, network.nativeYieldRouterAddress],
                    fee_receiver_address: privateKeyToAccount(RELAYER_SIGNER_PRIVATE_KEY).address,
                    signer_private_key: RELAYER_SIGNER_PRIVATE_KEY,
                    flat_fee_amount: "0",
                    quote_expiration_ms: 120_000,
                    native_currency: { name: "Ether", symbol: "ETH", decimals: 18 },
                    supported_assets: [
                        {
                            address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                            ticker: "ETH",
                            quoter: "Native",
                            fee_bps: "0",
                            decimals: 18,
                        },
                        {
                            address: network.mockErc20Address,
                            ticker: "mUSD",
                            quoter: "Mock",
                            fee_bps: "0",
                            decimals: 18,
                        },
                        {
                            address: network.yieldUnderlyingAddress,
                            ticker: "yUSDC",
                            quoter: "Mock",
                            fee_bps: "0",
                            decimals: 6,
                        },
                        // "Underlying" quoter: no market prices an ERC-4626 share directly — the
                        // relayer quotes `underlying` (above) through ITS quoter and scales by the
                        // wrapper's live previewRedeem rate. `zap` is an optional cross-check only;
                        // the authoritative zap is derived on-chain from RelaySwaps.approvedZapList().
                        {
                            address: network.yieldTokenAddress,
                            ticker: "ppyUSDC",
                            quoter: "Underlying",
                            underlying: network.yieldUnderlyingAddress,
                            zap: network.yieldZapAddress,
                            fee_bps: "0",
                            decimals: 18,
                        },
                        // The native-mode yield stack: ppWETH over MockWETH9, its router paying out ETH.
                        {
                            // Ticker "WETH" makes the relayer treat it as native (priced 1:1 to gas),
                            // which requires the "Native" quoter — any other fails boot validation.
                            address: network.nativeYieldUnderlyingAddress,
                            ticker: "WETH",
                            quoter: "Native",
                            fee_bps: "0",
                            decimals: 18,
                        },
                        {
                            address: network.nativeYieldTokenAddress,
                            ticker: "ppWETH",
                            quoter: "Underlying",
                            underlying: network.nativeYieldUnderlyingAddress,
                            zap: network.nativeYieldZapAddress,
                            fee_bps: "0",
                            decimals: 18,
                        },
                    ],
                },
            ],
        },
    };
    writeFileSync(path, JSON.stringify(config, null, 4));
}

async function isHealthy(url: string): Promise<boolean> {
    try {
        const response = await fetch(`${url}/v1/ping`);
        return response.ok;
    } catch {
        return false;
    }
}

const RELAYER_BUILD = join(RELAYER_DIR, "dist/main.js");
const RELAYER_BUILD_INPUTS = ["src", "package.json", "tsconfig.json", "tsconfig.build.json", "nest-cli.json", "nest-tsconfig.json"];

/** True when `dist/main.js` is missing or older than any of the relayer's build inputs. */
function relayerBuildIsStale(): boolean {
    if (!existsSync(RELAYER_BUILD)) return true;
    const builtAt = statSync(RELAYER_BUILD).mtimeMs;
    const newerThanBuild = (path: string): boolean => {
        if (!existsSync(path)) return false;
        const stat = statSync(path);
        if (!stat.isDirectory()) return stat.mtimeMs > builtAt;
        return readdirSync(path).some((entry) => newerThanBuild(join(path, entry)));
    };
    return RELAYER_BUILD_INPUTS.some((input) => newerThanBuild(join(RELAYER_DIR, input)));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
