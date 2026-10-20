import { buildPoseidon } from "circomlibjs";

import type {
    Hex,
    IHashService,
    ILogger,
    PoseidonHashServiceDependencies,
    PoseidonInstance,
} from "../internal.js";
import {
    FailedToHashInputs,
    FailedToInitializePoseidon,
    HashInputSchema,
    HashServiceNotInitialized,
    InvalidHashInputs,
} from "../internal.js";

/**
 * Implementation of the HashService interface for the Poseidon hash function.
 */
export class PoseidonHashService implements IHashService {
    /**
     * The Poseidon instance.
     * It is built lazily to avoid unnecessary initialization overhead.
     */
    private poseidonInstance: PoseidonInstance | null = null;

    private readonly logger?: ILogger;

    /**
     * @param dependencies - Optional dependencies for the PoseidonHashService.
     * @param dependencies.logger - The logger to use.
     */
    private constructor(dependencies?: PoseidonHashServiceDependencies) {
        this.logger = dependencies?.logger;
    }

    private async initialize(): Promise<PoseidonHashService> {
        try {
            this.logger?.debug("Initializing Poseidon hash service...");
            this.poseidonInstance = await buildPoseidon();
            this.logger?.debug("Poseidon hash service initialized successfully");

            return this;
        } catch (error) {
            this.logger?.error("Error initializing Poseidon hash service", { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new FailedToInitializePoseidon(
                `Failed to initialize Poseidon hash service: ${errorMessage || "Unknown error"}`,
            );
        }
    }

    /**
     * @inheritdoc IHashService.hash
     */
    hash(inputs: Hex[]): Hex {
        if (!this.poseidonInstance) {
            throw new HashServiceNotInitialized("Poseidon instance not initialized");
        }

        const validatedInputs = HashInputSchema.safeParse(inputs);

        if (!validatedInputs.success) {
            throw new InvalidHashInputs(
                `Invalid inputs: ${validatedInputs.error.issues[0].message}`,
            );
        }

        try {
            this.logger?.debug("Hashing inputs...", { inputCount: inputs.length });
            const montgomeryHash = this.poseidonInstance(inputs);
            const hash = this.poseidonInstance.F.toObject(montgomeryHash);
            this.logger?.debug("Hashed inputs successfully", { hash });

            return `0x${hash.toString(16).padStart(64, "0")}`;
        } catch (error) {
            this.logger?.error("Error hashing inputs", { error });
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new FailedToHashInputs(
                `Failed to hash inputs: ${errorMessage || "Unknown error"}`,
            );
        }
    }

    static async create(): Promise<PoseidonHashService> {
        return new PoseidonHashService().initialize();
    }
}
