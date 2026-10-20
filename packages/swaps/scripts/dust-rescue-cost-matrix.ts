/**
 * Dust-rescue cost matrix — real deposit proofs + real LiFi quotes across an
 * asset x amount grid, to inform where the "is this dust worth recovering"
 * threshold (docs: feature brief §Design decision 1 "Economics floor",
 * cross_chain_reshield_plan.org Leg 2 step 1) should actually sit.
 *
 * Deliberately read-only / no-submission: generates real deposit proofs via
 * `prepareDepositFor`'s blind cold-start path (the same mechanism
 * `packages/relayer/dust-rescue-prover` uses) against the real Arbitrum
 * Entrypoint, and estimates gas via `eth_estimateGas` — but never signs or
 * broadcasts a transaction, so this costs proving compute + RPC/LiFi API
 * calls only, no gas. Ownership of the resulting note is irrelevant here,
 * unlike the real dust-rescue-prover which derives a real stealth recipient.
 *
 * Gas estimation needs a real `from` account, even though nothing gets
 * broadcast: `eth_estimateGas` simulates against real chain state, so it
 * checks the account can actually afford `value` (native ETH rows) and, for
 * ERC20 rows, that the deposit's internal `transferFrom` wouldn't revert
 * (real token balance + a standing approval to the Entrypoint). A freshly
 * generated throwaway key holds neither, so gas estimates fail across the
 * board without one. Set `PRIVATE_KEY` (same env var the mainnet integration
 * tests use, see `run_a_test.sh`) to the same funded Arbitrum account those
 * tests already exercise — this script only ever reads its address, never
 * signs with it, so nothing is spent regardless.
 *
 * ASP: uses the same `LocalASPTreeService` override the real-Arbitrum
 * integration tests use (`.withAspDataProvider`), not a live ASP HTTP
 * endpoint — sidesteps the fact that no `dust_rescue_asp_url` exists for any
 * chain yet. Its dummy ASP public key is fine here since we never submit the
 * deposit on-chain (Entrypoint.deposit doesn't validate aspCiphertext
 * content either way).
 *
 * Chain-configurable: the destination chain (and its per-asset token
 * addresses) used for the LiFi quote leg is the one thing meant to change
 * as more L2s get deployed (see
 * `cross_chain_reshield_second_chain_deploy_tutorial.org`). Defaults to
 * Base (8453) — the only chain besides Arbitrum with a real deployment
 * today, which the contractCalls quote below actually requires (see next
 * paragraph). Update DEST_CHAIN_ID and DEST_TOKENS_BY_CHAIN below (or set
 * DUST_MATRIX_DEST_CHAIN_ID) once a further chain lands.
 *
 * Two LiFi quote types are fetched per row, quote-only, nothing broadcasts:
 * - `lifi.getSwapQuote()` — a plain swap/bridge quote (no destination
 *   contract call). Only needs a destination chain ID + token address, no
 *   real destination pool.
 * - A RAW `getContractCallsQuote()` call (bypassing the SDK's
 *   `LiFiSwapQuoteProvider` wrapper, which discards the fields we want) —
 *   the *same* quote type the real reshield flow uses, bundling a real
 *   destination deposit call so the response carries LiFi's actual
 *   `feeCosts`/`gasCosts`/`tool` breakdown instead of one lumped number.
 *   This one needs a REAL destination Entrypoint/PoolVault deployment to
 *   generate a destination deposit proof against (blind cold-start, same
 *   `prepareDepositFor` mechanism as the source side) — skipped with a
 *   warning if DEST_CHAIN_ID has none (see `tryGetContract` usage below).
 *   Scoping simplification: the destination `toAmount` quoted is the row's
 *   own nominal amount, not amount-minus-estimated-fees (computing that
 *   would need a live relayer round-trip, which this script deliberately
 *   avoids) — so treat this as "cost to deliver $X to a destination
 *   deposit", not a literal reproduction of a real reshield's sizing.
 *
 * Usage (from packages/swaps/):
 *   npx tsx scripts/dust-rescue-cost-matrix.ts
 *
 * Env (optional):
 *   ARB_RPC_URL                Arbitrum RPC. Defaults to the public endpoint.
 *   BASE_RPC_URL                Base RPC (used when DEST_CHAIN_ID is 8453, the default).
 *   PRIVATE_KEY                Funded Arbitrum account (same var the mainnet integration tests
 *                              use — see run_a_test.sh / SIGNER_PRIVATE_KEY_42161). Only its
 *                              address is read for gas estimation; only used to SIGN if
 *                              DUST_MATRIX_AUTO_APPROVE or DUST_MATRIX_REVOKE_APPROVALS is set
 *                              (see below). Without it, gas estimates fail for every row (proof
 *                              gen + LiFi quotes still work).
 *   DUST_MATRIX_DEST_CHAIN_ID  Destination chain ID for LiFi quotes. Defaults to Base (8453).
 *   LIFI_API_KEY                Recommended — unauthenticated LiFi requests are rate-limited.
 *   DUST_MATRIX_AUTO_APPROVE   If "true": for each active ERC20 asset, checks the funded
 *                              account's allowance to the Entrypoint and — ONLY if it's below
 *                              that asset's max test amount — submits one real approve() tx
 *                              (sized to exactly that max, not unlimited) before running the
 *                              matrix. This is the one case where the script signs and
 *                              broadcasts a real transaction; every other step stays read-only.
 *                              Skipped entirely (no-op) for assets whose allowance is already
 *                              sufficient, so reruns don't re-approve.
 *   DUST_MATRIX_REVOKE_APPROVALS  If "true": instead of running the matrix, sets the funded
 *                              account's allowance to 0 for every active ERC20 asset and exits.
 *                              Always safe to run after you're done testing — approve() fully
 *                              overwrites the previous allowance, so this cleanly undoes
 *                              DUST_MATRIX_AUTO_APPROVE (or any prior manual approval).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    parseUnits,
    type Address,
    type Hex,
} from "viem";
import { arbitrum, base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createClient, getContractCallsQuote } from "@lifi/sdk";
import type { ContractCallsQuoteRequest } from "@lifi/types";

import {
    CryptoService,
    LiFiSwapQuoteProvider,
    NoteComputationService,
    PoolSessionBuilder,
    PoseidonHashService,
    type PoolSession,
    type RelayerInfo,
} from "@privacy-pools-v2/evm-sdk";

import { LocalASPTreeService } from "../test/helpers/local-asp-tree.js";
import { getContract, tryGetContract } from "../test/helpers/deployment-loader.js";
import { DEPLOYMENT_BLOCK as SOURCE_DEPLOYMENT_BLOCK } from "../test/contract.config.js";
import {
    LEAF_CACHE_DIR,
    loadSessionLeafCacheSeeds,
    saveSessionLeafCache,
} from "../test/helpers/leaf-cache-store.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ---------------------------------------------------------------------------
// Source chain — Arbitrum, the only real deployment today (see
// cross_chain_reshield_second_chain_deploy_tutorial.org §1.1 for provenance).
// ---------------------------------------------------------------------------

const SOURCE_CHAIN_ID = 42_161;
const SOURCE_RPC =
    process.env.ARB_RPC_URL ?? process.env.RPC_URL_42161 ?? "https://arb1.arbitrum.io/rpc";

const POOL_ADDRESS = getContract(SOURCE_CHAIN_ID, "PoolVault");
const ENTRYPOINT_ADDRESS = getContract(SOURCE_CHAIN_ID, "Entrypoint");
const KEYSTORE_ADDRESS = getContract(SOURCE_CHAIN_ID, "Keystore");
const ASP_REGISTRY_ADDRESS = getContract(SOURCE_CHAIN_ID, "ASPRegistry");
const RELAY_SWAPS_ADDRESS = getContract(SOURCE_CHAIN_ID, "RelaySwaps");

const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");

// ---------------------------------------------------------------------------
// Destination chain — quote-only, chain-configurable. Swap in the real
// second L2's chain ID + token addresses once it's deployed; nothing else in
// this file needs to change.
// ---------------------------------------------------------------------------

const DEST_CHAIN_ID = Number(process.env.DUST_MATRIX_DEST_CHAIN_ID ?? 8453); // Base
const DEST_RPC =
    process.env.BASE_RPC_URL ?? process.env.RPC_URL_8453 ?? "https://mainnet.base.org";

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

/** Per-destination-chain token addresses, keyed by ticker. Add a new chain ID entry here. */
const DEST_TOKENS_BY_CHAIN: Record<number, Record<string, Address>> = {
    // Optimism — addresses previously exercised by the (now-broken-import,
    // otherwise-working) mainnet-crosschain-relay-swaps-withdraw-to-optimism
    // integration test, recovered from git history (commit dcc96cba) rather
    // than re-guessed. No real Entrypoint/PoolVault deployment on Optimism
    // today, so only the plain getSwapQuote() leg works if pointed here —
    // the contractCalls leg below skips itself via the tryGetContract guard.
    10: {
        ETH: NATIVE,
        WETH: "0x4200000000000000000000000000000000000006" as Address,
        USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address,
        USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" as Address,
    },
    // Base — verified against mainnet-crosschain-relay-swaps-reshield-to-base.integration.test.ts
    // and dust-leftover-observer.ts. Real Entrypoint/PoolVault deployment exists here, so this is
    // the only chain the contractCalls leg below can actually run against today.
    8453: {
        USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    },
};

