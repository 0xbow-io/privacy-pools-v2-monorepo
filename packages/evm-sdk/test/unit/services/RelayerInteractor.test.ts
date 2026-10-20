import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    BatchFeeCommitment,
    BatchWithdrawalQuoteParams,
    BatchWithdrawalRelayerQuote,
    BatchWithdrawalRelayParams,
    FeeCommitment,
    Hex,
    IHTTPClient,
    RegisterAndWithdrawalRelayParams,
    RegisterKeystoreRelayParams,
    RelayAndAnnounceRelayParams,
    RelayerInfo,
    RelayerInteractorConfig,
    SwapQuoteParams,
    SwapRelayerQuote,
    TransferQuoteParams,
    TransferRelayerQuote,
    TransferRelayParams,
    WithdrawalFeeCommitment,
    WithdrawalQuoteParams,
    WithdrawalRelayerQuote,
    WithdrawalRelayParams,
} from "../../../src/internal.js";
import {
    AddressSchema,
    InvalidRelayerConfig,
    RelayerInteractor,
    RelayerRejected,
    RelayerRequestFailed,
    relayerCapsFromDetails,
    WithdrawalRelayParamsSchema,
} from "../../../src/internal.js";

function createMockHttpClient(): IHTTPClient {
    return {
        get: vi.fn(),
        post: vi.fn(),
        getBinary: vi.fn(),
    };
}

function createMockRelayerInfo(overrides?: Partial<RelayerInfo>): RelayerInfo {
    return {
        url: "https://relayer1.example.com",
        name: "Test Relayer",
        chainId: 1,
        chainType: "evm",
        status: "active",
        address: "0x1234567890abcdef1234567890abcdef12345678" as Hex,
        processorAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Hex,
        ...overrides,
    };
}

const DEFAULT_RELAYERS = [createMockRelayerInfo()];

function createDefaultConfig(
    httpClient: IHTTPClient,
    overrides?: Partial<RelayerInteractorConfig>,
): RelayerInteractorConfig {
    return {
        relayers: DEFAULT_RELAYERS,
        httpClient,
        addressSchema: AddressSchema,
        ...overrides,
    };
}

function createMockFeeCommitment(overrides?: Partial<FeeCommitment>): FeeCommitment {
    return {
        data: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
        asset: "0xcccccccccccccccccccccccccccccccccccccccc" as Hex,
        expiration: Date.now() + 60000,
        feeAmount: "100",
        signedRelayerCommitment: "0xeeff" as Hex,
        ...overrides,
    };
}

function createMockWithdrawalFeeCommitment(
    overrides?: Partial<WithdrawalFeeCommitment>,
): WithdrawalFeeCommitment {
    return {
        ...createMockFeeCommitment(),
        recipient: "0x1234123412341234123412341234123412341234" as Hex,
        amountSent: "1000",
        amountReceived: "900",
        extraGas: false,
        ...overrides,
    };
}

function createMockProof(): {
    proof: { pi_a: Hex[]; pi_b: Hex[][]; pi_c: Hex[]; protocol: string; curve: string };
    publicSignals: Hex[];
} {
    return {
        proof: {
            pi_a: ["0x01" as Hex, "0x02" as Hex, "0x03" as Hex],
            pi_b: [
                ["0x04" as Hex, "0x05" as Hex],
                ["0x06" as Hex, "0x07" as Hex],
                ["0x08" as Hex, "0x09" as Hex],
            ],
            pi_c: ["0x0a" as Hex, "0x0b" as Hex, "0x0c" as Hex],
            protocol: "groth16",
            curve: "bn128",
        },
        publicSignals: ["0xaa" as Hex, "0xbb" as Hex],
    };
}

function createMockBatchFeeCommitment(overrides?: Partial<BatchFeeCommitment>): BatchFeeCommitment {
    return {
        data: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
        asset: "0xcccccccccccccccccccccccccccccccccccccccc" as Hex,
        expiration: Date.now() + 60000,
        totalFee: "30",
        maxRelayFee: "100",
        relayCost: "10",
        feeBps: "1000",
        flatFee: "0",
        signedRelayerCommitment: "0xeeff" as Hex,
        ...overrides,
    };
}

function createMockBatchQuote(
    overrides?: Partial<BatchWithdrawalRelayerQuote>,
): BatchWithdrawalRelayerQuote {
    return {
        txCost: "21000",
        gasPrice: "20000000000",
        totalFee: "30",
        maxRelayFee: "100",
        feeCommitment: createMockBatchFeeCommitment(),
        ...overrides,
    };
}

function createMockBatchRelayParams(
    overrides?: Partial<BatchWithdrawalRelayParams>,
): BatchWithdrawalRelayParams {
    return {
        items: [
            {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            },
            {
                proof: createMockProof(),
                noteData: [{ hint: "0x02" as Hex, data: "0xfedcba" as Hex }],
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            },
        ],
        signedBatchFeeCommitment: createMockBatchFeeCommitment(),
        ...overrides,
    };
}

