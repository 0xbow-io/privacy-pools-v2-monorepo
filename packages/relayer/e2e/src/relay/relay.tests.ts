import { describe, beforeAll, beforeEach } from "vitest";
import { randomBytes } from "crypto";
import type { Suite, Task } from "vitest";
import type { Address } from "viem";
import { fetchWithRetry, getQuoteEndpoint, getRelayEndpoint } from "../utils";
import { E2EProofService } from "../proofs";
import type { RelayPayload } from "../proofs";
import { CIRCUIT_ARTIFACTS_DIR, RPC_URL, NATIVE_ASSET, RELAYER_SIGNER_ADDRESS } from "../proofs/config";
import { PoseidonHashService } from "@privacy-pools-v2/evm-sdk";
import {
    DEPOSITOR,
    WITHDRAWAL_RECIPIENTS,
    TRANSFER_RECIPIENTS,
} from "../test-addresses";
import { negativeTests } from "./negative.tests";
import { withdrawal1xMTests } from "./withdrawal.1xm.tests";
import { withdrawal2xMTests } from "./withdrawal.2xm.tests";
import { withdrawal3xMTests } from "./withdrawal.3xm.tests";
import { withdrawal4xMTests } from "./withdrawal.4xm.tests";
import { withdrawal5xMTests } from "./withdrawal.5xm.tests";
import { transfer1xMTests } from "./transfer.1xm.tests";
import { transfer2xMTests } from "./transfer.2xm.tests";
import { transfer3xMTests } from "./transfer.3xm.tests";
import { transfer4xMTests } from "./transfer.4xm.tests";
import { transfer5xMTests } from "./transfer.5xm.tests";
import { transferMultiTests } from "./transfer.multi.tests";
import { commitmentTests } from "./commitment.tests";
import { validationTests } from "./validation.tests";
import type { RelayContext } from "./context";
import type { AccountState } from "../proofs";

const BASE_URL = process.env.RELAYER_URL!;
const CHAIN_ID = process.env.TEST_CHAIN_ID!;
const CHAIN_TYPE = process.env.TEST_CHAIN_TYPE!;
const V = process.env.API_VERSION!;

const RELAY_ENDPOINT = getRelayEndpoint(V, CHAIN_TYPE, CHAIN_ID);
const TRANSFER_AMOUNT = "1000000000000000"; // 0.001 ETH
// Each account gets 0.002 ETH so it's enough for both withdrawal and transfer flows.
const DEPOSIT_VALUE = (BigInt(TRANSFER_AMOUNT) * 2n).toString();
// 6 accounts total — enough for:
//   - withdrawal 1xM..5xM (uses first N)
//   - transfer 1xM..3xM (uses first N)
//   - negative 6x1 (uses all 6, expected to fail at proof gen — no circuit)
const ACCOUNT_COUNT = 6;

// ── Proof pre-generation specs ──
// Withdrawal amounts by N (index N-1). Each account has 0.002 ETH.
// generateWithdrawalProof assigns ALL change outputs accounts[0].label, so the
// per-label conservation check requires changeValue <= accounts[0].value (0.002 ETH).
// We pick amounts so change = 0.001 ETH for every N (well under the 0.002 limit).
//   N=1: withdraw 0.001 from 0.002 total (change 0.001)
//   N=2: withdraw 0.003 from 0.004 total (change 0.001)
//   N=3: withdraw 0.005 from 0.006 total (change 0.001)
//   N=4: withdraw 0.007 from 0.008 total (change 0.001)
//   N=5: withdraw 0.009 from 0.010 total (change 0.001)
const W_AMOUNTS = [
    "1000000000000000", // N=1: 0.001
    "3000000000000000", // N=2: 0.003
    "5000000000000000", // N=3: 0.005
    "7000000000000000", // N=4: 0.007
    "9000000000000000", // N=5: 0.009
];

// Nx1 withdrawal recipients per N; NxM (M>1) all use WITHDRAWAL_RECIPIENTS[0]
const W_NX1_RECIPIENTS: Address[] = WITHDRAWAL_RECIPIENTS;

