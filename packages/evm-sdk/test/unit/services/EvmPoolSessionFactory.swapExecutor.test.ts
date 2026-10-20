import { describe, expect, it, vi } from "vitest";

import type { Address, EvmPoolSessionConfig, IRPCInteractor } from "../../../src/internal.js";
import { createEvmPoolSession, LIFI_SWAP_EXECUTORS } from "../../../src/internal.js";

/**
 * Verifies which swap executor the factory hands the swap-and-deposit and reshield sessions: the
 * configured `swapExecutor` when set, else the chain's `LIFI_SWAP_EXECUTORS` entry. Same cast-mock approach as
 * EvmPoolSessionFactory.yield.test.ts — the factory only constructs the session. The executor is
 * read off the constructed delegate, since using it needs a full native swap-and-deposit.
 */

const rpcInteractor = {
    readContract: vi.fn(),
    getLogsPaginated: vi.fn(),
    getBlockNumber: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
} as unknown as IRPCInteractor;

const CUSTOM_EXECUTOR = {
    executor: "0x1111111111111111111111111111111111111111" as Address,
    erc20Proxy: "0x2222222222222222222222222222222222222222" as Address,
};

function config(chainId: number, overrides: Partial<EvmPoolSessionConfig> = {}): EvmPoolSessionConfig {
    const stub = {} as never;
    return {
        ownerAddress: "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392",
        chainId,
        cryptoService: stub,
        witnessPreparationService: stub,
        proofService: stub,
        entrypointInteractor: stub,
        noteManager: stub,
        keystoreManager: stub,
        keystoreInteractor: stub,
        hashService: stub,
        merkleService: stub,
        poolVaultInteractor: { getAddress: () => "0x09b94d3127019298757A6ceeB7911922085f7C01" },
        aspClient: stub,
        relayerInteractor: stub,
        aspDataProvider: stub,
        rpcInteractor,
        noteComputationService: stub,
        noteDiscoveryService: stub,
        paymentRequestService: stub,
        swapAndDepositQuoteProvider: stub,
        relaySwapsAddress: "0x3333333333333333333333333333333333333333",
        ...overrides,
    } as unknown as EvmPoolSessionConfig;
}

/** The executor each executor-composing session was built with; the two must always agree. */
function swapExecutorOf(session: unknown): unknown {
    const { delegates } = session as {
        delegates: { swapDeposit?: { swapExecutor?: unknown }; reshield?: { swapExecutor?: unknown } };
    };
    expect(delegates.swapDeposit).toBeDefined();
    expect(delegates.reshield).toBeDefined();
    expect(delegates.reshield?.swapExecutor).toEqual(delegates.swapDeposit?.swapExecutor);
    return delegates.swapDeposit?.swapExecutor;
}

describe("PoolSessionFactory swap executor wiring", () => {
    it("use the configured swapExecutor on a chain LIFI_SWAP_EXECUTORS does not list", () => {
        expect(LIFI_SWAP_EXECUTORS[11155111]).toBeUndefined();

        const session = createEvmPoolSession(config(11155111, { swapExecutor: CUSTOM_EXECUTOR }));

        expect(swapExecutorOf(session)).toEqual(CUSTOM_EXECUTOR);
    });

    it("prefer the configured swapExecutor over the chain's LiFi Executor", () => {
        const session = createEvmPoolSession(config(1, { swapExecutor: CUSTOM_EXECUTOR }));

        expect(swapExecutorOf(session)).toEqual(CUSTOM_EXECUTOR);
    });

    it("fall back to the chain's LiFi Executor when none is configured", () => {
        const session = createEvmPoolSession(config(1));

        expect(swapExecutorOf(session)).toEqual(LIFI_SWAP_EXECUTORS[1]);
    });

    it("leave the executor unset on an unlisted chain when none is configured", () => {
        const session = createEvmPoolSession(config(11155111));

        expect(swapExecutorOf(session)).toBeUndefined();
    });
});
