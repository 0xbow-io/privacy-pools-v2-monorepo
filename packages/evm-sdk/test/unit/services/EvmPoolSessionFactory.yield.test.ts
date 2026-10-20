import { describe, expect, it, vi } from "vitest";

import type { Address, EvmPoolSessionConfig, IRPCInteractor } from "../../../src/internal.js";
import { createEvmPoolSession, LOCAL_FORK_YIELD_DEPLOYMENT } from "../../../src/internal.js";

/**
 * Verifies the factory wires the optional yield namespace onto PoolSession only when a
 * `yieldDeployment` is supplied AND the base deposit session + transact core it composes are
 * available (i.e. `poolVaultInteractor` and `aspClient` are present).
 *
 * Uses cast mocks: the factory only *constructs* the sessions (storing references), it never calls
 * their methods, so opaque service mocks suffice. Only the yield interactors validate their address,
 * which the real LOCAL_FORK deployment satisfies.
 */

const rpcInteractor = {
    readContract: vi.fn(),
    getLogsPaginated: vi.fn(),
    getBlockNumber: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
} as unknown as IRPCInteractor;

const poolVaultInteractor = {
    getAddress: () => "0x09b94d3127019298757A6ceeB7911922085f7C01",
} as never;

function baseConfig(overrides: Partial<EvmPoolSessionConfig> = {}): EvmPoolSessionConfig {
    const stub = {} as never;
    return {
        ownerAddress: "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392",
        chainId: 11155111,
        cryptoService: stub,
        witnessPreparationService: stub,
        proofService: stub,
        entrypointInteractor: stub,
        noteManager: stub,
        keystoreManager: stub,
        keystoreInteractor: stub,
        hashService: stub,
        merkleService: stub,
        poolVaultInteractor,
        aspClient: stub,
        relayerInteractor: stub,
        aspDataProvider: stub,
        rpcInteractor,
        noteComputationService: stub,
        // Provide these so the factory does not construct real ones.
        noteDiscoveryService: stub,
        paymentRequestService: stub,
        ...overrides,
    } as unknown as EvmPoolSessionConfig;
}

describe("PoolSessionFactory yield wiring", () => {
    it("exposes session.yield when a yieldDeployment and the base deps are present", () => {
        const session = createEvmPoolSession(
            baseConfig({ yieldDeployment: LOCAL_FORK_YIELD_DEPLOYMENT }),
        );
        expect(session.yield).toBeDefined();
        expect(session.yield?.deposit).toBeDefined();
        expect(session.yield?.withdraw).toBeDefined();
        expect(session.yield?.token.getAddress()).toBe(LOCAL_FORK_YIELD_DEPLOYMENT.ppUSDC);
        expect(session.yield?.router.getAddress()).toBe(LOCAL_FORK_YIELD_DEPLOYMENT.ppRouter);
    });

    it("leaves session.yield undefined when no yieldDeployment is configured", () => {
        const session = createEvmPoolSession(baseConfig());
        expect(session.yield).toBeUndefined();
    });

    it("leaves session.yield undefined when poolVaultInteractor is absent (no deposit/transact core)", () => {
        const session = createEvmPoolSession(
            baseConfig({
                yieldDeployment: LOCAL_FORK_YIELD_DEPLOYMENT,
                poolVaultInteractor: undefined,
            }),
        );
        expect(session.yield).toBeUndefined();
    });

    it("leaves session.yield undefined when aspClient is absent (no transact core)", () => {
        const session = createEvmPoolSession(
            baseConfig({
                yieldDeployment: LOCAL_FORK_YIELD_DEPLOYMENT,
                aspClient: undefined,
            }),
        );
        expect(session.yield).toBeUndefined();
    });
});

