/**
 * Dust leftover observer — real, executed cross-chain reshields that measure
 * how much destination-chain leftover actually shows up at `fallbackAddress`,
 * and how long it takes to land. Closes the gap identified in
 * dust_experiments_outline.org §3-5: dust-rescue-cost-matrix.ts already
 * answers "what does rescuing dust cost" (proof gen + gas estimate, nothing
 * broadcasts); nothing answers "how much dust does a typical cross-chain
 * reshield actually leave behind." This script generalizes the one-off
 * observation already inline in
 * mainnet-crosschain-relay-swaps-reshield-to-base.integration.test.ts (its
 * "THE OBSERVATION" section) into a standalone, parameterized, repeatable
 * runner — this is meant to be invoked many times over as real data trickles
 * in, not run once.
 *
 * COST WARNING, unlike dust-rescue-cost-matrix.ts (proof gen + gas *estimate*
 * only, nothing ever broadcasts): every run here executes a REAL deposit +
 * REAL cross-chain reshield. Real gas, real bridge fees, real slippage, every
 * single invocation. The script logs the planned total spend up front and
 * refuses to spend anything unless DUST_OBSERVER_CONFIRM=yes is set.
 *
 * REQUIRES A LOCAL RELAYER, unlike dust-rescue-cost-matrix.ts:
 * prepareReshieldCrosschainQuote / relayReshieldCrosschain both call out to
 * the relayer service (RELAYER_URL). Also requires ASP_POSTMAN_PRIVATE_KEY —
 * registering the source/dest ASP labels needs POSTMAN_ROLE, a different
 * wallet than the depositor in the standard mainnet test setup.
 *
 * Usage (from packages/swaps/):
 *   DUST_OBSERVER_CONFIRM=yes npx tsx scripts/dust-leftover-observer.ts
 *
 * Without DUST_OBSERVER_CONFIRM=yes, the script logs what it WOULD spend and
 * exits without touching the network at all.
 *
 * Env:
 *   PRIVATE_KEY                  Funded Arbitrum + Base account — deposits on Arbitrum,
 *                                 doubles as the relayer identity and the fallbackAddress
 *                                 that receives destination leftover (same convention as
 *                                 the mainnet-crosschain-relay-swaps-reshield-to-base test).
 *   ASP_POSTMAN_PRIVATE_KEY      Wallet with POSTMAN_ROLE on both chains' ASPRegistry.
 *   RELAYER_URL                  Local relayer base URL. Default http://localhost:3000.
 *   ARB_RPC_URL / BASE_RPC_URL   RPC endpoints. Default to public endpoints.
 *   LIFI_API_KEY                 Recommended — unauthenticated LiFi requests are rate-limited.
 *   DUST_OBSERVER_SOURCE_TOKEN   Ticker on Arbitrum. Default USDC (only one supported today —
 *                                 see SOURCE_TOKENS below to add more once addresses are known).
 *   DUST_OBSERVER_DEST_TOKEN     Ticker on Base. Default USDC (same-asset baseline, per
 *                                 dust_experiments_outline.org §4 q1). Set to a different
 *                                 ticker for a cross-asset run (§4 q2) once a real, verified
 *                                 Base token address is added to DEST_TOKENS below — this
 *                                 script deliberately does not guess token addresses.
 *   DUST_OBSERVER_AMOUNT         Human units of source token per run. Default "1" (1 USDC).
 *   DUST_OBSERVER_RUN_COUNT      Sequential runs this invocation performs. Default 1.
 *                                 Bounded on purpose — see cost warning above. Runs are
 *                                 sequential, not parallel: parallel runs would race on the
 *                                 same fallbackAddress balance (see methodology caveat below).
 *   DUST_OBSERVER_POLL_INTERVAL_SEC  Seconds between destination-balance polls after the LiFi
 *                                     bridge reports DONE. Default 30.
 *   DUST_OBSERVER_POLL_WINDOW_SEC    How long to keep polling after DONE, to catch delayed
 *                                     sweeps instead of a single before/after snapshot
 *                                     (dust_experiments_outline.org §4 q3 / §5.2). Default 300.
 *   DUST_OBSERVER_SLIPPAGE        Overrides the LiFi slippage tolerance (0-1 range, e.g. "0.3"
 *                                  for 30%) passed to estimateReshieldCrosschainAmount /
 *                                  prepareReshieldCrosschainQuote. Unset by default — the SDK's
 *                                  own smart default applies (3% for cross-chain as of this
 *                                  writing; not hardcoded here, don't duplicate it). Exists to
 *                                  test whether widening the requested tolerance actually
 *                                  inflates the realized destination-side leftover, or whether
 *                                  that leftover is driven by something else — the two real runs
 *                                  so far (0.329% @ $10, 0.475% @ $100, same default slippage
 *                                  both times) don't cleanly support "leftover ~= tolerance", so
 *                                  this isn't assumed to work, only tested.
 *                                  MEV CAVEAT: a wide slippage tolerance on a real swap in a
 *                                  public mempool is a sandwich-attack invitation — low absolute
 *                                  risk at the small amounts this script is meant for, but it's a
 *                                  real mechanism, not just a safe knob. Don't reach for a large
 *                                  value on a large DUST_OBSERVER_AMOUNT.
 *   DUST_OBSERVER_CONFIRM         Must be "yes" to actually spend anything (see COST WARNING).
 *
 * Output: one JSON file per run under scripts/results/dust-leftover-observer-<timestamp>-run<N>.json
 * — append-only across invocations (not a single batch file), since results accumulate one/few
 * at a time over many separate invocations (dust_experiments_outline.org §5.1).
 *
 * Methodology caveat (dust_experiments_outline.org §4 q4): leftover is measured as a balance
 * delta at fallbackAddress (the relayer's own address in this flow) before vs. after each run.
 * At today's near-zero concurrent cross-chain-reshield volume this should isolate one run's
 * contribution cleanly, but if that assumption stops holding (concurrent runs of this script,
 * or another process using the same fallbackAddress), the delta becomes noisy. Not solved here
 * — stated explicitly, per the brief's ask, and echoed into every result record's
 * `methodologyNote` field so downstream analysis doesn't lose the caveat.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    parseAbi,
    parseUnits,
    formatUnits,
    toHex,
    type Address,
    type Hex,
} from "viem";
import { arbitrum, base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import {
    APP_IDENTIFIER,
    CryptoService,
    KeystoreManager,
    LiFiSwapQuoteProvider,
    PoolSessionBuilder,
    type PoolSession,
    type RelayerInfo,
} from "@privacy-pools-v2/evm-sdk";

import { LocalASPTreeService } from "../test/helpers/local-asp-tree.js";
import { getContract } from "../test/helpers/deployment-loader.js";
import { DEPLOYMENT_BLOCK as ARB_DEPLOYMENT_BLOCK } from "../test/contract.config.js";
import {
    LEAF_CACHE_DIR,
    loadSessionLeafCacheSeeds,
    saveSessionLeafCache,
} from "../test/helpers/leaf-cache-store.js";
import { saveRecoverySnapshot, markAsRecovered } from "../test/helpers/recovery-snapshot.js";
import { TestStatePersistence, type MainnetTestState } from "../test/helpers/test-state-persistence.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ---------------------------------------------------------------------------
// Chains — the only two real deployments today. Not a CLI/env param yet
// (matches dust-rescue-cost-matrix.ts's "update when the second L2 lands"
// note, except Base already IS that second chain here).
// ---------------------------------------------------------------------------

const SOURCE_CHAIN_ID = 42_161;
const DEST_CHAIN_ID = 8_453;

const ARB_RPC = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

const ARB_POOL_ADDRESS = getContract(SOURCE_CHAIN_ID, "PoolVault");
const ARB_ENTRYPOINT_ADDRESS = getContract(SOURCE_CHAIN_ID, "Entrypoint");
const ARB_KEYSTORE_ADDRESS = getContract(SOURCE_CHAIN_ID, "Keystore");
const ARB_ASP_REGISTRY_ADDRESS = getContract(SOURCE_CHAIN_ID, "ASPRegistry");
const ARB_RELAY_SWAPS_ADDRESS = getContract(SOURCE_CHAIN_ID, "RelaySwaps");

const BASE_POOL_ADDRESS = getContract(DEST_CHAIN_ID, "PoolVault");
const BASE_ENTRYPOINT_ADDRESS = getContract(DEST_CHAIN_ID, "Entrypoint");
const BASE_KEYSTORE_ADDRESS = getContract(DEST_CHAIN_ID, "Keystore");
const BASE_ASP_REGISTRY_ADDRESS = getContract(DEST_CHAIN_ID, "ASPRegistry");
const BASE_RELAY_SWAPS_ADDRESS = getContract(DEST_CHAIN_ID, "RelaySwaps");

// Binary-searched via `cast code` on the Base Keystore address (2026-08-13) —
// see test/integration_test_standards.org and the reshield-to-base test's own
// copy of this constant. Override with BASE_DEPLOYMENT_BLOCK if a future
// redeploy moves it.
const BASE_DEPLOYMENT_BLOCK = (process.env.BASE_DEPLOYMENT_BLOCK ?? "0x2F904AE") as Hex; // 49874094

const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");

// ---------------------------------------------------------------------------
// Token maps. Deliberately only populated with addresses already verified
// elsewhere in this codebase — this script does not guess token addresses,
// since a wrong one risks real funds. Add an entry (with its provenance
// noted) before pointing DUST_OBSERVER_*_TOKEN at it.
// ---------------------------------------------------------------------------

type TokenSpec = { address: Address; decimals: number };

const SOURCE_TOKENS: Record<string, TokenSpec> = {
    USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address, decimals: 6 },
};

const DEST_TOKENS: Record<string, TokenSpec> = {
    // Verified against mainnet-crosschain-relay-swaps-reshield-to-base.integration.test.ts.
    USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address, decimals: 6 },
};

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const SOURCE_TICKER = process.env.DUST_OBSERVER_SOURCE_TOKEN ?? "USDC";
const DEST_TICKER = process.env.DUST_OBSERVER_DEST_TOKEN ?? "USDC";
const AMOUNT_HUMAN = process.env.DUST_OBSERVER_AMOUNT ?? "1";
const RUN_COUNT = Number(process.env.DUST_OBSERVER_RUN_COUNT ?? "1");
const POLL_INTERVAL_SEC = Number(process.env.DUST_OBSERVER_POLL_INTERVAL_SEC ?? "30");
const POLL_WINDOW_SEC = Number(process.env.DUST_OBSERVER_POLL_WINDOW_SEC ?? "300");
const RELAYER_URL = process.env.RELAYER_URL ?? "http://localhost:3000";
// undefined -> SDK's own default applies (see Env doc above for why this isn't hardcoded here).
const SLIPPAGE: number | undefined =
    process.env.DUST_OBSERVER_SLIPPAGE !== undefined ? Number(process.env.DUST_OBSERVER_SLIPPAGE) : undefined;

const METHODOLOGY_NOTE =
    "Leftover = balance delta at fallbackAddress (relayer's own address) before vs. after this " +
    "run. Assumes near-zero concurrent cross-chain-reshield traffic at the same address during " +
    "the run window — not verified, just assumed given today's volume. See " +
    "dust_experiments_outline.org §4 q4.";

type BalanceSample = { tSecSinceDone: number; balanceHuman: string; leftoverHuman: string };

type ResultRecord = {
    runIndex: number;
    startedAt: string;
    sourceChainId: number;
    destChainId: number;
    sourceToken: string;
    destToken: string;
    amountHuman: string;
    /** The requested LiFi slippage tolerance actually used for this run (0-1 range), or
     * undefined if the SDK's own default applied — see DUST_OBSERVER_SLIPPAGE above. Recorded
     * per-run since the whole point of the override is correlating this against leftover. */
    slippageUsed?: number;
    noteValueHuman?: string;
    /** Relayer's own protocol fee, deducted on the source chain before the swap/bridge — NOT a LiFi/solver charge. Source-token units. */
    relayerFeeAmountHuman?: string;
    /** amount - relayerFeeAmount: what's actually handed to LiFi's swapCalldata. Source-token units. */
    netAmountHuman?: string;
    /** Destination Entrypoint's own vetting fee on the deposit — a protocol charge, not a LiFi/solver charge. Dest-token units. */
    destVettingFeeHuman?: string;
    /** noteValue + destVettingFee: total value the destination deposit call must receive to succeed. Dest-token units. */
    totalDepositCostHuman?: string;
    /**
     * netAmount - totalDepositCost - leftover: what LiFi + the solver(s) it routed through actually
     * kept, as opposed to what reached the destination deposit or the fallback address as leftover.
     * Only computed for same-asset (source ticker === dest ticker) runs — for a cross-asset run,
     * netAmount and totalDepositCost are denominated in two different tokens and a raw subtraction
     * across them isn't a meaningful single fee figure without a USD conversion this script doesn't do.
     */
    lifiAndSolverFeeHuman?: string;
    sourceTxHash?: Hex;
    /** Block the reshield tx landed in on Arbitrum — decimal string (bigint isn't JSON-safe).
     * Recorded so a later pass can re-fetch full tx/receipt/trace detail without re-deriving
     * this from the hash. */
    sourceBlockNumber?: string;
    sourceConfirmedAt?: string;
    destinationTxHash?: Hex;
    /** Block the destination deposit tx landed in on Base — same rationale as sourceBlockNumber. */
    destinationBlockNumber?: string;
    destinationDoneAt?: string;
    fallbackAddress?: Address;
    balanceBeforeHuman?: string;
    balanceSeries: BalanceSample[];
    leftoverFinalHuman?: string;
    leftoverAsFractionOfAmount?: number;
    methodologyNote: string;
    error?: string;
};

