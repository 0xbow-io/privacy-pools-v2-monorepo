//! Shared types for Privacy Pools V2 Stellar contracts.
//!
//! Contains Groth16 proof types, verification key structures,
//! and common data types used across all contracts.

#![no_std]

use soroban_sdk::{contracttype, Bytes, BytesN};
// Note: soroban_sdk::Vec is re-exported in contracttype structs

/// Size of a BN254 field element in bytes.
pub const FIELD_ELEMENT_SIZE: u32 = 32;

/// Size of a G1 point (uncompressed: x + y coordinates).
pub const G1_SIZE: u32 = 64;

/// Size of a G2 point (uncompressed: x0 + x1 + y0 + y1 coordinates).
pub const G2_SIZE: u32 = 128;

/// Size of a Groth16 proof (A: G1 + B: G2 + C: G1).
pub const PROOF_SIZE: u32 = 256;

/// BN254 scalar field modulus (Fr, NOT Fq).
/// 21888242871839275222246405745257275088548364400416034343698204186575808495617
/// = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
pub const SNARK_SCALAR_FIELD_BYTES: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
    0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Groth16 verification key bytes.
#[contracttype]
#[derive(Clone, Debug)]
pub struct VerificationKeyBytes {
    /// Alpha G1 point (64 bytes).
    pub alpha: BytesN<64>,
    /// Beta G2 point (128 bytes).
    pub beta: BytesN<128>,
    /// Gamma G2 point (128 bytes).
    pub gamma: BytesN<128>,
    /// Delta G2 point (128 bytes).
    pub delta: BytesN<128>,
    /// IC points (vector of G1 points, 64 bytes each).
    pub ic: soroban_sdk::Vec<BytesN<64>>,
}

/// Groth16 proof (A, B, C curve points).
#[contracttype]
#[derive(Clone, Debug)]
pub struct Groth16Proof {
    /// Proof point A (G1, 64 bytes).
    pub a: BytesN<64>,
    /// Proof point B (G2, 128 bytes).
    pub b: BytesN<128>,
    /// Proof point C (G1, 64 bytes).
    pub c: BytesN<64>,
}

/// Proof type identifier for VK lookup.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum ProofType {
    /// Deposit proof (4 public signals: outputCommitment, tokenId, value, context).
    Deposit = 0,
    /// Transact proof (6 + N + M public signals).
    Transact = 1,
    /// Ragequit proof (7 public signals).
    Ragequit = 2,
}

/// Discovery data for an output note.
///
/// Matches EVM's `NoteData { hint, data }` struct.
/// `hint` is an indexed tag for RPC-level log filtering (opaque to the contract).
/// `data` is the encrypted note payload (opaque to the contract).
#[contracttype]
#[derive(Clone, Debug)]
pub struct NoteData {
    /// Indexed tag for note discovery filtering.
    pub hint: BytesN<32>,
    /// Encrypted note payload.
    pub data: Bytes,
}

