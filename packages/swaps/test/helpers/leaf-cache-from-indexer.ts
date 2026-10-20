import type { Address, Hash, LeafCacheSeed } from "@privacy-pools-v2/evm-sdk";

/**
 * Reaches a deployed Envio HyperIndex GraphQL instance to produce a
 * `LeafCacheSeed` — a second seed producer alongside the file-backed
 * `loadLeafCache`/`saveLeafCache` in `leaf-cache-store.ts`, per the SDK's
 * storage-agnostic seed-in/export-out design (`contract-interactor.md`:
 * "The SDK itself never touches disk or browser storage; seeding and
 * exporting are entirely the caller's responsibility.").
 *
 * Research/verification behind this: `~/.../research_hyperindex/envio_hyper_index.org`.
 * Key facts this module relies on:
 * - Auth is `Authorization: Bearer <apiKey>`, not Hasura's own
 *   `x-hasura-admin-secret` — this deployment gates on a bearer token at a
 *   gateway in front of Hasura (org doc §3.5).
 * - `_newLeaf`/`_root`/`_newLeaves` values come back as base-10 decimal
 *   strings, not hex (org doc §9.2 schema check + live sample).
 * - `Keystore_LeafInserted._leafIndex` and
 *   `PoolVaultV2_LeavesInserted._startIndex` are the actual tree slot(s),
 *   so ordering by them directly reconstructs array position without
 *   needing block/log ordering — only `Keystore_LeafUpdated` (an
 *   overwrite, not an insert) needs chronological ordering, since the same
 *   slot can be updated more than once.
 *
 * Coverage across chains/contracts is NOT verified by this module — see
 * org doc §10, still blocked on a canonical production-address list.
 * Callers are responsible for only seeding sessions on chains/contracts
 * they've confirmed this indexer actually covers.
 */

/** Config for reaching a deployed Envio HyperIndex GraphQL instance. */
export type IndexerConfig = {
  /** e.g. `https://indexer.hyperindex.xyz/cf03704/v1/graphql` */
  endpoint: string;
  /** Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
};

/** Rows fetched per GraphQL page — well under any reasonable request-size limit. */
const PAGE_SIZE = 1000;

class IndexerQueryError extends Error {}

/** Base-10 decimal string (as returned by this indexer) -> 32-byte hex `Hash`, zero-padded like `bigintToHex`. */
function decimalToHash(decimal: string): Hash {
  return `0x${BigInt(decimal).toString(16).padStart(64, "0")}` as Hash;
}

/** The trailing `_<logIndex>` segment of this indexer's `<address>_<chainId>_<block>_<logIndex>` id format, parsed numerically (not lexicographically — digit-width varies, so string sort would misorder e.g. "10" before "9"). */
function logIndexFromId(id: string): number {
  const lastUnderscore = id.lastIndexOf("_");
  const logIndex = Number(id.slice(lastUnderscore + 1));
  if (!Number.isSafeInteger(logIndex)) {
    throw new IndexerQueryError(
      `Could not parse a log index out of id "${id}"`,
    );
  }
  return logIndex;
}

async function graphqlQuery<T>(
  config: IndexerConfig,
  query: string,
): Promise<T> {
  const res = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    throw new IndexerQueryError(
      `Indexer request failed: HTTP ${res.status} ${await res.text()}`,
    );
  }

  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new IndexerQueryError(
      `Indexer returned GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (json.data === undefined) {
    throw new IndexerQueryError("Indexer response had no `data` field");
  }
  return json.data;
}

/**
 * The block this indexer has actually finished processing for `chainId` —
 * used as the seed's `toBlock` so it reflects real, verified coverage
 * rather than "now" (see the fetch ordering note on
 * {@link fetchKeystoreLeafCacheSeed} for why this must be fetched before
 * the leaf-event queries, not after).
 *
 * @throws {IndexerQueryError} When `chainId` has no `chain_metadata` row —
 *   this indexer isn't tracking that chain at all.
 */
async function fetchLatestProcessedBlock(
  config: IndexerConfig,
  chainId: number,
): Promise<bigint> {
  const data = await graphqlQuery<{
    chain_metadata: { chain_id: number; latest_processed_block: number }[];
  }>(
    config,
    `{ chain_metadata(where: {chain_id: {_eq: ${chainId}}}) { chain_id latest_processed_block } }`,
  );

  const row = data.chain_metadata[0];
  if (!row) {
    throw new IndexerQueryError(
      `Indexer has no chain_metadata for chainId ${chainId} — it isn't tracking this chain.`,
    );
  }
  return BigInt(row.latest_processed_block);
}

type LeafInsertedRow = {
  id: string;
  _leafIndex: string;
  _newLeaf: string;
  _blockNumber: number;
};
type LeafUpdatedRow = {
  id: string;
  _leafIndex: string;
  _newLeaf: string;
  _blockNumber: number;
};
type LeavesInsertedRow = {
  id: string;
  _startIndex: string;
  _newLeaves: string[];
  _blockNumber: number;
};

