import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve, dirname } from "path";

import type { Hash, Hex, PublicKey, Secret } from "@privacy-pools-v2/evm-sdk";

export type MainnetTestState = {
  /** Protocol keys derived from wallet signature — matches SDK ProtocolKeys shape */
  protocolKeys: {
    privateNullifyingKey: Secret;
    privateRevocableKey: Secret;
    revocableKeyIndex: Hex;
    viewingPrivateKey: Secret;
    viewingPublicKey: PublicKey;
  };
  /** ASP tree leaves for rehydration */
  aspLeaves: Hash[];
  /** Whether keystore registration completed */
  keystoreRegistered?: boolean;
};

const DEFAULT_PATH = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../../.mainnet-test-state.json",
);

export class TestStatePersistence {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_PATH;
  }

  load(): MainnetTestState | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as MainnetTestState;
    } catch {
      return null;
    }
  }

  save(state: MainnetTestState): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, this.filePath);
  }
}
