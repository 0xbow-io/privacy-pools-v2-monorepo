import { beforeEach, describe, expect, it } from "vitest";

import type { AtRestScryptParams, IStorageService } from "../../../../src/internal.js";
import {
    AtRestDecryptionError,
    ENCRYPTED_STORAGE_HEADER_KEY,
    ENCRYPTED_STORAGE_HEADER_MARKER,
    ENCRYPTED_STORAGE_VERSION,
    EncryptedStorageBaseError,
    EncryptedStorageService,
    InMemoryStorageService,
    InvalidAtRestPassphrase,
    InvalidEncryptedRecord,
} from "../../../../src/internal.js";

// Cheap KDF params keep scrypt fast in tests; production defaults are memory-hard.
// N is the smallest in-bounds power of two (2^10) — the at-rest header now rejects
// anything below 2^10 as a resource-exhaustion guard (see the KDF-bounds tests below).
const FAST_KDF: AtRestScryptParams = { N: 1 << 10, r: 8, p: 1, dkLen: 32 };
const PASSPHRASE = "correct horse battery staple";

describe("EncryptedStorageService", () => {
    let inner: IStorageService;
    let store: EncryptedStorageService;

    beforeEach(() => {
        inner = new InMemoryStorageService();
        store = new EncryptedStorageService({
            inner,
            passphrase: PASSPHRASE,
            kdfParams: FAST_KDF,
        });
    });

    it("round-trip a string value through set then get", async () => {
        await store.set("k", "secret-value");
        expect(await store.get("k")).toBe("secret-value");
    });

    it("round-trip a nested object value through set then get", async () => {
        const value = { noteSecret: "0xabc", value: "0x10", nested: [1, 2, 3] };
        await store.set("note:1", value);
        expect(await store.get("note:1")).toEqual(value);
    });

    it("return null for a key that has not been set", async () => {
        expect(await store.get("missing")).toBeNull();
    });

    it("store ciphertext at rest, never the plaintext JSON", async () => {
        const value = { noteSecret: "SUPER_SECRET_MARKER", value: "0x10" };
        await store.set("note:1", value);

        const rawRecord = await inner.get<{ m: string; ct: string }>("note:1");
        expect(rawRecord).not.toBeNull();
        expect(rawRecord!.ct.startsWith("0x")).toBe(true);
        // The plaintext must not appear anywhere in the persisted record.
        expect(JSON.stringify(rawRecord)).not.toContain("SUPER_SECRET_MARKER");
        expect(JSON.stringify(rawRecord)).not.toContain(JSON.stringify(value));
    });

    // The storage key is authenticated as AEAD associated data. Without that binding a record
    // is valid under the derived key ALONE, so an attacker who can write the backing store can
    // move a sealed record between keys — across owners, chains, or record kinds — and it
    // decrypts cleanly, letting them substitute one account's state for another's.
    it("reject a valid record transplanted from a different storage key", async () => {
        await store.set("1:notes:alice", { noteSecret: "0xalice" });
        await store.set("1:notes:bob", { noteSecret: "0xbob" });

        // Attacker with write access to the backing store copies Alice's sealed record
        // verbatim over Bob's slot. Same store, same passphrase, same derived key — only the
        // logical key differs, so the AEAD tag is what has to catch it.
        const alice = await inner.get<{ m: string; ct: string }>("1:notes:alice");
        await inner.set("1:notes:bob", alice!);

        await expect(store.get("1:notes:bob")).rejects.toBeInstanceOf(AtRestDecryptionError);
        // Alice's own slot still opens — the record is intact, just not portable.
        expect(await store.get("1:notes:alice")).toEqual({ noteSecret: "0xalice" });
    });

    // The record AAD folds in the compile-time ENCRYPTED_STORAGE_VERSION. That is only safe while
    // a store written under a different version is rejected up front: otherwise bumping the
    // constant would change every record's AAD and every get() would fail authentication with an
    // error indistinguishable from a wrong passphrase — reading as user error, not a regression.
    it("reject a store whose persisted header version is not the supported one", async () => {
        await store.set("k", "v");
        const header = await inner.get<{ m: string; v: number }>(ENCRYPTED_STORAGE_HEADER_KEY);
        await inner.set(ENCRYPTED_STORAGE_HEADER_KEY, {
            ...header!,
            v: ENCRYPTED_STORAGE_VERSION + 1,
        });

        const reopened = new EncryptedStorageService({
            inner,
            passphrase: PASSPHRASE,
            kdfParams: FAST_KDF,
        });
        await expect(reopened.get("k")).rejects.toBeInstanceOf(InvalidEncryptedRecord);
    });

    it("pass the caller key through to the inner store unchanged", async () => {
        await store.set("1:notes:1", { a: 1 });
        // The value lives under the exact caller key (the decorator does not re-prefix).
        expect(await inner.get("1:notes:1")).not.toBeNull();
        // Only the reserved KDF header key is added alongside it.
        expect(await inner.get(ENCRYPTED_STORAGE_HEADER_KEY)).not.toBeNull();
    });

    it("throw AtRestDecryptionError when opened with a wrong passphrase", async () => {
        await store.set("k", "top-secret");

        const attacker = new EncryptedStorageService({
            inner, // same backend, same persisted salt
            passphrase: "wrong-passphrase",
            kdfParams: FAST_KDF,
        });
        await expect(attacker.get("k")).rejects.toBeInstanceOf(AtRestDecryptionError);
    });

    it("not return plaintext when the passphrase is wrong", async () => {
        await store.set("k", "top-secret");
        const attacker = new EncryptedStorageService({
            inner,
            passphrase: "wrong-passphrase",
            kdfParams: FAST_KDF,
        });
        await expect(attacker.get("k")).rejects.toThrow();
    });

    it("throw AtRestDecryptionError when the ciphertext is tampered with", async () => {
        await store.set("k", "top-secret");
        const rawRecord = await inner.get<{ m: string; ct: string }>("k");
        // Flip the final byte of the ciphertext/tag.
        const ct = rawRecord!.ct;
        const flipped = ct.slice(0, -2) + (ct.slice(-2) === "00" ? "01" : "00");
        await inner.set("k", { m: rawRecord!.m, ct: flipped });

        await expect(store.get("k")).rejects.toBeInstanceOf(AtRestDecryptionError);
    });

    it("throw InvalidEncryptedRecord when reading a plaintext value not written by the decorator", async () => {
        // Simulate a value written directly by a non-encrypted backend.
        await inner.set("k", { hello: "world" });
        await expect(store.get("k")).rejects.toBeInstanceOf(InvalidEncryptedRecord);
    });

    it("delete a key so a subsequent get returns null", async () => {
        await store.set("k", "value");
        await store.delete("k");
        expect(await store.get("k")).toBeNull();
        expect(await inner.get("k")).toBeNull();
    });

    it("pass delete through for a non-existent key without throwing", async () => {
        await expect(store.delete("phantom")).resolves.toBeUndefined();
    });

    it("clear all entries from the inner store", async () => {
        await store.set("a", 1);
        await store.set("b", 2);
        await store.clear();
        expect(await store.get("a")).toBeNull();
        expect(await store.get("b")).toBeNull();
        expect(await inner.get(ENCRYPTED_STORAGE_HEADER_KEY)).toBeNull();
    });

    it("remain usable after clear by re-establishing a fresh header", async () => {
        await store.set("a", "first");
        await store.clear();
        await store.set("a", "second");
        expect(await store.get("a")).toBe("second");
        expect(await inner.get(ENCRYPTED_STORAGE_HEADER_KEY)).not.toBeNull();
    });

    it("decrypt values written by a separate instance sharing the same passphrase and backend", async () => {
        await store.set("k", { secret: "0xdead" });
        const reopened = new EncryptedStorageService({
            inner,
            passphrase: PASSPHRASE,
            kdfParams: FAST_KDF,
        });
        expect(await reopened.get("k")).toEqual({ secret: "0xdead" });
    });

    it("reject an empty passphrase at construction", () => {
        expect(() => new EncryptedStorageService({ inner, passphrase: "" })).toThrow(
            InvalidAtRestPassphrase,
        );
    });

    it("throw after dispose when attempting a further write", async () => {
        await store.set("k", "v");
        store.dispose();
        await expect(store.set("k2", "v2")).rejects.toBeInstanceOf(EncryptedStorageBaseError);
    });

    it("zeroize the derived key on dispose without throwing on a second dispose", () => {
        store.dispose();
        expect(() => store.dispose()).not.toThrow();
    });

    // ── KDF-header bounds (resource-exhaustion / DoS guard) ───────────────────

    /** Plants a structurally-valid header carrying the given scrypt params directly into
     *  the inner store, so the next read exercises the header-bounds guard. */
    async function plantHeader(kdf: {
        N: number;
        r: number;
        p: number;
        dkLen: number;
    }): Promise<void> {
        await inner.set(ENCRYPTED_STORAGE_HEADER_KEY, {
            m: ENCRYPTED_STORAGE_HEADER_MARKER,
            v: ENCRYPTED_STORAGE_VERSION,
            kdf: { name: "scrypt", ...kdf },
            salt: ("0x" + "ab".repeat(16)) as `0x${string}`,
        });
    }

    it("reject a header whose scrypt N exceeds the upper bound (2^30 OOM vector)", async () => {
        await plantHeader({ N: 1 << 30, r: 8, p: 1, dkLen: 32 });
        // Any operation that derives the key must reject before scrypt is invoked.
        await expect(store.set("k", "v")).rejects.toBeInstanceOf(InvalidEncryptedRecord);
    });

    it("reject a header whose scrypt N is not a power of two", async () => {
        await plantHeader({ N: 1024 + 1, r: 8, p: 1, dkLen: 32 });
        await expect(store.set("k", "v")).rejects.toBeInstanceOf(InvalidEncryptedRecord);
    });

    it("reject a header whose scrypt N is below the lower bound", async () => {
        await plantHeader({ N: 16, r: 8, p: 1, dkLen: 32 });
        await expect(store.set("k", "v")).rejects.toBeInstanceOf(InvalidEncryptedRecord);
    });

    it("reject a header whose dkLen is not 32", async () => {
        await plantHeader({ N: 1 << 10, r: 8, p: 1, dkLen: 64 });
        await expect(store.set("k", "v")).rejects.toBeInstanceOf(InvalidEncryptedRecord);
    });

    it("reject a header whose scrypt r/p are out of range", async () => {
        await plantHeader({ N: 1 << 10, r: 64, p: 1, dkLen: 32 });
        await expect(store.set("k", "v")).rejects.toBeInstanceOf(InvalidEncryptedRecord);
    });

    it("accept and round-trip boundary-valid scrypt params (N = 2^10)", async () => {
        // The lower-bound power of two is accepted (not rejected) and the value round-trips
        // through a re-derive against the persisted header.
        const fresh = new EncryptedStorageService({
            inner: new InMemoryStorageService(),
            passphrase: PASSPHRASE,
            kdfParams: { N: 1 << 10, r: 8, p: 1, dkLen: 32 },
        });
        await fresh.set("k", "value");
        expect(await fresh.get("k")).toBe("value");
    });

    // ── Derived-key zeroization on dispose during in-flight derivation ────────

    it("refuse and zeroize the freshly derived key when disposed mid-derivation", async () => {
        // Kick off the first (memory-hard) derive, then dispose before it resolves. The
        // in-flight #loadOrCreateKey captures the passphrase reference up front, so the derive
        // still completes; the post-KDF disposed re-check must then zeroize the fresh key and
        // reject rather than re-arm #derivedKey on an already-disposed service (which would
        // leak a live key past dispose()).
        const raceStore = new EncryptedStorageService({
            inner: new InMemoryStorageService(),
            passphrase: PASSPHRASE,
            kdfParams: { N: 1 << 10, r: 8, p: 1, dkLen: 32 },
        });

        const pending = raceStore.set("k", "v"); // starts the derive; suspends on the KDF
        raceStore.dispose(); // disposes while the derive is still in flight

        await expect(pending).rejects.toBeInstanceOf(EncryptedStorageBaseError);
    });
});
