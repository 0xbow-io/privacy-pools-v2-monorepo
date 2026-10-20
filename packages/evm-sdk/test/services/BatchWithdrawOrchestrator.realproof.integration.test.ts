import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, keccak256 } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

import type {
    Address,
    BatchPrepareResult,
    BatchWithdrawalRelayerQuote,
    EVMProof,
    Hex,
    IASPClient,
    IKeystoreInteractor,
    IPoolVaultInteractor,
    IRPCInteractor,
    Label,
    NoteData,
    PreparedTransaction,
    Secret,
    TransactParams,
} from "../../src/internal.js";
import {
    BatchWithdrawOrchestrator,
    BN254_SCALAR_MODULUS,
    COMMITMENT_LEAF_TAG,
    computeBatchItemFee,
    CryptoService,
    Groth16Prover,
    KeystoreManager,
    LocalCircuitArtifacts,
    MAX_INPUTS,
    MerkleService,
    NoteComputationService,
    NoteManager,
    NoteStatus,
    PAYOUT_ROUTING_ABI,
    PAYOUT_ROUTING_ARRAY_ABI,
    PoseidonHashService,
    PP_RELAY_BATCH_ABI,
    ProofService,
    selectNotesForFullWithdraw,
    AddressSchema,
    EvmAddressEqualityComparator,
    EvmPreparedTxVerifier,
    EvmAddressFieldConverter,
    EvmContextHashService,
    EvmPayoutRoutingCodec,
    EvmRelayBatchCodec,
    TransactOrchestrator,
    WitnessPreparationService,
} from "../../src/internal.js";

/**
 * GAP-4 (E2E) — REAL-PROOF coverage of the ACTUAL BatchWithdrawOrchestrator entrypoint.
 *
 * The sibling `BatchWithdrawOrchestrator.integration.test.ts` proves the load-bearing
 * shared-stateRoot / distinct-context invariant one layer DOWN (WitnessPreparationService
 * + ProofService over two hand-built 1x1 witnesses), explicitly bypassing the orchestrator.
 * The unit test drives `prepareBatchWithdraw` but with a FAKE core echoing `proof: {}`.
 *
 * This test closes that gap: it wires the REAL {@link TransactOrchestrator} core (real
 * WitnessPreparationService + ProofService + Groth16, plus in-memory fake interactors that
 * serve leaves consistent with a seeded {@link NoteManager}) into a real
 * {@link BatchWithdrawOrchestrator} and drives `prepareBatchWithdraw` end-to-end. It then
 * asserts, on the orchestrator's returned items, that:
 *   1. every `item.proof` VERIFIES against the transact 1x1 verification key;
 *   2. all items share ONE `stateRoot` public signal that equals the actual Merkle root of
 *      the seeded pre-batch snapshot (shared, content-bound snapshot);
 *   3. the MULTISET of per-item `nullifierHash` signals equals the exact set of nullifiers
 *      derived from the seeded notes, and per index each `item[i]` spends `groups[i]`'s note
 *      — closing drop / duplicate / mis-order / wrong-note in one stroke;
 *   4. each item's decoded `PayoutRouting` matches the intended per-group quote, and each
 *      item's `context` public signal equals the context RECOMPUTED from that intended
 *      routing + the item's published noteData (not merely "distinct").
 *
 * The batch is forced to >=2 groups by giving each input note a DISTINCT label
 * (`selectNotesForFullWithdraw` emits one single-label group per lineage), so every item
 * is a 1x1 full withdrawal with a single zero-value change note — matching the compiled
 * `transact_1x1` artifact. Two of the three seeded notes carry the SAME value (100) so the
 * distinctness of their items is NOT a free side-effect of differing amounts/fees — those
 * two items share amountOut, fee, routing and every root, differing ONLY in nullifierHash,
 * outputCommitment and context.
 *
 * Transact public-signal layout for 1x1:
 *   [0] nullifierHash, [1] outputCommitment, [2] stateRoot, [3] keystoreRoot,
 *   [4] associationSetRoot, [5] amountOut, [6] tokenIdOut, [7] context.
 */

const CIRCUITS_BUILD_DIR = resolve(__dirname, "../../../../packages/circuits/build");
const TRANSACT_WASM = resolve(CIRCUITS_BUILD_DIR, "transact_1x1/transact_1x1_js/transact_1x1.wasm");
const hasTransactArtifacts = existsSync(TRANSACT_WASM);

