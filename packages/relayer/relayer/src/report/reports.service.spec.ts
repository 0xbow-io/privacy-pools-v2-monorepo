import { ModuleRef } from "@nestjs/core";
import { mock } from "jest-mock-extended";
import { ReportsService } from "./reports.service";
import { RelayerConfig } from "../config/relayer-config";
import { Chain } from "../config/chain";
import { ChainType } from "../config/enums";
import type { IReportService } from "./report.interface";
import { createMockLoggerProvider } from "../test/mocks";

const publishReportMock = jest.fn().mockResolvedValue(undefined);
jest.mock("./report-publisher", () => ({
    publishReport: (...args: unknown[]) => publishReportMock(...args),
}));

describe("ReportsService", () => {
    const relayerConfig = mock<RelayerConfig>();
    const moduleRef = mock<ModuleRef>();
    let service: ReportsService;

    beforeEach(() => {
        jest.clearAllMocks();
        publishReportMock.mockResolvedValue(undefined);
        (relayerConfig.chain as jest.Mock).mockImplementation((chainType: ChainType) => {
            if (chainType === ChainType.EVM) return new Chain(chainType, [{ id: 1 }, { id: 56 }] as never);
            if (chainType === ChainType.STELLAR) return new Chain(chainType, [{ id: 0 }] as never);
            return new Chain(chainType as never, [] as never);
        });
        const { log, error } = createMockLoggerProvider().useValue;
        service = new ReportsService({ log, error } as never, relayerConfig, moduleRef);
    });

    function evmReportService(overrides: Partial<IReportService> = {}): IReportService {
        return {
            nativeAssetBalance: jest.fn().mockResolvedValue({ chainId: 1, chainName: "ethereum", amount: "1.0", symbol: "ETH" }),
            profitMargin: jest.fn().mockResolvedValue({ chainId: 1, chainName: "ethereum", summary: "ethereum: ok" }),
            ...overrides,
        };
    }

    it("rejects any command carrying arguments without touching any chain", async () => {
        await service.handle("native_asset_balances", ["5"]);

        expect(moduleRef.resolve).not.toHaveBeenCalled();
        expect(publishReportMock).toHaveBeenCalledWith(
            expect.objectContaining({ command: "native_asset_balances", status: "error", text: expect.stringContaining("supported yet") }),
        );
    });

    it("fans a command out across every configured chain and publishes a combined ok report", async () => {
        moduleRef.resolve
            .mockResolvedValueOnce(evmReportService({ nativeAssetBalance: jest.fn().mockResolvedValue({ chainId: 1, chainName: "ethereum", amount: "1.0", symbol: "ETH" }) }))
            .mockResolvedValueOnce(evmReportService({ nativeAssetBalance: jest.fn().mockResolvedValue({ chainId: 56, chainName: "bsc", amount: "2.0", symbol: "BNB" }) }))
            .mockResolvedValueOnce(evmReportService({ nativeAssetBalance: jest.fn().mockResolvedValue({ chainId: 0, chainName: "stellar", amount: "3.0", symbol: "XLM" }) }));

        await service.handle("native_asset_balances", []);

        expect(moduleRef.resolve).toHaveBeenCalledTimes(3);
        const published = publishReportMock.mock.calls[0][0];
        expect(published.command).toBe("native_asset_balances");
        expect(published.status).toBe("ok");
        expect(published.text).toContain("ethereum (1): 1.0 ETH");
        expect(published.text).toContain("bsc (56): 2.0 BNB");
        expect(published.text).toContain("stellar (0): 3.0 XLM");
    });

    it("keeps going when one chain fails, and reports overall status error", async () => {
        moduleRef.resolve
            .mockResolvedValueOnce(evmReportService({ nativeAssetBalance: jest.fn().mockRejectedValue(new Error("rpc down")) }))
            .mockResolvedValueOnce(evmReportService({ nativeAssetBalance: jest.fn().mockResolvedValue({ chainId: 56, chainName: "bsc", amount: "2.0", symbol: "BNB" }) }))
            .mockResolvedValueOnce(evmReportService({ nativeAssetBalance: jest.fn().mockResolvedValue({ chainId: 0, chainName: "stellar", amount: "3.0", symbol: "XLM" }) }));

        await service.handle("native_asset_balances", []);

        const published = publishReportMock.mock.calls[0][0];
        expect(published.status).toBe("error");
        expect(published.text).toContain("rpc down");
        expect(published.text).toContain("bsc (56): 2.0 BNB");
    });

    it("renders a NotImplementedException from one chain as that chain's line, not a crash", async () => {
        moduleRef.resolve
            .mockResolvedValueOnce(evmReportService())
            .mockResolvedValueOnce(evmReportService())
            .mockResolvedValueOnce(
                evmReportService({ profitMargin: jest.fn().mockRejectedValue(new Error("current_profit_margins is not yet supported on Stellar")) }),
            );

        await service.handle("current_profit_margins", []);

        const published = publishReportMock.mock.calls[0][0];
        expect(published.text).toContain("not yet supported on Stellar");
    });

    it("never throws even if every chain resolution fails", async () => {
        moduleRef.resolve.mockRejectedValue(new Error("no RPC configured"));

        await expect(service.handle("native_asset_balances", [])).resolves.toBeUndefined();
        expect(publishReportMock).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
    });
});
