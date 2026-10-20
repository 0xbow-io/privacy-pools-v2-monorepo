//! Unit tests for soroban-v2-utils.

use super::*;
use contract_types::{Groth16Proof, VerificationKeyBytes, SNARK_SCALAR_FIELD_BYTES};
use soroban_sdk::{
    testutils::Address as _, Address, Bytes, BytesN, Env, U256, Vec,
};

// ─── Poseidon Hash Tests ───────────────────────────────────────────────────

#[test]
fn test_poseidon_hash_two_zeros() {
    let env = Env::default();
    let zero = U256::from_u32(&env, 0);
    let result = poseidon_hash_two(&env, &zero, &zero);
    let expected =
        U256::from_be_bytes(&env, &Bytes::from_slice(&env, &poseidon_test_vectors::HASH_0_0));
    assert_eq!(result, expected);
}

#[test]
fn test_poseidon_hash_two_1_2() {
    let env = Env::default();
    let one = U256::from_u32(&env, 1);
    let two = U256::from_u32(&env, 2);
    let result = poseidon_hash_two(&env, &one, &two);
    let expected =
        U256::from_be_bytes(&env, &Bytes::from_slice(&env, &poseidon_test_vectors::HASH_1_2));
    assert_eq!(result, expected);
}

#[test]
fn test_poseidon_hash_two_large_value() {
    let env = Env::default();
    // p - 1 (largest valid scalar field element, Fr)
    let p_minus_1 = U256::from_be_bytes(
        &env,
        &Bytes::from_slice(
            &env,
            &[
                0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81,
                0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1,
                0xf5, 0x93, 0xf0, 0x00, 0x00, 0x00,
            ],
        ),
    );
    let one = U256::from_u32(&env, 1);
    let result = poseidon_hash_two(&env, &p_minus_1, &one);
    let expected =
        U256::from_be_bytes(&env, &Bytes::from_slice(&env, &poseidon_test_vectors::HASH_PMIN1_1));
    assert_eq!(result, expected);
}

#[test]
fn test_poseidon_hash_two_chained() {
    let env = Env::default();
    let one = U256::from_u32(&env, 1);
    let two = U256::from_u32(&env, 2);
    let three = U256::from_u32(&env, 3);
    let four = U256::from_u32(&env, 4);

    let h12 = poseidon_hash_two(&env, &one, &two);
    let h34 = poseidon_hash_two(&env, &three, &four);
    let chained = poseidon_hash_two(&env, &h12, &h34);

    let expected = U256::from_be_bytes(
        &env,
        &Bytes::from_slice(&env, &poseidon_test_vectors::HASH_CHAINED),
    );
    assert_eq!(chained, expected);
}

#[test]
fn test_poseidon_hash_three_zeros() {
    let env = Env::default();
    let zero = U256::from_u32(&env, 0);
    let result = poseidon_hash_three(&env, &zero, &zero, &zero);
    let expected =
        U256::from_be_bytes(&env, &Bytes::from_slice(&env, &poseidon_test_vectors::HASH_0_0_0));
    assert_eq!(result, expected);
}

#[test]
fn test_poseidon_hash_three_1_2_3() {
    let env = Env::default();
    let one = U256::from_u32(&env, 1);
    let two = U256::from_u32(&env, 2);
    let three = U256::from_u32(&env, 3);
    let result = poseidon_hash_three(&env, &one, &two, &three);
    let expected =
        U256::from_be_bytes(&env, &Bytes::from_slice(&env, &poseidon_test_vectors::HASH_1_2_3));
    assert_eq!(result, expected);
}

#[test]
fn test_poseidon_hash_three_ctx_matches_plain() {
    // The memoized-context variant used in the transact hot loop must produce
    // bit-identical output to the plain `poseidon_hash_three`.
    let env = Env::default();
    let one = U256::from_u32(&env, 1);
    let two = U256::from_u32(&env, 2);
    let three = U256::from_u32(&env, 3);
    let ctx = poseidon::PoseidonT4Ctx::new(&env);
    let via_ctx = poseidon::poseidon_hash_three_ctx(&env, &ctx, &one, &two, &three);
    let plain = poseidon_hash_three(&env, &one, &two, &three);
    assert_eq!(via_ctx, plain);
}

