import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Address } from "@privacy-pools-v2/evm-sdk";

import {
  fetchKeystoreLeafCacheSeed,
  fetchStateLeafCacheSeed,
  type IndexerConfig,
} from "./leaf-cache-from-indexer.js";

const CONFIG: IndexerConfig = {
  endpoint: "https://indexer.example/v1/graphql",
  apiKey: "test-key",
};
const CHAIN_ID = 11155111;
const CONTRACT_ADDRESS =
  "0x6d264aCb9C3A7A3105c29470AfE2F5F1EC203C73" as Address;
/** Must match the module's internal PAGE_SIZE — kept in sync manually since it isn't exported. */
const PAGE_SIZE = 1000;

type LeafInsertedRow = {
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

function id(
  addr: string,
  chainId: number,
  block: number,
  logIndex: number,
): string {
  return `${addr}_${chainId}_${block}_${logIndex}`;
}

function extractOffset(query: string): number {
  const match = query.match(/offset:\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

/**
 * Fake `fetch` that inspects each GraphQL request's query text to decide
 * which table it's for and slices the corresponding full dataset by the
 * request's `offset`/PAGE_SIZE — so pagination is exercised by dataset
 * size alone, without hardcoding call counts/order.
 */
function mockFetch(datasets: {
  chainMetadata?: { chain_id: number; latest_processed_block: number }[];
  leafInserted?: LeafInsertedRow[];
  leafUpdated?: LeafInsertedRow[];
  leavesInserted?: LeavesInsertedRow[];
}) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    const query = body.query;
    const offset = extractOffset(query);

    const respond = (data: unknown) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ data }),
        text: async () => JSON.stringify(data),
      }) as Response;

    if (query.includes("chain_metadata")) {
      return respond({ chain_metadata: datasets.chainMetadata ?? [] });
    }
    if (query.includes("Keystore_LeafInserted")) {
      const all = datasets.leafInserted ?? [];
      return respond({
        Keystore_LeafInserted: all.slice(offset, offset + PAGE_SIZE),
      });
    }
    if (query.includes("Keystore_LeafUpdated")) {
      const all = datasets.leafUpdated ?? [];
      return respond({
        Keystore_LeafUpdated: all.slice(offset, offset + PAGE_SIZE),
      });
    }
    if (query.includes("PoolVaultV2_LeavesInserted")) {
      const all = datasets.leavesInserted ?? [];
      return respond({
        PoolVaultV2_LeavesInserted: all.slice(offset, offset + PAGE_SIZE),
      });
    }
    throw new Error(`mockFetch: unrecognized query: ${query}`);
  }) as unknown as typeof fetch & {
    mock: { calls: [RequestInfo | URL, RequestInit | undefined][] };
  };
}

