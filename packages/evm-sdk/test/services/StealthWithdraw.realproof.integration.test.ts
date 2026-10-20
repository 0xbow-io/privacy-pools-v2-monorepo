import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { encodeAbiParameters, keccak256 } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

import type {
    Address,
    Hex,
    IASPClient,
    IKeystoreInteractor,
    IPoolVaultInteractor,
    IRPCInteractor,
    Label,
    RelayAndAnnounceRelayParams,
    Secret,
    TransactParams,
} from "../../src/internal.js";
import type { Hex as StealthHex } from "../../src/stealth/index.js";
import {
    BN254_SCALAR_MODULUS,
    COMMITMENT_LEAF_TAG,
    CryptoService,
    Groth16Prover,
    KeystoreManager,
    LocalCircuitArtifacts,
    MerkleService,
    NoteComputationService,
    NoteManager,
    NoteStatus,
    PAYOUT_ROUTING_ABI,
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
import {
    deriveStealthAddress,
    generateEphemeralKeyPair,
    resolveRecipient,
    SCHEME_CANONICAL,
    toStealthAnnouncementFields,
} from "../../src/stealth/index.js";

/**
 * INTL-05 stealth (E2E) — the M-2 canonical scheme → real withdrawal proof → M-1 relayAndAnnounce
 * request compose coherently at the SDK layer.
 *
 * Derives a CANONICAL (0x0001) stealth address through the now-reachable resolver (M-2), builds a REAL
 * transact withdrawal proof paying that stealth address, and assembles the RelayAndAnnounceRelayParams.
 * Asserts:
 *   1. the withdrawal proof VERIFIES against the transact_1x1 vkey;
 *   2. the proof's `context` public signal binds the PayoutRouting whose recipient IS the stealth
 *      address — i.e. the proof provably pays the stealth address;
 *   3. the assembled request's `announcement.stealthAddress` equals the withdrawal recipient — the exact
 *      invariant `PrivacyPoolRelay.relayAndAnnounce` enforces on-chain (advisory STLTH-18 made concrete).
 *
 * Public-signal layout (1x1): [0] nullifierHash, [1] outputCommitment, [2] stateRoot, [3] keystoreRoot,
 * [4] associationSetRoot, [5] amountOut, [6] tokenIdOut, [7] context.
 */

const CIRCUITS_BUILD_DIR = resolve(__dirname, "../../../../packages/circuits/build");
const TRANSACT_WASM = resolve(CIRCUITS_BUILD_DIR, "transact_1x1/transact_1x1_js/transact_1x1.wasm");
const hasTransactArtifacts = existsSync(TRANSACT_WASM);

const CONTEXT_INDEX = 7;

/** ABI of the context preimage: keccak256(abi.encode(TransactParams, NoteData[])) mod BN254_p. */
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

const bytesToHex = (bytes: Uint8Array): StealthHex => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s as unknown as StealthHex;
};

