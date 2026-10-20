import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { EVMChainService } from "./evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import { Bytes, EvmRelaySDKPayload, EvmRelaySwapPayload, ReshapedProof } from "../relay/evm/types";
import {
    RELAY_GAS_BUDGET,
    relayBatchGasBudget,
    relayGasBudget,
    relayGasCap,
    relayGasLimit,
    relaySwapGasBudget,
} from "../quote/evm/relay_gas_budget";

// Coverage for the broadcast gas cap (minr #4): PrivacyPoolRelay pays native recipients
// with safeTransferETH (all remaining gas forwarded), so a recipient whose receive()
// spins until gas runs out makes eth_estimateGas return ~the block limit. The relayer
// priced the relay at RELAY_GAS_BUDGET.relay and charged a fixed fee, so it must refuse
// to sign anything estimated above `budget × relay_gas_cap_multiplier` (400, nothing
// sent) and must send everything else with the estimate as its gas limit — never the cap
// itself, since the estimator binary-searches the minimum gas that succeeds and a "burn
// whatever you get" recipient would otherwise be handed the whole cap. viem clients are
// stubbed via the private client()/signer() accessors (same pattern as the processor
// spec). Addresses/chainId are distinct from the other chain-service specs — the
// module-level caches are not reset between tests.

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RELAY_CONTRACT = "0x00000000000000000000000000000000000313A1" as const;
const POOL_VAULT = "0x00000000000000000000000000000000000313A2" as const;
const RELAY_SWAPS = "0x00000000000000000000000000000000000313A3" as const;
const PP_ROUTER = "0x00000000000000000000000000000000000313A4" as const;
const ZAP = "0x00000000000000000000000000000000000313A5" as const;
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc";
const MULTIPLIER = 3n;

const minimalProof = {
    pA: [0n, 0n],
    pB: [
        [0n, 0n],
        [0n, 0n],
    ],
    pC: [0n, 0n],
    pubSignals: [[], [], [0n], [0n], [0n], [1n], [0n], [0n]],
    parsedPubSignals: { nullifierHashes: ["0xgascap01"] },
} as unknown as ReshapedProof;

function relayPayload(extra: Partial<EvmRelaySDKPayload> = {}): EvmRelaySDKPayload {
    return { proof: minimalProof, noteData: [], data: "0x00", ...extra } as unknown as EvmRelaySDKPayload;
}

function swapPayload(extra: Partial<EvmRelaySwapPayload> = {}): EvmRelaySwapPayload {
    return { ...relayPayload(), nativeGas: 0n, ...extra } as EvmRelaySwapPayload;
}

describe("relay_gas_budget (pure)", () => {
    it("adds the unwrap surcharge to a yield-share swap, on top of B2", () => {
        expect(relaySwapGasBudget(false, true)).toBe(RELAY_GAS_BUDGET.relaySwap + RELAY_GAS_BUDGET.yieldUnwrapSurcharge);
        expect(relaySwapGasBudget(true, true)).toBe(
            RELAY_GAS_BUDGET.relaySwap + RELAY_GAS_BUDGET.b2GasSwapSurcharge + RELAY_GAS_BUDGET.yieldUnwrapSurcharge
        );
    });

    it("prices a yield-share withdrawal at the PPRouter budget", () => {
        expect(relayGasBudget(true)).toBe(RELAY_GAS_BUDGET.yieldRelay);
        expect(relayGasBudget(false)).toBe(RELAY_GAS_BUDGET.relay);
    });

    it("scales the batch budget with the item count and never below one item", () => {
        expect(relayBatchGasBudget(3)).toBe(RELAY_GAS_BUDGET.relayBatchItem * 3n);
        expect(relayBatchGasBudget(0)).toBe(RELAY_GAS_BUDGET.relayBatchItem);
    });

    it("adds the B2 surcharge to the swap budget only when the gas swap is active", () => {
        expect(relaySwapGasBudget(false)).toBe(RELAY_GAS_BUDGET.relaySwap);
        expect(relaySwapGasBudget(true)).toBe(RELAY_GAS_BUDGET.relaySwap + RELAY_GAS_BUDGET.b2GasSwapSurcharge);
    });

    it("computes the cap as budget × multiplier and refuses a multiplier that would disable it", () => {
        expect(relayGasCap(RELAY_GAS_BUDGET.relay, 3n)).toBe(RELAY_GAS_BUDGET.relay * 3n);
        expect(() => relayGasCap(RELAY_GAS_BUDGET.relay, 0n)).toThrow(/must be >= 1/);
    });
});

