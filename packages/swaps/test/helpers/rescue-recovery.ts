import { readFileSync, writeFileSync } from "fs";

/**
 * Shape of the two files `mainnet-crosschain-relay-swaps-reshield-to-base-dust-rescue
 * .integration.test.ts` writes to `.mainnet-dust-rescue-recovery-notes/` — see that
 * file's header and its own recipient-key-*.json / rescue-deposit-*.json comments.
 */
export type RecipientKeyRecord = {
  recipientPrivateKey: `0x${string}`;
  recipientIdentifier: { kind: "raw"; spendingPubKey: `0x${string}` };
};

export type RescueDepositRecord = {
  status: "success" | "reverted" | string;
  chainId: number;
  tokenId: `0x${string}`;
  sweptAmountHuman: string;
  sweptAmountBaseUnits: string;
  stealthAddress: `0x${string}`;
  recipientIdentifier: { kind: "raw"; spendingPubKey: `0x${string}` };
  recipientKeyFile: string;
  depositTxHash: `0x${string}`;
  depositBlock: string;
  entrypointAddress: `0x${string}`;
  recoveredAt?: string;
};

export function loadRecipientKeyRecord(filePath: string): RecipientKeyRecord {
  return JSON.parse(readFileSync(filePath, "utf8")) as RecipientKeyRecord;
}

export function loadRescueDepositRecord(filePath: string): RescueDepositRecord {
  return JSON.parse(readFileSync(filePath, "utf8")) as RescueDepositRecord;
}

export function markRescueRecovered(filePath: string): void {
  const record = loadRescueDepositRecord(filePath);
  record.recoveredAt = new Date().toISOString();
  writeFileSync(filePath, JSON.stringify(record, null, 2));
}
