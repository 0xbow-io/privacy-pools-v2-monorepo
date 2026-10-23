import { Keypair, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Hash,
    IStellarRPCInteractor,
    IStellarWalletInteractor,
    PoolVaultInteractor,
    StellarLog,
    StellarProof,
} from "../../../src/internal.js";
import {
    addressScVal,
    bigintToHex,
    createStellarPoolVaultInteractor,
    ledgerClosedAtToUnixSeconds,
    structScVal,
    u128ScVal,
    u256ScVal,
    vecScVal,
    WalletNotAvailable,
} from "../../../src/internal.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const READ_SOURCE = Keypair.random().publicKey();
const OWNER = Keypair.random().publicKey();
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 2));
const ZERO_HASH = `0x${"00".repeat(32)}` as Hash;

function createMockRPC(overrides?: Partial<IStellarRPCInteractor>): IStellarRPCInteractor {
    return {
        getLatestLedger: vi.fn(async () => "0x64" as Hash),
        getFinalizedBlockNumber: vi.fn(async () => ({ status: "finalized" as const, blockNumber: "0x64" as Hash })),
        getAccount: vi.fn(async () => ({ publicKey: READ_SOURCE, sequence: "1" })),
        getNativeBalance: vi.fn(async () => 0n),
        simulateRead: vi.fn(async () => false),
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

function topicBase64(scVal: xdr.ScVal): string {
    return scVal.toXDR("base64");
}

function dataBase64(fields: Record<string, xdr.ScVal>): string {
    return structScVal(fields).toXDR("base64");
}

const PROOF: StellarProof = {
    a: `0x${"11".repeat(64)}` as Hash,
    b: `0x${"22".repeat(128)}` as Hash,
    c: `0x${"33".repeat(64)}` as Hash,
    pubSignals: [1n, 2n, 3n, 4n, 5n, 6n, 7n],
};

describe("StellarPoolVaultChainAdapter", () => {
    let mockRPC: IStellarRPCInteractor;
    let mockWallet: IStellarWalletInteractor;
    let interactor: PoolVaultInteractor<string, string, StellarProof, StellarLog>;

    beforeEach(() => {
        mockRPC = createMockRPC();
        mockWallet = createMockWallet();
        interactor = createStellarPoolVaultInteractor(
            { rpcInteractor: mockRPC, contractId: CONTRACT_ID, readSourcePublicKey: READ_SOURCE },
            { walletInteractor: mockWallet },
        );
    });

    it("create instance via factory", () => {
        expect(interactor.getAddress()).toBe(CONTRACT_ID);
    });

    it("resolve a commitment's timestamp from Deposited event history, 0x0 if absent", async () => {
        const commitment = 123456789n;
        const ledgerClosedAt = "2024-01-01T00:00:00Z";
        mockRPC = createMockRPC({
            getEvents: vi.fn(async () => ({
                events: [
                    {
                        id: "e1",
                        type: "deposited",
                        ledger: "0x64" as Hash,
                        ledgerClosedAt,
                        contractId: CONTRACT_ID,
                        topics: [
                            topicBase64(xdr.ScVal.scvSymbol("deposited")),
                            topicBase64(u256ScVal(commitment)),
                        ],
                        data: dataBase64({
                            asset: addressScVal(ASSET),
                            value: u128ScVal(100n),
                            depositor: addressScVal(OWNER),
                        }),
                        transactionHash: "0xdead" as Hash,
                    } satisfies StellarLog,
                ],
                latestLedger: "0x64" as Hash,
            })),
        });
        interactor = createStellarPoolVaultInteractor({
            rpcInteractor: mockRPC,
            contractId: CONTRACT_ID,
            readSourcePublicKey: READ_SOURCE,
        });

        const timestamp = await interactor.getCommitmentTimestamp(bigintToHex(commitment));
        expect(BigInt(timestamp)).toBe(ledgerClosedAtToUnixSeconds(ledgerClosedAt));

        const missing = await interactor.getCommitmentTimestamp(ZERO_HASH);
        expect(missing).toBe(bigintToHex(0n));
    });

    it("resolve a nullifier's timestamp from Transacted event history, 0x0 if unspent", async () => {
        const nullifier = 987654321n;
        const ledgerClosedAt = "2024-06-01T00:00:00Z";
        mockRPC = createMockRPC({
            getEvents: vi.fn(async () => ({
                events: [
                    {
                        id: "e1",
                        type: "transacted",
                        ledger: "0x64" as Hash,
                        ledgerClosedAt,
                        contractId: CONTRACT_ID,
                        topics: [topicBase64(xdr.ScVal.scvSymbol("transacted"))],
                        data: dataBase64({
                            commitments: vecScVal([u256ScVal(1n)]),
                            nullifiers: vecScVal([u256ScVal(nullifier)]),
                            asset: addressScVal(ASSET),
                            amount_out: u128ScVal(0n),
                            processor: addressScVal(OWNER),
                        }),
                        transactionHash: "0xbeef" as Hash,
                    } satisfies StellarLog,
                ],
                latestLedger: "0x64" as Hash,
            })),
        });
        interactor = createStellarPoolVaultInteractor({
            rpcInteractor: mockRPC,
            contractId: CONTRACT_ID,
            readSourcePublicKey: READ_SOURCE,
        });

        const timestamp = await interactor.getNullifierTimestamp(bigintToHex(nullifier));
        expect(BigInt(timestamp)).toBe(ledgerClosedAtToUnixSeconds(ledgerClosedAt));

        const missing = await interactor.getNullifierTimestamp(ZERO_HASH);
        expect(missing).toBe(bigintToHex(0n));
    });

    it("call is_known_root via simulateRead with the read source account", async () => {
        await interactor.isKnownRoot(ZERO_HASH);
        expect(mockRPC.simulateRead).toHaveBeenCalledWith(
            CONTRACT_ID,
            "is_known_root",
            expect.any(Array),
            READ_SOURCE,
        );
    });

    it("build a ragequit transaction against the ragequit method with 9 ordered arguments", async () => {
        await interactor.encodeRagequit(PROOF, ASSET);
        expect(mockRPC.buildTransaction).toHaveBeenCalledWith(
            CONTRACT_ID,
            "ragequit",
            expect.arrayContaining([expect.anything()]),
            OWNER,
        );
        const args = vi.mocked(mockRPC.buildTransaction).mock.calls[0][2];
        expect(args).toHaveLength(9);
        expect(scValToNative(args[0])).toBe(OWNER);
        expect(scValToNative(args[8])).toBe(ASSET);
    });

    it("map pubSignals to ragequit's args in circom's outputs-then-inputs order, not declaration order", async () => {
        // PROOF.pubSignals = [1n, 2n, 3n, 4n, 5n, 6n, 7n] =
        //   [nullifierHash, commitment, keystoreRoot, ownerAddress, value, tokenId, label] —
        // matches ProofLibV2.RagequitProof's pubSignals[0..6] (packages/contracts/src/libraries/ProofLibV2.sol).
        await interactor.encodeRagequit(PROOF, ASSET);
        const args = vi.mocked(mockRPC.buildTransaction).mock.calls[0][2];
        // args = [owner, proof, nullifierHash, commitment, keystoreRoot, value, tokenId, label, asset]
        expect(scValToNative(args[2])).toBe(1n); // nullifierHash
        expect(scValToNative(args[3])).toBe(2n); // commitment
        expect(scValToNative(args[4])).toBe(3n); // keystoreRoot
        expect(scValToNative(args[5])).toBe(5n); // value (skips ownerAddress at pubSignals[3])
        expect(scValToNative(args[6])).toBe(6n); // tokenId
        expect(scValToNative(args[7])).toBe(7n); // label
    });

    it("reject encodeRagequit when no wallet interactor is configured", async () => {
        const readOnly = createStellarPoolVaultInteractor({
            rpcInteractor: mockRPC,
            contractId: CONTRACT_ID,
            readSourcePublicKey: READ_SOURCE,
        });
        await expect(readOnly.encodeRagequit(PROOF, ASSET)).rejects.toThrow(WalletNotAvailable);
    });
});
