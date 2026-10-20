import { bytesToHex } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    CircuitManifest,
    ICacheStore,
    IHTTPClient,
    ILogger,
    IpfsCircuitArtifactsConfig,
} from "../../../src/internal.js";
import {
    CircuitArtifactLoadFailed,
    CircuitArtifactMultihashMismatch,
    IpfsCircuitArtifacts,
} from "../../../src/internal.js";
import { cidFor, dagPbCidFor } from "../helpers/ipfsContent.js";

const GATEWAY = "https://gateway.pinata.cloud/ipfs";
const GATEWAY_BACKUP = "https://cloudflare-ipfs.com/ipfs";

// Canonical fixture bytes for each artifact kind. Each test pulls these
// from `validConfig()` + canonical fixtures so the multihash verification
// inside `IpfsCircuitArtifacts.fetchAndCache` passes for valid responses.
// Tests exercising tampering paths construct mismatched bytes inline.
const WASM_BYTES = new Uint8Array([0xde, 0xad]);
const PKEY_BYTES = new Uint8Array([1, 2, 3]);
const VKEY_BYTES = new Uint8Array([7, 8, 9]);
const WASM_CID = cidFor(WASM_BYTES);
const PKEY_CID = cidFor(PKEY_BYTES);
const VKEY_CID = cidFor(VKEY_BYTES);

const MANIFEST: CircuitManifest = {
    deposit: { wasm: WASM_CID, provingKey: PKEY_CID, verificationKey: VKEY_CID },
    unpinned: { wasm: "", provingKey: "", verificationKey: "" },
};

function createMockHttpClient(overrides?: Partial<IHTTPClient>): IHTTPClient {
    return {
        get: vi.fn(),
        post: vi.fn(),
        getBinary: vi.fn(),
        ...overrides,
    };
}

function createMockCacheStore(overrides?: Partial<ICacheStore>): ICacheStore {
    return {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        ...overrides,
    };
}

function createMockLogger(): ILogger {
    return {
        child: vi.fn(),
        level: "debug",
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
    };
}

function validConfig(overrides?: Partial<IpfsCircuitArtifactsConfig>): IpfsCircuitArtifactsConfig {
    return {
        ipfsGatewayUrls: [GATEWAY],
        circuitManifest: MANIFEST,
        httpClient: createMockHttpClient(),
        ...overrides,
    };
}

