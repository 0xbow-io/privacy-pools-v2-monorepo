import type { Hex, IMerkleService, LabelStatus } from "@privacy-pools-v2/core-sdk";
import { MerkleService, PoseidonHashService } from "@privacy-pools-v2/core-sdk";

/** The state transition a caller intends to make; committed only once publication succeeds. */
export interface AspPlan {
    /** The association-set leaf (`Poseidon(label)`) being added or removed. */
    leaf: Hex;
    /** The full leaf list after the transition. */
    leaves: Hex[];
    /** The root of `leaves` (`0n` for an empty set, matching the on-chain convention). */
    root: bigint;
}

export interface AspStateConfig {
    hashService: PoseidonHashService;
    merkleService: IMerkleService;
}

/**
 * The ASP's in-memory association set, chain-agnostic. Leaf format is produced by core-sdk's own
 * `PoseidonHashService` / `MerkleService`, so it is byte-identical to what `WitnessPreparationService`
 * expects — no independent hash reimplementation.
 *
 * Two roots are tracked on purpose: the locally-computed root of `leaves`, and the `publishedRoot`
 * the registry holds. They differ between an approval and its publication, which is exactly the
 * "approved but root not pushed yet" state the SDK must handle.
 */
export class AspState {
    private leafList: Hex[] = [];
    private readonly leafKeys = new Set<string>();
    private published = 0n;
    private readonly publishedHistory: bigint[] = [];
    private readonly overrides = new Map<string, LabelStatus>();

    static async create(): Promise<AspState> {
        const hashService = await PoseidonHashService.create();
        return new AspState({ hashService, merkleService: new MerkleService({ hashService }) });
    }

    constructor(private readonly config: AspStateConfig) {}

    get leaves(): readonly Hex[] {
        return this.leafList;
    }

    /** The root last published to the registry (`0n` until one is). */
    get publishedRoot(): bigint {
        return this.published;
    }

    /** The root published before the latest one, or `0n`. Used to fake a stale read. */
    get previousPublishedRoot(): bigint {
        return this.publishedHistory.at(-2) ?? 0n;
    }

    /** Seeds the served root from an already-published one, without recording history. */
    seedPublishedRoot(root: bigint): void {
        this.published = root;
    }

    /** @returns The association-set leaf for a raw deposit label. */
    leafForLabel(label: Hex): Hex {
        return this.config.hashService.hash([label]);
    }

    hasLeaf(leaf: Hex | bigint | string): boolean {
        return this.leafKeys.has(BigInt(leaf).toString());
    }

    /** Plans adding `label`'s leaf; nothing changes until {@link commit}. */
    async planApprove(label: Hex): Promise<AspPlan> {
        const leaf = this.leafForLabel(label);
        const leaves = this.hasLeaf(leaf) ? [...this.leafList] : [...this.leafList, leaf];
        return { leaf, leaves, root: await this.rootOf(leaves) };
    }

    /**
     * Plans removing `label`'s leaf.
     *
     * @returns The plan, or `null` when the label was never approved.
     */
    async planRevoke(label: Hex): Promise<AspPlan | null> {
        const leaf = this.leafForLabel(label);
        if (!this.hasLeaf(leaf)) return null;
        const key = BigInt(leaf).toString();
        const leaves = this.leafList.filter((l) => BigInt(l).toString() !== key);
        return { leaf, leaves, root: await this.rootOf(leaves) };
    }

    /**
     * Commits a plan.
     *
     * @param plan - A plan from {@link planApprove} / {@link planRevoke}.
     * @param published - Whether the plan's root was published to the registry.
     */
    commit(plan: AspPlan, published: boolean): void {
        this.leafList = plan.leaves;
        this.leafKeys.clear();
        for (const leaf of plan.leaves) this.leafKeys.add(BigInt(leaf).toString());
        if (published) {
            this.published = plan.root;
            this.publishedHistory.push(plan.root);
        }
    }

    /** Statuses set via the admin API win over the derived approved/pending status. */
    setStatusOverride(leaf: Hex | bigint | string, status: LabelStatus): void {
        this.overrides.set(BigInt(leaf).toString(), status);
    }

    clearOverrides(): void {
        this.overrides.clear();
    }

    getStatusOverrides(): Record<string, LabelStatus> {
        return Object.fromEntries(this.overrides);
    }

    /** @param leaf - Decimal leaf as it appears in `/labels/{decimal}/status`. */
    statusOf(leaf: string): LabelStatus {
        const override = this.overrides.get(BigInt(leaf).toString());
        if (override) return override;
        return { status: this.hasLeaf(leaf) ? "approved" : "pending" };
    }

    private async rootOf(leaves: Hex[]): Promise<bigint> {
        return BigInt(await this.config.merkleService.computeRoot(leaves));
    }
}