describe("leaf-cache-from-indexer", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("fetchKeystoreLeafCacheSeed", () => {
    it("reconstructs leaves from LeafInserted events, ordered by _leafIndex", async () => {
      const leafInserted: LeafInsertedRow[] = [
        {
          id: id(CONTRACT_ADDRESS, CHAIN_ID, 100, 1),
          _leafIndex: "1",
          _newLeaf: "11",
          _blockNumber: 100,
        },
        {
          id: id(CONTRACT_ADDRESS, CHAIN_ID, 99, 1),
          _leafIndex: "0",
          _newLeaf: "10",
          _blockNumber: 99,
        },
      ];
      global.fetch = mockFetch({
        chainMetadata: [{ chain_id: CHAIN_ID, latest_processed_block: 200 }],
        leafInserted,
      });

      const seed = await fetchKeystoreLeafCacheSeed(
        CONFIG,
        CHAIN_ID,
        CONTRACT_ADDRESS,
      );

      expect(seed.toBlock).toBe(200n);
      expect(seed.leaves).toEqual([
        `0x${10n.toString(16).padStart(64, "0")}`,
        `0x${11n.toString(16).padStart(64, "0")}`,
      ]);
    });

    it("paginates across more than one page of LeafInserted rows", async () => {
      const leafInserted: LeafInsertedRow[] = Array.from(
        { length: PAGE_SIZE + 3 },
        (_, i) => ({
          id: id(CONTRACT_ADDRESS, CHAIN_ID, 1000 + i, 0),
          _leafIndex: String(i),
          _newLeaf: String(i),
          _blockNumber: 1000 + i,
        }),
      );
      const fetchMock = mockFetch({
        chainMetadata: [{ chain_id: CHAIN_ID, latest_processed_block: 999999 }],
        leafInserted,
      });
      global.fetch = fetchMock;

      const seed = await fetchKeystoreLeafCacheSeed(
        CONFIG,
        CHAIN_ID,
        CONTRACT_ADDRESS,
      );

      expect(seed.leaves).toHaveLength(PAGE_SIZE + 3);
      expect(seed.leaves[0]).toBe(`0x${0n.toString(16).padStart(64, "0")}`);
      expect(seed.leaves[PAGE_SIZE + 2]).toBe(
        `0x${BigInt(PAGE_SIZE + 2)
          .toString(16)
          .padStart(64, "0")}`,
      );
      // 2 pages of LeafInserted (1000 + 3) + 1 empty page of LeafUpdated + 1 chain_metadata call.
      const leafInsertedCalls = fetchMock.mock.calls.filter(([, init]) =>
        (
          JSON.parse((init as RequestInit).body as string) as { query: string }
        ).query.includes("Keystore_LeafInserted"),
      );
      expect(leafInsertedCalls).toHaveLength(2);
    });

    it("applies LeafUpdated overwrites in chronological order, last update wins", async () => {
      const leafInserted: LeafInsertedRow[] = [
        {
          id: id(CONTRACT_ADDRESS, CHAIN_ID, 100, 0),
          _leafIndex: "0",
          _newLeaf: "1",
          _blockNumber: 100,
        },
      ];
      // Same block, two updates to the same slot — id's trailing logIndex decides order, not array order.
      const leafUpdated: LeafInsertedRow[] = [
        {
          id: id(CONTRACT_ADDRESS, CHAIN_ID, 150, 9),
          _leafIndex: "0",
          _newLeaf: "999",
          _blockNumber: 150,
        },
        {
          id: id(CONTRACT_ADDRESS, CHAIN_ID, 150, 10),
          _leafIndex: "0",
          _newLeaf: "1000",
          _blockNumber: 150,
        },
        {
          id: id(CONTRACT_ADDRESS, CHAIN_ID, 120, 5),
          _leafIndex: "0",
          _newLeaf: "500",
          _blockNumber: 120,
        },
      ];
      global.fetch = mockFetch({
        chainMetadata: [{ chain_id: CHAIN_ID, latest_processed_block: 200 }],
        leafInserted,
        leafUpdated,
      });

      const seed = await fetchKeystoreLeafCacheSeed(
        CONFIG,
        CHAIN_ID,
        CONTRACT_ADDRESS,
      );

      // Chronological order is block120 -> block150/logIndex9 -> block150/logIndex10; last (1000) wins.
      expect(seed.leaves).toEqual([
        `0x${1000n.toString(16).padStart(64, "0")}`,
      ]);
    });

    it("throws when a LeafUpdated targets an index no LeafInserted ever created", async () => {
      global.fetch = mockFetch({
        chainMetadata: [{ chain_id: CHAIN_ID, latest_processed_block: 200 }],
        leafInserted: [],
        leafUpdated: [
          {
            id: id(CONTRACT_ADDRESS, CHAIN_ID, 100, 0),
            _leafIndex: "0",
            _newLeaf: "1",
            _blockNumber: 100,
          },
        ],
      });

      await expect(
        fetchKeystoreLeafCacheSeed(CONFIG, CHAIN_ID, CONTRACT_ADDRESS),
      ).rejects.toThrow(/out of bounds/);
    });

    it("throws when the indexer has no chain_metadata for the requested chain", async () => {
      global.fetch = mockFetch({ chainMetadata: [] });

      await expect(
        fetchKeystoreLeafCacheSeed(CONFIG, CHAIN_ID, CONTRACT_ADDRESS),
      ).rejects.toThrow(/no chain_metadata/);
    });

    it("throws on a GraphQL errors response", async () => {
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: "field not found" }] }),
        text: async () => "",
      })) as unknown as typeof fetch;

      await expect(
        fetchKeystoreLeafCacheSeed(CONFIG, CHAIN_ID, CONTRACT_ADDRESS),
      ).rejects.toThrow(/field not found/);
    });

    it("throws on a non-OK HTTP response", async () => {
      global.fetch = vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => "Client authentication failed.",
      })) as unknown as typeof fetch;

      await expect(
        fetchKeystoreLeafCacheSeed(CONFIG, CHAIN_ID, CONTRACT_ADDRESS),
      ).rejects.toThrow(/401/);
    });
  });

  describe("fetchStateLeafCacheSeed", () => {
    it("reconstructs leaves from LeavesInserted batches at _startIndex", async () => {
      const leavesInserted: LeavesInsertedRow[] = [
        {
          id: id(CONTRACT_ADDRESS, CHAIN_ID, 200, 0),
          _startIndex: "2",
          _newLeaves: ["20", "21"],
          _blockNumber: 200,
        },
        {
          id: id(CONTRACT_ADDRESS, CHAIN_ID, 100, 0),
          _startIndex: "0",
          _newLeaves: ["10", "11"],
          _blockNumber: 100,
        },
      ];
      global.fetch = mockFetch({
        chainMetadata: [{ chain_id: CHAIN_ID, latest_processed_block: 300 }],
        leavesInserted,
      });

      const seed = await fetchStateLeafCacheSeed(
        CONFIG,
        CHAIN_ID,
        CONTRACT_ADDRESS,
      );

      expect(seed.toBlock).toBe(300n);
      expect(seed.leaves).toEqual(
        ["10", "11", "20", "21"].map(
          (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`,
        ),
      );
    });
  });
});