// Real destination deployment (for the contractCalls quote leg only) — `undefined` if
// DEST_CHAIN_ID has none, in which case that leg is skipped with a warning, not a crash.
const DEST_POOL_ADDRESS = tryGetContract(DEST_CHAIN_ID, "PoolVault");
const DEST_ENTRYPOINT_ADDRESS = tryGetContract(DEST_CHAIN_ID, "Entrypoint");
const DEST_KEYSTORE_ADDRESS = tryGetContract(DEST_CHAIN_ID, "Keystore");
const DEST_ASP_REGISTRY_ADDRESS = tryGetContract(DEST_CHAIN_ID, "ASPRegistry");
const DEST_RELAY_SWAPS_ADDRESS = tryGetContract(DEST_CHAIN_ID, "RelaySwaps");

// Binary-searched via `cast code` on the Base Keystore address (2026-08-13) — see
// test/integration_test_standards.org and dust-leftover-observer.ts's copy of this constant.
// Only meaningful when DEST_CHAIN_ID is 8453; override with DUST_MATRIX_DEST_DEPLOYMENT_BLOCK
// if a future redeploy moves it or a different dest chain is configured.
const DEST_DEPLOYMENT_BLOCK = (process.env.DUST_MATRIX_DEST_DEPLOYMENT_BLOCK ?? "0x2F904AE") as Hex; // 49874094