describe.skipIf(!hasTransactArtifacts)("stealth canonical withdraw + announce (real proof)", () => {
    const ownerAddress = "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392" as Address;
    const tokenId = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
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
    const amount = "0x32" as Hex; // 50
    const feeAmount = "0xa" as Hex; // 10
    const amountOut = "0x3c" as Hex; // 60

    let proofService: ProofService;
    let result: RelayAndAnnounceRelayParams;
    let stealthAddress: Address;
    let transactParams: TransactParams;
    let notesDataForContext: readonly { hint: Hex; data: Hex }[];

    beforeAll(async () => {
        const hashService = await PoseidonHashService.create();
        const merkleService = new MerkleService({ hashService });
        const cryptoService = new CryptoService();
        const noteComputationService = new NoteComputationService({ hashService, cryptoService });
        const witnessPreparationService = new WitnessPreparationService({
            noteComputationService,
            hashService,
            merkleService,
        });
        proofService = new ProofService({
            circuitArtifacts: new LocalCircuitArtifacts({ baseDir: CIRCUITS_BUILD_DIR }),
            groth16Prover: new Groth16Prover(),
        });

        // M-2: derive a CANONICAL stealth address through the public resolver (spending+viewing pair).
        const spendingPub = secp256k1.getPublicKey(randomBytes(32), /* compressed */ true);
        const viewingPub = secp256k1.getPublicKey(randomBytes(32), true);
        const metaAddress = resolveRecipient({
            kind: "canonical",
            spendingPubKey: bytesToHex(spendingPub),
            viewingPubKey: bytesToHex(viewingPub),
        });
        expect(metaAddress.scheme).toBe(SCHEME_CANONICAL);
        const ephemeral = generateEphemeralKeyPair(SCHEME_CANONICAL);
        const derivation = deriveStealthAddress(metaAddress, ephemeral, SCHEME_CANONICAL);
        stealthAddress = derivation.stealthAddress as unknown as Address;

        // Seed the owner's registered note + keystore leaf (normal path — owner already registered).
        const authDigest = noteComputationService.computeAuthDigest(privateRevocableKey);
        const nullKeyHash = hashService.hash([privateNullifyingKey]);
        const keystoreLeaf = hashService.hash([ownerAddress, nullKeyHash, authDigest]);

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
        const stateLeaves = [hashService.hash([COMMITMENT_LEAF_TAG, commitment, createdAtBlock])];
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
        const keystoreInteractor = {
            getKeystoreLeaves: async () => [keystoreLeaf],
            getNullifyingKeyHash: async () => "0x01",
        } as unknown as IKeystoreInteractor;
        const aspClient = {
            getAssociationSetLeaves: async () => aspLeaves,
        } as unknown as IASPClient;

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
            rpcInteractor: {} as unknown as IRPCInteractor,
            contextHashService: new EvmContextHashService(),
            payoutRoutingCodec: new EvmPayoutRoutingCodec(),
            relayBatchCodec: new EvmRelayBatchCodec(),
            addressFieldConverter: new EvmAddressFieldConverter(),
            addressEqualityComparator: new EvmAddressEqualityComparator(),
            addressSchema: AddressSchema,
        });

        // Bind the withdrawal to the stealth address via an explicit PayoutRouting.
        transactParams = {
            processor: relayAddress,
            data: encodeAbiParameters(PAYOUT_ROUTING_ABI, [
                {
                    recipient: stealthAddress,
                    feeRecipient: relayAddress,
                    feeAmount: BigInt(feeAmount),
                    nativeGas: 0n,
                },
            ]) as Hex,
        };

        const prepared = await orchestrator.prepareTransact({
            inputCommitments: [commitment],
            amount,
            tokenId,
            relayAddress,
            feeAmount,
            processorAddress: relayAddress,
            amountOut,
            recipientAddress: stealthAddress,
            transactParams,
        });
        notesDataForContext = prepared.notesData;

        // Assemble the atomic relay-and-announce request (M-1 SDK layer).
        result = {
            proof: prepared.proof,
            noteData: prepared.notesData,
            inputNullifierNumber: prepared.spentNotes.length,
            outputCommitmentNumber: prepared.changePendingNotes.length,
            signedFeeCommitment: {
                data: transactParams.data,
                asset: tokenId as Hex,
                expiration: Date.now() + 60_000,
                recipient: stealthAddress as Hex,
                amountSent: BigInt(amountOut).toString(),
                amountReceived: BigInt(amount).toString(),
                extraGas: false,
            } as RelayAndAnnounceRelayParams["signedFeeCommitment"],
            // Public bridge (G-1): no hand-assembly of the announcement fields.
            announcement: toStealthAnnouncementFields(derivation),
        };
    }, 240_000);

    it(
        "verifies the real withdrawal proof paying the stealth address",
        { timeout: 120_000 },
        async () => {
            expect(await proofService.verifyTransact(result.proof, 1, 1)).toBe(true);
        },
    );

    it("binds the proof context to the PayoutRouting whose recipient is the stealth address", () => {
        const encoded = encodeAbiParameters(CONTEXT_PREIMAGE_ABI, [
            { processor: transactParams.processor, data: transactParams.data },
            notesDataForContext.map((n) => ({ hint: n.hint, data: n.data })),
        ]);
        const expectedContext = BigInt(keccak256(encoded)) % BN254_SCALAR_MODULUS;
        expect(BigInt(result.proof.publicSignals[CONTEXT_INDEX])).toBe(expectedContext);
    });

    it("assembles a request whose announcement stealth address equals the withdrawal recipient", () => {
        // The exact invariant PrivacyPoolRelay.relayAndAnnounce enforces on-chain.
        expect(result.announcement.stealthAddress).toBe(stealthAddress);
        expect(BigInt(result.announcement.schemeId)).toBe(BigInt(SCHEME_CANONICAL));
    });
});
