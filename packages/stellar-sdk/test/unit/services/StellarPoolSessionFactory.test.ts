import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import type {
    ITxReceiptWaiter,
    PoolSession,
    StellarAddress,
    StellarDeriveFromSignatureConfig,
    StellarLog,
    StellarPoolSessionConfig,
    StellarProof,
} from "../../../src/internal.js";
import { createStellarPoolSession, InvalidPoolSessionConfig } from "../../../src/internal.js";

const OWNER = Keypair.random().publicKey();
const CURRENT_CURSOR = "0xff";

/** Only sendTransaction-adjacent capability the generic core itself needs — see
 * ITxReceiptWaiter's own doc comment. Stellar's rpcInteractor structurally has no more than
 * this (no readContract/getBlockNumber/getLogsPaginated), which is fine since
 * PoolSessionNoteDiscovery now reads the current cursor from poolVaultInteractor instead. */
const rpcInteractor: ITxReceiptWaiter<StellarLog> = {
    waitForTransactionReceipt: vi.fn(),
};

const poolVaultInteractor = {
    getAddress: () => "CPOOLVAULT",
    getCurrentCursor: vi.fn(async () => CURRENT_CURSOR),
};

const noteManager = { getSyncCursor: () => CURRENT_CURSOR } as never;

function baseConfig(
    overrides: Partial<StellarPoolSessionConfig> = {},
): StellarPoolSessionConfig {
    const stub = {} as never;
    return {
        ownerAddress: OWNER,
        chainId: 1,
        networkPassphrase: "Test SDF Network ; September 2015",
        cryptoService: stub,
        witnessPreparationService: stub,
        proofService: stub,
        entrypointInteractor: stub,
        noteManager,
        keystoreManager: stub,
        keystoreInteractor: stub,
        hashService: stub,
        merkleService: stub,
        poolVaultInteractor,
        aspClient: stub,
        relayerInteractor: stub,
        aspDataProvider: stub,
        rpcInteractor,
        noteComputationService: stub,
        paymentRequestService: stub,
        ...overrides,
    } as unknown as StellarPoolSessionConfig;
}

describe("createStellarPoolSession", () => {
    it("construct a session end-to-end with only Stellar defaults", () => {
        const session: PoolSession<
            string,
            StellarAddress,
            StellarProof,
            StellarLog,
            unknown,
            StellarDeriveFromSignatureConfig
        > = createStellarPoolSession(baseConfig());
        expect(session.chainId).toBe(1);
    });

    it("reject a non-StrKey ownerAddress via the default StellarAddressSchema", () => {
        expect(() =>
            createStellarPoolSession(
                baseConfig({
                    ownerAddress: "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392" as StellarAddress,
                }),
            ),
        ).toThrow(InvalidPoolSessionConfig);
    });

    it("wire a working noteDiscovery — poolVaultInteractor.getCurrentCursor is enough, no EVM rpcInteractor needed", async () => {
        const session = createStellarPoolSession(baseConfig());

        const discovered = await session.discoverNotes();

        expect(discovered).toEqual([]);
        expect(poolVaultInteractor.getCurrentCursor).toHaveBeenCalled();
    });

    it("accept an explicit config override instead of the Stellar default", () => {
        const customVerifier = { assertMatches: vi.fn() };
        const session = createStellarPoolSession(
            baseConfig({ preparedTxVerifier: customVerifier as never }),
        );
        expect(session).toBeDefined();
    });
});
