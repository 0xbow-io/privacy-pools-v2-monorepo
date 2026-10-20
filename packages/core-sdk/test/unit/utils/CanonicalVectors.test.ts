import { x25519 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
    AUTH0_REVOCABLE_PREFIX,
    clampToCurve25519,
    IDENTITY_DOMAIN,
    NULLIFYING_INFO,
    PROTOCOL_SALT,
    u64beCounter,
    VIEWING_DOMAIN,
    VIEWING_KEY_INFO,
} from "../../../src/internal.js";

/**
 * Canonical zero-appSecret derivation vectors. Pin the exact byte output of every
 * step in the layered HKDF tree so cross-platform SDK implementations
 * (TypeScript / Rust / Go / Python) must match before deployment.
 *
 * Inputs:
 *   appSecret = 0x00 × 32
 *   salt      = "PP_V2"
 *   counter0  = 0x00 × 8 (u64 BE)
 */
describe("Canonical key-derivation vectors (zero appSecret)", () => {
    const appSecret = new Uint8Array(32);
    const salt = utf8ToBytes(PROTOCOL_SALT);
    const counter0 = u64beCounter(0n);

    // Layer 1: Extract
    const masterPRK = extract(sha256, appSecret, salt);
    // Layer 2: domain PRKs
    const identityPRK = expand(sha256, masterPRK, utf8ToBytes(IDENTITY_DOMAIN), 32);
    const viewingPRK = expand(sha256, masterPRK, utf8ToBytes(VIEWING_DOMAIN), 32);
    const secretsPRK = expand(sha256, masterPRK, utf8ToBytes("SECRETS"), 32);
    // Layer 3: functional keys
    const nullifyingKeyBytes = expand(sha256, identityPRK, utf8ToBytes(NULLIFYING_INFO), 48);
    const revocableInfo = new Uint8Array([...utf8ToBytes(AUTH0_REVOCABLE_PREFIX), ...counter0]);
    const revocableKeyBytes_0 = expand(sha256, identityPRK, revocableInfo, 48);
    const viewingKeyBytes = expand(sha256, viewingPRK, utf8ToBytes(VIEWING_KEY_INFO), 32);
    const depositInfo = new Uint8Array([...utf8ToBytes("DEPOSIT"), ...counter0]);
    const depositSecretBytes_0 = expand(sha256, secretsPRK, depositInfo, 48);
    const noteInfo = new Uint8Array([...utf8ToBytes("NOTE"), ...counter0]);
    const noteSecretBytes_0 = expand(sha256, secretsPRK, noteInfo, 48);

    it("masterPRK matches the canonical vector", () => {
        expect(bytesToHex(masterPRK)).toBe(
            "2db406d59cb3fdb9676d54da4b64559dffd6b70fa8f8af58ac92fc9edf0b9bdd",
        );
    });

    it("identityPRK matches the canonical vector", () => {
        expect(bytesToHex(identityPRK)).toBe(
            "44a74e3bd71b6febf0fb6892de37cbb43d81d171d79fbc8ff8bbcb215a5c1cfc",
        );
    });

    it("viewingPRK matches the canonical vector", () => {
        expect(bytesToHex(viewingPRK)).toBe(
            "aafaf7afbf9dea80415621dfae7bc2d85cb6cfb02bbfb1e8050df08c95a5b6db",
        );
    });

    it("secretsPRK matches the canonical vector", () => {
        expect(bytesToHex(secretsPRK)).toBe(
            "91d047e883d78a7d18302a803d2c5ca9e7810a94632539fa0762537146680e8a",
        );
    });

    it("nullifyingKeyBytes (raw 48-byte HKDF output) matches the canonical vector", () => {
        expect(bytesToHex(nullifyingKeyBytes)).toBe(
            "449ba63772fa5a3f15fbf739a358a60b6dd53656bc7547ace099e4664747f40024a186aca416c5d1374ea93fbf10f05d",
        );
    });

    it("revocableKeyBytes_0 (raw 48-byte HKDF output at rotation index 0) matches the canonical vector", () => {
        expect(bytesToHex(revocableKeyBytes_0)).toBe(
            "6cd080868930ad307b713b285081a31857361a9faab3f5fbe3e7821d60ce32f8f4eb44b97f42806200058f29e77dce3c",
        );
    });

    it("viewingKeyBytes (raw 32-byte HKDF output, pre-clamp) matches the canonical vector", () => {
        expect(bytesToHex(viewingKeyBytes)).toBe(
            "7ba3c140021b78569081c42f4ae3f9ea8ab36d9c83c043069d8d5e1093911241",
        );
    });

    it("clamped viewingPrivateKey (post-RFC-7748 clamp) matches the canonical vector", () => {
        const clamped = clampToCurve25519(viewingKeyBytes);
        expect(clamped).toBe("0x78a3c140021b78569081c42f4ae3f9ea8ab36d9c83c043069d8d5e1093911241");
    });

    it("X25519 viewingPublicKey (basepoint mul of clamped scalar) matches the canonical vector", () => {
        const clamped = clampToCurve25519(viewingKeyBytes);
        const clampedBytes = new Uint8Array(32);
        const hex = clamped.slice(2);
        for (let i = 0; i < 32; i++) {
            clampedBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        const pub = x25519.getPublicKey(clampedBytes);
        expect(bytesToHex(pub)).toBe(
            "5a848d40bcd1b702a072eea9c9720816d3f880ac4c2557a1b6a59b1c502cf076",
        );
    });

    it("depositSecretBytes_0 (raw 48-byte HKDF output) matches the canonical vector", () => {
        expect(bytesToHex(depositSecretBytes_0)).toBe(
            "b77cb86790763ab50fe3f957cbdd1cc53513fa9939c89d85eee722c021695e39f7d1e455719380714076ff93095295b7",
        );
    });

    it("noteSecretBytes_0 (raw 48-byte HKDF output) matches the canonical vector", () => {
        expect(bytesToHex(noteSecretBytes_0)).toBe(
            "d49653016111279af15935d14c6905d36649b3bd92459a73a2d4e4702ad998caf072b93e5795f99a8748c8fc2e4d4039",
        );
    });
});
