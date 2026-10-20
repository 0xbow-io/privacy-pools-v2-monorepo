import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    IASPClient,
    IASPDataProvider,
    ICacheStore,
    ICircuitArtifacts,
    IKeystoreManager,
    INoteManager,
    INoteStorageAdapter,
    IRelayerInteractor,
    IStorageService,
    LabelStatus,
    PoolSessionBuilderConfig,
    PoolSessionSimpleConfig,
    ProtocolKeys,
    PublicKey,
    RelayerInfo,
    Secret,
} from "../../../src/internal.js";
import {
    DEPLOYMENTS,
    InvalidBuilderConfig,
    PoolSessionBuilder,
    PoseidonHashService,
    UnsupportedChainId,
    ViemRPCInteractor,
} from "../../../src/internal.js";
import { cidFor } from "../helpers/ipfsContent.js";

// Valid CIDs for tests that build IpfsCircuitArtifacts. The constructor
// now parses every non-empty CID, so placeholder strings ("Qm1") no longer
// satisfy the manifest contract.
const DEPOSIT_WASM_CID = cidFor(new Uint8Array([0xa1]));
const DEPOSIT_PKEY_CID = cidFor(new Uint8Array([0xa2]));
const DEPOSIT_VKEY_CID = cidFor(new Uint8Array([0xa3]));

const SEPOLIA_CHAIN_ID = 11155111;
const TEST_DEPLOYMENT = {
    poolAddress: "0x1111111111111111111111111111111111111111" as Address,
    entrypointAddress: "0x2222222222222222222222222222222222222222" as Address,
    keystoreAddress: "0x3333333333333333333333333333333333333333" as Address,
    aspRegistryAddress: "0x4444444444444444444444444444444444444444" as Address,
    relaySwapsAddress: "0x5555555555555555555555555555555555555555" as Address,
};

function randomSecret(): Secret {
    return ("0x" + bytesToHex(randomBytes(32))) as Secret;
}

function derivePublicKey(privateKey: Secret): PublicKey {
    const bytes = hexToBytes(privateKey.slice(2));
    const pubBytes = x25519.getPublicKey(bytes);
    return ("0x" + bytesToHex(pubBytes)) as PublicKey;
}

function validKeys(): ProtocolKeys {
    const viewingPrivateKey = randomSecret();
    return {
        privateNullifyingKey: randomSecret(),
        privateRevocableKey: randomSecret(),
        viewingPrivateKey,
        viewingPublicKey: derivePublicKey(viewingPrivateKey),
        revocableKeyIndex: "0x0" as Hex,
    };
}

const OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const RELAYER: RelayerInfo = {
    name: "Test Relayer",
    url: "https://relayer.example.com",
    address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address,
    processorAddress: "0xffffffffffffffffffffffffffffffffffffffff" as Address,
    chainId: SEPOLIA_CHAIN_ID,
    chainType: "evm",
    status: "active",
};

function minimalConfig(overrides: Partial<PoolSessionSimpleConfig> = {}): PoolSessionSimpleConfig {
    return {
        chainId: SEPOLIA_CHAIN_ID,
        deployment: TEST_DEPLOYMENT,
        rpcUrl: "https://sepolia.example.com",
        ownerAddress: OWNER,
        protocolKeys: validKeys(),
        aspUrl: "https://asp.example.com",
        relayers: [RELAYER],
        circuitArtifactsDir: "/tmp/circuits",
        ...overrides,
    } as PoolSessionSimpleConfig;
}

function minimalBuilderConfig(
    overrides: Partial<PoolSessionBuilderConfig> = {},
): PoolSessionBuilderConfig {
    return {
        chainId: SEPOLIA_CHAIN_ID,
        deployment: TEST_DEPLOYMENT,
        rpcUrl: "https://sepolia.example.com",
        ownerAddress: OWNER,
        protocolKeys: validKeys(),
        aspUrl: "https://asp.example.com",
        relayers: [RELAYER],
        circuitArtifactsDir: "/tmp/circuits",
        ...overrides,
    };
}

