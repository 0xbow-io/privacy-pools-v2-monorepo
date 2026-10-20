import { decodeFunctionData, encodeFunctionData } from "viem";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    AssetConfig,
    DepositCircuitInputs,
    Hash,
    Hex,
    IASPClient,
    IEntrypointInteractor,
    IKeystoreInteractor,
    IKeystoreManager,
    INoteManager,
    IPoolSessionDeposit,
    IPoolVaultInteractor,
    IPPRouterInteractor,
    IPPYieldTokenInteractor,
    IProofService,
    IRPCInteractor,
    ISwapAndDepositQuoteProvider,
    IWalletInteractor,
    IWitnessPreparationService,
    KeyPair,
    NoteDataBuilderInput,
    NoteEvent,
    PreparedTransaction,
    ReadContractParams,
    Secret,
    SwapAndDepositParams,
    YieldDepositTarget,
} from "../../../src/internal.js";
import {
    AddressSchema,
    CryptoService,
    decodeNoteData,
    DepositRecipientViewingKeyUnregistered,
    EMPTY_ADDRESS,
    ENTRYPOINT_DEPOSIT_ABI,
    EvmAddressEqualityComparator,
    EvmAddressFieldConverter,
    EvmContextHashService,
    EvmPoolSessionYieldDeposit,
    EvmPreparedTxVerifier,
    EvmSwapChainAdapter,
    InvalidDepositParams,
    InvalidSwapAndDepositParams,
    LOCAL_FORK_YIELD_DEPLOYMENT,
    NATIVE_ASSET_ADDRESS,
    NoteComputationService,
    NoteDiscoveryService,
    PoolSessionDeposit,
    PoolSessionSwapDeposit,
    PoseidonHashService,
    PP_ROUTER_DEPOSIT_ABI,
    RELAY_SWAP_ROUTING_TYPEHASH,
    toYieldSwapDepositTarget,
} from "../../../src/internal.js";

// DEV-489: a swap-and-deposit FOR someone else. Everything a recipient's discovery relies on
// (noteAddressHash, label, commitment, the noteData announcement) is computed by the REAL deposit
// pipeline: PoolSessionDeposit + NoteComputationService + CryptoService + PoseidonHashService.
// Only proving, the chain and LiFi are mocked. Discovery is the real NoteDiscoveryService.

const POOL_CHAIN_ID = 56;
const SOURCE_CHAIN_ID = 10;
const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const UNREGISTERED = "0x9876543210fedcba9876543210fedcba98765432" as Address;
const ENTRYPOINT = "0x9999999999999999999999999999999999999991" as Address;
const INPUT_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address; // e.g. WBNB
const DEPOSIT_TOKEN = "0xcccccccccccccccccccccccccccccccccccccccc" as Address; // e.g. USDT
const LIFI_ROUTER = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae" as Address;
const RELAY_SWAPS = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;
const SOURCE_RELAY_SWAPS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
const DEPOSIT_AMOUNT = "0xf4240" as Hex; // 1_000_000
const TIMESTAMP = "0x64000000" as Hash;

const ASSET_CONFIG: AssetConfig = {
    enabled: true,
    vettingFeeBPS: "0x64" as Hash,
    minAmount: "0x1" as Hash,
    maxRelayFee: "0xffffffff" as Hash,
};

let cryptoService: CryptoService;
let noteComputation: NoteComputationService;
let discovery: NoteDiscoveryService;
let payerViewingKeys: KeyPair;
let recipientViewingKeys: KeyPair;
let aspKeys: KeyPair;

beforeAll(async () => {
    cryptoService = new CryptoService();
    const hashService = await PoseidonHashService.create();
    noteComputation = new NoteComputationService({ hashService, cryptoService });
    discovery = new NoteDiscoveryService({
        cryptoService,
        hashService,
        noteComputationService: noteComputation,
        addressFieldConverter: new EvmAddressFieldConverter(),
    });
    payerViewingKeys = cryptoService.generateEphemeralKeyPair();
    recipientViewingKeys = cryptoService.generateEphemeralKeyPair();
    aspKeys = cryptoService.generateEphemeralKeyPair();
});

// --- The real deposit pipeline, owned by the PAYER ---

