import request from "supertest";
import { it, expect } from "vitest";
import { getRelayEndpoint } from "../utils";

const BASE_URL = process.env.RELAYER_URL!;
const CHAIN_ID = process.env.TEST_CHAIN_ID!;
const CHAIN_TYPE = process.env.TEST_CHAIN_TYPE!;
const V = process.env.API_VERSION!;

const RELAY_ENDPOINT = getRelayEndpoint(V, CHAIN_TYPE, CHAIN_ID);

// A minimal valid snarkjs proof structure (values are garbage but structurally correct)
const ZERO = "0";

const pi_a = [ZERO, ZERO, ZERO];
const pi_b = [
    [ZERO, ZERO],
    [ZERO, ZERO],
    [ZERO, ZERO],
];
const pi_c = [ZERO, ZERO, ZERO];

const validProof = {
    pi_a,
    pi_b,
    pi_c,
};

// Build publicSignals array for given N inputs + M outputs + 6 scalars
function makePublicSignals(inputN: number, outputM: number): string[] {
    return Array(inputN + outputM + 6).fill(ZERO);
}

const INPUT_N = 2;
const OUTPUT_M = 2;

// A structurally valid withdrawal request body (will fail at proof verification, not schema)
function makeValidWithdrawalBody(overrides: Record<string, unknown> = {}) {
    return {
        proof: {
            ...validProof,
            publicSignals: makePublicSignals(INPUT_N, OUTPUT_M),
        },
        inputNullifierNumber: INPUT_N,
        outputCommitmentNumber: OUTPUT_M,
        noteData: [{ hint: "0xdead", data: "0xbeef" }],
        ...overrides,
    };
}

// A structurally valid transfer request body (missing signedFeeCommitment intentionally for some tests)
function makeValidTransferBody(overrides: Record<string, unknown> = {}) {
    return {
        proof: {
            ...validProof,
            publicSignals: makePublicSignals(INPUT_N, OUTPUT_M),
        },
        inputNullifierNumber: INPUT_N,
        outputCommitmentNumber: OUTPUT_M,
        noteData: [{ hint: "0xdead", data: "0xbeef" }],
        ...overrides,
    };
}

export function validationTests() {
    // -========- Withdrawal schema tests -========-

    it("rejects withdrawal with empty body", async () => {
        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send({})
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with missing proof field", async () => {
        const body = makeValidWithdrawalBody();
        delete (body as Record<string, unknown>).proof;

        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with invalid proof format (missing pi_a)", async () => {
        const body = makeValidWithdrawalBody({
            proof: {
                pi_b: validProof.pi_b,
                pi_c: validProof.pi_c,
                publicSignals: makePublicSignals(INPUT_N, OUTPUT_M),
            },
        });

        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with invalid proof format (pi_a wrong length)", async () => {
        const body = makeValidWithdrawalBody({
            proof: {
                pi_a: [ZERO, ZERO], // needs 3 elements
                pi_b: validProof.pi_b,
                pi_c: validProof.pi_c,
                publicSignals: makePublicSignals(INPUT_N, OUTPUT_M),
            },
        });

        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with non-integer inputNullifierNumber", async () => {
        const body = makeValidWithdrawalBody({
            inputNullifierNumber: 1.5,
        });

        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with zero inputNullifierNumber", async () => {
        const body = makeValidWithdrawalBody({
            inputNullifierNumber: 0,
        });

        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with negative inputNullifierNumber", async () => {
        const body = makeValidWithdrawalBody({
            inputNullifierNumber: -1,
        });

        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with mismatched publicSignals length", async () => {
        // publicSignals length should be inputN + outputM + 6 = 10, but we send 8
        const body = makeValidWithdrawalBody({
            proof: {
                ...validProof,
                publicSignals: makePublicSignals(1, 1), // 1+1+6=8, but inputN=2, outputM=2 expects 10
            },
        });

        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with too few publicSignals (less than 8)", async () => {
        const body = makeValidWithdrawalBody({
            proof: {
                ...validProof,
                publicSignals: [ZERO, ZERO, ZERO], // min is 8
            },
        });

        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with no signedFeeCommitment", async () => {
        const body = makeValidWithdrawalBody();

        const res = await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);

        const responseText = JSON.stringify(res.body);
        expect(responseText).toContain("signedFeeCommitment");
    });

    // -========- Transfer schema tests -========-

    it("rejects transfer with empty body", async () => {
        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/transfer`)
            .send({})
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects transfer with no signedFeeCommitment", async () => {
        const body = makeValidTransferBody();

        const res = await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/transfer`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);

        const responseText = JSON.stringify(res.body);
        expect(responseText).toContain("signedFeeCommitment");
    });

    it("rejects transfer with missing proof field", async () => {
        const body = makeValidTransferBody();
        delete (body as Record<string, unknown>).proof;

        await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/transfer`)
            .send(body)
            .set("Content-Type", "application/json")
            .expect(400);
    });

    // -========- Route param validation -========-

    it("rejects withdrawal with invalid chainType", async () => {
        const badEndpoint = getRelayEndpoint(V, "invalidchain", CHAIN_ID);

        await request(BASE_URL)
            .post(`${badEndpoint}/withdrawal`)
            .send(makeValidWithdrawalBody())
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with invalid chainId", async () => {
        const badEndpoint = getRelayEndpoint(V, CHAIN_TYPE, "abc");

        await request(BASE_URL)
            .post(`${badEndpoint}/withdrawal`)
            .send(makeValidWithdrawalBody())
            .set("Content-Type", "application/json")
            .expect(400);
    });

    it("rejects withdrawal with nonexistent chainId", async () => {
        const badEndpoint = getRelayEndpoint(V, CHAIN_TYPE, "99999");

        await request(BASE_URL)
            .post(`${badEndpoint}/withdrawal`)
            .send(makeValidWithdrawalBody())
            .set("Content-Type", "application/json")
            .expect(400);
    });
}
