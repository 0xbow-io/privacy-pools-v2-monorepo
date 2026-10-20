import { Account, BASE_FEE, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import type { Hash, IStellarRPCInteractor } from "../../../src/internal.js";
import {
    buildKeyDerivationTransaction,
    KeypairWalletInteractor,
    StellarTransactionSendFailed,
    StellarWalletSignTransactionFailed,
    WalletSendTransactionFailed,
} from "../../../src/internal.js";

const NETWORK = "Test SDF Network ; September 2015";

function createMockRPC(overrides?: Partial<IStellarRPCInteractor>): IStellarRPCInteractor {
    return {
        getLatestLedger: async () => "0x0" as Hash,
        getFinalizedBlockNumber: async () => ({ status: "finalized" as const, blockNumber: "0x0" as Hash }),
        getAccount: async () => ({ publicKey: "", sequence: "0" }),
        simulateRead: async () => undefined,
        buildTransaction: async () => "",
        buildTransactionWithAuth: vi.fn(),
        buildUnsimulatedTransaction: vi.fn(),
        submitTransaction: async () => "0x0" as Hash,
        getEvents: async () => ({ events: [], latestLedger: "0x0" as Hash }),
        waitForTransactionReceipt: async () => {
            throw new Error("not used");
        },
        ...overrides,
    };
}

function unsignedXdr(source: Keypair): string {
    const account = new Account(source.publicKey(), "0");
    return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK })
        .addOperation(Operation.createAccount({ destination: Keypair.random().publicKey(), startingBalance: "1" }))
        .setTimeout(30)
        .build()
        .toXDR();
}

describe("KeypairWalletInteractor", () => {
    describe("sendTransaction", () => {
        it("sign and submit, returning the resulting hash", async () => {
            const keypair = Keypair.random();
            const submitTransaction = vi.fn(async () => "0xabc" as Hash);
            const wallet = new KeypairWalletInteractor({
                keypair,
                networkPassphrase: NETWORK,
                rpcInteractor: createMockRPC({ submitTransaction }),
            });

            const hash = await wallet.sendTransaction(unsignedXdr(keypair));

            expect(hash).toBe("0xabc");
            expect(submitTransaction).toHaveBeenCalledTimes(1);
        });

        it("throw StellarWalletSignTransactionFailed for a malformed unsigned XDR", async () => {
            const keypair = Keypair.random();
            const wallet = new KeypairWalletInteractor({
                keypair,
                networkPassphrase: NETWORK,
                rpcInteractor: createMockRPC(),
            });

            await expect(wallet.sendTransaction("not-valid-xdr")).rejects.toThrow(
                StellarWalletSignTransactionFailed,
            );
        });

        it("throw WalletSendTransactionFailed, not a Stellar-specific error, when the network rejects a signed transaction", async () => {
            const keypair = Keypair.random();
            const wallet = new KeypairWalletInteractor({
                keypair,
                networkPassphrase: NETWORK,
                rpcInteractor: createMockRPC({
                    submitTransaction: async () => {
                        throw new StellarTransactionSendFailed("txInsufficientBalance");
                    },
                }),
            });

            await expect(wallet.sendTransaction(unsignedXdr(keypair))).rejects.toThrow(
                WalletSendTransactionFailed,
            );
        });
    });

    describe("signKeyDerivationMessage", () => {
        it("return a signature that verifies against the built key-derivation transaction hash", async () => {
            const keypair = Keypair.random();
            const wallet = new KeypairWalletInteractor({
                keypair,
                networkPassphrase: NETWORK,
                rpcInteractor: createMockRPC(),
            });

            const signature = await wallet.signKeyDerivationMessage(keypair.publicKey());

            const expectedHash = buildKeyDerivationTransaction(keypair.publicKey(), NETWORK).hash();
            const signatureBytes = Buffer.from(signature.slice(2), "hex");
            expect(signatureBytes).toHaveLength(64);
            expect(keypair.verify(expectedHash, signatureBytes)).toBe(true);
        });

        it("return the identical signature across repeated calls (deterministic EdDSA signing)", async () => {
            const keypair = Keypair.random();
            const wallet = new KeypairWalletInteractor({
                keypair,
                networkPassphrase: NETWORK,
                rpcInteractor: createMockRPC(),
            });

            const a = await wallet.signKeyDerivationMessage(keypair.publicKey());
            const b = await wallet.signKeyDerivationMessage(keypair.publicKey());
            expect(a).toBe(b);
        });

        it("return different signatures for different keypairs", async () => {
            const keypairA = Keypair.random();
            const keypairB = Keypair.random();
            const walletA = new KeypairWalletInteractor({
                keypair: keypairA,
                networkPassphrase: NETWORK,
                rpcInteractor: createMockRPC(),
            });
            const walletB = new KeypairWalletInteractor({
                keypair: keypairB,
                networkPassphrase: NETWORK,
                rpcInteractor: createMockRPC(),
            });

            const a = await walletA.signKeyDerivationMessage(keypairA.publicKey());
            const b = await walletB.signKeyDerivationMessage(keypairB.publicKey());
            expect(a).not.toBe(b);
        });
    });
});