describe("EVM chain service — broadcast gas cap", () => {
    let service: EVMChainService;
    const loggerProvider = createMockLoggerProvider();
    const mockLogger = loggerProvider.useValue as { error: jest.Mock };

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(MULTIPLIER),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil-gascap" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8551"),
        relayContractAddress: jest.fn().mockReturnValue(RELAY_CONTRACT),
        poolVaultContractAddress: jest.fn().mockReturnValue(POOL_VAULT),
        relaySwapsContractAddress: jest.fn().mockReturnValue(RELAY_SWAPS),
        chainId: jest.fn().mockReturnValue("31341"),
    };

    function stubClients(estimate: bigint) {
        const simulateContract = jest.fn(async () => ({ request: { some: "request" } }));
        const estimateContractGas = jest.fn(async () => estimate);
        const estimateGas = jest.fn(async () => estimate);
        const writeContract = jest.fn(async () => TX_HASH);
        const sendTransaction = jest.fn(async () => TX_HASH);
        jest.spyOn(service as unknown as { client: () => Promise<unknown> }, "client").mockResolvedValue({
            simulateContract,
            estimateContractGas,
            estimateGas,
            // Stuck-nonce check (checkAndFixStuckNonce, top of writeWithGasCap/
            // sendRawTransaction) reads this first; a constant value takes its
            // "healthy, nothing to do" fast path every call in this suite.
            getTransactionCount: jest.fn(async () => 0),
        });
        jest.spyOn(service as unknown as { signer: () => Promise<unknown> }, "signer").mockResolvedValue({
            account: { address: "0x0000000000000000000000000000000000000002" },
            chain: { id: 31341 },
            writeContract,
            sendTransaction,
        });
        return { simulateContract, estimateContractGas, estimateGas, writeContract, sendTransaction };
    }

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EVMChainService,
                { provide: EvmConfigService, useValue: mockConfigService },
                loggerProvider,
                { provide: CHAIN_CONTEXT, useValue: { chainType: ChainType.EVM, chainId: "31341" } },
            ],
        }).compile();
        service = await module.resolve<EVMChainService>(EVMChainService);
        jest.clearAllMocks();
        mockConfigService.relayGasCapMultiplier.mockReturnValue(MULTIPLIER);
    });

    const RELAY_CAP = RELAY_GAS_BUDGET.relay * MULTIPLIER;

    it("relay: sends with the estimate + 5% headroom (not the cap) as the gas limit when the estimate fits", async () => {
        const { estimateContractGas, writeContract } = stubClients(600_000n);
        await expect(service.simulateAndWriteRelay(relayPayload())).resolves.toBe(TX_HASH);
        expect(estimateContractGas).toHaveBeenCalledTimes(1);
        expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ some: "request", gas: 630_000n }));
    });

    it("relay: refuses (400, nothing signed) when the estimate exceeds the cap — hostile receive()", async () => {
        const { writeContract } = stubClients(30_000_000n);
        await expect(service.simulateAndWriteRelay(relayPayload())).rejects.toThrow(BadRequestException);
        expect(writeContract).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("exceeds the relayer's cap"));
    });

    it("relay: keeps its own verdict text instead of the generic failWrite wrapping", async () => {
        stubClients(RELAY_CAP + 1n);
        await expect(service.simulateAndWriteRelay(relayPayload())).rejects.toThrow(
            new RegExp(`^Relay rejected: estimated gas ${RELAY_CAP + 1n} exceeds the relayer's cap of ${RELAY_CAP}`)
        );
    });

    it("relay: an estimate exactly at the cap is still relayed, with the cap as its limit", async () => {
        const { writeContract } = stubClients(RELAY_CAP);
        await expect(service.simulateAndWriteRelay(relayPayload())).resolves.toBe(TX_HASH);
        expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ some: "request", gas: RELAY_CAP }));
    });

    it("relay: the 5% headroom never lifts the gas limit above the cap", async () => {
        // 2026-10-01: the bare estimate ran 7 mainnet relays out of gas (~0.8% short at inclusion).
        const { writeContract } = stubClients(RELAY_CAP - 1_000n);
        await expect(service.simulateAndWriteRelay(relayPayload())).resolves.toBe(TX_HASH);
        expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ some: "request", gas: RELAY_CAP }));
    });

    it("relay: the multiplier comes from the chain config", async () => {
        mockConfigService.relayGasCapMultiplier.mockReturnValue(1n);
        const { writeContract } = stubClients(RELAY_GAS_BUDGET.relay + 1n);
        await expect(service.simulateAndWriteRelay(relayPayload())).rejects.toThrow(new RegExp(`cap of ${RELAY_GAS_BUDGET.relay}\\b`));
        expect(writeContract).not.toHaveBeenCalled();
    });

    it("PPRouter withdrawToUnderlying: capped at the yield-withdraw budget", async () => {
        const ok = stubClients(700_000n);
        await service.simulateAndWriteRelay(relayPayload({ processorAddress: PP_ROUTER, minUnderlyingOut: 1n }));
        expect(ok.writeContract).toHaveBeenCalledWith(expect.objectContaining({ some: "request", gas: 735_000n }));
        const hostile = stubClients(RELAY_GAS_BUDGET.yieldRelay * MULTIPLIER + 1n);
        await expect(
            service.simulateAndWriteRelay(relayPayload({ processorAddress: PP_ROUTER, minUnderlyingOut: 1n }))
        ).rejects.toThrow(/PPRouter withdrawToUnderlying rejected/);
        expect(hostile.writeContract).not.toHaveBeenCalled();
    });

    it("registerAndRelay / relayAndAnnounce: relay budget", async () => {
        const { writeContract } = stubClients(RELAY_CAP);
        await service.simulateAndWriteRegisterAndRelay(
            relayPayload({
                registration: {
                    account: PP_ROUTER,
                    authDigest: "0x1",
                    nullifyingKeyHash: "0x2",
                    deadline: "0x3",
                    signature: "0x",
                },
            } as never)
        );
        await service.simulateAndWriteRelayAndAnnounce(
            relayPayload({
                announcement: { schemeId: "0x1", stealthAddress: PP_ROUTER, ephemeralPubKey: "0x", metadata: "0x" },
            } as never)
        );
        expect(writeContract).toHaveBeenCalledTimes(2);
        for (const call of writeContract.mock.calls) {
            expect(call[0]).toEqual(expect.objectContaining({ some: "request", gas: RELAY_CAP }));
        }
    });

    it("shielded transfer (PoolVault.transact): its own smaller budget", async () => {
        const ok = stubClients(400_000n);
        await service.simulateAndWriteRelayTransfer(relayPayload());
        expect(ok.writeContract).toHaveBeenCalledWith(expect.objectContaining({ some: "request", gas: 420_000n }));
        const hostile = stubClients(RELAY_GAS_BUDGET.shieldedTransfer * MULTIPLIER + 1n);
        await expect(service.simulateAndWriteRelayTransfer(relayPayload())).rejects.toThrow(
            /PoolVault transact rejected/
        );
        expect(hostile.writeContract).not.toHaveBeenCalled();
    });

    it("RelaySwaps execute: swap budget, plus the B2 surcharge only when the gas swap is active", async () => {
        // Just above the plain swap cap: refused without B2, accepted with the surcharge.
        const estimate = RELAY_GAS_BUDGET.relaySwap * MULTIPLIER + 1n;
        const plain = stubClients(estimate);
        await expect(service.simulateAndWriteRelaySwap(swapPayload())).rejects.toThrow(/RelaySwaps execute rejected/);
        expect(plain.writeContract).not.toHaveBeenCalled();
        const b2 = stubClients(estimate);
        await service.simulateAndWriteRelaySwap(swapPayload({ b2GasSwap: true }));
        expect(b2.writeContract).toHaveBeenCalledWith(
            expect.objectContaining({
                some: "request",
                gas: relayGasLimit(estimate, relayGasCap(relaySwapGasBudget(true), MULTIPLIER)),
            })
        );
    });

    it("RelaySwaps executeUnwrapped (yield share): capped the same way", async () => {
        const { simulateContract, writeContract } = stubClients(1_000_000n);
        await service.simulateAndWriteRelaySwap(swapPayload({ zap: ZAP }));
        expect((simulateContract.mock.calls[0] as unknown as [{ functionName: string }])[0].functionName).toBe(
            "executeUnwrapped"
        );
        expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ some: "request", gas: 1_050_000n }));
    });

    it("RelaySwaps: refuses an over-cap estimate on the swap path too", async () => {
        const { writeContract } = stubClients(RELAY_GAS_BUDGET.relaySwap * MULTIPLIER + 1n);
        await expect(service.simulateAndWriteRelaySwap(swapPayload())).rejects.toThrow(/RelaySwaps execute rejected/);
        expect(writeContract).not.toHaveBeenCalled();
    });

    it("sendRawTransaction: estimates, caps at the swap budget, and refuses over-cap", async () => {
        const params = { to: PP_ROUTER, data: "0x" as const, value: 0n };
        const ok = stubClients(500_000n);
        await expect(service.sendRawTransaction(params)).resolves.toBe(TX_HASH);
        expect(ok.estimateGas).toHaveBeenCalledTimes(1);
        expect(ok.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: PP_ROUTER, gas: 525_000n }));

        const hostile = stubClients(30_000_000n);
        await expect(service.sendRawTransaction(params)).rejects.toThrow(/sendRawTransaction rejected/);
        expect(hostile.sendTransaction).not.toHaveBeenCalled();
    });
});
