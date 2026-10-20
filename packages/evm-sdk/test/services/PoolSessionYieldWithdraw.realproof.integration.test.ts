import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Mock } from "vitest";
import {
    decodeAbiParameters,
    decodeFunctionData,
    encodeAbiParameters,
    encodeFunctionData,
} from "viem";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
    Address,
    EVMProof,
    Hex,
    IASPClient,
    IKeystoreInteractor,
    IPoolVaultInteractor,
    IPPRouterInteractor,
    IRPCInteractor,
    Label,
    NoteData,
    PreparedTransaction,
    PreparedYieldWithdraw,
    PreparedYieldWithdrawRelay,
    Secret,
    TransactParams,
    TransactProof,
    WithdrawalFeeCommitment,
} from "../../src/internal.js";
import {
    bigintToHex,
    COMMITMENT_LEAF_TAG,
    CryptoService,
    Groth16Prover,
    InvalidTransactParams,
    KeystoreManager,
    LOCAL_FORK_YIELD_DEPLOYMENT,
    LocalCircuitArtifacts,
    MerkleService,
    NoteComputationService,
    NoteManager,
    NoteStatus,
    PAYOUT_ROUTING_ABI,
    POOL_VAULT_TRANSACT_ABI,
    EvmPoolSessionYieldWithdraw,
    PoseidonHashService,
    PP_ROUTER_WITHDRAW_ABI,
    ProofService,
    AddressSchema,
    EvmAddressEqualityComparator,
    EvmAddressFieldConverter,
    EvmContextHashService,
    EvmPayoutRoutingCodec,
    EvmRelayBatchCodec,
    TransactOrchestrator,
    WITHDRAW_SLIPPAGE_BPS,
    WitnessPreparationService,
    YIELD_BPS_DENOMINATOR,
} from "../../src/internal.js";

/**
 * GAP-1 (High) — REAL-PROOF coverage of the ACTUAL PoolSessionYieldWithdraw SESSION methods.
 *
 * The sibling `test/unit/services/PoolSessionYieldWithdraw.test.ts` drives both session methods,
 * but only against a FAKE orchestrator that echoes a hard-coded `PROOF` constant and returns
 * `proof: {}` — no genuine Groth16 proof ever flows through the decode -> re-encode path. The live
 * e2e (`scripts/e2e-yield/*.test.ts`) IMPORTS the class but hand-rolls the equivalent logic instead
 * of calling the methods, so the load-bearing decode/re-encode + relay guard + M-1 sizing never run
 * against a real proof.
 *
 * This test closes that gap. It wires the REAL {@link TransactOrchestrator} core (real
 * WitnessPreparationService + ProofService + Groth16, plus in-memory fake leaf-interactors serving
 * leaves consistent with a seeded {@link NoteManager} — the exact wiring the batch realproof test
 * uses for its `core`) into a real {@link PoolSessionYieldWithdraw}, and drives BOTH session methods
 * end-to-end on a genuine `transact_1x1` proof.
 *
 * `prepareYieldWithdraw` asserts:
 *   1. `withdrawTx` decodes as `PPRouter.withdrawToUnderlying` via `PP_ROUTER_WITHDRAW_ABI`;
 *   2. the proof embedded in `withdrawTx` is byte-identical to the EVM formatting of the REAL
 *      snarkjs proof the pipeline produced, and that real proof VERIFIES against the transact 1x1
 *      verification key (`proofService.verifyTransact`);
 *   3. the `PayoutRouting` bound into the transact context matches the intended recipient/fee;
 *   4. `minUnderlyingOut` equals the quoted floor `quoteWithdraw(recipientShares) * (1 - slippage)`.
 *
 * `prepareYieldWithdrawRelay` asserts:
 *   5. `relayParams.proof` (the raw snarkjs proof the relayer submits) VERIFIES;
 *   6. `relayParams.processorAddress == deployment.ppRouter`;
 *   7. `minUnderlyingOut` is sized from the CALLER's `amountOut - feeAmount` (M-1), never from the
 *      relayer's unverified `amountReceived`;
 *   8. the theft guard rejects a signed routing whose recipient != the caller BEFORE any proof is
 *      built (driving the real method, not a mock).
 *
 * The withdraw is a single-note FULL withdrawal (one input, one zero-value change note) — a 1x1
 * transaction matching the compiled `transact_1x1` artifact.
 *
 * Transact public-signal layout for 1x1:
 *   [0] nullifierHash, [1] outputCommitment, [2] stateRoot, [3] keystoreRoot,
 *   [4] associationSetRoot, [5] amountOut, [6] tokenIdOut, [7] context.
 *
 * Requires compiled circuit artifacts under packages/circuits/build/. Skipped otherwise.
 */

