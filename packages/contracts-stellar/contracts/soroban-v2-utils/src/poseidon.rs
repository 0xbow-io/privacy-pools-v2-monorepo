//! Poseidon hash functions for BN254.
//!
//! Wraps the low-level `poseidon_permutation` host function (CAP-0075)
//! with circom-compatible parameters (standard Poseidon, NOT Poseidon2).
//!
//! Uses the sponge construction: state = [0, inputs...], apply permutation,
//! return state[0].

use soroban_sdk::{symbol_short, Env, Symbol, U256, Vec};

use crate::poseidon_constants_t3;
use crate::poseidon_constants_t4;

/// BN254 field identifier for the host function.
fn bn254_symbol(_env: &Env) -> Symbol {
    symbol_short!("BN254")
}

/// Build the MDS matrix as Vec<Vec<U256>> from flat constant arrays.
fn build_mds(env: &Env, flat: &[[u8; 32]], t: u32) -> Vec<Vec<U256>> {
    let mut mds = Vec::new(env);
    let t_usize = t as usize;
    for i in 0..t_usize {
        let mut row = Vec::new(env);
        for j in 0..t_usize {
            let idx = i.checked_mul(t_usize).expect("mds overflow").checked_add(j).expect("mds overflow");
            row.push_back(u256_from_bytes(env, &flat[idx]));
        }
        mds.push_back(row);
    }
    mds
}

/// Build the round constants as Vec<Vec<U256>> from flat constant arrays.
fn build_round_constants(env: &Env, flat: &[[u8; 32]], t: u32, total_rounds: u32) -> Vec<Vec<U256>> {
    let mut rcs = Vec::new(env);
    let t_usize = t as usize;
    for r in 0..total_rounds as usize {
        let mut round = Vec::new(env);
        for j in 0..t_usize {
            let idx = r.checked_mul(t_usize).expect("rc overflow").checked_add(j).expect("rc overflow");
            round.push_back(u256_from_bytes(env, &flat[idx]));
        }
        rcs.push_back(round);
    }
    rcs
}

/// Convert a big-endian byte array to U256.
fn u256_from_bytes(env: &Env, bytes: &[u8; 32]) -> U256 {
    U256::from_be_bytes(env, &soroban_sdk::Bytes::from_slice(env, bytes))
}

/// Precomputed MDS + round-constants for Poseidon-2 (t=3).
///
/// Building these as `Vec<Vec<U256>>` is ~300K CPU (9 MDS entries +
/// 195 round constants → 204 `U256::from_be_bytes` calls). The host
/// function requires them as args every call. When a single entrypoint
/// does many Poseidon-2 hashes (LeanIMT walk, timestamped leaves, ...),
/// rebuilding each call wastes ~25M CPU at transact 5x5 (~85 calls).
///
/// Build once at the top of the entrypoint, pass to every
/// `poseidon_hash_two_ctx` / `lean_imt_insert` call.
pub struct PoseidonT3Ctx {
    mds: Vec<Vec<U256>>,
    rcs: Vec<Vec<U256>>,
}

impl PoseidonT3Ctx {
    /// Precompute the t=3 MDS matrix and round constants.
    ///
    /// Build this ONCE per entrypoint and pass it to every
    /// `poseidon_hash_two_ctx` / `lean_imt_insert` call — rebuilding it per
    /// hash is what makes a deep tree operation blow the CPU budget.
    pub fn new(env: &Env) -> Self {
        let mds = build_mds(env, &poseidon_constants_t3::MDS, poseidon_constants_t3::T);
        let rcs = build_round_constants(
            env,
            &poseidon_constants_t3::ROUND_CONSTANTS,
            poseidon_constants_t3::T,
            poseidon_constants_t3::ROUNDS_F
                .checked_add(poseidon_constants_t3::ROUNDS_P)
                .expect("overflow"),
        );
        Self { mds, rcs }
    }

    /// Expose the internal Vec references to the host permutation call.
    pub(crate) fn mds(&self) -> &Vec<Vec<U256>> { &self.mds }
    pub(crate) fn rcs(&self) -> &Vec<Vec<U256>> { &self.rcs }
}

/// Precomputed MDS + round-constants for Poseidon (t=4), the 3-input hash.
///
/// Same amortization rationale as [`PoseidonT3Ctx`]: building the
/// `Vec<Vec<U256>>` (16 MDS entries + 256 round constants) is expensive, and
/// the transact path now computes M+N domain-tagged 3-input state-tree leaves
/// (`Poseidon(TAG, value, timestamp)`) in a hot loop. Build once, share across
/// every `poseidon_hash_three_ctx` call.
pub struct PoseidonT4Ctx {
    mds: Vec<Vec<U256>>,
    rcs: Vec<Vec<U256>>,
}

impl PoseidonT4Ctx {
    /// Precompute the t=4 MDS matrix and round constants.
    ///
    /// Same rule as [`PoseidonT3Ctx::new`]: build once per entrypoint, reuse
    /// across every three-input hash.
    pub fn new(env: &Env) -> Self {
        let mds = build_mds(env, &poseidon_constants_t4::MDS, poseidon_constants_t4::T);
        let rcs = build_round_constants(
            env,
            &poseidon_constants_t4::ROUND_CONSTANTS,
            poseidon_constants_t4::T,
            poseidon_constants_t4::ROUNDS_F
                .checked_add(poseidon_constants_t4::ROUNDS_P)
                .expect("overflow"),
        );
        Self { mds, rcs }
    }

