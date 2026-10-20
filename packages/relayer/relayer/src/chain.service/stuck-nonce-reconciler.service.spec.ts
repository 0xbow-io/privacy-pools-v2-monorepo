import { createPublicClient, createWalletClient } from "viem";
import { StuckNonceReconcilerService } from "./stuck-nonce-reconciler.service";
import { RelayerConfig } from "../config/relayer-config";
import { createMockLogger } from "../test/mocks";
import type { EvmChainId, EvmPrivateKey } from "../config/evm/evm.types";

// Exercises StuckNonceReconcilerService against the REAL checkAndFixStuckNonce
// (stuck-nonce.ts) — the same function evm.chain.service.stuck-nonce.spec.ts
// exercises via EVMChainService's reactive call sites. That file already
// covers the detection/fix logic itself exhaustively (both timeout tiers,
// the in-flight guard, the eviction-survival fix, best-effort error
// swallowing); this file only covers what's specific to the reconciler:
// boot-seeding, the periodic timer firing with zero write-request traffic,
// and looping every configured chain. Each test uses its own chainId(s) for
// isolation, since stuck-nonce.ts's module-level state is NOT reset between
// tests (same convention as the sibling spec file).
//
// `createPublicClient` is mocked to dispatch by `chain.id` (StuckNonceReconcilerService
// builds a fresh plain viem client per chain per call, mirroring
// routing_layout_boot_validator.ts's own boot-time pattern) so multiple
// chains can be modeled independently in one test.
jest.mock("viem", () => {
    const actual = jest.requireActual("viem");
    return {
        ...actual,
        createPublicClient: jest.fn(),
        createWalletClient: jest.fn(),
    };
});

const FIRST_ANVIL_PKEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as EvmPrivateKey;
const CANCEL_TX_HASH = "0xdead000000000000000000000000000000000000000000000000000000000dea" as const;

interface Counts {
    latest: number;
    pending: number;
}

// Raw config shape (snake_case) — production code now wraps this itself via
// `new EvmChainConfigWrapper(c)` (Chain<T>.allConfigs() returns raw configs,
// not wrappers — see yield_zap_registry.spec.ts for the same convention).
function makeChainConfig(id: number, counts: Counts, opts: { pendingBlockTransactions?: { from: string; nonce: number }[] } = {}) {
    const getTransactionCount = jest.fn(async ({ blockTag }: { blockTag: "latest" | "pending" }) =>
        blockTag === "latest" ? counts.latest : counts.pending
    );
    const getBlock = jest.fn(async () => ({ transactions: opts.pendingBlockTransactions ?? [] }));
    const getGasPrice = jest.fn(async () => 1_000_000_000n);
    const publicClient = { getTransactionCount, getBlock, getGasPrice };

    const chainConfig = {
        id: id as EvmChainId,
        name: `test-chain-${id}`,
        rpc_url: `http://localhost:${8500 + id}`,
        native_currency: { name: "Ether", symbol: "ETH", decimals: 18 },
        signer_private_key: FIRST_ANVIL_PKEY,
    };
    return { chainConfig, publicClient, getTransactionCount, getBlock };
}

function installDispatcher(clients: Map<number, unknown>) {
    (createPublicClient as jest.Mock).mockImplementation((args: { chain: { id: number } }) => {
        const client = clients.get(args.chain.id);
        if (!client) throw new Error(`no mock client registered for chain ${args.chain.id}`);
        return client;
    });
}

function makeRelayerConfig(chainConfigs: unknown[]): RelayerConfig {
    return {
        chain: jest.fn().mockReturnValue({ allConfigs: () => chainConfigs }),
    } as unknown as RelayerConfig;
}

