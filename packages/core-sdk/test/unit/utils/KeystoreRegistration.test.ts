import { describe, expect, it, vi } from "vitest";

import type { Hash, IKeystoreInteractor } from "../../../src/internal.js";
import {
    assertKeystoreRegistered,
    ContractCallError,
    isKeystoreRegisteredOnChain,
    KeystoreNotRegistered,
    RegistrationCheckFailed,
} from "../../../src/internal.js";

const OWNER = "0x1234567890abcdef1234567890abcdef12345678";
const REGISTERED = ("0x" + "ab".repeat(32)) as Hash;

function keystoreReturning(read: () => Promise<Hash>): IKeystoreInteractor<unknown, string> {
    return { getNullifyingKeyHash: vi.fn(read) } as unknown as IKeystoreInteractor<unknown, string>;
}

describe("isKeystoreRegisteredOnChain", () => {
    it("return true when a nullifying-key hash is stored for the account", async () => {
        const keystore = keystoreReturning(() => Promise.resolve(REGISTERED));

        expect(await isKeystoreRegisteredOnChain(keystore, OWNER)).toBe(true);
    });

    it("return false for the zero sentinel in short form", async () => {
        const keystore = keystoreReturning(() => Promise.resolve("0x0" as Hash));

        expect(await isKeystoreRegisteredOnChain(keystore, OWNER)).toBe(false);
    });

    it("return false for the zero sentinel in full 32-byte form", async () => {
        const keystore = keystoreReturning(() => Promise.resolve(("0x" + "00".repeat(32)) as Hash));

        expect(await isKeystoreRegisteredOnChain(keystore, OWNER)).toBe(false);
    });

    it("query the given account", async () => {
        const keystore = keystoreReturning(() => Promise.resolve(REGISTERED));

        await isKeystoreRegisteredOnChain(keystore, OWNER);

        expect(keystore.getNullifyingKeyHash).toHaveBeenCalledWith(OWNER);
    });

    it("wrap a contract-interactor failure in RegistrationCheckFailed", async () => {
        const keystore = keystoreReturning(() => Promise.reject(new ContractCallError("revert")));

        await expect(isKeystoreRegisteredOnChain(keystore, OWNER)).rejects.toThrow(RegistrationCheckFailed);
    });

    it("wrap an arbitrary failure in RegistrationCheckFailed and keep its message", async () => {
        const keystore = keystoreReturning(() => Promise.reject(new Error("socket hang up")));

        await expect(isKeystoreRegisteredOnChain(keystore, OWNER)).rejects.toThrow(/socket hang up/);
    });

    it("wrap a non-Error rejection in RegistrationCheckFailed", async () => {
        const keystore = keystoreReturning(() => Promise.reject("boom"));

        await expect(isKeystoreRegisteredOnChain(keystore, OWNER)).rejects.toThrow(RegistrationCheckFailed);
    });
});

describe("assertKeystoreRegistered", () => {
    it("resolve for a registered account", async () => {
        const keystore = keystoreReturning(() => Promise.resolve(REGISTERED));

        await expect(assertKeystoreRegistered(keystore, OWNER)).resolves.toBeUndefined();
    });

    it("throw KeystoreNotRegistered naming the account when nothing is registered", async () => {
        const keystore = keystoreReturning(() => Promise.resolve("0x0" as Hash));

        await expect(assertKeystoreRegistered(keystore, OWNER)).rejects.toThrow(KeystoreNotRegistered);
        await expect(assertKeystoreRegistered(keystore, OWNER)).rejects.toThrow(OWNER);
    });

    it("let a failed read surface as RegistrationCheckFailed, not as not-registered", async () => {
        const keystore = keystoreReturning(() => Promise.reject(new Error("rpc down")));

        await expect(assertKeystoreRegistered(keystore, OWNER)).rejects.toThrow(RegistrationCheckFailed);
    });
});