function entrypointInteractor(): IEntrypointInteractor {
    return {
        getAddress: vi.fn(() => ENTRYPOINT),
        getAssetConfig: vi.fn(async () => ASSET_CONFIG),
        getAllowance: vi.fn(async () => "0x0" as Hash),
        encodeApprove: vi.fn(async (token: Address) => ({
            to: token,
            data: "0x095ea7b3" as Hex,
            value: "0x0" as Hex,
        })),
        // The real Entrypoint.deposit encoding, so the noteData the proof context is bound to is
        // exactly what lands on-chain (and what a recipient's discovery reads back).
        encodeDeposit: vi.fn(
            async (
                proof: unknown,
                noteData: { hint: Hex; data: Hex },
                aspCiphertext: Hex,
                msgValue: Hex,
            ) => ({
                to: ENTRYPOINT,
                data: encodeFunctionData({
                    abi: ENTRYPOINT_DEPOSIT_ABI,
                    functionName: "deposit",
                    args: [proof, noteData, aspCiphertext] as never,
                }),
                value: msgValue,
            }),
        ),
        submitTransaction: vi.fn(async () => "0x5ab" as Hex),
    } as unknown as IEntrypointInteractor;
}

function keystoreInteractor(): IKeystoreInteractor {
    return {
        getViewingKey: vi.fn(async (account: Address) =>
            account.toLowerCase() === RECIPIENT.toLowerCase()
                ? (recipientViewingKeys.publicKey as unknown as Hash)
                : (`0x${"00".repeat(32)}` as Hash),
        ),
    } as unknown as IKeystoreInteractor;
}

function witnessService(): IWitnessPreparationService {
    return {
        buildDepositWitness: vi.fn(async (params: DepositCircuitInputs) => params),
    } as unknown as IWitnessPreparationService;
}

/** Proving is mocked; the public signals still carry tokenId/value so router asserts run for real. */
function proofService(): IProofService {
    let last: DepositCircuitInputs | undefined;
    return {
        proveDeposit: vi.fn(async (witness: DepositCircuitInputs) => {
            last = witness;
            return { proof: {}, publicSignals: [] };
        }),
        formatForChain: vi.fn(() => {
            if (!last) throw new Error("formatForChain before proveDeposit");
            const w = last;
            return {
                pA: [1n, 2n],
                pB: [
                    [3n, 4n],
                    [5n, 6n],
                ],
                pC: [7n, 8n],
                pubSignals: [0n, BigInt(w.tokenId), BigInt(w.value), BigInt(w.context)],
            };
        }),
    } as unknown as IProofService;
}

function payerKeystoreManager(): IKeystoreManager {
    return {
        getViewingKeyPair: vi.fn(() => payerViewingKeys),
    } as unknown as IKeystoreManager;
}

function aspClient(): IASPClient {
    return {
        getASPPublicKey: vi.fn(async () => aspKeys.publicKey),
    } as unknown as IASPClient;
}

function poolVault(): IPoolVaultInteractor {
    return {
        getCommitmentTimestamp: vi.fn(async () => TIMESTAMP),
    } as unknown as IPoolVaultInteractor;
}

function rpc(): IRPCInteractor {
    return {
        readContract: vi.fn(async ({ functionName }: ReadContractParams) => {
            if (functionName === "allowance") return 0n;
            return functionName === "ROUTING_TYPEHASH" ? RELAY_SWAP_ROUTING_TYPEHASH : true;
        }),
        waitForTransactionReceipt: vi.fn(async () => ({
            status: true,
            blockNumber: "0x1" as Hex,
            txHash: "0x5ab" as Hex,
            logs: [],
        })),
    } as unknown as IRPCInteractor;
}

function noteManager(): INoteManager {
    return { addNote: vi.fn() } as unknown as INoteManager;
}

/** LiFi echoes the embedded call (target ABI-padded + calldata) so the containment checks pass. */
function quoteProvider(): ISwapAndDepositQuoteProvider {
    return {
        getSwapAndDepositQuote: vi.fn(
            async (req: {
                fromToken: Address;
                toToken: Address;
                fromChainId: number;
                toChainId: number;
                poolAddress: Address;
                depositCalldata: Hex;
                depositAmount: string;
            }) => ({
                fromAmount: "999990",
                toAmount: req.depositAmount,
                fromAmountUSD: "1.00",
                toAmountUSD: "1.00",
                approvalAddress: LIFI_ROUTER,
                transactionData:
                    `0x${req.poolAddress.slice(2).toLowerCase().padStart(64, "0")}${req.depositCalldata.slice(2)}` as Hex,
                transactionTo: LIFI_ROUTER,
                transactionValue: "0x0" as Hex,
                estimatedDuration: 30,
                fromTokenAddress: req.fromToken,
                toTokenAddress: req.toToken,
                fromChainId: req.fromChainId,
                toChainId: req.toChainId,
            }),
        ),
    } as unknown as ISwapAndDepositQuoteProvider;
}

