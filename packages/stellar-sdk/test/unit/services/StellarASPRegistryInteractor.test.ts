import { StrKey } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Hash, IStellarRPCInteractor } from "../../../src/internal.js";
import { ContractCallError, StellarASPRegistryInteractor } from "../../../src/internal.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const READ_SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));

function createMockRPC(overrides?: Partial<IStellarRPCInteractor>): IStellarRPCInteractor {
    return {
        getLatestLedger: vi.fn(async () => "0x64" as Hash),
        getFinalizedBlockNumber: vi.fn(async () => ({ status: "finalized" as const, blockNumber: "0x64" as Hash })),
        getAccount: vi.fn(async () => ({ publicKey: READ_SOURCE, sequence: "1" })),
        getNativeBalance: vi.fn(async () => 0n),
        simulateRead: vi.fn(async () => 0n),
        buildTransaction: vi.fn(async () => "unsigned-xdr"),
        buildTransactionWithAuth: vi.fn(),
        buildUnsimulatedTransaction: vi.fn(),
        submitTransaction: vi.fn(async () => "0xabc" as Hash),
        getEvents: vi.fn(async () => ({ events: [], latestLedger: "0x64" as Hash })),
        waitForTransactionReceipt: vi.fn(),
        ...overrides,
    };
}

describe("StellarASPRegistryInteractor", () => {
    let mockRPC: IStellarRPCInteractor;
    let interactor: StellarASPRegistryInteractor;

    beforeEach(() => {
        mockRPC = createMockRPC();
        interactor = new StellarASPRegistryInteractor({
            rpcInteractor: mockRPC,
            contractId: CONTRACT_ID,
            readSourcePublicKey: READ_SOURCE,
        });
    });

    describe("getLatestASPRoot", () => {
        it("call latest_asp_root via simulateRead with the read source account", async () => {
            mockRPC = createMockRPC({ simulateRead: vi.fn(async () => 42n) });
            interactor = new StellarASPRegistryInteractor({
                rpcInteractor: mockRPC,
                contractId: CONTRACT_ID,
                readSourcePublicKey: READ_SOURCE,
            });
            const root = await interactor.getLatestASPRoot();
            expect(mockRPC.simulateRead).toHaveBeenCalledWith(
                CONTRACT_ID,
                "latest_asp_root",
                [],
                READ_SOURCE,
            );
            expect(BigInt(root)).toBe(42n);
        });
    });

    describe("getLatestAssociationSetData", () => {
        it("resolve the latest root and CID by reading root_count then the last index", async () => {
            const calls: Record<string, unknown> = {
                root_count: 3,
                get_root_at: 777n,
                get_cid_at: new TextEncoder().encode("bafybeigdyrzt"),
            };
            mockRPC = createMockRPC({
                simulateRead: vi.fn(async (_contractId, method) => calls[method]),
            });
            interactor = new StellarASPRegistryInteractor({
                rpcInteractor: mockRPC,
                contractId: CONTRACT_ID,
                readSourcePublicKey: READ_SOURCE,
            });

            const data = await interactor.getLatestAssociationSetData();

            expect(BigInt(data.root)).toBe(777n);
            expect(data.ipfsCID).toBe("bafybeigdyrzt");
            expect(mockRPC.simulateRead).toHaveBeenCalledWith(
                CONTRACT_ID,
                "get_root_at",
                expect.any(Array),
                READ_SOURCE,
            );
            expect(mockRPC.simulateRead).toHaveBeenCalledWith(
                CONTRACT_ID,
                "get_cid_at",
                expect.any(Array),
                READ_SOURCE,
            );
        });

        it("reject with ContractCallError when no root has been submitted yet", async () => {
            mockRPC = createMockRPC({ simulateRead: vi.fn(async () => 0) });
            interactor = new StellarASPRegistryInteractor({
                rpcInteractor: mockRPC,
                contractId: CONTRACT_ID,
                readSourcePublicKey: READ_SOURCE,
            });
            await expect(interactor.getLatestAssociationSetData()).rejects.toThrow(
                ContractCallError,
            );
        });
    });
});
