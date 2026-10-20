import { zEvmRelayWithdrawalRequest } from "../relay/evm/schemas";

// Example proof in snarkjs format (as received from the SDK - hex strings)
const exampleSnarkjsProof = {
    pi_a: ["0x1", "0x2", "0x1"],
    pi_b: [
        ["0x2", "0x1"], // Elements are swapped during transform to get [1n, 2n]
        ["0x2", "0x1"],
        ["0x1", "0x0"],
    ],
    pi_c: ["0x1", "0x2", "0x1"],
    publicSignals: ["0x1234", "0x5678", "0x1", "0x2", "0x3", "0x4", "0x5", "0x6"],
};

const exampleRelayWithdrawalInput = {
    proof: exampleSnarkjsProof,
    inputNullifierNumber: 1,
    outputCommitmentNumber: 1,
    noteData: [
        {
            hint: "0x0000000000000000000000000000000000000000000000000000000000000001",
            data: "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000000",
        },
    ],
    signedFeeCommitment: {
        data: "0x01",
        asset: "0x0000000000000000000000000000000000000000",
        expiration: 9999999999,
        feeAmount: "100",
        recipient: "0x0000000000000000000000000000000000000001",
        amountSent: "10000",
        amountReceived: "9900",
        extraGas: false,
        signedRelayerCommitment: "0xdeadbeef",
    },
};

describe("Mock SDK Service", () => {
    it("Is able to parse and transform a snarkjs proof payload", () => {
        const parsed = zEvmRelayWithdrawalRequest.parse(exampleRelayWithdrawalInput);

        // Verify the transform produced the expected internal format
        expect(parsed.proof.pA[0]).toBe(1n);
        expect(parsed.proof.pA[1]).toBe(2n);

        // Verify pi_b elements were swapped correctly
        expect(parsed.proof.pB[0][0]).toBe(1n);
        expect(parsed.proof.pB[0][1]).toBe(2n);

        // Verify pC
        expect(parsed.proof.pC[0]).toBe(1n);
        expect(parsed.proof.pC[1]).toBe(2n);

        // Verify pubSignals were reshaped: [nullifiers, commitments, ...scalars]
        expect(parsed.proof.pubSignals[0]).toEqual([0x1234n]); // nullifiers
        expect(parsed.proof.pubSignals[1]).toEqual([0x5678n]); // commitments

        // Verify parsedPubSignals was computed from reshaped signals
        expect(parsed.proof.parsedPubSignals.nullifierHashes).toEqual(["0x1234"]);
        expect(parsed.proof.parsedPubSignals.outputCommitments).toEqual(["0x5678"]);
        expect(parsed.proof.parsedPubSignals.stateRoot).toBe("0x1");
        expect(parsed.proof.parsedPubSignals.keyRegistryRoot).toBe("0x2");
    });
});
