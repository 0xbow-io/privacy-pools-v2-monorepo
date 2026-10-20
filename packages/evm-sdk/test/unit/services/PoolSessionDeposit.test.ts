import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    AssetConfig,
    DepositCircuitInputs,
    DepositForParams,
    DepositParams,
    FinalizedBlockResult,
    Hash,
    Hex,
    IASPClient,
    ICryptoService,
    IEntrypointInteractor,
    IKeystoreInteractor,
    IKeystoreManager,
    INoteComputationService,
    INoteManager,
    IPoolVaultInteractor,
    IProofService,
    IRPCInteractor,
    IWitnessPreparationService,
    PoolSessionDepositConfig,
    ProofResult,
    PublicKey,
    Secret,
} from "../../../src/internal.js";
import {
    AssetNotEnabled,
    BelowMinimumAmount,
    DepositRecipientViewingKeyUnregistered,
    EMPTY_NOTE_DATA,
    AddressSchema,
    ENTRYPOINT_DEPOSIT_ABI,
    ERC20_APPROVE_ABI,
    EvmAddressEqualityComparator,
    EvmAddressFieldConverter,
    EvmContextHashService,
    EvmPreparedTxVerifier,
    InvalidDepositParams,
    InvalidPoolSessionConfig,
    NATIVE_ASSET_ADDRESS,
    NoteComputationService,
    NoteStatus,
    PoolSessionDeposit,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_ENTRYPOINT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const VALID_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const VALID_VALUE = "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000" as Hex; // 1e18
const MOCK_SECRET = "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
const MOCK_COMMITMENT = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const MOCK_LABEL = "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;
const ZERO_ALLOWANCE = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hash;
const SUFFICIENT_ALLOWANCE =
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hash;
const RECIPIENT_ADDRESS = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const ZERO_VIEWING_KEY =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as Hash;

const ENABLED_ASSET_CONFIG: AssetConfig = {
    enabled: true,
    vettingFeeBPS: "0x0000000000000000000000000000000000000000000000000000000000000032" as Hash, // 50 BPS = 0.5%
    minAmount: "0x0000000000000000000000000000000000000000000000000000000000000001" as Hash,
    maxRelayFee: "0x0000000000000000000000000000000000000000000000000000000000000064" as Hash,
};

const DISABLED_ASSET_CONFIG: AssetConfig = {
    enabled: false,
    vettingFeeBPS: "0x0000000000000000000000000000000000000000000000000000000000000032" as Hash,
    minAmount: "0x0000000000000000000000000000000000000000000000000000000000000001" as Hash,
    maxRelayFee: "0x0000000000000000000000000000000000000000000000000000000000000064" as Hash,
};

const HIGH_MIN_ASSET_CONFIG: AssetConfig = {
    enabled: true,
    vettingFeeBPS: "0x0000000000000000000000000000000000000000000000000000000000000032" as Hash,
    minAmount: "0x00000000000000000000000000000000000000000000d3c21bcecceda1000000" as Hash, // 1e24
    maxRelayFee: "0x0000000000000000000000000000000000000000000000000000000000000064" as Hash,
};

const COMPUTED_CONTEXT = keccak256(
    encodeAbiParameters(
        [
            {
                type: "tuple",
                components: [
                    { name: "hint", type: "bytes32" },
                    { name: "data", type: "bytes" },
                ],
            },
        ],
        [{ hint: EMPTY_NOTE_DATA.hint, data: EMPTY_NOTE_DATA.data }],
    ),
) as Hex;

const MOCK_NOTE_ADDR_HASH =
    "0x4444444444444444444444444444444444444444444444444444444444444444" as Hex;

const MOCK_DEPOSIT_WITNESS: DepositCircuitInputs = {
    tokenId: VALID_TOKEN,
    value: VALID_VALUE,
    context: COMPUTED_CONTEXT,
    noteAddressHash: MOCK_NOTE_ADDR_HASH,
    depositSecret: MOCK_SECRET,
};

const MOCK_PROOF_RESULT: ProofResult = {
    proof: {
        pi_a: [
            "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
            "0x0000000000000000000000000000000000000000000000000000000000000002" as Hex,
            "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
        ],
        pi_b: [
            [
                "0x0000000000000000000000000000000000000000000000000000000000000003" as Hex,
                "0x0000000000000000000000000000000000000000000000000000000000000004" as Hex,
                "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
            ],
            [
                "0x0000000000000000000000000000000000000000000000000000000000000005" as Hex,
                "0x0000000000000000000000000000000000000000000000000000000000000006" as Hex,
                "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
            ],
        ],
        pi_c: [
            "0x0000000000000000000000000000000000000000000000000000000000000007" as Hex,
            "0x0000000000000000000000000000000000000000000000000000000000000008" as Hex,
            "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
        ],
        protocol: "groth16",
        curve: "bn128",
    },
    publicSignals: [
        "0x000000000000000000000000000000000000000000000000000000000000000a" as Hex,
        "0x000000000000000000000000000000000000000000000000000000000000000b" as Hex,
        "0x000000000000000000000000000000000000000000000000000000000000000c" as Hex,
        "0x000000000000000000000000000000000000000000000000000000000000000d" as Hex,
    ],
};

const MOCK_ASP_PUBLIC_KEY =
    "0x031fa9e4035013764254198fabc6c1e61375a5ead70e788a8b9727cbdbe38b87e5" as PublicKey;
const MOCK_VIEWING_PRIVATE_KEY =
    "0x5555555555555555555555555555555555555555555555555555555555555555" as Secret;
const MOCK_VIEWING_PUBLIC_KEY =
    "0x026666666666666666666666666666666666666666666666666666666666666666" as PublicKey;
const MOCK_EPHEMERAL_PRIVATE_KEY =
    "0x8888888888888888888888888888888888888888888888888888888888888888" as Secret;
const MOCK_EPHEMERAL_PUBLIC_KEY =
    "0x9999999999999999999999999999999999999999999999999999999999999999" as PublicKey;
const MOCK_SHARED_SECRET =
    "0x7777777777777777777777777777777777777777777777777777777777777777" as Secret;
const MOCK_ENCRYPTED = "0xdeadbeef" as Hex;

function createMockASPClient(): IASPClient {
    return {
        getAssociationSetRoot: vi.fn(),
        getAssociationSetLeaves: vi.fn(),
        getMerkleProof: vi.fn(),
        getLabelStatus: vi.fn(),
        getASPPublicKey: vi.fn(async () => MOCK_ASP_PUBLIC_KEY),
    };
}

function createMockKeystoreManager(): IKeystoreManager {
    return {
        getPrivateNullifyingKey: vi.fn(() => MOCK_SECRET),
        getPrivateRevocableKey: vi.fn(() => MOCK_SECRET),
        getViewingKeyPair: vi.fn(() => ({
            privateKey: MOCK_VIEWING_PRIVATE_KEY,
            publicKey: MOCK_VIEWING_PUBLIC_KEY,
        })),
        applyRotation: vi.fn(),
        getRevocableKeyIndex: vi.fn().mockReturnValue("0x0"),
        isRegistered: vi.fn(),
        markRegistered: vi.fn(),
    };
}

function createMockCryptoService(): ICryptoService {
    return {
        ecdh: vi.fn(() => MOCK_SHARED_SECRET),
        encrypt: vi.fn(() => MOCK_ENCRYPTED),
        decrypt: vi.fn(),
        generateSecret: vi.fn(() => MOCK_SECRET),
        generateEphemeralKeyPair: vi.fn(() => ({
            privateKey: MOCK_EPHEMERAL_PRIVATE_KEY,
            publicKey: MOCK_EPHEMERAL_PUBLIC_KEY,
        })),
        deriveKeysFromSignature: vi.fn(),
        derivePaymentRequestKeyPair: vi.fn(),
    };
}

function createMockWitnessService(
    impl?: IWitnessPreparationService["buildDepositWitness"],
): IWitnessPreparationService {
    return {
        buildDepositWitness: vi.fn(
            impl ?? (async (): Promise<DepositCircuitInputs> => MOCK_DEPOSIT_WITNESS),
        ),
        buildTransactWitness: vi.fn(),
        buildRagequitWitness: vi.fn(),
    };
}

function createMockProofService(impl?: IProofService["proveDeposit"]): IProofService {
    return {
        proveDeposit: vi.fn(impl ?? (async (): Promise<ProofResult> => MOCK_PROOF_RESULT)),
        proveTransact: vi.fn(),
        proveRagequit: vi.fn(),
        verifyDeposit: vi.fn(),
        verifyTransact: vi.fn(),
        verifyRagequit: vi.fn(),
        loadCircuit: vi.fn(),
        formatForChain: vi.fn().mockReturnValue({
            pA: [0n, 0n],
            pB: [
                [0n, 0n],
                [0n, 0n],
            ],
            pC: [0n, 0n],
            pubSignals: [0n],
        }),
    };
}

function createMockEntrypointInteractor(
    getAssetConfigImpl?: (...args: unknown[]) => Promise<AssetConfig>,
    getAllowanceImpl?: (...args: unknown[]) => Promise<Hash>,
): IEntrypointInteractor {
    return {
        getAddress: vi.fn(() => VALID_ENTRYPOINT),
        getPoolVaultAddress: vi.fn(),
        getASPRegistryAddress: vi.fn(),
        getAssetConfig: vi.fn(
            getAssetConfigImpl ?? (async (): Promise<AssetConfig> => ENABLED_ASSET_CONFIG),
        ),
        getAllowance: vi.fn(getAllowanceImpl ?? (async (): Promise<Hash> => SUFFICIENT_ALLOWANCE)),
        encodeDeposit: vi.fn(
            (_proof: unknown, _noteData: unknown, aspCiphertext: Hex, msgValue: Hex) =>
                Promise.resolve({
                    to: VALID_ENTRYPOINT,
                    // Real `deposit`-encoded calldata so executeDeposit's selector
                    // check passes; the ciphertext is embedded as the bytes arg so
                    // assertions that look for it in callData still hold.
                    data: encodeFunctionData({
                        abi: ENTRYPOINT_DEPOSIT_ABI,
                        functionName: "deposit",
                        args: [
                            {
                                pA: [0n, 0n],
                                pB: [
                                    [0n, 0n],
                                    [0n, 0n],
                                ],
                                pC: [0n, 0n],
                                pubSignals: [0n, 0n, 0n, 0n],
                            },
                            { hint: `0x${"00".repeat(32)}` as Hex, data: "0x" as Hex },
                            aspCiphertext,
                        ] as const,
                    }),
                    value: msgValue,
                }),
        ),
        encodeApprove: vi.fn((token: Address, amount: Hex) => {
            const spenderPadded = VALID_ENTRYPOINT.slice(2).toLowerCase().padStart(64, "0");
            const amountPadded = BigInt(amount).toString(16).padStart(64, "0");
            return Promise.resolve({
                to: token,
                data: ("0x095ea7b3" + spenderPadded + amountPadded) as Hex,
                value: "0x0" as Hex,
            });
        }),
        submitTransaction: vi.fn().mockResolvedValue("0x1234" as Hex),
    };
}

function createMockNoteComputationService(): INoteComputationService {
    return {
        computeNoteAddressHash: vi.fn(() => MOCK_COMMITMENT),
        computePrecommitment: vi.fn(() => MOCK_COMMITMENT),
        computeLabel: vi.fn(() => MOCK_LABEL),
        computeFullCommitment: vi.fn(() => MOCK_COMMITMENT),
        computeAuthDigest: vi.fn(() => MOCK_COMMITMENT),
        computeNullifier: vi.fn(() => MOCK_COMMITMENT),
        computeLabelHash: vi.fn(() => MOCK_LABEL),
        encodeNotePayload: vi.fn(() => new Uint8Array(117)),
        decodeNotePayload: vi.fn(() => ({
            noteSecret: MOCK_SECRET,
            value: VALID_VALUE,
            tokenId: VALID_TOKEN as Address,
            label: MOCK_LABEL,
        })),
        generateNoteData: vi.fn(() => ({
            hint: `0x${"00".repeat(32)}` as Hex,
            data: ("0x" + MOCK_VIEWING_PUBLIC_KEY.slice(2) + MOCK_ENCRYPTED.slice(2)) as Hex,
        })),
        encodePaymentRequestNotePayload: vi.fn(() => new Uint8Array()),
        decodePaymentRequestNotePayload: vi.fn(),
        generatePaymentRequestNoteData: vi.fn(() => ({
            hint: `0x${"00".repeat(32)}` as Hex,
            data: ("0x" + MOCK_VIEWING_PUBLIC_KEY.slice(2) + MOCK_ENCRYPTED.slice(2)) as Hex,
        })),
    };
}

function createMockNoteManager(): INoteManager {
    return {
        addNote: vi.fn(),
        updateNoteStatus: vi.fn(),
        deleteNote: vi.fn(),
        updateNote: vi.fn(),
        getNotes: vi.fn(),
        getNote: vi.fn(),
        getNoteLineage: vi.fn(),
        getAllLineages: vi.fn(),
        computeAggregates: vi.fn(),
        exportState: vi.fn(),
        importState: vi.fn(),
        getSyncCursor: vi.fn(() => "0x0"),
        setSyncCursor: vi.fn(),
        flush: vi.fn(async () => undefined),
        loadFromStorage: vi.fn(async () => undefined),
    };
}

function createMockKeystoreInteractor(): IKeystoreInteractor {
    return {
        getAddress: vi.fn(() => VALID_ENTRYPOINT),
        getNullifyingKeyHash: vi.fn(async () => MOCK_COMMITMENT as Hash),
        getViewingKey: vi.fn(async () => MOCK_VIEWING_PUBLIC_KEY as unknown as Hash),
        isKnownRoot: vi.fn(async () => true),
        getKeystoreLeaves: vi.fn(async () => []),
        exportLeafCache: vi.fn(() => undefined),
        getCurrentAuthorizerDigest: vi.fn(async () => null),
        encodeSetAuthPolicy: vi
            .fn()
            .mockReturnValue({ to: VALID_ENTRYPOINT, data: "0x00" as Hex, value: "0x0" as Hex }),
        encodeSetViewingKey: vi
            .fn()
            .mockReturnValue({ to: VALID_ENTRYPOINT, data: "0x00" as Hex, value: "0x0" as Hex }),
        encodeUpdateAuthPolicy: vi
            .fn()
            .mockReturnValue({ to: VALID_ENTRYPOINT, data: "0x00" as Hex, value: "0x0" as Hex }),
        submitTransaction: vi.fn().mockResolvedValue("0x1234" as Hex),
        signTypedData: vi.fn().mockResolvedValue("0xsig" as Hex),
        buildRegistrationAuthorization: vi.fn(),
        signRegistrationAuthorization: vi.fn(),
    };
}

const MOCK_TIMESTAMP = "0x0000000000000000000000000000000000000000000000000000000067890abc" as Hash;

function createMockPoolVaultInteractor(): IPoolVaultInteractor {
    return {
        getAddress: vi.fn(() => VALID_ENTRYPOINT),
        getCurrentCursor: vi.fn(async () => "0x0" as Hex),
        resolveTokenId: vi.fn(async (fieldValue) => fieldValue as unknown as typeof VALID_ENTRYPOINT),
        getCommitmentTimestamp: vi.fn(async () => MOCK_TIMESTAMP),
        getNullifierTimestamp: vi.fn(async () => "0x0" as Hash),
        isKnownRoot: vi.fn(async () => true),
        getStateLeaves: vi.fn(async () => []),
        exportLeafCache: vi.fn(() => undefined),
        getNoteEvents: vi.fn(async () => []),
        getTransactedEvents: vi.fn(async () => []),
        extractSpentNullifiers: vi.fn(() => []),
        getDepositedEvents: vi.fn(async () => []),
        getRagequitEvents: vi.fn(async () => []),
        encodeRagequit: vi
            .fn()
            .mockReturnValue({ to: VALID_ENTRYPOINT, data: "0x00" as Hex, value: "0x0" as Hex }),
        encodeTransact: vi
            .fn()
            .mockReturnValue({ to: VALID_ENTRYPOINT, data: "0x00" as Hex, value: "0x0" as Hex }),
        submitTransaction: vi.fn().mockResolvedValue("0x1234" as Hex),
    };
}

function createMockRPCInteractor(): IRPCInteractor {
    return {
        readContract: vi.fn(),
        getBlockNumber: vi.fn(),
        getFinalizedBlockNumber: vi.fn(
            async () => ({ status: "unsupported" }) as FinalizedBlockResult,
        ),
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
            status: true,
            blockNumber: "0x1" as Hex,
            txHash: "0x1" as Hex,
            logs: [],
        }),
        getLogs: vi.fn(),
        getLogsPaginated: vi.fn(),
    };
}

