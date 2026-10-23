import { Keypair, scValToNative, StrKey } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    EntrypointInteractor,
    Hash,
    IStellarRPCInteractor,
    IStellarWalletInteractor,
    NoteData,
    StellarProof,
} from "../../../src/internal.js";
import {
    ContractCallError,
    createStellarEntrypointInteractor,
} from "../../../src/internal.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const ASP_REGISTRY_ID = StrKey.encodeContract(Buffer.alloc(32, 3));
const READ_SOURCE = Keypair.random().publicKey();
const DEPOSITOR = Keypair.random().publicKey();
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 2));

function createMockRPC(overrides?: Partial<IStellarRPCInteractor>): IStellarRPCInteractor {
    return {
        getLatestLedger: vi.fn(async () => "0x64" as Hash),
        getFinalizedBlockNumber: vi.fn(async () => ({ status: "finalized" as const, blockNumber: "0x64" as Hash })),
        getAccount: vi.fn(async () => ({ publicKey: READ_SOURCE, sequence: "1" })),
        getNativeBalance: vi.fn(async () => 0n),
        simulateRead: vi.fn(async () => ({
            enabled: true,
            min_deposit_amount: 1n,
            vetting_fee_bps: 100,
            accumulated_fees: 0n,
            max_relay_fee: 5n,
        })),
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
        getAccounts: vi.fn(async () => [DEPOSITOR]),
        getNetworkPassphrase: vi.fn(async () => "Test SDF Network ; September 2015"),
        signKeyDerivationMessage: vi.fn(async () => "0xsig" as Hash),
        signAuthEntry: vi.fn(),
    };
}

const PROOF: StellarProof = {
    a: `0x${"11".repeat(64)}` as Hash,
    b: `0x${"22".repeat(128)}` as Hash,
    c: `0x${"33".repeat(64)}` as Hash,
    pubSignals: [10n, 20n, 30n, 40n],
};

const NOTE_DATA: NoteData = { hint: `0x${"00".repeat(32)}` as Hash, data: "0x1234" as Hash };

describe("StellarEntrypointChainAdapter", () => {
    let mockRPC: IStellarRPCInteractor;
    let mockWallet: IStellarWalletInteractor;
    let interactor: EntrypointInteractor<string, string, StellarProof>;

    beforeEach(() => {
        mockRPC = createMockRPC();
        mockWallet = createMockWallet();
        interactor = createStellarEntrypointInteractor(
            {
                rpcInteractor: mockRPC,
                contractId: CONTRACT_ID,
                aspRegistryContractId: ASP_REGISTRY_ID,
                readSourcePublicKey: READ_SOURCE,
            },
            { walletInteractor: mockWallet },
        );
    });

    it("resolve the pool vault address self-referentially, with no RPC call", async () => {
        const address = await interactor.getPoolVaultAddress();
        expect(address).toBe(CONTRACT_ID);
        expect(mockRPC.simulateRead).not.toHaveBeenCalled();
    });

    it("resolve the ASP registry address from config, with no RPC call", async () => {
        const address = await interactor.getASPRegistryAddress();
        expect(address).toBe(ASP_REGISTRY_ID);
        expect(mockRPC.simulateRead).not.toHaveBeenCalled();
    });

    it("read asset config via get_asset_config", async () => {
        const config = await interactor.getAssetConfig(ASSET);
        expect(mockRPC.simulateRead).toHaveBeenCalledWith(
            CONTRACT_ID,
            "get_asset_config",
            expect.any(Array),
            READ_SOURCE,
        );
        expect(config.enabled).toBe(true);
    });

    it("report an unconfigured asset as disabled rather than throwing, for a contract error #10", async () => {
        mockRPC = createMockRPC({
            simulateRead: vi.fn(async () => {
                throw new Error("Contract call failed: Simulation failed: HostError: Error(Contract, #10)");
            }),
        });
        interactor = createStellarEntrypointInteractor(
            { rpcInteractor: mockRPC, contractId: CONTRACT_ID, aspRegistryContractId: ASP_REGISTRY_ID, readSourcePublicKey: READ_SOURCE },
            { walletInteractor: mockWallet },
        );

        const config = await interactor.getAssetConfig(ASSET);
        expect(config.enabled).toBe(false);
    });

    it("wrap any other get_asset_config failure in ContractCallError", async () => {
        mockRPC = createMockRPC({
            simulateRead: vi.fn(async () => {
                throw new Error("Simulation failed: HostError: Error(Contract, #1)");
            }),
        });
        interactor = createStellarEntrypointInteractor(
            { rpcInteractor: mockRPC, contractId: CONTRACT_ID, aspRegistryContractId: ASP_REGISTRY_ID, readSourcePublicKey: READ_SOURCE },
            { walletInteractor: mockWallet },
        );

        await expect(interactor.getAssetConfig(ASSET)).rejects.toThrow(ContractCallError);
    });

    it("report an effectively unlimited allowance (no approve concept on Stellar)", async () => {
        const allowance = await interactor.getAllowance(ASSET, DEPOSITOR, CONTRACT_ID);
        expect(BigInt(allowance)).toBeGreaterThan(0n);
        expect(mockRPC.simulateRead).not.toHaveBeenCalled();
    });

    it("reject encodeApprove with ContractCallError (no approve step on Stellar)", async () => {
        await expect(interactor.encodeApprove(ASSET, "0x1" as Hash)).rejects.toThrow(
            ContractCallError,
        );
    });

    it("build a deposit transaction against the deposit method with 6 ordered arguments when there is no ASP ciphertext", async () => {
        await interactor.encodeDeposit(PROOF, NOTE_DATA, "0x" as Hash, "0x00" as Hash, ASSET);
        expect(mockRPC.buildTransaction).toHaveBeenCalledWith(
            CONTRACT_ID,
            "deposit",
            expect.any(Array),
            DEPOSITOR,
        );
        const args = vi.mocked(mockRPC.buildTransaction).mock.calls[0][2];
        expect(args).toHaveLength(6);
        expect(scValToNative(args[0])).toBe(DEPOSITOR);
        expect(scValToNative(args[1])).toBe(ASSET);
    });

    it("register the ASP label in the same call through deposit_with_label when a ciphertext is given", async () => {
        await interactor.encodeDeposit(PROOF, NOTE_DATA, "0xc0ffee" as Hash, "0x00" as Hash, ASSET);
        expect(mockRPC.buildTransaction).toHaveBeenCalledWith(
            CONTRACT_ID,
            "deposit_with_label",
            expect.any(Array),
            DEPOSITOR,
        );
        const args = vi.mocked(mockRPC.buildTransaction).mock.calls[0][2];
        expect(args).toHaveLength(7);
        expect(Buffer.from(scValToNative(args[6]) as Uint8Array).toString("hex")).toBe("c0ffee");
    });
});
