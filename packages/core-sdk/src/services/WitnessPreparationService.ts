import type {
    BuildDepositWitnessInputs,
    BuildRagequitWitnessInputs,
    BuildTransactWitnessInputs,
    DepositCircuitInputs,
    Hex,
    IHashService,
    ILogger,
    IMerkleService,
    INoteComputationService,
    IWitnessPreparationService,
    MerkleProof,
    RagequitCircuitInputs,
    RagequitWitness,
    Secret,
    TransactCircuitInputs,
    WitnessPreparationServiceConfig,
    WitnessPreparationServiceDependencies,
} from "../internal.js";
import {
    AddressSchema,
    ASSOCIATION_SET_MAX_DEPTH,
    BuildDepositWitnessInputsSchema,
    COMMITMENT_LEAF_TAG,
    InvalidDepositWitnessInputs,
    InvalidRagequitWitnessInputs,
    InvalidTransactWitnessInputs,
    KEYSTORE_MAX_DEPTH,
    makeBuildRagequitWitnessInputsSchema,
    makeBuildTransactWitnessInputsSchema,
    METADATA_STANDARD,
    STATE_MAX_DEPTH,
    WitnessPreparationFailed,
} from "../internal.js";

/**
 * Implementation of the WitnessPreparationService interface.
 * Transforms raw domain inputs into structured witnesses for deposit, transact, and ragequit circuits.
 * This is the only place in the SDK that understands circuit input structure.
 */
export class WitnessPreparationService implements IWitnessPreparationService {
    private readonly noteComputationService: INoteComputationService;
    private readonly hashService: IHashService;
    private readonly merkleService: IMerkleService;
    private readonly buildTransactWitnessInputsSchema: ReturnType<
        typeof makeBuildTransactWitnessInputsSchema<string>
    >;
    private readonly buildRagequitWitnessInputsSchema: ReturnType<
        typeof makeBuildRagequitWitnessInputsSchema<string>
    >;
    private readonly logger?: ILogger;

    /**
     * Creates a new WitnessPreparationService instance.
     * @param config - The configuration for the WitnessPreparationService.
     * @param config.noteComputationService - The note computation service for shared hash chain computations.
     * @param config.hashService - The hash service for witness-internal Poseidon hashes (commitment, nullifier, keystore leaf, timestamped leaf, label hash).
     * @param config.merkleService - The merkle service to use for proof generation.
     * @param config.addressSchema - Validates embedded notes' `tokenId`/`ownerAddress` against the chain's real address shape.
     * @param dependencies - Optional dependencies for the WitnessPreparationService.
     * @param dependencies.logger - The logger to use.
     */
    constructor(
        config: WitnessPreparationServiceConfig,
        dependencies?: WitnessPreparationServiceDependencies,
    ) {
        this.noteComputationService = config.noteComputationService;
        this.hashService = config.hashService;
        this.merkleService = config.merkleService;
        const addressSchema = config.addressSchema ?? AddressSchema;
        this.buildTransactWitnessInputsSchema = makeBuildTransactWitnessInputsSchema(addressSchema);
        this.buildRagequitWitnessInputsSchema = makeBuildRagequitWitnessInputsSchema(addressSchema);
        this.logger = dependencies?.logger;
    }

    /**
     * @inheritdoc IWitnessPreparationService.buildDepositWitness
     * @throws {InvalidDepositWitnessInputs} If the inputs fail schema validation.
     * @throws {WitnessPreparationFailed} If witness construction fails.
     */
    async buildDepositWitness(inputs: BuildDepositWitnessInputs): Promise<DepositCircuitInputs> {
        const validated = BuildDepositWitnessInputsSchema.safeParse(inputs);
        if (!validated.success) {
            throw new InvalidDepositWitnessInputs(
                "Invalid deposit witness inputs: " + validated.error.issues[0].message,
            );
        }

        const { tokenId, value, context, depositSecret, noteAddressHash } = validated.data;

        return {
            tokenId,
            value,
            context,
            noteAddressHash,
            depositSecret,
        };
    }

