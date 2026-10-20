import { mock } from "jest-mock-extended";
import { createPublicClient, createWalletClient } from "viem";
import { ChainWriteService } from "./chain-write.service";
import { DustRescueConfigService } from "../config/dust-rescue-config.service";

jest.mock("viem", () => {
    const actual = jest.requireActual("viem");
    return { ...actual, createPublicClient: jest.fn(), createWalletClient: jest.fn() };
});
jest.mock("viem/accounts", () => ({
    privateKeyToAccount: jest.fn().mockReturnValue({ address: "0x00000000000000000000000000000000000eee" }),
}));

const mockCreatePublicClient = createPublicClient as jest.Mock;
const mockCreateWalletClient = createWalletClient as jest.Mock;
const getTransactionCount = jest.fn();
const sendTransaction = jest.fn();
const getTransactionReceipt = jest.fn();

describe("ChainWriteService", () => {
    let config: ReturnType<typeof mock<DustRescueConfigService>>;
    let service: ChainWriteService;

    beforeEach(() => {
        jest.clearAllMocks();
        config = mock<DustRescueConfigService>();
        config.chain.mockReturnValue({ rpcUrl: "https://rpc.example.com" } as never);
        config.signerPrivateKey.mockReturnValue("0xkey" as never);
        mockCreatePublicClient.mockReturnValue({ getTransactionCount, getTransactionReceipt });
        mockCreateWalletClient.mockReturnValue({ sendTransaction });
        getTransactionCount.mockResolvedValue(5);
        sendTransaction.mockResolvedValue("0xtxhash");
        service = new ChainWriteService(config);
    });

    it("fetches a fresh nonce for every deposit call, never caching across invocations.", async () => {
        await service.deposit(8453, "0x00000000000000000000000000000000000fff", "0xdata", "0x0");
        await service.deposit(8453, "0x00000000000000000000000000000000000fff", "0xdata", "0x0");

        expect(getTransactionCount).toHaveBeenCalledTimes(2);
        expect(getTransactionCount).toHaveBeenCalledWith(
            expect.objectContaining({ address: "0x00000000000000000000000000000000000eee", blockTag: "pending" })
        );
    });

    it("submits the deposit tx with the fetched nonce.", async () => {
        const hash = await service.deposit(8453, "0x00000000000000000000000000000000000fff", "0xdata", "0x0");

        expect(hash).toBe("0xtxhash");
        expect(sendTransaction).toHaveBeenCalledWith(
            expect.objectContaining({ to: "0x00000000000000000000000000000000000fff", data: "0xdata", nonce: 5 })
        );
    });

    it("submits an approval tx via the same send path.", async () => {
        const hash = await service.approve(8453, {
            to: "0x00000000000000000000000000000000000fff",
            data: "0xapprove",
            value: "0x0",
        });

        expect(hash).toBe("0xtxhash");
        expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ data: "0xapprove" }));
    });

    it("throws a short, arg-free error message on send failure (no calldata leaked).", async () => {
        sendTransaction.mockRejectedValue(new Error("insufficient funds for gas * price + value: 0xdata"));

        await expect(
            service.deposit(8453, "0x00000000000000000000000000000000000fff", "0xdata", "0x0")
        ).rejects.toThrow(/insufficient funds/);
    });

    it("waitForReceipt returns undefined when the receipt isn't found yet (not mined).", async () => {
        getTransactionReceipt.mockRejectedValue(new Error("not found"));

        const receipt = await service.waitForReceipt(8453, "0xtxhash");

        expect(receipt).toBeUndefined();
    });

    it("waitForReceipt returns the receipt once mined.", async () => {
        getTransactionReceipt.mockResolvedValue({ status: "success" });

        const receipt = await service.waitForReceipt(8453, "0xtxhash");

        expect(receipt).toEqual({ status: "success" });
    });
});
