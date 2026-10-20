import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type {
    Address,
    BuildTransactWitnessInputs,
    Hex,
    Secret,
    TransactCircuitInputs,
} from "../../src/internal.js";
import {
    COMMITMENT_LEAF_TAG,
    CryptoService,
    Groth16Prover,
    LocalCircuitArtifacts,
    MerkleService,
    NoteComputationService,
    NoteStatus,
    PoseidonHashService,
    ProofService,
    WitnessPreparationService,
} from "../../src/internal.js";

/**
 * GAP-4 (partial, artifact-gated) — SDK batch-withdraw REAL-PROOF path.
 *
 * The batch feature's core cryptographic claim is: N batch items, proven against
 * ONE shared pre-batch state snapshot, all carry the SAME `stateRoot` public
 * signal, while each item binds its own `context`. In production that flow is
 * `BatchWithdrawOrchestrator.prepareBatchWithdraw -> TransactOrchestrator.prepareTransact
 * -> WitnessPreparationService + ProofService (real Groth16)`.
 *
 * The full orchestrator wiring is exercised only by the non-fast docker
 * `batch.e2e.ts`. Driving `prepareBatchWithdraw` itself in a unit context is
 * tractable but requires ~10 fake interactors (keystore/asp/pool/rpc) plus a real
 * NoteManager seeded with a consistent multi-note state — see the report for the
 * exact recipe. This test instead proves the load-bearing invariant at the layer
 * the orchestrator delegates to: it builds TWO circuit-valid 1x1 transact
 * witnesses over ONE shared state snapshot using the REAL WitnessPreparationService
 * + NoteComputationService, generates REAL Groth16 proofs, and asserts:
 *   1. each proof VERIFIES (first fast-suite coverage of the transact real-proof
 *      path — only deposit was covered before);
 *   2. both share the same `stateRoot` public signal (shared-snapshot invariant);
 *   3. each item's `context` public signal is distinct (per-item binding).
 *
 * Transact public-signal layout for 1x1 (see relayer parsePubSignals):
 *   [0] nullifierHash, [1] outputCommitment, [2] stateRoot, [3] keystoreRoot,
 *   [4] associationSetRoot, [5] amountOut, [6] tokenIdOut, [7] context.
 */

const CIRCUITS_BUILD_DIR = resolve(__dirname, "../../../../packages/circuits/build");
const TRANSACT_WASM = resolve(CIRCUITS_BUILD_DIR, "transact_1x1/transact_1x1_js/transact_1x1.wasm");
const hasTransactArtifacts = existsSync(TRANSACT_WASM);

const STATE_ROOT_INDEX = 2;
const CONTEXT_INDEX = 7;

