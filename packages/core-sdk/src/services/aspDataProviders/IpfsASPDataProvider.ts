import type {
    EventSnapshot,
    Hash,
    Hex,
    IASPDataProvider,
    IASPRegistryInteractor,
    IHTTPClient,
    ILogger,
    IpfsASPDataProviderConfig,
    IpfsASPDataProviderDependencies,
    LabelStatus,
    NoteEvent,
    PublicKey,
} from "../../internal.js";
import {
    ASPUnavailable,
    InvalidASPCID,
    InvalidCIDFormat,
    IPFSFetchFailed,
    IPFSLeavesPayloadSchema,
    verifyBytesAgainstCID,
} from "../../internal.js";

/** IPFS-based implementation of {@link IASPDataProvider}. */
export class IpfsASPDataProvider implements IASPDataProvider {
    private readonly ipfsGatewayUrl: string;
    private readonly aspRegistryInteractor: IASPRegistryInteractor;
    private readonly httpClient: IHTTPClient;
    private readonly logger?: ILogger;

    constructor(config: IpfsASPDataProviderConfig, dependencies?: IpfsASPDataProviderDependencies) {
        this.ipfsGatewayUrl = config.ipfsGatewayUrl.replace(/\/$/, "");
        this.aspRegistryInteractor = config.aspRegistryInteractor;
        this.httpClient = config.httpClient;
        this.logger = dependencies?.logger;
        this.logger?.debug("IpfsASPDataProvider initialized", {
            ipfsGatewayUrl: this.ipfsGatewayUrl,
        });
    }

    /**
     * @inheritdoc IASPDataProvider.getRoot
     * @throws {ContractCallError} When the on-chain read fails.
     */
    async getRoot(): Promise<Hash> {
        return this.aspRegistryInteractor.getLatestASPRoot();
    }

    /**
     * @inheritdoc IASPDataProvider.getLeaves
     * @throws {InvalidASPCID} When the on-chain CID is malformed or uses an unsupported multihash.
     * @throws {IPFSFetchFailed} When IPFS content retrieval fails, the fetched bytes
     *   do not match the CID's embedded multihash digest (gateway tampering), or the
     *   decoded JSON payload fails {@link IPFSLeavesPayloadSchema} validation.
     */
    async getLeaves(): Promise<Hash[]> {
        const { ipfsCID } = await this.aspRegistryInteractor.getLatestAssociationSetData();
        this.logger?.debug("Fetching leaves from IPFS", { cid: ipfsCID });
        const bytes = await this.fetchAndVerifyBinaryLeaves(ipfsCID);

        try {
            const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
            const result = IPFSLeavesPayloadSchema.safeParse(parsed);
            if (!result.success) {
                throw new IPFSFetchFailed(
                    `IPFS leaves payload failed schema validation: ${result.error.issues[0]!.message}`,
                );
            }
            return result.data.leaves as Hash[];
        } catch (error) {
            if (error instanceof IPFSFetchFailed) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new IPFSFetchFailed(`Failed to decode IPFS payload: ${message}`);
        }
    }

    /**
     * @inheritdoc IASPDataProvider.getLabelStatus
     * @throws {ASPUnavailable} Always — not supported via IPFS.
     */
    async getLabelStatus(_label: Hash): Promise<LabelStatus> {
        throw new ASPUnavailable("getLabelStatus is not supported via IPFS");
    }

    /**
     * @inheritdoc IASPDataProvider.getASPPublicKey
     * @throws {ASPUnavailable} Always — not supported via IPFS.
     */
    async getASPPublicKey(): Promise<PublicKey> {
        throw new ASPUnavailable("getASPPublicKey is not supported via IPFS");
    }

    /**
     * @inheritdoc IASPDataProvider.getEventSnapshot
     * @throws {ASPUnavailable} Always — not supported via IPFS.
     */
    async getEventSnapshot(): Promise<EventSnapshot> {
        throw new ASPUnavailable("getEventSnapshot is not supported via IPFS");
    }

    /**
     * @inheritdoc IASPDataProvider.getNoteEvents
     * @throws {ASPUnavailable} Always — not supported via IPFS.
     */
    async getNoteEvents(
        _fromBlock?: Hex,
        _toBlock?: Hex,
    ): Promise<{ events: NoteEvent[]; lastSyncedBlock: Hex }> {
        throw new ASPUnavailable("getNoteEvents is not supported via IPFS");
    }

    /**
     * Fetches raw bytes from the IPFS gateway and content-verifies them
     * against the SHA-256 multihash embedded in `ipfsCID` before returning.
     *
     * The multihash check is the cryptographic guarantee IPFS CIDs exist to
     * provide: any byte-level tampering by a compromised gateway (or
     * in-transit corruption) flips the digest and we refuse the response.
     * Errors are normalized to the ASPClient hierarchy so the outer
     * `ASPClient.tryProviders` fallback advances to the next provider on
     * any failure: malformed CIDs surface as {@link InvalidASPCID},
     * gateway / transport / digest-mismatch failures as
     * {@link IPFSFetchFailed} — both subclass {@link ASPUnavailable}.
     *
     * @throws {InvalidASPCID} When `ipfsCID` is malformed or uses an unsupported multihash.
     * @throws {IPFSFetchFailed} When the gateway fetch fails or the digest does not match.
     */
    private async fetchAndVerifyBinaryLeaves(ipfsCID: string): Promise<Uint8Array> {
        const url = `${this.ipfsGatewayUrl}/${ipfsCID}`;
        try {
            const bytes = await this.httpClient.getBinary(url);
            verifyBytesAgainstCID(bytes, ipfsCID);
            return bytes;
        } catch (error) {
            if (error instanceof InvalidCIDFormat) {
                throw new InvalidASPCID(error.message);
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new IPFSFetchFailed(message);
        }
    }
}
