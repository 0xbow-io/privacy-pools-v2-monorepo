import type { Address, Hex } from "@privacy-pools-v2/evm-sdk";
import { getContract } from "./helpers/deployment-loader.js";

/**
 * Shared Privacy Pools V2 contract addresses for the mainnet (Arbitrum) smoke-test
 * suites. Deliberately independent of the SDK's `DEPLOYMENTS` map and any package
 * release. Every mainnet integration suite imports these common addresses instead
 * of hardcoding them.
 *
 * Two real Arbitrum deployments coexist; pick with `NEW_CONTRACTS`:
 *   - NEW_CONTRACTS unset or "true"  → the newer smoke deployment (July 10 broadcast)
 *   - NEW_CONTRACTS="false"          → the older swap-test deployment (the one
 *     RelaySwaps 0xE9D6... is immutably wired to; relayer.config.latest.json matches it)
 *
 * Per-suite addresses (tokens, etc.) stay in their own files.
 */
type SmokeDeployment = {
  pool: Address;
  entrypoint: Address;
  keystore: Address;
  aspRegistry: Address;
  relaySwaps: Hex;
  /** Earliest block with a LeafInserted on these contracts (decimal). */
  deploymentBlock: bigint;
};

/** Current Arbitrum deployment — matches deployments-it-002.json and relayer.config.real.json. */
const NEW_DEPLOYMENT: SmokeDeployment = {
  pool: getContract(42161, "PoolVault") as Address,
  entrypoint: getContract(42161, "Entrypoint") as Address,
  keystore: getContract(42161, "Keystore") as Address,
  aspRegistry: getContract(42161, "ASPRegistry") as Address,
  relaySwaps: getContract(42161, "RelaySwaps") as Hex,
  deploymentBlock: 482_545_313n,
};

/**
 * Older swap-test deployment — the one RelaySwaps 0xE9D6... serves (its POOL()/
 * ENTRYPOINT() are immutable). The relayer-dependent suites and
 * relayer.config.latest.json run against this one.
 */
const OLD_DEPLOYMENT: SmokeDeployment = {
  pool: "0xFf11c6d8e4176f0987FEf10cC904A5D3eeDCbB51" as Address,
  entrypoint: "0xa845D793C0D01ba8803A49a3d17c749Fef781D51" as Address,
  keystore: "0x813eb92c6217e0447601f6463A2A83304108f1fD" as Address,
  aspRegistry: "0x75A93132393a6956A1F354176c0aab6917ec05cf" as Address,
  relaySwaps: "0xE9D64494021257849F96F8F00e59D42B67EF22C2" as Hex,
  deploymentBlock: 479_886_149n,
};

const DEPLOYMENT =
  process.env.NEW_CONTRACTS === "false" ? OLD_DEPLOYMENT : NEW_DEPLOYMENT;

export const POOL_ADDRESS = DEPLOYMENT.pool;
export const ENTRYPOINT_ADDRESS = DEPLOYMENT.entrypoint;
export const KEYSTORE_ADDRESS = DEPLOYMENT.keystore;
export const ASP_REGISTRY_ADDRESS = DEPLOYMENT.aspRegistry;
export const RELAY_SWAPS_ADDRESS = DEPLOYMENT.relaySwaps;

/**
 * Deployment block — the `fromBlock` for every on-chain leaf scan (keystore,
 * state, ASP). MUST be at or before the earliest `LeafInserted` on these
 * contracts, or leaf-tree reconstruction is sparse and merkle proofs fail with
 * `LeafNotFound`.
 *
 * Defaults to the selected deployment's block; override per-run with the
 * `DEPLOYMENT_BLOCK` env var (decimal or 0x-hex). Exported as the 0x-hex
 * string the SDK's `deploymentBlock` expects.
 */
const DEPLOYMENT_BLOCK_NUMBER = process.env.DEPLOYMENT_BLOCK
  ? BigInt(process.env.DEPLOYMENT_BLOCK)
  : DEPLOYMENT.deploymentBlock;
export const DEPLOYMENT_BLOCK =
  `0x${DEPLOYMENT_BLOCK_NUMBER.toString(16)}` as Hex;