// --- A real yield deposit session on top of the same deposit pipeline ---

const DEP = { ...LOCAL_FORK_YIELD_DEPLOYMENT };

function yieldTarget(deposit: IPoolSessionDeposit): YieldDepositTarget {
    const router: IPPRouterInteractor = {
        getAddress: () => DEP.ppRouter,
        // 1% vetting fee in shares, the underlying 1:1 with the total.
        quote: vi.fn(async (value: bigint) => {
            const total = value + (value * 100n) / 10_000n;
            return { underlyingNeeded: total, total };
        }),
        quoteWithdraw: vi.fn(async () => 0n),
        supplyBufferUnits: vi.fn(async () => 0n),
    };
    const yieldToken: IPPYieldTokenInteractor = {
        getAddress: () => DEP.ppUSDC,
        exchangeRate: vi.fn(async () => 0n),
        previewDeposit: vi.fn(async (principal: bigint) => principal),
        previewRedeem: vi.fn(async () => 0n),
        encodeRedeem: vi.fn(() => ({
            to: DEP.ppUSDC,
            data: "0x" as Hex,
            value: "0x0" as Hex,
        })),
    };
    return {
        chainId: POOL_CHAIN_ID,
        deployment: DEP,
        deposit: new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router,
            yieldToken,
        }),
    } as unknown as YieldDepositTarget;
}

interface Harness {
    service: PoolSessionSwapDeposit<PreparedTransaction>;
    deposit: PoolSessionDeposit;
    keystore: IKeystoreInteractor;
    notes: INoteManager;
    provider: ISwapAndDepositQuoteProvider;
    sourceWallet: IWalletInteractor;
}

function buildHarness(opts: { crossChain?: boolean; withYield?: boolean } = {}): Harness {
    const poolRpc = rpc();
    const keystore = keystoreInteractor();
    const notes = noteManager();
    const ep = entrypointInteractor();
    const deposit = new PoolSessionDeposit({
        ownerAddress: PAYER,
        cryptoService,
        witnessPreparationService: witnessService(),
        proofService: proofService(),
        entrypointInteractor: ep,
        noteManager: notes,
        aspClient: aspClient(),
        keystoreManager: payerKeystoreManager(),
        noteComputationService: noteComputation,
        keystoreInteractor: keystore,
        poolVaultInteractor: poolVault(),
        rpcInteractor: poolRpc,
        contextHashService: new EvmContextHashService(),
        preparedTxVerifier: new EvmPreparedTxVerifier(),
        addressFieldConverter: new EvmAddressFieldConverter(),
        addressEqualityComparator: new EvmAddressEqualityComparator(),
        addressSchema: AddressSchema,
    });
    const provider = quoteProvider();
    const sourceRpc = rpc();
    const sourceWallet = {
        sendTransaction: vi.fn(async () => "0x50c" as Hex),
    } as unknown as IWalletInteractor;
    const service = new PoolSessionSwapDeposit<PreparedTransaction>({
        ownerAddress: PAYER,
        chainId: POOL_CHAIN_ID,
        depositDelegate: deposit,
        swapAndDepositQuoteProvider: provider,
        entrypointInteractor: ep,
        rpcInteractor: poolRpc,
        noteManager: notes,
        poolVaultInteractor: poolVault(),
        relaySwapsAddress: RELAY_SWAPS,
        nativeAssetAddress: NATIVE_ASSET_ADDRESS,
        emptyAddress: EMPTY_ADDRESS,
        addressEqualityComparator: new EvmAddressEqualityComparator(),
        addressSchema: AddressSchema,
        swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: poolRpc }),
        ...(opts.withYield
            ? {
                  yieldDepositTargets: [toYieldSwapDepositTarget(yieldTarget(deposit))],
              }
            : {}),
        ...(opts.crossChain
            ? {
                  sourceChain: {
                      chainId: SOURCE_CHAIN_ID,
                      walletInteractor: sourceWallet,
                      rpcInteractor: sourceRpc,
                      relaySwapsAddress: SOURCE_RELAY_SWAPS,
                      swapChainAdapter: new EvmSwapChainAdapter({
                          rpcInteractor: sourceRpc,
                      }),
                  },
              }
            : {}),
    });
    return { service, deposit, keystore, notes, provider, sourceWallet };
}

