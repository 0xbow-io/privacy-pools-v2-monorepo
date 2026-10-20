import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Hash,
    Hex,
    IASPDataProvider,
    IASPRegistryInteractor,
    IMerkleService,
    LabelStatus,
    MerkleProof,
    PublicKey,
} from "../../../src/internal.js";
import {
    ASPClient,
    ASPUnavailable,
    ASSOCIATION_SET_MAX_DEPTH,
    InvalidASPClientConfig,
    LabelNotInSet,
    LeafNotFound,
    MerkleService,
    PoseidonHashService,
} from "../../../src/internal.js";

const MOCK_ROOT = "0x0000000000000000000000000000000000000000000000000000000000abcdef" as Hash;
const MOCK_LEAVES = [
    "0x0000000000000000000000000000000000000000000000000000000000000001" as Hash,
    "0x0000000000000000000000000000000000000000000000000000000000000002" as Hash,
];
const MOCK_PUBLIC_KEY = "0x02abcdef" as PublicKey;
const MOCK_LABEL_STATUS: LabelStatus = { status: "approved", timestamp: 1000 };
const MOCK_PROOF: MerkleProof = {
    leaf: MOCK_LEAVES[0],
    root: MOCK_ROOT,
    siblings: [],
    index: 0,
};

function createMockProvider(overrides?: Partial<IASPDataProvider>): IASPDataProvider {
    return {
        getRoot: vi.fn(async () => MOCK_ROOT),
        getLeaves: vi.fn(async () => MOCK_LEAVES),
        getLabelStatus: vi.fn(async () => MOCK_LABEL_STATUS),
        getASPPublicKey: vi.fn(async () => MOCK_PUBLIC_KEY),
        getEventSnapshot: vi.fn(async () => ({
            chainId: "0x1" as Hex,
            snapshotBlockNumber: "0x0" as Hex,
            generatedAt: "1970-01-01T00:00:00.000Z",
            deposits: [],
            transacts: [],
            ragequits: [],
            leaves: [],
            keystoreLeaves: [],
        })),
        getNoteEvents: vi.fn(async () => ({ events: [], lastSyncedBlock: "0x0" as Hex })),
        ...overrides,
    };
}

function createMockMerkleService(overrides?: Partial<IMerkleService>): IMerkleService {
    return {
        generateMerkleProof: vi.fn(async () => MOCK_PROOF),
        padSiblings: vi.fn((siblings) => siblings),
        verifyMerkleProof: vi.fn(async () => true),
        // Default to returning the canonical MOCK_ROOT so leaves-vs-root
        // verification inside getAssociationSetLeaves passes for tests that
        // aren't specifically exercising the mismatch path.
        computeRoot: vi.fn(async () => MOCK_ROOT),
        ...overrides,
    };
}

function createMockASPRegistryInteractor(
    overrides?: Partial<IASPRegistryInteractor>,
): IASPRegistryInteractor {
    return {
        getLatestASPRoot: vi.fn(async () => MOCK_ROOT),
        getLatestAssociationSetData: vi.fn(async () => ({ root: MOCK_ROOT, ipfsCID: "" })),
        ...overrides,
    };
}

