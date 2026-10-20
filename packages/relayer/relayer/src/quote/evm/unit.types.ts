import type { EvmAddress } from "../../config/evm/evm.types";

export type BPS = bigint & { readonly __brand: "BPS" };
export type Gas = bigint & { readonly __brand: "Gas" };
export type Wei = bigint & { readonly __brand: "Wei" };
export type EvmAddressEncoded = bigint & { readonly __brand: "EvmAddressEncoded" };

// Constructor functions
export const BPS = (value: bigint) => value as BPS;
export const Gas = (value: bigint) => value as Gas;
export const Wei = (value: bigint) => value as Wei;
export const EvmAddressEncoded = (value: EvmAddress) => BigInt(value) as EvmAddressEncoded;

type UnitTypes = BPS | Gas | Wei;

// same-type addition
export function add<T extends UnitTypes>(a: T, b: T): T {
    return (a + b) as unknown as T;
}

// same-type subtraction
export function sub<T extends UnitTypes>(a: T, b: T): T {
    return (a - b) as unknown as T;
}

// Gas x Wei (i.e. gasPrice) = Wei, scalar multiplication
export function mul(a: Gas, b: Wei): Wei;
export function mul(a: Wei, b: Gas): Wei;
export function mul<T extends UnitTypes>(a: T, b: bigint): T;
export function mul(a: bigint, b: bigint): bigint {
    return a * b;
}

// BPS application with built-in 10_000n division
export function applyBPS(bps: BPS, amount: Wei): Wei {
    return Wei((amount * bps) / 10_000n);
}