#[test]
fn test_state_tree_leaf_domain_separation() {
    // M-0 (v2 da346809): commitment and nullifier leaves carry distinct domain
    // tags so the same (value, timestamp) cannot collide across leaf types.
    let env = Env::default();
    let value = U256::from_u32(&env, 42);
    let timestamp = U256::from_u32(&env, 1_000_000);

    let cm_tag = poseidon::commitment_leaf_tag(&env);
    let nh_tag = poseidon::nullifier_leaf_tag(&env);
    assert_ne!(cm_tag, nh_tag, "leaf tags must differ");

    let commitment_leaf = poseidon_hash_three(&env, &cm_tag, &value, &timestamp);
    let nullifier_leaf = poseidon_hash_three(&env, &nh_tag, &value, &timestamp);
    assert_ne!(
        commitment_leaf, nullifier_leaf,
        "domain tags must produce distinct leaves for identical (value, timestamp)"
    );

    // And neither equals the legacy untagged 2-input leaf.
    let legacy_leaf = poseidon_hash_two(&env, &value, &timestamp);
    assert_ne!(commitment_leaf, legacy_leaf);
    assert_ne!(nullifier_leaf, legacy_leaf);
}

// ─── Field Arithmetic Tests ────────────────────────────────────────────────

#[test]
fn test_keccak256_mod_field() {
    let env = Env::default();
    let data = [0u8; 32];
    let result = keccak256_mod_field(&env, &data);
    // keccak256(0x00..00) is a known value; just verify it's < field modulus
    let field =
        U256::from_be_bytes(&env, &Bytes::from_slice(&env, &SNARK_SCALAR_FIELD_BYTES));
    assert!(result < field);
}

#[test]
fn test_keccak256_mod_field_is_deterministic() {
    let env = Env::default();
    let data = [42u8; 32];
    let result1 = keccak256_mod_field(&env, &data);
    let result2 = keccak256_mod_field(&env, &data);
    assert_eq!(result1, result2);
}

#[test]
fn test_address_to_field() {
    let env = Env::default();
    let addr = Address::generate(&env);
    let result = address_to_field(&env, &addr);
    let field =
        U256::from_be_bytes(&env, &Bytes::from_slice(&env, &SNARK_SCALAR_FIELD_BYTES));
    assert!(result < field);
}

#[test]
fn test_address_to_field_is_deterministic() {
    let env = Env::default();
    let addr = Address::generate(&env);
    let result1 = address_to_field(&env, &addr);
    let result2 = address_to_field(&env, &addr);
    assert_eq!(result1, result2);
}

#[test]
fn test_encode_token_id_is_160_bit() {
    // cffcaca9 INS-1: tokenId must be < 2^160 to satisfy the circuit's
    // Num2Bits(160) constraint. encode_token_id keeps only the low 160 bits of
    // keccak256(strkey), so the high 12 bytes are always zero.
    let env = Env::default();
    let token = Address::generate(&env);
    let result = encode_token_id(&env, &token);

    // 2^160 = single bit at byte index 11 (big-endian).
    let mut two_pow_160_bytes = [0u8; 32];
    two_pow_160_bytes[11] = 0x01;
    let two_pow_160 = U256::from_be_bytes(&env, &Bytes::from_slice(&env, &two_pow_160_bytes));
    assert!(result < two_pow_160, "tokenId must be < 2^160");

    // Deterministic.
    assert_eq!(result, encode_token_id(&env, &token));
}

#[test]
fn test_encode_token_id_distinct_across_addresses() {
    // Distinct asset addresses must yield distinct 160-bit token ids (collisions
    // are the ~2^80 birthday case guarded at registration; ordinary addresses
    // must not collide).
    let env = Env::default();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    assert_ne!(encode_token_id(&env, &a), encode_token_id(&env, &b));
}

#[test]
fn test_different_addresses_give_different_fields() {
    let env = Env::default();
    let addr1 = Address::generate(&env);
    let addr2 = Address::generate(&env);
    let result1 = address_to_field(&env, &addr1);
    let result2 = address_to_field(&env, &addr2);
    assert_ne!(result1, result2);
}

// ─── Groth16 Verifier Tests ───────────────────────────────────────────────

#[test]
fn test_groth16_rejects_signal_count_mismatch() {
    let env = Env::default();

    // Create a dummy VK with 3 IC points (expects 2 signals)
    let vk = make_dummy_vk(&env, 3);

    // Create a dummy proof
    let proof = make_dummy_proof(&env);

    // Provide 1 signal instead of 2 — should fail
    let mut signals: Vec<U256> = Vec::new(&env);
    signals.push_back(U256::from_u32(&env, 42));

    let result = verify_groth16(&env, &vk, &proof, &signals);
    assert!(!result);
}