describe("IpfsCircuitArtifacts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("constructor", () => {
        it("construct with valid config", () => {
            expect(() => new IpfsCircuitArtifacts(validConfig())).not.toThrow();
        });

        it("throw CircuitArtifactLoadFailed for empty ipfsGatewayUrls", () => {
            expect(() => new IpfsCircuitArtifacts(validConfig({ ipfsGatewayUrls: [] }))).toThrow(
                CircuitArtifactLoadFailed,
            );
        });

        it("throw CircuitArtifactLoadFailed for malformed gateway URL", () => {
            expect(
                () => new IpfsCircuitArtifacts(validConfig({ ipfsGatewayUrls: ["not a url"] })),
            ).toThrow(CircuitArtifactLoadFailed);
        });

        it("throw CircuitArtifactLoadFailed when manifest contains a malformed CID", () => {
            const bad: CircuitManifest = {
                deposit: {
                    wasm: "not-a-cid",
                    provingKey: PKEY_CID,
                    verificationKey: VKEY_CID,
                },
            };
            expect(() => new IpfsCircuitArtifacts(validConfig({ circuitManifest: bad }))).toThrow(
                CircuitArtifactLoadFailed,
            );
        });

        it("strip trailing slash from gateway URL", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockResolvedValue(WASM_BYTES);
            const artifacts = new IpfsCircuitArtifacts(
                validConfig({ ipfsGatewayUrls: [`${GATEWAY}/`], httpClient }),
            );
            await artifacts.getWasm("deposit");
            expect(httpClient.getBinary).toHaveBeenCalledWith(`${GATEWAY}/${WASM_CID}`);
        });
    });

    describe("fetch by CID", () => {
        it("fetch WASM and return Uint8Array", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockResolvedValue(WASM_BYTES);
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            const result = await artifacts.getWasm("deposit");

            expect(result).toBe(WASM_BYTES);
            expect(httpClient.getBinary).toHaveBeenCalledWith(`${GATEWAY}/${WASM_CID}`);
        });

        it("fetch proving key and return Uint8Array", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockResolvedValue(PKEY_BYTES);
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            const result = await artifacts.getProvingKey("deposit");

            expect(result).toBe(PKEY_BYTES);
            expect(httpClient.getBinary).toHaveBeenCalledWith(`${GATEWAY}/${PKEY_CID}`);
        });

        it("fetch verification key and return Uint8Array", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockResolvedValue(VKEY_BYTES);
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            const result = await artifacts.getVerificationKey("deposit");

            expect(result).toBe(VKEY_BYTES);
            expect(httpClient.getBinary).toHaveBeenCalledWith(`${GATEWAY}/${VKEY_CID}`);
        });

        it("reject fetched bytes whose SHA-256 does not match the CID multihash", async () => {
            const httpClient = createMockHttpClient();
            // Bytes whose hash differs from WASM_CID's embedded digest.
            vi.mocked(httpClient.getBinary).mockResolvedValue(new Uint8Array([0xbe, 0xef]));
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            // When every gateway in the fan-out fails (here: the single
            // gateway returns tampered bytes), the loop reports the
            // generic load failure with the inner multihash mismatch in
            // the message. The cache-hit path below preserves the
            // subclass since it doesn't loop.
            await expect(artifacts.getWasm("deposit")).rejects.toThrow(CircuitArtifactLoadFailed);
            await expect(artifacts.getWasm("deposit")).rejects.toThrow(/Multihash mismatch/);
        });

        it("fall through to next gateway when first returns tampered bytes", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary)
                .mockResolvedValueOnce(new Uint8Array([0xbe, 0xef])) // tampered
                .mockResolvedValueOnce(WASM_BYTES); // matches CID
            const artifacts = new IpfsCircuitArtifacts(
                validConfig({ ipfsGatewayUrls: [GATEWAY, GATEWAY_BACKUP], httpClient }),
            );

            const result = await artifacts.getWasm("deposit");

            expect(result).toBe(WASM_BYTES);
            expect(httpClient.getBinary).toHaveBeenCalledTimes(2);
        });
    });

    describe("caching", () => {
        it("dedup repeat fetches via default in-memory cache", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockResolvedValue(WASM_BYTES);
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            await artifacts.getWasm("deposit");
            await artifacts.getWasm("deposit");

            expect(httpClient.getBinary).toHaveBeenCalledTimes(1);
        });

        it("return cacheStore hit without calling httpClient", async () => {
            const httpClient = createMockHttpClient();
            const cacheStore = createMockCacheStore({
                get: vi.fn(async () => WASM_BYTES),
            });
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }), { cacheStore });

            const result = await artifacts.getWasm("deposit");

            expect(result).toBe(WASM_BYTES);
            expect(cacheStore.get).toHaveBeenCalledWith(WASM_CID);
            expect(httpClient.getBinary).not.toHaveBeenCalled();
        });

        it("reject poisoned cacheStore hit that fails multihash check", async () => {
            const httpClient = createMockHttpClient();
            const cacheStore = createMockCacheStore({
                get: vi.fn(async () => new Uint8Array([0xbe, 0xef])),
            });
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }), { cacheStore });

            await expect(artifacts.getWasm("deposit")).rejects.toThrow(
                CircuitArtifactMultihashMismatch,
            );
        });

        it("populate cacheStore after IPFS fetch", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockResolvedValue(WASM_BYTES);
            const cacheStore = createMockCacheStore();
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }), { cacheStore });

            await artifacts.getWasm("deposit");

            expect(cacheStore.set).toHaveBeenCalledWith(WASM_CID, WASM_BYTES);
        });

        it("swallow cacheStore.set failure and still return bytes", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockResolvedValue(WASM_BYTES);
            const cacheStore = createMockCacheStore({
                set: vi.fn(async () => {
                    throw new Error("QuotaExceededError");
                }),
            });
            const logger = createMockLogger();
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }), {
                cacheStore,
                logger,
            });

            const result = await artifacts.getWasm("deposit");

            expect(result).toBe(WASM_BYTES);
            expect(logger.warn).toHaveBeenCalledWith(
                "Failed to persist circuit artifact to cache",
                expect.objectContaining({ cid: WASM_CID, error: "QuotaExceededError" }),
            );
        });
    });

    describe("concurrency", () => {
        it("coalesce concurrent fetches of same CID into single network call", async () => {
            const httpClient = createMockHttpClient();
            let resolveFetch: ((value: Uint8Array) => void) | undefined;
            vi.mocked(httpClient.getBinary).mockImplementation(
                () =>
                    new Promise<Uint8Array>((resolve) => {
                        resolveFetch = resolve;
                    }),
            );
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            const a = artifacts.getWasm("deposit");
            const b = artifacts.getWasm("deposit");
            const c = artifacts.getWasm("deposit");
            // Let the cache.get awaits settle so all three reach the in-flight check.
            await Promise.resolve();
            await Promise.resolve();
            resolveFetch!(WASM_BYTES);

            const [ra, rb, rc] = await Promise.all([a, b, c]);

            expect(ra).toBe(WASM_BYTES);
            expect(rb).toBe(WASM_BYTES);
            expect(rc).toBe(WASM_BYTES);
            expect(httpClient.getBinary).toHaveBeenCalledTimes(1);
        });

        it("clear in-flight entry on failure so next call retries fresh", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary)
                .mockRejectedValueOnce(new Error("transient"))
                .mockResolvedValueOnce(WASM_BYTES);
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            await expect(artifacts.getWasm("deposit")).rejects.toThrow(CircuitArtifactLoadFailed);
            await expect(artifacts.getWasm("deposit")).resolves.toBeInstanceOf(Uint8Array);
            expect(httpClient.getBinary).toHaveBeenCalledTimes(2);
        });
    });

    describe("multi-gateway fallback", () => {
        it("fall back to next gateway on first gateway failure", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary)
                .mockRejectedValueOnce(new Error("Pinata down"))
                .mockResolvedValueOnce(WASM_BYTES);
            const artifacts = new IpfsCircuitArtifacts(
                validConfig({ ipfsGatewayUrls: [GATEWAY, GATEWAY_BACKUP], httpClient }),
            );

            const result = await artifacts.getWasm("deposit");

            expect(result).toBe(WASM_BYTES);
            expect(httpClient.getBinary).toHaveBeenNthCalledWith(1, `${GATEWAY}/${WASM_CID}`);
            expect(httpClient.getBinary).toHaveBeenNthCalledWith(
                2,
                `${GATEWAY_BACKUP}/${WASM_CID}`,
            );
        });

        it("throw CircuitArtifactLoadFailed listing all attempts when every gateway fails", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary)
                .mockRejectedValueOnce(new Error("Pinata down"))
                .mockRejectedValueOnce(new Error("Cloudflare down"));
            const artifacts = new IpfsCircuitArtifacts(
                validConfig({ ipfsGatewayUrls: [GATEWAY, GATEWAY_BACKUP], httpClient }),
            );

            await expect(artifacts.getWasm("deposit")).rejects.toThrow(
                /Pinata down[\s\S]*Cloudflare down/,
            );
            expect(httpClient.getBinary).toHaveBeenCalledTimes(2);
        });

        it("treat empty response body as gateway failure and fall through", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary)
                .mockResolvedValueOnce(new Uint8Array(0))
                .mockResolvedValueOnce(WASM_BYTES);
            const artifacts = new IpfsCircuitArtifacts(
                validConfig({ ipfsGatewayUrls: [GATEWAY, GATEWAY_BACKUP], httpClient }),
            );

            const result = await artifacts.getWasm("deposit");

            expect(result).toBe(WASM_BYTES);
            expect(httpClient.getBinary).toHaveBeenCalledTimes(2);
        });
    });

    describe("dag-pb CIDs (checksum-manifest verification)", () => {
        const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

        const DAG_PB_MANIFEST: CircuitManifest = {
            deposit: {
                wasm: dagPbCidFor(WASM_BYTES),
                wasmSha256: sha256Hex(WASM_BYTES),
                provingKey: dagPbCidFor(PKEY_BYTES),
                provingKeySha256: sha256Hex(PKEY_BYTES),
                verificationKey: dagPbCidFor(VKEY_BYTES),
                verificationKeySha256: sha256Hex(VKEY_BYTES),
            },
        };

        it("accept fetched bytes whose SHA-256 matches the manifest digest", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockResolvedValue(WASM_BYTES);
            const artifacts = new IpfsCircuitArtifacts(
                validConfig({ circuitManifest: DAG_PB_MANIFEST, httpClient }),
            );

            const result = await artifacts.getWasm("deposit");

            expect(result).toBe(WASM_BYTES);
        });

        it("reject fetched bytes whose SHA-256 does not match the manifest digest", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockResolvedValue(new Uint8Array([0xbe, 0xef]));
            const artifacts = new IpfsCircuitArtifacts(
                validConfig({ circuitManifest: DAG_PB_MANIFEST, httpClient }),
            );

            await expect(artifacts.getWasm("deposit")).rejects.toThrow(CircuitArtifactLoadFailed);
            await expect(artifacts.getWasm("deposit")).rejects.toThrow(/Hash mismatch/);
        });

        it("throw CircuitArtifactLoadFailed at construction when a dag-pb CID lacks its sha256 digest", () => {
            const missingDigest: CircuitManifest = {
                deposit: {
                    ...DAG_PB_MANIFEST.deposit!,
                    wasmSha256: undefined,
                },
            };
            expect(
                () => new IpfsCircuitArtifacts(validConfig({ circuitManifest: missingDigest })),
            ).toThrow(/requires a valid wasmSha256 digest/);
        });

        it("throw CircuitArtifactLoadFailed at construction when a dag-pb digest is malformed", () => {
            const badDigest: CircuitManifest = {
                deposit: {
                    ...DAG_PB_MANIFEST.deposit!,
                    wasmSha256: "not-hex",
                },
            };
            expect(
                () => new IpfsCircuitArtifacts(validConfig({ circuitManifest: badDigest })),
            ).toThrow(CircuitArtifactLoadFailed);
        });

        it("throw CircuitArtifactLoadFailed at construction when a digest equals the SHA-256 of empty input", () => {
            // sha256("") — what a digest pipeline produces when it hashes a
            // missing file. No fetched artifact can ever match it.
            const emptyInputDigest: CircuitManifest = {
                deposit: {
                    ...DAG_PB_MANIFEST.deposit!,
                    provingKeySha256: sha256Hex(new Uint8Array(0)),
                },
            };
            expect(
                () => new IpfsCircuitArtifacts(validConfig({ circuitManifest: emptyInputDigest })),
            ).toThrow(/SHA-256 of empty input/);
        });
    });

    describe("manifest immutability", () => {
        it("ignore post-construction mutations to the caller's manifest", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockResolvedValue(WASM_BYTES);
            const callerManifest: Record<
                string,
                { wasm: string; provingKey: string; verificationKey: string }
            > = {
                deposit: { wasm: WASM_CID, provingKey: PKEY_CID, verificationKey: VKEY_CID },
            };
            const artifacts = new IpfsCircuitArtifacts(
                validConfig({ circuitManifest: callerManifest, httpClient }),
            );

            // Mutate caller's copy.
            callerManifest.deposit.wasm = cidFor(new Uint8Array([0xff]));

            await artifacts.getWasm("deposit");

            expect(httpClient.getBinary).toHaveBeenCalledWith(`${GATEWAY}/${WASM_CID}`);
        });
    });

    describe("error handling", () => {
        it("throw CircuitArtifactLoadFailed for unknown circuit", async () => {
            const artifacts = new IpfsCircuitArtifacts(validConfig());
            await expect(artifacts.getWasm("nonexistent")).rejects.toThrow(
                CircuitArtifactLoadFailed,
            );
        });

        it("throw CircuitArtifactLoadFailed when CID is empty (unpinned)", async () => {
            const httpClient = createMockHttpClient();
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            await expect(artifacts.getWasm("unpinned")).rejects.toThrow(CircuitArtifactLoadFailed);
            expect(httpClient.getBinary).not.toHaveBeenCalled();
        });

        it("wrap httpClient network error in CircuitArtifactLoadFailed", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockRejectedValue(new Error("network down"));
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            await expect(artifacts.getWasm("deposit")).rejects.toThrow(CircuitArtifactLoadFailed);
        });

        it("wrap HTTP non-2xx error in CircuitArtifactLoadFailed", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockRejectedValue(new Error("HTTP 502 Bad Gateway"));
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            await expect(artifacts.getProvingKey("deposit")).rejects.toThrow(
                CircuitArtifactLoadFailed,
            );
        });

        it("wrap timeout error in CircuitArtifactLoadFailed", async () => {
            const httpClient = createMockHttpClient();
            vi.mocked(httpClient.getBinary).mockRejectedValue(new Error("request timed out"));
            const artifacts = new IpfsCircuitArtifacts(validConfig({ httpClient }));

            await expect(artifacts.getVerificationKey("deposit")).rejects.toThrow(
                CircuitArtifactLoadFailed,
            );
        });
    });
});
