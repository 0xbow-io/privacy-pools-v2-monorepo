/**
 * Multihash function code for SHA-256 per the multicodec table
 * (https://github.com/multiformats/multicodec). The only algorithm the SDK
 * accepts for CID content-addressing today; CIDs that pin any other hash
 * algorithm (blake2, sha3, etc.) are rejected so we never silently fall
 * back to "fetch and pray".
 */
export const MULTIHASH_SHA2_256_CODE = 0x12;

/**
 * CID content codec for raw blocks (multicodec `raw`). A raw CID's multihash
 * digest is the SHA-256 of the file bytes themselves, so fetched content can
 * be verified against the CID alone.
 */
export const CID_CODEC_RAW = 0x55;

/**
 * CID content codec for dag-pb / UnixFS (multicodec `dag-pb`). This is what
 * standard IPFS pinning (folder uploads, chunked large files) produces. The
 * multihash digest covers the root UnixFS block — a protobuf envelope, not
 * the file bytes — so content verification needs an out-of-band digest such
 * as the manifest `*Sha256` fields.
 */
export const CID_CODEC_DAG_PB = 0x70;

/**
 * SHA-256 of zero bytes. A manifest digest with this value means the digest
 * pipeline hashed a missing or empty file, not the artifact — no real circuit
 * artifact is empty. `IpfsCircuitArtifacts.validateManifestCIDs` rejects it
 * at construction so the broken manifest fails with a clear message instead
 * of a tampering error at first fetch.
 */
export const SHA256_OF_EMPTY_INPUT =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
