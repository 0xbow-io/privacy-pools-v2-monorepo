import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";

import type {
    Address,
    Hex,
    IASPClient,
    IKeystoreInteractor,
    IPoolVaultInteractor,
    IRPCInteractor,
    Label,
    Secret,
} from "../../src/internal.js";
import {
    buildSetAuthPolicyTypedData,
    COMMITMENT_LEAF_TAG,
    CryptoService,
    Groth16Prover,
    KeystoreManager,
    LocalCircuitArtifacts,
    MerkleService,
    NoteComputationService,
    NoteManager,
    NoteStatus,
    PoseidonHashService,
    ProofService,
    AddressSchema,
    EvmAddressEqualityComparator,
    EvmAddressFieldConverter,
    EvmContextHashService,
    EvmPayoutRoutingCodec,
    EvmRelayBatchCodec,
    TransactOrchestrator,
    WitnessPreparationService,
} from "../../src/internal.js";

/**
 * INTL-05 (E2E) — REAL-PROOF coverage of the fresh-unfunded-recipient registerAndRelay flow.
 *
 * A recipient (Bob) holds a note but has NEVER registered his keystore auth policy on-chain, and
 * has no gas. The relayer will `registerAndRelay`: insert Bob's keystore leaf via
 * `setAuthPolicyWithSig`, then relay his withdrawal — in ONE transaction. So Bob's withdrawal proof
 * must anchor keystore membership to the PREDICTED post-insertion root (the tree AFTER his leaf is
 * inserted at the next index), a root that does not exist when the proof is built.
 *
 * This test drives the REAL {@link TransactOrchestrator} (real WitnessPreparationService +
 * ProofService + Groth16) with `pendingKeystoreRegistration: true`, over a keystore snapshot that
 * does NOT contain Bob's leaf, and asserts:
 *   1. the resulting transact proof VERIFIES against the transact_1x1 verification key — the circuit
 *      accepts the predicted root as valid keystore membership;
 *   2. the proof's `keystoreRoot` public signal equals the independently-computed predicted root
 *      (current leaves + Bob's leaf appended). This is the SAME leaf `setAuthPolicyWithSig` inserts
 *      (Poseidon(owner, Poseidon(nk), authDigest)) into the SAME LeanIMT the contract keeps, so the
 *      predicted root equals the actual post-registration root the contract will hold — cross-checked
 *      on-chain by `packages/contracts/test/integration/RegisterAndRelay.t.sol`;
 *   3. WITHOUT the flag, the same withdrawal is unprovable (Bob's leaf is absent from the current
 *      tree) — proving the predicted-root path is what makes the bundled flow reachable;
 *   4. the EIP-712 SetAuthPolicy payload the SDK builds is signed by Bob's own key and recovers to
 *      Bob's address — i.e. it matches what the Keystore's SignatureChecker will accept on-chain.
 *
 * Transact public-signal layout for 1x1:
 *   [0] nullifierHash, [1] outputCommitment, [2] stateRoot, [3] keystoreRoot,
 *   [4] associationSetRoot, [5] amountOut, [6] tokenIdOut, [7] context.
 */

const CIRCUITS_BUILD_DIR = resolve(__dirname, "../../../../packages/circuits/build");
const TRANSACT_WASM = resolve(CIRCUITS_BUILD_DIR, "transact_1x1/transact_1x1_js/transact_1x1.wasm");
const hasTransactArtifacts = existsSync(TRANSACT_WASM);

const KEYSTORE_ROOT_INDEX = 3;

// Bob's key: his EVM address is the keystore `account` AND the EIP-712 signer.
const BOB_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const KEYSTORE_ADDRESS = "0xabababababababababababababababababababab" as Address;
const CHAIN_ID = 11155111;

