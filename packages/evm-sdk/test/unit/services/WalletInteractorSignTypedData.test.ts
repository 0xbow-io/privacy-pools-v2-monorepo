import { describe, expect, it, vi } from "vitest";

import type { Address, Eip712TypedData, Hex } from "../../../src/internal.js";
import {
    buildSetAuthPolicyTypedData,
    EIP1193WalletInteractor,
    ViemWalletInteractor,
    WalletSignTypedDataFailed,
} from "../../../src/internal.js";

const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;

const typedData: Eip712TypedData = buildSetAuthPolicyTypedData({
    keystoreAddress: "0x1111111111111111111111111111111111111111" as Address,
    chainId: 1,
    account: ACCOUNT,
    authDigest: "0xabc" as Hex,
    nullifyingKeyHash: "0xdef" as Hex,
    deadline: "0x1234" as Hex,
});

describe("ViemWalletInteractor.signTypedData", () => {
    it("delegate to walletClient.signTypedData with the payload and return the signature", async () => {
        const signature = ("0x" + "11".repeat(65)) as Hex;
        const walletClient = {
            account: { address: ACCOUNT },
            chain: null,
            signTypedData: vi.fn(async () => signature),
        };
        const interactor = new ViemWalletInteractor({
            walletClient: walletClient as never,
        });

        const result = await interactor.signTypedData(typedData);

        expect(result).toBe(signature);
        expect(walletClient.signTypedData).toHaveBeenCalledWith(
            expect.objectContaining({
                primaryType: "SetAuthPolicy",
                domain: typedData.domain,
                message: typedData.message,
            }),
        );
    });

    it("throw WalletSignTypedDataFailed when the wallet rejects", async () => {
        const walletClient = {
            account: { address: ACCOUNT },
            chain: null,
            signTypedData: vi.fn(async () => {
                throw new Error("user rejected");
            }),
        };
        const interactor = new ViemWalletInteractor({ walletClient: walletClient as never });

        await expect(interactor.signTypedData(typedData)).rejects.toThrow(
            WalletSignTypedDataFailed,
        );
    });

    it("throw WalletSignTypedDataFailed when the wallet returns a short-hex signature", async () => {
        // Well-formed hex but only 32 bytes, not a full 65-byte ECDSA signature.
        const shortSig = ("0x" + "11".repeat(32)) as Hex;
        const walletClient = {
            account: { address: ACCOUNT },
            chain: null,
            signTypedData: vi.fn(async () => shortSig),
        };
        const interactor = new ViemWalletInteractor({ walletClient: walletClient as never });

        await expect(interactor.signTypedData(typedData)).rejects.toThrow(
            WalletSignTypedDataFailed,
        );
    });

    it("throw WalletSignTypedDataFailed when the wallet returns a non-hex signature", async () => {
        const walletClient = {
            account: { address: ACCOUNT },
            chain: null,
            signTypedData: vi.fn(async () => "not-a-signature"),
        };
        const interactor = new ViemWalletInteractor({ walletClient: walletClient as never });

        await expect(interactor.signTypedData(typedData)).rejects.toThrow(
            WalletSignTypedDataFailed,
        );
    });
});

describe("EIP1193WalletInteractor.signTypedData", () => {
    it("build the eth_signTypedData_v4 envelope (EIP712Domain + bigint->decimal) and return the signature", async () => {
        const signature = ("0x" + "22".repeat(65)) as Hex;
        const request = vi.fn(async (args: { method: string; params?: readonly unknown[] }) => {
            if (args.method === "eth_requestAccounts") return [ACCOUNT];
            if (args.method === "eth_signTypedData_v4") return signature;
            return null;
        });
        const interactor = new EIP1193WalletInteractor({ provider: { request } as never });

        const result = await interactor.signTypedData(typedData);

        expect(result).toBe(signature);
        const signCall = request.mock.calls.find(
            (c) => (c[0] as { method: string }).method === "eth_signTypedData_v4",
        )!;
        const [addr, json] = (signCall[0] as unknown as { params: [string, string] }).params;
        expect(addr).toBe(ACCOUNT);
        const envelope = JSON.parse(json) as {
            types: Record<string, unknown>;
            primaryType: string;
            message: Record<string, unknown>;
        };
        // eth_signTypedData_v4 requires the EIP712Domain type entry...
        expect(envelope.types.EIP712Domain).toBeDefined();
        expect(envelope.primaryType).toBe("SetAuthPolicy");
        // ...and uint256 fields must be decimal strings (bigint is not JSON-serializable).
        expect(typeof envelope.message.authDigest).toBe("string");
        expect(envelope.message.authDigest).toBe(BigInt("0xabc").toString());
    });

    it("throw WalletSignTypedDataFailed when the provider rejects", async () => {
        const request = vi.fn(async (args: { method: string }) => {
            if (args.method === "eth_requestAccounts") return [ACCOUNT];
            throw new Error("rejected");
        });
        const interactor = new EIP1193WalletInteractor({ provider: { request } as never });

        await expect(interactor.signTypedData(typedData)).rejects.toThrow(
            WalletSignTypedDataFailed,
        );
    });
});