// ---------------------------------------------------------------------------

function buildSecretDerivationPayload(signerAddress: Address) {
    const addressHash = keccak256(signerAddress as `0x${string}`);
    return {
        domain: {
            name: "Standardized Secret Derivation",
            version: "1",
            verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
            salt: keccak256(toHex(APP_IDENTIFIER)),
        },
        types: {
            SecretDerivation: [
                { name: "purpose", type: "string" },
                { name: "addressHash", type: "bytes32" },
            ],
        },
        primaryType: "SecretDerivation" as const,
        message: {
            purpose:
                "This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.",
            addressHash,
        },
    };
}

function writeResult(record: ResultRecord): void {
    const outDir = resolve(__dirname, "results");
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `dust-leftover-observer-${Date.now()}-run${record.runIndex}.json`);
    writeFileSync(outPath, JSON.stringify(record, null, 2));
    console.log(`Wrote result: ${outPath}`);
}

async function main() {
    const privateKey = process.env.PRIVATE_KEY as Hex | undefined;
    const postmanPrivateKey = process.env.ASP_POSTMAN_PRIVATE_KEY as Hex | undefined;
    if (!privateKey || !postmanPrivateKey) {
        console.error("PRIVATE_KEY and ASP_POSTMAN_PRIVATE_KEY are both required (real spend, real ASP registration).");
        process.exit(1);
    }

    const sourceSpec = SOURCE_TOKENS[SOURCE_TICKER];
    const destSpec = DEST_TOKENS[DEST_TICKER];
    if (!sourceSpec) {
        console.error(`No verified source-token address for "${SOURCE_TICKER}" — add one to SOURCE_TOKENS first.`);
        process.exit(1);
    }
    if (!destSpec) {
        console.error(`No verified dest-token address for "${DEST_TICKER}" — add one to DEST_TOKENS first.`);
        process.exit(1);
    }
    if (!Number.isInteger(RUN_COUNT) || RUN_COUNT < 1) {
        console.error(`DUST_OBSERVER_RUN_COUNT must be a positive integer, got "${process.env.DUST_OBSERVER_RUN_COUNT}".`);
        process.exit(1);
    }
    if (SLIPPAGE !== undefined && (!Number.isFinite(SLIPPAGE) || SLIPPAGE <= 0 || SLIPPAGE > 1)) {
        console.error(`DUST_OBSERVER_SLIPPAGE must be a number in (0, 1], got "${process.env.DUST_OBSERVER_SLIPPAGE}".`);
        process.exit(1);
    }
    if (SLIPPAGE !== undefined && SLIPPAGE >= 0.2) {
        // Not a hard stop — this script exists specifically to test wide tolerances — but a
        // silent one-line log is easy to miss buried in the rest of the run's output, and the
        // MEV exposure is real (see the Env doc above), so surface it prominently up front.
        console.warn(
            `WARNING: DUST_OBSERVER_SLIPPAGE=${SLIPPAGE} is wide (>=20%). This is a real sandwich-attack ` +
                `surface on a live swap, not just a safe knob. Keep DUST_OBSERVER_AMOUNT small while testing this.`,
        );
    }

    const totalHuman = (Number(AMOUNT_HUMAN) * RUN_COUNT).toString();
    console.log(
        `Planned spend: ${RUN_COUNT} run(s) x ${AMOUNT_HUMAN} ${SOURCE_TICKER} = ${totalHuman} ${SOURCE_TICKER} ` +
            `total deposited (${SOURCE_TICKER} on Arbitrum -> ${DEST_TICKER} on Base), plus real gas + bridge fees ` +
            `+ slippage on every run. Slippage tolerance: ${SLIPPAGE !== undefined ? `${SLIPPAGE} (override)` : "SDK default"}.`,
    );
    if (process.env.DUST_OBSERVER_CONFIRM !== "yes") {
        console.log("DUST_OBSERVER_CONFIRM is not \"yes\" — exiting without spending anything.");
        return;
    }

    const hasCircuits = resolve(CIRCUIT_ARTIFACTS_DIR, "deposit");
    void hasCircuits; // presence checked implicitly by prepareDeposit below; kept for parity with the test's early check

    const account = privateKeyToAccount(privateKey);
    const postmanAccount = privateKeyToAccount(postmanPrivateKey);

    const arbPublicClient = createPublicClient({ chain: arbitrum, transport: http(ARB_RPC) });
    const arbWalletClient = createWalletClient({ account, chain: arbitrum, transport: http(ARB_RPC) });
    const arbPostmanWalletClient = createWalletClient({ account: postmanAccount, chain: arbitrum, transport: http(ARB_RPC) });

    const basePublicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) }) as unknown as ReturnType<
        typeof createPublicClient
    >;
    const baseWalletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });
    const basePostmanWalletClient = createWalletClient({ account: postmanAccount, chain: base, transport: http(BASE_RPC) });

    // Dedicated state file — deliberately NOT the mainnet integration suites'
    // .mainnet-test-state.json, even though it's the same wallet, to avoid two
    // independently-invoked processes racing on the same persisted ASP-leaves /
    // keystoreRegistered state.
    const persistence = new TestStatePersistence(resolve(__dirname, "../.dust-leftover-observer-state.json"));
    const savedState = persistence.load();

    let protocolKeys: MainnetTestState["protocolKeys"];
    if (savedState?.protocolKeys) {
        protocolKeys = savedState.protocolKeys;
        console.log("Loaded protocol keys from state file");
    } else {
        const cryptoService = new CryptoService();
        const payload = buildSecretDerivationPayload(account.address as Address);
        const signature = await arbWalletClient.signTypedData({ ...payload, account });
        const addressHash = keccak256(account.address as `0x${string}`);
        const km = KeystoreManager.fromSignature(
            {
                signature: signature as Hex,
                signerAddress: account.address as Address,
                revocableKeyIndex: "0x0" as Hex,
                addressHash: addressHash as Hex,
            },
            { cryptoService },
        );
        const viewingKeyPair = km.getViewingKeyPair();
        protocolKeys = {
            privateNullifyingKey: km.getPrivateNullifyingKey(),
            privateRevocableKey: km.getPrivateRevocableKey(),
            revocableKeyIndex: km.getRevocableKeyIndex(),
            viewingPrivateKey: viewingKeyPair.privateKey,
            viewingPublicKey: viewingKeyPair.publicKey,
        };
        console.log("Derived fresh protocol keys from signature");
    }

    const state: MainnetTestState = savedState ?? { protocolKeys, aspLeaves: [], keystoreRegistered: false };
    state.protocolKeys = protocolKeys;
    persistence.save(state);

    const sourceASP = await LocalASPTreeService.create(
        { aspRegistryAddress: ARB_ASP_REGISTRY_ADDRESS, walletClient: arbPostmanWalletClient as any, publicClient: arbPublicClient as any },
        state.aspLeaves.length > 0 ? state.aspLeaves : undefined,
    );

    const relayerInfo: RelayerInfo = {
        url: RELAYER_URL,
        name: "local",
        chainId: SOURCE_CHAIN_ID,
        chainType: "evm",
        status: "active",
        address: account.address as Address,
        processorAddress: ARB_RELAY_SWAPS_ADDRESS as Address,
    };

    const lifiProvider = new LiFiSwapQuoteProvider({
        ...(process.env.LIFI_API_KEY ? { apiKey: process.env.LIFI_API_KEY } : {}),
    });

    const NOTE_STORAGE_DIR = resolve(__dirname, "../.dust-leftover-observer-notes");
    // Shared with the mainnet integration suites and scanned by
    // mainnet-recover-snapshots.integration.test.ts — deliberately NOT
    // NOTE_STORAGE_DIR above, so a crash mid-run leaves a note this script
    // doesn't own its own bespoke recovery for.
    const RECOVERY_SNAPSHOT_DIR = resolve(__dirname, "../.mainnet-deposit-notes");

    const sourceSession: PoolSession = await PoolSessionBuilder.fromConfig({
        chainId: SOURCE_CHAIN_ID,
        rpcUrl: ARB_RPC,
        ownerAddress: account.address as Address,
        deployment: {
            poolAddress: ARB_POOL_ADDRESS as Address,
            entrypointAddress: ARB_ENTRYPOINT_ADDRESS as Address,
            keystoreAddress: ARB_KEYSTORE_ADDRESS as Address,
            aspRegistryAddress: ARB_ASP_REGISTRY_ADDRESS as Address,
            relaySwapsAddress: ARB_RELAY_SWAPS_ADDRESS as Address,
        },
        ...loadSessionLeafCacheSeeds(LEAF_CACHE_DIR, SOURCE_CHAIN_ID, {
            keystoreAddress: ARB_KEYSTORE_ADDRESS as Address,
            poolAddress: ARB_POOL_ADDRESS as Address,
        }),
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [relayerInfo],
        persistentStorage: { type: "file", dirPath: NOTE_STORAGE_DIR },
        walletInteractor: { type: "viem", walletClient: arbWalletClient as any },
        deploymentBlock: ARB_DEPLOYMENT_BLOCK,
        destinationChainId: DEST_CHAIN_ID,
        destinationRpcUrl: BASE_RPC,
        destinationDeployment: {
            poolAddress: BASE_POOL_ADDRESS as Address,
            entrypointAddress: BASE_ENTRYPOINT_ADDRESS as Address,
            keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
            aspRegistryAddress: BASE_ASP_REGISTRY_ADDRESS as Address,
            relaySwapsAddress: BASE_RELAY_SWAPS_ADDRESS as Address,
        },
    } as any)
        .withAspDataProvider(sourceASP)
        .withSwapQuoteProvider(lifiProvider)
        .withSwapAndDepositQuoteProvider(lifiProvider)
        .create();

    if (!(await sourceSession.isKeystoreRegistered())) {
        console.log("Registering source (Arbitrum) keystore...");
        await sourceSession.registerKeystore();
        state.keystoreRegistered = true;
        persistence.save(state);
    }

    for (let runIndex = 1; runIndex <= RUN_COUNT; runIndex++) {
        console.log(`\n=== RUN ${runIndex}/${RUN_COUNT} ===`);
        const record: ResultRecord = {
            runIndex,
            startedAt: new Date().toISOString(),
            sourceChainId: SOURCE_CHAIN_ID,
            destChainId: DEST_CHAIN_ID,
            sourceToken: SOURCE_TICKER,
            destToken: DEST_TICKER,
            amountHuman: AMOUNT_HUMAN,
            slippageUsed: SLIPPAGE,
            balanceSeries: [],
            methodologyNote: METHODOLOGY_NOTE,
        };

        try {
            const amountWei = parseUnits(AMOUNT_HUMAN, sourceSpec.decimals);
            const depositValue = `0x${amountWei.toString(16)}` as Hex;

            const depositResult = await sourceSession.prepareDeposit({ tokenId: sourceSpec.address, value: depositValue });
            mkdirSync(NOTE_STORAGE_DIR, { recursive: true });
            writeFileSync(
                resolve(NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
                JSON.stringify(depositResult.pendingNote, null, 2),
            );

            const depositReceipt = await sourceSession.executeDeposit(depositResult);
            if (!depositReceipt.status) throw new Error(`Source deposit failed: ${depositReceipt.txHash}`);
            console.log("Source deposit tx:", depositReceipt.txHash);

            const depositTx = await arbPublicClient.getTransaction({ hash: depositReceipt.txHash as `0x${string}` });
            record.sourceBlockNumber = depositTx.blockNumber!.toString();
            const snapshotPath = await saveRecoverySnapshot({
                publicClient: arbPublicClient as any,
                chainId: SOURCE_CHAIN_ID,
                depositTxHash: depositReceipt.txHash as Hex,
                depositBlock: depositTx.blockNumber!,
                deploymentBlock: ARB_DEPLOYMENT_BLOCK,
                ownerAddress: account.address as Address,
                contracts: {
                    pool: ARB_POOL_ADDRESS as Address,
                    entrypoint: ARB_ENTRYPOINT_ADDRESS as Address,
                    keystore: ARB_KEYSTORE_ADDRESS as Address,
                    aspRegistry: ARB_ASP_REGISTRY_ADDRESS as Address,
                },
                protocolKeys: state.protocolKeys,
                note: depositResult.pendingNote,
                storageDir: RECOVERY_SNAPSHOT_DIR,
            });

            const label = depositResult.pendingNote.label as `0x${string}`;
            await sourceASP.registerLabel(label);
            const serialized = sourceASP.serialize();
            state.aspLeaves = serialized.leaves;
            persistence.save(state);

            const fromBlock = `0x${(depositTx.blockNumber! - 1n).toString(16)}` as Hex;
            await sourceSession.discoverNotes({ fromBlock });

            const estimate = await sourceSession.estimateReshieldCrosschainAmount({
                relayerInfo,
                amount: `0x${amountWei.toString(16)}` as Hex,
                tokenId: sourceSpec.address,
                outputToken: destSpec.address,
                toChainId: DEST_CHAIN_ID,
                denyExchanges: ["fly"],
                ...(SLIPPAGE !== undefined ? { slippage: SLIPPAGE } : {}),
            });
            record.noteValueHuman = formatUnits(BigInt(estimate.noteValue), destSpec.decimals);
            record.relayerFeeAmountHuman = formatUnits(BigInt(estimate.feeAmount), sourceSpec.decimals);
            record.destVettingFeeHuman = formatUnits(BigInt(estimate.vettingFee), destSpec.decimals);
            record.totalDepositCostHuman = formatUnits(BigInt(estimate.totalDepositCost), destSpec.decimals);
            console.log("Recommended dest note value:", record.noteValueHuman, DEST_TICKER);

            // Destination session — fresh ASP each run (deploymentBlock-pinned scan is cheap),
            // memory-backed storage since we only need prepareDeposit(), matching the test pattern.
            const destASP = await LocalASPTreeService.create({
                aspRegistryAddress: BASE_ASP_REGISTRY_ADDRESS,
                walletClient: basePostmanWalletClient as any,
                publicClient: basePublicClient as any,
            });
            const destSession: PoolSession = await PoolSessionBuilder.fromConfig({
                chainId: DEST_CHAIN_ID,
                rpcUrl: BASE_RPC,
                ownerAddress: account.address as Address,
                deployment: {
                    poolAddress: BASE_POOL_ADDRESS as Address,
                    entrypointAddress: BASE_ENTRYPOINT_ADDRESS as Address,
                    keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
                    aspRegistryAddress: BASE_ASP_REGISTRY_ADDRESS as Address,
                    relaySwapsAddress: BASE_RELAY_SWAPS_ADDRESS as Address,
                },
                ...loadSessionLeafCacheSeeds(LEAF_CACHE_DIR, DEST_CHAIN_ID, {
                    keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
                    poolAddress: BASE_POOL_ADDRESS as Address,
                }),
                protocolKeys,
                circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
                relayers: [
                    {
                        url: "http://localhost:3000",
                        name: "unused",
                        chainId: DEST_CHAIN_ID,
                        chainType: "evm",
                        status: "active",
                        address: account.address as Address,
                        processorAddress: account.address as Address,
                    },
                ],
                persistentStorage: { type: "memory" },
                walletInteractor: { type: "viem", walletClient: baseWalletClient as any },
                deploymentBlock: BASE_DEPLOYMENT_BLOCK,
            } as any)
                .withAspDataProvider(destASP)
                .create();

            if (!(await destSession.isKeystoreRegistered())) {
                console.log("Registering dest (Base) keystore...");
                await destSession.registerKeystore();
            }

            const destDepositResult = await destSession.prepareDeposit({ tokenId: destSpec.address, value: estimate.noteValue });
            writeFileSync(
                resolve(NOTE_STORAGE_DIR, `base-pending-${Date.now()}.json`),
                JSON.stringify(destDepositResult.pendingNote, null, 2),
            );

            const balanceBefore = await basePublicClient.readContract({
                address: destSpec.address,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [account.address],
            });
            record.balanceBeforeHuman = formatUnits(balanceBefore, destSpec.decimals);

            const prepared = await sourceSession.prepareReshieldCrosschainQuote({
                relayerInfo,
                amount: `0x${amountWei.toString(16)}` as Hex,
                tokenId: sourceSpec.address,
                outputToken: destSpec.address,
                toChainId: DEST_CHAIN_ID,
                depositResult: destDepositResult,
                totalDepositCost: estimate.totalDepositCost,
                denyExchanges: ["fly"],
                ...(SLIPPAGE !== undefined ? { slippage: SLIPPAGE } : {}),
            });
            record.fallbackAddress = prepared.fallbackAddress;
            record.netAmountHuman = formatUnits(BigInt(prepared.netAmount), sourceSpec.decimals);

            const txReceipt = await sourceSession.relayReshieldCrosschain({
                inputCommitments: [depositResult.pendingNote.commitment as `0x${string}`],
                amount: prepared.netAmount,
                tokenId: sourceSpec.address,
                outputToken: destSpec.address,
                toChainId: DEST_CHAIN_ID,
                fallbackAddress: prepared.fallbackAddress,
                swapCalldata: prepared.swapCalldata,
                selectedQuote: prepared.selectedQuote,
                dustRecipient: prepared.dustRecipient,
                swapTarget: prepared.swapTarget,
                approvalAddress: prepared.approvalAddress,
                depositNote: prepared.depositNote,
            });
            if (!txReceipt.status) throw new Error(`Reshield tx failed: ${txReceipt.txHash}`);
            record.sourceTxHash = txReceipt.txHash as Hex;
            record.sourceConfirmedAt = new Date().toISOString();
            console.log("Reshield tx:", txReceipt.txHash);

            markAsRecovered(snapshotPath);

            console.log("Waiting for bridge + deposit on Base (polling LiFi status)...");
            const maxWaitMs = 600_000;
            const statusPollMs = 15_000;
            const waitStart = Date.now();
            let destinationTxHash: Hex | undefined;
            while (Date.now() - waitStart < maxWaitMs) {
                const status = await lifiProvider.getSwapStatus({
                    txHash: txReceipt.txHash as Hex,
                    fromChainId: SOURCE_CHAIN_ID,
                    toChainId: DEST_CHAIN_ID,
                });
                if (status.status === "DONE" && status.receiving?.txHash) {
                    destinationTxHash = status.receiving.txHash;
                    break;
                }
                if (status.status === "FAILED") {
                    throw new Error(`LiFi bridge FAILED: ${status.substatusMessage ?? status.substatus ?? "no detail"}`);
                }
                await new Promise((r) => setTimeout(r, statusPollMs));
            }
            if (!destinationTxHash) throw new Error(`Bridge did not complete within ${maxWaitMs / 1000}s`);
            record.destinationTxHash = destinationTxHash;
            record.destinationDoneAt = new Date().toISOString();
            console.log("Bridge complete, Base tx:", destinationTxHash);

            const destinationTx = await basePublicClient.getTransaction({ hash: destinationTxHash });
            record.destinationBlockNumber = destinationTx.blockNumber.toString();
            await saveRecoverySnapshot({
                publicClient: basePublicClient as any,
                chainId: DEST_CHAIN_ID,
                depositTxHash: destinationTxHash,
                depositBlock: destinationTx.blockNumber,
                deploymentBlock: BASE_DEPLOYMENT_BLOCK,
                ownerAddress: account.address as Address,
                contracts: {
                    pool: BASE_POOL_ADDRESS as Address,
                    entrypoint: BASE_ENTRYPOINT_ADDRESS as Address,
                    keystore: BASE_KEYSTORE_ADDRESS as Address,
                    aspRegistry: BASE_ASP_REGISTRY_ADDRESS as Address,
                },
                protocolKeys: state.protocolKeys,
                note: destDepositResult.pendingNote,
                storageDir: RECOVERY_SNAPSHOT_DIR,
            });

            // Timing instrumentation (§4 q3 / §5.2): keep polling past DONE instead
            // of a single before/after pair, to catch delayed sweeps and build an
            // actual delivery-latency curve.
            const doneAt = Date.now();
            while (Date.now() - doneAt < POLL_WINDOW_SEC * 1000) {
                const balanceNow = await basePublicClient.readContract({
                    address: destSpec.address,
                    abi: ERC20_ABI,
                    functionName: "balanceOf",
                    args: [account.address],
                });
                const leftover = balanceNow - balanceBefore;
                record.balanceSeries.push({
                    tSecSinceDone: Math.round((Date.now() - doneAt) / 1000),
                    balanceHuman: formatUnits(balanceNow, destSpec.decimals),
                    leftoverHuman: formatUnits(leftover, destSpec.decimals),
                });
                await new Promise((r) => setTimeout(r, POLL_INTERVAL_SEC * 1000));
            }

            const last = record.balanceSeries[record.balanceSeries.length - 1];
            if (last) {
                record.leftoverFinalHuman = last.leftoverHuman;
                record.leftoverAsFractionOfAmount = Number(last.leftoverHuman) / Number(AMOUNT_HUMAN);
            }
            console.log(
                `Run ${runIndex} leftover: ${record.leftoverFinalHuman ?? "n/a"} ${DEST_TICKER} ` +
                    `(${((record.leftoverAsFractionOfAmount ?? 0) * 100).toFixed(4)}% of amount)`,
            );

            // LiFi + solver fee = what's fed into the swap/bridge minus what actually reached the
            // destination deposit or the fallback address. Only meaningful when source and dest are
            // the same asset — see the ResultRecord field doc for why a cross-asset run can't do this
            // as a plain subtraction.
            if (SOURCE_TICKER === DEST_TICKER && record.netAmountHuman && record.totalDepositCostHuman && record.leftoverFinalHuman) {
                const lifiFee =
                    Number(record.netAmountHuman) - Number(record.totalDepositCostHuman) - Number(record.leftoverFinalHuman);
                record.lifiAndSolverFeeHuman = lifiFee.toString();
                console.log(
                    `Run ${runIndex} LiFi + solver fee: ${record.lifiAndSolverFeeHuman} ${DEST_TICKER} ` +
                        `(${((lifiFee / Number(AMOUNT_HUMAN)) * 100).toFixed(4)}% of amount)`,
                );
            }

            saveSessionLeafCache(LEAF_CACHE_DIR, DEST_CHAIN_ID, {
                keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
                poolAddress: BASE_POOL_ADDRESS as Address,
            }, destSession);
        } catch (err) {
            record.error = (err as Error).message;
            console.error(`Run ${runIndex} failed:`, err);
        }

        writeResult(record);
    }

    saveSessionLeafCache(LEAF_CACHE_DIR, SOURCE_CHAIN_ID, {
        keystoreAddress: ARB_KEYSTORE_ADDRESS as Address,
        poolAddress: ARB_POOL_ADDRESS as Address,
    }, sourceSession);

    console.log(`\nDone. ${RUN_COUNT} run(s) completed, results under scripts/results/.`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
