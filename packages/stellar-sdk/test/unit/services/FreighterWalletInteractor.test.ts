import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Hash,
    IStellarRPCInteractor,
    StellarWalletProvider,
} from "../../../src/internal.js";
import {
    buildKeyDerivationTransaction,
    FreighterWalletInteractor,
    StellarWalletNetworkMismatch,
    StellarWalletNoAccountsError,
    StellarWalletNotAvailable,
    StellarWalletSignTransactionFailed,
} from "../../../src/internal.js";

const NETWORK = "Test SDF Network ; September 2015";
const OWNER = Keypair.random();

function createMockProvider(overrides: Partial<StellarWalletProvider> = {}): StellarWalletProvider {
    return {
        getAddress: vi.fn(async () => OWNER.publicKey()),
        getNetworkPassphrase: vi.fn(async () => NETWORK),
        signTransaction: vi.fn(async (xdr: string) => xdr),
        ...overrides,
    };
}

function createMockRPC(overrides: Partial<IStellarRPCInteractor> = {}): IStellarRPCInteractor {
    return {
        getLatestLedger: async () => "0x0" as Hash,
        getFinalizedBlockNumber: async () => ({ status: "finalized" as const, blockNumber: "0x0" as Hash }),
        getAccount: async () => ({ publicKey: "", sequence: "0" }),
        simulateRead: async () => undefined,
        buildTransaction: async () => "",
        buildTransactionWithAuth: vi.fn(),
        buildUnsimulatedTransaction: vi.fn(),
        submitTransaction: async () => "0xabc123" as Hash,
        getEvents: async () => ({ events: [], latestLedger: "0x0" as Hash }),
        waitForTransactionReceipt: async () => {
            throw new Error("not used");
        },
        ...overrides,
    };
}

describe("FreighterWalletInteractor", () => {
    let provider: StellarWalletProvider;
    let rpcInteractor: IStellarRPCInteractor;
    let wallet: FreighterWalletInteractor;

    beforeEach(() => {
        provider = createMockProvider();
        rpcInteractor = createMockRPC();
        wallet = new FreighterWalletInteractor({ provider, rpcInteractor, networkPassphrase: NETWORK });
    });

    describe("sendTransaction", () => {
        it("sign then submit when the wallet's active network matches", async () => {
            const hash = await wallet.sendTransaction("unsigned-xdr");

            expect(provider.signTransaction).toHaveBeenCalledWith("unsigned-xdr", {
                networkPassphrase: NETWORK,
            });
            expect(hash).toBe("0xabc123");
        });

        it("throw StellarWalletNetworkMismatch when the wallet is on a different network", async () => {
            provider = createMockProvider({ getNetworkPassphrase: async () => "Public Global Stellar Network ; September 2015" });
            wallet = new FreighterWalletInteractor({ provider, rpcInteractor, networkPassphrase: NETWORK });

            await expect(wallet.sendTransaction("unsigned-xdr")).rejects.toThrow(
                StellarWalletNetworkMismatch,
            );
        });

        it("classify a declined signature as StellarWalletSignTransactionFailed", async () => {
            provider = createMockProvider({
                signTransaction: vi.fn(async () => {
                    throw new Error("User declined access");
                }),
            });
            wallet = new FreighterWalletInteractor({ provider, rpcInteractor, networkPassphrase: NETWORK });

            await expect(wallet.sendTransaction("unsigned-xdr")).rejects.toThrow(
                StellarWalletSignTransactionFailed,
            );
        });

        it("classify a not-installed failure as StellarWalletNotAvailable", async () => {
            provider = createMockProvider({
                signTransaction: vi.fn(async () => {
                    throw new Error("Freighter extension is not installed");
                }),
            });
            wallet = new FreighterWalletInteractor({ provider, rpcInteractor, networkPassphrase: NETWORK });

            await expect(wallet.sendTransaction("unsigned-xdr")).rejects.toThrow(
                StellarWalletNotAvailable,
            );
        });
    });

    describe("getAccounts", () => {
        it("return the wallet's address", async () => {
            await expect(wallet.getAccounts()).resolves.toEqual([OWNER.publicKey()]);
        });

        it("throw StellarWalletNoAccountsError when the provider returns an empty address", async () => {
            provider = createMockProvider({ getAddress: vi.fn(async () => "") });
            wallet = new FreighterWalletInteractor({ provider, rpcInteractor, networkPassphrase: NETWORK });

            await expect(wallet.getAccounts()).rejects.toThrow(StellarWalletNoAccountsError);
        });

        it("wrap a provider failure as StellarWalletNotAvailable", async () => {
            provider = createMockProvider({
                getAddress: vi.fn(async () => {
                    throw new Error("no extension found");
                }),
            });
            wallet = new FreighterWalletInteractor({ provider, rpcInteractor, networkPassphrase: NETWORK });

            await expect(wallet.getAccounts()).rejects.toThrow(StellarWalletNotAvailable);
        });
    });

    describe("getNetworkPassphrase", () => {
        it("return the provider's active network passphrase", async () => {
            await expect(wallet.getNetworkPassphrase()).resolves.toBe(NETWORK);
        });
    });

    describe("signKeyDerivationMessage", () => {
        it("return a signature that verifies against the built key-derivation transaction hash", async () => {
            provider = createMockProvider({
                signTransaction: vi.fn(async (xdr: string) => {
                    const tx = buildKeyDerivationTransaction(OWNER.publicKey(), NETWORK);
                    expect(tx.toXDR()).toBe(xdr);
                    tx.sign(OWNER);
                    return tx.toXDR();
                }),
            });
            wallet = new FreighterWalletInteractor({ provider, rpcInteractor, networkPassphrase: NETWORK });

            const signature = await wallet.signKeyDerivationMessage(OWNER.publicKey());

            const expectedHash = buildKeyDerivationTransaction(OWNER.publicKey(), NETWORK).hash();
            const signatureBytes = Buffer.from(signature.slice(2), "hex");
            expect(signatureBytes).toHaveLength(64);
            expect(OWNER.verify(expectedHash, signatureBytes)).toBe(true);
        });

        it("throw StellarWalletSignTransactionFailed when the wallet returns no signature", async () => {
            provider = createMockProvider({
                signTransaction: vi.fn(async () =>
                    buildKeyDerivationTransaction(OWNER.publicKey(), NETWORK).toXDR(),
                ),
            });
            wallet = new FreighterWalletInteractor({ provider, rpcInteractor, networkPassphrase: NETWORK });

            await expect(wallet.signKeyDerivationMessage(OWNER.publicKey())).rejects.toThrow(
                StellarWalletSignTransactionFailed,
            );
        });

        it("throw StellarWalletNetworkMismatch when the wallet is on a different network", async () => {
            provider = createMockProvider({ getNetworkPassphrase: async () => "Public Global Stellar Network ; September 2015" });
            wallet = new FreighterWalletInteractor({ provider, rpcInteractor, networkPassphrase: NETWORK });

            await expect(wallet.signKeyDerivationMessage(OWNER.publicKey())).rejects.toThrow(
                StellarWalletNetworkMismatch,
            );
        });
    });
});
