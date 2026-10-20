import {
    Account,
    BASE_FEE,
    Contract,
    Keypair,
    Networks,
    nativeToScVal,
    StrKey,
    TransactionBuilder,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { StellarPreparedTxVerifier, UnexpectedTransactionTarget } from "../../../src/internal.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const OTHER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 2));
const SOURCE = Keypair.random().publicKey();

function buildUnsignedXdr(contractId: string, method: string, args: unknown[] = []): string {
    const account = new Account(SOURCE, "1");
    const contract = new Contract(contractId);
    const scArgs = args.map((arg) =>
        typeof arg === "bigint" ? nativeToScVal(arg, { type: "u128" }) : nativeToScVal(arg),
    );
    return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
        .addOperation(contract.call(method, ...scArgs))
        .setTimeout(30)
        .build()
        .toXDR();
}

describe("StellarPreparedTxVerifier", () => {
    const verifier = new StellarPreparedTxVerifier({ networkPassphrase: Networks.TESTNET });

    describe("assertMatches", () => {
        it("verify a deposit transaction targeting the expected contract and function", () => {
            const tx = buildUnsignedXdr(CONTRACT_ID, "deposit", [42n]);
            const result = verifier.assertMatches(tx, { to: CONTRACT_ID, operation: "deposit" });
            expect(result.operation).toBe("deposit");
            expect(result.args).toEqual([42n]);
        });

        it("map each PreparedTxOperation to its Rust snake_case function name", () => {
            const cases: [string, string][] = [
                ["ragequit", "ragequit"],
                ["transact", "transact"],
                ["setAuthPolicy", "set_auth_policy"],
                ["setViewingKey", "set_viewing_key"],
                ["updateAuthPolicy", "update_auth_policy"],
            ];
            for (const [operation, rustName] of cases) {
                const tx = buildUnsignedXdr(CONTRACT_ID, rustName);
                const result = verifier.assertMatches(tx, {
                    to: CONTRACT_ID,
                    operation: operation as never,
                });
                expect(result.operation).toBe(operation);
            }
        });

        // Regression: update_auth_policy's Rust signature is (owner, old_digest, new_digest,
        // siblings) — one arg ahead of EVM's updateAuthPolicy(oldDigest, newDigest, siblings),
        // which has no owner param (implicit via msg.sender). PoolSessionKeystore.
        // executeRotateRevocableKey is shared core-sdk code that destructures `args`
        // positionally against EVM's shape, so the leading owner must be dropped here —
        // without it, args[1] (still `oldDigest`) was read as the NEW digest, and every
        // Stellar rotation failed RotationKeyMismatch.
        it("drop the leading owner arg for updateAuthPolicy so args match EVM's [oldDigest, newDigest, siblings]", () => {
            const tx = buildUnsignedXdr(CONTRACT_ID, "update_auth_policy", [SOURCE, 11n, 22n]);
            const result = verifier.assertMatches(tx, { to: CONTRACT_ID, operation: "updateAuthPolicy" });
            expect(result.args).toEqual([11n, 22n]);
        });

        it("keep every arg (including the leading owner) for every other operation", () => {
            const tx = buildUnsignedXdr(CONTRACT_ID, "deposit", [SOURCE, 42n]);
            const result = verifier.assertMatches(tx, { to: CONTRACT_ID, operation: "deposit" });
            expect(result.args).toEqual([SOURCE, 42n]);
        });

        it("reject a transaction targeting a different contract", () => {
            const tx = buildUnsignedXdr(OTHER_CONTRACT_ID, "deposit");
            expect(() =>
                verifier.assertMatches(tx, { to: CONTRACT_ID, operation: "deposit" }),
            ).toThrow(UnexpectedTransactionTarget);
        });

        it("reject a transaction calling a different function", () => {
            const tx = buildUnsignedXdr(CONTRACT_ID, "ragequit");
            expect(() =>
                verifier.assertMatches(tx, { to: CONTRACT_ID, operation: "deposit" }),
            ).toThrow(UnexpectedTransactionTarget);
        });

        it("reject the approve operation — Stellar has no allowance/approve concept", () => {
            const tx = buildUnsignedXdr(CONTRACT_ID, "deposit");
            expect(() =>
                verifier.assertMatches(tx, { to: CONTRACT_ID, operation: "approve" }),
            ).toThrow(UnexpectedTransactionTarget);
        });

        it("reject malformed XDR", () => {
            expect(() =>
                verifier.assertMatches("not-valid-xdr", { to: CONTRACT_ID, operation: "deposit" }),
            ).toThrow(UnexpectedTransactionTarget);
        });
    });
});
