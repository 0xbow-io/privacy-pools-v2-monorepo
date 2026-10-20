/**
 * Recovery for the stranded 0x0967 notes on the real-pool deployment.
 *
 * Background: 0x0967's keystore registration on the real-pool keystore
 * (0xffA6...) was made with key material derived from the OLD test wallet
 * 0xcF3822... (deploy-v0.1 deployer) — not from 0x0967's own signature. The
 * notes themselves encrypt to 0x0967-derived viewing keys. Spending therefore
 * needs a hybrid key set:
 *   - privateNullifyingKey / privateRevocableKey: derived from 0xcF3822's signature
 *   - viewingPrivateKey / viewingPublicKey:       derived from 0x0967's signature
 *
 * This script derives both sides, verifies the old wallet's keys against the
 * on-chain registration (nullifyingKeyHash 0x1edded..., authDigest 0x008f53...),
 * probes revocable key indexes 0..5 if the digest doesn't match at index 0,
 * and writes `.mainnet-test-state.json` so the mass-ragequit suite picks the
 * hybrid keys up via TestStatePersistence instead of re-deriving.
 *
 * Run from packages/swaps:
 *   RECOVERY_PRIVATE_KEY=<0xcF3822 key> SIGNER_PRIVATE_KEY_42161=<0x0967 key> \
 *     npx tsx test/recover-stranded-write-state.ts
 *
 * Then: bash run_a_test.sh 5
 */
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { createWalletClient, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { buildPoseidon } from "circomlibjs";

import {
  CryptoService,
  KeystoreManager,
  APP_IDENTIFIER,
} from "@privacy-pools-v2/evm-sdk";
import type { Address, Hex } from "@privacy-pools-v2/evm-sdk";

// On-chain registration for 0x0967 on the real-pool keystore 0xffA6 (block 482548219)
const ONCHAIN_NULLIFYING_KEY_HASH =
  "0x1edded83dcf2e6530f9800c408cf6f3c9348d92c60551555c050c1741f9b8e71";
const ONCHAIN_AUTH_DIGEST =
  "0x008f53f186bc60857996725db589943c8c9daeffeb43b75db705c67061c029ac";
const AUTH_TYPE_DIRECT_KEY = "0x0";
const EXPECTED_RECOVERY_ADDRESS = "0xcF38221886f36522dA520669ACc24E32cE5E4f2c";
const EXPECTED_OWNER_ADDRESS = "0x0967755AfA2016866D12EefB820705026842dCe8";

const RECOVERY_PRIVATE_KEY = process.env.RECOVERY_PRIVATE_KEY;
const OWNER_PRIVATE_KEY =
  process.env.SIGNER_PRIVATE_KEY_42161 ?? process.env.PRIVATE_KEY;
if (!RECOVERY_PRIVATE_KEY || !OWNER_PRIVATE_KEY) {
  console.error(
    "Set RECOVERY_PRIVATE_KEY (0xcF3822... wallet) and SIGNER_PRIVATE_KEY_42161 (0x0967... wallet)",
  );
  process.exit(1);
}

function buildSecretDerivationPayload(signerAddress: Address) {
  const addressHash = keccak256(signerAddress as `0x${string}`);
  return {
    domain: {
      name: "Standardized Secret Derivation",
      version: "1",
      verifyingContract:
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
      salt: keccak256(toHex(APP_IDENTIFIER)),
    },
    types: {
      SecretDerivation: [
        { name: "purpose", type: "string" },
        { name: "addressHash", type: "bytes32" },
      ],
    },
    primaryType: "SecretDerivation" as const,
    message: {
      purpose:
        "This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.",
      addressHash,
    },
  };
}

async function deriveKeys(privateKey: string, revocableKeyIndex: Hex) {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: http("https://arb1.arbitrum.io/rpc"),
  });
  const payload = buildSecretDerivationPayload(account.address as Address);
  const signature = await walletClient.signTypedData({ ...payload, account });
  const km = KeystoreManager.fromSignature(
    {
      signature: signature as Hex,
      signerAddress: account.address as Address,
      revocableKeyIndex,
      addressHash: keccak256(account.address as `0x${string}`) as Hex,
    },
    { cryptoService: new CryptoService() },
  );
  return { account, km };
}

