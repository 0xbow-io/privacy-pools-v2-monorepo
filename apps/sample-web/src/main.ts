import {
  APP_IDENTIFIER,
  CryptoService,
  KeystoreManager,
  HTTPClient,
  IpfsCircuitArtifacts,
  LocalStorageService,
  NoteManager,
  NoteStorageAdapter,
  NoteStatus,
} from "@privacy-pools-v2/evm-sdk";

import { buildSecretDerivationPayload } from "./secretDerivationPayload.js";
import type {
  Address,
  CircuitManifest,
  Hash,
  Hex,
  Note,
} from "@privacy-pools-v2/evm-sdk";

const CHAIN_ID = 11155111; // Sepolia
const ETH_TOKEN_ID = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

function makeNote(
  overrides: Partial<Note> & Pick<Note, "commitment" | "label">,
): Note {
  return {
    noteAddressHash: "0x0" as Hex,
    value: "0x16345785d8a0000" as Hex,
    tokenId: ETH_TOKEN_ID,
    status: NoteStatus.INACTIVE,
    ownerAddress: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
    noteSecret: "0xaabbccdd" as Hex,
    isOwned: true,
    createdAtBlock: "0x1" as Hex,
    spentAtBlock: null,
    txHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111" as Hash,
    ...overrides,
  };
}

const NOTE_A = makeNote({
  commitment:
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hash,
  label:
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
});
const NOTE_B = makeNote({
  commitment:
    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hash,
  label:
    "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Hex,
  value: "0x2c68af0bb140000" as Hex,
});

// Demo-only owner used for the offline NoteManager-persistence playground.
// Real sessions thread `ownerAddress` from the connected wallet through to
// the storage adapter so the key is per-account.
const DEMO_OWNER_ADDRESS = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF" as const;

function makeManager(): { manager: NoteManager; adapter: NoteStorageAdapter } {
  const storage = new LocalStorageService({ prefix: "privacy-pool" });
  const adapter = new NoteStorageAdapter(CHAIN_ID, storage, DEMO_OWNER_ADDRESS);
  const manager = new NoteManager({}, { storageAdapter: adapter });
  return { manager, adapter };
}

// ── UI ────────────────────────────────────────────────────────────────────────

const out = document.getElementById("output") as HTMLPreElement;

function log(msg: string): void {
  out.textContent += msg + "\n";
}

function showLocalStorage(): void {
  out.textContent = "";
  const prefix = "privacy-pool:";
  let found = false;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (!key.startsWith(prefix)) continue;
    found = true;
    log(`Key: ${key}`);
    log(JSON.stringify(JSON.parse(localStorage.getItem(key)!), null, 2) + "\n");
  }
  if (!found)
    log("No privacy-pool keys in localStorage. Run the example first.");
}

async function run(): Promise<void> {
  out.textContent = "";
  const { manager: manager1, adapter } = makeManager();

  log("Phase 0 — clear");
  await adapter.clearState();
  log("  cleared\n");

  log("Phase 1 — add notes, flush");
  await manager1.loadFromStorage();
  log(`  notes before: ${manager1.getNotes().length}`);
  manager1.addNote(NOTE_A);
  manager1.addNote(NOTE_B);
  await manager1.flush();
  log(`  notes after:  ${manager1.getNotes().length}\n`);

  log("Phase 2 — reload from localStorage, verify");
  const { manager: manager2 } = makeManager();
  await manager2.loadFromStorage();
  const loaded = manager2.getNotes();
  log(`  notes loaded: ${loaded.length}`);
  for (const n of loaded) {
    log(
      `    ${n.commitment.slice(0, 10)}…  value=${n.value}  status=${n.status}`,
    );
  }

  log(
    "\nDone. Data left in localStorage — click 'Show raw' or open DevTools → Application → Local Storage.",
  );
}

async function clearStorage(): Promise<void> {
  const { adapter } = makeManager();
  await adapter.clearState();
  out.textContent = "Storage cleared.";
}

// ── IpfsCircuitArtifacts smoke test ───────────────────────────────────────────
// Real circuit CIDs are not pinned yet (DEFAULT_CIRCUIT_MANIFEST ships empty).
// This demo uses the canonical IPFS welcome doc as a stand-in payload to
// exercise the SDK plumbing end-to-end in the browser: fetch, cache, fallback.
// The bytes returned are NOT valid WASM — snarkjs won't run against them.
const SAMPLE_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const PRIMARY_GATEWAY = "https://ipfs.io/ipfs";
// Same-host fallback. Public IPFS gateways (Pinata, dweb.link, 4everland) have
// shown intermittent CORS / network failures in browser sessions even when
// curl confirms permissive headers. Using ipfs.io for the fallback keeps the
// demo deterministic — the fallback *mechanism* is proven (bad gateway → next
// gateway in list), just hitting the same host as phase 1.
const FALLBACK_GATEWAY = PRIMARY_GATEWAY;
const BAD_GATEWAY =
  "https://this-gateway-does-not-resolve.example.invalid/ipfs";

const SAMPLE_MANIFEST: CircuitManifest = {
  sample: {
    wasm: SAMPLE_CID,
    provingKey: SAMPLE_CID,
    verificationKey: SAMPLE_CID,
  },
};