async function fetchAllPages<T>(
  config: IndexerConfig,
  buildQuery: (limit: number, offset: number) => string,
  extractRows: (data: unknown) => T[],
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const data = await graphqlQuery<unknown>(
      config,
      buildQuery(PAGE_SIZE, offset),
    );
    const page = extractRows(data);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

/**
 * Builds a `LeafCacheSeed` for a Keystore contract from indexed
 * `Keystore_LeafInserted` + `Keystore_LeafUpdated` events, mirroring the
 * exact two-pass reduction `KeystoreInteractor.fetchAndCacheLeaves` does
 * against live RPC logs: every `LeafInserted` applied first (by
 * `_leafIndex`, order-independent since each writes a distinct slot), then
 * every `LeafUpdated` applied as an overwrite in strict chronological order
 * (block number, then log index parsed from `id` — the same slot can be
 * updated more than once, and the *last* update must win).
 *
 * Fetches `chain_metadata.latest_processed_block` for `chainId` *first* and
 * uses it as both the seed's `toBlock` and an explicit `_blockNumber`
 * upper bound on every event query that follows — without that ordering, a
 * block landing between the metadata read and the event reads would let
 * `toBlock` overstate coverage (claiming leaves scanned that weren't
 * actually fetched), which would make a later RPC delta-fetch skip real
 * gaps instead of catching them.
 *
 * @throws {IndexerQueryError} On any GraphQL/HTTP failure, or if this
 *   indexer has no `chain_metadata` for `chainId`.
 */
export async function fetchKeystoreLeafCacheSeed(
  config: IndexerConfig,
  chainId: number,
  contractAddress: Address,
): Promise<LeafCacheSeed> {
  const toBlock = await fetchLatestProcessedBlock(config, chainId);
  const addressPrefix = contractAddress.toLowerCase();

  const inserted = await fetchAllPages<LeafInsertedRow>(
    config,
    (limit, offset) => `{
      Keystore_LeafInserted(
        where: {id: {_ilike: "${addressPrefix}%"}, _blockNumber: {_lte: ${toBlock}}}
        order_by: {_leafIndex: asc}
        limit: ${limit}
        offset: ${offset}
      ) { id _leafIndex _newLeaf _blockNumber }
    }`,
    (data) =>
      (data as { Keystore_LeafInserted: LeafInsertedRow[] })
        .Keystore_LeafInserted,
  );

  const updated = await fetchAllPages<LeafUpdatedRow>(
    config,
    (limit, offset) => `{
      Keystore_LeafUpdated(
        where: {id: {_ilike: "${addressPrefix}%"}, _blockNumber: {_lte: ${toBlock}}}
        order_by: {_blockNumber: asc}
        limit: ${limit}
        offset: ${offset}
      ) { id _leafIndex _newLeaf _blockNumber }
    }`,
    (data) =>
      (data as { Keystore_LeafUpdated: LeafUpdatedRow[] }).Keystore_LeafUpdated,
  );

  const leaves: Hash[] = [];
  for (const row of inserted) {
    leaves[Number(row._leafIndex)] = decimalToHash(row._newLeaf);
  }

  const chronological = [...updated].sort((a, b) => {
    if (a._blockNumber !== b._blockNumber)
      return a._blockNumber - b._blockNumber;
    return logIndexFromId(a.id) - logIndexFromId(b.id);
  });
  for (const row of chronological) {
    const index = Number(row._leafIndex);
    if (index >= leaves.length) {
      throw new IndexerQueryError(
        `LeafUpdated index ${index} is out of bounds (${leaves.length} leaves inserted)`,
      );
    }
    leaves[index] = decimalToHash(row._newLeaf);
  }

  return { toBlock, leaves };
}

/**
 * Builds a `LeafCacheSeed` for a PoolVault contract from indexed
 * `PoolVaultV2_LeavesInserted` events, mirroring
 * `PoolVaultInteractor.getStateLeavesFromEvents`. Simpler than the Keystore
 * case: state-tree leaves are insert-only (no update/overwrite event
 * exists), so ordering by `_startIndex` alone reconstructs the array —
 * no chronological ordering needed.
 *
 * Same `toBlock`-first fetch ordering rationale as
 * {@link fetchKeystoreLeafCacheSeed} applies here too.
 *
 * @throws {IndexerQueryError} On any GraphQL/HTTP failure, or if this
 *   indexer has no `chain_metadata` for `chainId`.
 */
export async function fetchStateLeafCacheSeed(
  config: IndexerConfig,
  chainId: number,
  contractAddress: Address,
): Promise<LeafCacheSeed> {
  const toBlock = await fetchLatestProcessedBlock(config, chainId);
  const addressPrefix = contractAddress.toLowerCase();

  const batches = await fetchAllPages<LeavesInsertedRow>(
    config,
    (limit, offset) => `{
      PoolVaultV2_LeavesInserted(
        where: {id: {_ilike: "${addressPrefix}%"}, _blockNumber: {_lte: ${toBlock}}}
        order_by: {_startIndex: asc}
        limit: ${limit}
        offset: ${offset}
      ) { id _startIndex _newLeaves _blockNumber }
    }`,
    (data) =>
      (data as { PoolVaultV2_LeavesInserted: LeavesInsertedRow[] })
        .PoolVaultV2_LeavesInserted,
  );

  const leaves: Hash[] = [];
  for (const batch of batches) {
    const startIndex = Number(batch._startIndex);
    batch._newLeaves.forEach((newLeaf, offset) => {
      leaves[startIndex + offset] = decimalToHash(newLeaf);
    });
  }

  return { toBlock, leaves };
}
