import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Hash, IASPRegistryInteractor, IHTTPClient } from "../../../src/internal.js";
import {
    ASPUnavailable,
    InvalidASPCID,
    IpfsASPDataProvider,
    IPFSFetchFailed,
} from "../../../src/internal.js";
import { cidFor } from "../helpers/ipfsContent.js";

const MOCK_ROOT = "0x0000000000000000000000000000000000000000000000000000000000abcdef" as Hash;
const MOCK_LEAVES = [
    "0x0000000000000000000000000000000000000000000000000000000000000001" as Hash,
    "0x0000000000000000000000000000000000000000000000000000000000000002" as Hash,
];
// Canonical IPFS payload + matching CID. The provider verifies the SHA-256
// of the fetched bytes against the CID's embedded multihash; tests use
// matching pairs unless they specifically exercise the mismatch path.
const MOCK_PAYLOAD_BYTES = new TextEncoder().encode(JSON.stringify({ leaves: MOCK_LEAVES }));
const MOCK_CID = cidFor(MOCK_PAYLOAD_BYTES);
const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs";

function createMockRegistryInteractor(
    overrides?: Partial<IASPRegistryInteractor>,
): IASPRegistryInteractor {
    return {
        getLatestASPRoot: vi.fn(async () => MOCK_ROOT),
        getLatestAssociationSetData: vi.fn(async () => ({ root: MOCK_ROOT, ipfsCID: MOCK_CID })),
        ...overrides,
    };
}

function createMockHttpClient(overrides?: Partial<IHTTPClient>): IHTTPClient {
    return {
        get: vi.fn(),
        post: vi.fn(),
        getBinary: vi.fn(),
        ...overrides,
    };
}

