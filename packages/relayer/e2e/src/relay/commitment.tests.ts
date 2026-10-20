import request from "supertest";
import { it, expect } from "vitest";
import { getQuoteEndpoint, getRelayEndpoint } from "../utils";

const BASE_URL = process.env.RELAYER_URL!;
const CHAIN_ID = process.env.TEST_CHAIN_ID!;
const CHAIN_TYPE = process.env.TEST_CHAIN_TYPE!;
const V = process.env.API_VERSION!;

const RELAY_ENDPOINT = getRelayEndpoint(V, CHAIN_TYPE, CHAIN_ID);
const QUOTE_ENDPOINT = getQuoteEndpoint(V, CHAIN_TYPE, CHAIN_ID);

const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const AMOUNT = "1000000000000000000";

const ZERO = "0";
const INPUT_N = 2;
const OUTPUT_M = 2;

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

function makePublicSignals(inputN: number, outputM: number): string[] {
    return Array(inputN + outputM + 6).fill(ZERO);
}

/** Get a real signed withdrawal fee commitment from the quote endpoint */
async function getWithdrawalCommitment() {
    const res = await request(BASE_URL)
        .post(`${QUOTE_ENDPOINT}/send`)
        .send({
            asset: ETH_ADDRESS,
            amount: AMOUNT,
            extraGas: false,
            recipient: RECIPIENT,
            commit: true,
        })
        .set("Content-Type", "application/json")
        .expect(201);

    return res.body.feeCommitment;
}

/** Get a real signed transfer fee commitment from the quote endpoint */
async function getTransferCommitment() {
    const res = await request(BASE_URL)
        .post(`${QUOTE_ENDPOINT}/transfer`)
        .send({
            asset: ETH_ADDRESS,
            commit: true,
        })
        .set("Content-Type", "application/json")
        .expect(201);

    return res.body.feeCommitment;
}

export function commitmentTests() {
    it("rejects withdrawal with tampered signedFeeCommitment (bad signature)", async () => {
        const commitment = await getWithdrawalCommitment();

        // Tamper with the signature — flip a hex character
        const sig = commitment.signedRelayerCommitment as string;
        const lastChar = sig[sig.length - 1];
        const tampered = sig.slice(0, -1) + (lastChar === "0" ? "1" : "0");

        const body = {
            proof: {
                ...validProof,
                publicSignals: makePublicSignals(INPUT_N, OUTPUT_M),
            },
            inputNullifierNumber: INPUT_N,
            outputCommitmentNumber: OUTPUT_M,
            noteData: [{ hint: "0xdead", data: "0xbeef" }],
            signedFeeCommitment: {
                ...commitment,
                signedRelayerCommitment: tampered,
            },
        };

        const res = await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json");

        // Should fail with 400 (commitment verification), not 500
        expect(res.status).toBeLessThan(500);
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("rejects withdrawal with expired fee commitment", async () => {
        const commitment = await getWithdrawalCommitment();

        // Set expiration to the past
        const body = {
            proof: {
                ...validProof,
                publicSignals: makePublicSignals(INPUT_N, OUTPUT_M),
            },
            inputNullifierNumber: INPUT_N,
            outputCommitmentNumber: OUTPUT_M,
            noteData: [{ hint: "0xdead", data: "0xbeef" }],
            signedFeeCommitment: {
                ...commitment,
                expiration: 1000, // Unix timestamp in the past
            },
        };

        const res = await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/withdrawal`)
            .send(body)
            .set("Content-Type", "application/json");

        // Tampered expiration should invalidate the signature
        expect(res.status).toBeLessThan(500);
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("rejects transfer with tampered signedFeeCommitment (bad signature)", async () => {
        const commitment = await getTransferCommitment();

        // Tamper with the signature
        const sig = commitment.signedRelayerCommitment as string;
        const lastChar = sig[sig.length - 1];
        const tampered = sig.slice(0, -1) + (lastChar === "0" ? "1" : "0");

        const body = {
            proof: {
                ...validProof,
                publicSignals: makePublicSignals(INPUT_N, OUTPUT_M),
            },
            inputNullifierNumber: INPUT_N,
            outputCommitmentNumber: OUTPUT_M,
            noteData: [{ hint: "0xdead", data: "0xbeef" }],
            signedFeeCommitment: {
                ...commitment,
                signedRelayerCommitment: tampered,
            },
        };

        const res = await request(BASE_URL)
            .post(`${RELAY_ENDPOINT}/transfer`)
            .send(body)
            .set("Content-Type", "application/json");

        // Should fail with 400 (commitment verification), not 500
        expect(res.status).toBeLessThan(500);
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
}