// ---------------------------------------------------------------------------
// Asset x amount matrix (source-chain side). Amounts span "probably below
// any sane floor" -> "clearly worth it" per asset.
// ---------------------------------------------------------------------------

type AssetSpec = {
    ticker: string;
    sourceAddress: Address;
    decimals: number;
    amounts: string[]; // human units
};

const ASSET_MATRIX: AssetSpec[] = [
    // ETH, WETH, USDT commented out — USDC only for this pass (funds are tight, per the
    // deployer-wallet check above). Swap the others back in later.
    // { ticker: "ETH", sourceAddress: NATIVE, decimals: 18, amounts: ["0.0005", "0.002", "0.01", "0.1"] },
    // WETH commented out separately: not deposit-enabled on the real Arbitrum Entrypoint today
    // ("Asset not enabled: 0x82aF4944...") despite being listed as a supported asset in
    // relayer.config.real.json — a real config mismatch, not a script bug. Re-enable once
    // that's reconciled.
    // {
    //     ticker: "WETH",
    //     sourceAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address,
    //     decimals: 18,
    //     amounts: ["0.0005", "0.002", "0.01", "0.1"],
    // },
    {
        ticker: "USDC",
        sourceAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
        decimals: 6,
        amounts: ["1", "5", "25", "90"], // max capped at 90 USDC
    },
    // {
    //     ticker: "USDT",
    //     sourceAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address,
    //     decimals: 6,
    //     amounts: ["1", "5", "25", "90"],
    // },
];

// ---------------------------------------------------------------------------

type FeeCostRow = { name: string; percentage: string; amount: string; amountUSD: string; included: boolean };
type GasCostRow = { type: string; amount: string; amountUSD: string };