describe("StuckNonceReconcilerService", () => {
    let logger: ReturnType<typeof createMockLogger>;
    let cancelSendTransaction: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        logger = createMockLogger();
        cancelSendTransaction = jest.fn(async () => CANCEL_TX_HASH);
        (createWalletClient as jest.Mock).mockReturnValue({ sendTransaction: cancelSendTransaction });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("boot-seeds an already-outstanding multi-nonce gap at elapsed-zero, not epoch-zero", async () => {
        const counts: Counts = { latest: 98, pending: 101 }; // nonces 98, 99, 100 outstanding — the 2026-09-30 shape
        const { chainConfig, publicClient } = makeChainConfig(71001, counts, { pendingBlockTransactions: [] });
        installDispatcher(new Map([[71001, publicClient]]));
        const service = new StuckNonceReconcilerService(makeRelayerConfig([chainConfig]), logger as never);

        await service.onApplicationBootstrap();

        // Seeded at "now" (elapsed zero) — immediately after boot, nowhere
        // near the absent timeout yet, so nothing should fire on its own.
        // Seeding at epoch zero instead (the bug an earlier draft of this
        // design had) would have caused an immediate cancel here.
        expect(cancelSendTransaction).not.toHaveBeenCalled();

        // The periodic tick itself, past STUCK_ABSENT_TIMEOUT_MS (120_000
        // default) from boot, is what fires the fix — the floor nonce (98),
        // not any of the later ones (99, 100) queued behind it.
        await jest.advanceTimersByTimeAsync(130_000);

        expect(cancelSendTransaction).toHaveBeenCalledTimes(1);
        expect(cancelSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 98, value: 0n }));

        service.onModuleDestroy();
    });

    it("the periodic tick alone fires a fix, with no write request ever happening", async () => {
        const counts: Counts = { latest: 200, pending: 200 }; // healthy at boot — nothing to seed
        const { chainConfig, publicClient } = makeChainConfig(71002, counts, { pendingBlockTransactions: [] });
        installDispatcher(new Map([[71002, publicClient]]));
        const service = new StuckNonceReconcilerService(makeRelayerConfig([chainConfig]), logger as never);

        await service.onApplicationBootstrap();
        expect(cancelSendTransaction).not.toHaveBeenCalled();

        // A gap now appears with zero involvement from any write request —
        // only the reconciler's own timer will ever notice this.
        counts.pending = 201;

        // First tick after the gap appears: observes it for the first time,
        // starts the clock, doesn't act yet.
        await jest.advanceTimersByTimeAsync(60_000);
        expect(cancelSendTransaction).not.toHaveBeenCalled();

        // A later tick, past the absent timeout from when the gap was first
        // observed by the timer (not from when it actually appeared, since
        // nothing was watching yet — same "first observed" fallback the
        // reactive path itself falls back to when nothing recorded a real
        // broadcast time). Ticks land every 60s, so the clock starts at the
        // 60s tick and the first tick with elapsed >= 120s is the one at 180s.
        await jest.advanceTimersByTimeAsync(120_000);

        expect(cancelSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 200, value: 0n }));

        service.onModuleDestroy();
    });

    it("reconcileAllChains() — the Cloud Scheduler endpoint's entry point — reconciles every configured chain", async () => {
        const countsA: Counts = { latest: 10, pending: 10 };
        const countsB: Counts = { latest: 20, pending: 20 };
        const { chainConfig: chainA, publicClient: clientA, getTransactionCount: getTxCountA } = makeChainConfig(71003, countsA);
        const { chainConfig: chainB, publicClient: clientB, getTransactionCount: getTxCountB } = makeChainConfig(71004, countsB);
        installDispatcher(
            new Map<number, unknown>([
                [71003, clientA],
                [71004, clientB],
            ])
        );
        const service = new StuckNonceReconcilerService(makeRelayerConfig([chainA, chainB]), logger as never);

        await service.reconcileAllChains();

        expect(getTxCountA).toHaveBeenCalled();
        expect(getTxCountB).toHaveBeenCalled();
        expect(cancelSendTransaction).not.toHaveBeenCalled(); // both chains healthy — nothing to fix

        service.onModuleDestroy();
    });

    it("onModuleDestroy stops the timer — no further ticks fire after shutdown", async () => {
        const counts: Counts = { latest: 300, pending: 301 };
        const { chainConfig, publicClient, getTransactionCount } = makeChainConfig(71005, counts, { pendingBlockTransactions: [] });
        installDispatcher(new Map([[71005, publicClient]]));
        const service = new StuckNonceReconcilerService(makeRelayerConfig([chainConfig]), logger as never);

        await service.onApplicationBootstrap();
        const callsAtBoot = getTransactionCount.mock.calls.length;

        service.onModuleDestroy();
        await jest.advanceTimersByTimeAsync(600_000); // well past every relevant timeout

        expect(getTransactionCount.mock.calls.length).toBe(callsAtBoot);
        expect(cancelSendTransaction).not.toHaveBeenCalled();
    });
});
