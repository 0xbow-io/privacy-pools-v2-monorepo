import type { Hex } from "@privacy-pools-v2/core-sdk";
import { HTTPClient, HttpASPDataProvider, MerkleService, PoseidonHashService } from "@privacy-pools-v2/core-sdk";

import type {
    AspChainEventSource,
    AspRootPublisher,
    MockAspHttpServerConfig,
    WireEventSnapshot,
    WireNoteEventsPage,
} from "../../src/internal.js";
import { MockAspHttpServer } from "../../src/internal.js";

export const CHAIN_ID = 31337;
export const ENTRYPOINT = "0x00000000000000000000000000000000000000e1";

/** Records what would have been published on-chain; can be told to reject. */
export class FakePublisher implements AspRootPublisher {
    readonly published: bigint[] = [];
    failWith: string | null = null;
    latest: bigint | null = null;

    publishRoot(root: bigint): Promise<{ txId: string }> {
        if (this.failWith) return Promise.reject(new Error(this.failWith));
        this.published.push(root);
        return Promise.resolve({ txId: `0xtx${this.published.length}` });
    }

    readLatestRoot(): Promise<bigint | null> {
        return Promise.resolve(this.latest);
    }
}

export const NOTE_EVENT = {
    blockNumber: "7",
    txHash: ("0x" + "11".repeat(32)) as Hex,
    hint: ("0x" + "22".repeat(32)) as Hex,
    ephemeralPubKey: ("0x" + "33".repeat(32)) as Hex,
    encryptedPayload: "0xabcd" as Hex,
};

/** A minimal valid wire snapshot with one deposit row. */
export function snapshotFixture(): WireEventSnapshot {
    return {
        chainId: String(CHAIN_ID),
        snapshotBlockNumber: "100",
        generatedAt: "2026-01-01T00:00:00.000Z",
        deposits: [
            {
                txHash: "0x" + "44".repeat(32),
                logIndex: 0,
                depositAddress: "0x" + "55".repeat(20),
                outputCommitment: "12345",
                depositedValue: "1000",
                fee: "0",
                blockNumber: "5",
                blockTimestamp: "1700000000",
                asset: "0x" + "66".repeat(20),
            },
        ],
        transacts: [],
        ragequits: [],
        leaves: [],
        keystoreLeaves: [],
    };
}

/** Records the ranges it was asked for. */
export class FakeEventSource implements AspChainEventSource {
    readonly ranges: { since?: bigint; until?: bigint }[] = [];
    events = [NOTE_EVENT];

    getNoteEvents(range: { since?: bigint; until?: bigint }): Promise<WireNoteEventsPage> {
        this.ranges.push(range);
        return Promise.resolve({ events: [...this.events], lastSyncedBlock: "0x10" as Hex });
    }

    getEventSnapshot(): Promise<WireEventSnapshot> {
        return Promise.resolve(snapshotFixture());
    }
}

export async function startServer(
    overrides: Partial<MockAspHttpServerConfig> & { publisher: AspRootPublisher },
): Promise<MockAspHttpServer> {
    return MockAspHttpServer.start({
        scope: { chainId: CHAIN_ID, entrypoint: ENTRYPOINT },
        ...overrides,
    });
}

/** A real core-sdk provider + client, with no retries so faults surface immediately. */
export function providerFor(
    server: MockAspHttpServer,
    options?: { timeout?: number; entrypointAddress?: string },
): HttpASPDataProvider {
    return new HttpASPDataProvider({
        aspUrl: server.url,
        chainId: CHAIN_ID,
        entrypointAddress: (options?.entrypointAddress ?? ENTRYPOINT) as `0x${string}`,
        httpClient: new HTTPClient({ retryAttempts: 0, timeout: options?.timeout ?? 2000 }),
    });
}

export async function post(
    server: MockAspHttpServer,
    path: string,
    body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function get(
    server: MockAspHttpServer,
    path: string,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
    const res = await fetch(`${server.url}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

/** Independent Poseidon/LeanIMT, to check the server's roots against. */
export async function createReference(): Promise<{
    leafFor: (label: Hex) => Hex;
    rootOf: (leaves: Hex[]) => Promise<bigint>;
}> {
    const hashService = await PoseidonHashService.create();
    const merkle = new MerkleService({ hashService });
    return {
        leafFor: (label) => hashService.hash([label]),
        rootOf: async (leaves) => BigInt(await merkle.computeRoot(leaves)),
    };
}
