import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stellar/freighter-api", () => ({
    requestAccess: vi.fn(),
    getNetworkDetails: vi.fn(),
    signTransaction: vi.fn(),
}));

import * as freighterApi from "@stellar/freighter-api";

import { createFreighterProvider } from "../../../src/internal.js";

describe("createFreighterProvider", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    describe("getAddress", () => {
        it("call requestAccess (not the passive getAddress) and return its address", async () => {
            vi.mocked(freighterApi.requestAccess).mockResolvedValue({ address: "GABC123" });

            const provider = createFreighterProvider();
            await expect(provider.getAddress()).resolves.toBe("GABC123");
            expect(freighterApi.requestAccess).toHaveBeenCalledOnce();
        });

        it("throw with the FreighterApiError message when requestAccess returns an error", async () => {
            vi.mocked(freighterApi.requestAccess).mockResolvedValue({
                address: "",
                error: { code: -4, message: "User declined access" },
            });

            const provider = createFreighterProvider();
            await expect(provider.getAddress()).rejects.toThrow("User declined access");
        });
    });

    describe("getNetworkPassphrase", () => {
        it("return networkPassphrase from getNetworkDetails", async () => {
            vi.mocked(freighterApi.getNetworkDetails).mockResolvedValue({
                network: "TESTNET",
                networkUrl: "https://horizon-testnet.stellar.org",
                networkPassphrase: "Test SDF Network ; September 2015",
            });

            const provider = createFreighterProvider();
            await expect(provider.getNetworkPassphrase()).resolves.toBe(
                "Test SDF Network ; September 2015",
            );
        });

        it("throw with the FreighterApiError message when getNetworkDetails returns an error", async () => {
            vi.mocked(freighterApi.getNetworkDetails).mockResolvedValue({
                network: "",
                networkUrl: "",
                networkPassphrase: "",
                error: { code: -1, message: "Freighter is not installed" },
            });

            const provider = createFreighterProvider();
            await expect(provider.getNetworkPassphrase()).rejects.toThrow(
                "Freighter is not installed",
            );
        });
    });

    describe("signTransaction", () => {
        it("post the passphrase through and return signedTxXdr", async () => {
            vi.mocked(freighterApi.signTransaction).mockResolvedValue({
                signedTxXdr: "AAAA...signed",
                signerAddress: "GABC123",
            });

            const provider = createFreighterProvider();
            const signed = await provider.signTransaction("AAAA...unsigned", {
                networkPassphrase: "Test SDF Network ; September 2015",
            });

            expect(signed).toBe("AAAA...signed");
            expect(freighterApi.signTransaction).toHaveBeenCalledWith("AAAA...unsigned", {
                networkPassphrase: "Test SDF Network ; September 2015",
            });
        });

        it("throw with the FreighterApiError message when signTransaction returns an error", async () => {
            vi.mocked(freighterApi.signTransaction).mockResolvedValue({
                signedTxXdr: "",
                signerAddress: "",
                error: { code: -4, message: "User declined signing" },
            });

            const provider = createFreighterProvider();
            await expect(
                provider.signTransaction("AAAA...unsigned", {
                    networkPassphrase: "Test SDF Network ; September 2015",
                }),
            ).rejects.toThrow("User declined signing");
        });
    });
});
