import { sha256 } from "@noble/hashes/sha2.js";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { create as createDigest } from "multiformats/hashes/digest";

const SHA2_256_CODE = 0x12;

/**
 * Returns the CIDv1 (raw codec, SHA-256 multihash) string for the given bytes.
 * Tests that exercise the IPFS verification path supply CID + bytes pairs
 * produced by this helper so the multihash check inside `IpfsCircuitArtifacts`
 * and `IpfsASPDataProvider` passes for valid fixtures.
 */
export function cidFor(bytes: Uint8Array): string {
    const digest = sha256(bytes);
    const multihash = createDigest(SHA2_256_CODE, digest);
    return CID.createV1(raw.code, multihash).toString();
}

const DAG_PB_CODE = 0x70;

/**
 * Returns a CIDv1 (dag-pb codec, SHA-256 multihash) string. Real dag-pb CIDs
 * digest a UnixFS block, not the file bytes, so the digest here is computed
 * over a marker-prefixed copy of the bytes — guaranteeing it never equals
 * `sha256(bytes)`. Tests use this to assert the dag-pb verification path
 * relies on the manifest sha256 digest, never on the CID digest.
 */
export function dagPbCidFor(bytes: Uint8Array): string {
    const block = new Uint8Array([0x0a, ...bytes]);
    const multihash = createDigest(SHA2_256_CODE, sha256(block));
    return CID.createV1(DAG_PB_CODE, multihash).toString();
}