describe("RelayerInteractor", () => {
    let mockHttpClient: IHTTPClient;

    beforeEach(() => {
        vi.clearAllMocks();
        mockHttpClient = createMockHttpClient();
    });

    describe("constructor", () => {
        it("create instance with valid config", () => {
            expect(() => new RelayerInteractor(createDefaultConfig(mockHttpClient))).not.toThrow();
        });

        it("apply default values for optional config fields", () => {
            const interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
            expect(interactor).toBeDefined();
        });

        it("throw InvalidRelayerConfig for empty relayers array", () => {
            expect(
                () =>
                    new RelayerInteractor({
                        relayers: [],
                        httpClient: mockHttpClient,
                        addressSchema: AddressSchema,
                    }),
            ).toThrow(InvalidRelayerConfig);
        });

        it("throw InvalidRelayerConfig for invalid relayer entry", () => {
            expect(
                () =>
                    new RelayerInteractor({
                        relayers: [
                            {
                                url: "not-a-url",
                                name: "Bad",
                                chainId: 1,
                                chainType: "evm",
                                status: "active",
                                address: "0x1234567890abcdef1234567890abcdef12345678" as Hex,
                                processorAddress:
                                    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Hex,
                            } as RelayerInfo,
                        ],
                        httpClient: mockHttpClient,
                        addressSchema: AddressSchema,
                    }),
            ).toThrow(InvalidRelayerConfig);
        });
    });

    describe("getRelayers", () => {
        it("return relayers provided at construction", async () => {
            const relayers = [
                createMockRelayerInfo({ name: "Relayer A" }),
                createMockRelayerInfo({ name: "Relayer B", url: "https://relayer2.example.com" }),
            ];
            const interactor = new RelayerInteractor({
                relayers,
                httpClient: mockHttpClient,
                addressSchema: AddressSchema,
            });

            const result = await interactor.getRelayers();

            expect(result).toHaveLength(2);
            expect(result[0]!.name).toBe("Relayer A");
            expect(result[1]!.name).toBe("Relayer B");
        });

        it("return single relayer when only one provided", async () => {
            const interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));

            const result = await interactor.getRelayers();

            expect(result).toHaveLength(1);
            expect(result[0]!.name).toBe("Test Relayer");
        });
    });

    describe("getChainDetails", () => {
        const details = {
            id: 1,
            name: "mainnet",
            type: "evm",
            contracts: {
                entrypoint: "0x00000000000000000000000000000000000000e1",
                poolVault: "0x00000000000000000000000000000000000000e2",
                relay: "0x00000000000000000000000000000000000000e3",
                relaySwaps: "0x00000000000000000000000000000000000000e4",
            },
            swapsSupported: true,
            assets: [
                {
                    address: "0x00000000000000000000000000000000000000a1",
                    ticker: "USDC",
                    fixedFeeAmount: "21000",
                },
            ],
            relayerAddress: "0x00000000000000000000000000000000000000f1",
            processors: ["0x00000000000000000000000000000000000000d1"],
            yield: [
                {
                    ppToken: "0x00000000000000000000000000000000000000b1",
                    underlying: "0x00000000000000000000000000000000000000a1",
                    router: "0x00000000000000000000000000000000000000d1",
                    zap: "0x00000000000000000000000000000000000000c1",
                    ppDecimals: 18,
                    underlyingDecimals: 6,
                    underlyingSymbol: "USDC",
                },
            ],
        };

        it("GETs /v1/details/{chainType}/{chainId} and returns the validated details", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue(details);
            const interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));

            const result = await interactor.getChainDetails(createMockRelayerInfo());

            expect(mockHttpClient.get).toHaveBeenCalledWith(
                "https://relayer1.example.com/v1/details/evm/1",
            );
            expect(result.contracts.relay).toBe(details.contracts.relay);
            expect(result.yield?.[0]?.router).toBe(details.processors[0]);
            expect(result.relayerAddress).toBe(details.relayerAddress);
        });

        it("accepts a relayer that predates discovery (no relayerAddress / processors / yield)", async () => {
            const { relayerAddress: _a, processors: _p, yield: _y, ...legacy } = details;
            vi.mocked(mockHttpClient.get).mockResolvedValue(legacy);
            const interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));

            const result = await interactor.getChainDetails(createMockRelayerInfo());

            expect(result.yield).toBeUndefined();
            expect(result.contracts.relaySwaps).toBe(details.contracts.relaySwaps);
        });

        it("parses destinationCallsSupported, and leaves it undefined on a relayer predating it", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValueOnce({ ...details, destinationCallsSupported: false });
            const interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));

            expect((await interactor.getChainDetails(createMockRelayerInfo())).destinationCallsSupported).toBe(false);

            vi.mocked(mockHttpClient.get).mockResolvedValueOnce(details);
            expect((await interactor.getChainDetails(createMockRelayerInfo())).destinationCallsSupported).toBeUndefined();
        });

        it("parses the published cap, which relayerCapsFromDetails reads as a bigint", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({ ...details, maxSwapValueWei: "5000000000000000" });
            const interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));

            const result = await interactor.getChainDetails(createMockRelayerInfo());

            expect(relayerCapsFromDetails(result)).toEqual({ maxSwapValueWei: 5_000_000_000_000_000n });
            // A relayer predating cap publication: unknown, not unlimited.
            expect(relayerCapsFromDetails(details as never)).toEqual({ maxSwapValueWei: undefined });
        });

        it.each([
            ["a 0x hex string", "0x11c37937e08000", 5_000_000_000_000_000n],
            ["a safe-integer JSON number", 5_000_000_000_000_000, 5_000_000_000_000_000n],
            ["a precision-lost JSON number", 1e30, undefined],
            ["garbage", "5 ETH", undefined],
        ])("normalizes or drops %s without failing discovery", async (_label, wire, expected) => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({ ...details, maxSwapValueWei: wire });
            const interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));

            const result = await interactor.getChainDetails(createMockRelayerInfo());

            expect(relayerCapsFromDetails(result)).toEqual({ maxSwapValueWei: expected });
            expect(result.relayerAddress).toBe(details.relayerAddress);
            expect(result.yield?.[0]?.router).toBe(details.processors[0]);
        });

        it("rejects a response for a different chain than asked", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({ ...details, id: 10 });
            const interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));

            await expect(
                interactor.getChainDetails(createMockRelayerInfo({ chainId: 1 })),
            ).rejects.toThrow(/answered for chain 10, asked for 1/);
        });

        it("wraps a malformed response and transport failures in RelayerRequestFailed", async () => {
            vi.mocked(mockHttpClient.get).mockResolvedValue({
                id: 1,
                contracts: { relay: "nope" },
            });
            const interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
            await expect(interactor.getChainDetails(createMockRelayerInfo())).rejects.toThrow(
                RelayerRequestFailed,
            );

            vi.mocked(mockHttpClient.get).mockRejectedValue(new Error("ECONNREFUSED"));
            await expect(interactor.getChainDetails(createMockRelayerInfo())).rejects.toThrow(
                /ECONNREFUSED/,
            );
        });
    });

    describe("getTransferQuote", () => {
        let interactor: RelayerInteractor;
        const mockRelayer = createMockRelayerInfo();

        beforeEach(() => {
            interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
        });

        it("return transfer quote from relayer", async () => {
            const quote: TransferRelayerQuote = {
                txCost: "21000",
                gasPrice: "20000000000",
                feeAmount: "100",
                feeCommitment: createMockFeeCommitment(),
            };
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce(quote);

            const params: TransferQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
            };
            const result = await interactor.getTransferQuote(mockRelayer, params);

            expect(result.txCost).toBe("21000");
            expect(result.feeAmount).toBe("100");
            expect(result.feeCommitment.signedRelayerCommitment).toBe("0xeeff");
        });

        it("post to /quote/transfer endpoint", async () => {
            const quote: TransferRelayerQuote = {
                txCost: "21000",
                gasPrice: "20000000000",
                feeAmount: "100",
                feeCommitment: createMockFeeCommitment(),
            };
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce(quote);

            const params: TransferQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
            };
            await interactor.getTransferQuote(mockRelayer, params);

            expect(mockHttpClient.post).toHaveBeenCalledWith(
                "https://relayer1.example.com/v1/quote/evm/1/transfer",
                params,
            );
        });

        it("throw RelayerRequestFailed on error", async () => {
            vi.mocked(mockHttpClient.post).mockRejectedValueOnce(new Error("Timeout"));

            const params: TransferQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
            };

            await expect(interactor.getTransferQuote(mockRelayer, params)).rejects.toThrow(
                RelayerRequestFailed,
            );
        });

        it("throw RelayerRequestFailed for invalid response", async () => {
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ invalid: "data" });

            const params: TransferQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
            };

            await expect(interactor.getTransferQuote(mockRelayer, params)).rejects.toThrow(
                RelayerRequestFailed,
            );
        });

        it("throw RelayerRequestFailed for invalid params", async () => {
            const params = {
                asset: "not-hex",
                commit: true,
            } as unknown as TransferQuoteParams;

            await expect(interactor.getTransferQuote(mockRelayer, params)).rejects.toThrow(
                RelayerRequestFailed,
            );
        });
    });

    describe("getSwapQuote", () => {
        let interactor: RelayerInteractor;
        const mockRelayer = createMockRelayerInfo();

        const baseSwapParams: SwapQuoteParams = {
            asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
            recipient: "0x1234123412341234123412341234123412341234" as Hex,
            amount: "1000000",
            outputToken: "0xcccccccccccccccccccccccccccccccccccccccc" as Hex,
            minOutputAmount: "0",
            dustRecipient: "0x1234123412341234123412341234123412341234" as Hex,
            commit: true,
        };

        beforeEach(() => {
            interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
        });

        it("throw RelayerRequestFailed for a committed quote missing swapCalldata/swapTarget", async () => {
            await expect(interactor.getSwapQuote(mockRelayer, baseSwapParams)).rejects.toThrow(
                RelayerRequestFailed,
            );
            expect(mockHttpClient.post).not.toHaveBeenCalled();
        });

        it("accept a committed quote carrying swapCalldata and swapTarget", async () => {
            const quote: SwapRelayerQuote = {
                txCost: "21000",
                gasPrice: "20000000000",
                feeAmount: "100",
                feeCommitment: {
                    ...createMockFeeCommitment(),
                    recipient: "0x1234123412341234123412341234123412341234" as Hex,
                    amountSent: "1000000",
                },
            };
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce(quote);

            const result = await interactor.getSwapQuote(mockRelayer, {
                ...baseSwapParams,
                swapCalldata: "0xdeadbeef" as Hex,
                swapTarget: "0x2222222222222222222222222222222222222222" as Hex,
            });

            expect(result.feeAmount).toBe("100");
            expect(mockHttpClient.post).toHaveBeenCalledOnce();
        });

        it("throw RelayerRequestFailed for a committed quote (commit: true) missing feeCommitment", async () => {
            // The narrowing must not weaken the commit:true path: a committed request
            // whose response drops the signed feeCommitment is still validated against
            // SwapRelayerQuoteSchema and rejected.
            const badQuote = {
                txCost: "21000",
                gasPrice: "20000000000",
                feeAmount: "100",
            };
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce(badQuote);

            await expect(
                interactor.getSwapQuote(mockRelayer, {
                    ...baseSwapParams,
                    swapCalldata: "0xdeadbeef" as Hex,
                    swapTarget: "0x2222222222222222222222222222222222222222" as Hex,
                }),
            ).rejects.toThrow(RelayerRequestFailed);
        });
    });

    describe("getWithdrawalQuote", () => {
        let interactor: RelayerInteractor;
        const mockRelayer = createMockRelayerInfo();

        beforeEach(() => {
            interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
        });

        it("return withdrawal quote from relayer", async () => {
            const quote: WithdrawalRelayerQuote = {
                txCost: "21000",
                gasPrice: "20000000000",
                feeAmount: "100",
                amountSent: "1000",
                amountReceived: "900",
                feeCommitment: createMockWithdrawalFeeCommitment(),
            };
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce(quote);

            const params: WithdrawalQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
                recipient: "0x1234123412341234123412341234123412341234" as Hex,
                extraGas: false,
                amount: "1000",
            };
            const result = await interactor.getWithdrawalQuote(mockRelayer, params);

            expect(result.txCost).toBe("21000");
            expect(result.amountSent).toBe("1000");
            expect(result.amountReceived).toBe("900");
            expect(result.feeCommitment.recipient).toBe(
                "0x1234123412341234123412341234123412341234",
            );
        });

        it("post to /quote/withdrawal endpoint", async () => {
            const quote: WithdrawalRelayerQuote = {
                txCost: "21000",
                gasPrice: "20000000000",
                feeAmount: "100",
                amountSent: "1000",
                amountReceived: "900",
                feeCommitment: createMockWithdrawalFeeCommitment(),
            };
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce(quote);

            const params: WithdrawalQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
                recipient: "0x1234123412341234123412341234123412341234" as Hex,
                extraGas: false,
                amount: "1000",
            };
            await interactor.getWithdrawalQuote(mockRelayer, params);

            expect(mockHttpClient.post).toHaveBeenCalledWith(
                "https://relayer1.example.com/v1/quote/evm/1/receive",
                params,
            );
        });

        it("throw RelayerRequestFailed on error", async () => {
            vi.mocked(mockHttpClient.post).mockRejectedValueOnce(new Error("Timeout"));

            const params: WithdrawalQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
                recipient: "0x1234123412341234123412341234123412341234" as Hex,
                extraGas: false,
                amount: "1000",
            };

            await expect(interactor.getWithdrawalQuote(mockRelayer, params)).rejects.toThrow(
                RelayerRequestFailed,
            );
        });

        it("throw RelayerRequestFailed for invalid response", async () => {
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ invalid: "data" });

            const params: WithdrawalQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
                recipient: "0x1234123412341234123412341234123412341234" as Hex,
                extraGas: false,
                amount: "1000",
            };

            await expect(interactor.getWithdrawalQuote(mockRelayer, params)).rejects.toThrow(
                RelayerRequestFailed,
            );
        });

        it("throw RelayerRequestFailed for invalid params", async () => {
            const params = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
                // missing recipient, extraGas, amount
            } as unknown as WithdrawalQuoteParams;

            await expect(interactor.getWithdrawalQuote(mockRelayer, params)).rejects.toThrow(
                RelayerRequestFailed,
            );
        });
    });

    describe("relayTransfer", () => {
        let interactor: RelayerInteractor;
        const mockRelayer = createMockRelayerInfo();

        beforeEach(() => {
            interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
        });

        it("return txHash on successful relay", async () => {
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });

            const params: TransferRelayParams = {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 2,
            };
            const result = await interactor.relayTransfer(mockRelayer, params);

            expect(result).toBe(txHash);
        });

        it("post to /relay/transfer endpoint", async () => {
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });

            const params: TransferRelayParams = {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 2,
            };
            await interactor.relayTransfer(mockRelayer, params);

            expect(mockHttpClient.post).toHaveBeenCalledWith(
                "https://relayer1.example.com/v1/relay/evm/1/transfer",
                expect.objectContaining({
                    noteData: params.noteData,
                    signedFeeCommitment: params.signedFeeCommitment,
                }),
            );
        });

        it("throw RelayerRejected on error", async () => {
            vi.mocked(mockHttpClient.post).mockRejectedValueOnce(new Error("Rejected"));

            const params: TransferRelayParams = {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 2,
            };

            await expect(interactor.relayTransfer(mockRelayer, params)).rejects.toThrow(
                RelayerRejected,
            );
        });

        it("throw RelayerRejected on non-ok response", async () => {
            vi.mocked(mockHttpClient.post).mockRejectedValueOnce(
                new Error("HTTP 400: Bad Request"),
            );

            const params: TransferRelayParams = {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 2,
            };

            await expect(interactor.relayTransfer(mockRelayer, params)).rejects.toThrow(
                RelayerRejected,
            );
        });

        it("throw RelayerRejected for invalid params", async () => {
            const params = {
                proof: "not-a-proof",
                noteData: "0xabcdef",
                signedFeeCommitment: {},
            } as unknown as TransferRelayParams;

            await expect(interactor.relayTransfer(mockRelayer, params)).rejects.toThrow(
                RelayerRejected,
            );
        });
    });

    describe("relayWithdrawal", () => {
        let interactor: RelayerInteractor;
        const mockRelayer = createMockRelayerInfo();

        beforeEach(() => {
            interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
        });

        it("return txHash on successful relay", async () => {
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });

            const params: WithdrawalRelayParams = {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockWithdrawalFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            };
            const result = await interactor.relayWithdrawal(mockRelayer, params);

            expect(result).toBe(txHash);
        });

        it("post to /relay/withdrawal endpoint", async () => {
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });

            const params: WithdrawalRelayParams = {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockWithdrawalFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            };
            await interactor.relayWithdrawal(mockRelayer, params);

            expect(mockHttpClient.post).toHaveBeenCalledWith(
                "https://relayer1.example.com/v1/relay/evm/1/withdrawal",
                expect.objectContaining({
                    noteData: params.noteData,
                    signedFeeCommitment: params.signedFeeCommitment,
                }),
            );
        });

        it("throw RelayerRejected on error", async () => {
            vi.mocked(mockHttpClient.post).mockRejectedValueOnce(new Error("Rejected"));

            const params: WithdrawalRelayParams = {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockWithdrawalFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            };

            await expect(interactor.relayWithdrawal(mockRelayer, params)).rejects.toThrow(
                RelayerRejected,
            );
        });

        it("throw RelayerRejected on non-ok response", async () => {
            vi.mocked(mockHttpClient.post).mockRejectedValueOnce(
                new Error("HTTP 400: Bad Request"),
            );

            const params: WithdrawalRelayParams = {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockWithdrawalFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            };

            await expect(interactor.relayWithdrawal(mockRelayer, params)).rejects.toThrow(
                RelayerRejected,
            );
        });

        it("throw RelayerRejected for invalid params", async () => {
            const params = {
                proof: "not-a-proof",
                noteData: "0xabcdef",
                signedFeeCommitment: {},
            } as unknown as WithdrawalRelayParams;

            await expect(interactor.relayWithdrawal(mockRelayer, params)).rejects.toThrow(
                RelayerRejected,
            );
        });

        it("accept processorAddress and minUnderlyingOut through WithdrawalRelayParamsSchema", () => {
            const processorAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
            const minUnderlyingOut = "0x0f4240"; // 1_000_000
            const parsed = WithdrawalRelayParamsSchema.safeParse({
                proof: createMockProof(),
                noteData: [{ hint: "0x01", data: "0xabcdef" }],
                signedFeeCommitment: createMockWithdrawalFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
                processorAddress,
                minUnderlyingOut,
            });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.processorAddress).toBe(processorAddress);
                expect(parsed.data.minUnderlyingOut).toBe(minUnderlyingOut);
            }
        });

        it("validate a plain withdrawal that omits processorAddress and minUnderlyingOut", () => {
            const parsed = WithdrawalRelayParamsSchema.safeParse({
                proof: createMockProof(),
                noteData: [{ hint: "0x01", data: "0xabcdef" }],
                signedFeeCommitment: createMockWithdrawalFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.processorAddress).toBeUndefined();
                expect(parsed.data.minUnderlyingOut).toBeUndefined();
            }
        });

        it("forward processorAddress and minUnderlyingOut in the POST body for a yield withdrawal", async () => {
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });

            const processorAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Hex;
            const minUnderlyingOut = "0x0f4240" as Hex; // 1_000_000
            const params: WithdrawalRelayParams = {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockWithdrawalFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
                processorAddress,
                minUnderlyingOut,
            };
            await interactor.relayWithdrawal(mockRelayer, params);

            const [url, body] = vi.mocked(mockHttpClient.post).mock.calls[0]! as [
                string,
                Record<string, unknown>,
            ];
            expect(url).toBe("https://relayer1.example.com/v1/relay/evm/1/withdrawal");
            expect(body.processorAddress).toBe(processorAddress);
            expect(body.minUnderlyingOut).toBe(minUnderlyingOut);
        });

        it("omit processorAddress and minUnderlyingOut from the POST body for a plain withdrawal", async () => {
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });

            const params: WithdrawalRelayParams = {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockWithdrawalFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            };
            await interactor.relayWithdrawal(mockRelayer, params);

            const [, body] = vi.mocked(mockHttpClient.post).mock.calls[0]! as [
                string,
                Record<string, unknown>,
            ];
            expect(body).not.toHaveProperty("processorAddress");
            expect(body).not.toHaveProperty("minUnderlyingOut");
        });
    });

    const mockRegistration: RegisterKeystoreRelayParams = {
        account: "0x2222222222222222222222222222222222222222" as Address,
        authDigest: "0xabc" as Hex,
        nullifyingKeyHash: "0xdef" as Hex,
        deadline: "0xffffffffff" as Hex,
        signature: ("0x" + "12".repeat(65)) as Hex,
    };

    describe("submitRelayedRegistration", () => {
        let interactor: RelayerInteractor;
        const mockRelayer = createMockRelayerInfo();

        beforeEach(() => {
            interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
        });

        // RR-1: the relayer exposes no standalone `register` route (INTL-05 deferral), so the method
        // fails loudly up front rather than POSTing to a 404. See relayRegisterAndWithdrawal for the
        // supported atomic path.
        it("throw RelayerRequestFailed without issuing a request (deferred INTL-05 endpoint)", async () => {
            await expect(
                interactor.submitRelayedRegistration(mockRelayer, mockRegistration),
            ).rejects.toThrow(RelayerRequestFailed);
            expect(mockHttpClient.post).not.toHaveBeenCalled();
        });
    });

    describe("relayRegisterAndWithdrawal", () => {
        let interactor: RelayerInteractor;
        const mockRelayer = createMockRelayerInfo();

        function buildParams(): RegisterAndWithdrawalRelayParams {
            return {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockWithdrawalFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
                registration: mockRegistration,
            };
        }

        beforeEach(() => {
            interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
        });

        it("post to /register-and-withdrawal with the nested registration and return txHash", async () => {
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });

            const result = await interactor.relayRegisterAndWithdrawal(mockRelayer, buildParams());

            expect(result).toBe(txHash);
            const [url, body] = vi.mocked(mockHttpClient.post).mock.calls[0]! as [
                string,
                Record<string, unknown>,
            ];
            expect(url).toBe("https://relayer1.example.com/v1/relay/evm/1/register-and-withdrawal");
            // The whole registration leg survives the schema and reaches the POST body (F-1 no-strip).
            expect(body.registration).toMatchObject({
                account: mockRegistration.account,
                signature: mockRegistration.signature,
                deadline: mockRegistration.deadline,
            });
            // Proof is reshaped like the withdrawal path (flattened + publicSignals).
            expect(body).toHaveProperty("proof");
        });

        it("throw RelayerRejected when the fee commitment has expired", async () => {
            const params = buildParams();
            params.signedFeeCommitment = createMockWithdrawalFeeCommitment({ expiration: 1 });

            await expect(
                interactor.relayRegisterAndWithdrawal(mockRelayer, params),
            ).rejects.toThrow();
        });

        it("throw RelayerRejected when the registration is missing", async () => {
            const params = buildParams();
            delete (params as { registration?: unknown }).registration;

            await expect(
                interactor.relayRegisterAndWithdrawal(mockRelayer, params),
            ).rejects.toThrow(RelayerRejected);
        });
    });

    describe("relayWithAnnounce", () => {
        let interactor: RelayerInteractor;
        const mockRelayer = createMockRelayerInfo();

        const mockAnnouncement = {
            schemeId: "0x1" as Hex,
            stealthAddress: "0x3333333333333333333333333333333333333333" as Address,
            ephemeralPubKey: ("0x02" + "cd".repeat(32)) as Hex,
            metadata: "0xaa" as Hex,
        };

        function buildParams(): RelayAndAnnounceRelayParams {
            return {
                proof: createMockProof(),
                noteData: [{ hint: "0x01" as Hex, data: "0xabcdef" as Hex }],
                signedFeeCommitment: createMockWithdrawalFeeCommitment(),
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
                announcement: mockAnnouncement,
            };
        }

        beforeEach(() => {
            interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
        });

        it("post to /relay-and-announce with the nested announcement and return txHash", async () => {
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });

            const result = await interactor.relayWithAnnounce(mockRelayer, buildParams());

            expect(result).toBe(txHash);
            const [url, body] = vi.mocked(mockHttpClient.post).mock.calls[0]! as [
                string,
                Record<string, unknown>,
            ];
            expect(url).toBe("https://relayer1.example.com/v1/relay/evm/1/relay-and-announce");
            // The whole announcement leg survives the schema and reaches the POST body (F-1 no-strip).
            expect(body.announcement).toMatchObject({
                schemeId: mockAnnouncement.schemeId,
                stealthAddress: mockAnnouncement.stealthAddress,
                ephemeralPubKey: mockAnnouncement.ephemeralPubKey,
                metadata: mockAnnouncement.metadata,
            });
            expect(body).toHaveProperty("proof");
        });

        it("throw when the fee commitment has expired", async () => {
            const params = buildParams();
            params.signedFeeCommitment = createMockWithdrawalFeeCommitment({ expiration: 1 });

            await expect(interactor.relayWithAnnounce(mockRelayer, params)).rejects.toThrow();
        });

        it("throw RelayerRejected when the announcement is missing", async () => {
            const params = buildParams();
            delete (params as { announcement?: unknown }).announcement;

            await expect(interactor.relayWithAnnounce(mockRelayer, params)).rejects.toThrow(
                RelayerRejected,
            );
        });

        it("carry a FluidKey 0xfffe announcement with a 65-byte uncompressed ephemeral to the POST body", async () => {
            // TG-G2: the FluidKey scheme (uncompressed 65-byte ephemeralPubKey) must survive schema->wire,
            // not only the canonical compressed shape.
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });
            const fluidKeyEphemeral = ("0x04" + "cd".repeat(64)) as Hex; // 65 bytes
            const params = buildParams();
            params.announcement = {
                schemeId: "0xfffe" as Hex,
                stealthAddress: mockAnnouncement.stealthAddress,
                ephemeralPubKey: fluidKeyEphemeral,
                metadata: "0xbb" as Hex,
            };

            await interactor.relayWithAnnounce(mockRelayer, params);

            const [, body] = vi.mocked(mockHttpClient.post).mock.calls[0]! as [
                string,
                Record<string, unknown>,
            ];
            expect((body.announcement as { schemeId: string }).schemeId).toBe("0xfffe");
            expect((body.announcement as { ephemeralPubKey: string }).ephemeralPubKey).toBe(
                fluidKeyEphemeral,
            );
        });
    });

    describe("getBatchWithdrawalQuote", () => {
        let interactor: RelayerInteractor;
        const mockRelayer = createMockRelayerInfo();

        beforeEach(() => {
            interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
        });

        it("return batch withdrawal quote from relayer", async () => {
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce(createMockBatchQuote());

            const params: BatchWithdrawalQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
                recipient: "0x1234123412341234123412341234123412341234" as Hex,
                extraGas: false,
                amounts: ["1000", "500"],
            };
            const result = await interactor.getBatchWithdrawalQuote(mockRelayer, params);

            expect(result.totalFee).toBe("30");
            expect(result.maxRelayFee).toBe("100");
            expect(result.feeCommitment.signedRelayerCommitment).toBe("0xeeff");
        });

        it("post to /quote/batch endpoint", async () => {
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce(createMockBatchQuote());

            const params: BatchWithdrawalQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
                recipient: "0x1234123412341234123412341234123412341234" as Hex,
                extraGas: false,
                amounts: ["1000", "500"],
            };
            await interactor.getBatchWithdrawalQuote(mockRelayer, params);

            expect(mockHttpClient.post).toHaveBeenCalledWith(
                "https://relayer1.example.com/v1/quote/evm/1/batch",
                params,
            );
        });

        it("throw RelayerRequestFailed on error", async () => {
            vi.mocked(mockHttpClient.post).mockRejectedValueOnce(new Error("Timeout"));

            const params: BatchWithdrawalQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
                recipient: "0x1234123412341234123412341234123412341234" as Hex,
                extraGas: false,
                amounts: ["1000"],
            };

            await expect(interactor.getBatchWithdrawalQuote(mockRelayer, params)).rejects.toThrow(
                RelayerRequestFailed,
            );
        });

        it("throw RelayerRequestFailed for invalid response", async () => {
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ invalid: "data" });

            const params: BatchWithdrawalQuoteParams = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
                recipient: "0x1234123412341234123412341234123412341234" as Hex,
                extraGas: false,
                amounts: ["1000"],
            };

            await expect(interactor.getBatchWithdrawalQuote(mockRelayer, params)).rejects.toThrow(
                RelayerRequestFailed,
            );
        });

        it("throw RelayerRequestFailed for invalid params", async () => {
            const params = {
                asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
                commit: true,
                // missing recipient, extraGas, amounts
            } as unknown as BatchWithdrawalQuoteParams;

            await expect(interactor.getBatchWithdrawalQuote(mockRelayer, params)).rejects.toThrow(
                RelayerRequestFailed,
            );
        });
    });

    describe("relayBatchWithdrawal", () => {
        let interactor: RelayerInteractor;
        const mockRelayer = createMockRelayerInfo();

        beforeEach(() => {
            interactor = new RelayerInteractor(createDefaultConfig(mockHttpClient));
        });

        it("return txHash on successful batch relay", async () => {
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });

            const result = await interactor.relayBatchWithdrawal(
                mockRelayer,
                createMockBatchRelayParams(),
            );

            expect(result).toBe(txHash);
        });

        it("post to /relay/batch endpoint with flattened per-item proofs", async () => {
            const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            vi.mocked(mockHttpClient.post).mockResolvedValueOnce({ txHash });

            const params = createMockBatchRelayParams();
            await interactor.relayBatchWithdrawal(mockRelayer, params);

            expect(mockHttpClient.post).toHaveBeenCalledTimes(1);
            const [url, body] = vi.mocked(mockHttpClient.post).mock.calls[0]!;
            expect(url).toBe("https://relayer1.example.com/v1/relay/evm/1/batch");

            const typedBody = body as {
                items: {
                    proof: Record<string, unknown>;
                    noteData: unknown;
                    inputNullifierNumber: number;
                    outputCommitmentNumber: number;
                }[];
                signedBatchFeeCommitment: BatchFeeCommitment;
            };

            expect(typedBody.items).toHaveLength(2);
            // Each item's proof is flattened to `{ ...proof.proof, publicSignals }`.
            typedBody.items.forEach((item, i) => {
                const source = params.items[i]!;
                expect(item.proof).toEqual({
                    ...source.proof.proof,
                    publicSignals: source.proof.publicSignals,
                });
                // The nested `proof.proof` wrapper is gone after flattening.
                expect(item.proof).not.toHaveProperty("proof");
                expect(item.inputNullifierNumber).toBe(source.inputNullifierNumber);
                expect(item.outputCommitmentNumber).toBe(source.outputCommitmentNumber);
                expect(item.noteData).toEqual(source.noteData);
            });
            // The batch fee commitment passes through unchanged.
            expect(typedBody.signedBatchFeeCommitment).toEqual(params.signedBatchFeeCommitment);
        });

        it("throw RelayerRejected on error", async () => {
            vi.mocked(mockHttpClient.post).mockRejectedValueOnce(new Error("Rejected"));

            await expect(
                interactor.relayBatchWithdrawal(mockRelayer, createMockBatchRelayParams()),
            ).rejects.toThrow(RelayerRejected);
        });

        it("throw RelayerRejected for invalid params", async () => {
            const params = {
                items: "not-an-array",
                signedBatchFeeCommitment: {},
            } as unknown as BatchWithdrawalRelayParams;

            await expect(interactor.relayBatchWithdrawal(mockRelayer, params)).rejects.toThrow(
                RelayerRejected,
            );
        });

        it("throw for an expired batch fee commitment before submission", async () => {
            const params = createMockBatchRelayParams({
                signedBatchFeeCommitment: createMockBatchFeeCommitment({
                    expiration: Date.now() - 1000,
                }),
            });

            await expect(interactor.relayBatchWithdrawal(mockRelayer, params)).rejects.toThrow(
                /expired/i,
            );
            // Never reaches the HTTP layer.
            expect(mockHttpClient.post).not.toHaveBeenCalled();
        });
    });
});