/** The Note event the deposit's embedded noteData would emit on-chain. */
function noteEventFrom(noteData: { hint: Hex; data: Hex }): NoteEvent {
    const { ephemeralPubKey, encryptedPayload } = decodeNoteData(noteData.data);
    return {
        blockNumber: "0x10" as Hex,
        txHash: `0x${"ab".repeat(32)}` as Hash,
        hint: noteData.hint,
        ephemeralPubKey,
        encryptedPayload,
    };
}

/** The noteData carried by the embedded call LiFi was asked to execute. */
function embeddedNoteData(provider: ISwapAndDepositQuoteProvider): {
    hint: Hex;
    data: Hex;
} {
    const req = vi.mocked(provider.getSwapAndDepositQuote).mock.calls[0][0];
    try {
        const decoded = decodeFunctionData({
            abi: ENTRYPOINT_DEPOSIT_ABI,
            data: req.depositCalldata,
        });
        return decoded.args[1] as { hint: Hex; data: Hex };
    } catch {
        const decoded = decodeFunctionData({
            abi: PP_ROUTER_DEPOSIT_ABI,
            data: req.depositCalldata,
        });
        return decoded.args[1] as { hint: Hex; data: Hex };
    }
}

function params(overrides?: Partial<SwapAndDepositParams>): SwapAndDepositParams {
    return {
        fromChainId: POOL_CHAIN_ID,
        inputToken: INPUT_TOKEN,
        depositToken: DEPOSIT_TOKEN,
        depositAmount: DEPOSIT_AMOUNT,
        ...overrides,
    };
}

/** What a recipient's own discovery (their viewing key, their address) makes of the event. */
function recipientDiscovers(event: NoteEvent): { commitment: Hex; label: Hex; value: bigint }[] {
    return discovery
        .scanCatchAll([event], recipientViewingKeys.privateKey as Secret, RECIPIENT)
        .map((n) => ({
            commitment: n.commitment as Hex,
            label: n.label as Hex,
            value: BigInt(n.value),
        }));
}

