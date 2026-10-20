import { MAX_BATCH } from "@privacy-pools-v2/core-sdk/batch-fee";
import { encodeBatchFeeSplit } from "./fee_abi";
import { zEvmRelayBatchRequest } from "./schemas";

// GAP-3(a): the SDK's `RelayerInteractor.relayBatchWithdrawal`
// (services/RelayerInteractor.ts:322-331) serializes each batch item by
// FLATTENING its proof — `{ ...item.proof.proof, publicSignals: item.proof.publicSignals }`
// — and POSTs `{ items, signedBatchFeeCommitment }` to `/relay/.../batch`. The
// relayer validates that body with `zEvmRelayBatchRequest`. Only `batch.e2e.ts`
// (non-fast, docker) crosses this seam in production.
//
// This spec reconstructs the EXACT post-flatten wire shape and drives it through
// the relayer's zod schema. (Running the live SDK serialization here is not
// possible: the SDK's built main entry pulls in `@noble/ciphers` ESM, which this
// package's jest config does not transform. The companion SDK-side test
// `RelayerInteractor.test.ts` asserts the SDK actually emits this shape, so the
// two together close the seam.)

const ASSET = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const FEE_RECIPIENT = "0xc1ebfda3114bc2496e86d466b3082491a96767df";

// A ProofResult as the SDK carries it internally: geometry nested under `proof`,
// publicSignals alongside. pi_a/pi_c are 3-tuples, pi_b is 3x2, publicSignals
// length = inputNullifierNumber (1) + outputCommitmentNumber (1) + 6 scalars = 8.
function makeSdkProofResult() {
    return {
        proof: {
            pi_a: ["0x01", "0x02", "0x03"],
            pi_b: [
                ["0x04", "0x05"],
                ["0x06", "0x07"],
                ["0x08", "0x09"],
            ],
            pi_c: ["0x0a", "0x0b", "0x0c"],
            protocol: "groth16",
            curve: "bn128",
        },
        publicSignals: ["0x11", "0x12", "0x13", "0x14", "0x15", "0x16", "0x17", "0x18"],
    };
}

// Mirrors the SDK's per-item flatten in relayBatchWithdrawal.
function serializeItem() {
    const pr = makeSdkProofResult();
    return {
        proof: { ...pr.proof, publicSignals: pr.publicSignals },
        noteData: [{ hint: "0x01", data: "0xabcdef" }],
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
    };
}

function makeCommitment() {
    return {
        data: encodeBatchFeeSplit([
            { recipient: RECIPIENT, feeRecipient: FEE_RECIPIENT, feeAmount: 10n, nativeGas: 0n },
        ]),
        asset: ASSET,
        expiration: Date.now() + 3_600_000,
        // Numeric fee-model fields arrive as strings on the wire (SDK
        // BatchFeeCommitment serializes them as strings).
        totalFee: "10",
        maxRelayFee: "100",
        relayCost: "0",
        feeBps: "0",
        flatFee: "0",
        signedRelayerCommitment: "0xdeadbeef",
    };
}

function makeBody(itemCount = 1) {
    return {
        items: Array.from({ length: itemCount }, () => serializeItem()),
        signedBatchFeeCommitment: makeCommitment(),
    };
}

describe("Batch relay wire shape — SDK serialization ↔ relayer zod schema", () => {
    it("parses an SDK-serialized batch relay body with zEvmRelayBatchRequest", () => {
        const body = makeBody(1);

        // Sanity: the item carries the FLATTENED proof (no nested `proof.proof`).
        expect(body.items[0].proof).toHaveProperty("pi_a");
        expect(body.items[0].proof).toHaveProperty("publicSignals");
        expect(body.items[0].proof).not.toHaveProperty("proof");

        const parsed = zEvmRelayBatchRequest.parse(body);
        expect(parsed.items).toHaveLength(1);
        // The schema reshaped the flat 8 signals into the 2D contract layout.
        expect(parsed.items[0].proof.parsedPubSignals).toBeDefined();
        expect(parsed.items[0].proof.pubSignals[0]).toHaveLength(1); // 1 nullifier
        expect(parsed.items[0].proof.pubSignals[1]).toHaveLength(1); // 1 commitment
    });

    it("parses a full MAX_BATCH-sized body", () => {
        const parsed = zEvmRelayBatchRequest.parse(makeBody(MAX_BATCH));
        expect(parsed.items).toHaveLength(MAX_BATCH);
    });

    it("rejects a body missing signedBatchFeeCommitment", () => {
        const body = makeBody(1) as Partial<ReturnType<typeof makeBody>>;
        delete body.signedBatchFeeCommitment;

        expect(() => zEvmRelayBatchRequest.parse(body)).toThrow();
    });

    it("rejects a body whose item has the wrong publicSignals length", () => {
        const body = makeBody(1);
        // Drop one signal -> 7 != 1 + 1 + 6. superRefine must reject.
        body.items[0].proof.publicSignals = body.items[0].proof.publicSignals.slice(0, 7);

        expect(() => zEvmRelayBatchRequest.parse(body)).toThrow(/publicSignals/);
    });

    it("rejects a malformed item missing proof geometry (pi_a)", () => {
        const body = makeBody(1);
        delete (body.items[0].proof as { pi_a?: unknown }).pi_a;

        expect(() => zEvmRelayBatchRequest.parse(body)).toThrow();
    });

    it(`rejects a body with more than MAX_BATCH (${MAX_BATCH}) items`, () => {
        expect(() => zEvmRelayBatchRequest.parse(makeBody(MAX_BATCH + 1))).toThrow();
    });
});
