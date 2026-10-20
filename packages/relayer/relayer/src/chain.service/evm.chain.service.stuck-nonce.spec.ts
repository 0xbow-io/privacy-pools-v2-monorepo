import { Test, TestingModule } from "@nestjs/testing";
import { createWalletClient } from "viem";
import { EVMChainService } from "./evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import { Bytes, EvmRelaySDKPayload, ReshapedProof } from "../relay/evm/types";

// Stuck-nonce detection + auto-fix (see Ejemplos/stuck_nonce_reconciliation_plan.org
// for the full design trail). The detection/fix logic itself now lives in
// stuck-nonce.ts (shared with the periodic reconciler); this file exercises it
// only through EVMChainService's reactive call sites (writeWithGasCap,
// sendRawTransaction). State is a per-chain Map<Nonce, BroadcastTimeMs> —
// module-level in stuck-nonce.ts, populated both by a successful broadcast's
// own caller (the real broadcast time) and, as a fallback, by the check
// itself the first time it observes an outstanding nonce nothing recorded yet.
// Each test below uses its own chainId for isolation — this file's own testing
// convention, since that module-level state is NOT reset between tests.
//
// Key semantic the review corrected: `getTransactionCount({ blockTag: "pending" })`
// already counts a still-in-mempool tx as "sent" — it's the NEXT free nonce, not
// the stuck one. The actual stuck nonce (when one exists) is `blockTag: "latest"`
// whenever `pending > latest`. Every stub below returns DIFFERENT values for the
// two block tags to model this correctly; a stub that returned one constant for
// both would only test the (narrow, coincidental) fully-evicted case and would
// have hidden exactly the bug this suite now guards against.
//
// `createWalletClient` is mocked at the viem-module level: fixStuckNonce (in
// stuck-nonce.ts) builds its own throwaway wallet client for the cancel broadcast rather than going through
// EVMChainService.signer()/client() (which are separately stubbed per-test
// below for the request's own write path), so this is the only way to
// observe/control the cancel broadcast itself.
jest.mock("viem", () => {
    const actual = jest.requireActual("viem");
    return {
        ...actual,
        createWalletClient: jest.fn(),
    };
});

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SIGNER_ADDRESS = "0x0000000000000000000000000000000000000009" as const;
const RELAY_CONTRACT = "0x0000000000000000000000000000000000A0A1" as const;
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as const;
const CANCEL_TX_HASH = "0xdead000000000000000000000000000000000000000000000000000000000dea" as const;

const minimalProof = {
    pA: [0n, 0n],
    pB: [
        [0n, 0n],
        [0n, 0n],
    ],
    pC: [0n, 0n],
    pubSignals: [[], [], [0n], [0n], [0n], [1n], [0n], [0n]],
    parsedPubSignals: { nullifierHashes: ["0xstucknonce"] },
} as unknown as ReshapedProof;

function relayPayload(nullifier: string): EvmRelaySDKPayload {
    return {
        proof: { ...minimalProof, parsedPubSignals: { nullifierHashes: [nullifier] } },
        noteData: [],
        data: "0x00",
    } as unknown as EvmRelaySDKPayload;
}

interface Counts {
    latest: number;
    pending: number;
}