#[test]
fn test_groth16_rejects_empty_ic() {
    let env = Env::default();

    let vk = VerificationKeyBytes {
        alpha: BytesN::from_array(&env, &[0u8; 64]),
        beta: BytesN::from_array(&env, &[0u8; 128]),
        gamma: BytesN::from_array(&env, &[0u8; 128]),
        delta: BytesN::from_array(&env, &[0u8; 128]),
        ic: Vec::new(&env),
    };

    let proof = make_dummy_proof(&env);
    let signals: Vec<U256> = Vec::new(&env);

    let result = verify_groth16(&env, &vk, &proof, &signals);
    assert!(!result);
}

// ─── _ctx variants vs legacy wrappers: byte-equivalence ───────────────────

extern crate std;
use std::collections::BTreeMap;
use core::cell::RefCell;

/// Guards the memoization invariant: the legacy `poseidon_hash_two` wrapper
/// must produce identical output to `poseidon_hash_two_ctx` with a freshly
/// built ctx. Catches a future refactor where the legacy wrapper stops
/// delegating to the ctx-form (which is what makes memoization safe).
#[test]
fn test_poseidon_hash_two_ctx_matches_legacy() {
    let env = Env::default();
    let ctx = poseidon::PoseidonT3Ctx::new(&env);

    // A handful of representative pairs covering zero, small, and large inputs.
    let pairs: [(u32, u32); 4] = [(0, 0), (1, 2), (42, 7), (0xDEADBEEF, 0xCAFEBABE)];
    for (a_u, b_u) in pairs.iter() {
        let a = U256::from_u32(&env, *a_u);
        let b = U256::from_u32(&env, *b_u);
        let legacy = poseidon::poseidon_hash_two(&env, &a, &b);
        let via_ctx = poseidon::poseidon_hash_two_ctx(&env, &ctx, &a, &b);
        assert_eq!(legacy, via_ctx, "ctx mismatch at ({}, {})", a_u, b_u);
    }
}

/// Guards the "byte-equivalent to sequential inserts" invariant on
/// `lean_imt_insert_many_ctx` — the function transact actually uses.
/// Insert M leaves via the batched path and via the sequential path (each
/// leaf one-at-a-time into a fresh tree with pre-seeded side nodes matching
/// tree_size); the final root must match exactly.
#[test]
fn test_lean_imt_insert_many_ctx_matches_sequential() {
    let env = Env::default();
    let ctx = poseidon::PoseidonT3Ctx::new(&env);

    // 10 leaves (matches a 5x5 transact's N+M leaf count).
    let leaves: std::vec::Vec<U256> = (1..=10u32)
        .map(|i| U256::from_u32(&env, 100 + i))
        .collect();

    // Batched path.
    let batched_storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());
    let batched_get = |l: u32| -> Option<U256> { batched_storage.borrow().get(&l).cloned() };
    let batched_set = |l: u32, v: &U256| {
        batched_storage.borrow_mut().insert(l, v.clone());
    };
    let batched_root = lean_imt::lean_imt_insert_many_ctx(
        &env, &ctx, &leaves, &batched_get, &batched_set, 0,
    );

    // Sequential path.
    let seq_storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());
    let seq_get = |l: u32| -> Option<U256> { seq_storage.borrow().get(&l).cloned() };
    let seq_set = |l: u32, v: &U256| {
        seq_storage.borrow_mut().insert(l, v.clone());
    };
    let mut seq_root = U256::from_u32(&env, 0);
    for (i, leaf) in leaves.iter().enumerate() {
        seq_root = lean_imt::lean_imt_insert(
            &env, leaf, &seq_get, &seq_set, u32::try_from(i).expect("fits"),
        );
    }

    assert_eq!(batched_root, seq_root, "batched and sequential roots diverge");

    // Side nodes must also match — transact writes them to storage and
    // subsequent txs rely on the exact state.
    assert_eq!(
        batched_storage.borrow().len(),
        seq_storage.borrow().len(),
        "side-node count differs",
    );
    for (level, v_batched) in batched_storage.borrow().iter() {
        let v_seq = seq_storage.borrow().get(level).cloned().expect("level");
        assert_eq!(v_batched.clone(), v_seq, "side node at level {} differs", level);
    }
}

// ─── LeanIMT Tests ─────────────────────────────────────────────────────────

#[test]
fn test_lean_imt_single_insert() {
    let env = Env::default();
    let leaf = U256::from_u32(&env, 42);
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    let root = lean_imt::lean_imt_insert(&env, &leaf, &get, &set, 0);
    assert_eq!(root, leaf);
}