// Transfer proof specs — each spec lists one or more recipient outputs.
// Single-recipient specs have a 1-element array; multi-recipient specs have more.
interface TransferProofSpec {
    key: string;
    n: number;
    m: number;
    recipients: Array<{ amount: string; recipientIdx: number }>;
}

const TRANSFER_PROOF_SPECS: TransferProofSpec[] = [
    // ── Single-recipient (1 transfer output + change notes) ──
    // 1xM
    { key: "t-1x2", n: 1, m: 2, recipients: [{ amount: TRANSFER_AMOUNT, recipientIdx: 0 }] },
    { key: "t-1x3", n: 1, m: 3, recipients: [{ amount: TRANSFER_AMOUNT, recipientIdx: 0 }] },
    { key: "t-1x4", n: 1, m: 4, recipients: [{ amount: TRANSFER_AMOUNT, recipientIdx: 0 }] },
    { key: "t-1x5", n: 1, m: 5, recipients: [{ amount: TRANSFER_AMOUNT, recipientIdx: 0 }] },
    // 2xM
    { key: "t-2x2", n: 2, m: 2, recipients: [{ amount: (BigInt(TRANSFER_AMOUNT) * 2n).toString(), recipientIdx: 1 }] },
    { key: "t-2x3", n: 2, m: 3, recipients: [{ amount: TRANSFER_AMOUNT, recipientIdx: 1 }] },
    { key: "t-2x4", n: 2, m: 4, recipients: [{ amount: TRANSFER_AMOUNT, recipientIdx: 1 }] },
    { key: "t-2x5", n: 2, m: 5, recipients: [{ amount: TRANSFER_AMOUNT, recipientIdx: 1 }] },
    // 3xM
    { key: "t-3x3", n: 3, m: 3, recipients: [{ amount: (BigInt(TRANSFER_AMOUNT) * 2n).toString(), recipientIdx: 2 }] },
    { key: "t-3x4", n: 3, m: 4, recipients: [{ amount: TRANSFER_AMOUNT, recipientIdx: 2 }] },
    { key: "t-3x5", n: 3, m: 5, recipients: [{ amount: TRANSFER_AMOUNT, recipientIdx: 2 }] },
    // 4xM (M<N skipped — per-label conservation fails when primary has no change slot)
    { key: "t-4x4", n: 4, m: 4, recipients: [{ amount: (BigInt(TRANSFER_AMOUNT) * 2n).toString(), recipientIdx: 3 }] },
    { key: "t-4x5", n: 4, m: 5, recipients: [{ amount: TRANSFER_AMOUNT, recipientIdx: 3 }] },
    // 5xM (only 5x5 — no larger M circuit, and M<N skipped as above)
    { key: "t-5x5", n: 5, m: 5, recipients: [{ amount: (BigInt(TRANSFER_AMOUNT) * 2n).toString(), recipientIdx: 4 }] },

    // ── Multi-recipient (multiple transfer outputs in a single transaction) ──
    // Each account has 0.002 ETH. Recipients use indices 5-10 (no overlap with single-recipient specs).
    // 1x3 with 2 recipients + 1 change
    {
        key: "t-multi-1x3",
        n: 1,
        m: 3,
        recipients: [
            { amount: "400000000000000", recipientIdx: 5 },  // 0.0004 ETH
            { amount: "500000000000000", recipientIdx: 6 },  // 0.0005 ETH
        ],
    },
    // 1x5 with 4 recipients + 1 change
    {
        key: "t-multi-1x5",
        n: 1,
        m: 5,
        recipients: [
            { amount: "200000000000000", recipientIdx: 5 },  // 0.0002 ETH
            { amount: "200000000000000", recipientIdx: 6 },  // 0.0002 ETH
            { amount: "200000000000000", recipientIdx: 7 },  // 0.0002 ETH
            { amount: "200000000000000", recipientIdx: 8 },  // 0.0002 ETH
        ],
    },
    // 2x5 with 3 recipients + 2 change
    // All recipient outputs use primaryAccount.label, so total transfer must fit
    // within primaryAccount.value minus the relayer fee (~0.0005 ETH) for
    // per-label conservation to hold.
    {
        key: "t-multi-2x5",
        n: 2,
        m: 5,
        recipients: [
            { amount: "400000000000000", recipientIdx: 7 },  // 0.0004 ETH
            { amount: "400000000000000", recipientIdx: 8 },  // 0.0004 ETH
            { amount: "400000000000000", recipientIdx: 9 },  // 0.0004 ETH
        ],
    },
];

