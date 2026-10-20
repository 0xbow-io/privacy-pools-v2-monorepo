import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Address, Hex } from "@privacy-pools-v2/evm-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ContractName =
  | "PoolVault"
  | "Entrypoint"
  | "Keystore"
  | "ASPRegistry"
  | "RelaySwaps";

interface ChainDeployment {
  chainId: number;
  chainName: string;
  status: "deployed" | "not_deployed";
  deployedAt?: string | null;
  deployBlock?: number | null;
  contracts?: Partial<Record<ContractName, string | null>>;
  note?: string;
}

function loadDeployments(): ChainDeployment[] {
  const filePath =
    process.env.RELAY_SWAPS_DEPLOYMENTS_PATH ??
    resolve(__dirname, "../../contracts/deployments-it-002.json");
  return JSON.parse(readFileSync(filePath, "utf8")) as ChainDeployment[];
}

function latestDeployment(chainId: number): ChainDeployment | undefined {
  return loadDeployments()
    .filter((d) => d.chainId === chainId && d.status === "deployed")
    .sort((a, b) => {
      if (!a.deployedAt) return 1;
      if (!b.deployedAt) return -1;
      return b.deployedAt.localeCompare(a.deployedAt);
    })[0];
}

export function tryGetContract(
  chainId: number,
  contract: ContractName,
): Address | null {
  const deployment = latestDeployment(chainId);
  const address = deployment?.contracts?.[contract];
  return address ? (address as Address) : null;
}

export function getContract(chainId: number, contract: ContractName): Address {
  const address = tryGetContract(chainId, contract);
  if (!address) {
    const source =
      process.env.RELAY_SWAPS_DEPLOYMENTS_PATH ?? "deployments-it-002.json";
    throw new Error(
      `Contract ${contract} not deployed on chainId ${chainId} (source: ${source})`,
    );
  }
  return address;
}

/** PoolSessionBuilder's `deploymentBlock` scan-lower-bound, as the `Hex` it expects —
 * `undefined` if the registry has no `deployBlock` for this chain (e.g. still null,
 * not yet looked up). Doesn't need to be the literal contract-creation block, just a
 * recent, not-in-the-future lower bound (see ContractInteractor.ts's own doc comment
 * on `deploymentBlock` — the SDK never persists it, it's a delta-fetch optimization). */
export function getDeployBlock(chainId: number): Hex | undefined {
  const block = latestDeployment(chainId)?.deployBlock;
  return typeof block === "number"
    ? (`0x${block.toString(16)}` as Hex)
    : undefined;
}
