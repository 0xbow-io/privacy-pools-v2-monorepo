import { describe, expect, it } from "vitest";

import {
    CID_CODEC_DAG_PB,
    CID_CODEC_RAW,
    CIDDigestMismatch,
    InvalidCIDFormat,
    parseCID,
    verifyBytesAgainstCID,
} from "../../../src/internal.js";
import { cidFor, dagPbCidFor } from "../helpers/ipfsContent.js";

describe("IPFSContent", () => {
    describe("parseCID", () => {
        it("parse a valid CIDv1 with SHA-256 multihash", () => {
            const bytes = new Uint8Array([1, 2, 3, 4]);
            const cid = cidFor(bytes);
            const parsed = parseCID(cid);
            expect(parsed.cidString).toBe(cid);
            expect(parsed.digest).toBeInstanceOf(Uint8Array);
            expect(parsed.digest.length).toBe(32);
        });

        it("report the raw codec for raw CIDs and dag-pb for UnixFS CIDs", () => {
            const bytes = new Uint8Array([1, 2, 3, 4]);
            expect(parseCID(cidFor(bytes)).codec).toBe(CID_CODEC_RAW);
            expect(parseCID(dagPbCidFor(bytes)).codec).toBe(CID_CODEC_DAG_PB);
            // CIDv0 is always dag-pb — what folder pinning produces.
            expect(parseCID("QmNd4i6e1KPn477z7z56Q7renCgJj95d3t7EgiyZsfpGta").codec).toBe(
                CID_CODEC_DAG_PB,
            );
        });

        it("throw InvalidCIDFormat for a malformed CID", () => {
            expect(() => parseCID("not-a-cid")).toThrow(InvalidCIDFormat);
        });

        it("throw InvalidCIDFormat for an empty string", () => {
            expect(() => parseCID("")).toThrow(InvalidCIDFormat);
        });

        it("throw InvalidCIDFormat for a CID with unsupported multihash", () => {
            // bafkqac4 is a valid CIDv1 with identity multihash (0x00), not SHA-256.
            // We reject anything other than SHA-256 since we can only verify those.
            expect(() => parseCID("bafkqac4")).toThrow(InvalidCIDFormat);
        });
    });

    describe("verifyBytesAgainstCID", () => {
        it("accept bytes whose SHA-256 matches the CID's embedded multihash", () => {
            const bytes = new Uint8Array([10, 20, 30]);
            const cid = cidFor(bytes);
            expect(() => verifyBytesAgainstCID(bytes, cid)).not.toThrow();
        });

        it("throw CIDDigestMismatch when bytes differ by even a single byte", () => {
            const original = new Uint8Array([10, 20, 30]);
            const cid = cidFor(original);
            const tampered = new Uint8Array([10, 20, 31]);
            expect(() => verifyBytesAgainstCID(tampered, cid)).toThrow(CIDDigestMismatch);
        });

        it("throw CIDDigestMismatch when bytes are completely different", () => {
            const cid = cidFor(new Uint8Array([1, 2, 3]));
            expect(() => verifyBytesAgainstCID(new Uint8Array([4, 5, 6]), cid)).toThrow(
                CIDDigestMismatch,
            );
        });

        it("throw CIDDigestMismatch when bytes are shorter than expected content", () => {
            const cid = cidFor(new Uint8Array([1, 2, 3, 4]));
            expect(() => verifyBytesAgainstCID(new Uint8Array([1, 2, 3]), cid)).toThrow(
                CIDDigestMismatch,
            );
        });

        it("throw InvalidCIDFormat when the CID itself is malformed", () => {
            expect(() => verifyBytesAgainstCID(new Uint8Array([1]), "not-a-cid")).toThrow(
                InvalidCIDFormat,
            );
        });

        it("accept empty bytes when the CID encodes the SHA-256 of empty", () => {
            const empty = new Uint8Array(0);
            const cid = cidFor(empty);
            expect(() => verifyBytesAgainstCID(empty, cid)).not.toThrow();
        });
    });
});