function createDefaultConfig(): PoolSessionDepositConfig {
    return {
        ownerAddress: VALID_OWNER,
        cryptoService: createMockCryptoService(),
        witnessPreparationService: createMockWitnessService(),
        proofService: createMockProofService(),
        entrypointInteractor: createMockEntrypointInteractor(),
        noteManager: createMockNoteManager(),
        aspClient: createMockASPClient(),
        keystoreManager: createMockKeystoreManager(),
        noteComputationService:
            createMockNoteComputationService() as unknown as NoteComputationService,
        keystoreInteractor: createMockKeystoreInteractor(),
        poolVaultInteractor: createMockPoolVaultInteractor(),
        rpcInteractor: createMockRPCInteractor(),
        contextHashService: new EvmContextHashService(),
        preparedTxVerifier: new EvmPreparedTxVerifier(),
        addressFieldConverter: new EvmAddressFieldConverter(),
        addressEqualityComparator: new EvmAddressEqualityComparator(),
        addressSchema: AddressSchema,
    };
}

describe("PoolSessionDeposit", () => {
    let service: PoolSessionDeposit;
    let config: ReturnType<typeof createDefaultConfig>;

    beforeEach(() => {
        config = createDefaultConfig();
        service = new PoolSessionDeposit(config);
    });

    describe("constructor", () => {
        it("create instance with valid config", () => {
            expect(service).toBeInstanceOf(PoolSessionDeposit);
        });

        it("reject invalid owner address", () => {
            expect(
                () =>
                    new PoolSessionDeposit({
                        ...config,
                        ownerAddress: "not-an-address" as Address,
                    }),
            ).toThrow(InvalidPoolSessionConfig);
        });
    });

    describe("prepareDeposit", () => {
        const validParams: DepositParams = {
            tokenId: VALID_TOKEN,
            value: VALID_VALUE,
        };

        it("return calldata for a valid native ETH deposit", async () => {
            config.entrypointInteractor = createMockEntrypointInteractor(
                async () => ENABLED_ASSET_CONFIG,
            );
            service = new PoolSessionDeposit(config);

            const result = await service.prepareDeposit({
                tokenId: NATIVE_ASSET_ADDRESS,
                value: VALID_VALUE,
            });

            expect(result.pendingNote!.commitment).toBe(MOCK_COMMITMENT);
            expect(result.pendingNote!.label).toBe(MOCK_LABEL);
            expect(result.pendingNote!.value).toBe(VALID_VALUE);
            expect(result.pendingNote!.tokenId).toBe(NATIVE_ASSET_ADDRESS);
            expect(result.pendingNote!.status).toBe(NoteStatus.PENDING);
            expect(result.depositTx.data).toMatch(/^0x/);
            expect(result.depositTx.to).toBe(VALID_ENTRYPOINT);
            expect(result.approvalTx).toBeNull();
        });

        it("return calldata for a valid ERC-20 deposit", async () => {
            const result = await service.prepareDeposit(validParams);

            expect(result.pendingNote!.commitment).toBe(MOCK_COMMITMENT);
            expect(result.pendingNote!.label).toBe(MOCK_LABEL);
            expect(result.pendingNote!.value).toBe(VALID_VALUE);
            expect(result.pendingNote!.tokenId).toBe(VALID_TOKEN);
            expect(result.pendingNote!.status).toBe(NoteStatus.PENDING);
            expect(result.depositTx.data).toMatch(/^0x/);
            expect(result.depositTx.to).toBe(VALID_ENTRYPOINT);
            expect(result.approvalTx).toBeNull();
        });

        it("compute correct msgValue for native ETH (value + fee)", async () => {
            config.entrypointInteractor = createMockEntrypointInteractor(
                async () => ENABLED_ASSET_CONFIG,
            );
            service = new PoolSessionDeposit(config);

            // value = 1e18, fee = 1e18 * 50 / 10000 = 5e15
            // total = 1e18 + 5e15 = 1005000000000000000 = 0x0df27a2616c9c000
            const result = await service.prepareDeposit({
                tokenId: NATIVE_ASSET_ADDRESS,
                value: VALID_VALUE,
            });

            const msgValueBigInt = BigInt(result.depositTx.value);
            const valueBigInt = BigInt(VALID_VALUE);
            const expectedFee = (valueBigInt * 50n) / 10_000n;
            expect(msgValueBigInt).toBe(valueBigInt + expectedFee);
        });

        it("set msgValue to 0x0 for ERC-20 deposits", async () => {
            const result = await service.prepareDeposit(validParams);

            expect(BigInt(result.depositTx.value)).toBe(0n);
        });

        it("reject disabled asset with AssetNotEnabled", async () => {
            config.entrypointInteractor = createMockEntrypointInteractor(
                async () => DISABLED_ASSET_CONFIG,
            );
            service = new PoolSessionDeposit(config);

            await expect(service.prepareDeposit(validParams)).rejects.toThrow(AssetNotEnabled);
        });

        it("reject amount below minimum with BelowMinimumAmount", async () => {
            config.entrypointInteractor = createMockEntrypointInteractor(
                async () => HIGH_MIN_ASSET_CONFIG,
            );
            service = new PoolSessionDeposit(config);

            await expect(service.prepareDeposit(validParams)).rejects.toThrow(BelowMinimumAmount);
        });

        it("reject invalid tokenId with InvalidDepositParams", async () => {
            await expect(
                service.prepareDeposit({
                    tokenId: "bad" as Address,
                    value: VALID_VALUE,
                }),
            ).rejects.toThrow(InvalidDepositParams);
        });

        it("reject invalid value with InvalidDepositParams", async () => {
            await expect(
                service.prepareDeposit({
                    tokenId: VALID_TOKEN,
                    value: "not-hex" as Hex,
                }),
            ).rejects.toThrow(InvalidDepositParams);
        });

        it("propagate witness errors", async () => {
            config.witnessPreparationService = createMockWitnessService(async () => {
                throw new Error("hash computation failed");
            });
            service = new PoolSessionDeposit(config);

            await expect(service.prepareDeposit(validParams)).rejects.toThrow(
                "hash computation failed",
            );
        });

        it("propagate proof errors", async () => {
            config.proofService = createMockProofService(async () => {
                throw new Error("snarkjs failed");
            });
            service = new PoolSessionDeposit(config);

            await expect(service.prepareDeposit(validParams)).rejects.toThrow("snarkjs failed");
        });

        it("call witnessPreparationService with correct inputs", async () => {
            await service.prepareDeposit(validParams);

            const call = (
                config.witnessPreparationService.buildDepositWitness as ReturnType<typeof vi.fn>
            ).mock.calls[0][0] as Record<string, unknown>;
            expect(call.noteAddressHash).toBe(MOCK_COMMITMENT);
            expect(call.tokenId).toBe(VALID_TOKEN);
            expect(call.value).toBe(VALID_VALUE);
            expect(call.depositSecret).toBe(MOCK_SECRET);
            // Context is derived from the real encrypted noteData, not EMPTY_NOTE_DATA
            expect(call.context).toMatch(/^0x[0-9a-f]+$/);
        });

        it("call proofService with witness from witnessPreparationService", async () => {
            await service.prepareDeposit(validParams);

            expect(config.proofService.proveDeposit).toHaveBeenCalledWith(MOCK_DEPOSIT_WITNESS);
        });

        it("generate ASP ciphertext with an ephemeral keypair and the ASP public key", async () => {
            await service.prepareDeposit(validParams);

            expect(config.aspClient.getASPPublicKey).toHaveBeenCalledOnce();
            expect(config.cryptoService.generateEphemeralKeyPair).toHaveBeenCalledOnce();
            expect(config.keystoreManager.getViewingKeyPair).toHaveBeenCalledOnce();
            expect(config.cryptoService.ecdh).toHaveBeenCalledWith(
                MOCK_EPHEMERAL_PRIVATE_KEY,
                MOCK_ASP_PUBLIC_KEY,
            );
            expect(config.cryptoService.ecdh).not.toHaveBeenCalledWith(
                MOCK_VIEWING_PRIVATE_KEY,
                MOCK_ASP_PUBLIC_KEY,
            );
            expect(config.cryptoService.encrypt).toHaveBeenCalledOnce();
        });

        it("encode ASP ciphertext as ephemeralPublicKey concatenated with encrypted payload", async () => {
            const result = await service.prepareDeposit(validParams);

            const ephemeralPubHex = MOCK_EPHEMERAL_PUBLIC_KEY.slice(2).toLowerCase();
            const encryptedHex = MOCK_ENCRYPTED.slice(2).toLowerCase();
            const viewingPubHex = MOCK_VIEWING_PUBLIC_KEY.slice(2).toLowerCase();
            expect(result.depositTx.data.toLowerCase()).toContain(ephemeralPubHex + encryptedHex);
            expect(result.depositTx.data.toLowerCase()).not.toContain(viewingPubHex);
        });

        it("pass correct payload fields to encrypt", async () => {
            await service.prepareDeposit(validParams);

            // First (and only) encrypt call is the ASP ciphertext (note data encryption is inside NoteComputationService)
            const encryptCall = vi.mocked(config.cryptoService.encrypt).mock.calls[0];
            const plaintext = new TextDecoder().decode(encryptCall[0]);
            const payload = JSON.parse(plaintext) as Record<string, string>;

            expect(payload["noteAddressHash"]).toBe(MOCK_DEPOSIT_WITNESS.noteAddressHash);
            expect(payload["tokenId"]).toBe(VALID_TOKEN);
            expect(payload["value"]).toBe(VALID_VALUE);
            expect(payload["depositSecret"]).toBe(MOCK_SECRET);
            expect(payload["metadata"]).toBe("0x0");
        });

        it("not call noteManager.addNote during prepare", async () => {
            await service.prepareDeposit(validParams);

            expect(config.noteManager.addNote).not.toHaveBeenCalled();
        });

        it("return pendingNote with owner info for self-deposit", async () => {
            const result = await service.prepareDeposit(validParams);

            expect(result.pendingNote).toBeDefined();
            expect(result.pendingNote).toEqual(
                expect.objectContaining({
                    noteAddressHash: result.pendingNote!.noteAddressHash,
                    commitment: result.pendingNote!.commitment,
                    value: result.pendingNote!.value,
                    tokenId: result.pendingNote!.tokenId,
                    label: result.pendingNote!.label,
                    ownerAddress: VALID_OWNER,
                    noteSecret: MOCK_SECRET,
                    isOwned: true,
                }),
            );
        });

        describe("approvalTx", () => {
            it("return null approvalTx for native ETH deposit", async () => {
                config.entrypointInteractor = createMockEntrypointInteractor(
                    async () => ENABLED_ASSET_CONFIG,
                );
                service = new PoolSessionDeposit(config);

                const result = await service.prepareDeposit({
                    tokenId: NATIVE_ASSET_ADDRESS,
                    value: VALID_VALUE,
                });

                expect(result.approvalTx).toBeNull();
            });

            it("return null approvalTx when ERC-20 allowance is sufficient", async () => {
                config.entrypointInteractor = createMockEntrypointInteractor(
                    undefined,
                    async () => SUFFICIENT_ALLOWANCE,
                );
                service = new PoolSessionDeposit(config);

                const result = await service.prepareDeposit(validParams);

                expect(result.approvalTx).toBeNull();
            });

            it("plan approve(0) then approve(total) when a non-zero allowance is too small (mainnet USDT)", async () => {
                const RESIDUAL =
                    "0x0000000000000000000000000000000000000000000000000000000000000005" as Hash;
                config.entrypointInteractor = createMockEntrypointInteractor(
                    undefined,
                    async () => RESIDUAL,
                );
                service = new PoolSessionDeposit(config);
                const result = await service.prepareDeposit(validParams);
                expect(result.approvalTxs).toHaveLength(2);
                const amounts = result.approvalTxs.map(
                    (tx) => decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: tx.data }).args[1],
                );
                expect(amounts[0]).toBe(0n);
                expect(amounts[1]).toBeGreaterThan(0n);
                expect(result.approvalTx).toBe(result.approvalTxs[1]);
            });

            it("return approvalTx when ERC-20 allowance is zero", async () => {
                config.entrypointInteractor = createMockEntrypointInteractor(
                    undefined,
                    async () => ZERO_ALLOWANCE,
                );
                service = new PoolSessionDeposit(config);

                const result = await service.prepareDeposit(validParams);

                expect(result.approvalTx).not.toBeNull();
                expect(result.approvalTx!.to).toBe(VALID_TOKEN);
                expect(result.approvalTx!.value).toBe("0x0");
                // approve(address,uint256) selector = 0x095ea7b3
                expect(result.approvalTx!.data.startsWith("0x095ea7b3")).toBe(true);
            });

            it("return approvalTx encoding approve for exactly the deposit value", async () => {
                config.entrypointInteractor = createMockEntrypointInteractor(
                    undefined,
                    async () => ZERO_ALLOWANCE,
                );
                service = new PoolSessionDeposit(config);

                const result = await service.prepareDeposit(validParams);

                // The calldata encodes approve(VALID_ENTRYPOINT, VALID_VALUE + vettingFee)
                // VALID_ENTRYPOINT padded to 32 bytes should appear in the data
                const entrypointPadded = VALID_ENTRYPOINT.slice(2).toLowerCase().padStart(64, "0");
                expect(result.approvalTx!.data.toLowerCase()).toContain(entrypointPadded);
                // Approval amount = value + fee (value * feeBPS / 10000)
                const valueBigInt = BigInt(VALID_VALUE);
                const feeBPS = BigInt(ENABLED_ASSET_CONFIG.vettingFeeBPS);
                const totalAmount = valueBigInt + (valueBigInt * feeBPS) / 10_000n;
                const totalPadded = totalAmount.toString(16).padStart(64, "0");
                expect(result.approvalTx!.data.toLowerCase()).toContain(totalPadded);
            });

            it("return approvalTx when allowance is below deposit value", async () => {
                // Allowance = 1 wei, deposit value = 1e18 — insufficient
                const lowAllowance =
                    "0x0000000000000000000000000000000000000000000000000000000000000001" as Hash;
                config.entrypointInteractor = createMockEntrypointInteractor(
                    undefined,
                    async () => lowAllowance,
                );
                service = new PoolSessionDeposit(config);

                const result = await service.prepareDeposit(validParams);

                expect(result.approvalTx).not.toBeNull();
            });

            it("not call getAllowance for native ETH deposits", async () => {
                config.entrypointInteractor = createMockEntrypointInteractor(
                    async () => ENABLED_ASSET_CONFIG,
                );
                service = new PoolSessionDeposit(config);

                await service.prepareDeposit({
                    tokenId: NATIVE_ASSET_ADDRESS,
                    value: VALID_VALUE,
                });

                expect(config.entrypointInteractor.getAllowance).not.toHaveBeenCalled();
            });

            it("propagate getAllowance errors", async () => {
                config.entrypointInteractor = createMockEntrypointInteractor(
                    undefined,
                    async () => {
                        throw new Error("RPC timeout");
                    },
                );
                service = new PoolSessionDeposit(config);

                await expect(service.prepareDeposit(validParams)).rejects.toThrow("RPC timeout");
            });
        });
    });

    describe("prepareDepositFor", () => {
        const MOCK_NOTE_ADDRESS_HASH =
            "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex;

        let validForParams: DepositForParams;

        beforeEach(() => {
            validForParams = {
                tokenId: VALID_TOKEN,
                value: VALID_VALUE,
                noteAddressHash: MOCK_NOTE_ADDRESS_HASH,
            };
        });

        it("return a valid PrepareDepositResult", async () => {
            const result = await service.prepareDepositFor(validForParams);

            expect(result.depositTx.data).toMatch(/^0x/);
            expect(result.depositTx.to).toBe(VALID_ENTRYPOINT);
        });

        it("return pendingNote with isOwned false for deposit-for", async () => {
            const result = await service.prepareDepositFor(validForParams);

            expect(result.pendingNote.isOwned).toBe(false);
        });

        it("call buildDepositWitness with noteAddressHash", async () => {
            await service.prepareDepositFor(validForParams);

            expect(config.witnessPreparationService.buildDepositWitness).toHaveBeenCalledWith(
                expect.objectContaining({
                    noteAddressHash: MOCK_NOTE_ADDRESS_HASH,
                    tokenId: VALID_TOKEN,
                    value: VALID_VALUE,
                    context: COMPUTED_CONTEXT,
                }),
            );
        });

        it("generate ASP ciphertext", async () => {
            await service.prepareDepositFor(validForParams);

            expect(config.aspClient.getASPPublicKey).toHaveBeenCalledOnce();
            expect(config.cryptoService.encrypt).toHaveBeenCalledOnce();
        });

        it("reject invalid noteAddressHash", async () => {
            await expect(
                service.prepareDepositFor({
                    tokenId: VALID_TOKEN,
                    value: VALID_VALUE,
                    noteAddressHash: "bad" as Hex,
                }),
            ).rejects.toThrow(InvalidDepositParams);
        });

        describe("discoveryData", () => {
            it("use EMPTY_NOTE_DATA when discoveryData is omitted", async () => {
                await service.prepareDepositFor(validForParams);

                expect(config.noteComputationService.generateNoteData).not.toHaveBeenCalled();
                expect(config.witnessPreparationService.buildDepositWitness).toHaveBeenCalledWith(
                    expect.objectContaining({ context: COMPUTED_CONTEXT }),
                );
            });

            it("call generateNoteData when discoveryData has publicViewingKey", async () => {
                const paramsWithViewingKey: DepositForParams = {
                    tokenId: VALID_TOKEN,
                    value: VALID_VALUE,
                    discoveryData: {
                        publicViewingKey: MOCK_VIEWING_PUBLIC_KEY as unknown as Hex,
                        noteAddressHash: MOCK_NOTE_ADDRESS_HASH,
                        noteSecret: MOCK_SECRET as unknown as Hex,
                    },
                };

                await service.prepareDepositFor(paramsWithViewingKey);

                expect(config.noteComputationService.generateNoteData).toHaveBeenCalledWith(
                    expect.objectContaining({
                        noteSecret: MOCK_SECRET,
                        value: VALID_VALUE,
                        tokenId: VALID_TOKEN,
                        label: MOCK_LABEL,
                    }),
                    MOCK_VIEWING_PUBLIC_KEY,
                );
            });

            it("resolve viewing key from keystoreInteractor when discoveryData has evmAddress", async () => {
                const recipientAddress = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
                const paramsWithEvmAddress: DepositForParams = {
                    tokenId: VALID_TOKEN,
                    value: VALID_VALUE,
                    discoveryData: {
                        evmAddress: recipientAddress,
                        noteSecret: MOCK_SECRET as unknown as Hex,
                    },
                };

                await service.prepareDepositFor(paramsWithEvmAddress);

                expect(config.keystoreInteractor.getViewingKey).toHaveBeenCalledWith(
                    recipientAddress,
                );
                expect(config.noteComputationService.generateNoteData).toHaveBeenCalledWith(
                    expect.objectContaining({
                        noteSecret: MOCK_SECRET,
                        value: VALID_VALUE,
                        tokenId: VALID_TOKEN,
                        label: MOCK_LABEL,
                    }),
                    MOCK_VIEWING_PUBLIC_KEY,
                );
            });

            it("throw DepositRecipientViewingKeyUnregistered when evmAddress has no registered viewing key", async () => {
                config.keystoreInteractor.getViewingKey = vi.fn(async () => ZERO_VIEWING_KEY);
                const paramsWithEvmAddress: DepositForParams = {
                    tokenId: VALID_TOKEN,
                    value: VALID_VALUE,
                    discoveryData: { evmAddress: RECIPIENT_ADDRESS },
                };

                await expect(service.prepareDepositFor(paramsWithEvmAddress)).rejects.toThrow(
                    DepositRecipientViewingKeyUnregistered,
                );
            });

            it("fall back to outOfBand and surface noteSecret when caller opts in", async () => {
                config.keystoreInteractor.getViewingKey = vi.fn(async () => ZERO_VIEWING_KEY);
                const paramsWithEvmAddress: DepositForParams = {
                    tokenId: VALID_TOKEN,
                    value: VALID_VALUE,
                    discoveryData: {
                        evmAddress: RECIPIENT_ADDRESS,
                        noteSecret: MOCK_SECRET as unknown as Hex,
                        allowOutOfBandFallback: true,
                    },
                };

                const result = await service.prepareDepositFor(paramsWithEvmAddress);

                expect(result.noteSecret).toBe(MOCK_SECRET);
                expect(result.pendingNote.noteAddressHash).toBe(MOCK_COMMITMENT);
                expect(result.pendingNote.ownerAddress).toBe(RECIPIENT_ADDRESS);
                expect(config.noteComputationService.generateNoteData).not.toHaveBeenCalled();
                expect(config.witnessPreparationService.buildDepositWitness).toHaveBeenCalledWith(
                    expect.objectContaining({ context: COMPUTED_CONTEXT }),
                );
            });

            it("omit noteSecret when the recipient is discoverable", async () => {
                const paramsWithEvmAddress: DepositForParams = {
                    tokenId: VALID_TOKEN,
                    value: VALID_VALUE,
                    discoveryData: {
                        evmAddress: RECIPIENT_ADDRESS,
                        noteSecret: MOCK_SECRET as unknown as Hex,
                    },
                };

                const result = await service.prepareDepositFor(paramsWithEvmAddress);

                expect(result.noteSecret).toBeUndefined();
            });

            it("omit noteSecret for the blind noteAddressHash path", async () => {
                const result = await service.prepareDepositFor(validForParams);

                expect(result.noteSecret).toBeUndefined();
            });

            it("produce different context when discoveryData generates real noteData", async () => {
                const paramsWithViewingKey: DepositForParams = {
                    tokenId: VALID_TOKEN,
                    value: VALID_VALUE,
                    discoveryData: {
                        publicViewingKey: MOCK_VIEWING_PUBLIC_KEY as unknown as Hex,
                        noteAddressHash: MOCK_NOTE_ADDRESS_HASH,
                        noteSecret: MOCK_SECRET as unknown as Hex,
                    },
                };

                await service.prepareDepositFor(paramsWithViewingKey);

                // When discoveryData is provided, generateNoteData returns non-empty data,
                // so the context hash differs from COMPUTED_CONTEXT (which uses EMPTY_NOTE_DATA)
                const witnessCall = (
                    config.witnessPreparationService.buildDepositWitness as ReturnType<typeof vi.fn>
                ).mock.calls[0][0] as Record<string, unknown>;
                expect(witnessCall.context).not.toBe(COMPUTED_CONTEXT);
            });
        });
    });

    describe("depositFor", () => {
        it("reject allowOutOfBandFallback with InvalidDepositParams before touching the keystore", async () => {
            config.keystoreInteractor.getViewingKey = vi.fn(async () => ZERO_VIEWING_KEY);

            await expect(
                service.depositFor({
                    tokenId: VALID_TOKEN,
                    value: VALID_VALUE,
                    discoveryData: {
                        evmAddress: RECIPIENT_ADDRESS,
                        allowOutOfBandFallback: true,
                    },
                }),
            ).rejects.toThrow(InvalidDepositParams);
            expect(config.keystoreInteractor.getViewingKey).not.toHaveBeenCalled();
        });
    });

    describe("executeDeposit", () => {
        const validParams: DepositParams = {
            tokenId: VALID_TOKEN,
            value: VALID_VALUE,
        };

        it("call noteManager.addNote after successful transaction", async () => {
            const prepareResult = await service.prepareDeposit(validParams);
            await service.executeDeposit(prepareResult);

            expect(config.noteManager.addNote).toHaveBeenCalledOnce();
            expect(config.noteManager.addNote).toHaveBeenCalledWith(
                expect.objectContaining({
                    ownerAddress: VALID_OWNER,
                    noteSecret: MOCK_SECRET,
                    isOwned: true,
                    status: NoteStatus.PENDING,
                    createdAtBlock: MOCK_TIMESTAMP,
                    txHash: "0x1",
                    spentAtBlock: null,
                }),
            );
        });

        it("skip noteManager.addNote when commitment timestamp cannot be resolved", async () => {
            (
                config.poolVaultInteractor.getCommitmentTimestamp as ReturnType<typeof vi.fn>
            ).mockResolvedValue("0x0" as Hash);
            const prepareResult = await service.prepareDeposit(validParams);
            const receipt = await service.executeDeposit(prepareResult);

            expect(config.noteManager.addNote).not.toHaveBeenCalled();
            expect(receipt.status).toBe(true);
        });

        it("not call noteManager.addNote for deposit-for (no pendingNote)", async () => {
            const prepareResult = await service.prepareDepositFor({
                tokenId: VALID_TOKEN,
                value: VALID_VALUE,
                noteAddressHash:
                    "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex,
            });
            await service.executeDeposit(prepareResult);

            expect(config.noteManager.addNote).not.toHaveBeenCalled();
        });

        it("reject a deposit tx whose target is not the entrypoint", async () => {
            const prepareResult = await service.prepareDeposit(validParams);
            const tampered = {
                ...prepareResult,
                depositTx: { ...prepareResult.depositTx, to: VALID_TOKEN },
            };

            await expect(service.executeDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(config.entrypointInteractor.submitTransaction).not.toHaveBeenCalled();
        });

        it("reject a tampered deposit tx before submitting any ERC-20 approval", async () => {
            // Validate everything, then sign anything: a genuine approval must never be mined
            // ahead of a deposit transaction that is then refused.
            const erc20Config = createDefaultConfig();
            erc20Config.entrypointInteractor = createMockEntrypointInteractor(
                undefined,
                async () => ZERO_ALLOWANCE,
            );
            const erc20Service = new PoolSessionDeposit(erc20Config);
            const prepareResult = await erc20Service.prepareDeposit(validParams);
            expect(prepareResult.approvalTx).not.toBeNull();
            const tampered = {
                ...prepareResult,
                depositTx: { ...prepareResult.depositTx, to: VALID_TOKEN },
            };

            await expect(erc20Service.executeDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(erc20Config.entrypointInteractor.submitTransaction).not.toHaveBeenCalled();
        });

        it("reject an approval tx whose spender is not the entrypoint", async () => {
            const erc20Config = createDefaultConfig();
            erc20Config.entrypointInteractor = createMockEntrypointInteractor(
                undefined,
                async () => ZERO_ALLOWANCE,
            );
            const erc20Service = new PoolSessionDeposit(erc20Config);
            const prepareResult = await erc20Service.prepareDeposit(validParams);
            expect(prepareResult.approvalTx).not.toBeNull();

            const attacker = "0x9999999999999999999999999999999999999999" as Address;
            const tampered = {
                ...prepareResult,
                approvalTx: {
                    ...prepareResult.approvalTx!,
                    data: encodeFunctionData({
                        abi: ERC20_APPROVE_ABI,
                        functionName: "approve",
                        args: [attacker, 1000n],
                    }),
                },
            };

            await expect(erc20Service.executeDeposit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(erc20Config.entrypointInteractor.submitTransaction).not.toHaveBeenCalled();
        });
    });
});