describe.skipIf(!hasTransactArtifacts)(
    "BatchWithdrawOrchestrator real-proof invariant (real artifacts)",
    () => {
        let hashService: PoseidonHashService;
        let noteComputationService: NoteComputationService;
        let witnessService: WitnessPreparationService;
        let proofService: ProofService;

        // Shared identity across both batch items.
        const ownerAddress = "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392" as Hex;
        const tokenId = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
        const privateNullifyingKey =
            "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
        const privateRevocableKey =
            "0x2222222222222222222222222222222222222222222222222222222222222222" as Secret;
        const value = "0x64" as Hex; // 100
        const amountOut = "0x64" as Hex; // full withdraw -> change note is 0
        const createdAtBlock = "0x1" as Hex;

        // Built in beforeAll: the shared snapshot leaves + the two per-item witnesses.
        let stateLeaves: Hex[];
        let keystoreLeaves: Hex[];
        let aspLeaves: Hex[];
        const contexts: Hex[] = ["0x1111", "0x2222"] as Hex[];
        const witnesses: TransactCircuitInputs[] = [];

        // Per-item secrets/labels: distinct input notes, distinct change notes.
        const items = [
            {
                noteSecret:
                    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Secret,
                label: "0x0a" as Hex,
                changeNoteSecret:
                    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc1" as Secret,
            },
            {
                noteSecret:
                    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Secret,
                label: "0x0b" as Hex,
                changeNoteSecret:
                    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc2" as Secret,
            },
        ];

        beforeAll(async () => {
            hashService = await PoseidonHashService.create();
            const merkleService = new MerkleService({ hashService });
            const cryptoService = new CryptoService();
            noteComputationService = new NoteComputationService({ hashService, cryptoService });
            witnessService = new WitnessPreparationService({
                noteComputationService,
                hashService,
                merkleService,
            });
            const circuitArtifacts = new LocalCircuitArtifacts({ baseDir: CIRCUITS_BUILD_DIR });
            proofService = new ProofService({
                circuitArtifacts,
                groth16Prover: new Groth16Prover(),
            });

            // --- Shared keystore leaf (same owner + keys for both items) ---
            const authDigest = noteComputationService.computeAuthDigest(privateRevocableKey);
            const nullKeyHash = hashService.hash([privateNullifyingKey]);
            const keystoreLeaf = hashService.hash([ownerAddress, nullKeyHash, authDigest]);
            keystoreLeaves = [keystoreLeaf];

            // --- Per-item derived note commitments + leaves for the SHARED snapshot ---
            const perItem = items.map((it) => {
                const noteAddressHash = noteComputationService.computeNoteAddressHash(
                    ownerAddress,
                    it.noteSecret,
                );
                const commitment = noteComputationService.computeFullCommitment({
                    noteAddressHash,
                    tokenId,
                    value,
                    label: it.label,
                });
                const timestampedLeaf = hashService.hash([
                    COMMITMENT_LEAF_TAG,
                    commitment,
                    createdAtBlock,
                ]);
                const labelHash = noteComputationService.computeLabelHash(it.label);
                const changeNoteAddressHash = noteComputationService.computeNoteAddressHash(
                    ownerAddress,
                    it.changeNoteSecret,
                );
                return {
                    ...it,
                    noteAddressHash,
                    commitment,
                    timestampedLeaf,
                    labelHash,
                    changeNoteAddressHash,
                };
            });

            // ONE shared snapshot: both items' input leaves live in the same arrays,
            // so every proof computes its stateRoot over the identical leaf set.
            stateLeaves = perItem.map((p) => p.timestampedLeaf);
            aspLeaves = perItem.map((p) => p.labelHash);

            for (let i = 0; i < perItem.length; i++) {
                const p = perItem[i]!;
                const inputs: BuildTransactWitnessInputs = {
                    inputNotes: [
                        {
                            noteAddressHash: p.noteAddressHash,
                            commitment: p.commitment,
                            value,
                            tokenId,
                            label: p.label,
                            status: NoteStatus.ACTIVE,
                            ownerAddress: ownerAddress as Address,
                            noteSecret: p.noteSecret,
                            isOwned: true,
                            createdAtBlock,
                            spentAtBlock: null,
                            txHash: "0x00" as Hex,
                        },
                    ],
                    // Full withdraw: single zero-value change note carrying the input label.
                    changeNotes: [
                        {
                            noteAddressHash: p.changeNoteAddressHash,
                            commitment: "0x00" as Hex, // recomputed in-circuit from the fields below
                            value: "0x0" as Hex,
                            tokenId,
                            label: p.label,
                            status: NoteStatus.PENDING,
                            ownerAddress: ownerAddress as Address,
                            noteSecret: p.changeNoteSecret,
                            isOwned: true,
                        },
                    ],
                    recipientNotes: [],
                    ownerAddress,
                    privateNullifyingKey: privateNullifyingKey as unknown as Hex,
                    privateRevocableKey: privateRevocableKey as unknown as Hex,
                    tokenId: tokenId as unknown as Hex,
                    amountOut,
                    tokenIdOut: tokenId as unknown as Hex,
                    context: contexts[i]!,
                    stateLeaves,
                    keystoreLeaves,
                    aspLeaves,
                };
                witnesses.push(await witnessService.buildTransactWitness(inputs));
            }
        });

        it("builds two witnesses that share the snapshot stateRoot", () => {
            expect(witnesses).toHaveLength(2);
            // Both witnesses reference the same shared state snapshot.
            expect(witnesses[0]!.stateRoot).toBe(witnesses[1]!.stateRoot);
        });

        it(
            "generates and verifies two real 1x1 transact proofs",
            { timeout: 120_000 },
            async () => {
                const proof0 = await proofService.proveTransact(witnesses[0]!, 1, 1);
                const proof1 = await proofService.proveTransact(witnesses[1]!, 1, 1);

                expect(await proofService.verifyTransact(proof0, 1, 1)).toBe(true);
                expect(await proofService.verifyTransact(proof1, 1, 1)).toBe(true);

                // Invariant 1: both items share the SAME stateRoot public signal.
                expect(proof0.publicSignals[STATE_ROOT_INDEX]).toBe(
                    proof1.publicSignals[STATE_ROOT_INDEX],
                );
                // Sanity: the proof's stateRoot equals the shared witness snapshot
                // root (compared numerically — the proof emits an unpadded hex
                // integer while the witness carries a zero-padded 32-byte value).
                expect(BigInt(proof0.publicSignals[STATE_ROOT_INDEX]!)).toBe(
                    BigInt(witnesses[0]!.stateRoot),
                );

                // Invariant 2: each item binds its own, distinct context.
                expect(proof0.publicSignals[CONTEXT_INDEX]).not.toBe(
                    proof1.publicSignals[CONTEXT_INDEX],
                );
            },
        );
    },
);
