import { LeanIMT } from "@zk-kit/lean-imt";
import { buildPoseidon } from "circomlibjs";
import { type WalletClient, type PublicClient } from "viem";

import type {
  Hash,
  Hex,
  IASPDataProvider,
  LabelStatus,
  PublicKey,
  EventSnapshot,
  NoteEvent,
} from "@privacy-pools-v2/evm-sdk";

const ASP_REGISTRY_ABI = [
  {
    type: "function",
    name: "updateASPRoot",
    inputs: [
      { name: "_aspRoot", type: "uint256" },
      { name: "_ipfsCID", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// Dummy X25519 public key (32 bytes)
const DUMMY_ASP_PUBLIC_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as PublicKey;

type LocalASPTreeConfig = {
  aspRegistryAddress: Hex;
  walletClient: WalletClient;
  publicClient: PublicClient;
};

type SerializedASPTree = {
  leaves: Hash[];
};

/**
 * Local ASP tree service for testing against real contracts without an external ASP server.
 * Implements IASPDataProvider so PoolSession can use it directly via `.withAspDataProvider()`.
 *
 * Maintains in-memory LeanIMT of label hashes. When a label is registered,
 * computes labelHash = Poseidon(label), inserts into tree, and calls
 * ASPRegistry.updateASPRoot() on-chain with the POSTMAN_ROLE wallet.
 */
export class LocalASPTreeService implements IASPDataProvider {
  private poseidon: any;
  private tree: LeanIMT<Hash>;
  private leaves: Hash[];
  private readonly config: LocalASPTreeConfig;

  private constructor(
    config: LocalASPTreeConfig,
    poseidon: any,
    leaves: Hash[],
  ) {
    this.config = config;
    this.poseidon = poseidon;
    this.leaves = [...leaves];

    this.tree = new LeanIMT<Hash>(this.hashFn.bind(this));
    if (leaves.length > 0) {
      this.tree.insertMany(leaves);
    }
  }

  /**
   * Create new LocalASPTreeService. Initializes Poseidon and optionally
   * rehydrates from previously saved leaves.
   */
  static async create(
    config: LocalASPTreeConfig,
    savedLeaves?: Hash[],
  ): Promise<LocalASPTreeService> {
    const poseidon = await buildPoseidon();
    return new LocalASPTreeService(config, poseidon, savedLeaves ?? []);
  }

  /**
   * Register a label in the local ASP tree and update on-chain root.
   * Computes labelHash = Poseidon(label), adds to tree, calls updateASPRoot().
   */
  async registerLabel(label: Hash): Promise<void> {
    const labelHash = this.poseidonHash([label]);
    this.leaves.push(labelHash);
    this.tree.insert(labelHash);

    const root = this.tree.root;
    const rootBigInt = BigInt(root);

    const { request } = await this.config.publicClient.simulateContract({
      address: this.config.aspRegistryAddress as `0x${string}`,
      abi: ASP_REGISTRY_ABI,
      functionName: "updateASPRoot",
      args: [rootBigInt, "0x00" as `0x${string}`],
      account: this.config.walletClient.account!,
    });

    const txHash = await this.config.walletClient.writeContract(request);
    await this.config.publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  /** Serialize leaves for persistence between test runs. */
  serialize(): SerializedASPTree {
    return { leaves: this.leaves };
  }

  // --- IASPDataProvider ---

  async getRoot(): Promise<Hash> {
    if (this.leaves.length === 0) {
      return "0x0000000000000000000000000000000000000000000000000000000000000000" as Hash;
    }
    return this.tree.root;
  }

  async getLeaves(): Promise<Hash[]> {
    return [...this.leaves];
  }

  async getLabelStatus(_labelHash: Hash): Promise<LabelStatus> {
    return { status: "approved" };
  }

  async getASPPublicKey(): Promise<PublicKey> {
    return DUMMY_ASP_PUBLIC_KEY;
  }

  async getEventSnapshot(): Promise<EventSnapshot> {
    throw new Error("LocalASPTreeService does not support getEventSnapshot");
  }

  async getNoteEvents(
    _fromBlock?: Hex,
    _toBlock?: Hex,
  ): Promise<{ events: NoteEvent[]; lastSyncedBlock: Hex }> {
    // lastSyncedBlock must report ZERO coverage (= fromBlock), not full
    // coverage (= toBlock). PoolSessionNoteDiscovery treats
    // `lastSyncedBlock >= toBlock` as "ASP already has everything" and
    // returns aspEvents (always [] here) without ever calling
    // poolVaultInteractor.getNoteEvents() for the real chain data — which
    // silently broke note discovery for every recovery/ragequit test using
    // this stub (notes were never found, so they were skipped instead of
    // recovered). Reporting fromBlock instead makes the SDK gap-fill the
    // exact [fromBlock, toBlock] window against the real chain, same as
    // the pre-stub "throws, caught, fallback" behavior — but without the
    // cosmetic error log.
    return {
      events: [],
      lastSyncedBlock: (_fromBlock ?? "0x0") as Hex,
    };
  }

  // --- Private ---

  private hashFn(a: Hash, b: Hash): Hash {
    return this.poseidonHash([a, b]);
  }

  private poseidonHash(inputs: Hex[]): Hex {
    const montgomeryHash = this.poseidon(inputs);
    const hash = this.poseidon.F.toObject(montgomeryHash);
    return `0x${hash.toString(16).padStart(64, "0")}` as Hex;
  }
}