#[test]
fn test_lean_imt_two_inserts() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    let _root1 = lean_imt::lean_imt_insert(&env, &U256::from_u32(&env, 1), &get, &set, 0);
    let root2 = lean_imt::lean_imt_insert(&env, &U256::from_u32(&env, 2), &get, &set, 1);

    let expected =
        U256::from_be_bytes(&env, &Bytes::from_slice(&env, &poseidon_test_vectors::HASH_1_2));
    assert_eq!(root2, expected);
}

#[test]
fn test_lean_imt_four_inserts() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    lean_imt::lean_imt_insert(&env, &U256::from_u32(&env, 1), &get, &set, 0);
    lean_imt::lean_imt_insert(&env, &U256::from_u32(&env, 2), &get, &set, 1);
    lean_imt::lean_imt_insert(&env, &U256::from_u32(&env, 3), &get, &set, 2);
    let root = lean_imt::lean_imt_insert(&env, &U256::from_u32(&env, 4), &get, &set, 3);

    let expected = U256::from_be_bytes(
        &env,
        &Bytes::from_slice(&env, &poseidon_test_vectors::HASH_CHAINED),
    );
    assert_eq!(root, expected);
}

#[test]
fn test_lean_imt_insert_many() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    let leaves = [
        U256::from_u32(&env, 1),
        U256::from_u32(&env, 2),
        U256::from_u32(&env, 3),
        U256::from_u32(&env, 4),
    ];

    let root = lean_imt::lean_imt_insert_many(&env, &leaves, &get, &set, 0);

    let expected = U256::from_be_bytes(
        &env,
        &Bytes::from_slice(&env, &poseidon_test_vectors::HASH_CHAINED),
    );
    assert_eq!(root, expected);
}

#[test]
fn test_lean_imt_depth() {
    assert_eq!(lean_imt::lean_imt_depth(0), 0);
    assert_eq!(lean_imt::lean_imt_depth(1), 0);
    assert_eq!(lean_imt::lean_imt_depth(2), 1);
    assert_eq!(lean_imt::lean_imt_depth(3), 2);
    assert_eq!(lean_imt::lean_imt_depth(4), 2);
    assert_eq!(lean_imt::lean_imt_depth(5), 3);
    assert_eq!(lean_imt::lean_imt_depth(8), 3);
    assert_eq!(lean_imt::lean_imt_depth(9), 4);
    assert_eq!(lean_imt::lean_imt_depth(16), 4);
}

// ─── LeanIMT Verify Proof Tests ────────────────────────────────────────────

#[test]
fn test_lean_imt_verify_proof_single_leaf() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    let leaf = U256::from_u32(&env, 42);
    let root = lean_imt::lean_imt_insert(&env, &leaf, &get, &set, 0);

    // Single leaf tree: proof needs no siblings
    let computed = lean_imt::lean_imt_verify_proof(&env, &leaf, 0, &[], 1);
    assert_eq!(computed, Some(root));
}

#[test]
fn test_lean_imt_verify_proof_two_leaves() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    let leaf1 = U256::from_u32(&env, 1);
    let leaf2 = U256::from_u32(&env, 2);
    lean_imt::lean_imt_insert(&env, &leaf1, &get, &set, 0);
    let root = lean_imt::lean_imt_insert(&env, &leaf2, &get, &set, 1);

    // Verify leaf1 (index 0): sibling is leaf2
    let computed1 = lean_imt::lean_imt_verify_proof(&env, &leaf1, 0, &[leaf2.clone()], 2);
    assert_eq!(computed1, Some(root.clone()));

    // Verify leaf2 (index 1): sibling is leaf1
    let computed2 = lean_imt::lean_imt_verify_proof(&env, &leaf2, 1, &[leaf1.clone()], 2);
    assert_eq!(computed2, Some(root));
}

#[test]
fn test_lean_imt_verify_proof_three_leaves() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    let leaf1 = U256::from_u32(&env, 1);
    let leaf2 = U256::from_u32(&env, 2);
    let leaf3 = U256::from_u32(&env, 3);
    lean_imt::lean_imt_insert(&env, &leaf1, &get, &set, 0);
    lean_imt::lean_imt_insert(&env, &leaf2, &get, &set, 1);
    let root = lean_imt::lean_imt_insert(&env, &leaf3, &get, &set, 2);

    // Verify leaf3 (index 2, rightmost): no sibling at level 1 needed (rightmost path)
    // Sibling at level 0 is H(1,2)
    let h12 = poseidon_hash_two(&env, &leaf1, &leaf2);
    let computed = lean_imt::lean_imt_verify_proof(&env, &leaf3, 2, &[h12], 3);
    assert_eq!(computed, Some(root));
}

