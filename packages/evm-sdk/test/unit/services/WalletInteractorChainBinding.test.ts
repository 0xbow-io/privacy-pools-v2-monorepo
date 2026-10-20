import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { Address, Hex, PreparedTransaction } from "../../../src/internal.js";
import {
    EIP1193WalletInteractor,
    ViemWalletInteractor,
    WalletChainMismatch,
    WalletSendTransactionFailed,
} from "../../../src/internal.js";

const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const TX: PreparedTransaction = {
    to: "0x3333333333333333333333333333333333333333" as Address,
    data: "0xdeadbeef" as Hex,
    value: "0x0" as Hex,
};
const TX_HASH = ("0x" + "11".repeat(32)) as Hex;

/**
 * A contract address is the same string on every chain, so a transaction prepared for one
 * chain and sent after the wallet moved to another reaches whatever occupies that address
 * there. The interactor is bound to a chain at build time and re-reads the wallet's chain
 * immediately before each send.
 */
describe("EIP1193WalletInteractor chain binding", () => {
    function providerOn(
        chainId: number,
        calls: string[] = [],
    ): { request: Mock<[{ method: string }], Promise<unknown>> } {
        return {
            request: vi.fn(async ({ method }: { method: string }): Promise<unknown> => {
                calls.push(method);
                if (method === "eth_requestAccounts") return [ACCOUNT];
                if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
                if (method === "eth_sendTransaction") return TX_HASH;
                throw new Error(`unexpected method ${method}`);
            }),
        };
    }

    it("send when the provider is on the expected chain", async () => {
        const interactor = new EIP1193WalletInteractor({
            provider: providerOn(1) as never,
            expectedChainId: 1,
        });
        await expect(interactor.sendTransaction(TX)).resolves.toBe(TX_HASH);
    });

    it("refuse to send when the provider moved to another chain", async () => {
        const calls: string[] = [];
        const interactor = new EIP1193WalletInteractor({
            provider: providerOn(10, calls) as never,
            expectedChainId: 1,
        });

        await expect(interactor.sendTransaction(TX)).rejects.toBeInstanceOf(WalletChainMismatch);
        // Nothing was handed to the wallet to sign.
        expect(calls.includes("eth_sendTransaction")).toBe(false);
    });

    it("read the chain after eth_requestAccounts, never before", async () => {
        // `eth_requestAccounts` can open the wallet's own interactive prompt, and the user can
        // switch networks in it. A chain read taken first would describe the network from
        // before that prompt rather than the one the send goes out on.
        const calls: string[] = [];
        const interactor = new EIP1193WalletInteractor({
            provider: providerOn(1, calls) as never,
            expectedChainId: 1,
        });

        await interactor.sendTransaction(TX);

        expect(calls.indexOf("eth_chainId")).toBeGreaterThan(calls.indexOf("eth_requestAccounts"));
        expect(calls.indexOf("eth_chainId")).toBeLessThan(calls.indexOf("eth_sendTransaction"));
    });

    it("send without a chain check when no chain was configured", async () => {
        const calls: string[] = [];
        const interactor = new EIP1193WalletInteractor({
            provider: providerOn(10, calls) as never,
        });

        await expect(interactor.sendTransaction(TX)).resolves.toBe(TX_HASH);
        expect(calls.includes("eth_chainId")).toBe(false);
    });
});

describe("ViemWalletInteractor chain binding", () => {
    function clientOn(
        configuredChainId: number | null,
        reportedChainId: number,
    ): {
        account: { address: Address };
        chain: { id: number } | null;
        getChainId: Mock<[], Promise<number>>;
        sendTransaction: Mock<[], Promise<Hex>>;
    } {
        return {
            account: { address: ACCOUNT },
            chain: configuredChainId === null ? null : { id: configuredChainId },
            getChainId: vi.fn(async () => reportedChainId),
            sendTransaction: vi.fn(async () => TX_HASH),
        };
    }

    it("send when both the configured and the reported chain match", async () => {
        const walletClient = clientOn(1, 1);
        const interactor = new ViemWalletInteractor({
            walletClient: walletClient as never,
            expectedChainId: 1,
        });

        await expect(interactor.sendTransaction(TX)).resolves.toBe(TX_HASH);
    });

    it("refuse when the chain the client signs against differs from the expected one", async () => {
        // A local account signs against `walletClient.chain`, which is configured locally and
        // never re-read, so it can differ from what the transport reports.
        const walletClient = clientOn(10, 1);
        const interactor = new ViemWalletInteractor({
            walletClient: walletClient as never,
            expectedChainId: 1,
        });

        await expect(interactor.sendTransaction(TX)).rejects.toBeInstanceOf(WalletChainMismatch);
        expect(walletClient.sendTransaction).not.toHaveBeenCalled();
        // Refused before even asking the transport: the signature would already be wrong.
        expect(walletClient.getChainId).not.toHaveBeenCalled();
    });

    it("refuse when the transport reports another chain", async () => {
        const walletClient = clientOn(1, 10);
        const interactor = new ViemWalletInteractor({
            walletClient: walletClient as never,
            expectedChainId: 1,
        });

        await expect(interactor.sendTransaction(TX)).rejects.toBeInstanceOf(WalletChainMismatch);
        expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    });

    it("send without a chain check when no chain was configured", async () => {
        const walletClient = clientOn(10, 10);
        const interactor = new ViemWalletInteractor({ walletClient: walletClient as never });

        await expect(interactor.sendTransaction(TX)).resolves.toBe(TX_HASH);
        expect(walletClient.getChainId).not.toHaveBeenCalled();
    });

    it("surface a send failure as WalletSendTransactionFailed, not as a chain mismatch", async () => {
        const walletClient = clientOn(1, 1);
        walletClient.sendTransaction = vi.fn(async (): Promise<Hex> => {
            throw new Error("user rejected");
        });
        const interactor = new ViemWalletInteractor({
            walletClient: walletClient as never,
            expectedChainId: 1,
        });

        await expect(interactor.sendTransaction(TX)).rejects.toBeInstanceOf(
            WalletSendTransactionFailed,
        );
    });
});
