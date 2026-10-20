/**
 * Diagnose why the locally derived keystore leaf doesn't match the on-chain
 * registration for the signer account (LeafNotFound during ragequit).
 *
 * Derives protocol keys from the signer's EIP-712 signature exactly like the
 * mainnet integration tests, recomputes nullifyingKeyHash / authDigest /
 * keystore leaf, and compares each against the values registered on-chain
 * (AuthPolicySet event, block 482548219) and the current keystore tree leaves.
 *
 * Run from packages/swaps with the signer key exported:
 *   npx tsx test/diagnose-keystore-keys.ts
 */
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

// --- On-chain facts (Arb mainnet keystore 0xffA6...3509) ---
// AuthPolicySet(account=0x0967755A..., nullifyingKeyHash, authDigest) @ block 482548219
const ONCHAIN_NULLIFYING_KEY_HASH =
  "0x1edded83dcf2e6530f9800c408cf6f3c9348d92c60551555c050c1741f9b8e71";
const ONCHAIN_AUTH_DIGEST =
  "0x008f53f186bc60857996725db589943c8c9daeffeb43b75db705c67061c029ac";
// Current keystore tree leaves (LeafInserted events, all 3 registrations)
const ONCHAIN_TREE_LEAVES = [
  "0x1e2989d88ee5cfa232f0a077a69f76a781685038c83843201ef5730de70d9497",
  "0x2cecba63cf2b077fb968147220f1941c470adbb24abb1904a2cdecb1eae2aa6f",
  "0x2b5d9b5f4d484cc0793e3fba4e0bb71b18be43ea24dc38dd3267da98bf8b5745",
];

const AUTH_TYPE_DIRECT_KEY = "0x0"; // sdk constant (v2.0 direct-key auth)

const PRIVATE_KEY =
  process.env.PRIVATE_KEY ?? process.env.SIGNER_PRIVATE_KEY_42161;
if (!PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY or SIGNER_PRIVATE_KEY_42161");
  process.exit(1);
}

// Same payload as the mainnet integration tests
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

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({
  account,
  chain: arbitrum,
  transport: http("https://arb1.arbitrum.io/rpc"),
});

const poseidon = await buildPoseidon();
const pHash = (inputs: (Hex | string | bigint)[]): Hex => {
  const montgomery = poseidon(inputs);
  const out = poseidon.F.toObject(montgomery);
  return `0x${out.toString(16).padStart(64, "0")}` as Hex;
};

console.log("signer address:", account.address);

const payload = buildSecretDerivationPayload(account.address as Address);
const signature = await walletClient.signTypedData({ ...payload, account });
const addressHash = keccak256(account.address as `0x${string}`);

const km = KeystoreManager.fromSignature(
  {
    signature: signature as Hex,
    signerAddress: account.address as Address,
    revocableKeyIndex: "0x0" as Hex,
    addressHash: addressHash as Hex,
  },
  { cryptoService: new CryptoService() },
);

const privateNullifyingKey = km.getPrivateNullifyingKey();
const privateRevocableKey = km.getPrivateRevocableKey();

const nullifyingKeyHash = pHash([privateNullifyingKey]);
const authDigest = pHash([AUTH_TYPE_DIRECT_KEY, privateRevocableKey]);
const leaf = pHash([BigInt(account.address), nullifyingKeyHash, authDigest]);
// Hybrid leaves: on-chain nullifying key combined with local authDigest and vice versa
const leafOnchainNkLocalDigest = pHash([
  BigInt(account.address),
  ONCHAIN_NULLIFYING_KEY_HASH,
  authDigest,
]);
const leafLocalNkOnchainDigest = pHash([
  BigInt(account.address),
  nullifyingKeyHash,
  ONCHAIN_AUTH_DIGEST,
]);
const leafOnchainBoth = pHash([
  BigInt(account.address),
  ONCHAIN_NULLIFYING_KEY_HASH,
  ONCHAIN_AUTH_DIGEST,
]);

const eq = (a: string, b: string) => BigInt(a) === BigInt(b);
const inTree = (l: string) => ONCHAIN_TREE_LEAVES.some((t) => eq(t, l));

console.log("\n--- comparison ---");
console.log("nullifyingKeyHash local :", nullifyingKeyHash);
console.log("nullifyingKeyHash chain :", ONCHAIN_NULLIFYING_KEY_HASH);
console.log("  MATCH:", eq(nullifyingKeyHash, ONCHAIN_NULLIFYING_KEY_HASH));
console.log("authDigest local        :", authDigest);
console.log("authDigest chain        :", ONCHAIN_AUTH_DIGEST);
console.log("  MATCH:", eq(authDigest, ONCHAIN_AUTH_DIGEST));
console.log("\nleaf(local,local)       :", leaf, "inTree:", inTree(leaf));
console.log(
  "leaf(chainNk,localDig)  :",
  leafOnchainNkLocalDigest,
  "inTree:",
  inTree(leafOnchainNkLocalDigest),
);
console.log(
  "leaf(localNk,chainDig)  :",
  leafLocalNkOnchainDigest,
  "inTree:",
  inTree(leafLocalNkOnchainDigest),
);
console.log(
  "leaf(chainNk,chainDig)  :",
  leafOnchainBoth,
  "inTree:",
  inTree(leafOnchainBoth),
);

console.log("\n--- verdict ---");
if (eq(nullifyingKeyHash, ONCHAIN_NULLIFYING_KEY_HASH)) {
  if (eq(authDigest, ONCHAIN_AUTH_DIGEST)) {
    console.log(
      "Both match — leaf mismatch must be a leaf-format/tree-sync issue, not key drift.",
    );
  } else {
    console.log(
      "Nullifying key matches, authDigest drifted — RECOVERABLE via updateAuthPolicy() from the signer account.",
    );
  }
} else {
  console.log(
    "Nullifying key DOES NOT match on-chain registration — registration used keys derived elsewhere (e.g. the previous tester's BIP39 wallet). Ragequit needs that original derivation source; updateAuthPolicy cannot change the nullifying key.",
  );
}