/** Returns true if any child describe in the suite has at least one running test. */
function anyTestsWillRun(suite: Readonly<Suite>): boolean {
    for (const task of suite.tasks) {
        if (task.type === "suite") {
            const hasRunning = (task as Suite).tasks.some((t: Task) => t.mode === "run" || t.mode === "only");
            if (hasRunning) return true;
        }
    }
    return false;
}

/** Returns a beforeAll callback that sets up the relay context for a given suite. */
function makeRelayBeforeAll(ctx: RelayContext) {
    return async (suite: unknown) => {
        // Skip setup entirely if no tests will run (e.g. vitest filter excludes all).
        if (!anyTestsWillRun(suite as Suite)) return;

        const proofService = await E2EProofService.create({
            circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
            rpcUrl: RPC_URL,
        });
        const hashService = await PoseidonHashService.create();

        // ── Phase 1A: Prepare first account (establishes shared keys) ──
        const firstPrep = await proofService.prepareAccount({
            ownerAddress: DEPOSITOR,
            tokenId: NATIVE_ASSET,
            value: DEPOSIT_VALUE,
        });

        // ── Phase 1B: Prepare remaining accounts in parallel (sharing keys) ──
        const remainingPromises = [];
        for (let i = 1; i < ACCOUNT_COUNT; i++) {
            remainingPromises.push(
                proofService.prepareAccount({
                    ownerAddress: firstPrep.ownerAddress,
                    tokenId: NATIVE_ASSET,
                    value: DEPOSIT_VALUE,
                    privateNullifyingKey: firstPrep.privateNullifyingKey,
                    privateRevocableKey: firstPrep.privateRevocableKey,
                })
            );
        }
        const remainingPreps = await Promise.all(remainingPromises);
        const preps = [firstPrep, ...remainingPreps];

        // ── Phase 2: Submit all accounts sequentially (anvil-bound) ──
        const accounts: AccountState[] = [];
        for (const prep of preps) {
            accounts.push(await proofService.submitAccount(prep, { skipASP: true }));
        }

        // ── Phase 3: Push shared ASP tree ──
        const aspLeaves = accounts.map((a) => a.labelHash);
        await proofService.pushASPTree(accounts);

        // ── Phase 4: Snapshot anvil state ──
        // All deposits are done. Snapshot so tests can revert and reuse accounts.
        let currentSnapshotId = await proofService.snapshot();
        ctx.revertAndSnapshot = async () => {
            await proofService.revert(currentSnapshotId);
            currentSnapshotId = await proofService.snapshot();
        };

        // ── Phase 5: Pre-generate all proofs in parallel ──
        // Proofs only read chain state — they don't mutate it.
        // After revert, chain state is identical, so pre-generated proofs stay valid.
        type PayloadEntry = [string, RelayPayload & { recipient?: Address }];
        const proofPromises: Promise<PayloadEntry>[] = [];

        // Withdrawal proofs: for N inputs, use the first N accounts
        for (let n = 1; n <= 5; n++) {
            const accountStates = accounts.slice(0, n);
            const amount = W_AMOUNTS[n - 1];

            for (let m = 1; m <= 5; m++) {
                const key = `w-${n}x${m}`;
                const recipient = m === 1 ? W_NX1_RECIPIENTS[n - 1] : WITHDRAWAL_RECIPIENTS[0];
                proofPromises.push(
                    proofService
                        .generateWithdrawalProof({
                            accountStates,
                            amountOut: amount,
                            recipient,
                            relayerUrl: BASE_URL,
                            chainId: CHAIN_ID,
                            aspLeaves,
                            ...(m > 1 ? { mOutputs: m } : {}),
                        })
                        .then((r): PayloadEntry => [key, { ...r.relayPayload, recipient }]),
                );
            }
        }

        // Transfer proofs bind the processor disclosed by the quote endpoint —
        // proves the advertised value round-trips through proof generation and relay.
        const quoteRes = await fetchWithRetry(`${BASE_URL}${getQuoteEndpoint(V, CHAIN_TYPE, CHAIN_ID)}/transfer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ asset: NATIVE_ASSET, commit: false }),
        });
        if (!quoteRes.ok) {
            throw new Error(`Transfer quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
        }
        const transferQuote = (await quoteRes.json()) as { processor?: Address };
        // No fallback: a quote without `processor` must fail the suite, not silently
        // fall back to the signer and mask the regression.
        if (transferQuote.processor === undefined) {
            throw new Error("Transfer quote response is missing `processor`");
        }
        if (transferQuote.processor.toLowerCase() !== RELAYER_SIGNER_ADDRESS.toLowerCase()) {
            throw new Error(
                `Transfer quote processor ${transferQuote.processor} != relayer signer ${RELAYER_SIGNER_ADDRESS}`
            );
        }
        const transferProcessor = transferQuote.processor;

        // Transfer proofs: for N inputs, use the first N accounts
        for (const spec of TRANSFER_PROOF_SPECS) {
            const accountStates = accounts.slice(0, spec.n);
            const recipients = spec.recipients.map((r) => {
                const bobNoteSecret = `0x${randomBytes(31).toString("hex")}` as `0x${string}`;
                const noteAddressHash = hashService.hash([
                    TRANSFER_RECIPIENTS[r.recipientIdx],
                    bobNoteSecret,
                ]) as `0x${string}`;
                return { noteAddressHash, amount: r.amount };
            });
            proofPromises.push(
                proofService
                    .generateTransferProof({
                        accountStates,
                        recipients,
                        relayerUrl: BASE_URL,
                        chainId: CHAIN_ID,
                        aspLeaves,
                        mOutputs: spec.m,
                        processor: transferProcessor,
                    })
                    .then((r): PayloadEntry => [spec.key, r.relayPayload]),
            );
        }

        const payloadEntries = await Promise.all(proofPromises);

        // Populate shared context
        ctx.proofService = proofService;
        ctx.hashService = hashService;
        ctx.accounts = accounts;
        ctx.aspLeaves = aspLeaves;
        ctx.baseUrl = BASE_URL;
        ctx.chainId = CHAIN_ID;
        ctx.relayEndpoint = RELAY_ENDPOINT;
        ctx.payloads = new Map(payloadEntries);
    };
}

