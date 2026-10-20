//! Groth16 proof verification for BN254 curve.
//!
//! Verifies Groth16 proofs inline using Soroban's native BN254 host functions
//! (CAP-0074). No separate verifier contract needed.
//!
//! ## Security note: G2 subgroup checks
//!
//! This verifier does not explicitly check that G2 points (proof.B, VK beta/gamma/delta)
//! are in the correct G2 subgroup (BN254 G2 has cofactor > 1). We rely on Soroban's
//! CAP-0074 host functions to validate G2 subgroup membership during `from_bytes()`
//! deserialization and/or `pairing_check()`. This is standard behavior for pairing-based
//! crypto libraries. G1 points have cofactor = 1, so any point on the curve is in the
//! correct subgroup.

use contract_types::{Groth16Proof, VerificationKeyBytes, SNARK_SCALAR_FIELD_BYTES};
use soroban_sdk::{
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Fr},
    vec, Bytes, BytesN, Env, Vec, U256,
};

/// Verification key with deserialized curve points.
struct VerificationKey {
    alpha: Bn254G1Affine,
    beta: Bn254G2Affine,
    gamma: Bn254G2Affine,
    delta: Bn254G2Affine,
    ic: Vec<Bn254G1Affine>,
}

/// Deserialize a verification key from stored bytes.
fn vk_from_bytes(env: &Env, vk_bytes: &VerificationKeyBytes) -> VerificationKey {
    let mut ic_vec: Vec<Bn254G1Affine> = Vec::new(env);
    for bytes in vk_bytes.ic.iter() {
        ic_vec.push_back(Bn254G1Affine::from_bytes(bytes));
    }

    VerificationKey {
        alpha: Bn254G1Affine::from_bytes(vk_bytes.alpha.clone()),
        beta: Bn254G2Affine::from_bytes(vk_bytes.beta.clone()),
        gamma: Bn254G2Affine::from_bytes(vk_bytes.gamma.clone()),
        delta: Bn254G2Affine::from_bytes(vk_bytes.delta.clone()),
        ic: ic_vec,
    }
}

/// Verify a Groth16 proof against a verification key and public signals.
///
/// Returns `true` if the proof is valid, `false` otherwise.
///
/// # Arguments
/// * `env` - Soroban environment
/// * `vk_bytes` - Verification key in serialized form
/// * `proof` - Groth16 proof (A, B, C points)
/// * `public_signals` - Public signals as Fr field elements
///
/// # Signal Ordering (CRITICAL)
/// Signals must follow circom convention: outputs first, then public inputs.
/// The IC points in the VK correspond 1:1 with signals (IC[0] is the base,
/// IC[1..] correspond to signals[0..]).
///
/// # Canonical signals (CRITICAL)
/// Every signal must be a canonical field element (`< r`); a proof with any signal `>= r` is
/// rejected. `Fr::from_u256` reduces silently, so without this check a proof for `x` also
/// verifies for `x + r`, `x + 2r`, … — while callers key state on the RAW value. That turns one
/// spend proof into up to six distinct nullifiers (`2^256 / r ≈ 5.3`): a double-spend. EVM's
/// generated verifiers reject non-canonical signals the same way (`checkField`).
pub fn verify_groth16(
    env: &Env,
    vk_bytes: &VerificationKeyBytes,
    proof: &Groth16Proof,
    public_signals: &Vec<U256>,
) -> bool {
    let field = U256::from_be_bytes(env, &Bytes::from_slice(env, &SNARK_SCALAR_FIELD_BYTES));
    let mut signals = Vec::<Fr>::new(env);
    for signal in public_signals.iter() {
        if signal >= field {
            return false;
        }
        signals.push_back(Fr::from_u256(signal));
    }
    let vk = vk_from_bytes(env, vk_bytes);
    verify_groth16_inner(env, &vk, proof, &signals)
}

/// Inner verification logic.
///
/// Computes:
///   vk_x = IC[0] + sum(signal[i] * IC[i+1])
///
/// Then checks pairing:
///   e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
fn verify_groth16_inner(
    env: &Env,
    vk: &VerificationKey,
    proof: &Groth16Proof,
    public_signals: &Vec<Fr>,
) -> bool {
    let bn = env.crypto().bn254();

    // IC must have exactly pub_signals.len() + 1 entries
    let expected_ic_len = public_signals.len().checked_add(1);
    if expected_ic_len != Some(vk.ic.len()) {
        return false;
    }

    // Compute vk_x = IC[0] + sum(signal[i] * IC[i+1])
    let mut vk_x = vk.ic.get(0).expect("IC must have at least one element");

    for i in 0..public_signals.len() {
        let signal = public_signals.get(i).expect("signal index in range");
        let ic_point = vk.ic.get(i.checked_add(1).expect("overflow")).expect("IC index in range");
        let prod = bn.g1_mul(&ic_point, &signal);
        vk_x = bn.g1_add(&vk_x, &prod);
    }

    // Negate proof.A for the pairing check
    let neg_a = negate_g1(env, &proof.a);

    // Parse proof points
    let proof_b = Bn254G2Affine::from_bytes(proof.b.clone());
    let proof_c = Bn254G1Affine::from_bytes(proof.c.clone());

    // Pairing check: e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
    let g1_points = vec![env, neg_a, vk.alpha.clone(), vk_x, proof_c];
    let g2_points = vec![
        env,
        proof_b,
        vk.beta.clone(),
        vk.gamma.clone(),
        vk.delta.clone(),
    ];

    bn.pairing_check(g1_points, g2_points)
}

/// Negate a G1 point by negating its y-coordinate.
///
/// For BN254, negation is: -P = (x, p - y) where p is the base field modulus.
/// G1 serialization: [x (32 bytes) || y (32 bytes)]
fn negate_g1(env: &Env, point_bytes: &BytesN<64>) -> Bn254G1Affine {
    // BN254 base field modulus (Fq)
    const FQ_MODULUS: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81,
        0x58, 0x5d, 0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16,
        0xd8, 0x7c, 0xfd, 0x47,
    ];

    let bytes = point_bytes.to_array();
    let mut result = [0u8; 64];

    // Copy x-coordinate as-is
    result[..32].copy_from_slice(&bytes[..32]);

    // Check for point at infinity (both coords zero)
    let mut is_zero = true;
    for &b in &bytes[32..64] {
        if b != 0 {
            is_zero = false;
            break;
        }
    }

    if is_zero {
        // Point at infinity: negation is itself
        result[32..64].copy_from_slice(&bytes[32..64]);
    } else {
        // Negate y: result_y = Fq - y (big-endian subtraction)
        let mut borrow: u16 = 0;
        let y_bytes = &bytes[32..64];
        for i in (0..32).rev() {
            let diff = u16::from(FQ_MODULUS[i])
                .wrapping_sub(u16::from(y_bytes[i]))
                .wrapping_sub(borrow);
            #[allow(clippy::arithmetic_side_effects)]
            let out_idx = 32 + i;
            result[out_idx] = (diff & 0xFF) as u8;
            borrow = if diff > 0xFF { 1 } else { 0 };
        }
    }

    Bn254G1Affine::from_bytes(BytesN::from_array(env, &result))
}