#[test]
fn test_lean_imt_verify_proof_invalid_leaf() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    let leaf1 = U256::from_u32(&env, 1);
    let leaf2 = U256::from_u32(&env, 2);
    lean_imt::lean_imt_insert(&env, &leaf1, &get, &set, 0);
    let root = lean_imt::lean_imt_insert(&env, &leaf2, &get, &set, 1);

    // Verify wrong leaf value — should produce different root
    let wrong_leaf = U256::from_u32(&env, 99);
    let computed = lean_imt::lean_imt_verify_proof(&env, &wrong_leaf, 0, &[leaf2], 2);
    assert!(computed.is_some());
    assert_ne!(computed.unwrap(), root);
}

#[test]
fn test_lean_imt_verify_proof_empty_tree() {
    let env = Env::default();
    let leaf = U256::from_u32(&env, 1);
    let result = lean_imt::lean_imt_verify_proof(&env, &leaf, 0, &[], 0);
    assert_eq!(result, None);
}

// ─── LeanIMT Update Tests ─────────────────────────────────────────────────

#[test]
fn test_lean_imt_update_single_leaf() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    // Insert one leaf
    let leaf1 = U256::from_u32(&env, 42);
    lean_imt::lean_imt_insert(&env, &leaf1, &get, &set, 0);

    // Update it to a new value
    let new_leaf = U256::from_u32(&env, 99);
    let new_root = lean_imt::lean_imt_update(&env, 0, &leaf1, &new_leaf, &[], &get, &set, 1);

    // Root should equal the new leaf (single leaf tree)
    assert_eq!(new_root, new_leaf);
}

#[test]
fn test_lean_imt_update_two_leaves() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    let leaf1 = U256::from_u32(&env, 1);
    let leaf2 = U256::from_u32(&env, 2);
    lean_imt::lean_imt_insert(&env, &leaf1, &get, &set, 0);
    lean_imt::lean_imt_insert(&env, &leaf2, &get, &set, 1);

    // Update leaf at index 0 to new value
    let new_leaf = U256::from_u32(&env, 99);
    let new_root = lean_imt::lean_imt_update(&env, 0, &leaf1, &new_leaf, &[leaf2.clone()], &get, &set, 2);

    // Expected: H(99, 2)
    let expected = poseidon_hash_two(&env, &new_leaf, &leaf2);
    assert_eq!(new_root, expected);
}

#[test]
fn test_lean_imt_update_preserves_other_leaf() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    let leaf1 = U256::from_u32(&env, 1);
    let leaf2 = U256::from_u32(&env, 2);
    lean_imt::lean_imt_insert(&env, &leaf1, &get, &set, 0);
    lean_imt::lean_imt_insert(&env, &leaf2, &get, &set, 1);

    // Update leaf at index 1 to new value
    let new_leaf = U256::from_u32(&env, 77);
    let new_root = lean_imt::lean_imt_update(&env, 1, &leaf2, &new_leaf, &[leaf1.clone()], &get, &set, 2);

    // Expected: H(1, 77)
    let expected = poseidon_hash_two(&env, &leaf1, &new_leaf);
    assert_eq!(new_root, expected);
}

// ─── LeanIMT Leaf Validation Tests ─────────────────────────────────────────

#[test]
#[should_panic(expected = "leaf must be non-zero")]
fn test_lean_imt_insert_rejects_zero_leaf() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    let zero = U256::from_u32(&env, 0);
    lean_imt::lean_imt_insert(&env, &zero, &get, &set, 0);
}

#[test]
#[should_panic(expected = "leaf must be less than SNARK_SCALAR_FIELD")]
fn test_lean_imt_insert_rejects_out_of_field_leaf() {
    let env = Env::default();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| { storage.borrow_mut().insert(level, val.clone()); };

    // SNARK_SCALAR_FIELD itself is out of range (must be strictly less)
    let field = U256::from_be_bytes(&env, &Bytes::from_slice(&env, &SNARK_SCALAR_FIELD_BYTES));
    lean_imt::lean_imt_insert(&env, &field, &get, &set, 0);
}

// ─── Root Buffer Tests ─────────────────────────────────────────────────────

