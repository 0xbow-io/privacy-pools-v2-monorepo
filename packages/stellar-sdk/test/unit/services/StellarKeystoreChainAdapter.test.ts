import { Keypair, scValToNative, StrKey } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Eip712TypedData,
    Hash,
    IStellarRPCInteractor,
    IStellarWalletInteractor,
    KeystoreInteractor,
} from "../../../src/internal.js";
import { ContractCallError, createStellarKeystoreInteractor } from "../../../src/internal.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const READ_SOURCE = Keypair.random().publicKey();
const OWNER = Keypair.random().publicKey();
const AUTH_DIGEST = `0x${"01".repeat(32)}` as Hash;
const NULLIFYING_KEY_HASH = `0x${"02".repeat(32)}` as Hash;

function createMockRPC(overrides?: Partial<IStellarRPCInteractor>): IStellarRPCInteractor {
    return {
        getLatestLedger: vi.fn(async () => "0x64" as Hash),
        getFinalizedBlockNumber: vi.fn(async () => ({ status: "finalized" as const, blockNumber: "0x64" as Hash })),
        getAccount: vi.fn(async () => ({ publicKey: READ_SOURCE, sequence: "1" })),
        getNativeBalance: vi.fn(async () => 0n),
        simulateRead: vi.fn(async () => 42n),
        buildTransaction: vi.fn(async () => "unsigned-xdr"),
        buildTransactionWithAuth: vi.fn(),
        buildUnsimulatedTransaction: vi.fn(),
        submitTransaction: vi.fn(async () => "0xabc" as Hash),
        getEvents: vi.fn(async () => ({ events: [], latestLedger: "0x64" as Hash })),
        waitForTransactionReceipt: vi.fn(),
        ...overrides,
    };
}

function createMockWallet(): IStellarWalletInteractor {
    return {
        sendTransaction: vi.fn(async () => "0xabc" as Hash),
        getAccounts: vi.fn(async () => [OWNER]),
        getNetworkPassphrase: vi.fn(async () => "Test SDF Network ; September 2015"),
        signKeyDerivationMessage: vi.fn(async () => "0xsig" as Hash),
        signAuthEntry: vi.fn(),
    };
}

describe("StellarKeystoreChainAdapter", () => {
    let mockRPC: IStellarRPCInteractor;
    let mockWallet: IStellarWalletInteractor;
    let interactor: KeystoreInteractor<string, string>;

    beforeEach(() => {
        mockRPC = createMockRPC();
        mockWallet = createMockWallet();
        interactor = createStellarKeystoreInteractor(
            { rpcInteractor: mockRPC, contractId: CONTRACT_ID, readSourcePublicKey: READ_SOURCE },
            { walletInteractor: mockWallet },
        );
    });

    it("read the nullifying key hash via get_nullifying_key", async () => {
        await interactor.getNullifyingKeyHash(OWNER);
        expect(mockRPC.simulateRead).toHaveBeenCalledWith(
            CONTRACT_ID,
            "get_nullifying_key",
            expect.any(Array),
            READ_SOURCE,
        );
    });

    it("build a setAuthPolicy transaction with (owner, nullifyingKeyHash, authDigest) order", async () => {
        await interactor.encodeSetAuthPolicy(AUTH_DIGEST, NULLIFYING_KEY_HASH);
        expect(mockRPC.buildTransaction).toHaveBeenCalledWith(
            CONTRACT_ID,
            "set_auth_policy",
            expect.any(Array),
            OWNER,
            1,
        );
        const args = vi.mocked(mockRPC.buildTransaction).mock.calls[0][2];
        expect(args).toHaveLength(3);
        expect(scValToNative(args[0])).toBe(OWNER);
        expect(scValToNative(args[1])).toBe(BigInt(NULLIFYING_KEY_HASH));
        expect(scValToNative(args[2])).toBe(BigInt(AUTH_DIGEST));
    });

    it("reject signTypedData with ContractCallError (no EIP-712 equivalent on Stellar)", async () => {
        await expect(
            interactor.signTypedData({
                domain: {},
                types: {},
                primaryType: "x",
                message: {},
            } as unknown as Eip712TypedData),
        ).rejects.toThrow(ContractCallError);
    });
});