async function runIpfsDemo(): Promise<void> {
  out.textContent = "";
  const httpClient = new HTTPClient();

  log("Phase 1 — single-gateway fetch + cache");
  const artifacts = new IpfsCircuitArtifacts({
    ipfsGatewayUrls: [PRIMARY_GATEWAY],
    circuitManifest: SAMPLE_MANIFEST,
    httpClient,
  });

  const t0 = performance.now();
  const first = await artifacts.getWasm("sample");
  const t1 = performance.now();
  log(`  network fetch: ${first.length} bytes in ${(t1 - t0).toFixed(0)} ms`);

  const t2 = performance.now();
  const second = await artifacts.getWasm("sample");
  const t3 = performance.now();
  log(
    `  cached fetch:  ${second.length} bytes in ${(t3 - t2).toFixed(0)} ms (no network)\n`,
  );

  log("Phase 2 — multi-gateway fallback (first gateway is invalid)");
  const fallbackArtifacts = new IpfsCircuitArtifacts({
    ipfsGatewayUrls: [BAD_GATEWAY, FALLBACK_GATEWAY],
    circuitManifest: SAMPLE_MANIFEST,
    httpClient,
  });
  const t4 = performance.now();
  const bytes = await fallbackArtifacts.getWasm("sample");
  const t5 = performance.now();
  log(
    `  fallback fetch: ${bytes.length} bytes in ${(t5 - t4).toFixed(0)} ms (first gateway failed, second succeeded)\n`,
  );

  log("Phase 3 — unpinned CID rejection");
  const unpinnedArtifacts = new IpfsCircuitArtifacts({
    ipfsGatewayUrls: [PRIMARY_GATEWAY],
    circuitManifest: {
      unpinned: { wasm: "", provingKey: "", verificationKey: "" },
    },
    httpClient,
  });
  try {
    await unpinnedArtifacts.getWasm("unpinned");
    log("  unexpected: did not throw");
  } catch (e) {
    log(
      `  rejected as expected: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }

  log("Done. Real circuit CIDs will land here once DevOps pins the artifacts.");
}

document.getElementById("btn-run")!.addEventListener("click", () => {
  run().catch((err: unknown) => {
    out.textContent += `\nError: ${String(err)}\n`;
    console.error(err);
  });
});
document.getElementById("btn-raw")!.addEventListener("click", showLocalStorage);
document.getElementById("btn-clear")!.addEventListener("click", () => {
  clearStorage().catch(console.error);
});
document.getElementById("btn-ipfs")!.addEventListener("click", () => {
  runIpfsDemo().catch((err: unknown) => {
    out.textContent += `\nError: ${String(err)}\n`;
    console.error(err);
  });
});

// ── Wallet key derivation ────────────────────────────────────────────────────

const outDerive = document.getElementById("output-derive") as HTMLPreElement;

function logDerive(msg: string): void {
  outDerive.textContent += msg + "\n";
}

async function deriveKeysFromWallet(): Promise<void> {
  outDerive.textContent = "";

  if (!window.ethereum) {
    logDerive("No injected wallet found. Install MetaMask and reload.");
    return;
  }

  logDerive("Requesting accounts…");
  const accounts = (await window.ethereum.request({
    method: "eth_requestAccounts",
  })) as string[];
  const signerAddress = accounts[0] as Address;
  logDerive(`Connected: ${signerAddress}\n`);

  // EIP-712 payload — see Signature-Based Derivation spec (Step 2).
  const typedData = buildSecretDerivationPayload(signerAddress);
  logDerive(`addressHash: ${typedData.message.addressHash}`);
  logDerive(`domain.salt: ${typedData.domain.salt}\n`);

  logDerive(`Requesting signTypedData (EIP-712) for app "${APP_IDENTIFIER}"`);
  logDerive("(Check your wallet — approve the signing request)\n");

  const signature = (await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [signerAddress, JSON.stringify(typedData)],
  })) as Hex;

  logDerive(`Signature: ${signature.slice(0, 20)}…\n`);

  const cryptoService = new CryptoService();
  const keys = cryptoService.deriveKeysFromSignature({
    signature,
    signerAddress,
    addressHash: typedData.message.addressHash,
    revocableKeyIndex: "0x0",
  });

  logDerive("Derived key material:");
  logDerive(`  privateNullifyingKey: ${keys.privateNullifyingKey}`);
  logDerive(`  privateRevocableKey:  ${keys.privateRevocableKey}`);
  logDerive(`  viewingPrivateKey:    ${keys.viewingPrivateKey}`);
  logDerive(`  viewingPublicKey:     ${keys.viewingPublicKey}`);
  logDerive("");

  const km = KeystoreManager.fromSignature(
    {
      signature,
      signerAddress,
      addressHash: typedData.message.addressHash,
      revocableKeyIndex: "0x0" as Hex,
    },
    { cryptoService },
  );
  const vp = km.getViewingKeyPair();
  logDerive("KeystoreManager.fromSignature() — same keys:");
  logDerive(`  nullifyingKey: ${km.getPrivateNullifyingKey()}`);
  logDerive(`  revocableKey:  ${km.getPrivateRevocableKey()}`);
  logDerive(`  viewingKey:    ${vp.privateKey}`);
  logDerive(`  viewingPub:    ${vp.publicKey}`);
  logDerive("");
  logDerive(
    "Keys are deterministic: same wallet + same payload = same keys every time.",
  );
}

document.getElementById("btn-derive")!.addEventListener("click", () => {
  deriveKeysFromWallet().catch((err: unknown) => {
    outDerive.textContent += `\nError: ${String(err)}\n`;
    console.error(err);
  });
});
