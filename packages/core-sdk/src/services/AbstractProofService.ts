import type { Groth16Proof, NumericString, PublicSignals } from "snarkjs";

import type {
    CachedCircuitArtifacts,
    CircuitInputs,
    DepositProof,
    EVMProof,
    Hex,
    ICircuitArtifacts,
    IGroth16Prover,
    ILogger,
    IProofService,
    Proof,
    ProofResult,
    ProofServiceConfig,
    ProofServiceDependencies,
    RagequitProof,
    TransactProof,
    VerificationKey,
} from "../internal.js";

import {
    CircuitArtifactLoadFailed,
    CircuitInputsSchema,
    Groth16ProofSchema,
    Groth16PublicSignalsSchema,
    InvalidProof,
    InvalidTransactDimensions,
    InvalidWitness,
    ProofGenerationFailed,
    ProofResultSchema,
    ProofVerificationFailed,
    TransactDimensionsSchema,
} from "../internal.js";

/**
 * Chain-agnostic base for {@link IProofService} implementations, generic over the chain's
 * on-chain-verifier proof format `TProof`. Generates and verifies Groth16 ZK proofs using
 * snarkjs — has no protocol knowledge, receives opaque witnesses and delegates to the injected
 * {@link IGroth16Prover}. Every piece of this is chain-agnostic except reshaping a proof into
 * the target chain's on-chain verifier calldata format, left to extenders (`ProofService`'s
 * `formatForChain` returns {@link EVMProof}; a `StellarProofService`'s returns its own shape).
 */
export abstract class AbstractProofService<TProof = EVMProof> implements IProofService<TProof> {
    private readonly logger?: ILogger;
    private readonly groth16Prover: IGroth16Prover;
    private readonly circuitArtifacts: ICircuitArtifacts;
    private readonly artifactCache = new Map<string, CachedCircuitArtifacts>();
    private readonly vkeyCache = new Map<string, VerificationKey>();

    /**
     * Constructs a new AbstractProofService.
     * @param config - The configuration for the ProofService.
     * @param config.circuitArtifacts - The circuit artifacts to use.
     * @param config.groth16Prover - The Groth16 prover/verifier to use.
     * @param dependencies - Optional dependencies for the ProofService.
     * @param dependencies.logger - The logger to use.
     */
    constructor(config: ProofServiceConfig, dependencies?: ProofServiceDependencies) {
        this.circuitArtifacts = config.circuitArtifacts;
        this.groth16Prover = config.groth16Prover;
        this.logger = dependencies?.logger;
    }

    /**
     * @inheritdoc IProofService.proveDeposit
     * @throws {InvalidWitness} If the witness fails schema validation.
     * @throws {CircuitArtifactLoadFailed} If circuit artifacts cannot be loaded.
     * @throws {ProofGenerationFailed} If snarkjs proof generation fails.
     */
    async proveDeposit(witness: CircuitInputs): Promise<DepositProof> {
        return this.generateProof("deposit", witness);
    }

    /**
     * @inheritdoc IProofService.proveTransact
     * @throws {InvalidTransactDimensions} If nInputs or mOutputs are out of range.
     * @throws {InvalidWitness} If the witness fails schema validation.
     * @throws {CircuitArtifactLoadFailed} If circuit artifacts cannot be loaded.
     * @throws {ProofGenerationFailed} If snarkjs proof generation fails.
     */
    async proveTransact(
        witness: CircuitInputs,
        nInputs: number,
        mOutputs: number,
    ): Promise<TransactProof> {
        this.validateTransactDimensions(nInputs, mOutputs);
        return this.generateProof(`transact_${nInputs}x${mOutputs}`, witness);
    }

    /**
     * @inheritdoc IProofService.proveRagequit
     * @throws {InvalidWitness} If the witness fails schema validation.
     * @throws {CircuitArtifactLoadFailed} If circuit artifacts cannot be loaded.
     * @throws {ProofGenerationFailed} If snarkjs proof generation fails.
     */
    async proveRagequit(witness: CircuitInputs): Promise<RagequitProof> {
        return this.generateProof("ragequit", witness);
    }

    /**
     * @inheritdoc IProofService.verifyDeposit
     * @throws {InvalidProof} If the proof structure fails schema validation.
     * @throws {CircuitArtifactLoadFailed} If the verification key cannot be loaded.
     * @throws {ProofVerificationFailed} If snarkjs verification throws.
     */
    async verifyDeposit(proof: DepositProof): Promise<boolean> {
        return this.verifyProof("deposit", proof);
    }

