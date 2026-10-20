import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { buildKeyDerivationTransaction } from "../../../src/internal.js";

const OWNER = Keypair.random().publicKey();
const NETWORK = "Test SDF Network ; September 2015";

describe("buildKeyDerivationTransaction", () => {
    it("build the identical transaction XDR for the same owner and network every time", () => {
        const a = buildKeyDerivationTransaction(OWNER, NETWORK).toXDR();
        const b = buildKeyDerivationTransaction(OWNER, NETWORK).toXDR();
        expect(a).toBe(b);
    });

    it("build a different transaction for a different owner", () => {
        const other = Keypair.random().publicKey();
        const a = buildKeyDerivationTransaction(OWNER, NETWORK).toXDR();
        const b = buildKeyDerivationTransaction(other, NETWORK).toXDR();
        expect(a).not.toBe(b);
    });

    it("produce a different signed hash for a different network", () => {
        const a = buildKeyDerivationTransaction(OWNER, NETWORK).hash();
        const b = buildKeyDerivationTransaction(OWNER, "Public Global Stellar Network ; September 2015").hash();
        expect(a.equals(b)).toBe(false);
    });

    it("encode a single manage_data operation with the versioned key and no value", () => {
        const tx = buildKeyDerivationTransaction(OWNER, NETWORK);
        expect(tx.operations).toHaveLength(1);
        const op = tx.operations[0];
        expect(op.type).toBe("manageData");
        if (op.type === "manageData") {
            expect(op.name).toBe("pp:keyderiv:v1");
            expect(op.value).toBeNull();
        }
    });

    it("use a fixed sequence number, not tied to any real account state", () => {
        const tx = buildKeyDerivationTransaction(OWNER, NETWORK);
        expect(tx.sequence).toBe("1");
    });

    it("round-trip through XDR unchanged", () => {
        const tx = buildKeyDerivationTransaction(OWNER, NETWORK);
        const roundTripped = TransactionBuilder.fromXDR(tx.toXDR(), NETWORK);
        expect(roundTripped.toXDR()).toBe(tx.toXDR());
    });
});
