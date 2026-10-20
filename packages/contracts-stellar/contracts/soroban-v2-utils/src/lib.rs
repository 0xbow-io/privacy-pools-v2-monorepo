//! Shared utilities for Privacy Pools V2 Stellar contracts.
//!
//! Provides Poseidon hashing, Groth16 verification, BN254 field arithmetic,
//! and helper functions used across all contracts.

#![no_std]

use soroban_sdk::{Address, Bytes, Env, U256};
use contract_types::SNARK_SCALAR_FIELD_BYTES;

// Poseidon hash functions
pub mod poseidon;
pub mod poseidon_constants_t3;
pub mod poseidon_constants_t4;

// Groth16 verification
pub mod groth16;

// State structures
pub mod lean_imt;
pub mod root_buffer;

// Test vectors (only available in tests)
#[cfg(test)]
pub mod poseidon_test_vectors;

#[cfg(test)]
mod real_proof_tests;

// Re-export key functions for convenience
pub use groth16::verify_groth16;
pub use poseidon::{poseidon_hash_three, poseidon_hash_two};

/// Keccak256 hash of data, reduced to BN254 scalar field.
///
/// Computes `keccak256(data) % SNARK_SCALAR_FIELD`.
pub fn keccak256_mod_field(env: &Env, data: &[u8]) -> U256 {
    let hash = env.crypto().keccak256(&Bytes::from_slice(env, data));
    let hash_u256 = U256::from_be_bytes(env, &Bytes::from_slice(env, &hash.to_array()));
    let field = U256::from_be_bytes(env, &Bytes::from_slice(env, &SNARK_SCALAR_FIELD_BYTES));
    hash_u256.rem_euclid(&field)
}

/// Convert a Stellar address to a BN254 field element.
///
/// Computes `keccak256(strkey_bytes) % SNARK_SCALAR_FIELD`.
/// Uses the Stellar strkey representation (e.g. "G..." or "C...") for
/// a deterministic, canonical encoding of the address.
/// Analogous to Solana's `address_to_field(pubkey)`.
pub fn address_to_field(env: &Env, address: &Address) -> U256 {
    let strkey = address.to_string();
    let strkey_bytes = strkey.to_bytes();
    let hash = env.crypto().keccak256(&strkey_bytes);
    let hash_u256 = U256::from_be_bytes(env, &Bytes::from_slice(env, &hash.to_array()));
    let field = U256::from_be_bytes(env, &Bytes::from_slice(env, &SNARK_SCALAR_FIELD_BYTES));
    hash_u256.rem_euclid(&field)
}

/// Encode a Stellar token (SAC) address as a 160-bit token identifier.
///
/// Computes `keccak256(token_strkey_bytes) % 2^160` — the low 160 bits of the
/// keccak hash, mirroring how an EVM address is the low 160 bits of a keccak
/// hash. The v2 circuits constrain `tokenId < 2^160` (cffcaca9 INS-1) to keep
/// the in-circuit and on-chain canonical token id in lockstep; a full-field
/// (~254-bit) id would be rejected by the circuit. Owner addresses use
/// [`address_to_field`] (full field) since the circuits do not range-check them.
pub fn encode_token_id(env: &Env, token_address: &Address) -> U256 {
    let strkey = token_address.to_string();
    let strkey_bytes = strkey.to_bytes();
    let hash = env.crypto().keccak256(&strkey_bytes);
    let arr = hash.to_array();
    // Keep the low 160 bits (last 20 of 32 bytes); zero the high 12 bytes.
    let mut low = [0u8; 32];
    low[12..].copy_from_slice(&arr[12..]);
    U256::from_be_bytes(env, &Bytes::from_slice(env, &low))
}

/// Basis-point denominator for the vetting fee.
pub const MAX_FEE_BPS: u128 = 10_000;

/// The vetting fee on a deposit of `value`: `value × bps / 10_000`, truncating.
///
/// The single source of the fee formula (EVM: `FeeCalculator.calcFee`, audit N-2 / yield C1). The
/// pool charges it and the yield router must mint exactly enough shares to cover it; two
/// hand-written copies would be a drift hazard where a one-share disagreement makes the pool reject
/// a deposit only after the router has already minted. `None` on overflow.
pub fn vetting_fee(value: u128, bps: u32) -> Option<u128> {
    value.checked_mul(u128::from(bps)).map(|v| v / MAX_FEE_BPS)
}

#[cfg(test)]
mod test;
