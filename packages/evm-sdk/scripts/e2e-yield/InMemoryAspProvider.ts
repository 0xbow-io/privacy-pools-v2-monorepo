/**
 * In-memory ASP data provider for the LOCAL yield E2E.
 *
 * Replaces the HTTP/IPFS ASP server. It holds the same leaves the script
 * registers on-chain (`leaf = Poseidon([label])`), so the SDK's `ASPClient`
 * — which verifies that the LeanIMT root of the provider's leaves equals the
 * on-chain `latestASPRoot` — accepts them and can build valid ASP Merkle
 * proofs for the transact witness.
 *
 * The ASP public key is a real X25519 keypair generated for this run; the
 * deposit `aspCiphertext` is encrypted to it (matching the production deposit
 * path), even though nothing decrypts it in this local test.
 */
import type {
    EventSnapshot,
    Hash,
    Hex,
    IASPDataProvider,
    LabelStatus,
    NoteEvent,
    PublicKey,
} from "../../src/internal.js";

export class InMemoryAspProvider implements IASPDataProvider {
    private leaves: Hash[] = [];
    private root: Hash = "0x0" as Hash;

    constructor(private readonly aspPublicKey: PublicKey) {}

    /** Replace the leaf set + root (called after each on-chain `updateASPRoot`). */
    setState(leaves: Hash[], root: Hash): void {
        this.leaves = [...leaves];
        this.root = root;
    }

    async getRoot(): Promise<Hash> {
        return this.root;
    }

    async getLeaves(): Promise<Hash[]> {
        return [...this.leaves];
    }

    async getLabelStatus(_labelHash: Hash): Promise<LabelStatus> {
        return { isApproved: true } as unknown as LabelStatus;
    }

    async getASPPublicKey(): Promise<PublicKey> {
        return this.aspPublicKey;
    }

    async getEventSnapshot(): Promise<EventSnapshot> {
        throw new Error("InMemoryAspProvider.getEventSnapshot not used in the yield E2E");
    }

    async getNoteEvents(
        _fromBlock?: Hex,
        _toBlock?: Hex,
    ): Promise<{ events: NoteEvent[]; lastSyncedBlock: Hex }> {
        return { events: [], lastSyncedBlock: "0x0" as Hex };
    }
}
