/**
 * Result of parsing an IPFS CID: the original CID string, the content codec,
 * and the SHA-256 multihash digest bytes extracted from it.
 *
 * The codec decides what the digest covers. For raw CIDs (`CID_CODEC_RAW`)
 * the digest is the SHA-256 of the file bytes, so callers can compare it
 * against fetched bytes directly. For dag-pb CIDs (`CID_CODEC_DAG_PB`) the
 * digest covers a UnixFS block, not the file bytes — callers need a separate
 * digest (e.g. the manifest `*Sha256` fields) to verify content.
 */
export interface ParsedCID {
    readonly cidString: string;
    readonly codec: number;
    readonly digest: Uint8Array;
}
