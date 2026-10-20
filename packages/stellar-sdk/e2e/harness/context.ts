import { AspAdminClient } from "@privacy-pools-v2/mock-asp";
import { inject } from "vitest";

import { SorobanRPCInteractor } from "../../src/internal.js";
import type { StellarE2ENetwork } from "../network.js";
import type { StellarE2ERelayer } from "../relayer.js";

/** True only under `STELLAR_E2E=1`; test files use `describe.skipIf(!STELLAR_E2E)` so a bare `vitest run` is inert. */
export const STELLAR_E2E = process.env.STELLAR_E2E === "1";

/** What `globalSetup` hands to test files. Plain serializable data only (vitest `provide`). */
export interface E2EProvided {
    network: StellarE2ENetwork;
    relayer: StellarE2ERelayer;
    aspUrl: string;
}

declare module "vitest" {
    export interface ProvidedContext {
        e2e: E2EProvided;
    }
}

export interface E2EContext extends E2EProvided {
    asp: AspAdminClient;
    rpcInteractor: SorobanRPCInteractor;
}

/**
 * How often sessions and the harness re-check a submitted transaction. The SDK's 2 s default suits
 * public networks; the local standalone network closes a ledger about every second, and at 2 s every
 * receipt wait cost most of a poll interval — over 3 minutes of a full run.
 */
export const E2E_RECEIPT_POLL_INTERVAL_MS = 200;

/** Infrastructure started once by `globalSetup`; call from `beforeAll`. */
export function e2eContext(): E2EContext {
    const provided = inject("e2e");
    return {
        ...provided,
        asp: new AspAdminClient(provided.aspUrl),
        rpcInteractor: new SorobanRPCInteractor({
            rpcUrl: provided.network.rpcUrl,
            networkPassphrase: provided.network.networkPassphrase,
            receiptPollIntervalMs: E2E_RECEIPT_POLL_INTERVAL_MS,
        }),
    };
}
