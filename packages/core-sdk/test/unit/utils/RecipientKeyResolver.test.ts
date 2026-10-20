import { describe, expect, it, vi } from "vitest";

import type { Address, Hex, IKeystoreInteractor } from "../../../src/internal.js";
import { resolveRecipientViewingKey } from "../../../src/internal.js";

const RECIPIENT = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const NONZERO_VIEWING_KEY =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const ZERO_VIEWING_KEY =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

function createMockKeystoreInteractor(viewingKey: Hex): IKeystoreInteractor {
    return {
        getViewingKey: vi.fn(async () => viewingKey),
    } as unknown as IKeystoreInteractor;
}

class TestUnregisteredError extends Error {
    constructor(evmAddress: Address) {
        super(`unregistered: ${evmAddress}`);
        this.name = "TestUnregisteredError";
    }
}

describe("resolveRecipientViewingKey", () => {
    it("resolve to discoverable when the keystore returns a nonzero viewing key", async () => {
        const keystoreInteractor = createMockKeystoreInteractor(NONZERO_VIEWING_KEY);

        const result = await resolveRecipientViewingKey(RECIPIENT, keystoreInteractor, {
            onUnregistered: (evmAddress) => new TestUnregisteredError(evmAddress),
        });

        expect(result).toEqual({ kind: "discoverable", publicViewingKey: NONZERO_VIEWING_KEY });
        expect(keystoreInteractor.getViewingKey).toHaveBeenCalledWith(RECIPIENT);
    });

    it("throw the caller-supplied error when unregistered and fallback is not opted in", async () => {
        const keystoreInteractor = createMockKeystoreInteractor(ZERO_VIEWING_KEY);

        await expect(
            resolveRecipientViewingKey(RECIPIENT, keystoreInteractor, {
                onUnregistered: (evmAddress) => new TestUnregisteredError(evmAddress),
            }),
        ).rejects.toThrow(TestUnregisteredError);
    });

    it("fall back to outOfBand when unregistered and allowOutOfBandFallback is set", async () => {
        const keystoreInteractor = createMockKeystoreInteractor(ZERO_VIEWING_KEY);

        const result = await resolveRecipientViewingKey(RECIPIENT, keystoreInteractor, {
            allowOutOfBandFallback: true,
            onUnregistered: (evmAddress) => new TestUnregisteredError(evmAddress),
        });

        expect(result).toEqual({ kind: "outOfBand" });
    });

    it("propagate keystore RPC errors instead of falling back", async () => {
        const failingKeystore = {
            getViewingKey: vi.fn(async () => {
                throw new Error("RPC unreachable");
            }),
        } as unknown as IKeystoreInteractor;

        await expect(
            resolveRecipientViewingKey(RECIPIENT, failingKeystore, {
                allowOutOfBandFallback: true,
                onUnregistered: (evmAddress) => new TestUnregisteredError(evmAddress),
            }),
        ).rejects.toThrow("RPC unreachable");
    });
});
