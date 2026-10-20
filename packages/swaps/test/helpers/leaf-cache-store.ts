import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname, resolve } from "path";

import type { Address, LeafCacheSeed } from "@privacy-pools-v2/evm-sdk";

/**
 * Single shared cache directory for every mainnet suite and script — unlike
 * `RECOVERY_SNAPSHOT_DIR`/`TestStatePersistence` (which are deliberately
 * per-test-type), leaf caches are already scoped by chainId + contract
 * address in the filename itself, so there's no benefit to separate
 * directories per suite and real benefit to sharing: a keystore/pool address
 * scanned by one mainnet test warms the cache for every other test hitting
 * the same chain + contract.
 */
export const LEAF_CACHE_DIR = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../../.leaf-cache",
);

/**
 * On-disk representation of a `LeafCacheSeed`. `toBlock` is stored as a
 * decimal string since `bigint` isn't JSON-serializable. `chainId`/
 * `contractAddress` are stamped into the payload (in addition to being
 * baked into the filename) so `loadLeafCache` can refuse a seed that ended
 * up under the wrong file by hand-copying/renaming, instead of silently
 * feeding another chain's or contract's leaves into a session.
 */
type StoredLeafCacheSeed = {
  chainId: number;
  contractAddress: Address;
  toBlock: string;
  leaves: LeafCacheSeed["leaves"];
};

function cacheFilePath(
  storageDir: string,
  chainId: number,
  contractAddress: Address,
): string {
  // Dotfile: covered by the blanket `.*` dotfile rule in packages/swaps/.gitignore
  // (same reasoning as `.mainnet-test-state.json` — leaf caches carry no secrets,
  // but are local machine-specific state that shouldn't get committed).
  return resolve(
    storageDir,
    `.leaf-cache-${chainId}-${contractAddress.toLowerCase()}.json`,
  );
}

/**
 * Loads a previously saved `LeafCacheSeed` for the given chain + contract
 * from `storageDir`, or `undefined` if none has been saved yet. Feed the
 * result into `PoolSessionBuilder`'s `keystoreLeafCacheSeed`/
 * `stateLeafCacheSeed` config to skip re-scanning the leaves it already
 * covers.
 *
 * @throws {Error} When the stored payload's stamped chainId/contractAddress
 *   disagree with the ones requested — only reachable via manual file
 *   tampering (the filename itself already keys on both), but a wrong seed
 *   would desync the local merkle tree from on-chain truth, so this fails
 *   loud instead of loading it anyway.
 */
export function loadLeafCache(
  storageDir: string,
  chainId: number,
  contractAddress: Address,
): LeafCacheSeed | undefined {
  const filePath = cacheFilePath(storageDir, chainId, contractAddress);
  if (!existsSync(filePath)) return undefined;

  const stored = JSON.parse(
    readFileSync(filePath, "utf-8"),
  ) as StoredLeafCacheSeed;
  if (
    stored.chainId !== chainId ||
    stored.contractAddress.toLowerCase() !== contractAddress.toLowerCase()
  ) {
    throw new Error(
      `Leaf cache file ${filePath} is stamped for chain ${stored.chainId} / ${stored.contractAddress}, ` +
        `not the requested chain ${chainId} / ${contractAddress} — refusing to load a mismatched seed.`,
    );
  }

  return { toBlock: BigInt(stored.toBlock), leaves: stored.leaves };
}

/**
 * Persists a `LeafCacheSeed` for the given chain + contract under
 * `storageDir` (created if absent), typically from
 * `PoolSession.exportKeystoreLeafCache()` / `.exportStateLeafCache()` after
 * a test run. Written atomically (temp file + rename) so a crash mid-write
 * can't leave a corrupt cache file for the next run to trip over.
 */
export function saveLeafCache(
  storageDir: string,
  chainId: number,
  contractAddress: Address,
  seed: LeafCacheSeed,
): void {
  mkdirSync(storageDir, { recursive: true });
  const stored: StoredLeafCacheSeed = {
    chainId,
    contractAddress,
    toBlock: seed.toBlock.toString(),
    leaves: seed.leaves,
  };

  const filePath = cacheFilePath(storageDir, chainId, contractAddress);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(stored, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

/** The two contract addresses a `PoolSession`'s leaf caches are keyed by. */
export type LeafCacheAddresses = {
  keystoreAddress: Address;
  poolAddress: Address;
};

/** `PoolSessionBuilderConfig` seed fields for one chain's leaf caches. */
export type SessionLeafCacheSeeds = {
  keystoreLeafCacheSeed?: LeafCacheSeed;
  stateLeafCacheSeed?: LeafCacheSeed;
};

/**
 * Loads both of a session's leaf-cache seeds (keystore + state-tree) for one
 * chain in one call — every `PoolSessionBuilder.fromConfig(...)` call site
 * needs exactly this pair, keyed by the deployment's keystore/pool
 * addresses. Spread the result into the builder config.
 */
export function loadSessionLeafCacheSeeds(
  storageDir: string,
  chainId: number,
  addresses: LeafCacheAddresses,
): SessionLeafCacheSeeds {
  return {
    keystoreLeafCacheSeed: loadLeafCache(
      storageDir,
      chainId,
      addresses.keystoreAddress,
    ),
    stateLeafCacheSeed: loadLeafCache(
      storageDir,
      chainId,
      addresses.poolAddress,
    ),
  };
}

/** A built session exposing the two export methods `saveSessionLeafCache` needs. */
export type LeafCacheExportingSession = {
  exportKeystoreLeafCache(): LeafCacheSeed | undefined;
  exportStateLeafCache(): LeafCacheSeed | undefined;
};

/**
 * Exports both of a session's leaf caches and persists whichever ones are
 * populated — the counterpart to {@link loadSessionLeafCacheSeeds}, called
 * after a test/script run so the next run starts warmer. A cache stays
 * `undefined` (and is skipped) when nothing ever triggered that particular
 * scan (e.g. a state-tree query never ran), not just when it's empty.
 */
export function saveSessionLeafCache(
  storageDir: string,
  chainId: number,
  addresses: LeafCacheAddresses,
  session: LeafCacheExportingSession,
): void {
  const keystoreSeed = session.exportKeystoreLeafCache();
  if (keystoreSeed) {
    saveLeafCache(storageDir, chainId, addresses.keystoreAddress, keystoreSeed);
  }

  const stateSeed = session.exportStateLeafCache();
  if (stateSeed) {
    saveLeafCache(storageDir, chainId, addresses.poolAddress, stateSeed);
  }
}