type ResultRow = {
    ticker: string;
    amountHuman: string;
    amountWei: string;
    proofGenMs: number | null;
    depositGasEstimate: string;
    lifi:
        | {
              fromAmountUSD?: string;
              toAmountUSD?: string;
              estimatedOutput: string;
              toAmountMin: string;
              estimatedDurationSec: number;
          }
        | { error: string };
    /**
     * The raw LiFi contractCalls quote — same quote type the real reshield flow uses (see header
     * comment). This is what actually answers "how much does LiFi/the solver charge, separate from
     * real destination execution gas" instead of one lumped estimate.
     */
    contractCallsQuote?:
        | {
              tool: string;
              fromAmountUSD?: string;
              toAmountUSD?: string;
              feeCosts: FeeCostRow[];
              gasCosts: GasCostRow[];
              totalFeeCostUSD: number;
              totalGasCostUSD: number;
              totalFeeCostAsPctOfAmount: number | null;
              totalGasCostAsPctOfAmount: number | null;
          }
        | { skipped: string }
        | { error: string };
    error?: string;
};

const ERC20_ABI = parseAbi([
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
]);

const ENTRYPOINT_ASSETS_ABI = parseAbi([
    "function assets(address token) view returns (bool enabled, uint256 minAmount, uint256 vettingFeeBPS, uint256 maxRelayFee)",
]);

function placeholderRelayer(chainId: number): RelayerInfo {
    return {
        name: "dust-rescue-cost-matrix-internal",
        url: "http://localhost",
        chainId,
        chainType: "evm",
        status: "active",
        address: "0x0000000000000000000000000000000000000001",
        processorAddress: "0x0000000000000000000000000000000000000001",
    } as RelayerInfo;
}

