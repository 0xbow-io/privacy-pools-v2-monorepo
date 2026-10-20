/**
 * Idempotent bootstrap for a local relayer instance the stellar-sdk e2e suite can relay a real
 * withdrawal through — no mock: this spawns the actual `packages/relayer/relayer` NestJS service
 * pointed at the local Soroban network `network.ts` deployed to, with a generated Stellar chain
 * config. Mirrors `packages/evm-sdk/e2e/relayer.ts`'s `ensureRelayerRunning`.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Asset, BASE_FEE, Keypair, Operation, rpc, TransactionBuilder } from "@stellar/stellar-sdk";

import type { StellarAddress } from "../src/internal.js";
import type { StellarE2ENetwork } from "./network.js";
import { fundViaFriendbot, NETWORK_MODE } from "./network.js";
import { stopProcessGroup } from "./processGroup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAYER_DIR = join(__dirname, "../../relayer/relayer");
const CONFIG_PATH = join(RELAYER_DIR, `relayer.config.e2e.stellar.${NETWORK_MODE}.json`);

// Dedicated — distinct from evm-sdk e2e's 3210, so both can run at once without colliding.
const PORT = 3211;
const URL = `http://localhost:${PORT}`;

/**
 * In stroops. Must stay comfortably under the deployed asset's `maxRelayFee` (see
 * `packages/contracts-stellar/scripts/config/assets.json`) and, more tightly, under every real
 * note value the shared suites relay (smallest is `batchWithdraw.ts`'s 6-unit `noteF`, 600,000
 * stroops at `StellarDriver`'s 1,000,000-stroop unit) — otherwise an ordinary relayed withdrawal
 * becomes infeasible. Must stay above `StellarDriver.assets.native.dust` (150,000) so the
 * "fee exceeds a dust note" batchWithdraw case actually triggers.
 */
const FLAT_FEE_AMOUNT = "200000"; // 0.02 XLM

export interface StellarE2ERelayer {
    url: string;
    address: StellarAddress;
    processorAddress: StellarAddress;
}

export interface EnsureRelayerRunningResult {
    relayer: StellarE2ERelayer;
    /** Present only when this call actually started the relayer. */
    stopRelayer?: () => Promise<void>;
}

const KEEP_ALIVE = process.env.STELLAR_E2E_KEEP_ALIVE !== "0";

export async function ensureRelayerRunning(network: StellarE2ENetwork): Promise<EnsureRelayerRunningResult> {
    const relayerKeypair = Keypair.random();
    await fundViaFriendbot(relayerKeypair.publicKey());
    // The relayer is also its own fee receiver, and a yield withdrawal pays the fee in the UNDERLYING:
    // for a classic asset that needs a trustline, or every relayed withdrawal of that share fails.
    for (const y of network.yields) {
        if (y.classicAsset) await trustClassicAsset(network, relayerKeypair, y.classicAsset);
    }

    const relayer: StellarE2ERelayer = {
        url: URL,
        address: relayerKeypair.publicKey() as StellarAddress,
        processorAddress: network.relayId as StellarAddress,
    };
    writeConfig(network, relayerKeypair);

    if (await isHealthy()) {
        return { relayer };
    }

    // Always detached (own process group), regardless of KEEP_ALIVE — see
    // `packages/evm-sdk/e2e/relayer.ts`'s matching doc comment for why. Runs the built
    // `node dist/main`, rebuilding first only when the relayer's own sources are newer than the build
    // (the SDKs are not bundled — they load from their own dists at runtime).
    const watch = process.env.STELLAR_E2E_RELAYER_WATCH === "1";
    if (!watch && relayerBuildIsStale()) {
        execFileSync("pnpm", ["exec", "nest", "build"], { cwd: RELAYER_DIR, stdio: "ignore" });
    }
    const relayerArgs = watch ? ["start:dev"] : ["start"];
    const child = spawn("pnpm", relayerArgs, {
        cwd: RELAYER_DIR,
        stdio: "ignore",
        detached: true,
        env: { ...process.env, CONFIG_PATH, PORT: String(PORT) },
    });
    if (KEEP_ALIVE) {
        child.unref();
    }

    for (let attempt = 0; attempt < 120; attempt++) {
        if (await isHealthy()) {
            return {
                relayer,
                stopRelayer: KEEP_ALIVE ? undefined : () => stopProcessGroup(child.pid),
            };
        }
        await sleep(1000);
    }
    // The spawn succeeded but health-checking never did — without this, the child (and its
    // `nest`/node descendants) leaks past this function returning, orphaned and undetected,
    // regardless of KEEP_ALIVE (a timeout is not a "keep it running" outcome for anyone).
    await stopProcessGroup(child.pid);
    throw new Error(`relayer did not become ready at ${URL}/v1/ping within 120s`);
}