describe("PoolSessionSwapDeposit for a recipient (DEV-489)", () => {
    describe("same-chain, plain pool token", () => {
        let h: Harness;
        beforeEach(() => {
            h = buildHarness();
        });

        it("lets a registered recipient discover the note while the payer neither owns nor discovers it", async () => {
            const result = await h.service.prepareSwapAndDeposit(
                params({ recipient: { discoveryData: { evmAddress: RECIPIENT } } }),
            );

            expect(result.pendingNote.isOwned).toBe(false);
            expect(result.pendingNote.ownerAddress).toBe(RECIPIENT);
            expect(h.keystore.getViewingKey).toHaveBeenCalledWith(RECIPIENT);

            const event = noteEventFrom(embeddedNoteData(h.provider));
            // The recipient's scan reproduces the exact commitment and label the deposit inserts.
            expect(recipientDiscovers(event)).toEqual([
                {
                    commitment: result.pendingNote.commitment,
                    label: result.pendingNote.label,
                    value: BigInt(result.pendingNote.value),
                },
            ]);
            // The payer's own viewing key cannot read it.
            expect(
                discovery.scanCatchAll([event], payerViewingKeys.privateKey as Secret, PAYER),
            ).toEqual([]);

            // Executing never files the recipient's note under the payer.
            await h.service.executeSwapAndDeposit(result);
            expect(h.notes.addNote).not.toHaveBeenCalled();
        });

        it("keeps the payer's quote request unchanged apart from the embedded proof", async () => {
            await h.service.prepareSwapAndDeposit(
                params({ recipient: { discoveryData: { evmAddress: RECIPIENT } } }),
            );
            const req = vi.mocked(h.provider.getSwapAndDepositQuote).mock.calls[0][0];
            expect(req.fromAddress).toBe(PAYER);
            expect(req.poolAddress).toBe(ENTRYPOINT);
            expect(req.toToken).toBe(DEPOSIT_TOKEN);
            // value + 1% vetting fee, exactly as for a self deposit.
            expect(req.depositAmount).toBe((1_000_000n + 10_000n).toString());
            expect(Object.keys(req).sort()).toEqual(
                [
                    "depositAmount",
                    "depositCalldata",
                    "fromAddress",
                    "fromChainId",
                    "fromToken",
                    "poolAddress",
                    "toChainId",
                    "toToken",
                ].sort(),
            );
        });

        it("refuses an unregistered recipient on the discoverable form before quoting", async () => {
            await expect(
                h.service.prepareSwapAndDeposit(
                    params({
                        recipient: { discoveryData: { evmAddress: UNREGISTERED } },
                    }),
                ),
            ).rejects.toBeInstanceOf(DepositRecipientViewingKeyUnregistered);
            expect(h.provider.getSwapAndDepositQuote).not.toHaveBeenCalled();
        });

        it("commits a blind deposit to the caller's noteAddressHash and returns what a claim link needs", async () => {
            const noteSecret = cryptoService.generateSecret();
            const depositSecret = cryptoService.generateSecret();
            const noteAddressHash = noteComputation.computeNoteAddressHash(RECIPIENT, noteSecret);
            const backup = {
                hint: `0x${"5e".repeat(32)}` as Hex,
                data: "0xc0ffee" as Hex,
            };

            const result = await h.service.prepareSwapAndDeposit(
                params({
                    recipient: { noteAddressHash, noteData: backup, depositSecret },
                }),
            );

            expect(h.keystore.getViewingKey).not.toHaveBeenCalled();
            expect(result.pendingNote.isOwned).toBe(false);
            expect(result.pendingNote.noteAddressHash).toBe(noteAddressHash);
            expect(result.pendingNote.depositSecret).toBe(depositSecret);
            expect(embeddedNoteData(h.provider)).toEqual(backup);

            // A claimant holding the link (noteSecret + label) rebuilds exactly this commitment.
            const precommitment = noteComputation.computePrecommitment(
                noteAddressHash,
                DEPOSIT_TOKEN,
                DEPOSIT_AMOUNT,
            );
            const label = noteComputation.computeLabel(precommitment, depositSecret);
            expect(result.pendingNote.label).toBe(label);
            expect(result.pendingNote.commitment).toBe(
                noteComputation.computeFullCommitment({
                    noteAddressHash,
                    tokenId: DEPOSIT_TOKEN,
                    value: DEPOSIT_AMOUNT,
                    label,
                }),
            );

            await h.service.executeSwapAndDeposit(result);
            expect(h.notes.addNote).not.toHaveBeenCalled();
        });

        it("publishes the empty announcement for a blind deposit without noteData, as plain depositFor does", async () => {
            const noteAddressHash = noteComputation.computeNoteAddressHash(
                RECIPIENT,
                cryptoService.generateSecret(),
            );
            const result = await h.service.prepareSwapAndDeposit(
                params({ recipient: { noteAddressHash } }),
            );
            expect(result.pendingNote.isOwned).toBe(false);
            expect(embeddedNoteData(h.provider).data).toBe("0x");
        });

        it("refuses a recipient evmAddress that is the payer's own address", async () => {
            await expect(
                h.service.prepareSwapAndDeposit(
                    params({ recipient: { discoveryData: { evmAddress: PAYER } } }),
                ),
            ).rejects.toThrow(/own address/);
            expect(h.provider.getSwapAndDepositQuote).not.toHaveBeenCalled();
        });

        it("rejects a recipient naming both forms", async () => {
            await expect(
                h.service.prepareSwapAndDeposit(
                    params({
                        recipient: {
                            noteAddressHash: `0x${"11".repeat(32)}` as Hex,
                            discoveryData: { evmAddress: RECIPIENT },
                        } as never,
                    }),
                ),
            ).rejects.toBeInstanceOf(InvalidSwapAndDepositParams);
        });

        it("gives the session owner the note without a recipient", async () => {
            const forSpy = vi.spyOn(h.deposit, "prepareDepositFor");
            const result = await h.service.prepareSwapAndDeposit(params());
            expect(forSpy).not.toHaveBeenCalled();
            expect(result.pendingNote.isOwned).toBe(true);
            expect(result.pendingNote.ownerAddress).toBe(PAYER);
            await h.service.executeSwapAndDeposit(result);
            expect(h.notes.addNote).toHaveBeenCalledTimes(1);
        });
    });

    describe("same-chain, yield share", () => {
        let h: Harness;
        beforeEach(() => {
            h = buildHarness({ withYield: true });
        });

        it("lets a registered recipient discover the share note embedded in the router call", async () => {
            const result = await h.service.prepareSwapAndDeposit(
                params({
                    depositToken: DEP.ppUSDC,
                    recipient: { discoveryData: { evmAddress: RECIPIENT } },
                }),
            );
            const req = vi.mocked(h.provider.getSwapAndDepositQuote).mock.calls[0][0];
            expect(req.poolAddress.toLowerCase()).toBe(DEP.ppRouter.toLowerCase());
            expect(
                decodeFunctionData({
                    abi: PP_ROUTER_DEPOSIT_ABI,
                    data: req.depositCalldata,
                }).functionName,
            ).toBe("depositExactShares");

            expect(result.pendingNote.isOwned).toBe(false);
            expect(result.pendingNote.tokenId).toBe(DEP.ppUSDC);
            const found = recipientDiscovers(noteEventFrom(embeddedNoteData(h.provider)));
            expect(found).toHaveLength(1);
            expect(found[0].commitment).toBe(result.pendingNote.commitment);

            await h.service.executeSwapAndDeposit(result);
            expect(h.notes.addNote).not.toHaveBeenCalled();
        });

        it("hands a blind noteData builder the SIZED shares and binds its payload", async () => {
            const noteSecret = cryptoService.generateSecret();
            const depositSecret = cryptoService.generateSecret();
            const noteAddressHash = noteComputation.computeNoteAddressHash(RECIPIENT, noteSecret);
            const seen: NoteDataBuilderInput[] = [];
            const builder = (note: NoteDataBuilderInput): { hint: Hex; data: Hex } => {
                seen.push(note);
                return { hint: `0x${"7e".repeat(32)}` as Hex, data: note.label };
            };

            const result = await h.service.prepareSwapAndDeposit(
                params({
                    depositToken: DEP.ppUSDC,
                    recipient: { noteAddressHash, noteData: builder, depositSecret },
                }),
            );

            expect(seen).toHaveLength(1);
            expect(seen[0].tokenId).toBe(DEP.ppUSDC);
            // Shares, not the funding budget: the value the claim must name.
            expect(BigInt(seen[0].value)).toBe(BigInt(result.pendingNote.value));
            expect(BigInt(seen[0].value)).not.toBe(BigInt(DEPOSIT_AMOUNT));
            expect(seen[0].label).toBe(result.pendingNote.label);
            expect(seen[0].commitment).toBe(result.pendingNote.commitment);
            expect(seen[0].depositSecret).toBe(depositSecret);
            expect(embeddedNoteData(h.provider)).toEqual({
                hint: `0x${"7e".repeat(32)}`,
                data: result.pendingNote.label,
            });
            expect(result.pendingNote.isOwned).toBe(false);
        });

        it("refuses a builder returning a malformed payload before proving", async () => {
            const noteAddressHash = noteComputation.computeNoteAddressHash(
                RECIPIENT,
                cryptoService.generateSecret(),
            );
            await expect(
                h.service.prepareSwapAndDeposit(
                    params({
                        depositToken: DEP.ppUSDC,
                        recipient: {
                            noteAddressHash,
                            noteData: (() => ({ hint: "nope" })) as never,
                        },
                    }),
                ),
            ).rejects.toBeInstanceOf(InvalidDepositParams);
            expect(h.provider.getSwapAndDepositQuote).not.toHaveBeenCalled();
        });

        it("rejects an async noteData builder at parse time, before any network call", async () => {
            const noteAddressHash = noteComputation.computeNoteAddressHash(
                RECIPIENT,
                cryptoService.generateSecret(),
            );
            const forSpy = vi.spyOn(h.deposit, "prepareDepositFor");
            await expect(
                h.service.prepareSwapAndDeposit(
                    params({
                        depositToken: DEP.ppUSDC,
                        recipient: {
                            noteAddressHash,
                            noteData: (async () => ({ hint: "0x", data: "0x" })) as never,
                        },
                    }),
                ),
            ).rejects.toBeInstanceOf(InvalidSwapAndDepositParams);
            expect(forSpy).not.toHaveBeenCalled();
            expect(h.provider.getSwapAndDepositQuote).not.toHaveBeenCalled();
        });

        it("names the problem when a builder returns a Promise past the schema", async () => {
            const noteAddressHash = noteComputation.computeNoteAddressHash(
                RECIPIENT,
                cryptoService.generateSecret(),
            );
            // A plain function returning a Promise looks like a transpiled async builder.
            const builder = () => Promise.resolve({ hint: "0x" as Hex, data: "0x" as Hex });
            await expect(
                h.service.prepareSwapAndDeposit(
                    params({
                        depositToken: DEP.ppUSDC,
                        recipient: { noteAddressHash, noteData: builder as never },
                    }),
                ),
            ).rejects.toThrow(/must be synchronous/);
            expect(h.provider.getSwapAndDepositQuote).not.toHaveBeenCalled();
        });

        it("keeps the yield deposit the owner's without a recipient", async () => {
            const forSpy = vi.spyOn(h.deposit, "prepareDepositFor");
            const result = await h.service.prepareSwapAndDeposit(
                params({ depositToken: DEP.ppUSDC }),
            );
            expect(forSpy).not.toHaveBeenCalled();
            expect(result.pendingNote.isOwned).toBe(true);
        });
    });

    describe("cross-chain", () => {
        let h: Harness;
        beforeEach(() => {
            h = buildHarness({ crossChain: true, withYield: true });
        });

        it("lands a recipient's note on the destination pool and refunds the PAYER on a failed delivery", async () => {
            const result = await h.service.prepareSwapAndDeposit(
                params({
                    fromChainId: SOURCE_CHAIN_ID,
                    recipient: { discoveryData: { evmAddress: RECIPIENT } },
                }),
            );
            const req = vi.mocked(h.provider.getSwapAndDepositQuote).mock.calls[0][0];
            expect(req.fromChainId).toBe(SOURCE_CHAIN_ID);
            expect(req.toChainId).toBe(POOL_CHAIN_ID);
            expect(req.fallbackAddress).toBe(PAYER);
            expect(result.pendingNote.isOwned).toBe(false);
            expect(
                recipientDiscovers(noteEventFrom(embeddedNoteData(h.provider)))[0]?.commitment,
            ).toBe(result.pendingNote.commitment);

            await h.service.executeSwapAndDeposit(result);
            expect(h.sourceWallet.sendTransaction).toHaveBeenCalled();
            expect(h.notes.addNote).not.toHaveBeenCalled();
        });

        it("sizes a recipient's yield share with the cross-chain headroom", async () => {
            const result = await h.service.prepareSwapAndDeposit(
                params({
                    fromChainId: SOURCE_CHAIN_ID,
                    depositToken: DEP.ppUSDC,
                    recipient: { discoveryData: { evmAddress: RECIPIENT } },
                }),
            );
            expect(result.pendingNote.isOwned).toBe(false);
            expect(result.pendingNote.tokenId).toBe(DEP.ppUSDC);
            // 500 ppm headroom (cross-chain) leaves fewer shares than the 1 ppm same-chain sizing.
            const same = await buildHarness({
                withYield: true,
            }).service.prepareSwapAndDeposit(params({ depositToken: DEP.ppUSDC }));
            expect(BigInt(result.pendingNote.value)).toBeLessThan(BigInt(same.pendingNote.value));
        });
    });

    it("refuses a delegate that hands back an OWNED note for a recipient", async () => {
        const h = buildHarness();
        const real = h.deposit.prepareDepositFor.bind(h.deposit);
        vi.spyOn(h.deposit, "prepareDepositFor").mockImplementation(async (p) => {
            const r = await real(p);
            return { ...r, pendingNote: { ...r.pendingNote, isOwned: true } };
        });
        await expect(
            h.service.prepareSwapAndDeposit(
                params({ recipient: { discoveryData: { evmAddress: RECIPIENT } } }),
            ),
        ).rejects.toBeInstanceOf(InvalidSwapAndDepositParams);
    });
});