    pub(crate) fn mds(&self) -> &Vec<Vec<U256>> { &self.mds }
    pub(crate) fn rcs(&self) -> &Vec<Vec<U256>> { &self.rcs }
}

/// Poseidon hash of three BN254 field elements with a pre-built t=4 ctx.
///
/// Output is identical to [`poseidon_hash_three`]; only the constants
/// materialization is amortized across calls.
pub fn poseidon_hash_three_ctx(env: &Env, ctx: &PoseidonT4Ctx, a: &U256, b: &U256, c: &U256) -> U256 {
    let field = bn254_symbol(env);
    let zero = U256::from_u32(env, 0);

    // Initial state: [0 (capacity), a, b, c]
    let mut input = Vec::new(env);
    input.push_back(zero);
    input.push_back(a.clone());
    input.push_back(b.clone());
    input.push_back(c.clone());

    let result = env.crypto_hazmat().poseidon_permutation(
        &input,
        field,
        poseidon_constants_t4::T,
        poseidon_constants_t4::D,
        poseidon_constants_t4::ROUNDS_F,
        poseidon_constants_t4::ROUNDS_P,
        ctx.mds(),
        ctx.rcs(),
    );
    result.get(0).expect("permutation returned empty state")
}

/// State-tree leaf domain-separation tags (v2-monorepo da346809 M-0), big-endian.
/// `Poseidon(BigInt(Buffer.from("privacy_pools_note","utf-8")))`.
pub const COMMITMENT_LEAF_TAG_BYTES: [u8; 32] = [
    0x08, 0x62, 0x05, 0xd9, 0xd9, 0xe3, 0x2c, 0xe5, 0x3f, 0xc3, 0x09, 0x58, 0x56, 0x85, 0xdd, 0xb6,
    0x29, 0xe8, 0x78, 0xdd, 0xd2, 0xdd, 0x04, 0xf5, 0x75, 0x08, 0x9c, 0x3a, 0x42, 0x13, 0x42, 0xd9,
];
/// `Poseidon(BigInt(Buffer.from("privacy_pools_nullifier","utf-8")))`.
pub const NULLIFIER_LEAF_TAG_BYTES: [u8; 32] = [
    0x03, 0x45, 0xf8, 0x52, 0x33, 0x30, 0x82, 0x0b, 0xa6, 0x3c, 0x70, 0x40, 0x7f, 0x3b, 0xfd, 0x09,
    0x32, 0x15, 0x87, 0xca, 0xe0, 0x7b, 0xd4, 0xf7, 0xd3, 0x7d, 0x50, 0x49, 0xf9, 0xc5, 0x1b, 0x17,
];

/// Domain-separation tag for commitment leaves in the state tree.
pub fn commitment_leaf_tag(env: &Env) -> U256 {
    u256_from_bytes(env, &COMMITMENT_LEAF_TAG_BYTES)
}

/// Domain-separation tag for nullifier leaves in the state tree.
pub fn nullifier_leaf_tag(env: &Env) -> U256 {
    u256_from_bytes(env, &NULLIFIER_LEAF_TAG_BYTES)
}

/// Poseidon hash of two BN254 field elements with a pre-built t=3 ctx.
///
/// Output is identical to [`poseidon_hash_two`]; only the constants
/// materialization is amortized across calls.
pub fn poseidon_hash_two_ctx(env: &Env, ctx: &PoseidonT3Ctx, a: &U256, b: &U256) -> U256 {
    let field = bn254_symbol(env);
    let zero = U256::from_u32(env, 0);

    let mut input = Vec::new(env);
    input.push_back(zero);
    input.push_back(a.clone());
    input.push_back(b.clone());

    let result = env.crypto_hazmat().poseidon_permutation(
        &input,
        field,
        poseidon_constants_t3::T,
        poseidon_constants_t3::D,
        poseidon_constants_t3::ROUNDS_F,
        poseidon_constants_t3::ROUNDS_P,
        ctx.mds(),
        ctx.rcs(),
    );
    result.get(0).expect("permutation returned empty state")
}

/// Poseidon hash of two BN254 field elements.
///
/// Uses t=3 (state width 3), d=5, 8 full + 57 partial rounds.
/// State: [0, a, b] -> permutation -> return state[0].
///
/// Rebuilds constants on every call; for hot paths use
/// [`poseidon_hash_two_ctx`] instead.
///
/// Used for: LeanIMT internal nodes, timestamped leaves.
pub fn poseidon_hash_two(env: &Env, a: &U256, b: &U256) -> U256 {
    let ctx = PoseidonT3Ctx::new(env);
    poseidon_hash_two_ctx(env, &ctx, a, b)
}

/// Poseidon hash of three BN254 field elements.
///
/// Uses t=4 (state width 4), d=5, 8 full + 56 partial rounds.
/// State: [0, a, b, c] -> permutation -> return state[0].
///
/// Rebuilds constants on every call; for hot paths use
/// [`poseidon_hash_three_ctx`] instead.
///
/// Used for: keystore leaf = Poseidon(addressHash, nullifyingKeyHash, authDigest),
/// and single domain-tagged state-tree leaves (deposit, ragequit).
pub fn poseidon_hash_three(env: &Env, a: &U256, b: &U256, c: &U256) -> U256 {
    let ctx = PoseidonT4Ctx::new(env);
    poseidon_hash_three_ctx(env, &ctx, a, b, c)
}
