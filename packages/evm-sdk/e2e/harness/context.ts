import { createPublicClient, http } from "viem";
import { inject } from "vitest";

import { currentLane } from "../lanes.js";
import type { EvmE2ENetwork } from "../network.js";
import type { EvmE2ERelayer } from "../relayer.js";
import { AspAdminClient } from "./asp.js";

/**
 * How often viem re-polls (e.g. `waitForTransactionReceipt`) on the local anvil. viem's default is
 * 4 s, and anvil can answer the first receipt check before it has mined the tx, so every such wait
 * otherwise cost a full 4 s — most of the suite's wall time.
 */
export const E2E_POLLING_INTERVAL_MS = 100;

/** True only under `EVM_E2E=1`; test files use `describe.skipIf(!EVM_E2E)` so a bare `vitest run` is inert. */
export const EVM_E2E = process.env.EVM_E2E === "1";

/** One lane's infrastructure (see `lanes.ts`). */
export interface E2ELane {
    network: EvmE2ENetwork;
    relayer: EvmE2ERelayer;
    aspUrl: string;
}

/** What `globalSetup` hands to test files. Plain serializable data only (vitest `provide`). */
export interface E2EProvided {
    /** By lane; a file uses its worker's ({@link currentLane}). */
    lanes: E2ELane[];
}

declare module "vitest" {
    export interface ProvidedContext {
        e2e: E2EProvided;
    }
}

export interface E2EContext extends E2ELane {
    asp: AspAdminClient;
    publicClient: ReturnType<typeof createPublicClient>;
}

/** The RPC url of this worker's lane — for helpers that run without an {@link E2EContext}. */
export function laneRpcUrl(): string {
    return currentLane(inject("e2e").lanes).network.rpcUrl;
}

/** This worker's lane of the infrastructure started once by `globalSetup`; call from `beforeAll`. */
export function e2eContext(): E2EContext {
    const provided = currentLane(inject("e2e").lanes);
    return {
        ...provided,
        asp: new AspAdminClient(provided.aspUrl),
        publicClient: createPublicClient({
            transport: http(provided.network.rpcUrl),
            pollingInterval: E2E_POLLING_INTERVAL_MS,
        }),
    };
}
