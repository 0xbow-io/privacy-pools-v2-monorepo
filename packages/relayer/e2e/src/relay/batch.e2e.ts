/**
 * Batch withdrawal — definitive full-stack e2e.
 *
 * Exercises the "withdraw an entire single-asset balance in ONE on-chain
 * transaction" feature end to end (design doc: docs/tech-design/contracts/batch-withdrawal.md):
 *
 *   SDK builds N per-note-group transact proofs
 *     -> relayer POST /v1/quote/evm/:chainId/batch   (one aggregate signed fee split)
 *     -> relayer POST /v1/relay/evm/:chainId/batch    (one signed batch commitment)
 *     -> on-chain PrivacyPoolRelay.relayBatch          (one tx, one aggregate payout)
 *     -> assert recipient / feeRecipient / pool balances + RelayedBatch event.
 *
 * We deposit N = 3 notes with DISTINCT labels of the same native asset, so a
 * full-balance withdrawal partitions into 3 single-label groups -> a genuine
 * 3-item batch (each item a 1x1 full withdrawal, zero-value change), matching how
 * `selectNotesForFullWithdraw` groups notes by label.
 *
 * Batch item construction runs through the SDK's real
 * `BatchWithdrawOrchestrator.prepareBatchWithdraw` (value-exported from
 * `@privacy-pools-v2/evm-sdk`). The harness wires a genuine `TransactOrchestrator`
 * ("core") + `NoteManager` via `E2EProofService.createBatchWithdrawCore` — the same
 * dependencies the SDK's PoolSession factory builds — and this file constructs the
 * `BatchWithdrawOrchestrator` from `{ core, noteManager }`, exactly as a consumer
 * would. `selectNotesForFullWithdraw` partitions the active balance into the
 * per-label groups that drive both the quote `amounts` and the proof loop, so the
 * relayer's signed `PayoutRouting[]` lines up with the groups the orchestrator proves.
 * The relayer HTTP legs use `RelayerInteractor.getBatchWithdrawalQuote` and
 * `relayBatchWithdrawal`.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
    createPublicClient,
    http,
    decodeAbiParameters,
    getAddress,
    parseEventLogs,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: SDK installed from tarball / workspace, not always present in node_modules
// prettier-ignore
import { RelayerInteractor, HTTPClient, BatchWithdrawOrchestrator, selectNotesForFullWithdraw, PAYOUT_ROUTING_ARRAY_ABI, type RelayerInfo, type BatchWithdrawalRelayerQuote, type BatchWithdrawItem } from "@privacy-pools-v2/evm-sdk";

import { E2EProofService, SEPOLIA_CONTRACTS } from "../proofs";
import type { AccountState, PayoutRouting } from "../proofs";
import { CIRCUIT_ARTIFACTS_DIR, RPC_URL, NATIVE_ASSET } from "../proofs/config";
import { WITHDRAWAL_RECIPIENTS } from "../test-addresses";

const BASE_URL = process.env.RELAYER_URL!;
const CHAIN_ID = process.env.TEST_CHAIN_ID!;
const CHAIN_TYPE = process.env.TEST_CHAIN_TYPE!;

// Dedicated depositor for the batch suite — MUST differ from the relay suite's
// DEPOSITOR: keystore registration is keyed by ownerAddress and skipped if the
// account is already registered, so sharing an owner across suites with different
// nullifying keys would leave the wrong key registered.
const BATCH_DEPOSITOR: Address = getAddress("0xba7c000000000000000000000000000000000fa7");

// Single shared recipient for the whole batch (a clean external address).
const RECIPIENT: Address = WITHDRAWAL_RECIPIENTS[0];

// Three distinct-value native notes -> three distinct labels -> a 3-item batch.
const DEPOSIT_VALUES = ["1000000000000000", "2000000000000000", "3000000000000000"]; // 0.001, 0.002, 0.003 ETH

// Max input notes per transact (circuit limit). Mirrors the SDK's MAX_INPUTS,
// which is not value-exported from the package barrel.
const MAX_INPUTS = 5;

// RelayedBatch(address indexed asset, address indexed recipient, uint256 recipientAmount,
//              address indexed feeRecipient, uint256 fee, uint256 gasFunding, uint256 count)
const RELAYED_BATCH_EVENT_ABI = [
    {
        type: "event",
        name: "RelayedBatch",
        inputs: [
            { name: "_asset", type: "address", indexed: true },
            { name: "_recipient", type: "address", indexed: true },
            { name: "_recipientAmount", type: "uint256", indexed: false },
            { name: "_feeRecipient", type: "address", indexed: true },
            { name: "_fee", type: "uint256", indexed: false },
            { name: "_gasFunding", type: "uint256", indexed: false },
            { name: "_count", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
] as const;

interface BatchContext {
    proofService: E2EProofService;
    publicClient: PublicClient;
    relayer: RelayerInteractor;
    relayerInfo: RelayerInfo;
    accounts: AccountState[];
    aspLeaves: Hex[];
    revertAndSnapshot: () => Promise<void>;
}

/** Decode the signed batch fee commitment's PayoutRouting[] the same way the relayer does. */
function decodeRoutings(data: Hex): PayoutRouting[] {
    const [routings] = decodeAbiParameters(PAYOUT_ROUTING_ARRAY_ABI, data);
    return (routings as ReadonlyArray<PayoutRouting>).map((r) => ({
        recipient: getAddress(r.recipient),
        feeRecipient: getAddress(r.feeRecipient),
        feeAmount: BigInt(r.feeAmount),
        nativeGas: BigInt(r.nativeGas),
    }));
}