describe.skipIf(!hasTransactArtifacts)(
    "registerAndRelay fresh-recipient withdrawal (real proof)",
    () => {
        const account = privateKeyToAccount(BOB_PK);
        const ownerAddress = account.address.toLowerCase() as Address;
        const tokenId = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
        const recipientAddress = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
        const relayAddress = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;
        const poolAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
        const privateNullifyingKey =
            "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
        const privateRevocableKey =
            "0x2222222222222222222222222222222222222222222222222222222222222222" as Secret;
        const createdAtBlock = "0x1" as Hex;
        const noteSecret =
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Secret;
        const noteLabel = "0x0a" as Label;
        const noteValue = "0x64" as Hex; // 100

        // Bob withdraws 50 to the recipient + 10 fee (amountOut 60 leaves the pool), 40 change.
        const amount = "0x32" as Hex; // 50
        const feeAmount = "0xa" as Hex; // 10
        const amountOut = "0x3c" as Hex; // 60

        // A keystore snapshot of OTHER accounts — Bob's leaf is deliberately absent (he is unregistered).
        const otherKeystoreLeaves = ["0xdead", "0xbeef"] as Hex[];

        let proofService: ProofService;
        let orchestrator: TransactOrchestrator;
        let bobKeystoreLeaf: Hex;
        let predictedKeystoreRoot: bigint;
        let inputCommitment: Hex;

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
            proofService = new ProofService({
                circuitArtifacts: new LocalCircuitArtifacts({ baseDir: CIRCUITS_BUILD_DIR }),
                groth16Prover: new Groth16Prover(),
            });

            // Bob's keystore leaf — the exact preimage the circuit and setAuthPolicyWithSig both use.
            const authDigest = noteComputationService.computeAuthDigest(privateRevocableKey);
            const nullKeyHash = hashService.hash([privateNullifyingKey]);
            bobKeystoreLeaf = hashService.hash([ownerAddress, nullKeyHash, authDigest]);
            predictedKeystoreRoot = BigInt(
                await merkleService.computeRoot([...otherKeystoreLeaves, bobKeystoreLeaf]),
            );

            // Seed Bob's single note.
            const noteAddressHash = noteComputationService.computeNoteAddressHash(
                ownerAddress,
                noteSecret,
            );
            const commitment = noteComputationService.computeFullCommitment({
                noteAddressHash,
                tokenId,
                value: noteValue,
                label: noteLabel,
            });
            inputCommitment = commitment;
            const stateLeaves = [
                hashService.hash([COMMITMENT_LEAF_TAG, commitment, createdAtBlock]),
            ];
            const aspLeaves = [noteComputationService.computeLabelHash(noteLabel)];

            const noteManager = new NoteManager({});
            noteManager.addNote({
                noteAddressHash,
                commitment,
                value: noteValue,
                tokenId,
                label: noteLabel,
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

            const poolVaultInteractor = {
                getAddress: () => poolAddress,
                getStateLeaves: async () => stateLeaves,
                encodeTransact: () => ({ to: poolAddress, data: "0x" as Hex, value: "0x0" as Hex }),
            } as unknown as IPoolVaultInteractor;
            // Bob is NOT registered — the keystore snapshot omits his leaf.
            const keystoreInteractor = {
                getKeystoreLeaves: async () => otherKeystoreLeaves,
            } as unknown as IKeystoreInteractor;
            const aspClient = {
                getAssociationSetLeaves: async () => aspLeaves,
            } as unknown as IASPClient;

            orchestrator = new TransactOrchestrator({
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
                rpcInteractor: {} as unknown as IRPCInteractor,
                contextHashService: new EvmContextHashService(),
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                relayBatchCodec: new EvmRelayBatchCodec(),
                addressFieldConverter: new EvmAddressFieldConverter(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                addressSchema: AddressSchema,
            });
        }, 240_000);

        it(
            "builds a verifying withdrawal proof anchored to the predicted post-insertion keystore root",
            { timeout: 120_000 },
            async () => {
                const { proof } = await orchestrator.prepareTransact({
                    inputCommitments: [inputCommitment],
                    amount,
                    tokenId,
                    relayAddress,
                    feeAmount,
                    processorAddress: relayAddress,
                    amountOut,
                    recipientAddress,
                    pendingKeystoreRegistration: true,
                });

                // (1) The circuit accepts the predicted root as valid keystore membership.
                expect(await proofService.verifyTransact(proof, 1, 1)).toBe(true);

                // (2) The proof's keystoreRoot equals the independently-computed predicted root.
                expect(BigInt(proof.publicSignals[KEYSTORE_ROOT_INDEX])).toBe(
                    predictedKeystoreRoot,
                );
            },
        );

        it(
            "cannot prove the same withdrawal without the predicted-root flag (Bob's leaf is absent)",
            { timeout: 120_000 },
            async () => {
                await expect(
                    orchestrator.prepareTransact({
                        inputCommitments: [inputCommitment],
                        amount,
                        tokenId,
                        relayAddress,
                        feeAmount,
                        processorAddress: relayAddress,
                        amountOut,
                        recipientAddress,
                        // pendingKeystoreRegistration omitted -> anchors to the current tree, where
                        // Bob's leaf does not exist, so membership cannot be proven.
                    }),
                ).rejects.toThrow();
            },
        );

        it("produces a SetAuthPolicy signature that recovers to Bob's account", async () => {
            const typedData = buildSetAuthPolicyTypedData({
                keystoreAddress: KEYSTORE_ADDRESS,
                chainId: CHAIN_ID,
                account: ownerAddress,
                authDigest: bobKeystoreLeaf, // any 0x-uint256 works for the recovery check
                nullifyingKeyHash: "0x1" as Hex,
                deadline: "0xffffffffff" as Hex,
            });

            const signature = await account.signTypedData({
                domain: typedData.domain,
                types: typedData.types,
                primaryType: typedData.primaryType,
                message: typedData.message,
            });

            const valid = await verifyTypedData({
                address: account.address,
                domain: typedData.domain,
                types: typedData.types,
                primaryType: typedData.primaryType,
                message: typedData.message,
                signature,
            });
            expect(valid).toBe(true);
        });
    },
);