    /**
     * @inheritdoc IWitnessPreparationService.buildTransactWitness
     * @throws {InvalidTransactWitnessInputs} If the inputs fail schema validation.
     * @throws {WitnessPreparationFailed} If witness construction fails.
     */
    async buildTransactWitness(inputs: BuildTransactWitnessInputs): Promise<TransactCircuitInputs> {
        const validated = this.buildTransactWitnessInputsSchema.safeParse(inputs);
        if (!validated.success) {
            const issue = validated.error.issues[0];
            const path = issue.path.length > 0 ? ` (at ${issue.path.join(".")})` : "";
            throw new InvalidTransactWitnessInputs(
                `Invalid transact witness inputs: ${issue.message}${path}`,
            );
        }

        const {
            inputNotes,
            changeNotes,
            recipientNotes,
            ownerAddress,
            privateNullifyingKey,
            privateRevocableKey,
            tokenId,
            amountOut,
            tokenIdOut,
            context,
            stateLeaves,
            keystoreLeaves,
            aspLeaves,
            pendingKeystoreRegistration,
        } = validated.data;

        const outputNotes = [...changeNotes, ...(recipientNotes ?? [])];

        this.logger?.debug("Building transact witness...", {
            inputCount: inputNotes.length,
            outputCount: outputNotes.length,
        });

        try {
            // 1. Compute authorization
            const authDigest = this.noteComputationService.computeAuthDigest(privateRevocableKey);
            const keystoreLeaf = this.computeKeystoreLeaf(
                ownerAddress,
                privateNullifyingKey,
                authDigest,
            );

            // 2. Generate keystore merkle proof. For a bundled registerAndRelay the owner's leaf is
            // not on-chain yet, so anchor to the PREDICTED post-insertion root: append the just-
            // computed leaf at the next index and prove membership against that tree. `keystoreLeaf`
            // here is identical to the leaf `setAuthPolicyWithSig` will insert (same owner + keys),
            // so the predicted root matches the actual post-registration root by construction.
            const keystoreLeavesForProof = pendingKeystoreRegistration
                ? [...keystoreLeaves, keystoreLeaf]
                : keystoreLeaves;
            const keystoreProof = await this.merkleService.generateMerkleProof(
                keystoreLeavesForProof,
                keystoreLeaf,
            );

            // 3. Process input notes
            const stateProofs: MerkleProof[] = [];
            const aspProofs: MerkleProof[] = [];
            const noteSecrets: Hex[] = [];
            const values: Hex[] = [];
            const labels: Hex[] = [];
            const timestamps: Hex[] = [];

            for (const note of inputNotes) {
                const commitment = note.commitment;
                const timestampedLeaf = this.computeTimestampedLeaf(
                    commitment,
                    note.createdAtBlock,
                );
                const labelHash = this.noteComputationService.computeLabelHash(note.label);

                noteSecrets.push(note.noteSecret);
                values.push(note.value);
                labels.push(note.label);
                timestamps.push(note.createdAtBlock);

                const stateProof = await this.merkleService.generateMerkleProof(
                    stateLeaves,
                    timestampedLeaf,
                );
                stateProofs.push(stateProof);

                const aspProof = await this.merkleService.generateMerkleProof(aspLeaves, labelHash);
                aspProofs.push(aspProof);
            }

            // 4. Structure witness matching Transact circuit signal spec
            const witness: TransactCircuitInputs = {
                // Public inputs (roots from proofs)
                stateRoot: stateProofs[0].root,
                keystoreRoot: keystoreProof.root,
                associationSetRoot: aspProofs[0].root,
                amountOut,
                tokenIdOut,
                context,

                // Authorization
                ownerAddress,
                privateNullifyingKey,
                privateRevocableKey,
                keystoreLeafIndex: this.numberToHex(keystoreProof.index),
                keystoreSiblings: this.merkleService.padSiblings(
                    keystoreProof.siblings,
                    KEYSTORE_MAX_DEPTH,
                ),
                keystoreTreeDepth: this.numberToHex(keystoreProof.siblings.length),

                // Per input note
                noteSecret: noteSecrets,
                value: values,
                tokenId,
                label: labels,
                stateLeafIndex: stateProofs.map((p) => this.numberToHex(p.index)),
                stateSiblings: stateProofs.map((p) =>
                    this.merkleService.padSiblings(p.siblings, STATE_MAX_DEPTH),
                ),
                stateTreeDepth: stateProofs.map((p) => this.numberToHex(p.siblings.length)),
                associationSetLeafIndex: aspProofs.map((p) => this.numberToHex(p.index)),
                associationSetSiblings: aspProofs.map((p) =>
                    this.merkleService.padSiblings(p.siblings, ASSOCIATION_SET_MAX_DEPTH),
                ),
                associationSetTreeDepth: aspProofs.map((p) => this.numberToHex(p.siblings.length)),
                timestamp: timestamps,

                // Per output note
                outputNoteAddressHash: outputNotes.map((o) => o.noteAddressHash),
                outputValue: outputNotes.map((o) => o.value),
                outputLabel: outputNotes.map((o) => o.label),
            };

            return witness;
        } catch (error) {
            this.logger?.error("Error building transact witness", { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new WitnessPreparationFailed(`Failed to build transact witness: ${errorMessage}`);
        }
    }

    /**
     * @inheritdoc IWitnessPreparationService.buildRagequitWitness
     * @throws {InvalidRagequitWitnessInputs} If the inputs fail schema validation.
     * @throws {WitnessPreparationFailed} If witness construction fails.
     */
    async buildRagequitWitness(inputs: BuildRagequitWitnessInputs): Promise<RagequitWitness> {
        const validated = this.buildRagequitWitnessInputsSchema.safeParse(inputs);
        if (!validated.success) {
            throw new InvalidRagequitWitnessInputs(
                "Invalid ragequit witness inputs: " + validated.error.issues[0].message,
            );
        }

        const {
            note,
            ownerAddress,
            privateNullifyingKey,
            privateRevocableKey,
            tokenId,
            label,
            keystoreLeaves,
        } = validated.data;

        this.logger?.debug("Building ragequit witness...", { ownerAddress, tokenId });

        try {
            // 1. Compute authorization
            const authDigest = this.noteComputationService.computeAuthDigest(privateRevocableKey);
            const keystoreLeaf = this.computeKeystoreLeaf(
                ownerAddress,
                privateNullifyingKey,
                authDigest,
            );

            // 2. Generate keystore merkle proof
            const keystoreProof = await this.merkleService.generateMerkleProof(
                keystoreLeaves,
                keystoreLeaf,
            );

            // 3. Compute note values
            const commitment = note.commitment;
            const nullifierHash = this.noteComputationService.computeNullifier(
                privateNullifyingKey,
                commitment,
            );

            // 4. Structure witness matching Ragequit circuit signal spec
            const witness: RagequitCircuitInputs = {
                // Public inputs
                keystoreRoot: keystoreProof.root,
                ownerAddress,
                value: note.value,
                tokenId,
                label,

                // Private inputs
                noteSecret: note.noteSecret,
                metadata: METADATA_STANDARD,
                privateNullifyingKey,
                privateRevocableKey,
                keystoreLeafIndex: this.numberToHex(keystoreProof.index),
                keystoreSiblings: this.merkleService.padSiblings(
                    keystoreProof.siblings,
                    KEYSTORE_MAX_DEPTH,
                ),
                keystoreTreeDepth: this.numberToHex(keystoreProof.siblings.length),
            };

            this.logger?.debug("Ragequit witness built successfully", {
                nullifierHash,
                commitment,
            });

            return { witness, nullifierHash, commitment };
        } catch (error) {
            this.logger?.error("Error building ragequit witness", { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new WitnessPreparationFailed(`Failed to build ragequit witness: ${errorMessage}`);
        }
    }

    /** Computes the note commitment: Poseidon(precommitment, label). */
    private computeCommitment(precommitment: Hex, label: Hex): Hex {
        return this.hashService.hash([precommitment, label]);
    }

    /** Computes the keystore leaf: Poseidon(ownerAddress, Poseidon(privateNullifyingKey), authDigest). */
    private computeKeystoreLeaf(
        ownerAddress: Hex,
        privateNullifyingKey: Secret,
        authDigest: Hex,
    ): Hex {
        const nullKeyHash = this.hashService.hash([privateNullifyingKey]);
        return this.hashService.hash([ownerAddress, nullKeyHash, authDigest]);
    }

    /** Computes the domain-tagged timestamped leaf: Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp). */
    private computeTimestampedLeaf(commitment: Hex, timestamp: Hex): Hex {
        return this.hashService.hash([COMMITMENT_LEAF_TAG, commitment, timestamp]);
    }

    private numberToHex(n: number): Hex {
        return `0x${n.toString(16)}` as Hex;
    }
}