describe("PoolSessionFactory yield wiring: several deployments on one chain", () => {
    const second = {
        ...LOCAL_FORK_YIELD_DEPLOYMENT,
        ppUSDC: "0xA4cF419558Ef36CC6FfB666195684dC963910426",
        underlying: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        underlyingSymbol: "USDT",
    } as typeof LOCAL_FORK_YIELD_DEPLOYMENT;

    it("builds one namespace per deployment; session.yield is the first; yieldFor selects by share or underlying", () => {
        const session = createEvmPoolSession(
            baseConfig({ yieldDeployments: [LOCAL_FORK_YIELD_DEPLOYMENT, second] }),
        );
        expect(session.yields).toHaveLength(2);
        expect(session.yield).toBe(session.yields[0]);
        expect(session.yields[0]?.deployment).toBe(LOCAL_FORK_YIELD_DEPLOYMENT);
        expect(session.yields[1]?.deployment).toBe(second);
        expect(session.yields[1]?.token.getAddress()).toBe(second.ppUSDC);
        expect(session.yieldFor(second.ppUSDC.toLowerCase() as Address)?.deployment).toBe(second);
        expect(
            session.yieldFor(second.underlying.toUpperCase().replace("0X", "0x") as Address)
                ?.deployment,
        ).toBe(second);
        expect(session.yieldFor(LOCAL_FORK_YIELD_DEPLOYMENT.underlying)?.deployment).toBe(
            LOCAL_FORK_YIELD_DEPLOYMENT,
        );
        expect(session.yieldFor("0x0000000000000000000000000000000000000001")).toBeUndefined();
    });

    it("the single yieldDeployment stays supported and comes first, before yieldDeployments", () => {
        const session = createEvmPoolSession(
            baseConfig({
                yieldDeployment: LOCAL_FORK_YIELD_DEPLOYMENT,
                yieldDeployments: [second],
            }),
        );
        expect(session.yields.map((y) => y.deployment)).toEqual([
            LOCAL_FORK_YIELD_DEPLOYMENT,
            second,
        ]);
        expect(session.yield?.deployment).toBe(LOCAL_FORK_YIELD_DEPLOYMENT);
    });

    it("a legacy single-deployment session exposes yields of length 1 with its deployment", () => {
        const session = createEvmPoolSession(
            baseConfig({ yieldDeployment: LOCAL_FORK_YIELD_DEPLOYMENT }),
        );
        expect(session.yields).toHaveLength(1);
        expect(session.yield?.deployment).toBe(LOCAL_FORK_YIELD_DEPLOYMENT);
    });

    it("no yield configured: yields is empty and yieldFor answers undefined", () => {
        const session = createEvmPoolSession(baseConfig());
        expect(session.yields).toEqual([]);
        expect(session.yieldFor(LOCAL_FORK_YIELD_DEPLOYMENT.ppUSDC)).toBeUndefined();
    });

    it("the same share token twice is a configuration error", () => {
        expect(() =>
            createEvmPoolSession(
                baseConfig({
                    yieldDeployments: [
                        LOCAL_FORK_YIELD_DEPLOYMENT,
                        {
                            ...LOCAL_FORK_YIELD_DEPLOYMENT,
                            ppUSDC: LOCAL_FORK_YIELD_DEPLOYMENT.ppUSDC
                                .toUpperCase()
                                .replace("0X", "0x") as never,
                        },
                    ],
                }),
            ),
        ).toThrow(/configured twice/);
    });
});

describe("PoolSessionFactory yield wiring: earned", () => {
    it("exposes an earned session per deployment, bound to that deployment's share interactor", () => {
        const second = {
            ...LOCAL_FORK_YIELD_DEPLOYMENT,
            ppUSDC: "0xA4cF419558Ef36CC6FfB666195684dC963910426",
            underlying: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            underlyingSymbol: "USDT",
        } as typeof LOCAL_FORK_YIELD_DEPLOYMENT;
        const session = createEvmPoolSession(
            baseConfig({ yieldDeployments: [LOCAL_FORK_YIELD_DEPLOYMENT, second] }),
        );
        expect(session.yields.map((y) => typeof y.earned.compute)).toEqual([
            "function",
            "function",
        ]);
        expect(session.yields[0]!.earned).not.toBe(session.yields[1]!.earned);
        expect(session.yieldFor(second.ppUSDC)?.earned).toBe(session.yields[1]!.earned);
    });
});
