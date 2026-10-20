import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    ICryptoService,
    IHashService,
    IKeystoreManager,
    INoteComputationService,
    IPaymentRequestStorageAdapter,
    KeyPair,
    PaymentRequestServiceState,
    Secret,
} from "../../../src/internal.js";
import {
    InvalidPaymentRequestParams,
    InvalidPaymentRequestState,
    PaymentRequestNotFoundError,
    PaymentRequestService,
    SCAN_EXPIRY_GRACE_MS,
} from "../../../src/internal.js";

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const VALID_AMOUNT = "0x100" as Hex;
const MOCK_TAG = ("0x" + "ee".repeat(32)) as Hex;
const MOCK_PUB_KEY = ("0x" + "aa".repeat(32)) as Hex;
const MOCK_PRIV_KEY = ("0x" + "bb".repeat(32)) as Secret;
const MOCK_VIEWING_PRIV_KEY = ("0x" + "cc".repeat(32)) as Secret;
const MOCK_VIEWING_PUB_KEY = ("0x" + "dd".repeat(32)) as Hex;

function createMockCryptoService(): ICryptoService {
    let secretCounter = 0;
    return {
        generateSecret: vi.fn(() => {
            secretCounter += 1;
            return `0x${secretCounter.toString(16).padStart(64, "0")}` as Secret;
        }),
        generateEphemeralKeyPair: vi.fn(
            (): KeyPair => ({ privateKey: MOCK_PRIV_KEY, publicKey: MOCK_PUB_KEY }),
        ),
        ecdh: vi.fn(),
        encrypt: vi.fn(),
        decrypt: vi.fn(),
        deriveKeysFromSignature: vi.fn(),
        derivePaymentRequestKeyPair: vi.fn(
            (): KeyPair => ({ privateKey: MOCK_PRIV_KEY, publicKey: MOCK_PUB_KEY }),
        ),
    };
}

function createMockHashService(): IHashService {
    return {
        hash: vi.fn(() => MOCK_TAG),
    };
}

function createMockNoteComputationService(): INoteComputationService {
    let counter = 0;
    return {
        computeNoteAddressHash: vi.fn(() => {
            counter += 1;
            return `0x${counter.toString(16).padStart(64, "0")}` as Hash;
        }),
    } as unknown as INoteComputationService;
}

function createMockStorageAdapter(): IPaymentRequestStorageAdapter & {
    state: PaymentRequestServiceState | null;
} {
    let state: PaymentRequestServiceState | null = null;
    return {
        get state(): PaymentRequestServiceState | null {
            return state;
        },
        set state(v: PaymentRequestServiceState | null) {
            state = v;
        },
        saveState: vi.fn(async (s: PaymentRequestServiceState) => {
            state = s;
        }),
        getState: vi.fn(async () => state),
        clearState: vi.fn(async () => {
            state = null;
        }),
    };
}

function createMockKeystoreManager(): IKeystoreManager {
    return {
        getViewingKeyPair: vi.fn(() => ({
            privateKey: MOCK_VIEWING_PRIV_KEY,
            publicKey: MOCK_VIEWING_PUB_KEY,
        })),
        getPrivateNullifyingKey: vi.fn(),
        getPrivateRevocableKey: vi.fn(),
        getRevocableKeyIndex: vi.fn(),
        applyRotation: vi.fn(),
        isRegistered: vi.fn(),
        markRegistered: vi.fn(),
    };
}

function buildService(): {
    service: PaymentRequestService;
    adapter: ReturnType<typeof createMockStorageAdapter>;
} {
    const adapter = createMockStorageAdapter();
    const service = new PaymentRequestService({
        ownerAddress: VALID_OWNER,
        cryptoService: createMockCryptoService(),
        hashService: createMockHashService(),
        noteComputationService: createMockNoteComputationService(),
        keystoreManager: createMockKeystoreManager(),
        storageAdapter: adapter,
    });
    return { service, adapter };
}

