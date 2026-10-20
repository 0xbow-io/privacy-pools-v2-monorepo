/**
 * One-off ragequit recovery for a stuck MAINNET source-deposit note left by
 * `live-relayer-mainnet-to-optimism-eth-dust-rescue.integration.test.sketch.ts` (the
 * direction mirror of the Optimism->Mainnet sketch). Companion to
 * `test/recover-op-dust-note.ts` — same logic, chain 1 instead of chain 10.
 *
 * Ragequit needs neither ASP approval nor tree inclusion (see
 * packages/circuits/docs/circuits/Ragequit.md), so it recovers the note regardless of
 * which step of the sketch stranded it.
 *
 * COST: this submits a ragequit proof + tx on Ethereum L1 — budget ~$5-15 of gas
 * depending on gas price. There is no cheaper path for a stranded Mainnet note.
 *
 * Deliberately NOT run through mainnet-recover-snapshots.integration.test.ts (which
 * ragequits every unrecovered snapshot in the shared .mainnet-deposit-notes/ dir).
 * This script targets only the one snapshot below, in its own directory.
 *
 * Run from packages/swaps:
 *   npx tsx test/recover-mainnet-dust-note.ts                        # dry run: reports note status only
 *   RAGEQUIT_CONFIRM=yes npx tsx test/recover-mainnet-dust-note.ts   # actually submits the ragequit tx
 *
 * Requires ASP_POSTMAN_PRIVATE_KEY and RPC_URL_1 in the environment. The snapshot's
 * owner (0x0967755AfA2016866D12EefB820705026842dCe8) is that wallet — see the handoff
 * doc's "Deliberate deviation, still open" section.
 *
 * Retarget SNAPSHOT_PATH below to the actual stranded-note file before running — the
 * sketch writes snapshots to .live-mainnet-op-dust-rescue-mainnet-deposit-notes/ with a
 * `recovery-0x<id>-<ts>.json` name.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  PoolSessionBuilder,
  ViemRPCInteractor,
  NoteStatus,
} from "@privacy-pools-v2/evm-sdk";
import type { Address, Hash, Hex, ILogger } from "@privacy-pools-v2/evm-sdk";

import {
  loadRecoverySnapshot,
  markAsRecovered,
  SnapshotRPCInteractor,
} from "./helpers/recovery-snapshot.js";
import { LocalASPTreeService } from "./helpers/local-asp-tree.js";
import { getContract } from "./helpers/deployment-loader.js";

// Points getContract() at the it-003 registry (Mainnet+Optimism) rather than the
// default it-002 (Arbitrum/Base) — must be set before the getContract() call below runs.
process.env.RELAY_SWAPS_DEPLOYMENTS_PATH = resolve(
  __dirname,
  "../contracts/deployments-it-003.json",
);

const MAINNET_CHAIN_ID = 1;
const MAINNET_RPC = process.env.RPC_URL_1 ?? "https://eth.llamarpc.com";
const PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const SNAPSHOT_PATH = resolve(
  __dirname,
  "../.live-mainnet-op-dust-rescue-mainnet-deposit-notes/recovery-0x1b1e4e74-1788046253666.json",
);
const RELAY_SWAPS_ADDRESS = getContract(MAINNET_CHAIN_ID, "RelaySwaps");

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const consoleLogger: ILogger = {
  level: "debug",
  child(service: string): ILogger {
    return {
      ...consoleLogger,
      debug: (msg: string, obj?: object) =>
        console.log(`[${service}]`, msg, obj ?? ""),
    };
  },
  debug: (msg: string, obj?: object) => console.log("[sdk]", msg, obj ?? ""),
  info: (msg: string, obj?: object) => console.log("[sdk]", msg, obj ?? ""),
  warn: (msg: string, obj?: object) => console.warn("[sdk]", msg, obj ?? ""),
  error: (msg: string, obj?: object) => console.error("[sdk]", msg, obj ?? ""),
  fatal: (msg: string, obj?: object) =>
    console.error("[sdk:fatal]", msg, obj ?? ""),
};

async function main() {
  if (!PRIVATE_KEY) throw new Error("ASP_POSTMAN_PRIVATE_KEY is not set");
  if (SNAPSHOT_PATH.endsWith("recovery-CHANGEME.json")) {
    throw new Error(
      "SNAPSHOT_PATH still points at the placeholder — retarget it to the actual " +
        "stranded-note file in .live-mainnet-op-dust-rescue-mainnet-deposit-notes/",
    );
  }

  const snapshot = loadRecoverySnapshot(SNAPSHOT_PATH);
  if (snapshot.recoveredAt) {
    console.log(
      `Already marked recovered at ${snapshot.recoveredAt} — nothing to do.`,
    );
    return;
  }

  const account = privateKeyToAccount(PRIVATE_KEY as Hex);
  if (account.address.toLowerCase() !== snapshot.ownerAddress.toLowerCase()) {
    throw new Error(
      `Signing wallet ${account.address} does not match snapshot owner ${snapshot.ownerAddress}`,
    );
  }

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(MAINNET_RPC),
  });
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(MAINNET_RPC),
  });

  const realRpc = new ViemRPCInteractor(
    {
      publicClient: publicClient as any,
      chunkSize: 2_000_000n,
      minFromBlock: BigInt(snapshot.deploymentBlock),
    },
    { logger: consoleLogger },
  );
  const snapshotRpc = new SnapshotRPCInteractor(realRpc, snapshot);

  // Ragequit bypasses ASP compliance by design (Ragequit.md) — this stub only
  // satisfies PoolSessionBuilder's requirement for an ASP data provider.
  const localASP = await LocalASPTreeService.create({
    aspRegistryAddress: snapshot.contracts.aspRegistry,
    walletClient: walletClient as any,
    publicClient: publicClient as any,
  });

  const session = await PoolSessionBuilder.fromConfig({
    chainId: MAINNET_CHAIN_ID,
    rpcUrl: MAINNET_RPC,
    ownerAddress: snapshot.ownerAddress,
    deployment: {
      poolAddress: snapshot.contracts.pool,
      entrypointAddress: snapshot.contracts.entrypoint,
      keystoreAddress: snapshot.contracts.keystore,
      aspRegistryAddress: snapshot.contracts.aspRegistry,
      relaySwapsAddress: RELAY_SWAPS_ADDRESS as Address,
    },
    protocolKeys: snapshot.protocolKeys,
    circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
    relayers: [
      {
        url: "http://localhost:3000",
        name: "unused",
        chainId: MAINNET_CHAIN_ID,
        chainType: "evm",
        status: "active" as const,
        address: account.address as Address,
        processorAddress: account.address as Address,
      },
    ],
    persistentStorage: { type: "memory" },
    walletInteractor: { type: "viem", walletClient: walletClient as any },
    logger: consoleLogger,
    deploymentBlock: snapshot.deploymentBlock,
  })
    .withAspDataProvider(localASP)
    .withRpcInteractor(snapshotRpc)
    .create();

  const depositBlockN = BigInt(snapshot.depositBlock);
  const fromBlock = `0x${(depositBlockN - 1n).toString(16)}` as Hex;
  console.log(`Discovering note from block ${fromBlock}...`);
  const notes = await session.discoverNotes({ fromBlock });
  const discovered = notes.find(
    (n) =>
      n.commitment.toLowerCase() === snapshot.note.commitment.toLowerCase(),
  );

  if (!discovered) {
    throw new Error(
      `Note ${snapshot.note.commitment} not found in discovery scan`,
    );
  }
  console.log(`Note status: ${discovered.status}`);
  if (discovered.status !== NoteStatus.ACTIVE) {
    console.log(
      "Not ACTIVE — nothing more to do (already spent, or genuinely still pending).",
    );
    return;
  }

  const tokenId = snapshot.note.tokenId as Address;
  const decimals = (await publicClient.readContract({
    address: tokenId,
    abi: ERC20_ABI,
    functionName: "decimals",
  })) as number;
  const balanceBefore = (await publicClient.readContract({
    address: tokenId,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  console.log(
    `Note is ACTIVE and ragequit-eligible. Balance before: ${formatUnits(balanceBefore, decimals)}`,
  );

  if (process.env.RAGEQUIT_CONFIRM !== "yes") {
    console.log(
      "Dry run only (RAGEQUIT_CONFIRM not set to 'yes') — not submitting the ragequit tx. " +
        "Re-run with RAGEQUIT_CONFIRM=yes to actually recover the funds.",
    );
    return;
  }

  console.log(
    "Generating ragequit proof and submitting (Ethereum L1 — this costs gas)...",
  );
  const receipt = await session.rageQuit({
    commitment: snapshot.note.commitment as Hash,
  });
  console.log(`Ragequit tx: ${receipt.txHash} | status: ${receipt.status}`);
  if (!receipt.status) throw new Error("Ragequit transaction reverted");

  const balanceAfter = (await publicClient.readContract({
    address: tokenId,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  console.log(`Balance after: ${formatUnits(balanceAfter, decimals)}`);
  console.log(
    `Recovered: ${formatUnits(balanceAfter - balanceBefore, decimals)}`,
  );

  markAsRecovered(SNAPSHOT_PATH);
  console.log("Snapshot marked as recovered.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