/**
 * Map an orchestrator {@link BatchWithdrawItem} onto the relayer's batch relay item,
 * exactly as the SDK's `PoolSessionBatchWithdraw.relayBatchWithdraw` does — `item.proof`
 * is already a `ProofResult`, so it passes straight through.
 */
function toRelayItem(item: BatchWithdrawItem) {
    return {
        proof: item.proof,
        noteData: item.noteData,
        inputNullifierNumber: item.inputNullifierNumber,
        outputCommitmentNumber: item.outputCommitmentNumber,
    };
}

export function batchWithdrawalTests() {
    describe("Batch withdrawal", () => {
        const ctx = {} as BatchContext;

        beforeAll(async () => {
            const proofService = await E2EProofService.create({
                circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
                rpcUrl: RPC_URL,
            });

            // ── Phase 1: prepare 3 accounts sharing keys but with distinct
            // note/deposit secrets => distinct labels (one group per note). ──
            const firstPrep = await proofService.prepareAccount({
                ownerAddress: BATCH_DEPOSITOR,
                tokenId: NATIVE_ASSET,
                value: DEPOSIT_VALUES[0],
            });
            const remainingPreps = await Promise.all(
                DEPOSIT_VALUES.slice(1).map((value) =>
                    proofService.prepareAccount({
                        ownerAddress: firstPrep.ownerAddress,
                        tokenId: NATIVE_ASSET,
                        value,
                        privateNullifyingKey: firstPrep.privateNullifyingKey,
                        privateRevocableKey: firstPrep.privateRevocableKey,
                    }),
                ),
            );
            const preps = [firstPrep, ...remainingPreps];

            // ── Phase 2: submit deposits sequentially (anvil impersonation). ──
            const accounts: AccountState[] = [];
            for (const prep of preps) {
                accounts.push(await proofService.submitAccount(prep, { skipASP: true }));
            }

            // ── Phase 3: push one shared ASP tree covering all 3 labels. ──
            const aspLeaves = accounts.map((a) => a.labelHash) as Hex[];
            await proofService.pushASPTree(accounts);

            // ── Phase 4: snapshot so each test reverts to a clean post-deposit state. ──
            let snapshotId = await proofService.snapshot();
            ctx.revertAndSnapshot = async () => {
                await proofService.revert(snapshotId);
                snapshotId = await proofService.snapshot();
            };

            const publicClient = createPublicClient({ transport: http(RPC_URL) });
            const relayerInfo: RelayerInfo = {
                url: BASE_URL,
                name: "e2e-local",
                chainId: Number(CHAIN_ID),
                chainType: CHAIN_TYPE,
                status: "active",
                address: SEPOLIA_CONTRACTS.relayContract,
                processorAddress: SEPOLIA_CONTRACTS.relayContract,
            };
            const relayer = new RelayerInteractor({ relayers: [relayerInfo], httpClient: new HTTPClient() });

            ctx.proofService = proofService;
            ctx.publicClient = publicClient as PublicClient;
            ctx.relayer = relayer;
            ctx.relayerInfo = relayerInfo;
            ctx.accounts = accounts;
            ctx.aspLeaves = aspLeaves;
        }, 300_000);

        beforeEach(async () => {
            await ctx.revertAndSnapshot();
        });

        it("withdraws the full balance across a 3-item batch in one tx", async () => {
            // Wire a real BatchWithdrawOrchestrator over the batch's notes — the same
            // { core: TransactOrchestrator, noteManager } a PoolSession consumer builds.
            const { core, noteManager, notes } = await ctx.proofService.createBatchWithdrawCore({
                ownerAddress: BATCH_DEPOSITOR,
                accounts: ctx.accounts,
                aspLeaves: ctx.aspLeaves,
            });
            const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager });

            // Partition the balance ONCE: the same groups drive the quote amounts and the
            // orchestrator's proof loop, so routings[i] lines up with groups[i].
            const groups = selectNotesForFullWithdraw({ notes, tokenId: NATIVE_ASSET, maxInputs: MAX_INPUTS });
            const amounts = groups.map((g) => g.amountOut.toString());
            const totalAmountOut = groups.reduce((s, g) => s + g.amountOut, 0n);

            // 1. Aggregate batch quote (SDK -> relayer POST /v1/quote/.../batch).
            const quote: BatchWithdrawalRelayerQuote = await ctx.relayer.getBatchWithdrawalQuote(ctx.relayerInfo, {
                asset: NATIVE_ASSET as Hex,
                commit: true,
                recipient: RECIPIENT as Hex,
                extraGas: false,
                amounts,
            });
            const totalFee = BigInt(quote.totalFee);
            expect(totalFee).toBeGreaterThan(0n);

            // 2. Decode the relayer-authoritative PayoutRouting[] the relayer signed.
            const routings = decodeRoutings(quote.feeCommitment.data as Hex);
            expect(routings).toHaveLength(groups.length);
            const feeRecipient = routings[0].feeRecipient;
            // Every item shares one recipient/feeRecipient; only the fee split varies.
            for (const r of routings) {
                expect(getAddress(r.recipient)).toBe(getAddress(RECIPIENT));
                expect(getAddress(r.feeRecipient)).toBe(getAddress(feeRecipient));
            }
            expect(routings.reduce((s, r) => s + r.feeAmount, 0n)).toBe(totalFee);

            // 3. Drive per-group proofs through the SDK orchestrator: one full-withdrawal
            //    transact per note group, the relayer's routing bound into each proof context.
            const prepared = await orchestrator.prepareBatchWithdraw({
                tokenId: NATIVE_ASSET,
                recipientAddress: RECIPIENT,
                relayAddress: SEPOLIA_CONTRACTS.relayContract,
                quote,
                groups,
            });
            const items = prepared.items.map(toRelayItem);

            // 4. Snapshot balances just before the batch lands.
            const recipientBefore = await ctx.publicClient.getBalance({ address: RECIPIENT });
            const feeRecipientBefore = await ctx.publicClient.getBalance({ address: feeRecipient });
            const poolBefore = await ctx.publicClient.getBalance({ address: SEPOLIA_CONTRACTS.poolVault });

            // 5. Submit the batch (SDK -> relayer POST /v1/relay/.../batch -> on-chain relayBatch).
            const txHash = await ctx.relayer.relayBatchWithdrawal(ctx.relayerInfo, {
                items,
                signedBatchFeeCommitment: quote.feeCommitment,
            });
            expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

            const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash as Hex });
            expect(receipt.status).toBe("success");

            // 6. Balance assertions: recipient += ΣamountOut − Σfee; feeRecipient += Σfee; pool −= ΣamountOut.
            const recipientAfter = await ctx.publicClient.getBalance({ address: RECIPIENT });
            const feeRecipientAfter = await ctx.publicClient.getBalance({ address: feeRecipient });
            const poolAfter = await ctx.publicClient.getBalance({ address: SEPOLIA_CONTRACTS.poolVault });

            expect(recipientAfter - recipientBefore).toBe(totalAmountOut - totalFee);
            expect(feeRecipientAfter - feeRecipientBefore).toBe(totalFee);
            expect(poolBefore - poolAfter).toBe(totalAmountOut);

            // 7. RelayedBatch event: one aggregate payout event with count = 3.
            const events = parseEventLogs({
                abi: RELAYED_BATCH_EVENT_ABI,
                logs: receipt.logs,
                eventName: "RelayedBatch",
            });
            expect(events).toHaveLength(1);
            const ev = events[0].args as {
                _asset: Address;
                _recipient: Address;
                _recipientAmount: bigint;
                _feeRecipient: Address;
                _fee: bigint;
                _count: bigint;
            };
            expect(getAddress(ev._asset)).toBe(getAddress(NATIVE_ASSET));
            expect(getAddress(ev._recipient)).toBe(getAddress(RECIPIENT));
            expect(getAddress(ev._feeRecipient)).toBe(getAddress(feeRecipient));
            expect(ev._recipientAmount).toBe(totalAmountOut - totalFee);
            expect(ev._fee).toBe(totalFee);
            expect(ev._count).toBe(BigInt(ctx.accounts.length));
        }, 180_000);

        it("rejects a batch that exceeds MAX_BATCH (11 > 10)", async () => {
            const { core, noteManager, notes } = await ctx.proofService.createBatchWithdrawCore({
                ownerAddress: BATCH_DEPOSITOR,
                accounts: ctx.accounts,
                aspLeaves: ctx.aspLeaves,
            });
            const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager });

            // One real, structurally-valid item from a single note group + its matching
            // 1-amount quote, produced by the SDK orchestrator (no hand-rolled proof).
            const oneGroup = selectNotesForFullWithdraw({ notes: [notes[0]], tokenId: NATIVE_ASSET, maxInputs: MAX_INPUTS });
            const oneQuote = await ctx.relayer.getBatchWithdrawalQuote(ctx.relayerInfo, {
                asset: NATIVE_ASSET as Hex,
                commit: true,
                recipient: RECIPIENT as Hex,
                extraGas: false,
                amounts: oneGroup.map((g) => g.amountOut.toString()),
            });
            const preparedOne = await orchestrator.prepareBatchWithdraw({
                tokenId: NATIVE_ASSET,
                recipientAddress: RECIPIENT,
                relayAddress: SEPOLIA_CONTRACTS.relayContract,
                quote: oneQuote,
                groups: oneGroup,
            });
            const one = toRelayItem(preparedOne.items[0]);

            // Quote an 11-item batch (each == account[0]'s value) to get an 11-routing
            // signed commitment, then submit 11 copies of the valid item. relayBatch's
            // shape check (n <= MAX_BATCH) reverts before any per-item transact runs, so
            // proof reuse is irrelevant — the batch is rejected atomically for its size.
            const value = ctx.accounts[0].value;
            const amounts = Array.from({ length: 11 }, () => value);
            const quote: BatchWithdrawalRelayerQuote = await ctx.relayer.getBatchWithdrawalQuote(ctx.relayerInfo, {
                asset: NATIVE_ASSET as Hex,
                commit: true,
                recipient: RECIPIENT as Hex,
                extraGas: false,
                amounts,
            });
            const routings = decodeRoutings(quote.feeCommitment.data as Hex);
            expect(routings).toHaveLength(11);

            const items = Array.from({ length: 11 }, () => one);

            await expect(
                ctx.relayer.relayBatchWithdrawal(ctx.relayerInfo, {
                    items,
                    signedBatchFeeCommitment: quote.feeCommitment,
                }),
            ).rejects.toThrow();
        }, 120_000);
    });
}
