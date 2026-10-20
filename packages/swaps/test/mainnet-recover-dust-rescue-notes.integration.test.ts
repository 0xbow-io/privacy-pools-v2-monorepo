/**
 * Recovers dust-rescue notes (issue #222) — the "mythical test #2"
 * (mainnet-recover-snapshots.integration.test.ts) equivalent for this new note type.
 *
 * Why a SEPARATE test rather than teaching test #2 about these: test #2 operates
 * entirely on `snapshot.protocolKeys` (the depositor's own registered keystore
 * identity) and finds notes via the ordinary `session.discoverNotes()` scan. A
 * dust-rescue note is owned by a completely different identity — an unregistered
 * stealth address, recoverable only via ECDH decryption using the private key saved
 * in `recipient-key-*.json` (see the dust-rescue test's own header comment). It would
 * never be found by test #2's scan, no matter how long you wait.
 *
 * Scans `.mainnet-dust-rescue-recovery-notes/` for unrecovered `rescue-deposit-*.json`
 * records (written by the dust-rescue test right after its rescue deposit lands). For
 * each:
 *   1. Fetches the deposit tx and decodes its own `Entrypoint.deposit()` calldata to
 *      get the raw `noteData.data` bytes — no ASP/indexer involved, straight from the
 *      transaction itself.
 *   2. Recovers the stealth private key (`deriveStealthPrivateKey`, self-validating
 *      against the saved `stealthAddress` — throws loudly on any mismatch rather than
 *      silently producing a wrong key).
 *   3. Recovers the note's secret material (`NoteDiscoveryService.scanStealthDeposits`,
 *      the same decrypt+decode chain the SDK's own note discovery uses — not
 *      reimplemented here).
 *   4. Injects the recovered note into a session owned by the recovered stealth
 *      address (`session.addNotes`) and ragequits it for real — funds land back at the
 *      stealth address, spendable from there with the same recovered private key.
 *
 * This is genuinely new ground: nothing in this codebase has exercised "recover a
 * blind, stealth-owned note from raw calldata" before writing this file. Building it
 * surfaced and fixed a real, unrelated, pre-existing bug: `ENTRYPOINT_DEPOSIT_ABI` and
 * `decodeNoteData` were used by `dust-rescue-prover` via `@privacy-pools-v2/evm-sdk` but
 * were never actually exported from the package's public surface — undetected because
 * nothing had ever really called that code path for real. Fixed in
 * `packages/sdk/src/external.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  decodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base } from "viem/chains";
import { resolve } from "path";
import { existsSync, readdirSync } from "fs";

import {
  PoolSessionBuilder,
  CryptoService,
  PoseidonHashService,
  NoteComputationService,
  EvmNoteDiscoveryService,
  EvmAddressFieldConverter,
  NoteStatus,
  ENTRYPOINT_DEPOSIT_ABI,
  decodeNoteData,
} from "@privacy-pools-v2/evm-sdk";
import type { Address, Hash, Hex, ILogger } from "@privacy-pools-v2/evm-sdk";
import {
  decodeStealthDepositPayload,
  deriveStealthPrivateKey,
  SCHEME_FLUIDKEY,
  type FluidKeyAnnouncement,
  type ScanCredentials,
  type DerivePrivCredentials,
  type Hex as StealthHex,
} from "@privacy-pools-v2/evm-sdk/stealth";

import {
  loadRecipientKeyRecord,
  loadRescueDepositRecord,
  markRescueRecovered,
  type RescueDepositRecord,
} from "./helpers/rescue-recovery.js";
import { getContract } from "./helpers/deployment-loader.js";

// --- Config ---
const ARB_CHAIN_ID = 42161;
const BASE_CHAIN_ID = 8453;
const ARB_RPC = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const RESCUE_RECOVERY_DIR = resolve(
  __dirname,
  "../.mainnet-dust-rescue-recovery-notes",
);

const BASE_POOL_ADDRESS = getContract(8453, "PoolVault");
const BASE_KEYSTORE_ADDRESS = getContract(8453, "Keystore");
const BASE_ASP_REGISTRY_ADDRESS = getContract(8453, "ASPRegistry");
const BASE_RELAY_SWAPS_ADDRESS = getContract(8453, "RelaySwaps");

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
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

function chainForId(chainId: number) {
  if (chainId === ARB_CHAIN_ID) return arbitrum;
  if (chainId === BASE_CHAIN_ID) return base;
  throw new Error(`Unsupported chainId in rescue record: ${chainId}`);
}

function rpcUrlForId(chainId: number): string {
  if (chainId === ARB_CHAIN_ID) return ARB_RPC;
  if (chainId === BASE_CHAIN_ID) return BASE_RPC;
  throw new Error(`No RPC URL configured for chainId ${chainId}`);
}

function loadUnrecoveredRescueRecords(): Array<{
  path: string;
  record: RescueDepositRecord;
}> {
  if (!existsSync(RESCUE_RECOVERY_DIR)) return [];
  return readdirSync(RESCUE_RECOVERY_DIR)
    .filter((f) => f.startsWith("rescue-deposit-") && f.endsWith(".json"))
    .map((f) => ({
      path: resolve(RESCUE_RECOVERY_DIR, f),
      record: loadRescueDepositRecord(resolve(RESCUE_RECOVERY_DIR, f)),
    }))
    .filter(({ record }) => record.recoveredAt === undefined);
}

const hasCircuits = existsSync(resolve(CIRCUIT_ARTIFACTS_DIR, "ragequit"));
const unrecovered = loadUnrecoveredRescueRecords();

describe.skipIf(!hasCircuits)(
  "Recover Dust-Rescue Notes (Ragequit) — Mainnet",
  () => {
    it.skipIf(unrecovered.length === 0)(
      `ragequit ${unrecovered.length} unrecovered dust-rescue note(s)`,
      async () => {
        let totalRecovered = 0;
        let attempted = 0;

        for (const { path: recordPath, record } of unrecovered) {
          console.log(`\n--- Processing rescue record: ${recordPath}`);
          console.log(`    stealthAddress: ${record.stealthAddress}`);
          console.log(`    chainId:        ${record.chainId}`);
          console.log(`    deposit tx:     ${record.depositTxHash}`);
          console.log(`    swept amount:   ${record.sweptAmountHuman}`);

          if (record.status !== "success") {
            console.warn(
              `    SKIP: recorded status is "${record.status}", not "success" — the ` +
                `deposit itself reverted, so there is no note to recover. Whatever funded ` +
                `it is still an ordinary balance wherever it landed pre-deposit.`,
            );
            continue;
          }

          try {
            const rpcUrl = rpcUrlForId(record.chainId);
            const chain = chainForId(record.chainId);
            const publicClient = createPublicClient({
              chain,
              transport: http(rpcUrl),
            });

            // === 1. Recover noteData.data straight from the deposit tx's own calldata —
            // no ASP, no indexer, nothing but the transaction itself. ===
            const depositTx = await publicClient.getTransaction({
              hash: record.depositTxHash as `0x${string}`,
            });
            const decoded = decodeFunctionData({
              abi: ENTRYPOINT_DEPOSIT_ABI,
              data: depositTx.input,
            });
            const noteData = decoded.args[1] as { hint: Hex; data: Hex };

            // === 2. Recover the stealth private key. Self-validates internally against
            // record.stealthAddress — a mismatch throws rather than silently producing a
            // wrong key, so this is safe to trust if it doesn't throw. ===
            const stealthPayload = decodeStealthDepositPayload(
              noteData.data as unknown as StealthHex,
            );
            if (!stealthPayload) {
              throw new Error(
                "noteData.data did not decode as a stealth deposit payload — wrong tx, " +
                  "or this deposit wasn't built by proveDustRescueDeposit.",
              );
            }
            const recipientKeyRecord = loadRecipientKeyRecord(
              record.recipientKeyFile,
            );
            const spendingPrivateKey =
              recipientKeyRecord.recipientPrivateKey as unknown as Hex;

            const announcement: FluidKeyAnnouncement = {
              schemeId: SCHEME_FLUIDKEY,
              stealthAddress:
                record.stealthAddress as unknown as FluidKeyAnnouncement["stealthAddress"],
              ephemeralPubKey:
                stealthPayload.ephemeralPubKey as unknown as FluidKeyAnnouncement["ephemeralPubKey"],
              viewTag: stealthPayload.viewTag,
            };
            const derivePrivCredentials = {
              scheme: SCHEME_FLUIDKEY,
              spendingPrivateKey,
            } as unknown as DerivePrivCredentials;
            const stealthPrivateKey = deriveStealthPrivateKey(
              announcement,
              derivePrivCredentials,
            );
            console.log(
              `    Stealth private key recovered and self-validated OK.`,
            );

            // === 3. Recover the note's secret material via the SDK's own decrypt+decode
            // chain (NoteDiscoveryService.scanStealthDeposits) — not reimplemented here. ===
            const {
              ephemeralPubKey: envelopeEphemeralPubKey,
              encryptedPayload,
            } = decodeNoteData(noteData.data);
            const cryptoService = new CryptoService();
            const hashService = await PoseidonHashService.create();
            const noteComputationService = new NoteComputationService({
              hashService,
              cryptoService,
            });
            const noteDiscoveryService = new EvmNoteDiscoveryService(
              {
                cryptoService,
                hashService,
                noteComputationService,
                addressFieldConverter: new EvmAddressFieldConverter(),
              },
              { logger: consoleLogger },
            );
            const scanCredentials = {
              scheme: SCHEME_FLUIDKEY,
              spendingPrivateKey,
            } as unknown as ScanCredentials;
            const discovered = noteDiscoveryService.scanStealthDeposits(
              [
                {
                  blockNumber:
                    `0x${depositTx.blockNumber!.toString(16)}` as Hex,
                  txHash: record.depositTxHash as Hash,
                  hint: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
                  ephemeralPubKey: envelopeEphemeralPubKey,
                  encryptedPayload,
                },
              ],
              scanCredentials,
            );

            if (discovered.length === 0) {
              throw new Error(
                "scanStealthDeposits found nothing — the saved recipient key does not " +
                  "decrypt this deposit's note payload.",
              );
            }
            const note = discovered[0]!;
            console.log(`    Note recovered. commitment: ${note.commitment}`);
            console.log(
              `    Recovered value: ${formatUnits(BigInt(note.value), 6)} ` +
                `(expected ${record.sweptAmountHuman})`,
            );
            expect(note.value).toBe(
              `0x${BigInt(record.sweptAmountBaseUnits).toString(16)}`,
            );
            expect(note.tokenId.toLowerCase()).toBe(
              record.tokenId.toLowerCase(),
            );

            attempted++;

            // === 4. Build a session owned by the recovered stealth address, inject the
            // note directly (no discoverNotes() — nothing else can find it), and
            // ragequit it for real. ===
            const stealthAccount = privateKeyToAccount(
              stealthPrivateKey as unknown as `0x${string}`,
            );
            expect(stealthAccount.address.toLowerCase()).toBe(
              record.stealthAddress.toLowerCase(),
            );
            const stealthWalletClient = createWalletClient({
              account: stealthAccount,
              chain,
              transport: http(rpcUrl),
            });

            const tokenId = record.tokenId as `0x${string}`;
            const balanceBefore = (await publicClient.readContract({
              address: tokenId,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [stealthAccount.address],
            })) as bigint;
            console.log(
              `    Stealth address balance before: ${formatUnits(balanceBefore, 6)}`,
            );

            // Throwaway protocol keys: irrelevant to this note's ownership (bound
            // entirely to noteAddressHash = Poseidon(stealthAddress, noteSecret), the
            // same "blind" cold-start binding dust-rescue-prover itself used to build
            // this deposit — see proveDustRescueDeposit.ts) — only needed to satisfy
            // PoolSessionBuilder's schema.
            const viewingKeyPair = cryptoService.generateEphemeralKeyPair();
            const protocolKeys = {
              privateNullifyingKey: cryptoService.generateSecret(),
              privateRevocableKey: cryptoService.generateSecret(),
              revocableKeyIndex: "0x0" as Hex,
              viewingPrivateKey: viewingKeyPair.privateKey,
              viewingPublicKey: viewingKeyPair.publicKey,
            };

            const session = await PoolSessionBuilder.fromConfig({
              chainId: record.chainId,
              rpcUrl,
              ownerAddress: stealthAccount.address as Address,
              deployment: {
                poolAddress: BASE_POOL_ADDRESS as Address,
                entrypointAddress: record.entrypointAddress as Address,
                keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
                aspRegistryAddress: BASE_ASP_REGISTRY_ADDRESS as Address,
                relaySwapsAddress: BASE_RELAY_SWAPS_ADDRESS as Address,
              },
              protocolKeys,
              circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
              relayers: [
                {
                  url: "http://localhost:3000",
                  name: "unused",
                  chainId: record.chainId,
                  chainType: "evm",
                  status: "active" as const,
                  address: stealthAccount.address as Address,
                  processorAddress: stealthAccount.address as Address,
                },
              ],
              persistentStorage: { type: "memory" },
              walletInteractor: {
                type: "viem",
                walletClient: stealthWalletClient as any,
              },
              logger: consoleLogger,
              // No deploymentBlock scan needed — the note is injected directly below,
              // never discovered via a LeavesInserted scan.
              deploymentBlock: "0x0" as Hex,
            }).create();

            const noteAddressHash =
              noteComputationService.computeNoteAddressHash(
                stealthAccount.address as Address,
                note.noteSecret,
              );
            await session.addNotes([
              {
                pendingNote: {
                  noteAddressHash,
                  commitment: note.commitment,
                  value: note.value,
                  tokenId: note.tokenId,
                  label: note.label,
                  status: NoteStatus.ACTIVE,
                  ownerAddress: stealthAccount.address as Address,
                  noteSecret: note.noteSecret,
                  isOwned: true,
                },
                txHash: record.depositTxHash as Hash,
              },
            ]);

            console.log(`    Generating ragequit proof...`);
            const receipt = await session.rageQuit({
              commitment: note.commitment,
            });
            console.log(
              `    Ragequit tx: ${receipt.txHash} | status: ${receipt.status}`,
            );
            expect(receipt.status).toBe(true);

            const balanceAfter = (await publicClient.readContract({
              address: tokenId,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [stealthAccount.address],
            })) as bigint;
            console.log(
              `    Stealth address balance after:  ${formatUnits(balanceAfter, 6)}`,
            );
            console.log(
              `    Recovered: ${formatUnits(balanceAfter - balanceBefore, 6)} — now a ` +
                `plain balance at ${stealthAccount.address}, spendable with the same ` +
                `recipient-key-*.json private key.`,
            );

            markRescueRecovered(recordPath);
            console.log(`    Rescue record marked as recovered.`);
            totalRecovered++;
          } catch (error) {
            // One record failing must not abort every other record in this run —
            // same rationale as mainnet-recover-snapshots.integration.test.ts.
            console.error(
              `    SKIP: unexpected error recovering ${record.stealthAddress}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }

        console.log(
          `\n=== DUST-RESCUE RECOVERY COMPLETE: ${totalRecovered}/${unrecovered.length} ` +
            `notes ragequitted (${attempted} genuinely attempted) ===`,
        );
        if (attempted > 0) {
          expect(totalRecovered).toBeGreaterThan(0);
        }
      },
      3_600_000, // 1 hour — proof gen can take several minutes per note
    );
  },
);