describe("PaymentRequestService", () => {
    // The constructor validates `requestExpiryMs` up front precisely so a bad value cannot
    // surface mid-`generate`, after the payment ID, key pair, and slot secrets are already
    // derived — `BigInt(Infinity)` and `BigInt(1.5)` both throw RangeError at the stamping step.
    // Each rejected shape gets its own case (TEST-1: one test per error path).
    describe("constructor requestExpiryMs validation", () => {
        function construct(requestExpiryMs: number): PaymentRequestService {
            return new PaymentRequestService({
                ownerAddress: VALID_OWNER,
                cryptoService: createMockCryptoService(),
                hashService: createMockHashService(),
                noteComputationService: createMockNoteComputationService(),
                keystoreManager: createMockKeystoreManager(),
                storageAdapter: createMockStorageAdapter(),
                requestExpiryMs,
            });
        }

        // The plausible caller's way of saying "never expire" — and the one that would otherwise
        // blow up inside generate() rather than at wiring time.
        it("reject Infinity", () => {
            expect(() => construct(Number.POSITIVE_INFINITY)).toThrow(InvalidPaymentRequestParams);
        });

        it("reject NaN", () => {
            expect(() => construct(Number.NaN)).toThrow(InvalidPaymentRequestParams);
        });

        it("reject a fractional window", () => {
            expect(() => construct(1.5)).toThrow(InvalidPaymentRequestParams);
        });

        // Zero would stamp expiresAt === createdAt, expiring every request the instant it is
        // generated — a silently useless service rather than a loud misconfiguration.
        it("reject a zero window", () => {
            expect(() => construct(0)).toThrow(InvalidPaymentRequestParams);
        });

        it("reject a negative window", () => {
            expect(() => construct(-1)).toThrow(InvalidPaymentRequestParams);
        });

        it("reject a window beyond the safe-integer range", () => {
            expect(() => construct(Number.MAX_SAFE_INTEGER + 2)).toThrow(
                InvalidPaymentRequestParams,
            );
        });

        // Boundary on the accepting side: 1ms is the smallest legal window, and omitting the
        // option entirely must fall through to the default rather than trip the new guard.
        it("accept the smallest legal window", () => {
            expect(() => construct(1)).not.toThrow();
        });

        it("accept an omitted window and fall back to the default", () => {
            expect(() => buildService()).not.toThrow();
        });
    });

    describe("generate", () => {
        let service: PaymentRequestService;
        let adapter: ReturnType<typeof createMockStorageAdapter>;

        beforeEach(() => {
            const built = buildService();
            service = built.service;
            adapter = built.adapter;
        });

        it("create a record with default 5 slots when slots is omitted", async () => {
            const record = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
            });
            expect(record.noteSecretsMap.size).toBe(5);
        });

        it("respect a custom slots count", async () => {
            const record = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 3,
            });
            expect(record.noteSecretsMap.size).toBe(3);
        });

        it("populate tag, paymentKeyPair, recipientAddress, and status=OPEN", async () => {
            const record = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
            });
            expect(record.tag).toBe(MOCK_TAG);
            expect(record.paymentPubKey).toBe(MOCK_PUB_KEY);
            expect(record.paymentPrivKey).toBe(MOCK_PRIV_KEY);
            expect(record.recipientAddress).toBe(VALID_OWNER);
            expect(record.status).toBe("OPEN");
            expect(record.fulfilledByCommitments).toEqual([]);
        });

        it("persist generated record via the storage adapter", async () => {
            const record = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });
            expect(adapter.saveState).toHaveBeenCalledOnce();
            expect(adapter.state?.requests).toHaveLength(1);
            expect(adapter.state?.requests[0].paymentId).toBe(record.paymentId);
        });

        it("throw InvalidPaymentRequestParams when slots is non-positive", async () => {
            await expect(
                service.generate({ amount: VALID_AMOUNT, tokenId: VALID_TOKEN, slots: 0 }),
            ).rejects.toThrow(InvalidPaymentRequestParams);
        });

        it("populate noteSecretsMap so every key equals computeNoteAddressHash(ownerAddress, secret)", async () => {
            // The sender does not receive the recipient's EVM address, so
            // they cannot revalidate this binding at fulfill time. Pin it
            // here so a future refactor of the generation loop cannot
            // produce malformed maps that lock recipient funds.
            const computeMock = vi.fn(
                (owner: Address, secret: Secret): Hash =>
                    `0xdead${owner.slice(2, 10)}${secret.slice(2, 10).padStart(56, "0")}` as Hash,
            );
            const adapter = createMockStorageAdapter();
            const service = new PaymentRequestService({
                ownerAddress: VALID_OWNER,
                cryptoService: createMockCryptoService(),
                hashService: createMockHashService(),
                noteComputationService: {
                    computeNoteAddressHash: computeMock,
                } as unknown as INoteComputationService,
                keystoreManager: createMockKeystoreManager(),
                storageAdapter: adapter,
            });

            const record = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 3,
            });

            for (const [key, secret] of record.noteSecretsMap) {
                expect(key).toBe(computeMock(VALID_OWNER, secret));
            }
        });

        it("derive paymentPrivKey via cryptoService.derivePaymentRequestKeyPair, not the ephemeral pair", async () => {
            const adapter = createMockStorageAdapter();
            const cryptoService = createMockCryptoService();
            const keystoreManager = createMockKeystoreManager();
            const svc = new PaymentRequestService({
                ownerAddress: VALID_OWNER,
                cryptoService,
                hashService: createMockHashService(),
                noteComputationService: createMockNoteComputationService(),
                keystoreManager,
                storageAdapter: adapter,
            });

            const record = await svc.generate({ amount: VALID_AMOUNT, tokenId: VALID_TOKEN });

            expect(cryptoService.generateEphemeralKeyPair).not.toHaveBeenCalled();
            expect(cryptoService.derivePaymentRequestKeyPair).toHaveBeenCalledWith(
                MOCK_VIEWING_PRIV_KEY,
                VALID_OWNER,
                record.paymentId,
            );
        });

        it("omit paymentPrivKey from the persisted state blob", async () => {
            const { service, adapter } = buildService();
            await service.generate({ amount: VALID_AMOUNT, tokenId: VALID_TOKEN, slots: 1 });
            const persisted = adapter.state?.requests[0] as Record<string, unknown> | undefined;
            expect(persisted).toBeDefined();
            expect(persisted).not.toHaveProperty("paymentPrivKey");
        });
    });

    describe("list / getOpenRequests", () => {
        it("return all records when no filter is provided", async () => {
            const { service } = buildService();
            await service.generate({ amount: VALID_AMOUNT, tokenId: VALID_TOKEN, slots: 1 });
            await service.generate({ amount: VALID_AMOUNT, tokenId: VALID_TOKEN, slots: 1 });
            const all = await service.list();
            expect(all).toHaveLength(2);
        });

        it("filter by status", async () => {
            const { service } = buildService();
            const r = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });
            await service.markFulfilled(r.paymentId, {
                commitment: ("0x" + "cc".repeat(32)) as Hex,
                noteAddressHash: r.noteAddressHashes[0],
                value: "0x1" as Hex,
            });

            const open = await service.list({ status: "OPEN" });
            const fulfilled = await service.list({ status: "FULFILLED" });

            expect(open).toHaveLength(0);
            expect(fulfilled).toHaveLength(1);
        });

        it("getOpenRequests delegates to list with status=OPEN", async () => {
            const { service } = buildService();
            await service.generate({ amount: VALID_AMOUNT, tokenId: VALID_TOKEN, slots: 1 });
            const open = await service.getOpenRequests();
            expect(open).toHaveLength(1);
            expect(open[0].status).toBe("OPEN");
        });
    });

    describe("markFulfilled", () => {
        it("flip status to FULFILLED and append commitment on a genuine match", async () => {
            const { service, adapter } = buildService();
            const r = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });
            const commitment = ("0x" + "dd".repeat(32)) as Hex;

            await service.markFulfilled(r.paymentId, {
                commitment,
                noteAddressHash: r.noteAddressHashes[0],
                value: "0x64" as Hex,
            });

            const updated = (await service.list())[0];
            expect(updated.status).toBe("FULFILLED");
            expect(updated.fulfilledByCommitments).toEqual([commitment]);
            expect(updated.consumedSlots).toEqual([r.noteAddressHashes[0]]);
            expect(adapter.saveState).toHaveBeenCalledTimes(2); // once on generate, once on markFulfilled
        });

        it("be idempotent for the same commitment", async () => {
            const { service } = buildService();
            const r = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });
            const commitment = ("0x" + "dd".repeat(32)) as Hex;
            const match = {
                commitment,
                noteAddressHash: r.noteAddressHashes[0],
                value: "0x64" as Hex,
            };

            await service.markFulfilled(r.paymentId, match);
            await service.markFulfilled(r.paymentId, match);

            const updated = (await service.list())[0];
            expect(updated.fulfilledByCommitments).toEqual([commitment]);
            expect(updated.consumedSlots).toEqual([r.noteAddressHashes[0]]);
        });

        it("append additional commitments beyond the first match", async () => {
            const { service } = buildService();
            const r = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 2,
            });

            await service.markFulfilled(r.paymentId, {
                commitment: ("0x" + "11".repeat(32)) as Hex,
                noteAddressHash: r.noteAddressHashes[0],
                value: "0x64" as Hex,
            });
            await service.markFulfilled(r.paymentId, {
                commitment: ("0x" + "22".repeat(32)) as Hex,
                noteAddressHash: r.noteAddressHashes[1],
                value: "0x64" as Hex,
            });

            const updated = (await service.list())[0];
            expect(updated.fulfilledByCommitments).toHaveLength(2);
            expect(updated.consumedSlots).toHaveLength(2);
        });

        it("record but NOT consume a slot for a 0-value phantom (no fulfillment advance)", async () => {
            // An attacker can craft a decryptable dust/zero note against a public slot.
            // It is recorded (audit trail) but must not advance fulfillment (#600).
            const { service } = buildService();
            const r = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });

            await service.markFulfilled(r.paymentId, {
                commitment: ("0x" + "de".repeat(32)) as Hex,
                noteAddressHash: r.noteAddressHashes[0],
                value: "0x0" as Hex,
            });

            const updated = (await service.list())[0];
            expect(updated.status).toBe("OPEN");
            expect(updated.consumedSlots).toEqual([]);
            expect(updated.fulfilledByCommitments).toHaveLength(1);
        });

        it("NOT consume a slot twice for a duplicate-slot phantom", async () => {
            const { service } = buildService();
            const r = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });

            await service.markFulfilled(r.paymentId, {
                commitment: ("0x" + "11".repeat(32)) as Hex,
                noteAddressHash: r.noteAddressHashes[0],
                value: "0x64" as Hex,
            });
            // A second, different commitment re-using the SAME slot must not double-consume.
            await service.markFulfilled(r.paymentId, {
                commitment: ("0x" + "22".repeat(32)) as Hex,
                noteAddressHash: r.noteAddressHashes[0],
                value: "0x64" as Hex,
            });

            const updated = (await service.list())[0];
            expect(updated.consumedSlots).toEqual([r.noteAddressHashes[0]]);
            expect(updated.fulfilledByCommitments).toHaveLength(2);
        });

        it("NOT consume a slot for a noteAddressHash outside the request's slot map", async () => {
            const { service } = buildService();
            const r = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });

            await service.markFulfilled(r.paymentId, {
                commitment: ("0x" + "33".repeat(32)) as Hex,
                noteAddressHash: ("0x" + "ff".repeat(32)) as Hash,
                value: "0x64" as Hex,
            });

            const updated = (await service.list())[0];
            expect(updated.status).toBe("OPEN");
            expect(updated.consumedSlots).toEqual([]);
        });

        it("throw PaymentRequestNotFoundError for unknown paymentId", async () => {
            const { service } = buildService();
            await expect(
                service.markFulfilled("0xdead" as Hex, {
                    commitment: "0xfeed" as Hex,
                    noteAddressHash: ("0x" + "01".repeat(32)) as Hash,
                    value: "0x1" as Hex,
                }),
            ).rejects.toThrow(PaymentRequestNotFoundError);
        });
    });

    describe("getScannableRequests / archive / expiry", () => {
        it("include a FULFILLED request until it is archived (discovery must not stop at FULFILLED)", async () => {
            const { service } = buildService();
            const r = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });
            await service.markFulfilled(r.paymentId, {
                commitment: ("0x" + "dd".repeat(32)) as Hex,
                noteAddressHash: r.noteAddressHashes[0],
                value: "0x64" as Hex,
            });

            const scannable = await service.getScannableRequests();
            expect(scannable).toHaveLength(1);
            expect(scannable[0].status).toBe("FULFILLED");
        });

        it("exclude an archived request from the scan set but keep it in list()", async () => {
            const { service, adapter } = buildService();
            const r = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });

            await service.archive(r.paymentId);

            expect(await service.getScannableRequests()).toHaveLength(0);
            const all = await service.list();
            expect(all).toHaveLength(1);
            expect(all[0].status).toBe("ARCHIVED");
            expect(adapter.saveState).toHaveBeenCalledTimes(2); // generate + archive
        });

        it("be idempotent when archiving an already-archived request", async () => {
            const { service, adapter } = buildService();
            const r = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });

            await service.archive(r.paymentId);
            await service.archive(r.paymentId);

            expect(adapter.saveState).toHaveBeenCalledTimes(2); // generate + first archive only
        });

        it("throw PaymentRequestNotFoundError when archiving an unknown paymentId", async () => {
            const { service } = buildService();
            await expect(service.archive("0xdead" as Hex)).rejects.toThrow(
                PaymentRequestNotFoundError,
            );
        });

        // A lapsed deadline alone no longer removes a request from the scan set: a payment
        // made before it is on-chain and matchable forever, so retiring on the clock would
        // lose it for a recipient who happened to scan afterwards. Only coverage retires.
        it("keep a request past its expiry window scannable until a scan covers it", async () => {
            const adapter = createMockStorageAdapter();
            // A record created near epoch is far past any positive expiry window relative to now.
            adapter.state = {
                requests: [
                    {
                        paymentId: ("0x" + "ab".repeat(32)) as Hex,
                        noteAddressHashes: [("0x" + "01".repeat(32)) as Hash],
                        noteSecretsMap: new Map<Hash, Secret>([
                            [("0x" + "01".repeat(32)) as Hash, ("0x" + "02".repeat(32)) as Secret],
                        ]),
                        amount: VALID_AMOUNT,
                        tokenId: VALID_TOKEN,
                        tag: MOCK_TAG,
                        paymentPubKey: MOCK_PUB_KEY,
                        recipientAddress: VALID_OWNER,
                        status: "OPEN",
                        createdAt: "0x1" as Hex, // 1ms after epoch
                        // Stamped (as `generate` does) so this exercises the expiry window. An
                        // unstamped record models a pre-expiry snapshot and is never expired.
                        expiresAt: "0x3e9" as Hex, // createdAt + 1000ms, i.e. long past
                        fulfilledByCommitments: [],
                        consumedSlots: [],
                    },
                ],
            };
            const service = new PaymentRequestService({
                ownerAddress: VALID_OWNER,
                cryptoService: createMockCryptoService(),
                hashService: createMockHashService(),
                noteComputationService: createMockNoteComputationService(),
                keystoreManager: createMockKeystoreManager(),
                storageAdapter: adapter,
                requestExpiryMs: 1000, // 1s window; the epoch-old record is long expired
            });
            await service.loadFromStorage();

            expect(await service.getScannableRequests()).toHaveLength(1);

            // Coverage past the deadline is what retires it.
            // expiresAt (0x3e9) + grace is the inclusive boundary, so coverage has to pass it.
            await service.markScanRetired(
                ("0x" + (0x3e9n + BigInt(SCAN_EXPIRY_GRACE_MS) + 1n).toString(16)) as Hex,
            );
            expect(await service.getScannableRequests()).toHaveLength(0);
            expect(await service.list()).toHaveLength(1); // still visible for display
        });

        it("keep a freshly-generated request scannable under the default window", async () => {
            const { service } = buildService();
            await service.generate({ amount: VALID_AMOUNT, tokenId: VALID_TOKEN, slots: 1 });
            expect(await service.getScannableRequests()).toHaveLength(1);
        });

        // Boundary of the SCAN window (#600). isExpired uses strict `>` against
        // `expiresAt + SCAN_EXPIRY_GRACE_MS`, not against `expiresAt` itself: the recipient keeps
        // scanning past the sender's deadline so a payment that was legitimate when submitted is
        // still discovered once it lands. So a request is scannable right up to
        // `expiresAt + grace` inclusive, and drops out one millisecond later.
        //
        // The grace is imported, never restated: hard-coding 24h here would let the constant and
        // the test drift apart, and the test would keep passing while describing a window the
        // code no longer has.
        const EXPIRY_MS = 1000;
        // Comfortably past the epoch so `expiresAt + grace` is representable in every fixture.
        const FIXED_NOW = SCAN_EXPIRY_GRACE_MS * 10;

        /**
         * Builds a loaded service holding a single OPEN request created `ageMs` before FIXED_NOW.
         *
         * `expiresAt` is stamped here exactly as `generate` stamps it. Omitting it would model a
         * record persisted before scan-expiry existed, which is deliberately never expired — see
         * the grandfathering test below.
         */
        async function serviceWithRequestAged(
            ageMs: number,
            opts: { stampExpiry?: boolean } = {},
        ): Promise<PaymentRequestService> {
            const stampExpiry = opts.stampExpiry ?? true;
            const adapter = createMockStorageAdapter();
            adapter.state = {
                requests: [
                    {
                        paymentId: ("0x" + "ab".repeat(32)) as Hex,
                        noteAddressHashes: [("0x" + "01".repeat(32)) as Hash],
                        noteSecretsMap: new Map<Hash, Secret>([
                            [("0x" + "01".repeat(32)) as Hash, ("0x" + "02".repeat(32)) as Secret],
                        ]),
                        amount: VALID_AMOUNT,
                        tokenId: VALID_TOKEN,
                        tag: MOCK_TAG,
                        paymentPubKey: MOCK_PUB_KEY,
                        recipientAddress: VALID_OWNER,
                        status: "OPEN",
                        // Clamped at 0: these are unsigned ms-since-epoch stamps, and a negative
                        // value would hex-encode as "0x-..." and fail HexSchema on load with an
                        // opaque Zod error rather than "your fixture predates the epoch".
                        createdAt: ("0x" + Math.max(0, FIXED_NOW - ageMs).toString(16)) as Hex,
                        ...(stampExpiry
                            ? {
                                  expiresAt: ("0x" +
                                      Math.max(0, FIXED_NOW - ageMs + EXPIRY_MS).toString(
                                          16,
                                      )) as Hex,
                              }
                            : {}),
                        fulfilledByCommitments: [],
                        consumedSlots: [],
                    },
                ],
            };
            const service = new PaymentRequestService({
                ownerAddress: VALID_OWNER,
                cryptoService: createMockCryptoService(),
                hashService: createMockHashService(),
                noteComputationService: createMockNoteComputationService(),
                keystoreManager: createMockKeystoreManager(),
                storageAdapter: adapter,
                requestExpiryMs: EXPIRY_MS,
            });
            await service.loadFromStorage();
            return service;
        }

        /** Runs `assert` with the clock pinned to FIXED_NOW, restoring real timers either way. */
        async function atFixedNow(assert: () => Promise<void>): Promise<void> {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(FIXED_NOW));
            try {
                await assert();
            } finally {
                vi.useRealTimers();
            }
        }

        it("keep a request created exactly expiryMs ago scannable (boundary, still live)", async () => {
            await atFixedNow(async () => {
                const service = await serviceWithRequestAged(EXPIRY_MS);
                expect(await service.getScannableRequests()).toHaveLength(1);
            });
        });

        // The whole point of the grace. A sender who passed their own `expiresAt` check moments
        // before the deadline still needs to prove, submit, and be included; if the recipient
        // stopped scanning at `expiresAt` exactly, that payment would land on-chain outside the
        // scan set and never be discovered — #600's silent loss in a smaller window.
        it("keep a request scannable just past expiresAt but within the grace period", async () => {
            await atFixedNow(async () => {
                const service = await serviceWithRequestAged(EXPIRY_MS + 1);
                expect(await service.getScannableRequests()).toHaveLength(1);
            });
        });

        it("keep a request scannable at exactly expiresAt + grace (boundary, still live)", async () => {
            await atFixedNow(async () => {
                const service = await serviceWithRequestAged(EXPIRY_MS + SCAN_EXPIRY_GRACE_MS);
                expect(await service.getScannableRequests()).toHaveLength(1);
            });
        });

        // The deadline is the boundary `markScanRetired` applies, and it applies it to the
        // timestamp a scan has COVERED, never to the wall clock. A request one millisecond
        // past `expiresAt + grace` is therefore still scannable while nothing has covered
        // it, and drops out the moment a covering scan is reported.
        it("retire a request one millisecond past expiresAt + grace only once a scan covers it", async () => {
            await atFixedNow(async () => {
                const service = await serviceWithRequestAged(EXPIRY_MS + SCAN_EXPIRY_GRACE_MS + 1);
                expect(await service.getScannableRequests()).toHaveLength(1);

                await service.markScanRetired(("0x" + BigInt(FIXED_NOW).toString(16)) as Hex);
                expect(await service.getScannableRequests()).toHaveLength(0);
            });
        });

        it("leave a request whose deadline the scan has not reached in the scan set", async () => {
            await atFixedNow(async () => {
                const service = await serviceWithRequestAged(EXPIRY_MS + SCAN_EXPIRY_GRACE_MS + 1);
                // Coverage stopping one millisecond short of the boundary retires nothing.
                const record = (await service.list())[0];
                const boundary = BigInt(record.expiresAt as Hex) + BigInt(SCAN_EXPIRY_GRACE_MS);
                await service.markScanRetired(("0x" + boundary.toString(16)) as Hex);
                expect(await service.getScannableRequests()).toHaveLength(1);
            });
        });

        it("keep the original coverage stamp when a later scan retires nothing new", async () => {
            await atFixedNow(async () => {
                const service = await serviceWithRequestAged(EXPIRY_MS + SCAN_EXPIRY_GRACE_MS + 1);
                const first = ("0x" + BigInt(FIXED_NOW).toString(16)) as Hex;
                await service.markScanRetired(first);
                await service.markScanRetired(
                    ("0x" + BigInt(FIXED_NOW + 5000).toString(16)) as Hex,
                );
                expect((await service.list())[0].scanRetiredAt).toBe(first);
            });
        });

        // #600 regression. Scan-expiry must never apply retroactively. A record persisted before
        // expiry existed carries no `expiresAt`; recomputing the window from `createdAt` instead
        // would silently drop every already-shared request older than the window out of the scan
        // set the moment the user upgrades — so a sender paying that still-valid link would
        // create a note that lands on-chain and is never discovered.
        it("never expire a pre-existing record that carries no expiresAt stamp", async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(FIXED_NOW));
            try {
                const service = await serviceWithRequestAged(EXPIRY_MS * 1000, {
                    stampExpiry: false,
                });
                const [stored] = await service.list();
                expect(stored.expiresAt).toBeUndefined();
                expect(await service.getScannableRequests()).toHaveLength(1);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("clear", () => {
        it("remove all records and clear storage", async () => {
            const { service, adapter } = buildService();
            await service.generate({ amount: VALID_AMOUNT, tokenId: VALID_TOKEN, slots: 1 });
            await service.clear();
            expect(await service.list()).toEqual([]);
            expect(adapter.clearState).toHaveBeenCalledOnce();
        });
    });

    describe("loadFromStorage", () => {
        it("hydrate in-memory state from the adapter", async () => {
            const adapter = createMockStorageAdapter();
            const persisted: PaymentRequestServiceState = {
                requests: [
                    {
                        paymentId: ("0x" + "ab".repeat(32)) as Hex,
                        noteAddressHashes: [("0x" + "01".repeat(32)) as Hash],
                        noteSecretsMap: new Map<Hash, Secret>([
                            [("0x" + "01".repeat(32)) as Hash, ("0x" + "02".repeat(32)) as Secret],
                        ]),
                        amount: VALID_AMOUNT,
                        tokenId: VALID_TOKEN,
                        tag: MOCK_TAG,
                        paymentPubKey: MOCK_PUB_KEY,
                        recipientAddress: VALID_OWNER,
                        status: "OPEN",
                        createdAt: "0x1" as Hex,
                        fulfilledByCommitments: [],
                        consumedSlots: [],
                    },
                ],
            };
            adapter.state = persisted;

            const service = new PaymentRequestService({
                ownerAddress: VALID_OWNER,
                cryptoService: createMockCryptoService(),
                hashService: createMockHashService(),
                noteComputationService: createMockNoteComputationService(),
                keystoreManager: createMockKeystoreManager(),
                storageAdapter: adapter,
            });

            await service.loadFromStorage();
            const all = await service.list();
            expect(all).toHaveLength(1);
            expect(all[0].paymentId).toBe(persisted.requests[0].paymentId);
        });

        it("be a no-op when no persisted state exists", async () => {
            const { service } = buildService();
            await service.loadFromStorage();
            expect(await service.list()).toEqual([]);
        });

        it("rehydrate paymentPrivKey from the viewing key on load", async () => {
            const adapter = createMockStorageAdapter();
            adapter.state = {
                requests: [
                    {
                        paymentId: ("0x" + "ab".repeat(32)) as Hex,
                        noteAddressHashes: [("0x" + "01".repeat(32)) as Hash],
                        noteSecretsMap: new Map<Hash, Secret>([
                            [("0x" + "01".repeat(32)) as Hash, ("0x" + "02".repeat(32)) as Secret],
                        ]),
                        amount: VALID_AMOUNT,
                        tokenId: VALID_TOKEN,
                        tag: MOCK_TAG,
                        paymentPubKey: MOCK_PUB_KEY,
                        recipientAddress: VALID_OWNER,
                        status: "OPEN",
                        createdAt: "0x1" as Hex,
                        fulfilledByCommitments: [],
                        consumedSlots: [],
                    },
                ],
            };

            const cryptoService = createMockCryptoService();
            const service = new PaymentRequestService({
                ownerAddress: VALID_OWNER,
                cryptoService,
                hashService: createMockHashService(),
                noteComputationService: createMockNoteComputationService(),
                keystoreManager: createMockKeystoreManager(),
                storageAdapter: adapter,
            });

            await service.loadFromStorage();
            const [hydrated] = await service.list();
            expect(hydrated.paymentPrivKey).toBe(MOCK_PRIV_KEY);
            expect(cryptoService.derivePaymentRequestKeyPair).toHaveBeenCalledWith(
                MOCK_VIEWING_PRIV_KEY,
                VALID_OWNER,
                hydrated.paymentId,
            );
        });
    });

    describe("exportState / importState", () => {
        it("export an empty array when no requests exist", () => {
            const { service } = buildService();
            expect(service.exportState()).toEqual([]);
        });

        it("export records as JSON-safe array-of-entries with no paymentPrivKey", async () => {
            const { service } = buildService();
            const record = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 2,
            });

            const [exported] = service.exportState();
            expect(exported.paymentId).toBe(record.paymentId);
            expect(Array.isArray(exported.noteSecretsMap)).toBe(true);
            expect(exported.noteSecretsMap).toHaveLength(2);
            expect("paymentPrivKey" in exported).toBe(false);
        });

        it("round-trip a snapshot from exportState back through importState", async () => {
            const source = buildService();
            await source.service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });
            const snapshot = source.service.exportState();

            const target = buildService();
            await target.service.importState(snapshot);

            const restored = await target.service.list();
            expect(restored).toHaveLength(1);
            expect(restored[0].paymentId).toBe(snapshot[0].paymentId);
            expect(restored[0].noteSecretsMap.size).toBe(1);
            expect(restored[0].paymentPrivKey).toBe(MOCK_PRIV_KEY);
        });

        it("survive a JSON stringify/parse round-trip without losing noteSecretsMap", async () => {
            const source = buildService();
            await source.service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 2,
            });
            // The integrator's real path goes through storage as JSON. A Map
            // here would stringify to `{}` and the codec's size>0 refine would
            // reject it — so this guards the array-of-entries shape end-to-end,
            // which the in-memory round-trip above cannot (the codec also
            // accepts a Map).
            const serialized = JSON.parse(
                JSON.stringify(source.service.exportState()),
            ) as ReturnType<PaymentRequestService["exportState"]>;

            const target = buildService();
            await target.service.importState(serialized);

            const [restored] = await target.service.list();
            expect(restored.noteSecretsMap.size).toBe(2);
        });

        it("carry scanRetiredAt through a JSON export/import round-trip", async () => {
            // The storage schema is what both the load path and importState run records
            // through, and a field it does not declare is dropped silently. A retired request
            // would then come back scannable after a reload, and the wallet would keep
            // scanning for a payment it has already stopped expecting.
            const source = buildService();
            const record = await source.service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });
            const covered = ("0x" +
                (BigInt(record.expiresAt as Hex) + BigInt(SCAN_EXPIRY_GRACE_MS) + 1n).toString(
                    16,
                )) as Hex;
            await source.service.markScanRetired(covered);

            const serialized = JSON.parse(
                JSON.stringify(source.service.exportState()),
            ) as ReturnType<PaymentRequestService["exportState"]>;

            const target = buildService();
            await target.service.importState(serialized);

            expect((await target.service.list())[0].scanRetiredAt).toBe(covered);
            expect(await target.service.getScannableRequests()).toHaveLength(0);
        });

        it("reload a retired request from storage as retired", async () => {
            const { service, adapter } = buildService();
            const record = await service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });
            const covered = ("0x" +
                (BigInt(record.expiresAt as Hex) + BigInt(SCAN_EXPIRY_GRACE_MS) + 1n).toString(
                    16,
                )) as Hex;
            await service.markScanRetired(covered);

            const reloaded = buildService();
            reloaded.adapter.state = adapter.state;
            await reloaded.service.loadFromStorage();

            expect(await reloaded.service.getScannableRequests()).toHaveLength(0);
        });

        it("persist the imported snapshot via the storage adapter", async () => {
            const source = buildService();
            await source.service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });
            const snapshot = source.service.exportState();

            const { service, adapter } = buildService();
            await service.importState(snapshot);
            expect(adapter.saveState).toHaveBeenCalledOnce();
            expect(adapter.state?.requests).toHaveLength(1);
        });

        it("replace any existing in-memory requests on import", async () => {
            const source = buildService();
            await source.service.generate({
                amount: VALID_AMOUNT,
                tokenId: VALID_TOKEN,
                slots: 1,
            });
            const snapshot = source.service.exportState();

            const { service } = buildService();
            await service.generate({ amount: VALID_AMOUNT, tokenId: VALID_TOKEN, slots: 1 });
            await service.importState(snapshot);

            const restored = await service.list();
            expect(restored).toHaveLength(1);
            expect(restored[0].paymentId).toBe(snapshot[0].paymentId);
        });

        it("throw InvalidPaymentRequestState on a malformed snapshot", async () => {
            const { service } = buildService();
            const bad = [{ paymentId: "not-hex" }] as unknown as ReturnType<
                PaymentRequestService["exportState"]
            >;
            await expect(service.importState(bad)).rejects.toThrow(InvalidPaymentRequestState);
        });
    });
});
