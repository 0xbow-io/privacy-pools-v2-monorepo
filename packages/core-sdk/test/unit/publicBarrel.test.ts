import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Deliberate exception to the "all imports via internal.js" rule (SDK CLAUDE.md §1): the whole
// purpose of this file is to assert what the PUBLIC barrel exposes, so it must import from
// `external.js` — going through `internal.js` would test the wrong thing and pass regardless.
import * as publicBarrel from "../../src/external.js";
import {
    AtRestDecryptionError,
    BuildTransactWitnessInputsSchema,
    bytesToBigIntBE,
    cliffOverlap,
    cohortBpsAt,
    COMMITMENT_LEAF_TAG,
    computePoints,
    DEFAULT_REQUEST_EXPIRY_MS,
    EMPTY_NOTE_DATA,
    EncryptedStorageBaseError,
    EncryptedStorageService,
    epochParamsFromRateLeaves,
    HttpPointsDataProvider,
    InvalidAtRestPassphrase,
    InvalidEncryptedRecord,
    InvalidPaymentRequestParams,
    InvalidPaymentRequestState,
    InvalidPointsDataProviderConfig,
    InvalidPointsEpochParams,
    InvalidPointsInput,
    KEYSTORE_WRITE_ABI,
    liveEpochParams,
    MAX_INPUTS,
    NativeDestinationDepositUnsupported,
    notePointsForEpoch,
    PaymentRequestBaseError,
    PaymentRequestExpired,
    PaymentRequestNotFoundError,
    PendingNoteSchema,
    POINTS_COHORT_EDGE_SENTINEL,
    POINTS_DECIMALS,
    PointsBaseError,
    PointsDataUnavailable,
    PoolSessionTransactBaseError,
    SCAN_EXPIRY_GRACE_MS,
    sleep,
} from "../../src/external.js";

/**
 * `external.ts` ends with `export type * from "./internal.js"`, which silently makes every
 * symbol that is not ALSO named in an explicit value export **type-only**: it type-checks at
 * every call site, then is `undefined` at runtime. The failure surfaces only in a consumer, as
 * an `instanceof` that is always false or a constant that reads `undefined` — never here.
 *
 * That trap has been hit repeatedly in this package (FEATURE_BEST_PRACTICES B-2 records three
 * separate instances: BatchWithdrawOrchestrator, the PAYOUT_ROUTING ABIs, and all six
 * BatchWithdraw error classes). This suite is the standing guard, so the next one is caught by
 * CI rather than by an integrator.
 *
 * The import statement above is itself half the test — under `export type *` alone, naming
 * these in a value import does not compile. The assertions below cover the rest.
 */
