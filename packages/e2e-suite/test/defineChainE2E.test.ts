import { describe, expect, it } from "vitest";

import type { ChainE2EDriver } from "../src/internal.js";
import { amountOf, defineChainE2E, need, randomProtocolKeys } from "../src/internal.js";

const base = { chainName: "fake" } as ChainE2EDriver;
const allUnsupported = {
    relayer: "no relayer",
    registerAndWithdraw: "no relayer",
    keyRotation: "n/a",
    token: "n/a",
    paymentRequests: "n/a",
    yield: "n/a",
    yieldNative: "n/a",
    yieldToken: "n/a",
} as const;

describe("defineChainE2E", () => {
    it("report the reason a capability is opted out and undefined for the rest", () => {
        const chain = defineChainE2E({
            name: "fake",
            enabled: true,
            unsupported: { token: "no second asset", yield: "no yield deployment", yieldNative: "n/a", yieldToken: "n/a" },
            // `token` and the yield capabilities are opted out, so only the other capabilities' members are required.
            createDriver: () =>
                Object.assign(base, {
                    relayerUrl: "http://127.0.0.1:1",
                    relayedSession: async () => ({}) as never,
                    withdrawalQuote: async () => ({}) as never,
                    rerouteFeeCommitment: (data: `0x${string}`) => data,
                    sendUnrelatedTransaction: async () => "0x" as const,
                    verifyRelayedRegistration: async () => true,
                    drainedNativeBalance: 0n,
                    keysAtIndex: () => randomProtocolKeys(),
                }),
        });

        expect(chain.unsupportedReason("token")).toBe("no second asset");
        expect(chain.unsupportedReason("relayer")).toBeUndefined();
    });

    it("create the driver once, on first use", async () => {
        let created = 0;
        const chain = defineChainE2E({
            name: "fake",
            enabled: true,
            unsupported: allUnsupported,
            createDriver: () => {
                created += 1;
                return base;
            },
        });

        expect(created).toBe(0);
        const [a, b] = await Promise.all([chain.driver(), chain.driver()]);

        expect(a).toBe(b);
        expect(created).toBe(1);
    });

    it("refuse at compile time a chain that claims a capability without its driver members", () => {
        // @ts-expect-error — supports everything (`unsupported: {}`) but provides no capability members
        defineChainE2E({ name: "fake", enabled: false, unsupported: {}, createDriver: () => base });
    });
});

describe("need", () => {
    it("return the driver when the capability's members are present", () => {
        const driver = Object.assign({ ...base }, { keysAtIndex: () => randomProtocolKeys() });

        expect(need(driver, "keyRotation")).toBe(driver);
    });

    it("throw naming the missing member and the capability to opt out of", () => {
        expect(() => need(base, "keyRotation")).toThrow(/does not provide 'keysAtIndex'.*'keyRotation'/);
    });

    it("require nothing for a capability that owns no members", () => {
        expect(need(base, "paymentRequests")).toBe(base);
    });
});

describe("amountOf", () => {
    it("scale suite units into the asset's base units as the Hex the session API takes", () => {
        const asset = { id: "x", symbol: "X", unit: 1_000n, minDeposit: 1n, dust: 1n };

        expect(BigInt(amountOf(asset, 20))).toBe(20_000n);
    });
});

describe("randomProtocolKeys", () => {
    it("generate distinct keys with an X25519 viewing public key on every call", () => {
        const a = randomProtocolKeys();
        const b = randomProtocolKeys();

        expect(a.viewingPrivateKey).not.toBe(b.viewingPrivateKey);
        expect(a.viewingPublicKey).toMatch(/^0x[0-9a-f]{64}$/);
        expect(a.revocableKeyIndex).toBe("0x0");
    });
});
