import { Test, TestingModule } from "@nestjs/testing";
import { Address, authorizeEntry, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { StellarChainService } from "./stellar.chain.service";
import { StellarConfigService } from "../config/stellar/stellar-config.service";
import { createMockLoggerProvider } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import type { StellarWithdrawalFeeCommitment } from "../quote/stellar/types";

const simulateRead = jest.fn();
const buildTransaction = jest.fn();
const submitTransaction = jest.fn();
const sendTransaction = jest.fn();
const getLatestLedger = jest.fn();
const waitForTransactionReceipt = jest.fn();

jest.mock("@privacy-pools-v2/stellar-sdk", () => ({
    ...jest.requireActual("@privacy-pools-v2/stellar-sdk"),
    SorobanRPCInteractor: jest.fn().mockImplementation(() => ({
        simulateRead,
        buildTransaction,
        submitTransaction,
        getLatestLedger,
        waitForTransactionReceipt,
    })),
    KeypairWalletInteractor: jest.fn().mockImplementation(() => ({
        sendTransaction,
    })),
}));

const SIGNER = Keypair.random();
// Real, checksum-valid StrKeys (encoded from arbitrary but fixed 32-byte payloads) — addressScVal
// validates StrKey shape/checksum, so a hand-typed placeholder string fails before the test even
// reaches the behavior under test.
const RELAY_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 1));
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 2));
const RECIPIENT = Keypair.random().publicKey();
const KEYSTORE = StrKey.encodeContract(Buffer.alloc(32, 7));
const PASSPHRASE = "Test SDF Network ; September 2015";
const OWNER = Keypair.random();

function u256(v: bigint): xdr.ScVal {
    const b = Buffer.alloc(32);
    let x = v;
    for (let i = 31; i >= 0; i--) {
        b[i] = Number(x & 0xffn);
        x >>= 8n;
    }
    return xdr.ScVal.scvU256(xdr.UInt256Parts.fromXDR(b));
}

/** A signed owner entry over `keystore.set_auth_policy(account, 1, 2)`, as the SDK produces it. */
async function signedEntry(opts: { signer?: Keypair; keystore?: string; nkh?: bigint; expiry?: number } = {}): Promise<string> {
    const owner = OWNER.publicKey();
    const entry = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
            new xdr.SorobanAddressCredentials({
                address: new Address(owner).toScAddress(),
                nonce: xdr.Int64.fromString("42"),
                signatureExpirationLedger: opts.expiry ?? 1_000,
                signature: xdr.ScVal.scvVec([]),
            })
        ),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                new xdr.InvokeContractArgs({
                    contractAddress: new Address(opts.keystore ?? KEYSTORE).toScAddress(),
                    functionName: "set_auth_policy",
                    args: [new Address(owner).toScVal(), u256(opts.nkh ?? 1n), u256(2n)],
                })
            ),
            subInvocations: [],
        }),
    });
    const signed = await authorizeEntry(entry, opts.signer ?? OWNER, opts.expiry ?? 1_000, PASSPHRASE);
    return `0x${signed.toXDR().toString("hex")}`;
}

function fakeCommitment(overrides: Partial<StellarWithdrawalFeeCommitment> = {}): StellarWithdrawalFeeCommitment {
    return {
        data: "0x00",
        asset: ASSET,
        expiration: Date.now() + 10_000_000_000,
        feeAmount: 100n,
        recipient: RECIPIENT,
        amountSent: 1_000_000n,
        amountReceived: 999_900n,
        ...overrides,
    };
}

