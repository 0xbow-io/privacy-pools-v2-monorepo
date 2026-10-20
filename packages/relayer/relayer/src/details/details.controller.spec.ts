import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { mock } from "jest-mock-extended";
import { StrKey } from "@stellar/stellar-sdk";
import { DetailsController } from "./details.controller";
import { DETAILS_SERVICE, type IDetailsService } from "./details.interface";
import { createMockLoggerProvider } from "../test/mocks";

// Real, checksum-valid StrKey — a hand-typed placeholder fails zStellarAddress's StrKey
// validation before the test even reaches the behavior under test.
const STELLAR_ASSET = StrKey.encodeContract(Buffer.alloc(32, 7));

describe("DetailsController", () => {
    let controller: DetailsController;
    const detailsService = mock<IDetailsService>();

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [DetailsController],
            providers: [
                { provide: DETAILS_SERVICE, useValue: detailsService },
                createMockLoggerProvider(),
            ],
        }).compile();

        controller = module.get<DetailsController>(DetailsController);
        jest.clearAllMocks();
    });

    it("delegates all-chains details for an EVM chainType", async () => {
        const fullConfig = { version: "1", chains: [] } as never;
        detailsService.allDetails.mockResolvedValue(fullConfig);

        const result = await controller.getChainTypeDetails("evm");

        expect(detailsService.allDetails).toHaveBeenCalledTimes(1);
        expect(result).toBe(fullConfig);
    });

    it("delegates all-chains details for a Stellar chainType", async () => {
        const fullConfig = { version: "1", chains: [] } as never;
        detailsService.allDetails.mockResolvedValue(fullConfig);

        const result = await controller.getChainTypeDetails("stellar");

        expect(detailsService.allDetails).toHaveBeenCalledTimes(1);
        expect(result).toBe(fullConfig);
    });

    it("rejects an unsupported chainType on the chain-type listing route", async () => {
        await expect(controller.getChainTypeDetails("starknet")).rejects.toThrow(BadRequestException);
        expect(detailsService.allDetails).not.toHaveBeenCalled();
    });

    it("delegates chain details for an EVM chainId", async () => {
        const chainConfig = { id: 1 } as never;
        detailsService.chainDetails.mockResolvedValue(chainConfig);

        const result = await controller.getChainDetails("evm", "1");

        expect(detailsService.chainDetails).toHaveBeenCalledWith(1);
        expect(result).toBe(chainConfig);
    });

    it("rejects a still-unsupported chainType with a clean BadRequestException instead of force-parsing it as EVM", async () => {
        // Regression test: this chainId ("1") is deliberately also a valid EVM chainId
        // shape, so the only thing that can catch an unsupported chainType here is an
        // explicit check — not incidental failure of EVM-shaped parsing. Starknet stays
        // unsupported on the details endpoint (unlike Stellar, which is now real — see below).
        await expect(controller.getChainDetails("starknet", "1")).rejects.toThrow(BadRequestException);
        expect(detailsService.chainDetails).not.toHaveBeenCalled();
    });

    it("rejects a still-unsupported chainType on the asset-details route the same way", async () => {
        await expect(
            controller.getAssetDetails("starknet", "1", "0x0000000000000000000000000000000000000001")
        ).rejects.toThrow(BadRequestException);
        expect(detailsService.assetDetails).not.toHaveBeenCalled();
    });

    it("delegates asset details for an EVM chainId/asset", async () => {
        const assetConfig = { ticker: "USDC" } as never;
        detailsService.assetDetails.mockResolvedValue(assetConfig);

        // zEvmAddress checksums the address (viem's getAddress), so assert on shape
        // rather than a specific mixed-case string.
        const result = await controller.getAssetDetails("evm", "1", "0xabcdef0000000000000000000000000000000001");

        expect(detailsService.assetDetails).toHaveBeenCalledWith(1, expect.stringMatching(/^0x[0-9a-fA-F]{40}$/));
        expect(result).toBe(assetConfig);
    });

    it("delegates chain details for a Stellar chainId", async () => {
        const chainConfig = { id: 1 } as never;
        detailsService.chainDetails.mockResolvedValue(chainConfig);

        const result = await controller.getChainDetails("stellar", "1");

        expect(detailsService.chainDetails).toHaveBeenCalledWith(1);
        expect(result).toBe(chainConfig);
    });

    it("delegates asset details for a Stellar chainId/asset", async () => {
        const assetConfig = { ticker: "USDC" } as never;
        detailsService.assetDetails.mockResolvedValue(assetConfig);

        const result = await controller.getAssetDetails("stellar", "1", STELLAR_ASSET);

        expect(detailsService.assetDetails).toHaveBeenCalledWith(1, STELLAR_ASSET);
        expect(result).toBe(assetConfig);
    });

    it("rejects a malformed Stellar asset address", async () => {
        await expect(controller.getAssetDetails("stellar", "1", "not-a-strkey")).rejects.toThrow();
        expect(detailsService.assetDetails).not.toHaveBeenCalled();
    });
});
