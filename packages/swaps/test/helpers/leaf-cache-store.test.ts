import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Address, Hash } from "@privacy-pools-v2/evm-sdk";

import { loadLeafCache, saveLeafCache } from "./leaf-cache-store.js";

const CHAIN_ID = 42161;
const CONTRACT_ADDRESS =
  "0x1234567890abcdef1234567890abcdef12345678" as Address;
const OTHER_CONTRACT_ADDRESS =
  "0xffffffffffffffffffffffffffffffffffffffff" as Address;

describe("leaf-cache-store", () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "leaf-cache-store-test-"));
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("returns undefined when no cache has been saved yet", () => {
    expect(
      loadLeafCache(storageDir, CHAIN_ID, CONTRACT_ADDRESS),
    ).toBeUndefined();
  });

  it("round-trips a seed through save then load, preserving bigint toBlock", () => {
    const leaves: Hash[] = [
      "0x0000000000000000000000000000000000000000000000000000000000000aaa",
      "0x0000000000000000000000000000000000000000000000000000000000000bbb",
    ];
    saveLeafCache(storageDir, CHAIN_ID, CONTRACT_ADDRESS, {
      toBlock: 482545313n,
      leaves,
    });

    const loaded = loadLeafCache(storageDir, CHAIN_ID, CONTRACT_ADDRESS);

    expect(loaded).toEqual({ toBlock: 482545313n, leaves });
    expect(typeof loaded?.toBlock).toBe("bigint");
  });

  it("scopes cache files by chainId and contractAddress independently", () => {
    saveLeafCache(storageDir, CHAIN_ID, CONTRACT_ADDRESS, {
      toBlock: 1n,
      leaves: [],
    });

    expect(
      loadLeafCache(storageDir, CHAIN_ID, OTHER_CONTRACT_ADDRESS),
    ).toBeUndefined();
    expect(loadLeafCache(storageDir, 8453, CONTRACT_ADDRESS)).toBeUndefined();
    expect(loadLeafCache(storageDir, CHAIN_ID, CONTRACT_ADDRESS)).toBeDefined();
  });

  it("overwrites a previously saved seed for the same chain + contract", () => {
    saveLeafCache(storageDir, CHAIN_ID, CONTRACT_ADDRESS, {
      toBlock: 1n,
      leaves: ["0xaaa" as Hash],
    });
    saveLeafCache(storageDir, CHAIN_ID, CONTRACT_ADDRESS, {
      toBlock: 2n,
      leaves: ["0xbbb" as Hash],
    });

    expect(loadLeafCache(storageDir, CHAIN_ID, CONTRACT_ADDRESS)).toEqual({
      toBlock: 2n,
      leaves: ["0xbbb"],
    });
  });

  it("throws when a cache file's stamped chain/contract disagree with what's requested", () => {
    saveLeafCache(storageDir, CHAIN_ID, CONTRACT_ADDRESS, {
      toBlock: 1n,
      leaves: [],
    });

    // Simulate hand-tampering: load the file under a filename matching a
    // different contract by saving a mismatched payload directly at that path.
    const wrongPath = join(
      storageDir,
      `.leaf-cache-${CHAIN_ID}-${OTHER_CONTRACT_ADDRESS.toLowerCase()}.json`,
    );
    saveLeafCache(storageDir, CHAIN_ID, OTHER_CONTRACT_ADDRESS, {
      toBlock: 1n,
      leaves: [],
    });
    // Overwrite that file's contents with the wrong contract's payload.
    writeFileSync(
      wrongPath,
      JSON.stringify({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_ADDRESS,
        toBlock: "1",
        leaves: [],
      }),
    );

    expect(() =>
      loadLeafCache(storageDir, CHAIN_ID, OTHER_CONTRACT_ADDRESS),
    ).toThrow(/refusing to load a mismatched seed/);
  });
});