async function main() {
    const publicClient = createPublicClient({ chain: arbitrum, transport: http(SOURCE_RPC) });

    // Only ever read for its address (gas-estimate `from`, and to satisfy
    // LocalASPTreeService's constructor type below) — never signs or broadcasts
    // anything, so a real funded key here is safe to use. Falls back to a fresh
    // throwaway key if PRIVATE_KEY isn't set; gas estimates will then fail (see
    // the header comment) but proof generation and LiFi quotes still work.
    const fundedPrivateKey = process.env.PRIVATE_KEY as Hex | undefined;
    if (!fundedPrivateKey) {
        console.warn(
            "PRIVATE_KEY not set — gas estimates will fail for every row (eth_estimateGas checks " +
                "real balance/allowance even for a read-only call). Set it to the same funded " +
                "Arbitrum account the mainnet integration tests use (run_a_test.sh) to get real " +
                "gas numbers; proof generation and LiFi quotes work either way.",
        );
    }
    const account = privateKeyToAccount(fundedPrivateKey ?? generatePrivateKey());
    const walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(SOURCE_RPC),
    });

    const autoApprove = process.env.DUST_MATRIX_AUTO_APPROVE === "true";

    /**
     * Ensures `account` has approved the Entrypoint for at least `neededAmount`
     * of `token` — required for ERC20 deposit gas estimates to succeed (see
     * header comment). No-ops if the allowance is already sufficient. Only
     * signs/submits a real transaction when DUST_MATRIX_AUTO_APPROVE=true and a
     * real funded key is available; otherwise just reports what's missing so
     * it can be approved manually. Defined as a closure (not a top-level
     * function taking typed client params) to sidestep viem's PublicClient/
     * WalletClient generic-inference quirks in helper-function signatures.
     */
    async function ensureApproval(token: Address, neededAmount: bigint): Promise<void> {
        const current = await publicClient.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [account.address, ENTRYPOINT_ADDRESS],
        });
        if (current >= neededAmount) {
            console.log(`  [${token}] allowance already sufficient (${current} >= ${neededAmount}), skipping approval`);
            return;
        }
        if (!autoApprove || !fundedPrivateKey) {
            console.warn(
                `  [${token}] allowance ${current} < needed ${neededAmount} — gas estimates for this asset ` +
                    `will fail. Set DUST_MATRIX_AUTO_APPROVE=true (with a real PRIVATE_KEY) to fix ` +
                    `automatically, or approve manually:\n` +
                    `    cast send ${token} "approve(address,uint256)" ${ENTRYPOINT_ADDRESS} ${neededAmount} --rpc-url <RPC> --private-key $PRIVATE_KEY`,
            );
            return;
        }
        console.log(
            `  [${token}] allowance ${current} < needed ${neededAmount} — submitting approve(${ENTRYPOINT_ADDRESS}, ${neededAmount})...`,
        );
        const hash = await walletClient.writeContract({
            address: token,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [ENTRYPOINT_ADDRESS, neededAmount],
            chain: arbitrum,
            account,
        });
        console.log(`  [${token}] approve tx submitted: ${hash} — waiting for confirmation...`);
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`  [${token}] approved.`);
    }

    const activeErc20Assets = ASSET_MATRIX.filter((a) => a.sourceAddress.toLowerCase() !== NATIVE.toLowerCase());

    if (process.env.DUST_MATRIX_REVOKE_APPROVALS === "true") {
        if (!fundedPrivateKey) {
            console.error("DUST_MATRIX_REVOKE_APPROVALS=true requires a real PRIVATE_KEY to sign with.");
            process.exit(1);
        }
        console.log("Revoking approvals for all active ERC20 assets...");
        for (const asset of activeErc20Assets) {
            // Not reusing ensureApproval here: it no-ops once allowance already satisfies
            // `neededAmount`, and 0n always trivially satisfies that check — revoking needs
            // an explicit approve(spender, 0) whenever the current allowance is nonzero, which
            // is the opposite condition.
            const current = await publicClient.readContract({
                address: asset.sourceAddress,
                abi: ERC20_ABI,
                functionName: "allowance",
                args: [account.address, ENTRYPOINT_ADDRESS],
            });
            if (current > 0n) {
                console.log(`  [${asset.ticker}] revoking non-zero allowance (${current})...`);
                const hash = await walletClient.writeContract({
                    address: asset.sourceAddress,
                    abi: ERC20_ABI,
                    functionName: "approve",
                    args: [ENTRYPOINT_ADDRESS, 0n],
                    chain: arbitrum,
                    account: walletClient.account!,
                });
                console.log(`  [${asset.ticker}] revoke tx submitted: ${hash} — waiting for confirmation...`);
                await publicClient.waitForTransactionReceipt({ hash });
                console.log(`  [${asset.ticker}] revoked.`);
            } else {
                console.log(`  [${asset.ticker}] allowance already 0, nothing to revoke.`);
            }
        }
        console.log("Done revoking.");
        return;
    }

    const localASP = await LocalASPTreeService.create({
        aspRegistryAddress: ASP_REGISTRY_ADDRESS,
        walletClient: walletClient as never,
        publicClient: publicClient as never,
    });

    const cryptoService = new CryptoService();
    const hashService = await PoseidonHashService.create();
    const noteComputationService = new NoteComputationService({ hashService, cryptoService });
    const viewingKeyPair = cryptoService.generateEphemeralKeyPair();

    const session = await PoolSessionBuilder.fromConfig({
        chainId: SOURCE_CHAIN_ID,
        rpcUrl: SOURCE_RPC,
        ownerAddress: account.address,
        deployment: {
            poolAddress: POOL_ADDRESS,
            entrypointAddress: ENTRYPOINT_ADDRESS,
            keystoreAddress: KEYSTORE_ADDRESS,
            aspRegistryAddress: ASP_REGISTRY_ADDRESS,
            relaySwapsAddress: RELAY_SWAPS_ADDRESS,
        },
        deploymentBlock: SOURCE_DEPLOYMENT_BLOCK,
        ...loadSessionLeafCacheSeeds(LEAF_CACHE_DIR, SOURCE_CHAIN_ID, {
            keystoreAddress: KEYSTORE_ADDRESS,
            poolAddress: POOL_ADDRESS,
        }),
        protocolKeys: {
            privateNullifyingKey: cryptoService.generateSecret(),
            privateRevocableKey: cryptoService.generateSecret(),
            revocableKeyIndex: "0x0" as Hex,
            viewingPrivateKey: viewingKeyPair.privateKey,
            viewingPublicKey: viewingKeyPair.publicKey,
        },
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [placeholderRelayer(SOURCE_CHAIN_ID)],
    })
        .withAspDataProvider(localASP)
        .create();

    const lifi = new LiFiSwapQuoteProvider({
        ...(process.env.LIFI_API_KEY ? { apiKey: process.env.LIFI_API_KEY } : {}),
    });

    const destTokens = DEST_TOKENS_BY_CHAIN[DEST_CHAIN_ID];
    if (!destTokens) {
        console.warn(
            `No DEST_TOKENS_BY_CHAIN entry for chain ${DEST_CHAIN_ID} — LiFi quotes will be skipped. ` +
                `Add one (see the comment at the top of this file) once the destination chain is known.`,
        );
    }

    // Destination session — only for the contractCalls quote leg's deposit proof (blind
    // cold-start, ownership irrelevant, same as the source side). `undefined` when
    // DEST_CHAIN_ID has no real deployment; the per-row loop skips that leg in that case.
    let destSession: PoolSession | undefined;
    const hasDestDeployment =
        DEST_POOL_ADDRESS && DEST_ENTRYPOINT_ADDRESS && DEST_KEYSTORE_ADDRESS && DEST_ASP_REGISTRY_ADDRESS;
    if (hasDestDeployment) {
        // `base` is the only chain object needed today (see header comment — Base is the only
        // real second deployment); falls back to a minimal stub if a different DEST_CHAIN_ID is
        // ever configured before this script gets a proper per-chain viem chain-object map.
        const destChainObject = DEST_CHAIN_ID === base.id ? base : ({ id: DEST_CHAIN_ID } as any);
        const destPublicClient = createPublicClient({ chain: destChainObject, transport: http(DEST_RPC) });
        const destWalletClient = createWalletClient({
            account,
            chain: destChainObject,
            transport: http(DEST_RPC),
        });
        const destASP = await LocalASPTreeService.create({
            aspRegistryAddress: DEST_ASP_REGISTRY_ADDRESS!,
            walletClient: destWalletClient as never,
            publicClient: destPublicClient as never,
        });
        destSession = await PoolSessionBuilder.fromConfig({
            chainId: DEST_CHAIN_ID,
            rpcUrl: DEST_RPC,
            ownerAddress: account.address,
            deployment: {
                poolAddress: DEST_POOL_ADDRESS!,
                entrypointAddress: DEST_ENTRYPOINT_ADDRESS!,
                keystoreAddress: DEST_KEYSTORE_ADDRESS!,
                aspRegistryAddress: DEST_ASP_REGISTRY_ADDRESS!,
                ...(DEST_RELAY_SWAPS_ADDRESS ? { relaySwapsAddress: DEST_RELAY_SWAPS_ADDRESS } : {}),
            },
            deploymentBlock: DEST_DEPLOYMENT_BLOCK,
            ...loadSessionLeafCacheSeeds(LEAF_CACHE_DIR, DEST_CHAIN_ID, {
                keystoreAddress: DEST_KEYSTORE_ADDRESS!,
                poolAddress: DEST_POOL_ADDRESS!,
            }),
            protocolKeys: {
                privateNullifyingKey: cryptoService.generateSecret(),
                privateRevocableKey: cryptoService.generateSecret(),
                revocableKeyIndex: "0x0" as Hex,
                viewingPrivateKey: viewingKeyPair.privateKey,
                viewingPublicKey: viewingKeyPair.publicKey,
            },
            circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
            relayers: [placeholderRelayer(DEST_CHAIN_ID)],
        } as any)
            .withAspDataProvider(destASP)
            .create();
    } else {
        console.warn(
            `No real Entrypoint/PoolVault deployment found for chain ${DEST_CHAIN_ID} — the ` +
                `contractCalls quote leg (LiFi fee/gas breakdown) will be skipped for every row. ` +
                `The plain getSwapQuote() leg still runs.`,
        );
    }

    // Raw LiFi SDK client, separate from LiFiSwapQuoteProvider's internal (private) one — needed
    // to call getContractCallsQuote() directly and keep the raw step's feeCosts/gasCosts/tool,
    // which LiFiSwapQuoteProvider.extractContractCallsResult() discards before returning.
    const rawLifiClient = createClient({
        integrator: "privacy-pools-v2", // mirrors packages/sdk's DEFAULT_LIFI_INTEGRATOR
        ...(process.env.LIFI_API_KEY ? { apiKey: process.env.LIFI_API_KEY } : {}),
    });

    // ERC20 gas estimates need a real allowance to the Entrypoint (see header comment) — sized
    // to VALUE + VETTING FEE, not just the raw deposit value: the Entrypoint's transferFrom
    // pulls amount + (amount * vettingFeeBPS / 10000) (same formula the contract itself uses),
    // so approving only the raw max amount undershoots by exactly the fee — which is invisible
    // for small test amounts (comfortably covered by a larger unrelated allowance) and only
    // surfaces as a revert on the largest row. Sized per-asset, not unlimited — only submits a
    // real tx when DUST_MATRIX_AUTO_APPROVE=true, and only for assets whose allowance is
    // actually insufficient (reruns after a successful approval are no-ops).
    console.log("Checking ERC20 allowances...");
    for (const asset of activeErc20Assets) {
        const maxAmountWei = asset.amounts
            .map((a) => parseUnits(a, asset.decimals))
            .reduce((max, v) => (v > max ? v : max), 0n);
        const [, , vettingFeeBPS] = await publicClient.readContract({
            address: ENTRYPOINT_ADDRESS,
            abi: ENTRYPOINT_ASSETS_ABI,
            functionName: "assets",
            args: [asset.sourceAddress],
        });
        const neededAmount = maxAmountWei + (maxAmountWei * vettingFeeBPS) / 10_000n;
        await ensureApproval(asset.sourceAddress, neededAmount);
    }

    const results: ResultRow[] = [];

    for (const asset of ASSET_MATRIX) {
        for (const amountHuman of asset.amounts) {
            const amountWei = parseUnits(amountHuman, asset.decimals);
            const amountHex = `0x${amountWei.toString(16)}` as Hex;

            const row: ResultRow = {
                ticker: asset.ticker,
                amountHuman,
                amountWei: amountWei.toString(),
                proofGenMs: null,
                depositGasEstimate: "n/a",
                lifi: { error: "not attempted" },
            };

            // --- Real deposit proof, timed. Note ownership is irrelevant here
            // (unlike the real dust-rescue-prover, which derives a real stealth
            // recipient, see DustRescueOptIn) — reuses `account` only because a
            // valid-looking owner address is required, not because it matters.
            try {
                const noteSecret = cryptoService.generateSecret();
                const noteAddressHash = noteComputationService.computeNoteAddressHash(
                    account.address,
                    noteSecret,
                );

                const t0 = Date.now();
                const depositResult = await session.prepareDepositFor({
                    tokenId: asset.sourceAddress,
                    value: amountHex,
                    noteAddressHash,
                });
                row.proofGenMs = Date.now() - t0;

                try {
                    const gas = await publicClient.estimateGas({
                        account: account.address,
                        to: depositResult.to,
                        data: depositResult.callData,
                        value: BigInt(depositResult.msgValue),
                    });
                    row.depositGasEstimate = gas.toString();
                } catch (gasErr) {
                    row.depositGasEstimate = `estimate failed: ${(gasErr as Error).message}`;
                }
            } catch (proofErr) {
                row.error = `proof generation failed: ${(proofErr as Error).message}`;
            }

            // --- LiFi swap/bridge quote, source -> destination chain.
            const destAddress = destTokens?.[asset.ticker];
            if (!destAddress) {
                row.lifi = { error: `no destination token mapped for ${asset.ticker} on chain ${DEST_CHAIN_ID}` };
            } else {
                try {
                    const quote = await lifi.getSwapQuote({
                        fromChainId: SOURCE_CHAIN_ID,
                        toChainId: DEST_CHAIN_ID,
                        fromToken: asset.sourceAddress,
                        toToken: destAddress,
                        fromAddress: account.address,
                        amount: amountWei.toString(),
                        amountType: "from",
                    });
                    row.lifi = {
                        fromAmountUSD: quote.fromAmountUSD,
                        toAmountUSD: quote.toAmountUSD,
                        estimatedOutput: quote.toAmount,
                        toAmountMin: quote.toAmountMin,
                        estimatedDurationSec: quote.estimatedDuration,
                    };
                } catch (lifiErr) {
                    row.lifi = { error: (lifiErr as Error).message };
                }
            }

            // --- Raw LiFi contractCalls quote: same quote type the real reshield flow uses,
            // read directly so feeCosts/gasCosts/tool survive (see header comment).
            if (!destSession || !destAddress || !DEST_POOL_ADDRESS) {
                row.contractCallsQuote = { skipped: "no destination deployment or token mapping for this chain/ticker" };
            } else {
                try {
                    const destAmountWei = amountWei; // scoping simplification — see header comment
                    const noteSecret = cryptoService.generateSecret();
                    const noteAddressHash = noteComputationService.computeNoteAddressHash(account.address, noteSecret);
                    const destDepositProof = await destSession.prepareDepositFor({
                        tokenId: destAddress,
                        value: `0x${destAmountWei.toString(16)}` as Hex,
                        noteAddressHash,
                    });

                    const quoteRequest: ContractCallsQuoteRequest = {
                        fromChain: SOURCE_CHAIN_ID,
                        fromToken: asset.sourceAddress,
                        toChain: DEST_CHAIN_ID,
                        toToken: destAddress,
                        fromAddress: account.address,
                        toAmount: destAmountWei.toString(),
                        slippage: 0.03,
                        integrator: "privacy-pools-v2",
                        denyExchanges: ["fly"],
                        contractCalls: [
                            {
                                fromAmount: destAmountWei.toString(),
                                fromTokenAddress: destAddress,
                                toContractAddress: destDepositProof.to,
                                toContractCallData: destDepositProof.callData,
                                toContractGasLimit: "300000",
                            },
                        ],
                    } as ContractCallsQuoteRequest;

                    const step = await getContractCallsQuote(rawLifiClient, quoteRequest);
                    const feeCosts: FeeCostRow[] = (step.estimate.feeCosts ?? []).map((f) => ({
                        name: f.name,
                        percentage: f.percentage,
                        amount: f.amount,
                        amountUSD: f.amountUSD,
                        included: f.included,
                    }));
                    const gasCosts: GasCostRow[] = (step.estimate.gasCosts ?? []).map((g) => ({
                        type: g.type,
                        amount: g.amount,
                        amountUSD: g.amountUSD,
                    }));
                    const totalFeeCostUSD = feeCosts.reduce((sum, f) => sum + Number(f.amountUSD || 0), 0);
                    const totalGasCostUSD = gasCosts.reduce((sum, g) => sum + Number(g.amountUSD || 0), 0);
                    const fromAmountUSD = step.estimate.fromAmountUSD ? Number(step.estimate.fromAmountUSD) : null;

                    row.contractCallsQuote = {
                        tool: step.estimate.tool,
                        fromAmountUSD: step.estimate.fromAmountUSD,
                        toAmountUSD: step.estimate.toAmountUSD,
                        feeCosts,
                        gasCosts,
                        totalFeeCostUSD,
                        totalGasCostUSD,
                        totalFeeCostAsPctOfAmount: fromAmountUSD ? (totalFeeCostUSD / fromAmountUSD) * 100 : null,
                        totalGasCostAsPctOfAmount: fromAmountUSD ? (totalGasCostUSD / fromAmountUSD) * 100 : null,
                    };
                } catch (ccErr) {
                    row.contractCallsQuote = { error: (ccErr as Error).message };
                }
            }

            results.push(row);
            console.log(
                `${asset.ticker.padEnd(4)} ${amountHuman.padStart(8)}  ` +
                    `proof=${String(row.proofGenMs).padStart(6)}ms  gas=${row.depositGasEstimate.padStart(8)}  ` +
                    `lifi=${JSON.stringify(row.lifi)}`,
            );
            if (row.contractCallsQuote && "tool" in row.contractCallsQuote) {
                const cc = row.contractCallsQuote;
                console.log(
                    `     contractCalls: tool=${cc.tool}  fee=${cc.totalFeeCostUSD.toFixed(4)}USD` +
                        ` (${cc.totalFeeCostAsPctOfAmount?.toFixed(4) ?? "n/a"}%)  ` +
                        `gas=${cc.totalGasCostUSD.toFixed(4)}USD (${cc.totalGasCostAsPctOfAmount?.toFixed(4) ?? "n/a"}%)`,
                );
            } else if (row.contractCallsQuote) {
                console.log(`     contractCalls: ${JSON.stringify(row.contractCallsQuote)}`);
            }
        }
    }

    saveSessionLeafCache(LEAF_CACHE_DIR, SOURCE_CHAIN_ID, {
        keystoreAddress: KEYSTORE_ADDRESS,
        poolAddress: POOL_ADDRESS,
    }, session);

    if (destSession && DEST_KEYSTORE_ADDRESS && DEST_POOL_ADDRESS) {
        saveSessionLeafCache(LEAF_CACHE_DIR, DEST_CHAIN_ID, {
            keystoreAddress: DEST_KEYSTORE_ADDRESS,
            poolAddress: DEST_POOL_ADDRESS,
        }, destSession);
    }

    const outDir = resolve(__dirname, "results");
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `dust-rescue-cost-matrix-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify({ sourceChainId: SOURCE_CHAIN_ID, destChainId: DEST_CHAIN_ID, results }, null, 2));
    console.log(`\nWrote ${results.length} rows to ${outPath}`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