/** Opens a trustline from `keypair`'s (funded) account to the classic asset `CODE:ISSUER`. */
async function trustClassicAsset(network: StellarE2ENetwork, keypair: Keypair, classicAsset: string): Promise<void> {
    const [code, issuer] = classicAsset.split(":") as [string, string];
    const server = new rpc.Server(network.rpcUrl, { allowHttp: true });
    const account = await server.getAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: network.networkPassphrase })
        .addOperation(Operation.changeTrust({ asset: new Asset(code, issuer) }))
        .setTimeout(30)
        .build();
    tx.sign(keypair);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") throw new Error(`trustline to ${classicAsset} was rejected: ${sent.errorResult?.toXDR("base64")}`);
    const done = await server.pollTransaction(sent.hash);
    if (done.status !== "SUCCESS") throw new Error(`trustline to ${classicAsset} did not land: ${done.status}`);
}

function writeConfig(network: StellarE2ENetwork, relayerKeypair: Keypair): void {
    const config = {
        chains: {
            stellar: [
                {
                    id: 1,
                    name: NETWORK_MODE,
                    network_passphrase: network.networkPassphrase,
                    rpc_url: network.rpcUrl,
                    pool_contract: network.poolId,
                    relay_contract: network.relayId,
                    keystore_contract: network.keystoreId,
                    asp_registry_contract: network.aspRegistryId,
                    fee_receiver_address: relayerKeypair.publicKey(),
                    signer_secret_key: relayerKeypair.secret(),
                    flat_fee_amount: FLAT_FEE_AMOUNT,
                    quote_expiration_ms: 120_000,
                    supported_assets: [
                        { address: network.nativeAssetAddress, ticker: "XLM", decimals: 7 },
                        // Each yield share: withdrawn through its router, fee quoted in shares.
                        ...network.yields.map((y) => ({
                            address: y.shareToken,
                            ticker: `pp${y.underlyingSymbol}`,
                            decimals: y.shareDecimals,
                            yield_router: y.router,
                        })),
                    ],
                },
            ],
            // Harmless placeholder, never dialed. `EvmConfigService`'s constructor
            // unconditionally does `relayerConfig.chain(ChainType.EVM).config(chainId)` — and
            // NestJS's QUOTE_SERVICE/RELAY_SERVICE/DETAILS_SERVICE factories inject
            // Evm/Starknet/StellarXxxService together, so all three (and therefore all three
            // ConfigServices) are constructed for *every* request regardless of the requested
            // chainType. A relayer config with `chains.evm` entirely absent (or missing this
            // chainId) makes every Stellar-routed request throw "Config for chainId 1 not found
            // on chain evm" before StellarConfigService is ever reached — confirmed live. This
            // is a real pre-existing relayer bug (eager cross-chain DI construction), not
            // Stellar-specific; the correct fix is lazily resolving only the requested chain's
            // service (e.g. via NestJS's ModuleRef), which is out of scope for this e2e harness.
            evm: [
                {
                    id: 1,
                    name: "unused-placeholder",
                    rpc_url: "http://127.0.0.1:1",
                    entrypoint_contract: `0x${"0".repeat(40)}`,
                    relay_contract: `0x${"0".repeat(40)}`,
                    pool_vault_contract: `0x${"0".repeat(40)}`,
                    supported_assets: [],
                    fee_receiver_address: `0x${"0".repeat(40)}`,
                    signer_private_key: `0x${"1".repeat(64)}`,
                },
            ],
        },
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4));
}

async function isHealthy(): Promise<boolean> {
    try {
        const response = await fetch(`${URL}/v1/ping`);
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
