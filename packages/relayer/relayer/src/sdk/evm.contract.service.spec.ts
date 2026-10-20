import { Test } from "@nestjs/testing";
import { mock } from "jest-mock-extended";
import { EvmContractService } from "./evm.contract.service";
import { EVMChainService } from "../chain.service/evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../test/mocks";

// The asset-config cache in evm.contract.service.ts is module-level and NOT
// reset between tests (same convention as the caches in evm.chain.service.ts)
// — every test uses distinct asset addresses for isolation.
describe("EvmContractService.getAssetConfig", () => {
    const ENTRYPOINT = "0x1111111111111111111111111111111111111111";

    const onChainConfig = {
        vettingFeeBPS: 10n,
        minAmount: 1n,
        maxRelayFee: 12345n,
    };

    async function makeService(chainId: number) {
        const chainService = mock<EVMChainService>();
        chainService.readContract.mockResolvedValue(onChainConfig as never);
        const configService = mock<EvmConfigService>();
        configService.entrypointContractAddress.mockReturnValue(ENTRYPOINT as never);
        configService.chainId.mockReturnValue(chainId);

        const module = await Test.createTestingModule({
            providers: [
                EvmContractService,
                { provide: EVMChainService, useValue: chainService },
                { provide: EvmConfigService, useValue: configService },
                createMockLoggerProvider(),
            ],
        }).compile();

        const service = await module.resolve<EvmContractService>(EvmContractService);
        return { service, chainService };
    }

    afterEach(() => {
        jest.useRealTimers();
    });

    it("reads the chain once and serves repeat calls from the cache", async () => {
        const asset = "0xaaa0000000000000000000000000000000000001";
        const { service, chainService } = await makeService(11155111);

        const first = await service.getAssetConfig(asset);
        const second = await service.getAssetConfig(asset);

        expect(first.maxRelayFee).toBe(12345n);
        expect(second).toEqual(first);
        expect(chainService.readContract).toHaveBeenCalledTimes(1);
    });

    it("caches per asset — a different asset triggers its own read", async () => {
        const assetA = "0xaaa0000000000000000000000000000000000002";
        const assetB = "0xaaa0000000000000000000000000000000000003";
        const { service, chainService } = await makeService(11155111);

        await service.getAssetConfig(assetA);
        await service.getAssetConfig(assetB);

        expect(chainService.readContract).toHaveBeenCalledTimes(2);
    });

    it("caches per chain — the same asset on another chainId is a separate entry", async () => {
        const asset = "0xaaa0000000000000000000000000000000000004";
        const chainA = await makeService(11155111);
        const chainB = await makeService(1);

        await chainA.service.getAssetConfig(asset);
        await chainB.service.getAssetConfig(asset);

        expect(chainA.chainService.readContract).toHaveBeenCalledTimes(1);
        expect(chainB.chainService.readContract).toHaveBeenCalledTimes(1);
    });

    it("is case-insensitive on the asset address", async () => {
        const lower = "0xaaa0000000000000000000000000000000000005";
        const upper = "0xAAA0000000000000000000000000000000000005";
        const { service, chainService } = await makeService(11155111);

        await service.getAssetConfig(lower);
        await service.getAssetConfig(upper);

        expect(chainService.readContract).toHaveBeenCalledTimes(1);
    });

    it("re-reads the chain after the TTL expires", async () => {
        jest.useFakeTimers();
        const asset = "0xaaa0000000000000000000000000000000000006";
        const { service, chainService } = await makeService(11155111);

        await service.getAssetConfig(asset);
        jest.advanceTimersByTime(61_000);
        await service.getAssetConfig(asset);

        expect(chainService.readContract).toHaveBeenCalledTimes(2);
    });
});
