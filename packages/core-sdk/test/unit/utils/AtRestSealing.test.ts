import { hexToBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { describe, expect, it } from "vitest";

import type { AtRestScryptParams, SealedEnvelope } from "../../../src/internal.js";
import {
    aeadEncrypt,
    AtRestDecryptionError,
    atRestRecordAad,
    deriveAtRestKey,
    InvalidAtRestPassphrase,
    InvalidEncryptedRecord,
    openSealed,
    passphraseToBytes,
    sealValue,
} from "../../../src/internal.js";

// Cheap KDF params keep scrypt fast in tests. N is the smallest in-bounds power of two
// (2^10) — openSealed now rejects out-of-range params as a resource-exhaustion guard.
const FAST_KDF: AtRestScryptParams = { N: 1 << 10, r: 8, p: 1, dkLen: 32 };
const PASSPHRASE = "correct horse battery staple";

describe("AtRestSealing", () => {
    it("round-trip an object through sealValue then openSealed", async () => {
        const account = { notes: [{ noteSecret: "0xabc" }], owner: "0x01", chainId: 1 };
        const sealed = await sealValue(account, PASSPHRASE, FAST_KDF);
        expect(await openSealed(sealed, PASSPHRASE)).toEqual(account);
    });

    it("produce ciphertext that does not contain the plaintext", async () => {
        const sealed = await sealValue({ secret: "SUPER_SECRET_MARKER" }, PASSPHRASE, FAST_KDF);
        expect(JSON.stringify(sealed)).not.toContain("SUPER_SECRET_MARKER");
        expect(sealed.ciphertext.startsWith("0x")).toBe(true);
        expect(sealed.salt.startsWith("0x")).toBe(true);
        expect(sealed.kdf.name).toBe("scrypt");
    });

    it("throw AtRestDecryptionError when opened with a wrong passphrase", async () => {
        const sealed = await sealValue({ a: 1 }, PASSPHRASE, FAST_KDF);
        await expect(openSealed(sealed, "wrong")).rejects.toBeInstanceOf(AtRestDecryptionError);
    });

    // Domain separation: an envelope and a keyed store record are different things sealed with the
    // same primitive. Without distinct associated data a record's ciphertext could be presented as
    // an envelope (and vice versa) under the same passphrase, since neither says what it is.
    it("not open an envelope whose ciphertext was sealed under different associated data", async () => {
        const sealed = await sealValue({ a: 1 }, PASSPHRASE, FAST_KDF);
        const key = await deriveAtRestKey(
            passphraseToBytes(PASSPHRASE),
            hexToBytes(sealed.salt.slice(2)),
            sealed.kdf,
        );
        // Same key, same plaintext — only the AAD differs, standing in for a store record.
        const foreign: SealedEnvelope = {
            ...sealed,
            ciphertext: aeadEncrypt(
                key,
                utf8ToBytes(JSON.stringify({ a: 1 })),
                atRestRecordAad("ppv2-enc", 1, "1:notes:alice"),
            ),
        };

        await expect(openSealed(foreign, PASSPHRASE)).rejects.toBeInstanceOf(AtRestDecryptionError);
    });

    it("throw AtRestDecryptionError when the ciphertext is tampered with", async () => {
        const sealed = await sealValue({ a: 1 }, PASSPHRASE, FAST_KDF);
        const ct = sealed.ciphertext;
        const tampered: SealedEnvelope = {
            ...sealed,
            ciphertext: (ct.slice(0, -2) + (ct.slice(-2) === "00" ? "01" : "00")) as `0x${string}`,
        };
        await expect(openSealed(tampered, PASSPHRASE)).rejects.toBeInstanceOf(
            AtRestDecryptionError,
        );
    });

    it("reject an empty passphrase", async () => {
        await expect(sealValue({ a: 1 }, "", FAST_KDF)).rejects.toBeInstanceOf(
            InvalidAtRestPassphrase,
        );
    });

    it("throw InvalidEncryptedRecord for a malformed envelope", async () => {
        const bad = { v: 1, salt: "0x00" } as unknown as SealedEnvelope;
        await expect(openSealed(bad, PASSPHRASE)).rejects.toBeInstanceOf(InvalidEncryptedRecord);
    });

    it("throw InvalidEncryptedRecord for an envelope with an out-of-range scrypt N (OOM guard)", async () => {
        // A hostile envelope with N = 2^30 would OOM the process on open; the bounds guard
        // must reject it before scrypt runs, rather than attempt the ~1 TiB working set.
        const sealed = await sealValue({ a: 1 }, PASSPHRASE, FAST_KDF);
        const hostile: SealedEnvelope = { ...sealed, kdf: { ...sealed.kdf, N: 1 << 30 } };
        await expect(openSealed(hostile, PASSPHRASE)).rejects.toBeInstanceOf(
            InvalidEncryptedRecord,
        );
    });
});