const NULLIFIER_INDEX = 0;
const STATE_ROOT_INDEX = 2;
const CONTEXT_INDEX = 7;

/**
 * ABI of the `context` preimage, mirroring TransactOrchestrator.computeTransactContext:
 * `keccak256(abi.encode(TransactParams{processor,data}, NoteData[]{hint,data}))`.
 */
const CONTEXT_PREIMAGE_ABI = [
    {
        type: "tuple",
        components: [
            { name: "processor", type: "address" },
            { name: "data", type: "bytes" },
        ],
    },
    {
        type: "tuple[]",
        components: [
            { name: "hint", type: "bytes32" },
            { name: "data", type: "bytes" },
        ],
    },
] as const;

// The signed fee-model the relayer commits to (bps model): each item pays
// relayCost + amountOut*feeBps/10000, capped at maxRelayFee.
const FEE_MODEL = { relayCost: 10n, feeBps: 1000n, flatFee: 0n, maxRelayFee: 100n };

/** One PayoutRouting slot as the relayer signs it into the batch fee commitment. */
interface Routing { recipient: Address; feeRecipient: Address; feeAmount: bigint; nativeGas: bigint }

describe.skipIf(!hasTransactArtifacts)(
    "BatchWithdrawOrchestrator.prepareBatchWithdraw (real proof)",
    () => {
        // Shared identity across every batch item.
        const ownerAddress = "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392" as Address;
        const tokenId = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
        const recipientAddress = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
        const relayAddress = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;
        const poolAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
        const privateNullifyingKey =
            "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
        const privateRevocableKey =
            "0x2222222222222222222222222222222222222222222222222222222222222222" as Secret;
        const createdAtBlock = "0x1" as Hex;

        // Three DISTINCT lineages -> three single-note groups -> three 1x1 withdrawals.
        // Notes A and C share value 100 so their items are indistinguishable by amount/fee
        // — proving item distinctness is bound by nullifier/output/context, not by value.
        const inputs = [
            {
                noteSecret:
                    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Secret,
                label: "0x0a" as Label,
                value: "0x64" as Hex, // 100
            },
            {
                noteSecret:
                    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Secret,
                label: "0x0b" as Label,
                value: "0xc8" as Hex, // 200
            },
            {
                noteSecret:
                    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Secret,
                label: "0x0c" as Label,
                value: "0x64" as Hex, // 100 (same as note A)
            },
        ];

        let orchestrator: BatchWithdrawOrchestrator;
        let proofService: ProofService;
        let quote: BatchWithdrawalRelayerQuote;
        let result: BatchPrepareResult;
        let groups: ReturnType<typeof selectNotesForFullWithdraw>;
        // The actual Merkle root of the seeded pre-batch snapshot leaves.
        let expectedStateRoot: bigint;
        // Ground-truth nullifierHash for each seeded note, keyed by its commitment.
        const expectedNullifierByCommitment = new Map<Hex, bigint>();

        beforeAll(async () => {
            const hashService = await PoseidonHashService.create();
            const merkleService = new MerkleService({ hashService });
            const cryptoService = new CryptoService();
            const noteComputationService = new NoteComputationService({
                hashService,
                cryptoService,
            });
            const witnessPreparationService = new WitnessPreparationService({
                noteComputationService,
                hashService,
                merkleService,
            });
            const circuitArtifacts = new LocalCircuitArtifacts({ baseDir: CIRCUITS_BUILD_DIR });
            proofService = new ProofService({
                circuitArtifacts,
                groth16Prover: new Groth16Prover(),
            });

            // --- Derive each input note + the leaf sets of ONE shared pre-batch snapshot. ---
            const authDigest = noteComputationService.computeAuthDigest(privateRevocableKey);
            const nullKeyHash = hashService.hash([privateNullifyingKey]);
            const keystoreLeaf = hashService.hash([ownerAddress, nullKeyHash, authDigest]);
            const keystoreLeaves = [keystoreLeaf];

            const noteManager = new NoteManager({});
            const stateLeaves: Hex[] = [];
            const aspLeaves: Hex[] = [];

            for (const input of inputs) {
                const noteAddressHash = noteComputationService.computeNoteAddressHash(
                    ownerAddress,
                    input.noteSecret,
                );
                const commitment = noteComputationService.computeFullCommitment({
                    noteAddressHash,
                    tokenId,
                    value: input.value,
                    label: input.label,
                });
                stateLeaves.push(
                    hashService.hash([COMMITMENT_LEAF_TAG, commitment, createdAtBlock]),
                );
                aspLeaves.push(noteComputationService.computeLabelHash(input.label));

                // Ground truth: the nullifierHash the circuit will expose for this note is
                // Poseidon(privateNullifyingKey, commitment) — the SAME derivation the
                // witness builder uses (NoteComputationService.computeNullifier).
                expectedNullifierByCommitment.set(
                    commitment,
                    BigInt(
                        noteComputationService.computeNullifier(privateNullifyingKey, commitment),
                    ),
                );

                noteManager.addNote({
                    noteAddressHash,
                    commitment,
                    value: input.value,
                    tokenId,
                    label: input.label,
                    status: NoteStatus.ACTIVE,
                    ownerAddress,
                    noteSecret: input.noteSecret,
                    isOwned: true,
                    createdAtBlock,
                    spentAtBlock: null,
                    txHash: "0xab" as Hex,
                });
            }

            // Real KeystoreManager; the viewing keypair is a valid X25519 pair the config
            // schema requires but this withdraw flow only uses for change-note encryption.
            const viewing = cryptoService.generateEphemeralKeyPair();
            const keystoreManager = new KeystoreManager({
                privateNullifyingKey,
                privateRevocableKey,
                viewingPrivateKey: viewing.privateKey,
                viewingPublicKey: viewing.publicKey,
                revocableKeyIndex: "0x0" as Hex,
            });

            // In-memory fake interactors serving leaves consistent with the seeded notes.
            const poolVaultInteractor = {
                getAddress: () => poolAddress,
                getStateLeaves: async () => stateLeaves,
                encodeTransact: (
                    _proof: EVMProof,
                    _pubSignals: bigint[][],
                    _params: TransactParams,
                    _noteData: NoteData[],
                ): PreparedTransaction => ({
                    to: poolAddress,
                    data: "0x" as Hex,
                    value: "0x0" as Hex,
                }),
            } as unknown as IPoolVaultInteractor;
            const keystoreInteractor = {
                getKeystoreLeaves: async () => keystoreLeaves,
                getNullifyingKeyHash: async () => "0x01",
            } as unknown as IKeystoreInteractor;
            const aspClient = {
                getAssociationSetLeaves: async () => aspLeaves,
            } as unknown as IASPClient;
            const rpcInteractor = {} as unknown as IRPCInteractor;

            const core = new TransactOrchestrator({
                ownerAddress,
                noteManager,
                keystoreManager,
                witnessPreparationService,
                proofService,
                keystoreInteractor,
                poolVaultInteractor,
                aspClient,
                cryptoService,
                noteComputationService,
                rpcInteractor,
                contextHashService: new EvmContextHashService(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                relayBatchCodec: new EvmRelayBatchCodec(),
                addressFieldConverter: new EvmAddressFieldConverter(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                addressSchema: AddressSchema,
            });

            orchestrator = new BatchWithdrawOrchestrator({
                core,
                noteManager,
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
            });

            // The stateRoot every item must prove against: the Merkle root of the ONE
            // seeded snapshot. Binding to this exact value (not just "all items equal")
            // fails an orchestrator that proves over a different/empty leaf set.
            expectedStateRoot = BigInt(await merkleService.computeRoot(stateLeaves));

            // Partition the balance exactly as the session does, then quote each group's
            // fair single-tx fee — one signed PayoutRouting per group, in group order.
            groups = selectNotesForFullWithdraw({
                notes: noteManager.getNotes({ status: NoteStatus.ACTIVE, tokenId }),
                tokenId,
                maxInputs: MAX_INPUTS,
            });
            expect(groups).toHaveLength(3);
            quote = makeQuote(groups.map((group) => group.amountOut));

            result = await orchestrator.prepareBatchWithdraw({
                tokenId,
                recipientAddress,
                relayAddress,
                quote,
                groups,
            });
        }, 240_000);

        /** Builds a relayer batch quote whose per-group routings carry the fair single-tx fee. */
        function makeQuote(amountOuts: bigint[]): BatchWithdrawalRelayerQuote {
            const fees = amountOuts.map((amountOut) =>
                computeBatchItemFee({ ...FEE_MODEL, amountOut }),
            );
            const routings: Routing[] = fees.map((feeAmount) => ({
                recipient: recipientAddress,
                feeRecipient: relayAddress,
                feeAmount,
                nativeGas: 0n,
            }));
            const data = encodeAbiParameters(PAYOUT_ROUTING_ARRAY_ABI, [routings]) as Hex;
            const totalFee = fees.reduce((sum, fee) => sum + fee, 0n).toString();
            return {
                txCost: "0x0",
                gasPrice: "0x0",
                totalFee,
                maxRelayFee: FEE_MODEL.maxRelayFee.toString(),
                feeCommitment: {
                    data,
                    asset: tokenId as Hex,
                    expiration: Date.now() + 60_000,
                    totalFee,
                    maxRelayFee: FEE_MODEL.maxRelayFee.toString(),
                    relayCost: FEE_MODEL.relayCost.toString(),
                    feeBps: FEE_MODEL.feeBps.toString(),
                    flatFee: FEE_MODEL.flatFee.toString(),
                    signedRelayerCommitment: "0x" as Hex,
                },
            };
        }

        /**
         * Recomputes the `context` field element exactly as the orchestrator/contract does:
         * `keccak256(abi.encode(transactParams, noteData)) mod BN254_p`. snarkjs reduces the
         * 256-bit keccak input into the scalar field before it appears as a public signal.
         */
        function computeExpectedContext(
            transactParams: { processor: Address; data: Hex },
            noteData: readonly { hint: Hex; data: Hex }[],
        ): bigint {
            const encoded = encodeAbiParameters(CONTEXT_PREIMAGE_ABI, [
                { processor: transactParams.processor, data: transactParams.data },
                noteData.map((n) => ({ hint: n.hint, data: n.data })),
            ]);
            return BigInt(keccak256(encoded)) % BN254_SCALAR_MODULUS;
        }

        it("drives prepareBatchWithdraw into one item per note group", () => {
            expect(result.items).toHaveLength(3);
            // Each item carries a real proof with the 1x1 public-signal layout (8 signals).
            for (const item of result.items) {
                expect(item.proof.publicSignals).toHaveLength(8);
            }
        });

        it("verifies every returned item's real transact proof", { timeout: 120_000 }, async () => {
            for (const item of result.items) {
                expect(await proofService.verifyTransact(item.proof, 1, 1)).toBe(true);
            }
        });

        it("returns items whose shared stateRoot equals the seeded snapshot root", () => {
            const stateRoots = result.items.map((item) =>
                BigInt(item.proof.publicSignals[STATE_ROOT_INDEX]),
            );
            // All items prove against ONE snapshot...
            expect(new Set(stateRoots.map((r) => r.toString())).size).toBe(1);
            // ...and that snapshot is the actual Merkle root of the seeded leaves, not an
            // arbitrary constant the fake interactor happened to echo.
            for (const stateRoot of stateRoots) {
                expect(stateRoot).toBe(expectedStateRoot);
            }
        });

        it("spends exactly the seeded notes' nullifiers, one per item in group order", () => {
            // MULTISET equality: the per-item nullifierHash signals must be EXACTLY the set
            // derived from the seeded notes. A dropped, duplicated, or foreign-note item
            // changes this multiset. (1x1 => one nullifier at index 0 per item.)
            const actual = result.items
                .map((item) => BigInt(item.proof.publicSignals[NULLIFIER_INDEX]).toString())
                .sort();
            const expected = [...expectedNullifierByCommitment.values()]
                .map((n) => n.toString())
                .sort();
            expect(actual).toEqual(expected);

            // PER-INDEX binding: item[i] must spend groups[i]'s note. This pins ordering, so
            // a reversed/mis-ordered output array fails even though A and C share every other
            // signal — the multiset alone is order-insensitive; this is not.
            for (let i = 0; i < groups.length; i++) {
                const groupCommitment = groups[i].inputCommitments[0];
                const expectedNullifier = expectedNullifierByCommitment.get(groupCommitment);
                expect(expectedNullifier).toBeDefined();
                expect(BigInt(result.items[i].proof.publicSignals[NULLIFIER_INDEX])).toBe(
                    expectedNullifier,
                );
            }
        });

        it("binds each item's decoded routing to the intended per-group quote", () => {
            for (let i = 0; i < groups.length; i++) {
                const item = result.items[i];
                const [routing] = decodeAbiParameters(PAYOUT_ROUTING_ABI, item.transactParams.data);
                const expectedFee = computeBatchItemFee({
                    ...FEE_MODEL,
                    amountOut: groups[i].amountOut,
                });
                expect(routing.recipient.toLowerCase()).toBe(recipientAddress.toLowerCase());
                expect(routing.feeRecipient.toLowerCase()).toBe(relayAddress.toLowerCase());
                expect(routing.feeAmount).toBe(expectedFee);
                expect(routing.nativeGas).toBe(0n);
                // The processor is the relayer's payout processor for this batch.
                expect(item.transactParams.processor.toLowerCase()).toBe(
                    relayAddress.toLowerCase(),
                );
            }
        });

        it("binds each item's context to its intended routing and published noteData", () => {
            for (let i = 0; i < groups.length; i++) {
                const item = result.items[i];
                // Reconstruct the routing the batch SHOULD have bound for this group and
                // recompute context over it + the item's own published noteData. Asserting
                // equality proves the context signal is not merely distinct but pins the
                // exact recipient/feeRecipient/feeAmount/processor AND output note payloads.
                const expectedFee = computeBatchItemFee({
                    ...FEE_MODEL,
                    amountOut: groups[i].amountOut,
                });
                const intendedParams = {
                    processor: relayAddress,
                    data: encodeAbiParameters(PAYOUT_ROUTING_ABI, [
                        {
                            recipient: recipientAddress,
                            feeRecipient: relayAddress,
                            feeAmount: expectedFee,
                            nativeGas: 0n,
                        },
                    ]) as Hex,
                };
                const expectedContext = computeExpectedContext(intendedParams, item.noteData);
                expect(BigInt(item.proof.publicSignals[CONTEXT_INDEX])).toBe(expectedContext);
            }

            // Sanity: every context is still distinct across items (A and C share amount,
            // fee and routing, so distinctness here comes from the per-item noteData/output).
            const contexts = result.items.map((item) =>
                BigInt(item.proof.publicSignals[CONTEXT_INDEX]).toString(),
            );
            expect(new Set(contexts).size).toBe(result.items.length);
        });

        // BW-2 (TEST-7): the SELF-SUBMIT path exercised with REAL proofs — encodeRelayBatch
        // reshapes each real proof (formatForChain + restructure) into the relayBatch tuple.
        it(
            "prepareSelfSubmitBatch encodes a real-proof relayBatch with zero-fee routings",
            { timeout: 240_000 },
            async () => {
                const prepared = await orchestrator.prepareSelfSubmitBatch({
                    tokenId,
                    recipientAddress,
                    relayContractAddress: relayAddress,
                    groups,
                });

                expect(prepared.relayBatchTx.to).toBe(relayAddress);
                expect(prepared.relayBatchTx.value).toBe("0x0");
                expect(prepared.spentNotes).toHaveLength(3);

                const { functionName, args } = decodeFunctionData({
                    abi: PP_RELAY_BATCH_ABI,
                    data: prepared.relayBatchTx.data,
                });
                expect(functionName).toBe("relayBatch");
                const [proofs, batchParams, batchNoteData] = args as unknown as [
                    { pubSignals: readonly (readonly bigint[])[] }[],
                    { data: Hex }[],
                    unknown[],
                ];
                expect(proofs).toHaveLength(3);
                expect(batchParams).toHaveLength(3);
                expect(batchNoteData).toHaveLength(3);

                for (let i = 0; i < 3; i++) {
                    // The reshaped proof is REAL: its stateRoot public signal (2D layout [2][0])
                    // equals the seeded snapshot root — a mock/empty proof would not.
                    expect(proofs[i].pubSignals[2][0]).toBe(expectedStateRoot);
                    // Zero-fee routing to the user's own recipient (no relayer fee).
                    const [routing] = decodeAbiParameters(PAYOUT_ROUTING_ABI, batchParams[i].data);
                    expect(routing.feeAmount).toBe(0n);
                    expect(routing.recipient.toLowerCase()).toBe(recipientAddress.toLowerCase());
                }
            },
        );
    },
);