#[test]
fn test_root_buffer_record_and_find() {
    let env = Env::default();
    let root1 = U256::from_u32(&env, 111);
    let root2 = U256::from_u32(&env, 222);

    let roots: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let set_root = |idx: u32, val: &U256| { roots.borrow_mut().insert(idx, val.clone()); };
    let set_idx = |_idx: u32| {};
    let get_root = |idx: u32| -> Option<U256> { roots.borrow().get(&idx).cloned() };

    let history_size = 30u32;

    root_buffer::record_root(&root1, 0, history_size, &set_root, &set_idx);
    assert!(root_buffer::is_known_root(&env, &root1, history_size, &get_root));
    assert!(!root_buffer::is_known_root(&env, &root2, history_size, &get_root));

    root_buffer::record_root(&root2, 1, history_size, &set_root, &set_idx);
    assert!(root_buffer::is_known_root(&env, &root1, history_size, &get_root));
    assert!(root_buffer::is_known_root(&env, &root2, history_size, &get_root));
}

#[test]
fn test_root_buffer_wraparound() {
    let env = Env::default();
    let roots: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let set_root = |idx: u32, val: &U256| { roots.borrow_mut().insert(idx, val.clone()); };
    let set_idx = |_idx: u32| {};
    let get_root = |idx: u32| -> Option<U256> { roots.borrow().get(&idx).cloned() };

    let history_size = 3u32;

    root_buffer::record_root(&U256::from_u32(&env, 1), 0, history_size, &set_root, &set_idx);
    root_buffer::record_root(&U256::from_u32(&env, 2), 1, history_size, &set_root, &set_idx);
    root_buffer::record_root(&U256::from_u32(&env, 3), 2, history_size, &set_root, &set_idx);

    assert!(root_buffer::is_known_root(&env, &U256::from_u32(&env, 1), history_size, &get_root));
    assert!(root_buffer::is_known_root(&env, &U256::from_u32(&env, 2), history_size, &get_root));
    assert!(root_buffer::is_known_root(&env, &U256::from_u32(&env, 3), history_size, &get_root));

    // Wraparound: root 4 overwrites root 1 at index 0
    root_buffer::record_root(&U256::from_u32(&env, 4), 0, history_size, &set_root, &set_idx);

    assert!(!root_buffer::is_known_root(&env, &U256::from_u32(&env, 1), history_size, &get_root));
    assert!(root_buffer::is_known_root(&env, &U256::from_u32(&env, 2), history_size, &get_root));
    assert!(root_buffer::is_known_root(&env, &U256::from_u32(&env, 3), history_size, &get_root));
    assert!(root_buffer::is_known_root(&env, &U256::from_u32(&env, 4), history_size, &get_root));
}

#[test]
fn test_root_buffer_latest() {
    let env = Env::default();
    let roots: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let set_root = |idx: u32, val: &U256| { roots.borrow_mut().insert(idx, val.clone()); };
    let set_idx = |_idx: u32| {};
    let get_root = |idx: u32| -> Option<U256> { roots.borrow().get(&idx).cloned() };

    let history_size = 5u32;

    root_buffer::record_root(&U256::from_u32(&env, 42), 0, history_size, &set_root, &set_idx);

    let latest = root_buffer::latest_root(1, history_size, &get_root);
    assert_eq!(latest, Some(U256::from_u32(&env, 42)));
}

#[test]
fn test_root_buffer_zero_root_not_found() {
    let env = Env::default();
    let roots: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let set_root = |idx: u32, val: &U256| { roots.borrow_mut().insert(idx, val.clone()); };
    let set_idx = |_idx: u32| {};
    let get_root = |idx: u32| -> Option<U256> { roots.borrow().get(&idx).cloned() };

    let history_size = 5u32;

    // Record some non-zero roots
    root_buffer::record_root(&U256::from_u32(&env, 111), 0, history_size, &set_root, &set_idx);
    root_buffer::record_root(&U256::from_u32(&env, 222), 1, history_size, &set_root, &set_idx);

    // Zero should never be a known root (even if it's never been stored)
    let zero = U256::from_u32(&env, 0);
    assert!(!root_buffer::is_known_root(&env, &zero, history_size, &get_root));
}

#[test]
fn test_root_buffer_nonexistent_root_not_found() {
    let env = Env::default();
    let roots: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());

    let set_root = |idx: u32, val: &U256| { roots.borrow_mut().insert(idx, val.clone()); };
    let set_idx = |_idx: u32| {};
    let get_root = |idx: u32| -> Option<U256> { roots.borrow().get(&idx).cloned() };

    let history_size = 5u32;

    // Record some roots
    root_buffer::record_root(&U256::from_u32(&env, 111), 0, history_size, &set_root, &set_idx);
    root_buffer::record_root(&U256::from_u32(&env, 222), 1, history_size, &set_root, &set_idx);
    root_buffer::record_root(&U256::from_u32(&env, 333), 2, history_size, &set_root, &set_idx);

    // A root that was never stored should not be found
    let unknown = U256::from_u32(&env, 999);
    assert!(!root_buffer::is_known_root(&env, &unknown, history_size, &get_root));
}