export function relayTests() {
    describe("Relay validation", validationTests);
    describe("Relay commitment", commitmentTests);

    describe("Relay", () => {
        const ctx: RelayContext = {} as RelayContext;
        beforeAll(makeRelayBeforeAll(ctx), 600_000);
        beforeEach(async () => {
            await ctx.revertAndSnapshot();
        });

        describe("negative", () => negativeTests(ctx));
        describe("withdrawal 1xm", () => withdrawal1xMTests(ctx));
        describe("withdrawal 2xm", () => withdrawal2xMTests(ctx));
        describe("withdrawal 3xm", () => withdrawal3xMTests(ctx));
        describe("withdrawal 4xm", () => withdrawal4xMTests(ctx));
        describe("withdrawal 5xm", () => withdrawal5xMTests(ctx));
        describe("transfer 1xm", () => transfer1xMTests(ctx));
        describe("transfer 2xm", () => transfer2xMTests(ctx));
        describe("transfer 3xm", () => transfer3xMTests(ctx));
        describe("transfer 4xm", () => transfer4xMTests(ctx));
        describe("transfer 5xm", () => transfer5xMTests(ctx));
        describe("transfer multi-recipient", () => transferMultiTests(ctx));
    });
}

export function baseRelayTests() {
    describe("Relay validation", validationTests);
    describe("Relay commitment", commitmentTests);

    describe("Relay", () => {
        const ctx: RelayContext = {} as RelayContext;
        beforeAll(makeRelayBeforeAll(ctx), 600_000);
        beforeEach(async () => {
            await ctx.revertAndSnapshot();
        });

        describe("negative", () => negativeTests(ctx));
        describe("withdrawal 1xm", () => withdrawal1xMTests(ctx));
        describe("withdrawal 3xm", () => withdrawal3xMTests(ctx));
        describe("transfer 1xm", () => transfer1xMTests(ctx));
        describe("transfer 3xm", () => transfer3xMTests(ctx));
    });
}