const STUB_ASP_PROVIDER: IASPDataProvider = {
    getRoot: async () => "0x0" as Hash,
    getLeaves: async () => [],
    getLabelStatus: async () => ({ status: "approved" }) as LabelStatus,
    getASPPublicKey: async () => "0x0" as PublicKey,
    getEventSnapshot: async () => ({
        chainId: "0x1",
        snapshotBlockNumber: "0x0",
        generatedAt: new Date().toISOString(),
        deposits: [],
        transacts: [],
        ragequits: [],
        leaves: [],
        keystoreLeaves: [],
    }),
    getNoteEvents: async () => ({ events: [], lastSyncedBlock: "0x0" as Hex }),
};

describe("PoolSessionBuilder", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe("static create", () => {
        it("build PoolSession from minimal config", async () => {
            const session = await PoolSessionBuilder.create(minimalConfig());

            expect(session).toBeDefined();
            expect(session.prepareDeposit).toBeTypeOf("function");
            expect(session.prepareTransfer).toBeTypeOf("function");
            expect(session.prepareRageQuit).toBeTypeOf("function");
            expect(session.discoverNotes).toBeTypeOf("function");
            expect(session.exportAccount).toBeTypeOf("function");
        });

        it("build PoolSession using IPFS ASP when ipfsGatewayUrl is provided", async () => {
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionSimpleConfig>).aspUrl;
            const session = await PoolSessionBuilder.create({
                ...cfg,
                ipfsGatewayUrl: "https://ipfs.example.com",
            } as PoolSessionSimpleConfig);
            expect(session).toBeDefined();
        });
    });

    describe("fromConfig + withX", () => {
        it("apply KeystoreManager override in place of protocolKeys", async () => {
            const km: IKeystoreManager = {
                getPrivateNullifyingKey: () => "0x0" as Secret,
                getPrivateRevocableKey: () => "0x0" as Secret,
                getViewingKeyPair: () => ({
                    privateKey: "0x0" as Secret,
                    publicKey: "0x0" as Secret,
                }),
                applyRotation: () => { /* no-op */ },
                getRevocableKeyIndex: () => "0x0" as Hex,
                isRegistered: () => false,
                markRegistered: () => { /* no-op */ },
            };

            const cfg = minimalBuilderConfig();
            delete cfg.protocolKeys;

            const session = await PoolSessionBuilder.fromConfig(cfg)
                .withKeystoreManager(km)
                .create();
            expect(session).toBeDefined();
        });

        it("apply RelayerInteractor override in place of relayers", async () => {
            const ri: IRelayerInteractor = {
                getRelayers: async () => [],
                getChainDetails: vi.fn() as never,
                getTransferQuote: async () => ({
                    txCost: "0",
                    gasPrice: "0",
                    feeAmount: "0",
                    feeCommitment: {} as never,
                }),
                getWithdrawalQuote: async () => ({
                    txCost: "0",
                    gasPrice: "0",
                    feeAmount: "0",
                    amountSent: "0",
                    amountReceived: "0",
                    feeCommitment: {} as never,
                }),
                getBatchWithdrawalQuote: async () => ({
                    txCost: "0",
                    gasPrice: "0",
                    totalFee: "0",
                    maxRelayFee: "0",
                    feeCommitment: {} as never,
                }),
                relayTransfer: async () => "0x0",
                relayWithdrawal: async () => "0x0",
                relayBatchWithdrawal: async () => "0x0",
                submitRelayedRegistration: async () => "0x0",
                relayRegisterAndWithdrawal: async () => "0x0",
                relayWithAnnounce: async () => "0x0",
                getSwapQuote: async () => ({
                    txCost: "0",
                    gasPrice: "0",
                    feeAmount: "0",
                    feeCommitment: {} as never,
                }),
                relaySwap: async () => "0x0",
            };

            const cfg = minimalBuilderConfig();
            delete cfg.relayers;

            const session = await PoolSessionBuilder.fromConfig(cfg)
                .withRelayerInteractor(ri)
                .create();
            expect(session).toBeDefined();
        });

        it("apply AspClient override", async () => {
            const client: IASPClient = {
                getAssociationSetRoot: async () => "0x0" as Hash,
                getAssociationSetLeaves: async () => [],
                getMerkleProof: async () => ({
                    leaf: "0x0",
                    root: "0x0",
                    siblings: [],
                    index: 0,
                }),
                getLabelStatus: async () => ({ status: "approved" }),
                getASPPublicKey: async () => "0x0" as PublicKey,
            };

            const cfg = minimalBuilderConfig();
            delete cfg.aspUrl;

            const session = await PoolSessionBuilder.fromConfig(cfg)
                .withAspClient(client)
                .withAspDataProvider(STUB_ASP_PROVIDER)
                .create();
            expect(session).toBeDefined();
        });

        it("chain multiple leaf-service withX overrides and return this", () => {
            const builder = PoolSessionBuilder.fromConfig(minimalBuilderConfig());
            const chained = builder
                .withCryptoService({} as never)
                .withHashService({} as never)
                .withNoteManager({} as INoteManager);
            expect(chained).toBe(builder);
        });

        it("not expose protocolKeys when a retained builder is serialized or enumerated", () => {
            // The builder holds config (with the private keys) so a caller that keeps the
            // builder around could otherwise leak them via a log/crash-report (audit #101). The
            // #private fields must be invisible to JSON.stringify / Object.keys / spread.
            const cfg = minimalConfig();
            const nullifyingKey = cfg.protocolKeys!.privateNullifyingKey.slice(2);
            const builder = PoolSessionBuilder.fromConfig(cfg);

            expect(Object.keys(builder)).toHaveLength(0);
            expect(JSON.stringify(builder)).not.toContain(nullifyingKey);
            expect(JSON.stringify({ ...builder })).not.toContain(nullifyingKey);
        });

        it("is single-use: a second create() throws after the config is dropped", async () => {
            // create() drops its reference to the caller config (incl. protocolKeys) on success,
            // so the builder can't be reused (audit #101 review).
            const builder = PoolSessionBuilder.fromConfig(minimalConfig());

            await expect(builder.create()).resolves.toBeDefined();
            await expect(builder.create()).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });
    });

    describe("leaf cache seeding", () => {
        it("keystoreLeafCacheSeed/stateLeafCacheSeed pre-populate the session's leaf caches", async () => {
            const keystoreSeed = {
                toBlock: 123n,
                leaves: ["0x" + "1".repeat(64)] as Hash[],
            };
            const stateSeed = {
                toBlock: 456n,
                leaves: ["0x" + "2".repeat(64)] as Hash[],
            };

            const session = await PoolSessionBuilder.create(
                minimalConfig({
                    keystoreLeafCacheSeed: keystoreSeed,
                    stateLeafCacheSeed: stateSeed,
                }),
            );

            // The background warm-up fired by the builder targets a fake RPC URL and
            // fails silently (fire-and-forget), so the seeded cache is untouched —
            // exporting it back out should return exactly what was seeded in.
            expect(session.exportKeystoreLeafCache()).toEqual(keystoreSeed);
            expect(session.exportStateLeafCache()).toEqual(stateSeed);
        });

        it("exportKeystoreLeafCache/exportStateLeafCache return undefined when unseeded and unfetched", async () => {
            const session = await PoolSessionBuilder.create(minimalConfig());

            expect(session.exportKeystoreLeafCache()).toBeUndefined();
            expect(session.exportStateLeafCache()).toBeUndefined();
        });
    });

    describe("validation", () => {
        it("resolve deployment from DEPLOYMENTS when omitted for a known chainId", async () => {
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionSimpleConfig>).deployment;

            const session = await PoolSessionBuilder.create(cfg);
            expect(session).toBeDefined();
        });

        it("throw UnsupportedChainId when deployment omitted for an unknown chainId", async () => {
            const cfg = minimalConfig({
                chainId: 424242,
                relayers: [{ ...RELAYER, chainId: 424242 }],
            });
            delete (cfg as Partial<PoolSessionSimpleConfig>).deployment;

            await expect(PoolSessionBuilder.create(cfg)).rejects.toBeInstanceOf(UnsupportedChainId);
        });

        it("expose canonical Sepolia deployment in DEPLOYMENTS", () => {
            expect(DEPLOYMENTS[SEPOLIA_CHAIN_ID]).toBeDefined();
        });

        it("throw InvalidBuilderConfig when rpcUrl is malformed", async () => {
            await expect(
                PoolSessionBuilder.create(minimalConfig({ rpcUrl: "not-a-url" })),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("throw InvalidBuilderConfig when relayers is empty", async () => {
            await expect(
                PoolSessionBuilder.create(minimalConfig({ relayers: [] })),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("throw InvalidBuilderConfig when sourceChain.chainId equals the pool chainId", async () => {
            await expect(
                PoolSessionBuilder.create(
                    minimalConfig({
                        sourceChain: {
                            chainId: SEPOLIA_CHAIN_ID,
                            rpcUrl: "https://source.example.com",
                            walletInteractor: {
                                type: "viem",
                                walletClient: {} as never,
                            },
                            relaySwapsAddress: OWNER,
                        },
                    } as never),
                ),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("throw InvalidBuilderConfig when protocolKeys missing and no KeystoreManager override", async () => {
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionSimpleConfig>).protocolKeys;

            await expect(PoolSessionBuilder.create(cfg)).rejects.toBeInstanceOf(
                InvalidBuilderConfig,
            );
        });

        it("throw InvalidBuilderConfig when walletInteractor config is malformed", async () => {
            // A declarative wallet config with a missing client must fail at construction, not at
            // first write (audit #68).
            const cfg = minimalConfig({
                walletInteractor: { type: "viem" } as never,
            });

            await expect(PoolSessionBuilder.create(cfg)).rejects.toBeInstanceOf(
                InvalidBuilderConfig,
            );
        });

        it("throw InvalidBuilderConfig when walletInteractor type is unknown", async () => {
            // buildWalletInteractor's switch has no default: an unrecognized `type` would
            // silently build a session without a wallet. The schema must catch it instead.
            const cfg = minimalConfig({
                walletInteractor: { type: "Viem", walletClient: {} } as never,
            });

            await expect(PoolSessionBuilder.create(cfg)).rejects.toBeInstanceOf(
                InvalidBuilderConfig,
            );
        });

        it("throw InvalidBuilderConfig when persistentStorage filename could escape the directory", async () => {
            // Same rule as the FileStorageService constructor, surfaced as InvalidBuilderConfig
            // like every other bad builder field.
            const cfg = minimalConfig({
                persistentStorage: { type: "file", dirPath: "/tmp", filename: "../escape" },
            });

            await expect(PoolSessionBuilder.create(cfg)).rejects.toBeInstanceOf(
                InvalidBuilderConfig,
            );
        });

        it("throw InvalidBuilderConfig when circuitManifest is omitted on the IPFS path", async () => {
            // Audit M-11: no silent fallback to DEFAULT_CIRCUIT_MANIFEST.
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionSimpleConfig>).circuitArtifactsDir;

            await expect(PoolSessionBuilder.create(cfg)).rejects.toThrow(
                /circuitManifest must be supplied explicitly/,
            );
        });

        it("throw InvalidBuilderConfig when manifest CIDs are malformed, not just empty", async () => {
            // A non-empty but unparseable CID must not count as "pinned" — otherwise it slips
            // through to a runtime `<gateway>/<garbage>` fetch instead of failing at construction.
            // The error names the offending field (circuitManifest.deposit.wasm) via the Zod path.
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionSimpleConfig>).circuitArtifactsDir;
            (cfg as PoolSessionBuilderConfig).circuitManifest = {
                deposit: { wasm: "not-a-cid", provingKey: "", verificationKey: "" },
            };

            await expect(PoolSessionBuilder.create(cfg)).rejects.toBeInstanceOf(
                InvalidBuilderConfig,
            );
            await expect(PoolSessionBuilder.create(cfg)).rejects.toThrow(
                "circuitManifest.deposit.wasm",
            );
        });

        it("default to IPFS circuit path when manifest has at least one pinned CID", async () => {
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionSimpleConfig>).circuitArtifactsDir;
            (cfg as PoolSessionBuilderConfig).circuitManifest = {
                deposit: {
                    wasm: DEPOSIT_WASM_CID,
                    provingKey: DEPOSIT_PKEY_CID,
                    verificationKey: DEPOSIT_VKEY_CID,
                },
            };

            const session = await PoolSessionBuilder.create(cfg);
            expect(session).toBeDefined();
        });

        it("throw InvalidBuilderConfig when aspUrl and ipfsGatewayUrl both missing and no AspDataProvider override", async () => {
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionSimpleConfig>).aspUrl;

            await expect(PoolSessionBuilder.create(cfg)).rejects.toBeInstanceOf(
                InvalidBuilderConfig,
            );
        });
    });

    describe("cross-dependency validation (runtime belt + suspenders)", () => {
        // These conflicts are rejected at compile time by the `.withX()`
        // `this`-parameter constraints. The `as never` casts below bypass TS
        // to verify runtime guards catch the same cases for JS consumers /
        // dynamically-shaped configs.

        it("reject relayers whose chainId diverges from session chainId", async () => {
            const cfg = minimalConfig({
                relayers: [{ ...RELAYER, chainId: 1 }],
            });

            await expect(PoolSessionBuilder.create(cfg)).rejects.toBeInstanceOf(
                InvalidBuilderConfig,
            );
        });

        it("reject conflicting protocolKeys + KeystoreManager override", async () => {
            const km = {} as IKeystoreManager;
            const builder = PoolSessionBuilder.fromConfig(minimalBuilderConfig());

            await expect(builder.withKeystoreManager(km).create()).rejects.toBeInstanceOf(
                InvalidBuilderConfig,
            );
        });

        it("reject conflicting relayers + RelayerInteractor override", async () => {
            const ri = {} as IRelayerInteractor;
            const builder = PoolSessionBuilder.fromConfig(minimalBuilderConfig());

            await expect(builder.withRelayerInteractor(ri).create()).rejects.toBeInstanceOf(
                InvalidBuilderConfig,
            );
        });

        it("reject conflicting circuitArtifactsDir + CircuitArtifacts override", async () => {
            const stubArtifacts = {
                load: async () => ({ wasm: new Uint8Array(), zkey: new Uint8Array() }),
            } as never;
            const builder = PoolSessionBuilder.fromConfig(minimalBuilderConfig());

            await expect(
                builder.withCircuitArtifacts(stubArtifacts).create(),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("reject conflicting aspUrl + AspDataProvider override", async () => {
            const builder = PoolSessionBuilder.fromConfig(minimalBuilderConfig());

            await expect(
                builder.withAspDataProvider(STUB_ASP_PROVIDER).create(),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("reject conflicting deployment + interactor override", async () => {
            const stubEntrypoint = {} as never;
            const builder = PoolSessionBuilder.fromConfig(minimalBuilderConfig());

            await expect(
                builder.withEntrypointInteractor(stubEntrypoint).create(),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("reject conflicting persistentStorage + StorageService override", async () => {
            const stubStorage = {} as IStorageService;
            const builder = PoolSessionBuilder.fromConfig(
                minimalBuilderConfig({ persistentStorage: { type: "memory" } }),
            );

            await expect(
                (builder.withStorageService as never as (s: IStorageService) => typeof builder)(
                    stubStorage,
                ).create(),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("reject conflicting persistentStorage + NoteStorageAdapter override", async () => {
            const stubAdapter = {} as INoteStorageAdapter;
            const builder = PoolSessionBuilder.fromConfig(
                minimalBuilderConfig({ persistentStorage: { type: "memory" } }),
            );

            await expect(
                (
                    builder.withNoteStorageAdapter as never as (
                        a: INoteStorageAdapter,
                    ) => typeof builder
                )(stubAdapter).create(),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("reject conflicting StorageService + NoteStorageAdapter overrides", async () => {
            const stubStorage = {} as IStorageService;
            const stubAdapter = {} as INoteStorageAdapter;
            const builder = PoolSessionBuilder.fromConfig(minimalBuilderConfig());

            await expect(
                builder
                    .withStorageService(stubStorage)
                    .withNoteStorageAdapter(stubAdapter)
                    .create(),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });
    });

    describe("persistentStorage", () => {
        it("build PoolSession with in-memory persistentStorage", async () => {
            const session = await PoolSessionBuilder.create(
                minimalConfig({ persistentStorage: { type: "memory" } }),
            );
            expect(session).toBeDefined();
        });

        it("reject persistentStorage with unknown type via schema", async () => {
            await expect(
                PoolSessionBuilder.create(
                    minimalConfig({
                        persistentStorage: { type: "bogus" } as never,
                    }),
                ),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("reject file persistentStorage without dirPath", async () => {
            await expect(
                PoolSessionBuilder.create(
                    minimalConfig({
                        persistentStorage: { type: "file", dirPath: "" } as never,
                    }),
                ),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });
    });

    describe("IPFS circuit artifacts", () => {
        it("build PoolSession with circuitGatewayUrls instead of circuitArtifactsDir", async () => {
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionBuilderConfig>).circuitArtifactsDir;
            cfg.circuitGatewayUrls = ["https://ipfs.example.com/ipfs"];
            cfg.circuitManifest = {
                deposit: {
                    wasm: DEPOSIT_WASM_CID,
                    provingKey: DEPOSIT_PKEY_CID,
                    verificationKey: DEPOSIT_VKEY_CID,
                },
            };

            const session = await PoolSessionBuilder.create(cfg as never);
            expect(session).toBeDefined();
        });

        it("accept circuitManifest alongside circuitGatewayUrls", async () => {
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionBuilderConfig>).circuitArtifactsDir;
            cfg.circuitGatewayUrls = ["https://ipfs.example.com/ipfs"];
            cfg.circuitManifest = {
                deposit: {
                    wasm: DEPOSIT_WASM_CID,
                    provingKey: DEPOSIT_PKEY_CID,
                    verificationKey: DEPOSIT_VKEY_CID,
                },
            };

            const session = await PoolSessionBuilder.create(cfg as never);
            expect(session).toBeDefined();
        });

        it("reject conflicting circuitArtifactsDir + circuitGatewayUrls via schema", async () => {
            await expect(
                PoolSessionBuilder.create(
                    minimalConfig({
                        circuitGatewayUrls: ["https://ipfs.example.com/ipfs"],
                    }) as never,
                ),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("reject conflicting circuitGatewayUrls + CircuitArtifacts override", async () => {
            const stubArtifacts: ICircuitArtifacts = {
                getWasm: async (): Promise<Uint8Array> => new Uint8Array(),
                getProvingKey: async (): Promise<Uint8Array> => new Uint8Array(),
                getVerificationKey: async (): Promise<Uint8Array> => new Uint8Array(),
            };
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionBuilderConfig>).circuitArtifactsDir;
            cfg.circuitGatewayUrls = ["https://ipfs.example.com/ipfs"];

            const builder = PoolSessionBuilder.fromConfig(cfg);
            await expect(
                (builder.withCircuitArtifacts as never as (a: ICircuitArtifacts) => typeof builder)(
                    stubArtifacts,
                ).create(),
            ).rejects.toBeInstanceOf(InvalidBuilderConfig);
        });

        it("reject withCircuitCacheStore on local circuit path", async () => {
            const stubStore: ICacheStore = {
                get: async (): Promise<Uint8Array | null> => null,
                set: async (): Promise<void> => undefined,
            };
            const builder = PoolSessionBuilder.fromConfig(minimalConfig());
            await expect(builder.withCircuitCacheStore(stubStore).create()).rejects.toBeInstanceOf(
                InvalidBuilderConfig,
            );
        });

        it("accept withCircuitCacheStore alongside circuitGatewayUrls", async () => {
            const stubStore: ICacheStore = {
                get: async (): Promise<Uint8Array | null> => null,
                set: async (): Promise<void> => undefined,
            };
            const cfg = minimalConfig();
            delete (cfg as Partial<PoolSessionBuilderConfig>).circuitArtifactsDir;
            cfg.circuitGatewayUrls = ["https://ipfs.example.com/ipfs"];
            cfg.circuitManifest = {
                deposit: {
                    wasm: DEPOSIT_WASM_CID,
                    provingKey: DEPOSIT_PKEY_CID,
                    verificationKey: DEPOSIT_VKEY_CID,
                },
            };

            const session = await PoolSessionBuilder.fromConfig(cfg)
                .withCircuitCacheStore(stubStore)
                .create();
            expect(session).toBeDefined();
        });
    });

    describe("singleton sharing", () => {
        it("construct a single ViemRPCInteractor for all contract interactors", async () => {
            const createSpy = vi.spyOn(ViemRPCInteractor, "create");
            await PoolSessionBuilder.create(minimalConfig());
            expect(createSpy).toHaveBeenCalledTimes(1);
        });

        it("construct a single PoseidonHashService shared across dependents", async () => {
            const createSpy = vi.spyOn(PoseidonHashService, "create");
            await PoolSessionBuilder.create(minimalConfig());
            expect(createSpy).toHaveBeenCalledTimes(1);
        });

        it("skip PoseidonHashService.create when HashService override is supplied", async () => {
            const hs = await PoseidonHashService.create();
            const createSpy = vi.spyOn(PoseidonHashService, "create");

            await PoolSessionBuilder.fromConfig(minimalBuilderConfig())
                .withHashService(hs)
                .create();

            expect(createSpy).not.toHaveBeenCalled();
        });
    });
});