const poseidon = await buildPoseidon();
const pHash = (inputs: (Hex | string | bigint)[]): Hex => {
  const out = poseidon.F.toObject(poseidon(inputs));
  return `0x${out.toString(16).padStart(64, "0")}` as Hex;
};
const eq = (a: string, b: string) => BigInt(a) === BigInt(b);

// --- Recovery wallet: derive + verify against on-chain registration ---
const { account: recoveryAccount, km: recoveryKm } = await deriveKeys(
  RECOVERY_PRIVATE_KEY,
  "0x0" as Hex,
);
console.log("recovery wallet:", recoveryAccount.address);
if (
  recoveryAccount.address.toLowerCase() !==
  EXPECTED_RECOVERY_ADDRESS.toLowerCase()
) {
  console.error(
    `Recovery key controls ${recoveryAccount.address}, expected ${EXPECTED_RECOVERY_ADDRESS}. Aborting.`,
  );
  process.exit(1);
}

const nkh = pHash([recoveryKm.getPrivateNullifyingKey()]);
console.log("nullifyingKeyHash derived:", nkh);
console.log("nullifyingKeyHash on-chain:", ONCHAIN_NULLIFYING_KEY_HASH);
if (!eq(nkh, ONCHAIN_NULLIFYING_KEY_HASH)) {
  console.error(
    "Nullifying key mismatch — this wallet is NOT the source of the registration. Aborting.",
  );
  process.exit(1);
}
console.log("nullifying key MATCHES ✓");

// authDigest depends on the revocable key index used at registration; probe 0..5
let matchedIndex: number | null = null;
let revocableKm = recoveryKm;
for (let i = 0; i <= 5; i++) {
  const idx = `0x${i.toString(16)}` as Hex;
  const { km } = await deriveKeys(RECOVERY_PRIVATE_KEY, idx);
  const digest = pHash([AUTH_TYPE_DIRECT_KEY, km.getPrivateRevocableKey()]);
  if (eq(digest, ONCHAIN_AUTH_DIGEST)) {
    matchedIndex = i;
    revocableKm = km;
    break;
  }
}
if (matchedIndex === null) {
  console.error(
    "authDigest not reproduced at revocable indexes 0..5 — witness would fail. Aborting.",
  );
  process.exit(1);
}
console.log(`authDigest MATCHES at revocableKeyIndex ${matchedIndex} ✓`);

// --- Owner wallet: viewing keys (notes encrypt to these) ---
const { account: ownerAccount, km: ownerKm } = await deriveKeys(
  OWNER_PRIVATE_KEY,
  "0x0" as Hex,
);
console.log("owner wallet:", ownerAccount.address);
if (
  ownerAccount.address.toLowerCase() !== EXPECTED_OWNER_ADDRESS.toLowerCase()
) {
  console.error(
    `Owner key controls ${ownerAccount.address}, expected ${EXPECTED_OWNER_ADDRESS}. Aborting.`,
  );
  process.exit(1);
}
const viewingKeyPair = ownerKm.getViewingKeyPair();

// --- Write hybrid state for the mass-ragequit suite ---
const statePath = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../.mainnet-test-state.json",
);
const state = {
  protocolKeys: {
    privateNullifyingKey: revocableKm.getPrivateNullifyingKey(),
    privateRevocableKey: revocableKm.getPrivateRevocableKey(),
    revocableKeyIndex: `0x${matchedIndex.toString(16)}`,
    viewingPrivateKey: viewingKeyPair.privateKey,
    viewingPublicKey: viewingKeyPair.publicKey,
  },
  aspLeaves: [],
  keystoreRegistered: true,
};
writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
console.log(`\nHybrid state written to ${statePath}`);
console.log("Now run: bash run_a_test.sh 5");