    /**
     * @inheritdoc IProofService.verifyTransact
     * @throws {InvalidTransactDimensions} If nInputs or mOutputs are out of range.
     * @throws {InvalidProof} If the proof structure fails schema validation.
     * @throws {CircuitArtifactLoadFailed} If the verification key cannot be loaded.
     * @throws {ProofVerificationFailed} If snarkjs verification throws.
     */
    async verifyTransact(
        proof: TransactProof,
        nInputs: number,
        mOutputs: number,
    ): Promise<boolean> {
        this.validateTransactDimensions(nInputs, mOutputs);
        return this.verifyProof(`transact_${nInputs}x${mOutputs}`, proof);
    }

    /**
     * @inheritdoc IProofService.verifyRagequit
     * @throws {InvalidProof} If the proof structure fails schema validation.
     * @throws {CircuitArtifactLoadFailed} If the verification key cannot be loaded.
     * @throws {ProofVerificationFailed} If snarkjs verification throws.
     */
    async verifyRagequit(proof: RagequitProof): Promise<boolean> {
        return this.verifyProof("ragequit", proof);
    }

    /**
     * @inheritdoc IProofService.loadCircuit
     * @throws {CircuitArtifactLoadFailed} If the artifacts cannot be loaded.
     */
    async loadCircuit(circuitName: string): Promise<void> {
        await this.loadArtifacts(circuitName);
    }

    /**
     * @inheritdoc IProofService.formatForChain
     */
    abstract formatForChain(proofResult: ProofResult): TProof;

    private validateTransactDimensions(nInputs: number, mOutputs: number): void {
        this.logger?.debug("Validating transact dimensions...", { nInputs, mOutputs });
        const result = TransactDimensionsSchema.safeParse({ nInputs, mOutputs });
        if (!result.success) {
            throw new InvalidTransactDimensions(
                `Invalid transact dimensions: nInputs=${nInputs}, mOutputs=${mOutputs}. Both must be integers between 1 and 5.`,
            );
        }
        this.logger?.debug("Transact dimensions validated successfully", { nInputs, mOutputs });
    }

