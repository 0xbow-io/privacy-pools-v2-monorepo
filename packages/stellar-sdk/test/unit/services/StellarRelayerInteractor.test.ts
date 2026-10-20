import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Hex,
    IHTTPClient,
    IProofService,
    ProofResult,
    RelayerInfo,
    StellarAddress,
    StellarProof,
    StellarRelayerInteractorConfig,
    WithdrawalQuoteParams,
    WithdrawalRelayParams,
} from "../../../src/internal.js";
import {
    FeeCommitmentExpired,
    RelayerRejected,
    RelayerRequestFailed,
    StellarAddressSchema,
    StellarRelayerInteractor,
} from "../../../src/internal.js";

const RELAYER_ACCOUNT = Keypair.random().publicKey();
const PROCESSOR_ACCOUNT = Keypair.random().publicKey();
const ASSET_CONTRACT = Keypair.random().publicKey();
const RECIPIENT_ACCOUNT = Keypair.random().publicKey();
const POOL_CONTRACT = Keypair.random().publicKey();
const RELAY_CONTRACT = Keypair.random().publicKey();

function hex32(byte: number): Hex {
    return (`0x` + byte.toString(16).padStart(2, "0").repeat(32)) as Hex;
}

function createMockHttpClient(): IHTTPClient {
    return {
        get: vi.fn(),
        post: vi.fn(),
        getBinary: vi.fn(),
    };
}

function createMockProofService(): IProofService<StellarProof> {
    return {
        loadCircuit: vi.fn(),
        proveDeposit: vi.fn(),
        proveTransact: vi.fn(),
        proveRagequit: vi.fn(),
        verifyDeposit: vi.fn(),
        verifyTransact: vi.fn(),
        verifyRagequit: vi.fn(),
        formatForChain: vi.fn((proofResult: ProofResult) => ({
            a: "0xaa" as Hex,
            b: "0xbb" as Hex,
            c: "0xcc" as Hex,
            pubSignals: proofResult.publicSignals.map((s) => BigInt(s)),
        })),
    };
}

function createMockRelayerInfo(): RelayerInfo<StellarAddress> {
    return {
        url: "https://relayer1.example.com",
        name: "Test Stellar Relayer",
        chainId: 1,
        chainType: "stellar",
        status: "active",
        address: RELAYER_ACCOUNT,
        processorAddress: PROCESSOR_ACCOUNT,
    };
}

/** A well-formed transact proof for n=1 input, m=1 output (8 public signals total). */
function createTransactProofResult(): ProofResult {
    return {
        proof: { pi_a: [], pi_b: [], pi_c: [], protocol: "groth16", curve: "bn128" },
        publicSignals: [
            hex32(1), // nullifier[0]
            hex32(2), // outputCommitment[0]
            hex32(3), // stateRoot
            hex32(4), // keystoreRoot
            hex32(5), // associationSetRoot
            hex32(6), // amountOut
            hex32(7), // tokenIdOut
            hex32(8), // context
        ],
    };
}

const COMMITMENT_DATA = ("0x" + "11".repeat(64)) as Hex;
const COMMITMENT_SIGNATURE = ("0x" + "22".repeat(64)) as Hex;

function fakeQuoteResponse(overrides: Record<string, unknown> = {}) {
    return {
        feeAmount: "5",
        amountSent: "1000",
        amountReceived: "995",
        feeCommitment: {
            data: COMMITMENT_DATA,
            asset: ASSET_CONTRACT,
            expiration: Date.now() + 60_000,
            feeAmount: "5",
            recipient: RECIPIENT_ACCOUNT,
            amountSent: "1000",
            amountReceived: "995",
            signedRelayerCommitment: COMMITMENT_SIGNATURE,
        },
        ...overrides,
    };
}