const CIRCUITS_BUILD_DIR = resolve(__dirname, "../../../../packages/circuits/build");
const TRANSACT_WASM = resolve(CIRCUITS_BUILD_DIR, "transact_1x1/transact_1x1_js/transact_1x1.wasm");
const hasTransactArtifacts = existsSync(TRANSACT_WASM);

const DEP = LOCAL_FORK_YIELD_DEPLOYMENT;

// The full ppUSDC-share value of the single seeded note (1 ppUSDC, 18 decimals).
const VALUE = 1_000_000_000_000_000_000n;
const VALUE_HEX = bigintToHex(VALUE);

// The fixed underlying (USDC) the router quotes for redeeming the recipient's shares.
const QUOTED_OUT = 1_020_000n; // 1.02 USDC after yield

describe.skipIf(!hasTransactArtifacts)(
    "PoolSessionYieldWithdraw session methods (real proof)",
    () => {
        const ownerAddress = "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392" as Address;
        const recipientAddress = "0x000000000000000000000000000000000000beef" as Address;
        const attackerAddress = "0x00000000000000000000000000000000deadbeef" as Address;
        const poolAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
        const tokenId = DEP.ppUSDC;
        const privateNullifyingKey =
            "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
        const privateRevocableKey =
            "0x2222222222222222222222222222222222222222222222222222222222222222" as Secret;
        const noteSecret =
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Secret;
        const label = "0x0a" as Label;
        const createdAtBlock = "0x1" as Hex;

        let session: EvmPoolSessionYieldWithdraw;
        let proofService: ProofService;
        // Records every REAL snarkjs proof the pipeline produced, in prepareTransact call order. Its
        // length also serves as the prepareTransact call count (one push per proof built).
        let capturedProofs: TransactProof[];

        let noteCommitment: Hex;
        let quoteWithdrawSpy: Mock<[bigint], Promise<bigint>>;

        // Session results generated once against real proofs.
        let withdrawResult: PreparedYieldWithdraw;
        let relayResult: PreparedYieldWithdrawRelay;

        /** A signed relayer PayoutRouting commitment for the relay path (honest by default). */
        function makeCommitment(overrides?: {
            routingRecipient?: Address;
        }): WithdrawalFeeCommitment {
            const routingRecipient = overrides?.routingRecipient ?? recipientAddress;
            const data = encodeAbiParameters(PAYOUT_ROUTING_ABI, [
                {
                    recipient: routingRecipient,
                    feeRecipient: routingRecipient,
                    feeAmount: 0n,
                    nativeGas: 0n,
                },
            ]) as Hex;
            return {
                data,
                asset: DEP.ppUSDC as Hex,
                expiration: Date.now() + 600_000,
                feeAmount: "0",
                signedRelayerCommitment: "0xdead" as Hex,
                recipient: routingRecipient as Hex,
                amountSent: VALUE.toString(),
                amountReceived: VALUE.toString(),
                extraGas: false,
            };
        }

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

            // Pass-through spy: capture every real snarkjs proof the orchestrator produces so the
            // withdraw path's embedded EVM proof can be bound to (and verified as) the genuine article.
            capturedProofs = [];
            const realProveTransact = proofService.proveTransact.bind(proofService);
            vi.spyOn(proofService, "proveTransact").mockImplementation(
                async (witness, nInputs, mOutputs) => {
                    const proof = await realProveTransact(witness, nInputs, mOutputs);
                    capturedProofs.push(proof);
                    return proof;
                },
            );

            // --- Seed ONE note + the leaf sets of a single pre-batch snapshot. ---
            const authDigest = noteComputationService.computeAuthDigest(privateRevocableKey);
            const nullKeyHash = hashService.hash([privateNullifyingKey]);
            const keystoreLeaf = hashService.hash([ownerAddress, nullKeyHash, authDigest]);
            const keystoreLeaves = [keystoreLeaf];

            const noteAddressHash = noteComputationService.computeNoteAddressHash(
                ownerAddress,
                noteSecret,
            );
            noteCommitment = noteComputationService.computeFullCommitment({
                noteAddressHash,
                tokenId,
                value: VALUE_HEX,
                label,
            });
            const stateLeaves: Hex[] = [
                hashService.hash([COMMITMENT_LEAF_TAG, noteCommitment, createdAtBlock]),
            ];
            const aspLeaves: Hex[] = [noteComputationService.computeLabelHash(label)];

            const noteManager = new NoteManager({});
            noteManager.addNote({
                noteAddressHash,
                commitment: noteCommitment,
                value: VALUE_HEX,
                tokenId,
                label,
                status: NoteStatus.ACTIVE,
                ownerAddress,
                noteSecret,
                isOwned: true,
                createdAtBlock,
                spentAtBlock: null,
                txHash: "0xab" as Hex,
            });

            const viewing = cryptoService.generateEphemeralKeyPair();
            const keystoreManager = new KeystoreManager({
                privateNullifyingKey,
                privateRevocableKey,
                viewingPrivateKey: viewing.privateKey,
                viewingPublicKey: viewing.publicKey,
                revocableKeyIndex: "0x0" as Hex,
            });

            // In-memory fake interactors serving leaves consistent with the seeded note. The
            // encodeTransact fake mirrors the REAL PoolVaultInteractor.encodeTransact byte-for-byte so
            // the session can decode the resulting PoolVault.transact calldata and re-encode it.
            const poolVaultInteractor = {
                getAddress: () => poolAddress,
                getStateLeaves: async () => stateLeaves,
                encodeTransact: (
                    proof: EVMProof,
                    transactPubSignals: bigint[][],
                    params: TransactParams,
                    noteData: NoteData[],
                ): PreparedTransaction => ({
                    to: poolAddress,
                    data: encodeFunctionData({
                        abi: POOL_VAULT_TRANSACT_ABI,
                        functionName: "transact",
                        args: [
                            {
                                pA: proof.pA,
                                pB: proof.pB,
                                pC: proof.pC,
                                pubSignals: transactPubSignals,
                            },
                            { processor: params.processor, data: params.data },
                            noteData,
                        ] as never,
                    }) as Hex,
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

            const orchestrator = new TransactOrchestrator({
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

            quoteWithdrawSpy = vi.fn(async (_shares: bigint) => QUOTED_OUT);
            const router = {
                getAddress: () => DEP.ppRouter,
                quote: vi.fn(async () => ({ underlyingNeeded: 0n, total: 0n })),
                quoteWithdraw: quoteWithdrawSpy,
                supplyBufferUnits: vi.fn(async () => 2n),
            } as unknown as IPPRouterInteractor;

            session = new EvmPoolSessionYieldWithdraw({ deployment: DEP, orchestrator, router });

            // Drive BOTH real session methods once. The note is never persisted as SPENT (we never call
            // persistNoteUpdates), so both calls prove against the same ACTIVE note / snapshot.
            withdrawResult = await session.prepareYieldWithdraw({
                inputCommitments: [noteCommitment],
                amount: VALUE,
                amountOut: VALUE,
                recipient: recipientAddress,
            });
            relayResult = await session.prepareYieldWithdrawRelay({
                inputCommitments: [noteCommitment],
                amount: VALUE,
                amountOut: VALUE,
                recipient: recipientAddress,
                signedFeeCommitment: makeCommitment(),
            });
        }, 240_000);

        it("re-encodes the withdraw as a PPRouter.withdrawToUnderlying call", () => {
            expect(withdrawResult.withdrawTx.to).toBe(DEP.ppRouter);
            const decoded = decodeFunctionData({
                abi: PP_ROUTER_WITHDRAW_ABI,
                data: withdrawResult.withdrawTx.data,
            });
            expect(decoded.functionName).toBe("withdrawToUnderlying");
        });

        it(
            "embeds a REAL transact 1x1 proof in the withdraw call that verifies",
            { timeout: 120_000 },
            async () => {
                // The withdraw path is the FIRST prepareTransact call.
                const captured = capturedProofs[0];
                expect(captured).toBeDefined();
                expect(captured.publicSignals).toHaveLength(8);

                // The genuine snarkjs proof the pipeline produced verifies against the 1x1 vkey.
                expect(await proofService.verifyTransact(captured, 1, 1)).toBe(true);

                // The proof embedded in withdrawTx is byte-identical to the EVM formatting of that exact
                // verified proof — so the re-encoded router call carries the real, valid proof.
                const [embeddedProof] = decodeFunctionData({
                    abi: PP_ROUTER_WITHDRAW_ABI,
                    data: withdrawResult.withdrawTx.data,
                }).args;
                const evm = proofService.formatForChain(captured);
                expect(embeddedProof.pA).toEqual([evm.pA[0], evm.pA[1]]);
                expect(embeddedProof.pB).toEqual([
                    [evm.pB[0][0], evm.pB[0][1]],
                    [evm.pB[1][0], evm.pB[1][1]],
                ]);
                expect(embeddedProof.pC).toEqual([evm.pC[0], evm.pC[1]]);
                // The router ABI carries pubSignals as uint256[][]; flattening recovers the 8 signals,
                // which must equal the real proof's public signals in order.
                const flatSignals = embeddedProof.pubSignals.flat();
                expect(flatSignals.map((s) => s.toString())).toEqual(
                    captured.publicSignals.map((s) => BigInt(s).toString()),
                );
            },
        );

        it("binds the intended PayoutRouting (recipient + zero fee) into the withdraw proof context", () => {
            const [, transactParams] = decodeFunctionData({
                abi: PP_ROUTER_WITHDRAW_ABI,
                data: withdrawResult.withdrawTx.data,
            }).args;
            expect(transactParams.processor.toLowerCase()).toBe(DEP.ppRouter.toLowerCase());

            const [routing] = decodeAbiParameters(PAYOUT_ROUTING_ABI, transactParams.data);
            expect((routing.recipient as string).toLowerCase()).toBe(
                recipientAddress.toLowerCase(),
            );
            // No explicit feeRecipient => defaults to recipient; full withdrawal => zero fee.
            expect((routing.feeRecipient as string).toLowerCase()).toBe(
                recipientAddress.toLowerCase(),
            );
            expect(routing.feeAmount).toBe(0n);
            expect(routing.nativeGas).toBe(0n);
        });

        it("sizes withdraw minUnderlyingOut as the default-slippage floor off quoteWithdraw", () => {
            // Full withdrawal, fee 0 => the recipient leg is the whole value.
            expect(quoteWithdrawSpy).toHaveBeenCalledWith(VALUE);
            expect(withdrawResult.recipientShares).toBe(VALUE);
            expect(withdrawResult.quotedUnderlyingOut).toBe(QUOTED_OUT);
            const expectedFloor =
                (QUOTED_OUT * (YIELD_BPS_DENOMINATOR - WITHDRAW_SLIPPAGE_BPS)) /
                YIELD_BPS_DENOMINATOR;
            expect(withdrawResult.minUnderlyingOut).toBe(expectedFloor);

            // The re-encoded router call carries exactly that floor.
            const [, , , minUnderlyingOut] = decodeFunctionData({
                abi: PP_ROUTER_WITHDRAW_ABI,
                data: withdrawResult.withdrawTx.data,
            }).args;
            expect(minUnderlyingOut).toBe(expectedFloor);
        });

        it(
            "returns relay params carrying a REAL transact 1x1 proof that verifies",
            { timeout: 120_000 },
            async () => {
                expect(relayResult.relayParams.proof.publicSignals).toHaveLength(8);
                expect(await proofService.verifyTransact(relayResult.relayParams.proof, 1, 1)).toBe(
                    true,
                );
            },
        );

        it("targets the PPRouter as the relayed-withdraw processor", () => {
            expect(relayResult.relayParams.processorAddress).toBe(DEP.ppRouter);
        });

        it("sizes relay minUnderlyingOut from amountOut-fee (M-1), not the relayer's amountReceived", () => {
            // Committed fee is 0 => recipient leg == amountOut == VALUE. The floor is quoted off the
            // caller's OWN recipient leg, so quoteWithdraw is called with VALUE (never the relayer's
            // amountReceived, which an adversarial relayer could under-report).
            expect(quoteWithdrawSpy).toHaveBeenCalledWith(VALUE);
            expect(relayResult.recipientShares).toBe(VALUE);
            const expectedFloor =
                (QUOTED_OUT * (YIELD_BPS_DENOMINATOR - WITHDRAW_SLIPPAGE_BPS)) /
                YIELD_BPS_DENOMINATOR;
            expect(relayResult.minUnderlyingOut).toBe(expectedFloor);
            expect(relayResult.relayParams.minUnderlyingOut).toBe(bigintToHex(expectedFloor));
        });

        it("rejects a signed routing whose recipient is not the caller (theft guard) before proving", async () => {
            // capturedProofs grows by one on every real prepareTransact/prove call.
            const before = capturedProofs.length;
            await expect(
                session.prepareYieldWithdrawRelay({
                    inputCommitments: [noteCommitment],
                    amount: VALUE,
                    amountOut: VALUE,
                    recipient: recipientAddress,
                    signedFeeCommitment: makeCommitment({ routingRecipient: attackerAddress }),
                }),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
            // The guard fires before the expensive proof build: no additional prove call happened.
            expect(capturedProofs.length).toBe(before);
        });
    },
);