describe("StellarChainService", () => {
    let service: StellarChainService;
    const mockConfigService = {
        rpcUrl: jest.fn().mockReturnValue("https://soroban-rpc.example"),
        networkPassphrase: jest.fn().mockReturnValue("Test SDF Network ; September 2015"),
        signerSecretKey: jest.fn().mockReturnValue(SIGNER.secret()),
        poolContractId: jest.fn().mockReturnValue("CPOOL00000000000000000000000000000000000000000000000000000"),
        relayContractId: jest.fn().mockReturnValue(RELAY_CONTRACT),
        keystoreContractId: jest.fn().mockReturnValue(KEYSTORE),
    };

    beforeEach(async () => {
        jest.clearAllMocks();
        simulateRead.mockReset();
        buildTransaction.mockReset();
        submitTransaction.mockReset();
        sendTransaction.mockReset();
        waitForTransactionReceipt.mockReset().mockResolvedValue({ status: true });

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StellarChainService,
                { provide: StellarConfigService, useValue: mockConfigService },
                createMockLoggerProvider(),
                { provide: CHAIN_CONTEXT, useValue: { chainType: ChainType.STELLAR, chainId: 1 } },
            ],
        }).compile();

        service = await module.resolve<StellarChainService>(StellarChainService);
    });

    it("signs a withdrawal commitment and verifies it round-trip", async () => {
        const commitment = fakeCommitment();
        const signature = await service.signRelayWithdrawalCommitment(commitment);

        expect(signature).toMatch(/^0x[0-9a-f]+$/);

        const verified = await service.verifyRelayWithdrawalCommitment({ ...commitment, signedRelayerCommitment: signature });
        expect(verified).toBe(true);
    });

    it("reject a commitment tampered after signing", async () => {
        // Tamper amountSent — one of the fields the signature actually covers directly
        // (commitmentBytes). feeAmount itself is only bound indirectly via `data` (the
        // encoded PayoutRouting), exactly mirroring EVM's EIP-712 message shape, which
        // likewise signs {data, asset, expiration, amountSent, amountReceived} and never a
        // separate feeAmount field — the real payout is always decoded from `data`.
        const commitment = fakeCommitment();
        const signature = await service.signRelayWithdrawalCommitment(commitment);

        const verified = await service.verifyRelayWithdrawalCommitment({
            ...commitment,
            amountSent: commitment.amountSent + 1n,
            signedRelayerCommitment: signature,
        });
        expect(verified).toBe(false);
    });

    it("reject a commitment signed by a different signer", async () => {
        const commitment = fakeCommitment();
        const signature = await service.signRelayWithdrawalCommitment(commitment);

        mockConfigService.signerSecretKey.mockReturnValueOnce(Keypair.random().secret());
        const verified = await service.verifyRelayWithdrawalCommitment({ ...commitment, signedRelayerCommitment: signature });
        expect(verified).toBe(false);
    });

    it("throw BadRequestException when verifying an expired commitment", async () => {
        const commitment = fakeCommitment({ expiration: Date.now() - 1000 });
        await expect(
            service.verifyRelayWithdrawalCommitment({ ...commitment, signedRelayerCommitment: "0x00" })
        ).rejects.toThrow("Fee commitment has expired");
    });

    it("read the pool's max_relay_fee via get_asset_config", async () => {
        simulateRead.mockResolvedValue({
            enabled: true,
            min_deposit_amount: 0n,
            vetting_fee_bps: 0,
            max_relay_fee: 500n,
        });

        const config = await service.getAssetConfig(ASSET);

        expect(config.maxRelayFee).toBe(500n);
        expect(simulateRead).toHaveBeenCalledWith(
            mockConfigService.poolContractId(),
            "get_asset_config",
            expect.anything(),
            expect.any(String)
        );
    });

    it("throw ServiceUnavailableException when get_asset_config returns a malformed shape", async () => {
        simulateRead.mockResolvedValue({ not: "an asset config" });
        await expect(service.getAssetConfig(ASSET)).rejects.toThrow("Expected an AssetConfig struct");
    });

    it("submit a relay transaction and return the tx hash", async () => {
        buildTransaction.mockResolvedValue("unsigned-xdr");
        sendTransaction.mockResolvedValue("0xabc123");

        const result = await service.submitRelay({
            n: 1,
            m: 1,
            proof: { a: "0x00", b: "0x00", c: "0x00" },
            stateRoot: 1n,
            keystoreRoot: 2n,
            aspRoot: 3n,
            amountOut: 1000n,
            tokenIdOut: 4n,
            nullifierHashes: [5n],
            outputCommitments: [6n],
            asset: ASSET,
            noteData: [],
            routing: { recipient: RECIPIENT, feeRecipient: RECIPIENT, feeAmount: 100n },
        });

        expect(result.txHash).toBe("0xabc123");
        expect(buildTransaction).toHaveBeenCalledWith(RELAY_CONTRACT, "relay", expect.any(Array), expect.any(String));
        expect(sendTransaction).toHaveBeenCalledWith("unsigned-xdr");
    });

    describe("concurrent relays from the one signer", () => {
        const relayParams = () => ({
            n: 1,
            m: 1,
            proof: { a: "0x00", b: "0x00", c: "0x00" } as never,
            stateRoot: 1n,
            keystoreRoot: 2n,
            aspRoot: 3n,
            amountOut: 1000n,
            tokenIdOut: 4n,
            nullifierHashes: [5n],
            outputCommitments: [6n],
            asset: ASSET,
            noteData: [],
            routing: { recipient: RECIPIENT, feeRecipient: RECIPIENT, feeAmount: 100n },
        });
        const flush = () => new Promise((resolve) => setImmediate(resolve));

        it("build the second relay only after the first is confirmed, so it reads the advanced sequence", async () => {
            let confirmFirst!: () => void;
            waitForTransactionReceipt.mockImplementationOnce(
                () => new Promise((resolve) => (confirmFirst = () => resolve({ status: true })))
            );
            buildTransaction.mockResolvedValue("unsigned-xdr");
            sendTransaction.mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond");

            const first = service.submitRelay(relayParams());
            const second = service.submitRelay(relayParams());
            await flush();
            await flush();

            expect(buildTransaction).toHaveBeenCalledTimes(1);
            confirmFirst();

            expect((await first).txHash).toBe("0xfirst");
            expect((await second).txHash).toBe("0xsecond");
            expect(buildTransaction).toHaveBeenCalledTimes(2);
        });

        it("return the hash, and release the signer, when the transaction fails on-chain", async () => {
            buildTransaction.mockResolvedValue("unsigned-xdr");
            sendTransaction.mockResolvedValueOnce("0xfailed").mockResolvedValueOnce("0xnext");
            waitForTransactionReceipt.mockRejectedValueOnce(new Error("Transaction failed: txFailed"));

            expect((await service.submitRelay(relayParams())).txHash).toBe("0xfailed");
            expect((await service.submitRelay(relayParams())).txHash).toBe("0xnext");
        });
    });

    it("throw ServiceUnavailableException when the relay submission fails", async () => {
        buildTransaction.mockRejectedValue(new Error("RPC down"));

        await expect(
            service.submitRelay({
                n: 1,
                m: 1,
                proof: { a: "0x00", b: "0x00", c: "0x00" },
                stateRoot: 1n,
                keystoreRoot: 2n,
                aspRoot: 3n,
                amountOut: 1000n,
                tokenIdOut: 4n,
                nullifierHashes: [],
                outputCommitments: [],
                asset: ASSET,
                noteData: [],
                routing: { recipient: RECIPIENT, feeRecipient: RECIPIENT, feeAmount: 0n },
            })
        ).rejects.toThrow();
    });
    describe("parseRegistrationEntry", () => {
        const registration = async (opts: Parameters<typeof signedEntry>[0] = {}) => ({
            account: OWNER.publicKey(),
            nullifyingKeyHash: "0x01" as const,
            authDigest: "0x02" as const,
            signature: (await signedEntry(opts)) as `0x${string}`,
        });

        beforeEach(() => getLatestLedger.mockResolvedValue("0x64")); // ledger 100

        it("accept the owner's entry over this keystore's set_auth_policy with the registration's args", async () => {
            const entry = await service.parseRegistrationEntry(await registration());
            expect(entry.credentials().address().signatureExpirationLedger()).toBe(1_000);
        });

        it("reject an entry another account signed for", async () => {
            const reg = { ...(await registration()), account: Keypair.random().publicKey() };
            await expect(service.parseRegistrationEntry(reg)).rejects.toThrow("not signed by registration.account");
        });

        it("reject an entry over another keystore", async () => {
            await expect(
                service.parseRegistrationEntry(await registration({ keystore: StrKey.encodeContract(Buffer.alloc(32, 8)) }))
            ).rejects.toThrow("must authorize exactly this keystore's set_auth_policy");
        });

        it("reject an entry whose args differ from the registration", async () => {
            await expect(service.parseRegistrationEntry(await registration({ nkh: 9n }))).rejects.toThrow(
                "must authorize exactly this keystore's set_auth_policy"
            );
        });

        it("reject an expired entry", async () => {
            await expect(service.parseRegistrationEntry(await registration({ expiry: 100 }))).rejects.toThrow("expired");
        });

        it("reject bytes that are not an authorization entry", async () => {
            const reg = { ...(await registration()), signature: "0xdeadbeef" as const };
            await expect(service.parseRegistrationEntry(reg)).rejects.toThrow("not a Soroban authorization entry");
        });
    });

    describe("batch and transfer commitments", () => {
        const batch = {
            data: "0x00" as const,
            asset: ASSET,
            expiration: Date.now() + 10_000_000,
            totalFee: 200n,
            maxRelayFee: 0n,
            relayCost: 0n,
            feeBps: 0n,
            flatFee: 100n,
        };

        it("verify a batch commitment round-trip and reject one tampered after signing", async () => {
            const signedRelayerCommitment = await service.signBatchCommitment(batch);

            await expect(service.verifyBatchCommitment({ ...batch, signedRelayerCommitment })).resolves.toBe(true);
            await expect(
                service.verifyBatchCommitment({ ...batch, totalFee: 201n, signedRelayerCommitment })
            ).resolves.toBe(false);
        });

        it("never accept a transfer signature as a batch one, or vice versa (distinct domain tags)", async () => {
            const transfer = { data: "0x00" as const, asset: ASSET, expiration: batch.expiration, feeAmount: 200n };
            const transferSig = await service.signTransferCommitment(transfer);
            const batchSig = await service.signBatchCommitment(batch);

            await expect(service.verifyTransferCommitment({ ...transfer, signedRelayerCommitment: transferSig })).resolves.toBe(true);
            await expect(service.verifyBatchCommitment({ ...batch, signedRelayerCommitment: transferSig })).resolves.toBe(false);
            await expect(service.verifyTransferCommitment({ ...transfer, signedRelayerCommitment: batchSig })).resolves.toBe(false);
        });
    });
});