describe("EVM chain service — stuck-nonce detection and auto-fix", () => {
    let service: EVMChainService;
    let mockLogger: { log: jest.Mock; warn: jest.Mock; turbo: jest.Mock; error: jest.Mock };

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil-stuck" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8560"),
        relayContractAddress: jest.fn().mockReturnValue(RELAY_CONTRACT),
    };

    async function makeService(chainId: string): Promise<EVMChainService> {
        const loggerProvider = createMockLoggerProvider();
        mockLogger = loggerProvider.useValue as typeof mockLogger;
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EVMChainService,
                { provide: EvmConfigService, useValue: mockConfigService },
                loggerProvider,
                { provide: CHAIN_CONTEXT, useValue: { chainType: ChainType.EVM, chainId } },
            ],
        }).compile();
        return module.resolve<EVMChainService>(EVMChainService);
    }

    // `counts` is read live on every getTransactionCount call, so a test can
    // mutate it between two sequential writes to model the chain's state
    // changing over time (a gap opening, persisting, or healing).
    function stubClients(counts: Counts, opts: { pendingBlockTransactions?: { from: string; nonce: number }[] } = {}) {
        const getTransactionCount = jest.fn(async ({ blockTag }: { blockTag: "latest" | "pending" }) =>
            blockTag === "latest" ? counts.latest : counts.pending
        );
        const simulateContract = jest.fn(async () => ({ request: { some: "request" } }));
        const estimateContractGas = jest.fn(async () => 500_000n);
        const writeContract = jest.fn(async () => TX_HASH);
        const getGasPrice = jest.fn(async () => 1_000_000_000n);
        const getBlock = jest.fn(async () => ({ transactions: opts.pendingBlockTransactions ?? [] }));
        const getTransaction = jest.fn(async () => ({ nonce: counts.latest }));

        const publicClient = {
            simulateContract,
            estimateContractGas,
            getTransactionCount,
            getBlock,
            getGasPrice,
            getTransaction,
        };
        const walletClient = { account: { address: SIGNER_ADDRESS }, writeContract };
        jest.spyOn(service as unknown as { client: () => Promise<unknown> }, "client").mockResolvedValue(
            publicClient
        );
        jest.spyOn(service as unknown as { signer: () => Promise<unknown> }, "signer").mockResolvedValue(
            walletClient
        );

        const cancelSendTransaction = jest.fn(async () => CANCEL_TX_HASH);
        (createWalletClient as jest.Mock).mockReturnValue({ sendTransaction: cancelSendTransaction });

        return { getTransactionCount, simulateContract, estimateContractGas, writeContract, getBlock, cancelSendTransaction };
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("healthy chain: pending == latest throughout, no gap, no fix, one cheap getTransactionCount pair per write", async () => {
        service = await makeService("40001");
        const counts: Counts = { latest: 10, pending: 10 };
        const { getTransactionCount, writeContract, getBlock, cancelSendTransaction } = stubClients(counts);

        await service.simulateAndWriteRelay(relayPayload("0xn1"));
        counts.latest = 11;
        counts.pending = 11;
        await service.simulateAndWriteRelay(relayPayload("0xn2"));

        expect(getTransactionCount).toHaveBeenCalledTimes(4); // 2 calls (latest+pending) x 2 writes
        expect(getBlock).not.toHaveBeenCalled();
        expect(cancelSendTransaction).not.toHaveBeenCalled();
        expect(writeContract).toHaveBeenCalledTimes(2);
        expect(mockLogger.turbo).not.toHaveBeenCalled();
    });

    it("a write that fails before broadcasting (gas-cap rejection) never starts the clock, even if the chain then sits idle", async () => {
        // Models the false-positive the review flagged: checkAndFixStuckNonce
        // runs before a write can fail (gas-cap rejection, simulation revert),
        // so a failed-before-broadcast attempt must never look "stuck" later.
        // `writeContract` is deliberately made to never succeed here: since a
        // successful broadcast now records its own nonce into
        // outstandingNonces (for precise elapsed-time tracking — see the
        // eviction-survival test above), a write that never reaches that
        // point must never record anything either, no matter how long the
        // chain then sits idle with no gap ever visible.
        service = await makeService("40002");
        const counts: Counts = { latest: 20, pending: 20 }; // no gap: nothing outstanding
        const { cancelSendTransaction, writeContract, estimateContractGas } = stubClients(counts);
        estimateContractGas.mockResolvedValue(999_999_999n); // exceeds the relayer's gas cap every time

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await expect(service.simulateAndWriteRelay(relayPayload("0xn3"))).rejects.toThrow();
        dateSpy.mockReturnValue(now + 700_000); // well past both timeouts, but there was never a gap
        await expect(service.simulateAndWriteRelay(relayPayload("0xn4"))).rejects.toThrow();

        expect(writeContract).not.toHaveBeenCalled();
        expect(cancelSendTransaction).not.toHaveBeenCalled();
        dateSpy.mockRestore();
    });

    it("gap present but under the short threshold: no fix yet", async () => {
        service = await makeService("40003");
        const counts: Counts = { latest: 30, pending: 31 }; // nonce 30 outstanding
        const { cancelSendTransaction, writeContract, getBlock } = stubClients(counts, {
            pendingBlockTransactions: [{ from: SIGNER_ADDRESS, nonce: 30 }],
        });

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xn5")); // seeds the watermark at nonce 30
        dateSpy.mockReturnValue(now + 60_000); // under STUCK_ABSENT_TIMEOUT_MS (120_000)
        await service.simulateAndWriteRelay(relayPayload("0xn6"));

        expect(getBlock).not.toHaveBeenCalled(); // never even escalates to the pending-block read
        expect(cancelSendTransaction).not.toHaveBeenCalled();
        expect(writeContract).toHaveBeenCalledTimes(2);
        dateSpy.mockRestore();
    });

    it("gap present, absent from the pending-block past STUCK_ABSENT_TIMEOUT_MS: cancels the real stuck nonce (latest), not the free one (pending)", async () => {
        service = await makeService("40004");
        const counts: Counts = { latest: 40, pending: 41 }; // nonce 40 outstanding, evicted (absent below)
        const { cancelSendTransaction, writeContract } = stubClients(counts, { pendingBlockTransactions: [] });

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xn7")); // seeds watermark at 40
        dateSpy.mockReturnValue(now + 130_000); // past STUCK_ABSENT_TIMEOUT_MS

        // The triggering write's own broadcast must not happen until the cancel's
        // acceptance has resolved, and must not reuse the cancelled nonce. Wire
        // the check into the SAME cancelSendTransaction mock stubClients already
        // installed (re-overriding createWalletClient here would silently swap in
        // an unrelated mock that this test never observes).
        let cancelResolved = false;
        cancelSendTransaction.mockImplementation(async () => {
            cancelResolved = true;
            return CANCEL_TX_HASH;
        });
        writeContract.mockImplementation(async () => {
            if (!cancelResolved && writeContract.mock.calls.length > 1) {
                throw new Error("write broadcast before the cancel resolved");
            }
            return TX_HASH;
        });

        await service.simulateAndWriteRelay(relayPayload("0xn8"));

        expect(cancelSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 40, value: 0n }));
        expect(writeContract).toHaveBeenCalledTimes(2); // seed (n7) + triggering write (n8)
        const triggeringNonce = (writeContract.mock.calls[1] as unknown as [{ nonce: number }])[0].nonce;
        expect(triggeringNonce).toBeGreaterThan(40);
        expect(mockLogger.turbo).toHaveBeenCalled();
        // Scoped by chain + signer so a stuck nonce on one chain doesn't suppress a page for another.
        expect(mockLogger.turbo.mock.calls[0][1]).toMatchObject({
            dedupKey: `relayer.stuckNonce.40004.${SIGNER_ADDRESS}`,
        });
        dateSpy.mockRestore();
    });

    it("a gap that evicts from the mempool between checks still fires the fix — `pending` catching back up to `latest` must not erase the watermark", async () => {
        // Regression test for the bug found 2026-09-30: the old code treated
        // `pendingCount <= latestConfirmed` as proof nothing was outstanding and
        // unconditionally cleared the watermark on that basis. Once a stuck tx
        // fully evicts from the mempool, `pending` collapses back down to equal
        // `latest` even though the gap is still real (any later-queued nonces
        // sit behind it as non-contiguous "queued" and aren't counted) — so the
        // old code silently forgot the gap existed and the auto-fix never fired.
        // Reproduced live on mainnet: nonces 98-100 sat stuck 8+ hours with zero
        // detection, because every later write attempt saw `pending == latest`
        // and re-cleared the watermark before the timeout could ever fire.
        service = await makeService("40013");
        const counts: Counts = { latest: 140, pending: 141 }; // nonce 140 outstanding, still visible
        const { cancelSendTransaction, writeContract, getBlock } = stubClients(counts, {
            pendingBlockTransactions: [{ from: SIGNER_ADDRESS, nonce: 140 }],
        });

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xn24")); // seeds watermark at 140

        // The stuck tx evicts from the mempool: `pending` drops back to equal
        // `latest` (140) even though nonce 140 never confirmed — `latest` itself
        // is unchanged, which is the only signal that should matter now.
        counts.pending = 140;
        getBlock.mockResolvedValue({ transactions: [] }); // no longer present anywhere
        dateSpy.mockReturnValue(now + 130_000); // past STUCK_ABSENT_TIMEOUT_MS

        await service.simulateAndWriteRelay(relayPayload("0xn25"));

        expect(cancelSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 140, value: 0n }));
        expect(writeContract).toHaveBeenCalledTimes(2);
        dateSpy.mockRestore();
    });

    it("a chain's own successful broadcast is tracked at its real broadcast time, even if the mempool's `pending` count never reflects it at all", async () => {
        // Distinguishes this from the eviction test above: there, a gap was
        // already visible via `pending` before eviction. Here, nothing ever
        // makes it into the mempool's own accounting at all — `pending`
        // stays equal to `latest` from the very first check onward, exactly
        // like the 2026-09-30 incident's evicted transactions looked to
        // every check that happened after they'd already vanished. Only
        // because a successful broadcast now records its own nonce directly
        // (not just nonces the RPC happens to still show as pending) does
        // the fix ever get a chance to fire here.
        service = await makeService("40014");
        const counts: Counts = { latest: 150, pending: 150 }; // healthy: no gap visible, ever
        const { cancelSendTransaction, writeContract } = stubClients(counts, { pendingBlockTransactions: [] });

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xn26")); // broadcasts nonce 150, recorded at `now`

        dateSpy.mockReturnValue(now + 130_000); // past STUCK_ABSENT_TIMEOUT_MS
        await service.simulateAndWriteRelay(relayPayload("0xn27"));

        expect(cancelSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 150, value: 0n }));
        expect(writeContract).toHaveBeenCalledTimes(2); // the tracked write (n26) + the triggering write (n27)
        dateSpy.mockRestore();
    });

    it("a stuck floor keeps its clock while later writes go out at higher nonces", async () => {
        // The clock is per nonce: writes at 161, 162 behind an evicted 160
        // record their own nonces and never restart 160's timer.
        service = await makeService("40015");
        const counts: Counts = { latest: 160, pending: 160 };
        const { cancelSendTransaction, writeContract } = stubClients(counts, { pendingBlockTransactions: [] });

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xn28")); // 160, then evicted
        dateSpy.mockReturnValue(now + 10_000);
        await service.simulateAndWriteRelay(relayPayload("0xn29")); // 161 (local trust window)
        dateSpy.mockReturnValue(now + 20_000);
        await service.simulateAndWriteRelay(relayPayload("0xn30")); // 162
        expect(cancelSendTransaction).not.toHaveBeenCalled();

        dateSpy.mockReturnValue(now + 130_000); // 130s after 160's own broadcast
        await service.simulateAndWriteRelay(relayPayload("0xn31"));

        expect(cancelSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 160, value: 0n }));
        expect(writeContract).toHaveBeenCalledTimes(4);
        dateSpy.mockRestore();
    });

    it("tip floor: the cancel's gas price is lifted to 2 x base + floor before the bump multiplier", async () => {
        service = await makeService("40016");
        process.env.MIN_PRIORITY_FEE_WEI_EVM_40016 = "50000000";
        const counts: Counts = { latest: 170, pending: 171 };
        const { cancelSendTransaction, getBlock } = stubClients(counts);
        // Base fee 1 gwei; eth_gasPrice stub is also 1 gwei, below 2 x base + floor.
        getBlock.mockResolvedValue({ transactions: [], baseFeePerGas: 1_000_000_000n } as never);

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xn32")); // seeds 170
        dateSpy.mockReturnValue(now + 130_000);
        await service.simulateAndWriteRelay(relayPayload("0xn33"));

        expect(cancelSendTransaction).toHaveBeenCalledWith(
            expect.objectContaining({ nonce: 170, gasPrice: (2n * 1_000_000_000n + 50_000_000n) * 2n })
        );
        dateSpy.mockRestore();
        delete process.env.MIN_PRIORITY_FEE_WEI_EVM_40016;
    });

    it("gap present, still visible in the pending-block past STUCK_PRESENT_TIMEOUT_MS: same fix, via the slower path", async () => {
        service = await makeService("40005");
        const counts: Counts = { latest: 50, pending: 51 };
        const { cancelSendTransaction } = stubClients(counts, {
            pendingBlockTransactions: [{ from: SIGNER_ADDRESS, nonce: 50 }], // present
        });

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xn9"));
        dateSpy.mockReturnValue(now + 130_000); // past absent-threshold, under present-threshold
        await service.simulateAndWriteRelay(relayPayload("0xn10"));
        expect(cancelSendTransaction).not.toHaveBeenCalled(); // still present, not patient-timeout yet

        dateSpy.mockReturnValue(now + 700_000); // past STUCK_PRESENT_TIMEOUT_MS (600_000)
        await service.simulateAndWriteRelay(relayPayload("0xn11"));

        expect(cancelSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 50, value: 0n }));
        dateSpy.mockRestore();
    });

    it("a gap that heals on its own resets the clock instead of carrying stale timing into a later, unrelated gap", async () => {
        service = await makeService("40006");
        const counts: Counts = { latest: 60, pending: 61 };
        const { cancelSendTransaction } = stubClients(counts, { pendingBlockTransactions: [] });

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xn12")); // seeds watermark at 60, since=now

        // The gap closes entirely before the timeout would have fired.
        counts.latest = 61;
        counts.pending = 61;
        dateSpy.mockReturnValue(now + 90_000);
        await service.simulateAndWriteRelay(relayPayload("0xn13")); // clears the watermark

        // A brand new, unrelated gap opens. If the old `since` had leaked
        // through, this would already look stale; it must not.
        counts.latest = 70;
        counts.pending = 71;
        dateSpy.mockReturnValue(now + 90_000 + 5_000);
        await service.simulateAndWriteRelay(relayPayload("0xn14")); // seeds a fresh watermark at 70
        dateSpy.mockReturnValue(now + 90_000 + 5_000 + 60_000); // only 60s into the NEW gap
        await service.simulateAndWriteRelay(relayPayload("0xn15"));

        expect(cancelSendTransaction).not.toHaveBeenCalled();
        dateSpy.mockRestore();
    });

    it("best effort: a failed getTransactionCount is logged and swallowed — the write still succeeds", async () => {
        service = await makeService("40007");
        const counts: Counts = { latest: 80, pending: 80 };
        const { writeContract } = stubClients(counts);
        const client = await (service as unknown as { client: () => Promise<{ getTransactionCount: jest.Mock }> }).client();
        client.getTransactionCount.mockRejectedValue(new Error("RPC unavailable"));

        await expect(service.simulateAndWriteRelay(relayPayload("0xn16"))).resolves.toBe(TX_HASH);
        expect(writeContract).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Stuck-nonce check skipped"));
    });

    it("best effort: a failed pending-block read (getBlock) is logged and swallowed — the write still succeeds", async () => {
        service = await makeService("40008");
        const counts: Counts = { latest: 90, pending: 91 };
        const { writeContract } = stubClients(counts);
        const client = await (
            service as unknown as { client: () => Promise<{ getBlock: jest.Mock }> }
        ).client();
        client.getBlock.mockRejectedValue(new Error("RPC unavailable"));

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xn17")); // seeds watermark
        dateSpy.mockReturnValue(now + 130_000); // escalates to the (failing) getBlock read

        await expect(service.simulateAndWriteRelay(relayPayload("0xn18"))).resolves.toBe(TX_HASH);
        expect(writeContract).toHaveBeenCalledTimes(2);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Stuck-nonce check skipped"));
        dateSpy.mockRestore();
    });

    it("concurrent same-chain requests: the in-flight guard prevents a second simultaneous cancel, but both writes still proceed", async () => {
        service = await makeService("40009");
        const counts: Counts = { latest: 100, pending: 101 };

        let resolveCancel!: (hash: typeof CANCEL_TX_HASH) => void;
        const cancelSendTransaction = jest.fn(
            () => new Promise<typeof CANCEL_TX_HASH>((resolve) => (resolveCancel = resolve))
        );
        (createWalletClient as jest.Mock).mockReturnValue({ sendTransaction: cancelSendTransaction });

        const getTransactionCount = jest.fn(async ({ blockTag }: { blockTag: "latest" | "pending" }) =>
            blockTag === "latest" ? counts.latest : counts.pending
        );
        const simulateContract = jest.fn(async () => ({ request: {} }));
        const estimateContractGas = jest.fn(async () => 500_000n);
        const writeContract = jest.fn(async () => TX_HASH);
        const getBlock = jest.fn(async () => ({ transactions: [] })); // absent -> stale
        jest.spyOn(service as unknown as { client: () => Promise<unknown> }, "client").mockResolvedValue({
            simulateContract,
            estimateContractGas,
            getTransactionCount,
            getBlock,
            getGasPrice: jest.fn(async () => 1_000_000_000n),
            getTransaction: jest.fn(async () => ({ nonce: 100 })),
        });
        jest.spyOn(service as unknown as { signer: () => Promise<unknown> }, "signer").mockResolvedValue({
            account: { address: SIGNER_ADDRESS },
            writeContract,
        });

        const dateSpy = jest.spyOn(Date, "now");
        const now = Date.now();
        dateSpy.mockReturnValue(now);
        await service.simulateAndWriteRelay(relayPayload("0xn19")); // seeds watermark at 100
        dateSpy.mockReturnValue(now + 130_000);

        const first = service.simulateAndWriteRelay(relayPayload("0xn20"));
        const second = service.simulateAndWriteRelay(relayPayload("0xn21"));
        // Flush every pending microtask so both requests reach as far as they can
        // without the cancel resolving: the first takes the per-signer lock and
        // suspends on the cancel broadcast; the second waits on that lock, then
        // sees the freshly re-recorded nonce 100 (elapsed zero) and does not
        // cancel again.
        await new Promise((resolve) => setTimeout(resolve, 0));
        resolveCancel(CANCEL_TX_HASH);
        await Promise.all([first, second]);

        // Only one cancel was ever attempted; every write still went through —
        // the seed (n19) plus both concurrent requests (n20, n21) — 3 total.
        expect(cancelSendTransaction).toHaveBeenCalledTimes(1);
        expect(writeContract).toHaveBeenCalledTimes(3);
        dateSpy.mockRestore();
    });

    it("#239 log line: writeWithGasCap logs nonce/txHash/signer/chainId without ever awaiting the lookup", async () => {
        service = await makeService("40010");
        const counts: Counts = { latest: 110, pending: 110 };
        stubClients(counts);

        await service.simulateAndWriteRelay(relayPayload("0xn22"));
        // The write already resolved above; the fire-and-forget log lookup runs
        // on a later macrotask — flush it before asserting.
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockLogger.log).toHaveBeenCalledWith(
            expect.stringContaining("Broadcast nonce reservation"),
            expect.objectContaining({ nonce: 110, txHash: TX_HASH, signer: SIGNER_ADDRESS, chainId: "40010" })
        );
    });

    it("#239 log line: a failed nonce lookup degrades to a warn without affecting the returned hash", async () => {
        service = await makeService("40011");
        const counts: Counts = { latest: 120, pending: 120 };
        const { writeContract } = stubClients(counts);
        const client = await (
            service as unknown as { client: () => Promise<{ getTransaction: jest.Mock }> }
        ).client();
        client.getTransaction.mockRejectedValue(new Error("not found"));

        await expect(service.simulateAndWriteRelay(relayPayload("0xn23"))).resolves.toBe(TX_HASH);
        expect(writeContract).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setTimeout(resolve, 1_100)); // past the retry backoff (0/250/750ms)
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Could not resolve the nonce"));
    });

    it("sendRawTransaction: also runs the stuck-nonce check and the #239 log line", async () => {
        service = await makeService("40012");
        const counts: Counts = { latest: 130, pending: 130 };
        const getTransactionCount = jest.fn(async ({ blockTag }: { blockTag: "latest" | "pending" }) =>
            blockTag === "latest" ? counts.latest : counts.pending
        );
        const estimateGas = jest.fn(async () => 100_000n);
        const sendTransaction = jest.fn(async () => TX_HASH);
        const getTransaction = jest.fn(async () => ({ nonce: 130 }));
        jest.spyOn(service as unknown as { client: () => Promise<unknown> }, "client").mockResolvedValue({
            getTransactionCount,
            estimateGas,
            getTransaction,
        });
        jest.spyOn(service as unknown as { signer: () => Promise<unknown> }, "signer").mockResolvedValue({
            account: { address: SIGNER_ADDRESS },
            chain: { id: 40012 },
            sendTransaction,
        });

        const hash = await service.sendRawTransaction({ to: RELAY_CONTRACT, data: "0x", value: 0n });

        expect(hash).toBe(TX_HASH);
        expect(getTransactionCount).toHaveBeenCalledTimes(2); // latest + pending
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(mockLogger.log).toHaveBeenCalledWith(
            expect.stringContaining("Broadcast nonce reservation"),
            expect.objectContaining({ nonce: 130, txHash: TX_HASH, signer: SIGNER_ADDRESS, chainId: "40012" })
        );
    });
});