describe("StellarRelayerInteractor", () => {
    let httpClient: IHTTPClient;
    let proofService: IProofService<StellarProof>;
    let interactor: StellarRelayerInteractor;
    const relayer = createMockRelayerInfo();

    beforeEach(() => {
        httpClient = createMockHttpClient();
        proofService = createMockProofService();
        const config: StellarRelayerInteractorConfig = {
            relayers: [relayer],
            httpClient,
            addressSchema: StellarAddressSchema,
            proofService,
        };
        interactor = new StellarRelayerInteractor(config);
    });

    describe("getRelayers", () => {
        it("return the configured relayers", async () => {
            await expect(interactor.getRelayers()).resolves.toEqual([relayer]);
        });
    });

    describe("getChainDetails", () => {
        function fakeChainDetailsResponse(overrides: Record<string, unknown> = {}) {
            return {
                id: 1,
                name: "stellar-testnet",
                type: "stellar",
                contracts: { entrypoint: POOL_CONTRACT, poolVault: POOL_CONTRACT, relay: RELAY_CONTRACT },
                swapsSupported: false,
                assets: [{ address: ASSET_CONTRACT, ticker: "USDC" }],
                relayerAddress: RELAYER_ACCOUNT,
                ...overrides,
            };
        }

        it("fetch and validate chain details from /v1/details/stellar/:chainId", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce(fakeChainDetailsResponse());

            const details = await interactor.getChainDetails(relayer);

            expect(httpClient.get).toHaveBeenCalledWith("https://relayer1.example.com/v1/details/stellar/1");
            expect(details.contracts.relay).toBe(RELAY_CONTRACT);
            expect(details.relayerAddress).toBe(RELAYER_ACCOUNT);
        });

        it("reject when the relayer answers for a different chain id", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce(fakeChainDetailsResponse({ id: 2 }));

            await expect(interactor.getChainDetails(relayer)).rejects.toThrow(RelayerRequestFailed);
        });

        it("reject a malformed response", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({ not: "chain details" });

            await expect(interactor.getChainDetails(relayer)).rejects.toThrow(RelayerRequestFailed);
        });
    });

    describe("getTransferQuote", () => {
        it("reject with RelayerRequestFailed, unsupported on Stellar", async () => {
            await expect(
                interactor.getTransferQuote(relayer, { asset: ASSET_CONTRACT, commit: true }),
            ).rejects.toThrow(RelayerRequestFailed);
        });
    });

    describe("getWithdrawalQuote", () => {
        function createParams(overrides: Partial<WithdrawalQuoteParams<StellarAddress>> = {}) {
            return {
                asset: ASSET_CONTRACT,
                commit: true,
                recipient: RECIPIENT_ACCOUNT,
                extraGas: false,
                amount: "1000",
                ...overrides,
            };
        }

        it("post amount/asset/recipient/commit to /v1/quote/stellar/:chainId/receive", async () => {
            vi.mocked(httpClient.post).mockResolvedValueOnce(fakeQuoteResponse());

            const quote = await interactor.getWithdrawalQuote(relayer, createParams());

            expect(httpClient.post).toHaveBeenCalledWith(
                "https://relayer1.example.com/v1/quote/stellar/1/receive",
                { amount: "1000", asset: ASSET_CONTRACT, recipient: RECIPIENT_ACCOUNT, commit: true },
            );
            expect(quote.txCost).toBe("0");
            expect(quote.gasPrice).toBe("0");
            expect(quote.feeAmount).toBe("5");
            expect(quote.amountSent).toBe("1000");
            expect(quote.amountReceived).toBe("995");
            expect(quote.feeCommitment.recipient).toBe(RECIPIENT_ACCOUNT);
            expect(quote.feeCommitment.data).toBe(COMMITMENT_DATA);
            expect(quote.feeCommitment.signedRelayerCommitment).toBe(COMMITMENT_SIGNATURE);
            expect(quote.feeCommitment.extraGas).toBe(false);
        });

        it("reject extraGas requests, Stellar's PayoutRouting has no native_gas field", async () => {
            await expect(
                interactor.getWithdrawalQuote(relayer, createParams({ extraGas: true })),
            ).rejects.toThrow(RelayerRequestFailed);
            expect(httpClient.post).not.toHaveBeenCalled();
        });

        it("reject when the relayer returns no fee commitment", async () => {
            vi.mocked(httpClient.post).mockResolvedValueOnce(
                fakeQuoteResponse({ feeCommitment: undefined }),
            );

            await expect(interactor.getWithdrawalQuote(relayer, createParams())).rejects.toThrow(
                RelayerRequestFailed,
            );
        });

        it("reject a malformed response", async () => {
            vi.mocked(httpClient.post).mockResolvedValueOnce({ not: "a quote" });

            await expect(interactor.getWithdrawalQuote(relayer, createParams())).rejects.toThrow(
                RelayerRequestFailed,
            );
        });
    });

    describe("relayWithdrawal", () => {
        async function quoteThenBuildParams(): Promise<WithdrawalRelayParams<StellarAddress>> {
            vi.mocked(httpClient.post).mockResolvedValueOnce(fakeQuoteResponse());
            const quote = await interactor.getWithdrawalQuote(relayer, {
                asset: ASSET_CONTRACT,
                commit: true,
                recipient: RECIPIENT_ACCOUNT,
                extraGas: false,
                amount: "1000",
            });
            vi.mocked(httpClient.post).mockReset();

            return {
                proof: createTransactProofResult(),
                noteData: [{ hint: hex32(9), data: "0xaa" as Hex }],
                signedFeeCommitment: quote.feeCommitment,
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            };
        }

        it("post the formatted proof + commitment to /v1/relay/stellar/:chainId/withdrawal and return the tx hash", async () => {
            const params = await quoteThenBuildParams();
            const txHash = ("0x" + "ab".repeat(32)) as Hex;
            vi.mocked(httpClient.post).mockResolvedValueOnce({ txHash });

            const hash = await interactor.relayWithdrawal(relayer, params);

            expect(hash).toBe(txHash);
            expect(httpClient.post).toHaveBeenCalledWith(
                "https://relayer1.example.com/v1/relay/stellar/1/withdrawal",
                {
                    proof: {
                        a: "0xaa",
                        b: "0xbb",
                        c: "0xcc",
                        publicSignals: createTransactProofResult().publicSignals,
                    },
                    inputNullifierNumber: 1,
                    outputCommitmentNumber: 1,
                    noteData: params.noteData,
                    signedFeeCommitment: params.signedFeeCommitment,
                },
            );
        });

        it("forward a yield router processorAddress and the underlying floor to the relayer", async () => {
            const params = await quoteThenBuildParams();
            vi.mocked(httpClient.post).mockResolvedValueOnce({ txHash: ("0x" + "ab".repeat(32)) as Hex });

            await interactor.relayWithdrawal(relayer, {
                ...params,
                processorAddress: PROCESSOR_ACCOUNT,
                minUnderlyingOut: "0x64" as Hex,
            });

            expect(httpClient.post).toHaveBeenCalledWith(
                "https://relayer1.example.com/v1/relay/stellar/1/withdrawal",
                expect.objectContaining({ processorAddress: PROCESSOR_ACCOUNT, minUnderlyingOut: "100" }),
            );
        });

        it("reject an expired fee commitment before posting", async () => {
            const params = await quoteThenBuildParams();
            await expect(
                interactor.relayWithdrawal(relayer, {
                    ...params,
                    signedFeeCommitment: { ...params.signedFeeCommitment, expiration: Date.now() - 1 },
                }),
            ).rejects.toThrow(FeeCommitmentExpired);
            expect(httpClient.post).not.toHaveBeenCalled();
        });

        it("reject when the relayer responds with an error", async () => {
            const params = await quoteThenBuildParams();
            vi.mocked(httpClient.post).mockResolvedValueOnce({
                txHash: ("0x" + "00".repeat(32)) as Hex,
                error: "insufficient balance",
            });

            await expect(interactor.relayWithdrawal(relayer, params)).rejects.toThrow(RelayerRejected);
        });

        it("reject a malformed response", async () => {
            const params = await quoteThenBuildParams();
            vi.mocked(httpClient.post).mockResolvedValueOnce({ not: "a relay response" });

            await expect(interactor.relayWithdrawal(relayer, params)).rejects.toThrow(RelayerRejected);
        });
    });

    describe("unsupported operations", () => {
        it("reject getBatchWithdrawalQuote, the relay contract has no batch entrypoint", async () => {
            await expect(
                interactor.getBatchWithdrawalQuote(relayer, {
                    asset: ASSET_CONTRACT,
                    commit: true,
                    recipient: RECIPIENT_ACCOUNT,
                    extraGas: false,
                    amounts: ["1", "2"],
                }),
            ).rejects.toThrow(RelayerRequestFailed);
        });

        it("reject relayBatchWithdrawal, the relay contract has no batch entrypoint", async () => {
            await expect(
                interactor.relayBatchWithdrawal(relayer, {
                    items: [],
                    signedBatchFeeCommitment: {
                        data: "0x" as Hex,
                        asset: "0x" as Hex,
                        expiration: Date.now() + 60_000,
                        totalFee: "0",
                        maxRelayFee: "0",
                        relayCost: "0",
                        feeBps: "0",
                        flatFee: "0",
                        signedRelayerCommitment: "0x" as Hex,
                    },
                }),
            ).rejects.toThrow(RelayerRejected);
        });

        it("reject relayTransfer, private transfers have no relayer route on Stellar", async () => {
            await expect(
                interactor.relayTransfer(relayer, {
                    proof: createTransactProofResult(),
                    noteData: [],
                    signedFeeCommitment: {
                        data: "0x" as Hex,
                        asset: ASSET_CONTRACT,
                        expiration: Date.now() + 60_000,
                        feeAmount: "0",
                        signedRelayerCommitment: "0x" as Hex,
                    },
                    inputNullifierNumber: 1,
                    outputCommitmentNumber: 1,
                }),
            ).rejects.toThrow(RelayerRejected);
        });

        it("reject submitRelayedRegistration, no standalone registration route", async () => {
            await expect(
                interactor.submitRelayedRegistration(relayer, {
                    account: RECIPIENT_ACCOUNT,
                    authDigest: "0x" as Hex,
                    nullifyingKeyHash: "0x" as Hex,
                    deadline: "0x0" as Hex,
                    signature: "0x" as Hex,
                }),
            ).rejects.toThrow(RelayerRequestFailed);
        });

        it("reject relayWithAnnounce, ERC-5564 stealth announcements have no Soroban counterpart", async () => {
            const params = await quoteThenBuildParamsForAnnounce();
            await expect(interactor.relayWithAnnounce(relayer, params)).rejects.toThrow(RelayerRejected);
        });

        it("reject getSwapQuote, the swap subsystem is EVM-only", async () => {
            await expect(
                interactor.getSwapQuote(relayer, {
                    asset: ASSET_CONTRACT,
                    commit: true,
                    recipient: RECIPIENT_ACCOUNT,
                    amount: "1",
                    outputToken: ASSET_CONTRACT,
                    minOutputAmount: "1",
                    dustRecipient: RECIPIENT_ACCOUNT,
                }),
            ).rejects.toThrow(RelayerRequestFailed);
        });

        it("reject relaySwap, the swap subsystem is EVM-only", async () => {
            await expect(
                interactor.relaySwap(relayer, {
                    proof: createTransactProofResult(),
                    noteData: [],
                    signedSwapCommitment: {
                        data: "0x" as Hex,
                        asset: "0x" as Hex,
                        expiration: Date.now() + 60_000,
                        feeAmount: "0",
                        signedRelayerCommitment: "0x" as Hex,
                        recipient: "0x" as Hex,
                        amountSent: "0",
                    },
                    inputNullifierNumber: 1,
                    outputCommitmentNumber: 1,
                }),
            ).rejects.toThrow(RelayerRejected);
        });

        async function quoteThenBuildParamsForAnnounce(): Promise<
            import("../../../src/internal.js").RelayAndAnnounceRelayParams<StellarAddress>
        > {
            return {
                proof: createTransactProofResult(),
                noteData: [],
                signedFeeCommitment: {
                    data: "0x" as Hex,
                    asset: ASSET_CONTRACT,
                    expiration: Date.now() + 60_000,
                    feeAmount: "0",
                    signedRelayerCommitment: "0x" as Hex,
                    recipient: RECIPIENT_ACCOUNT,
                    amountSent: "0",
                    amountReceived: "0",
                    extraGas: false,
                },
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
                announcement: {
                    schemeId: "0x0001" as Hex,
                    stealthAddress: RECIPIENT_ACCOUNT,
                    ephemeralPubKey: "0x" as Hex,
                    metadata: "0x" as Hex,
                },
            };
        }

        it("reject relayRegisterAndWithdrawal, no atomic register-and-relay route", async () => {
            await expect(
                interactor.relayRegisterAndWithdrawal(relayer, {
                    proof: createTransactProofResult(),
                    noteData: [],
                    signedFeeCommitment: {
                        data: "0x" as Hex,
                        asset: ASSET_CONTRACT,
                        expiration: Date.now() + 60_000,
                        feeAmount: "0",
                        signedRelayerCommitment: "0x" as Hex,
                        recipient: RECIPIENT_ACCOUNT,
                        amountSent: "0",
                        amountReceived: "0",
                        extraGas: false,
                    },
                    inputNullifierNumber: 1,
                    outputCommitmentNumber: 1,
                    registration: {
                        account: RECIPIENT_ACCOUNT,
                        authDigest: "0x" as Hex,
                        nullifyingKeyHash: "0x" as Hex,
                        deadline: "0x0" as Hex,
                        signature: "0x" as Hex,
                    },
                }),
            ).rejects.toThrow(RelayerRejected);
        });
    });
});