describe("IpfsASPDataProvider", () => {
    let aspRegistryInteractor: IASPRegistryInteractor;
    let mockHttpClient: IHTTPClient;

    beforeEach(() => {
        vi.clearAllMocks();
        aspRegistryInteractor = createMockRegistryInteractor();
        mockHttpClient = createMockHttpClient();
    });

    const validConfig = (): {
        ipfsGatewayUrl: string;
        aspRegistryInteractor: IASPRegistryInteractor;
        httpClient: IHTTPClient;
    } => ({
        ipfsGatewayUrl: IPFS_GATEWAY,
        aspRegistryInteractor,
        httpClient: mockHttpClient,
    });

    describe("getRoot", () => {
        it("return root from on-chain registry", async () => {
            const provider = new IpfsASPDataProvider(validConfig());
            const root = await provider.getRoot();
            expect(root).toBe(MOCK_ROOT);
            expect(aspRegistryInteractor.getLatestASPRoot).toHaveBeenCalledOnce();
        });
    });

    describe("getLeaves", () => {
        it("get CID from registry and fetch + verify leaves from IPFS gateway", async () => {
            aspRegistryInteractor = createMockRegistryInteractor({
                getLatestAssociationSetData: vi.fn(async () => ({
                    root: MOCK_ROOT,
                    ipfsCID: MOCK_CID,
                })),
            });
            vi.mocked(mockHttpClient.getBinary).mockResolvedValue(MOCK_PAYLOAD_BYTES);
            const provider = new IpfsASPDataProvider(validConfig());
            const leaves = await provider.getLeaves();
            expect(leaves).toEqual(MOCK_LEAVES);
            expect(aspRegistryInteractor.getLatestAssociationSetData).toHaveBeenCalledOnce();
            expect(mockHttpClient.getBinary).toHaveBeenCalledWith(`${IPFS_GATEWAY}/${MOCK_CID}`);
        });

        it("throw IPFSFetchFailed on IPFS gateway error", async () => {
            aspRegistryInteractor = createMockRegistryInteractor({
                getLatestAssociationSetData: vi.fn(async () => ({
                    root: MOCK_ROOT,
                    ipfsCID: MOCK_CID,
                })),
            });
            vi.mocked(mockHttpClient.getBinary).mockRejectedValue(
                new Error("IPFS gateway timeout"),
            );
            const provider = new IpfsASPDataProvider(validConfig());
            await expect(provider.getLeaves()).rejects.toThrow(IPFSFetchFailed);
        });

        it("throw on registry error", async () => {
            aspRegistryInteractor = createMockRegistryInteractor({
                getLatestAssociationSetData: vi.fn(async () => {
                    throw new Error("Contract call failed");
                }),
            });
            const provider = new IpfsASPDataProvider(validConfig());
            await expect(provider.getLeaves()).rejects.toThrow();
        });

        it("throw InvalidASPCID when on-chain CID is malformed", async () => {
            aspRegistryInteractor = createMockRegistryInteractor({
                getLatestAssociationSetData: vi.fn(async () => ({
                    root: MOCK_ROOT,
                    ipfsCID: "not-a-cid",
                })),
            });
            vi.mocked(mockHttpClient.getBinary).mockResolvedValue(MOCK_PAYLOAD_BYTES);
            const provider = new IpfsASPDataProvider(validConfig());
            await expect(provider.getLeaves()).rejects.toThrow(InvalidASPCID);
        });

        it("throw IPFSFetchFailed when fetched bytes fail multihash check", async () => {
            aspRegistryInteractor = createMockRegistryInteractor({
                getLatestAssociationSetData: vi.fn(async () => ({
                    root: MOCK_ROOT,
                    ipfsCID: MOCK_CID,
                })),
            });
            // Bytes whose hash differs from MOCK_CID's embedded digest.
            vi.mocked(mockHttpClient.getBinary).mockResolvedValue(
                new TextEncoder().encode(JSON.stringify({ leaves: [] })),
            );
            const provider = new IpfsASPDataProvider(validConfig());
            await expect(provider.getLeaves()).rejects.toThrow(IPFSFetchFailed);
        });

        it("throw IPFSFetchFailed when decoded payload is missing the leaves field", async () => {
            const badPayloadBytes = new TextEncoder().encode(JSON.stringify({ wrong: "shape" }));
            const badCID = cidFor(badPayloadBytes);
            aspRegistryInteractor = createMockRegistryInteractor({
                getLatestAssociationSetData: vi.fn(async () => ({
                    root: MOCK_ROOT,
                    ipfsCID: badCID,
                })),
            });
            vi.mocked(mockHttpClient.getBinary).mockResolvedValue(badPayloadBytes);
            const provider = new IpfsASPDataProvider(validConfig());
            await expect(provider.getLeaves()).rejects.toThrow(IPFSFetchFailed);
        });

        it("throw IPFSFetchFailed when decoded payload leaves are not strings", async () => {
            const badPayloadBytes = new TextEncoder().encode(
                JSON.stringify({ leaves: [null, undefined] }),
            );
            const badCID = cidFor(badPayloadBytes);
            aspRegistryInteractor = createMockRegistryInteractor({
                getLatestAssociationSetData: vi.fn(async () => ({
                    root: MOCK_ROOT,
                    ipfsCID: badCID,
                })),
            });
            vi.mocked(mockHttpClient.getBinary).mockResolvedValue(badPayloadBytes);
            const provider = new IpfsASPDataProvider(validConfig());
            await expect(provider.getLeaves()).rejects.toThrow(IPFSFetchFailed);
        });

        it("throw IPFSFetchFailed when decoded JSON is malformed", async () => {
            const badPayloadBytes = new TextEncoder().encode("{not valid json");
            const badCID = cidFor(badPayloadBytes);
            aspRegistryInteractor = createMockRegistryInteractor({
                getLatestAssociationSetData: vi.fn(async () => ({
                    root: MOCK_ROOT,
                    ipfsCID: badCID,
                })),
            });
            vi.mocked(mockHttpClient.getBinary).mockResolvedValue(badPayloadBytes);
            const provider = new IpfsASPDataProvider(validConfig());
            await expect(provider.getLeaves()).rejects.toThrow(IPFSFetchFailed);
        });
    });

    describe("getLabelStatus", () => {
        it("throw ASPUnavailable (not supported via IPFS)", async () => {
            const provider = new IpfsASPDataProvider(validConfig());
            await expect(provider.getLabelStatus("0x01" as Hash)).rejects.toThrow(ASPUnavailable);
        });
    });

    describe("getASPPublicKey", () => {
        it("throw ASPUnavailable (not supported via IPFS)", async () => {
            const provider = new IpfsASPDataProvider(validConfig());
            await expect(provider.getASPPublicKey()).rejects.toThrow(ASPUnavailable);
        });
    });
});