describe("public barrel runtime exports", () => {
    describe("payment-request errors", () => {
        // Value-exported so a caller can discriminate. This is what makes SDK-side expiry
        // enforcement useful at all: without it, "this link lapsed, ask for a new one" is
        // indistinguishable from a validation failure.
        it("expose every payment-request error as a runtime constructor", () => {
            for (const ctor of [
                PaymentRequestBaseError,
                InvalidPaymentRequestParams,
                PaymentRequestNotFoundError,
                InvalidPaymentRequestState,
                PaymentRequestExpired,
            ]) {
                expect(typeof ctor).toBe("function");
            }
        });

        it("make PaymentRequestExpired instanceof-able against both its base and Error", () => {
            const error = new PaymentRequestExpired("0x3e8", 1000n);
            expect(error).toBeInstanceOf(PaymentRequestExpired);
            expect(error).toBeInstanceOf(PaymentRequestBaseError);
            expect(error).toBeInstanceOf(Error);
        });
    });

    describe("at-rest storage errors", () => {
        // A caller opening an encrypted store has to tell a wrong passphrase (retryable, prompt
        // again) from a tampered or transplanted record (not retryable).
        it("expose every at-rest error as a runtime constructor", () => {
            for (const ctor of [
                EncryptedStorageBaseError,
                InvalidAtRestPassphrase,
                AtRestDecryptionError,
                InvalidEncryptedRecord,
            ]) {
                expect(typeof ctor).toBe("function");
            }
        });

        it("make AtRestDecryptionError instanceof-able against its base", () => {
            const error = new AtRestDecryptionError("tag mismatch");
            expect(error).toBeInstanceOf(AtRestDecryptionError);
            expect(error).toBeInstanceOf(EncryptedStorageBaseError);
        });
    });

    describe("payment-request time bounds", () => {
        it("expose both bounds as runtime numbers", () => {
            expect(DEFAULT_REQUEST_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000);
            expect(SCAN_EXPIRY_GRACE_MS).toBe(24 * 60 * 60 * 1000);
        });

        // The asymmetry is load-bearing, not incidental: the recipient's scan window must
        // outlast the sender's deadline, or a payment that was legitimate when submitted can
        // land outside the scan set. Equal values would silently reintroduce that gap.
        it("keep the recipient scan window strictly longer than the sender deadline", () => {
            expect(SCAN_EXPIRY_GRACE_MS).toBeGreaterThan(0);
        });
    });

    // A representative sample spanning every category this exact bug hit during the
    // core-sdk/evm-sdk/stellar-sdk split (2026-09): a symbol declared in the bundled .d.ts
    // (so tsc resolves it fine at every call site) but absent from the runtime `export {...}`
    // in the bundled .js, because external.ts's `export type * from "./internal.js"` catch-all
    // only ever makes a symbol TYPE-only unless it's also named in an explicit value export
    // above. One per error/constant/schema/service/util category — not exhaustive (189 error
    // classes alone), but enough that a regression in the curation pattern itself fails here
    // instead of silently reaching a downstream package's test suite months later.
    describe("cross-category value exports (regression: type-only-by-omission)", () => {
        it("expose one error class from a non-payment-request/non-storage hierarchy", () => {
            expect(typeof EncryptedStorageService).toBe("function");
        });

        it("expose a witness-building domain-separation constant", () => {
            expect(COMMITMENT_LEAF_TAG).toMatch(/^0x[0-9a-f]+$/);
        });

        it("expose a keystore-write ABI constant", () => {
            expect(Array.isArray(KEYSTORE_WRITE_ABI)).toBe(true);
            expect(KEYSTORE_WRITE_ABI.length).toBeGreaterThan(0);
        });

        it("expose a transact-dimension bound constant", () => {
            expect(typeof MAX_INPUTS).toBe("number");
        });

        it("expose an EVM-default pre-built schema instance", () => {
            expect(typeof PendingNoteSchema.parse).toBe("function");
            expect(typeof BuildTransactWitnessInputsSchema.parse).toBe("function");
        });

        it("expose a utility function", () => {
            expect(typeof bytesToBigIntBE).toBe("function");
            expect(typeof sleep).toBe("function");
        });

        it("expose a sentinel object constant", () => {
            expect(EMPTY_NOTE_DATA).toBeDefined();
        });
    });

    describe("points", () => {
        it("expose the points functions, provider and constant at runtime", () => {
            for (const fn of [
                computePoints,
                notePointsForEpoch,
                cliffOverlap,
                cohortBpsAt,
                epochParamsFromRateLeaves,
                liveEpochParams,
                HttpPointsDataProvider,
            ]) {
                expect(typeof fn).toBe("function");
            }
            expect(POINTS_DECIMALS).toBe(18);
            expect(POINTS_COHORT_EDGE_SENTINEL).toBe(1n << 47n);
        });

        it("make every points error instanceof-able against its base", () => {
            for (const ctor of [
                InvalidPointsEpochParams,
                InvalidPointsInput,
                InvalidPointsDataProviderConfig,
                PointsDataUnavailable,
            ]) {
                const error = new ctor("x");
                expect(error).toBeInstanceOf(PointsBaseError);
                expect(error).toBeInstanceOf(Error);
            }
        });
    });

    // Thrown by PoolSessionSwapDeposit and PoolSessionReshieldCrosschain, but type-only until
    // 2026-10: a frontend's `instanceof` was always false, and evm-sdk's
    // `.rejects.toThrow(NativeDestinationDepositUnsupported)` assertions passed on any error.
    describe("cross-chain native-destination refusal", () => {
        it("make NativeDestinationDepositUnsupported instanceof-able against its base", () => {
            const error = new NativeDestinationDepositUnsupported("0x0", "1");
            expect(error).toBeInstanceOf(NativeDestinationDepositUnsupported);
            expect(error).toBeInstanceOf(PoolSessionTransactBaseError);
            expect(error).toBeInstanceOf(Error);
        });
    });

    // The exhaustive form of the cross-category sample above, for error classes only: every
    // class declared under src/errors/ must be a runtime export, so the next one left out of the
    // curated blocks in external.ts fails here rather than in a consumer.
    it("value-export every error class declared under src/errors/", () => {
        const errorsDir = fileURLToPath(new URL("../../src/errors/", import.meta.url));
        const declared = readdirSync(errorsDir)
            .filter((file) => file.endsWith(".ts"))
            .flatMap((file) =>
                [...readFileSync(join(errorsDir, file), "utf8").matchAll(/^export class (\w+)/gm)].flatMap(
                    (match) => match[1] ?? [],
                ),
            );
        const runtimeExports = publicBarrel as Record<string, unknown>;

        expect(declared.length).toBeGreaterThan(100);
        expect(declared.filter((name) => typeof runtimeExports[name] !== "function")).toEqual([]);
    });
});
