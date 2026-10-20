import type { E2EProofService, AccountState, RelayPayload } from "../proofs";
import type { PoseidonHashService } from "@privacy-pools-v2/evm-sdk";
import type { Hex as SDKHex } from "@privacy-pools-v2/evm-sdk";
import type { Address } from "viem";

export interface RelayContext {
    proofService: E2EProofService;
    hashService: Awaited<ReturnType<typeof PoseidonHashService.create>>;
    accounts: AccountState[];
    aspLeaves: SDKHex[];
    baseUrl: string;
    chainId: string;
    relayEndpoint: string;
    payloads: Map<string, RelayPayload & { recipient?: Address }>;
    revertAndSnapshot: () => Promise<void>;
}
