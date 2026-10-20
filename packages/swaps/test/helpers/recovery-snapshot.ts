import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import { parseAbi } from "viem";
import type { PublicClient } from "viem";
import type {
  Address,
  Hex,
  PendingNote,
  FinalizedBlockResult,
  IRPCInteractor,
  GetLogsParams,
  DecodedEventLog,
  TxReceipt,
  ReadContractParams,
} from "@privacy-pools-v2/evm-sdk";

const LEAVES_INSERTED_ABI = parseAbi([
  "event LeavesInserted(uint256[] _newLeaves, uint256 _root, uint256 _startIndex)",
]);

const CHUNK_SIZE = 500_000n;

export type ProtocolKeys = {
  privateNullifyingKey: Hex;
  privateRevocableKey: Hex;
  revocableKeyIndex: Hex;
  viewingPrivateKey: Hex;
  viewingPublicKey: Hex;
};

export type RecoverySnapshot = {
  savedAt: string;
  chainId: number;
  depositTxHash: Hex;
  depositBlock: Hex;
  deploymentBlock: Hex;
  ownerAddress: Address;
  contracts: {
    pool: Address;
    entrypoint: Address;
    keystore: Address;
    aspRegistry: Address;
  };
  protocolKeys: ProtocolKeys;
  note: PendingNote;
  stateLeaves: Hex[];
  recoveredAt?: string;
};

type SaveParams = {
  publicClient: PublicClient;
  chainId: number;
  depositTxHash: Hex;
  depositBlock: bigint;
  deploymentBlock: Hex;
  ownerAddress: Address;
  contracts: RecoverySnapshot["contracts"];
  protocolKeys: ProtocolKeys;
  note: PendingNote;
  storageDir: string;
};

async function fetchLeavesUpTo(
  publicClient: PublicClient,
  poolAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Hex[]> {
  const leaves: Hex[] = [];

  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    const end =
      start + CHUNK_SIZE - 1n < toBlock ? start + CHUNK_SIZE - 1n : toBlock;
    const logs = await publicClient.getLogs({
      address: poolAddress,
      events: LEAVES_INSERTED_ABI,
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      const { _newLeaves, _startIndex } = log.args as {
        _newLeaves: bigint[];
        _root: bigint;
        _startIndex: bigint;
      };
      const startIdx = Number(_startIndex);
      for (let i = 0; i < _newLeaves.length; i++) {
        leaves[startIdx + i] =
          `0x${_newLeaves[i].toString(16).padStart(64, "0")}` as Hex;
      }
    }
  }

  return leaves;
}

export async function saveRecoverySnapshot(
  params: SaveParams,
): Promise<string> {
  const {
    publicClient,
    chainId,
    depositTxHash,
    depositBlock,
    deploymentBlock,
    ownerAddress,
    contracts,
    protocolKeys,
    note,
    storageDir,
  } = params;

  console.log(
    "Building recovery snapshot: scanning pool leaves up to deposit block...",
  );
  const stateLeaves = await fetchLeavesUpTo(
    publicClient,
    contracts.pool,
    BigInt(deploymentBlock),
    depositBlock,
  );
  console.log(
    `Recovery snapshot: captured ${stateLeaves.length} state leaves.`,
  );

  const snapshot: RecoverySnapshot = {
    savedAt: new Date().toISOString(),
    chainId,
    depositTxHash,
    depositBlock: `0x${depositBlock.toString(16)}` as Hex,
    deploymentBlock,
    ownerAddress,
    contracts,
    protocolKeys,
    note,
    stateLeaves,
  };

  mkdirSync(storageDir, { recursive: true });
  const filename = `recovery-${note.commitment.slice(0, 10)}-${Date.now()}.json`;
  const filePath = resolve(storageDir, filename);
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  console.log(`Recovery snapshot saved: ${filePath}`);
  return filePath;
}

export function loadRecoverySnapshot(filePath: string): RecoverySnapshot {
  return JSON.parse(readFileSync(filePath, "utf8")) as RecoverySnapshot;
}

export function markAsRecovered(filePath: string): void {
  const snapshot = loadRecoverySnapshot(filePath);
  snapshot.recoveredAt = new Date().toISOString();
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
}

/**
 * Wraps a real IRPCInteractor and intercepts getLogsPaginated / getLogs for
 * LeavesInserted queries on the pool address. Serves the stored snapshot leaves
 * as a single synthetic log (startIndex=0, covering the whole history up to the
 * deposit block), then appends any real delta from depositBlock+1 onward. This
 * avoids a full chain scan during ragequit while keeping the state tree current.
 */
export class SnapshotRPCInteractor implements IRPCInteractor {
  private readonly snapshot: RecoverySnapshot;
  private readonly real: IRPCInteractor;

  constructor(real: IRPCInteractor, snapshot: RecoverySnapshot) {
    this.real = real;
    this.snapshot = snapshot;
  }

  readContract(params: ReadContractParams): Promise<unknown> {
    return this.real.readContract(params);
  }

  getBlockNumber(): Promise<Hex> {
    return this.real.getBlockNumber();
  }

  getFinalizedBlockNumber(): Promise<FinalizedBlockResult> {
    return this.real.getFinalizedBlockNumber();
  }

  waitForTransactionReceipt(hash: Hex): Promise<TxReceipt> {
    return this.real.waitForTransactionReceipt(hash);
  }

  async getLogs(params: GetLogsParams): Promise<DecodedEventLog[]> {
    if (!this.isPoolLeavesQuery(params)) return this.real.getLogs(params);
    return this.buildSnapshotResponse(params);
  }

  async getLogsPaginated(params: GetLogsParams): Promise<DecodedEventLog[]> {
    if (!this.isPoolLeavesQuery(params))
      return this.real.getLogsPaginated(params);
    return this.buildSnapshotResponse(params);
  }

  private isPoolLeavesQuery(params: GetLogsParams): boolean {
    return (
      params.address.toLowerCase() ===
        this.snapshot.contracts.pool.toLowerCase() &&
      params.events.some(
        (e: Record<string, unknown>) => e["name"] === "LeavesInserted",
      )
    );
  }

  private async buildSnapshotResponse(
    params: GetLogsParams,
  ): Promise<DecodedEventLog[]> {
    const depositBlock = BigInt(this.snapshot.depositBlock);

    // Synthetic log that serves all stored leaves as a single batch at index 0
    const syntheticLog: DecodedEventLog = {
      eventName: "LeavesInserted",
      args: {
        _newLeaves: this.snapshot.stateLeaves.map((h) => BigInt(h)),
        _root: 0n,
        _startIndex: 0n,
      },
      blockNumber: this.snapshot.deploymentBlock,
      transactionHash: ("0x" + "0".repeat(64)) as Hex,
    };

    // Fetch only the delta: leaves inserted after our deposit
    const deltaLogs = await this.real.getLogsPaginated({
      ...params,
      fromBlock: depositBlock + 1n,
    });

    return [syntheticLog, ...deltaLogs];
  }
}