// ─── Test Helpers ──────────────────────────────────────────────────────────

/// Create a dummy VK with the specified number of IC points.
/// Points are the G1 generator to avoid panic on deserialization.
fn make_dummy_vk(env: &Env, num_ic: u32) -> VerificationKeyBytes {
    // G1 generator point for BN254
    let g1_gen = g1_generator_bytes();
    // G2 generator point for BN254
    let g2_gen = g2_generator_bytes();

    let mut ic: Vec<BytesN<64>> = Vec::new(env);
    for _ in 0..num_ic {
        ic.push_back(BytesN::from_array(env, &g1_gen));
    }

    VerificationKeyBytes {
        alpha: BytesN::from_array(env, &g1_gen),
        beta: BytesN::from_array(env, &g2_gen),
        gamma: BytesN::from_array(env, &g2_gen),
        delta: BytesN::from_array(env, &g2_gen),
        ic,
    }
}

/// Create a dummy proof with generator points.
fn make_dummy_proof(env: &Env) -> Groth16Proof {
    let g1_gen = g1_generator_bytes();
    let g2_gen = g2_generator_bytes();
    Groth16Proof {
        a: BytesN::from_array(env, &g1_gen),
        b: BytesN::from_array(env, &g2_gen),
        c: BytesN::from_array(env, &g1_gen),
    }
}

/// BN254 G1 generator: (1, 2)
fn g1_generator_bytes() -> [u8; 64] {
    let mut bytes = [0u8; 64];
    bytes[31] = 1; // x = 1
    bytes[63] = 2; // y = 2
    bytes
}

/// BN254 G2 generator (Soroban c1||c0 ordering)
fn g2_generator_bytes() -> [u8; 128] {
    let mut bytes = [0u8; 128];
    // G2 generator x-coordinate (Fq2):
    // x.c1 (imaginary) = 10857046999023057135944570762232829481370756359578518086990519993285655852781
    // x.c0 (real) = 11559732032986387107991004021392285783925812861821192530917403151452391805634
    let x_c1: [u8; 32] = [
        0x18, 0x00, 0xde, 0xef, 0x12, 0x1f, 0x1e, 0x76, 0x42, 0x6a, 0x00, 0x66, 0x5e, 0x5c,
        0x44, 0x79, 0x67, 0x43, 0x22, 0xd4, 0xf7, 0x5e, 0xda, 0xdd, 0x46, 0xde, 0xbd, 0x5c,
        0xd9, 0x92, 0xf6, 0xed,
    ];
    let x_c0: [u8; 32] = [
        0x19, 0x8e, 0x93, 0x93, 0x92, 0x0d, 0x48, 0x3a, 0x72, 0x60, 0xbf, 0xb7, 0x31, 0xfb,
        0x5d, 0x25, 0xf1, 0xaa, 0x49, 0x33, 0x35, 0xa9, 0xe7, 0x12, 0x97, 0xe4, 0x85, 0xb7,
        0xae, 0xf3, 0x12, 0xc2,
    ];
    // G2 generator y-coordinate (Fq2):
    // y.c1 (imaginary) = 8495653923123431417604973247489272438418190587263600148770280649306958101930
    // y.c0 (real) = 4082367875863433681332203403145435568316851327593401208105741076214120093531
    let y_c1: [u8; 32] = [
        0x12, 0xc8, 0x5e, 0xa5, 0xdb, 0x8c, 0x6d, 0xeb, 0x4a, 0xab, 0x71, 0x80, 0x8d, 0xcb,
        0x40, 0x8f, 0xe3, 0xd1, 0xe7, 0x69, 0x0c, 0x43, 0xd3, 0x7b, 0x4c, 0xe6, 0xcc, 0x01,
        0x66, 0xfa, 0x7d, 0xaa,
    ];
    let y_c0: [u8; 32] = [
        0x09, 0x0d, 0x97, 0xd0, 0x2e, 0x99, 0x79, 0x92, 0x09, 0x6a, 0xdb, 0x10, 0x10, 0x62,
        0x2b, 0x1e, 0x8f, 0xac, 0x95, 0x73, 0xa1, 0x88, 0x80, 0xd6, 0x8a, 0xe1, 0xa9, 0x57,
        0x5c, 0x3e, 0x76, 0x0b,
    ];
    // Soroban ordering: x.c1 || x.c0 || y.c1 || y.c0
    bytes[..32].copy_from_slice(&x_c1);
    bytes[32..64].copy_from_slice(&x_c0);
    bytes[64..96].copy_from_slice(&y_c1);
    bytes[96..128].copy_from_slice(&y_c0);
    bytes
}