    private async generateProof(circuitName: string, witness: CircuitInputs): Promise<ProofResult> {
        // Never log the full witness — `CircuitInputs` includes noteSecret,
        // privateNullifyingKey, depositSecret, and Merkle siblings. A
        // `logger.debug` of the raw witness leaks every secret needed to spend
        // the resulting note to any log sink (file, third-party APM, browser
        // console) — M-1 (line 16). Log only the safe metadata.
        this.logger?.debug("Generating proof...", {
            circuitName,
            witnessFields: Object.keys(witness as object),
        });
        this.validateWitness(witness);

        const { wasm, provingKey } = await this.loadArtifacts(circuitName);

        try {
            const { proof, publicSignals } = await this.groth16Prover.fullProve(
                witness,
                wasm,
                provingKey,
            );
            this.logger?.info("Proof generated successfully");
            // Public signals are on-chain and safe to log. The proof bytes
            // themselves are public outputs, also safe.
            this.logger?.debug("Public signals", { circuitName, publicSignals });

            return {
                proof: this.grothProofToHex(proof),
                publicSignals: this.publicSignalsToHex(publicSignals),
            };
        } catch (error) {
            this.logger?.error("Error generating proof", { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new ProofGenerationFailed(
                `Failed to generate proof for circuit "${circuitName}": ${errorMessage}`,
            );
        }
    }

    private validateWitness(witness: CircuitInputs): void {
        // Do not log the witness contents — see generateProof (M-1).
        this.logger?.debug("Validating witness...");
        const result = CircuitInputsSchema.safeParse(witness);
        if (!result.success) {
            throw new InvalidWitness(`Invalid witness: ${result.error.issues[0].message}`);
        }
        this.logger?.debug("Witness validated successfully");
    }

    private async loadArtifacts(circuitName: string): Promise<CachedCircuitArtifacts> {
        this.logger?.debug("Loading artifacts...", { circuitName });
        const cached = this.artifactCache.get(circuitName);
        if (cached) {
            this.logger?.debug("Artifacts loaded from cache", { circuitName });
            return cached;
        }

        try {
            const [wasm, provingKey] = await Promise.all([
                this.circuitArtifacts.getWasm(circuitName),
                this.circuitArtifacts.getProvingKey(circuitName),
            ]);

            this.logger?.info("Artifacts loaded successfully", { circuitName });

            const artifacts = { wasm, provingKey };
            this.logger?.debug("Artifacts set in cache", { circuitName });
            this.artifactCache.set(circuitName, artifacts);

            return artifacts;
        } catch (error) {
            this.logger?.error("Error loading artifacts", { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new CircuitArtifactLoadFailed(
                `Failed to load artifacts for circuit "${circuitName}": ${errorMessage}`,
            );
        }
    }

    private grothProofToHex(proof: Groth16Proof): Proof {
        const result = Groth16ProofSchema.safeParse(proof);
        if (!result.success) {
            throw new InvalidProof(`Invalid Groth16 proof: ${result.error.issues[0].message}`);
        }

        this.logger?.debug("Groth16 proof converted to hex", { proof });

        return {
            pi_a: proof.pi_a.map((p) => this.numericStringToHex(p)),
            pi_b: proof.pi_b.map((p) => p.map((p) => this.numericStringToHex(p))),
            pi_c: proof.pi_c.map((p) => this.numericStringToHex(p)),
            protocol: proof.protocol,
            curve: proof.curve,
        };
    }

    private publicSignalsToHex(publicSignals: PublicSignals): Hex[] {
        this.logger?.debug("Converting public signals to hex...", { publicSignals });
        const result = Groth16PublicSignalsSchema.safeParse(publicSignals);
        if (!result.success) {
            throw new InvalidProof(
                `Invalid Groth16 public signals: ${result.error.issues[0].message}`,
            );
        }

        return publicSignals.map((s) => this.numericStringToHex(s));
    }

    private async verifyProof(circuitName: string, proofResult: ProofResult): Promise<boolean> {
        this.logger?.debug("Verifying proof...", { circuitName, proofResult });
        this.validateProofResult(proofResult);

        this.logger?.debug("Loading verification key...", { circuitName });
        const vkey = await this.loadVerificationKey(circuitName);
        this.logger?.debug("Verification key loaded successfully", { circuitName });

        try {
            const verified = await this.groth16Prover.verify(
                vkey,
                this.publicSignalsFromHex(proofResult.publicSignals),
                this.grothProofFromHex(proofResult.proof),
            );

            this.logger?.info("Proof verified successfully", { circuitName });
            this.logger?.debug("Verification result", { circuitName, verified });

            return verified;
        } catch (error) {
            this.logger?.error("Error verifying proof", { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new ProofVerificationFailed(
                `Failed to verify proof for circuit "${circuitName}": ${errorMessage}`,
            );
        }
    }

    private validateProofResult(proofResult: ProofResult): void {
        const result = ProofResultSchema.safeParse(proofResult);
        if (!result.success) {
            throw new InvalidProof(`Invalid proof structure: ${result.error.issues[0].message}`);
        }
    }

    private async loadVerificationKey(circuitName: string): Promise<VerificationKey> {
        this.logger?.debug("Loading verification key...", { circuitName });
        const cached = this.vkeyCache.get(circuitName);
        if (cached) {
            this.logger?.debug("Verification key loaded from cache", { circuitName });
            return cached;
        }

        try {
            const vkeyBytes = await this.circuitArtifacts.getVerificationKey(circuitName);
            this.logger?.info("Verification key bytes loaded successfully", { circuitName });
            this.logger?.debug("Decoding verification key bytes...", { circuitName });

            const vkeyJson = new TextDecoder().decode(vkeyBytes);
            const vkey = JSON.parse(vkeyJson) as VerificationKey;
            this.logger?.debug("Verification key parsed successfully", { circuitName, vkey });

            this.vkeyCache.set(circuitName, vkey);
            this.logger?.debug("Verification key set in cache", { circuitName });

            return vkey;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new CircuitArtifactLoadFailed(
                `Failed to load verification key for circuit "${circuitName}": ${errorMessage}`,
            );
        }
    }

    private grothProofFromHex(proof: Proof): Groth16Proof {
        return {
            pi_a: proof.pi_a.map((p) => this.numericStringFromHex(p)),
            pi_b: proof.pi_b.map((p) => p.map((p) => this.numericStringFromHex(p))),
            pi_c: proof.pi_c.map((p) => this.numericStringFromHex(p)),
            protocol: proof.protocol,
            curve: proof.curve,
        };
    }

    private publicSignalsFromHex(publicSignals: Hex[]): PublicSignals {
        return publicSignals.map((s) => this.numericStringFromHex(s));
    }

    private numericStringToHex(numericString: NumericString): Hex {
        return `0x${BigInt(numericString).toString(16)}` as Hex;
    }

    private numericStringFromHex(hex: Hex): NumericString {
        return BigInt(hex).toString(10);
    }
}
