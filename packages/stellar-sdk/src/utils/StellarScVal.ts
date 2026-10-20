import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

import type { NoteData, StellarProof } from "../internal.js";

/** Converts a `0x`-prefixed hex string into raw bytes for a Soroban `Bytes`/`BytesN` argument. */
function hexToBuffer(hex: string): Buffer {
    return Buffer.from(hex.slice(2), "hex");
}

/** Builds a Soroban `U256` argument from a bigint or a `0x`-prefixed hex string. */
export function u256ScVal(value: bigint | string): xdr.ScVal {
    return nativeToScVal(typeof value === "bigint" ? value : BigInt(value), { type: "u256" });
}

/** Builds a Soroban `u128` argument from a bigint or a `0x`-prefixed hex string. */
export function u128ScVal(value: bigint | string): xdr.ScVal {
    return nativeToScVal(typeof value === "bigint" ? value : BigInt(value), { type: "u128" });
}

/** Builds a Soroban `i128` argument from a bigint or a `0x`-prefixed hex string. */
export function i128ScVal(value: bigint | string): xdr.ScVal {
    return nativeToScVal(typeof value === "bigint" ? value : BigInt(value), { type: "i128" });
}

/** Builds a Soroban `u32` argument. */
export function u32ScVal(value: number): xdr.ScVal {
    return nativeToScVal(value, { type: "u32" });
}

/** Builds a Soroban `u64` argument from a bigint. */
export function u64ScVal(value: bigint): xdr.ScVal {
    return nativeToScVal(value, { type: "u64" });
}

/** Builds a Soroban `bool` argument. */
export function boolScVal(value: boolean): xdr.ScVal {
    return xdr.ScVal.scvBool(value);
}

/** Builds a Soroban `Address` argument from a StrKey string (account "G..." or contract "C..."). */
export function addressScVal(value: string): xdr.ScVal {
    return nativeToScVal(value, { type: "address" });
}

/** Builds a Soroban `Bytes`/`BytesN<N>` argument from a `0x`-prefixed hex string. */
export function bytesScVal(hex: string): xdr.ScVal {
    return xdr.ScVal.scvBytes(hexToBuffer(hex));
}

/** Builds a Soroban `Vec<T>` argument. */
export function vecScVal(items: xdr.ScVal[]): xdr.ScVal {
    return xdr.ScVal.scvVec(items);
}

/**
 * Builds a Soroban `#[contracttype]` struct argument — a map with **Symbol**-keyed entries
 * (not String-keyed: `nativeToScVal` on a plain JS object produces String keys, which a Soroban
 * contract's `#[contracttype]`-derived `TryFromVal` rejects), sorted by field name to match the
 * canonical XDR map ordering every Soroban host enforces.
 */
export function structScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
    const entries = Object.keys(fields)
        .sort()
        .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] }));
    return xdr.ScVal.scvMap(entries);
}

/** Encodes a `Groth16Proof {a: BytesN<64>, b: BytesN<128>, c: BytesN<64>}` contract argument. */
export function groth16ProofScVal(proof: StellarProof): xdr.ScVal {
    return structScVal({
        a: bytesScVal(proof.a),
        b: bytesScVal(proof.b),
        c: bytesScVal(proof.c),
    });
}

/** Encodes a `NoteData {hint: BytesN<32>, data: Bytes}` contract argument. */
export function noteDataScVal(noteData: NoteData): xdr.ScVal {
    return structScVal({
        hint: bytesScVal(noteData.hint),
        data: bytesScVal(noteData.data),
    });
}