// ─── Tree Depth CPU Scaling Benchmark ──────────────────────────────────────
//
// Measures the CPU cost of 10 sequential lean_imt_insert calls (matching a
// 5x5 transact's tree ops) at various simulated tree sizes. Side nodes are
// pre-seeded at every level so the insert walks hash at each set bit of
// `size`, mimicking what the on-chain tree looks like when it already
// contains that many leaves.
//
// Run with:
//   cargo test --release --package soroban-v2-utils \
//     bench_tree_depth_cpu -- --ignored --nocapture
//
// Ignored by default — not a correctness test, just a perf measurement.

fn seed_side_nodes(
    env: &Env,
    tree_size: u32,
    storage: &RefCell<BTreeMap<u32, U256>>,
) {
    // Seed a valid U256 at every level. lean_imt_insert only reads levels
    // where bit `l` of `size` is 1, so extras are harmless but cheap.
    // Use sequential non-zero values; they just need to be < field.
    let mut map = storage.borrow_mut();
    let depth = if tree_size <= 1 { 0 } else { 32 - (tree_size - 1).leading_zeros() };
    for level in 0..=depth {
        // A simple valid value: level + 1 (non-zero, clearly < field).
        map.insert(level, U256::from_u32(env, level + 1));
    }
}

fn bench_insert_10_at_size(tree_size: u32) -> u64 {
    let env = Env::default();
    env.budget().reset_unlimited();
    let storage: RefCell<BTreeMap<u32, U256>> = RefCell::new(BTreeMap::new());
    seed_side_nodes(&env, tree_size, &storage);

    let get = |level: u32| -> Option<U256> { storage.borrow().get(&level).cloned() };
    let set = |level: u32, val: &U256| {
        storage.borrow_mut().insert(level, val.clone());
    };

    // Build the Poseidon ctx once, matching how transact does it.
    let ctx = poseidon::PoseidonT3Ctx::new(&env);

    // Prepare 10 leaves (representative of 5x5: 5 nullifiers + 5 commitments).
    let leaves: std::vec::Vec<U256> = (1..=10u32)
        .map(|i| U256::from_u32(&env, 1_000_000 + i))
        .collect();

    env.budget().reset_tracker();
    for (i, leaf) in leaves.iter().enumerate() {
        let size = tree_size.checked_add(i as u32).unwrap();
        lean_imt::lean_imt_insert_ctx(&env, &ctx, leaf, &get, &set, size);
    }
    env.budget().cpu_instruction_cost()
}

#[test]
#[ignore]
fn bench_tree_depth_cpu() {
    let sizes: &[(&str, u32)] = &[
        ("85 (scenario 11 baseline)", 85),
        ("1K",       1_000),
        ("10K",     10_000),
        ("100K",   100_000),
        ("1M",   1_000_000),
        ("10M", 10_000_000),
        ("100M", 100_000_000),
        ("1B",  1_000_000_000),
    ];

    std::println!();
    std::println!("Tree-depth CPU scaling: 10 sequential lean_imt_insert calls");
    std::println!("(equivalent to the tree-ops portion of one 5x5 transact)");
    std::println!();
    std::println!("{:<30} {:>6} {:>18} {:>18}",
        "tree_size", "depth", "cpu_instructions", "delta_vs_baseline");

    let mut baseline: Option<u64> = None;
    for (label, size) in sizes {
        let cpu = bench_insert_10_at_size(*size);
        let depth = if *size <= 1 { 0 } else { 32 - (size - 1).leading_zeros() };
        let base = *baseline.get_or_insert(cpu);
        let delta = cpu as i64 - base as i64;
        std::println!(
            "{:<30} {:>6} {:>18} {:>+18}",
            label, depth, cpu, delta
        );
    }
    std::println!();
    std::println!("Note: this measures ONLY the LeanIMT tree walk.");
    std::println!("Full 5x5 transact adds ~55-65M of fixed cost (Groth16 verify,");
    std::println!("nullifier markers, SAC transfer, timestamped-leaf building).");
}