describe("ASPClient", () => {
    let provider1: IASPDataProvider;
    let provider2: IASPDataProvider;
    let merkleService: IMerkleService;
    let aspRegistryInteractor: IASPRegistryInteractor;

    beforeEach(() => {
        vi.clearAllMocks();
        provider1 = createMockProvider();
        provider2 = createMockProvider();
        merkleService = createMockMerkleService();
        aspRegistryInteractor = createMockASPRegistryInteractor();
    });

    describe("constructor", () => {
        it("create instance with valid config", () => {
            expect(
                () =>
                    new ASPClient({ providers: [provider1], merkleService, aspRegistryInteractor }),
            ).not.toThrow();
        });

        it("throw InvalidASPClientConfig for empty providers", () => {
            expect(
                () => new ASPClient({ providers: [], merkleService, aspRegistryInteractor }),
            ).toThrow(InvalidASPClientConfig);
        });
    });

    describe("getAssociationSetRoot", () => {
        it("return root from first provider", async () => {
            const client = new ASPClient({
                providers: [provider1, provider2],
                merkleService,
                aspRegistryInteractor,
            });
            const root = await client.getAssociationSetRoot();
            expect(root).toBe(MOCK_ROOT);
            expect(provider1.getRoot).toHaveBeenCalledOnce();
            expect(provider2.getRoot).not.toHaveBeenCalled();
        });

        it("fallback to second provider on first failure", async () => {
            provider1 = createMockProvider({
                getRoot: vi.fn(async () => {
                    throw new Error("provider 1 down");
                }),
            });
            const client = new ASPClient({
                providers: [provider1, provider2],
                merkleService,
                aspRegistryInteractor,
            });
            const root = await client.getAssociationSetRoot();
            expect(root).toBe(MOCK_ROOT);
            expect(provider2.getRoot).toHaveBeenCalledOnce();
        });

        it("throw ASPUnavailable when all providers fail", async () => {
            provider1 = createMockProvider({
                getRoot: vi.fn(async () => {
                    throw new Error("p1 down");
                }),
            });
            provider2 = createMockProvider({
                getRoot: vi.fn(async () => {
                    throw new Error("p2 down");
                }),
            });
            const client = new ASPClient({
                providers: [provider1, provider2],
                merkleService,
                aspRegistryInteractor,
            });
            await expect(client.getAssociationSetRoot()).rejects.toThrow(ASPUnavailable);
        });
    });

    describe("getAssociationSetLeaves", () => {
        it("return leaves from first provider", async () => {
            const client = new ASPClient({
                providers: [provider1, provider2],
                merkleService,
                aspRegistryInteractor,
            });
            const leaves = await client.getAssociationSetLeaves();
            expect(leaves).toEqual(MOCK_LEAVES);
            expect(provider1.getLeaves).toHaveBeenCalledOnce();
            expect(provider2.getLeaves).not.toHaveBeenCalled();
        });

        it("fallback to second provider on first failure", async () => {
            provider1 = createMockProvider({
                getLeaves: vi.fn(async () => {
                    throw new Error("p1 down");
                }),
            });
            const client = new ASPClient({
                providers: [provider1, provider2],
                merkleService,
                aspRegistryInteractor,
            });
            const leaves = await client.getAssociationSetLeaves();
            expect(leaves).toEqual(MOCK_LEAVES);
        });

        it("throw ASPUnavailable when all providers fail", async () => {
            provider1 = createMockProvider({
                getLeaves: vi.fn(async () => {
                    throw new Error("p1 down");
                }),
            });
            provider2 = createMockProvider({
                getLeaves: vi.fn(async () => {
                    throw new Error("p2 down");
                }),
            });
            const client = new ASPClient({
                providers: [provider1, provider2],
                merkleService,
                aspRegistryInteractor,
            });
            await expect(client.getAssociationSetLeaves()).rejects.toThrow(ASPUnavailable);
        });

        it("reject an oversized leaves set before building the tree", async () => {
            // A provider returning more leaves than the association-set tree can hold is hostile or
            // broken. The guard must reject on count before computeRoot, so the O(n) LeanIMT build
            // never runs on the oversized array.
            const oversized = new Array(2 ** ASSOCIATION_SET_MAX_DEPTH + 1).fill(
                MOCK_LEAVES[0],
            ) as Hash[];
            provider1 = createMockProvider({
                getLeaves: vi.fn(async () => oversized),
            });
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });
            await expect(client.getAssociationSetLeaves()).rejects.toThrow(ASPUnavailable);
            expect(merkleService.computeRoot).not.toHaveBeenCalled();
        });

        it("verify leaves against the on-chain root via merkleService.computeRoot", async () => {
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });
            await client.getAssociationSetLeaves();
            expect(merkleService.computeRoot).toHaveBeenCalledWith(MOCK_LEAVES);
            expect(aspRegistryInteractor.getLatestASPRoot).toHaveBeenCalled();
        });

        it("fall through to next provider when first provider's leaves do not match the on-chain root", async () => {
            const tamperedLeaves = [
                "0x0000000000000000000000000000000000000000000000000000000000000099" as Hash,
            ];
            provider1 = createMockProvider({
                getLeaves: vi.fn(async () => tamperedLeaves),
            });
            // computeRoot returns the wrong root for tampered leaves, the
            // expected root for canonical leaves.
            merkleService = createMockMerkleService({
                computeRoot: vi.fn(async (leaves: Hex[]) =>
                    leaves === tamperedLeaves ? ("0xdeadbeef" as Hash) : MOCK_ROOT,
                ),
            });
            const client = new ASPClient({
                providers: [provider1, provider2],
                merkleService,
                aspRegistryInteractor,
            });
            const leaves = await client.getAssociationSetLeaves();
            expect(leaves).toEqual(MOCK_LEAVES);
            expect(provider1.getLeaves).toHaveBeenCalledOnce();
            expect(provider2.getLeaves).toHaveBeenCalledOnce();
        });

        // TEST-7 (no mock-only). Every case above stubs `merkleService.computeRoot`, so the mock
        // DECIDES whether the leaves match — the real reconstruction never runs. That matters more
        // here than usual: root-verification IS the #540 fix. Rejection corroboration was moved off
        // the raw `getLeaves()` endpoint onto this method precisely so the second read is anchored
        // on something the ASP does not serve, and a mocked `computeRoot` re-serves the ASP's own
        // answer. A wrong leaf ordering, a drifted hashing convention, or an off-by-one in the
        // LeanIMT build would satisfy every mocked test in this file.
        //
        // The LeanIMT-over-Poseidon primitive itself does have real coverage (the real-proof
        // integration suites compute roots the circuits and contracts then accept). What had none
        // was this assembly: leaves -> real root -> compare against the on-chain root.
        describe("root verification with real Poseidon + LeanIMT (no mocks)", () => {
            const REAL_LEAVES = [
                "0x0000000000000000000000000000000000000000000000000000000000000001" as Hash,
                "0x0000000000000000000000000000000000000000000000000000000000000002" as Hash,
                "0x0000000000000000000000000000000000000000000000000000000000000003" as Hash,
            ];
            let realMerkleService: MerkleService;
            let realRoot: Hash;

            beforeEach(async () => {
                const hashService = await PoseidonHashService.create();
                realMerkleService = new MerkleService({ hashService });
                realRoot = (await realMerkleService.computeRoot(REAL_LEAVES)) as Hash;
            });

            it("accept leaves whose real reconstructed root matches the on-chain root", async () => {
                const client = new ASPClient({
                    providers: [createMockProvider({ getLeaves: vi.fn(async () => REAL_LEAVES) })],
                    merkleService: realMerkleService,
                    aspRegistryInteractor: createMockASPRegistryInteractor({
                        getLatestASPRoot: vi.fn(async () => realRoot),
                    }),
                });

                await expect(client.getAssociationSetLeaves()).resolves.toEqual(REAL_LEAVES);
            });

            // The adversarial shape #540 actually cares about: the ASP serves a leaf set that is
            // internally self-consistent but is NOT the set the chain is anchored to. Only a real
            // recomputation can tell the difference.
            it("reject a tampered leaf set that does not reconstruct to the on-chain root", async () => {
                const tampered = [...REAL_LEAVES.slice(0, 2), ("0x" + "99".repeat(32)) as Hash];
                const client = new ASPClient({
                    providers: [createMockProvider({ getLeaves: vi.fn(async () => tampered) })],
                    merkleService: realMerkleService,
                    aspRegistryInteractor: createMockASPRegistryInteractor({
                        getLatestASPRoot: vi.fn(async () => realRoot),
                    }),
                });

                await expect(client.getAssociationSetLeaves()).rejects.toThrow(ASPUnavailable);
            });

            // Ordering is load-bearing in a LeanIMT: the same multiset of leaves in a different
            // order is a different tree. A reconstruction that sorted or de-duplicated would pass
            // the two cases above and fail this one.
            it("reject the same leaves supplied in a different order", async () => {
                const reordered = [REAL_LEAVES[1], REAL_LEAVES[0], REAL_LEAVES[2]];
                const client = new ASPClient({
                    providers: [createMockProvider({ getLeaves: vi.fn(async () => reordered) })],
                    merkleService: realMerkleService,
                    aspRegistryInteractor: createMockASPRegistryInteractor({
                        getLatestASPRoot: vi.fn(async () => realRoot),
                    }),
                });

                await expect(client.getAssociationSetLeaves()).rejects.toThrow(ASPUnavailable);
            });
        });

        it("throw ASPUnavailable when every provider returns leaves that don't match the root", async () => {
            merkleService = createMockMerkleService({
                computeRoot: vi.fn(async () => "0xdeadbeef" as Hash),
            });
            const client = new ASPClient({
                providers: [provider1, provider2],
                merkleService,
                aspRegistryInteractor,
            });
            await expect(client.getAssociationSetLeaves()).rejects.toThrow(ASPUnavailable);
        });

        it("serve the cached on-chain root on back-to-back calls within the TTL", async () => {
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });
            await client.getAssociationSetLeaves();
            await client.getAssociationSetLeaves();
            expect(aspRegistryInteractor.getLatestASPRoot).toHaveBeenCalledTimes(1);
        });

        it("survive a stale cache by force-refreshing on-chain root when the cached root mismatches", async () => {
            const OLD_ROOT =
                "0x000000000000000000000000000000000000000000000000000000000000aaaa" as Hash;
            const NEW_ROOT = MOCK_ROOT;
            const getLatestASPRoot = vi
                .fn()
                .mockResolvedValueOnce(OLD_ROOT)
                .mockResolvedValue(NEW_ROOT);
            aspRegistryInteractor = createMockASPRegistryInteractor({ getLatestASPRoot });
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });

            const leaves = await client.getAssociationSetLeaves();

            expect(leaves).toEqual(MOCK_LEAVES);
            expect(getLatestASPRoot).toHaveBeenCalledTimes(2);
        });

        it("throw when both the cached and fresh on-chain roots disagree with the leaves", async () => {
            const STALE_ROOT =
                "0x000000000000000000000000000000000000000000000000000000000000aaaa" as Hash;
            const FRESH_ROOT =
                "0x000000000000000000000000000000000000000000000000000000000000bbbb" as Hash;
            const getLatestASPRoot = vi
                .fn()
                .mockResolvedValueOnce(STALE_ROOT)
                .mockResolvedValue(FRESH_ROOT);
            aspRegistryInteractor = createMockASPRegistryInteractor({ getLatestASPRoot });
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });

            await expect(client.getAssociationSetLeaves()).rejects.toThrow(ASPUnavailable);
            expect(getLatestASPRoot).toHaveBeenCalledTimes(2);
        });

        it("accept the empty-ASP case (empty leaves + empty on-chain root)", async () => {
            aspRegistryInteractor = createMockASPRegistryInteractor({
                getLatestASPRoot: vi.fn(async () => "0x0" as Hash),
            });
            provider1 = createMockProvider({ getLeaves: vi.fn(async () => []) });
            merkleService = createMockMerkleService({
                computeRoot: vi.fn(async (leaves: Hex[]) =>
                    leaves.length === 0 ? ("0x0" as Hash) : MOCK_ROOT,
                ),
            });
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });
            const leaves = await client.getAssociationSetLeaves();
            expect(leaves).toEqual([]);
        });

        it("reject empty leaves when on-chain root is non-empty (provider lying about empty set)", async () => {
            provider1 = createMockProvider({ getLeaves: vi.fn(async () => []) });
            merkleService = createMockMerkleService({
                computeRoot: vi.fn(async () => "0x0" as Hash),
            });
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });
            await expect(client.getAssociationSetLeaves()).rejects.toThrow(ASPUnavailable);
        });
    });

    describe("getMerkleProof", () => {
        it("get leaves and generate proof locally", async () => {
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });
            const proof = await client.getMerkleProof(MOCK_LEAVES[0]);
            expect(proof).toEqual(MOCK_PROOF);
            expect(provider1.getLeaves).toHaveBeenCalledOnce();
            expect(merkleService.generateMerkleProof).toHaveBeenCalledWith(
                MOCK_LEAVES,
                MOCK_LEAVES[0],
            );
        });

        it("throw LabelNotInSet when leaf not found", async () => {
            merkleService = createMockMerkleService({
                generateMerkleProof: vi.fn(async () => {
                    throw new LeafNotFound("leaf not in tree");
                }),
            });
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });
            await expect(
                client.getMerkleProof(
                    "0x00000000000000000000000000000000000000000000000000000000deadbeef" as Hash,
                ),
            ).rejects.toThrow(LabelNotInSet);
        });
    });

    describe("getLabelStatus", () => {
        it("return status from provider", async () => {
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });
            const status = await client.getLabelStatus(MOCK_LEAVES[0]);
            expect(status).toEqual(MOCK_LABEL_STATUS);
        });

        it("skip unsupported provider and use fallback", async () => {
            provider1 = createMockProvider({
                getLabelStatus: vi.fn(async () => {
                    throw new Error("not supported");
                }),
            });
            const client = new ASPClient({
                providers: [provider1, provider2],
                merkleService,
                aspRegistryInteractor,
            });
            const status = await client.getLabelStatus(MOCK_LEAVES[0]);
            expect(status).toEqual(MOCK_LABEL_STATUS);
        });

        it("throw ASPUnavailable when all providers fail", async () => {
            provider1 = createMockProvider({
                getLabelStatus: vi.fn(async () => {
                    throw new Error("p1");
                }),
            });
            provider2 = createMockProvider({
                getLabelStatus: vi.fn(async () => {
                    throw new Error("p2");
                }),
            });
            const client = new ASPClient({
                providers: [provider1, provider2],
                merkleService,
                aspRegistryInteractor,
            });
            await expect(client.getLabelStatus(MOCK_LEAVES[0])).rejects.toThrow(ASPUnavailable);
        });
    });

    describe("getASPPublicKey", () => {
        it("return public key from config when provided", async () => {
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
                publicKey: MOCK_PUBLIC_KEY,
            });
            const key = await client.getASPPublicKey();
            expect(key).toBe(MOCK_PUBLIC_KEY);
            expect(provider1.getASPPublicKey).not.toHaveBeenCalled();
        });

        it("return public key from provider when not in config", async () => {
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });
            const key = await client.getASPPublicKey();
            expect(key).toBe(MOCK_PUBLIC_KEY);
            expect(provider1.getASPPublicKey).toHaveBeenCalledOnce();
        });

        it("throw ASPUnavailable when all providers fail and no config key", async () => {
            provider1 = createMockProvider({
                getASPPublicKey: vi.fn(async () => {
                    throw new Error("not supported");
                }),
            });
            const client = new ASPClient({
                providers: [provider1],
                merkleService,
                aspRegistryInteractor,
            });
            await expect(client.getASPPublicKey()).rejects.toThrow(ASPUnavailable);
        });
    });
});
