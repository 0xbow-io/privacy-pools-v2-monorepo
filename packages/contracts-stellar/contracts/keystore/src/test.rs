//! Keystore contract unit tests.

use super::*;
extern crate std;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke};
use soroban_sdk::IntoVal;
use soroban_sdk::Event as _;

/// Root liveness window used in tests (seconds). Large enough that superseded
/// roots stay known across a test unless the ledger timestamp is advanced.
const KEYSTORE_ROOT_LIVENESS: u64 = 3600;
/// Circuit-aligned keystore-tree cap (= 2^KEYSTORE_MAX_DEPTH = 2^18).
const MAX_KEYSTORE_TREE_SIZE: u32 = 262_144;

fn setup(env: &Env) -> (KeystoreContractClient, Address) {
    env.mock_all_auths();
    let contract_id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    client.initialize(&admin, &KEYSTORE_ROOT_LIVENESS, &MAX_KEYSTORE_TREE_SIZE);
    (client, admin)
}

/// setup that also returns a known upgrader for testing upgrader-gated setters.
fn setup_with_upgrader(env: &Env) -> (KeystoreContractClient, Address, Address) {
    let (client, admin) = setup(env);
    let upgrader = Address::generate(env);
    client.set_upgrader(&admin, &upgrader);
    (client, admin, upgrader)
}

// ── Initialization ──

#[test]
fn test_initialize() {
    let env = Env::default();
    let (client, _) = setup(&env);
    assert_eq!(client.tree_size(), 0);
}

#[test]
fn test_initialize_rejects_double_init() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let admin2 = Address::generate(&env);
    let r = client.try_initialize(&admin2, &KEYSTORE_ROOT_LIVENESS, &MAX_KEYSTORE_TREE_SIZE);
    assert!(
        matches!(r, Err(Ok(Error::AlreadyInitialized))),
        "expected Error::AlreadyInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_initialize_rejects_zero_liveness() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let r = client.try_initialize(&admin, &0, &MAX_KEYSTORE_TREE_SIZE);
    assert!(
        matches!(r, Err(Ok(Error::InvalidRootLiveness))),
        "expected Error::InvalidRootLiveness from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_initialize_rejects_zero_max_tree_size() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let r = client.try_initialize(&admin, &KEYSTORE_ROOT_LIVENESS, &0);
    assert!(
        matches!(r, Err(Ok(Error::InvalidMaxTreeSize))),
        "expected Error::InvalidMaxTreeSize from this call specifically, got {:?}",
        r
    );
}

// ── set_auth_policy ──

#[test]
fn test_set_auth_policy() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let nk_hash = U256::from_u32(&env, 12345);
    let auth_digest = U256::from_u32(&env, 67890);

    client.set_auth_policy(&user, &nk_hash, &auth_digest);

    assert_eq!(client.tree_size(), 1);
    assert_eq!(client.get_nullifying_key(&user), nk_hash);

    // Root should be set
    let root = client.latest_root();
    assert!(client.is_known_root(&root));
}

#[test]
fn test_set_auth_policy_two_users() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let nk1 = U256::from_u32(&env, 111);
    let nk2 = U256::from_u32(&env, 222);
    let ad1 = U256::from_u32(&env, 333);
    let ad2 = U256::from_u32(&env, 444);

    client.set_auth_policy(&user1, &nk1, &ad1);
    let root1 = client.latest_root();

    client.set_auth_policy(&user2, &nk2, &ad2);
    let root2 = client.latest_root();

    assert_eq!(client.tree_size(), 2);
    assert!(root1 != root2); // Different roots
    assert!(client.is_known_root(&root1)); // Old root still known
    assert!(client.is_known_root(&root2)); // New root known
}

#[test]
fn test_set_auth_policy_rejects_already_registered() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let nk = U256::from_u32(&env, 111);
    let ad = U256::from_u32(&env, 222);

    client.set_auth_policy(&user, &nk, &ad);
    // Second registration should fail
    let r = client.try_set_auth_policy(&user, &nk, &ad);
    assert!(
        matches!(r, Err(Ok(Error::AlreadyRegistered))),
        "expected Error::AlreadyRegistered from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_auth_policy_rejects_zero_nk_hash() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let zero = U256::from_u32(&env, 0);
    let ad = U256::from_u32(&env, 222);

    let r = client.try_set_auth_policy(&user, &zero, &ad);

    assert!(

        matches!(r, Err(Ok(Error::InvalidNullifyingKeyHash))),

        "expected Error::InvalidNullifyingKeyHash from this call specifically, got {:?}",

        r

    );
}

#[test]
fn test_set_auth_policy_rejects_nk_hash_out_of_field() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    // Value >= SNARK_SCALAR_FIELD (use max u256)
    let out_of_field = U256::from_be_bytes(
        &env,
        &soroban_sdk::Bytes::from_slice(&env, &[0xFF; 32]),
    );
    let ad = U256::from_u32(&env, 222);

    let r = client.try_set_auth_policy(&user, &out_of_field, &ad);

    assert!(

        matches!(r, Err(Ok(Error::OutOfScalarField))),

        "expected Error::OutOfScalarField from this call specifically, got {:?}",

        r

    );
}

#[test]
fn test_set_auth_policy_rejects_auth_digest_out_of_field() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let nk = U256::from_u32(&env, 12345);
    let out_of_field = U256::from_be_bytes(
        &env,
        &soroban_sdk::Bytes::from_slice(&env, &[0xFF; 32]),
    );

    let r = client.try_set_auth_policy(&user, &nk, &out_of_field);

    assert!(

        matches!(r, Err(Ok(Error::OutOfScalarField))),

        "expected Error::OutOfScalarField from this call specifically, got {:?}",

        r

    );
}

#[test]
fn test_update_auth_policy_rejects_new_digest_out_of_field() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let nk = U256::from_u32(&env, 12345);
    let ad = U256::from_u32(&env, 67890);
    client.set_auth_policy(&user, &nk, &ad);

    let out_of_field = U256::from_be_bytes(
        &env,
        &soroban_sdk::Bytes::from_slice(&env, &[0xFF; 32]),
    );
    let siblings = soroban_sdk::Vec::<U256>::new(&env);
    let r = client.try_update_auth_policy(&user, &ad, &out_of_field, &siblings);
    assert!(
        matches!(r, Err(Ok(Error::OutOfScalarField))),
        "expected Error::OutOfScalarField from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_update_auth_policy_rejects_old_digest_out_of_field() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let nk = U256::from_u32(&env, 12345);
    let ad = U256::from_u32(&env, 67890);
    client.set_auth_policy(&user, &nk, &ad);

    let out_of_field = U256::from_be_bytes(
        &env,
        &soroban_sdk::Bytes::from_slice(&env, &[0xFF; 32]),
    );
    let siblings = soroban_sdk::Vec::<U256>::new(&env);
    // old_auth_digest is out of field
    let r = client.try_update_auth_policy(&user, &out_of_field, &ad, &siblings);
    assert!(
        matches!(r, Err(Ok(Error::OutOfScalarField))),
        "expected Error::OutOfScalarField from this call specifically, got {:?}",
        r
    );
}

// ── update_auth_policy ──

#[test]
fn test_update_auth_policy() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let nk_hash = U256::from_u32(&env, 12345);
    let old_ad = U256::from_u32(&env, 67890);
    let new_ad = U256::from_u32(&env, 99999);

    // Register first
    client.set_auth_policy(&user, &nk_hash, &old_ad);
    let root_after_insert = client.latest_root();

    // For a tree with 1 leaf, the root IS the leaf (no siblings needed)
    let siblings = Vec::<U256>::new(&env);

    // Update auth policy
    client.update_auth_policy(&user, &old_ad, &new_ad, &siblings);

    // Root should change
    let new_root = client.latest_root();
    assert!(new_root != root_after_insert);
    assert!(client.is_known_root(&new_root));

    // Old root should still be in history
    assert!(client.is_known_root(&root_after_insert));
}

#[test]
fn test_root_reinsertion_clears_stale_valid_until() {
    // Exercises update_root's `delete previousRoots[new_root]` branch (EVM
    // Keystore._updateRoot): a root that was superseded (got a validUntil) and
    // then becomes current again must have its stale stamp cleared.
    let env = Env::default();
    let (client, _) = setup(&env);
    env.ledger().set_timestamp(1_000);

    let user = Address::generate(&env);
    let nk = U256::from_u32(&env, 12345);
    let ad_a = U256::from_u32(&env, 100);
    let ad_b = U256::from_u32(&env, 200);
    let siblings = Vec::<U256>::new(&env); // 1-leaf tree: root == leaf

    client.set_auth_policy(&user, &nk, &ad_a);
    let root_a = client.latest_root();

    // A -> B supersedes root_a (stamps validUntil).
    client.update_auth_policy(&user, &ad_a, &ad_b, &siblings);
    assert_eq!(client.previous_root_valid_until(&root_a), 1_000 + KEYSTORE_ROOT_LIVENESS);

    // B -> A re-promotes root_a to current; its stale stamp must be cleared.
    client.update_auth_policy(&user, &ad_b, &ad_a, &siblings);
    assert_eq!(client.current_root(), root_a);
    assert_eq!(client.previous_root_valid_until(&root_a), 0);
    assert!(client.is_known_root(&root_a));
}

#[test]
fn test_set_max_keystore_tree_size_rejects_non_upgrader() {
    let env = Env::default();
    let (client, _admin, _upgrader) = setup_with_upgrader(&env);
    let rando = Address::generate(&env);
    let r = client.try_set_max_keystore_tree_size(&rando, &(MAX_KEYSTORE_TREE_SIZE * 2));
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_keystore_tree_cap_boundary_at_exact_max() {
    // cap = 2: two registrations fill exactly to MAX (size+1 <= max each),
    // the third (size 2, 2+1 > 2) is rejected — makes the `> max` boundary explicit.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &KEYSTORE_ROOT_LIVENESS, &2u32);

    let u1 = Address::generate(&env);
    client.set_auth_policy(&u1, &U256::from_u32(&env, 1), &U256::from_u32(&env, 2));
    let u2 = Address::generate(&env);
    client.set_auth_policy(&u2, &U256::from_u32(&env, 3), &U256::from_u32(&env, 4));
    assert_eq!(client.tree_size(), 2); // exactly at cap

    let u3 = Address::generate(&env);
    let res = client.try_set_auth_policy(&u3, &U256::from_u32(&env, 5), &U256::from_u32(&env, 6));
    assert!(res.is_err()); // KeystoreTreeFull
    assert_eq!(client.tree_size(), 2); // unchanged
}

#[test]
fn test_update_auth_policy_rejects_unregistered() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let old_ad = U256::from_u32(&env, 111);
    let new_ad = U256::from_u32(&env, 222);
    let siblings = Vec::<U256>::new(&env);

    let r = client.try_update_auth_policy(&user, &old_ad, &new_ad, &siblings);

    assert!(

        matches!(r, Err(Ok(Error::NotRegistered))),

        "expected Error::NotRegistered from this call specifically, got {:?}",

        r

    );
}

// ── set_viewing_key ──

#[test]
fn test_set_viewing_key() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let vk = BytesN::from_array(&env, &[1u8; 32]);
    client.set_viewing_key(&user, &vk);
    assert_eq!(client.get_viewing_key(&user), vk);
}

#[test]
fn test_set_viewing_key_update() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let vk1 = BytesN::from_array(&env, &[1u8; 32]);
    let vk2 = BytesN::from_array(&env, &[2u8; 32]);

    client.set_viewing_key(&user, &vk1);
    assert_eq!(client.get_viewing_key(&user), vk1);

    client.set_viewing_key(&user, &vk2);
    assert_eq!(client.get_viewing_key(&user), vk2);
}

// ── is_known_root ──

#[test]
fn test_is_known_root_false_for_unknown() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let unknown = U256::from_u32(&env, 9999);
    assert!(!client.is_known_root(&unknown));
}

#[test]
fn test_is_known_root_false_for_zero() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let zero = U256::from_u32(&env, 0);
    assert!(!client.is_known_root(&zero));
}

// ── current_root / latest_root ──

#[test]
fn test_current_root_is_zero_on_empty_tree() {
    // EVM currentRoot returns 0 before any root is recorded.
    let env = Env::default();
    let (client, _) = setup(&env);
    assert_eq!(client.current_root(), U256::from_u32(&env, 0));
    assert_eq!(client.latest_root(), U256::from_u32(&env, 0));
    assert!(!client.is_known_root(&U256::from_u32(&env, 0)));
}

// ── get_nullifying_key ──

#[test]
fn test_get_nullifying_key_rejects_unregistered() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let user = Address::generate(&env);
    let r = client.try_get_nullifying_key(&user);
    assert!(
        matches!(r, Err(Ok(Error::NotRegistered))),
        "expected Error::NotRegistered from this call specifically, got {:?}",
        r
    );
}

// ── get_viewing_key ──

#[test]
fn test_get_viewing_key_rejects_unset() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let user = Address::generate(&env);
    let r = client.try_get_viewing_key(&user);
    assert!(
        matches!(r, Err(Ok(Error::NotRegistered))),
        "expected Error::NotRegistered from this call specifically, got {:?}",
        r
    );
}

// ── Multiple registrations with tree growth ──

#[test]
fn test_four_registrations_tree_growth() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let mut roots = soroban_sdk::vec![&env];

    for i in 0..4u32 {
        let user = Address::generate(&env);
        let nk = U256::from_u32(&env, 1000 + i);
        let ad = U256::from_u32(&env, 2000 + i);
        client.set_auth_policy(&user, &nk, &ad);
        roots.push_back(client.latest_root());
    }

    assert_eq!(client.tree_size(), 4);

    // All 4 roots should be in history
    for i in 0..4u32 {
        assert!(client.is_known_root(&roots.get(i).unwrap()));
    }
}

// ── update_auth_policy: InvalidProof ──

#[test]
fn test_update_auth_policy_rejects_invalid_proof() {
    let env = Env::default();
    let (client, _) = setup(&env);

    // Register 2 users to create a tree with depth=1 (needs siblings)
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let nk1 = U256::from_u32(&env, 111);
    let nk2 = U256::from_u32(&env, 222);
    let ad1 = U256::from_u32(&env, 333);
    let ad2 = U256::from_u32(&env, 444);

    client.set_auth_policy(&user1, &nk1, &ad1);
    client.set_auth_policy(&user2, &nk2, &ad2);

    // Tree has 2 leaves, depth=1. User1 at index 0 needs 1 sibling.
    // Provide NO siblings — should fail with InvalidProof (too few siblings)
    let empty_siblings = Vec::<U256>::new(&env);
    let new_ad = U256::from_u32(&env, 999);
    let r = client.try_update_auth_policy(&user1, &ad1, &new_ad, &empty_siblings);
    assert!(
        matches!(r, Err(Ok(Error::InvalidProof))),
        "expected Error::InvalidProof from this call specifically, got {:?}",
        r
    );
}

// ── update_auth_policy: UnknownRoot ──

#[test]
fn test_update_auth_policy_rejects_unknown_root() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let nk = U256::from_u32(&env, 111);
    let ad = U256::from_u32(&env, 333);

    client.set_auth_policy(&user, &nk, &ad);

    // With tree_size=1, depth=0, no siblings needed.
    // Provide wrong old_auth_digest → wrong leaf → wrong computed root → UnknownRoot
    let wrong_old_ad = U256::from_u32(&env, 999);
    let new_ad = U256::from_u32(&env, 888);
    let empty_siblings = Vec::<U256>::new(&env);
    let r = client.try_update_auth_policy(&user, &wrong_old_ad, &new_ad, &empty_siblings);
    assert!(
        matches!(r, Err(Ok(Error::UnknownRoot))),
        "expected Error::UnknownRoot from this call specifically, got {:?}",
        r
    );
}

// ── update_auth_policy: cross-user attack (EVM parity: cannotUpdateAnotherUsersLeaf) ──

#[test]
fn test_update_auth_policy_cannot_update_other_user() {
    let env = Env::default();
    let (client, _) = setup(&env);

    // Register Alice and Bob (tree_size=2, depth=1)
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let nk_alice = U256::from_u32(&env, 111);
    let nk_bob = U256::from_u32(&env, 222);
    let ad_alice = U256::from_u32(&env, 333);
    let ad_bob = U256::from_u32(&env, 444);

    client.set_auth_policy(&alice, &nk_alice, &ad_alice);
    client.set_auth_policy(&bob, &nk_bob, &ad_bob);

    // Bob tries to update using Alice's old auth_digest.
    // The contract computes old_leaf = Poseidon(hash(bob), nk_bob, ad_alice).
    // Bob's REAL leaf is Poseidon(hash(bob), nk_bob, ad_bob).
    // Since ad_alice != ad_bob, the computed old_leaf is wrong,
    // the recomputed root won't match any known root → UnknownRoot.
    let alice_hash = soroban_v2_utils::address_to_field(&env, &alice);
    let alice_leaf = soroban_v2_utils::poseidon::poseidon_hash_three(
        &env, &alice_hash, &nk_alice, &ad_alice,
    );

    // Bob at index 1 needs Alice's leaf as sibling
    let siblings = soroban_sdk::vec![&env, alice_leaf];
    let new_ad = U256::from_u32(&env, 999);

    let r = client.try_update_auth_policy(&bob, &ad_alice, &new_ad, &siblings);

    assert!(

        matches!(r, Err(Ok(Error::UnknownRoot))),

        "expected Error::UnknownRoot from this call specifically, got {:?}",

        r

    );
}

// ── update_auth_policy: multi-level proof (EVM parity: updateWithLongProof) ──

#[test]
fn test_update_auth_policy_with_multi_level_proof() {
    let env = Env::default();
    let (client, _) = setup(&env);

    // Register 3 users: tree_size=3, depth=2
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);

    let nk_a = U256::from_u32(&env, 111);
    let nk_b = U256::from_u32(&env, 222);
    let nk_c = U256::from_u32(&env, 333);
    let ad_a = U256::from_u32(&env, 1000);
    let ad_b = U256::from_u32(&env, 2000);
    let ad_c = U256::from_u32(&env, 3000);

    client.set_auth_policy(&alice, &nk_a, &ad_a);
    client.set_auth_policy(&bob, &nk_b, &ad_b);
    client.set_auth_policy(&charlie, &nk_c, &ad_c);

    assert_eq!(client.tree_size(), 3);
    let root_before = client.latest_root();

    // Tree structure (3 leaves, depth=2):
    //       root
    //      /    \
    //   H(a,b)   c       (charlie is on rightmost path at level 1)
    //   /   \
    //  a     b
    //
    // Alice at index 0 needs 2 siblings:
    // Level 0: Bob's leaf (index_bit=0, not on rightmost path → need sibling)
    // Level 1: Charlie's leaf (index_bit=0, not on rightmost path → need sibling)

    let bob_hash = soroban_v2_utils::address_to_field(&env, &bob);
    let charlie_hash = soroban_v2_utils::address_to_field(&env, &charlie);
    let bob_leaf =
        soroban_v2_utils::poseidon::poseidon_hash_three(&env, &bob_hash, &nk_b, &ad_b);
    let charlie_leaf =
        soroban_v2_utils::poseidon::poseidon_hash_three(&env, &charlie_hash, &nk_c, &ad_c);

    let siblings = soroban_sdk::vec![&env, bob_leaf, charlie_leaf];
    let new_ad_a = U256::from_u32(&env, 9999);

    // Update Alice's auth digest with a 2-level sibling proof
    client.update_auth_policy(&alice, &ad_a, &new_ad_a, &siblings);

    let root_after = client.latest_root();
    assert!(root_after != root_before);
    assert!(client.is_known_root(&root_after));
    assert!(client.is_known_root(&root_before));
}

// ── Time-based root liveness (validUntil) ──

#[test]
fn test_superseded_root_known_within_liveness() {
    let env = Env::default();
    let (client, _) = setup(&env);
    env.ledger().set_timestamp(1_000);

    let user1 = Address::generate(&env);
    client.set_auth_policy(&user1, &U256::from_u32(&env, 100), &U256::from_u32(&env, 200));
    let root1 = client.latest_root();

    let user2 = Address::generate(&env);
    client.set_auth_policy(&user2, &U256::from_u32(&env, 101), &U256::from_u32(&env, 201));
    let root2 = client.latest_root();

    // root1 is superseded but still within its liveness window (time unchanged).
    assert_eq!(client.current_root(), root2);
    assert!(client.is_known_root(&root1));
    assert!(client.is_known_root(&root2));
    // valid_until stamped at supersession time + liveness.
    assert_eq!(client.previous_root_valid_until(&root1), 1_000 + KEYSTORE_ROOT_LIVENESS);
}

#[test]
fn test_superseded_root_expires_after_liveness() {
    let env = Env::default();
    let (client, _) = setup(&env);
    env.ledger().set_timestamp(1_000);

    let user1 = Address::generate(&env);
    client.set_auth_policy(&user1, &U256::from_u32(&env, 100), &U256::from_u32(&env, 200));
    let root1 = client.latest_root();

    let user2 = Address::generate(&env);
    client.set_auth_policy(&user2, &U256::from_u32(&env, 101), &U256::from_u32(&env, 201));
    let root2 = client.latest_root();

    // Advance past root1's validUntil (1000 + 3600 = 4600).
    env.ledger().set_timestamp(1_000 + KEYSTORE_ROOT_LIVENESS + 1);
    assert!(!client.is_known_root(&root1)); // expired
    assert!(client.is_known_root(&root2)); // current root always known
}

// ── is_known_root on uninitialized contract ──

#[test]
fn test_is_known_root_false_when_not_initialized() {
    // The view is harmless before init: no current root, no previous roots.
    let env = Env::default();
    let contract_id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &contract_id);
    assert!(!client.is_known_root(&U256::from_u32(&env, 42)));
}

// ── liveness / max-tree-size setters ──

#[test]
fn test_set_keystore_root_liveness_happy() {
    let env = Env::default();
    let (client, _admin, upgrader) = setup_with_upgrader(&env);
    assert_eq!(client.keystore_root_liveness(), KEYSTORE_ROOT_LIVENESS);
    client.set_keystore_root_liveness(&upgrader, &7_200);
    assert_eq!(client.keystore_root_liveness(), 7_200);
}

#[test]
fn test_set_keystore_root_liveness_rejects_non_upgrader() {
    let env = Env::default();
    let (client, _admin, _upgrader) = setup_with_upgrader(&env);
    let rando = Address::generate(&env);
    let r = client.try_set_keystore_root_liveness(&rando, &7_200);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_keystore_root_liveness_rejects_zero() {
    let env = Env::default();
    let (client, _admin, upgrader) = setup_with_upgrader(&env);
    let r = client.try_set_keystore_root_liveness(&upgrader, &0);
    assert!(
        matches!(r, Err(Ok(Error::InvalidRootLiveness))),
        "expected Error::InvalidRootLiveness from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_max_keystore_tree_size_happy() {
    let env = Env::default();
    let (client, _admin, upgrader) = setup_with_upgrader(&env);
    assert_eq!(client.max_keystore_tree_size(), MAX_KEYSTORE_TREE_SIZE);
    client.set_max_keystore_tree_size(&upgrader, &(MAX_KEYSTORE_TREE_SIZE * 2));
    assert_eq!(client.max_keystore_tree_size(), MAX_KEYSTORE_TREE_SIZE * 2);
}

#[test]
fn test_set_max_keystore_tree_size_rejects_not_above_size() {
    let env = Env::default();
    let (client, _admin, upgrader) = setup_with_upgrader(&env);
    let r = client.try_set_max_keystore_tree_size(&upgrader, &0);
    assert!(
        matches!(r, Err(Ok(Error::InvalidMaxTreeSize))),
        "expected Error::InvalidMaxTreeSize from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_keystore_tree_cap_enforced() {
    // cap = 1: first registration fills the tree, second exceeds it.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &KEYSTORE_ROOT_LIVENESS, &1u32);

    let user1 = Address::generate(&env);
    client.set_auth_policy(&user1, &U256::from_u32(&env, 100), &U256::from_u32(&env, 200));
    let user2 = Address::generate(&env);
    let r = client.try_set_auth_policy(&user2, &U256::from_u32(&env, 101), &U256::from_u32(&env, 201));
    assert!(
        matches!(r, Err(Ok(Error::KeystoreTreeFull))),
        "expected Error::KeystoreTreeFull from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_tree_size_rejects_not_initialized() {
    let env = Env::default();
    let contract_id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &contract_id);
    let r = client.try_tree_size();
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_auth_policy_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &contract_id);
    let user = Address::generate(&env);
    let nk = U256::from_u32(&env, 111);
    let ad = U256::from_u32(&env, 222);
    let r = client.try_set_auth_policy(&user, &nk, &ad);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_update_auth_policy_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &contract_id);
    let user = Address::generate(&env);

    // Inject NullifyingKey and LeafIndex so we pass NotRegistered checks
    // and reach the TreeSize (NotInitialized) check.
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::NullifyingKey(user.clone()), &U256::from_u32(&env, 111));
        env.storage()
            .persistent()
            .set(&DataKey::LeafIndex(user.clone()), &0u32);
    });

    let siblings = soroban_sdk::Vec::<U256>::new(&env);
    let r = client.try_update_auth_policy(&user, &U256::from_u32(&env, 222), &U256::from_u32(&env, 333), &siblings);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

// ── Auth rejection tests (TEST-03) ──

/// Authorization on `set_auth_policy`, proven rather than assumed.
///
/// The previous version was `#[should_panic]` with no expected string, and its setup called
/// `env.mock_auths(&[])`. That combination proves nothing: `mock_auths(&[])` makes EVERY call fail,
/// so the test passed whether or not `owner.require_auth()` existed, and a bare `should_panic`
/// accepts any panic at all — including one from the setup. This repo has been bitten by exactly
/// this twice; see the Lessons Learned entry on `is_err()` passing for the wrong reason.
///
/// The replacement grants authorization to a STRANGER for precisely the call under test. With the
/// gate present the call fails, because the address it requires is absent. With the gate removed it
/// would succeed, because nothing is required. The control grants the correct address and must
/// succeed — without it, "the call failed" is compatible with the contract being broken.
#[test]
fn test_set_auth_policy_requires_the_owners_authorization() {
    let env = Env::default();
    let contract_id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin, &KEYSTORE_ROOT_LIVENESS, &MAX_KEYSTORE_TREE_SIZE);

    let user = Address::generate(&env);
    let stranger = Address::generate(&env);
    let nk = U256::from_u32(&env, 111);
    let ad = U256::from_u32(&env, 222);
    let args: soroban_sdk::Vec<soroban_sdk::Val> =
        (user.clone(), nk.clone(), ad.clone()).into_val(&env);

    // A macro, not a closure: the client returned by `mock_auths` borrows the temporaries built
    // for the invoke, so a closure cannot return it. `yield-token`'s `as_only!` hit the same wall.
    macro_rules! only {
        ($who:expr) => {
            client.mock_auths(&[MockAuth {
                address: $who,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_auth_policy",
                    args: args.clone(),
                    sub_invokes: &[],
                },
            }])
        };
    }

    assert!(
        only!(&stranger).try_set_auth_policy(&user, &nk, &ad).is_err(),
        "a stranger's authorization must not stand in for the owner's"
    );
    assert_eq!(
        client.tree_size(), 0,
        "a refused registration must not insert a leaf"
    );

    // The control. Without it, the assertion above is satisfied by any breakage at all.
    only!(&user)
        .try_set_auth_policy(&user, &nk, &ad)
        .expect("the owner's own authorization must be accepted")
        .expect("registration must succeed with correct authorization");
    assert_eq!(client.tree_size(), 1, "the control must actually register");
    assert_eq!(
        client.get_nullifying_key(&user), nk,
        "and must register the key the owner authorized"
    );
}

/// Authorization on `update_auth_policy`, proven rather than assumed.
///
/// Replaces a bare `#[should_panic]` whose setup called `env.mock_auths(&[])`. That makes EVERY call
/// fail, so the test passed whether or not the gate existed, and a bare `should_panic` accepts any
/// panic — including one from the setup. A stranger's grant plus a control that must succeed is the
/// only shape that distinguishes "the gate fired" from "everything is broken".
#[test]
fn test_update_auth_policy_requires_the_owners_authorization() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let stranger = Address::generate(&env);
    let nk_hash = U256::from_u32(&env, 12345);
    let old_ad = U256::from_u32(&env, 67890);
    let new_ad = U256::from_u32(&env, 99999);
    client.set_auth_policy(&user, &nk_hash, &old_ad);
    let root_before = client.latest_root();

    // One leaf, so the root IS the leaf and no siblings are needed — the control can therefore
    // succeed on its merits, which is what makes the negative case attributable to the gate.
    let siblings = Vec::<U256>::new(&env);
    let args: soroban_sdk::Vec<soroban_sdk::Val> =
        (user.clone(), old_ad.clone(), new_ad.clone(), siblings.clone()).into_val(&env);
    macro_rules! only {
        ($who:expr) => {
            client.mock_auths(&[MockAuth {
                address: $who,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "update_auth_policy",
                    args: args.clone(),
                    sub_invokes: &[],
                },
            }])
        };
    }

    assert!(
        only!(&stranger)
            .try_update_auth_policy(&user, &old_ad, &new_ad, &siblings)
            .is_err(),
        "a stranger's authorization must not stand in for the owner's"
    );
    assert_eq!(
        client.latest_root(), root_before,
        "a refused update must not change the tree"
    );

    only!(&user)
        .try_update_auth_policy(&user, &old_ad, &new_ad, &siblings)
        .expect("the owner's own authorization must be accepted")
        .expect("the update must succeed with correct authorization");
    assert!(
        client.latest_root() != root_before,
        "the control must actually update the tree"
    );
}

/// Authorization on `set_viewing_key`, proven rather than assumed. Same replacement, same reason.
#[test]
fn test_set_viewing_key_requires_the_owners_authorization() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let stranger = Address::generate(&env);
    client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));

    let viewing_key = soroban_sdk::BytesN::from_array(&env, &[7u8; 32]);
    let args: soroban_sdk::Vec<soroban_sdk::Val> =
        (user.clone(), viewing_key.clone()).into_val(&env);
    macro_rules! only {
        ($who:expr) => {
            client.mock_auths(&[MockAuth {
                address: $who,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_viewing_key",
                    args: args.clone(),
                    sub_invokes: &[],
                },
            }])
        };
    }

    assert!(
        only!(&stranger).try_set_viewing_key(&user, &viewing_key).is_err(),
        "a stranger's authorization must not stand in for the owner's"
    );

    only!(&user)
        .try_set_viewing_key(&user, &viewing_key)
        .expect("the owner's own authorization must be accepted")
        .expect("setting a viewing key must succeed with correct authorization");
}

// ── Event emission tests ──

#[test]
fn test_set_auth_policy_emits_events() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let user = Address::generate(&env);
    let nk_hash = U256::from_u32(&env, 12345);
    let auth_digest = U256::from_u32(&env, 67890);

    client.set_auth_policy(&user, &nk_hash, &auth_digest);

    // Capture events BEFORE any other contract calls (which reset the event buffer)
    let events = env.events().all();

    // Compute the expected leaf: Poseidon(address_hash, nk_hash, auth_digest)
    let address_hash = address_to_field(&env, &user);
    let expected_leaf = poseidon_hash_three(&env, &address_hash, &nk_hash, &auth_digest);
    let expected_root = client.latest_root();

    // Check AuthPolicySet event
    let expected_auth_event = AuthPolicySet {
        account: user.clone(),
        nullifying_key_hash: nk_hash,
        auth_digest,
    };
    assert!(
        events.events().contains(&expected_auth_event.to_xdr(&env, &client.address)),
        "AuthPolicySet event not found"
    );

    // Check LeafInserted event
    let expected_leaf_event = LeafInserted {
        leaf: expected_leaf,
        root: expected_root,
        index: 0,
    };
    assert!(
        events.events().contains(&expected_leaf_event.to_xdr(&env, &client.address)),
        "LeafInserted event not found"
    );
}

// ── set_upgrader / upgrade (mirrors EVM UPGRADER_ROLE) ──

#[test]
fn test_set_upgrader_happy_path() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let upgrader = Address::generate(&env);
    client.set_upgrader(&admin, &upgrader);
}

#[test]
fn test_set_upgrader_rejects_non_admin() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let not_admin = Address::generate(&env);
    let upgrader = Address::generate(&env);
    let r = client.try_set_upgrader(&not_admin, &upgrader);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_upgrade_rejects_non_upgrader() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let upgrader = Address::generate(&env);
    client.set_upgrader(&admin, &upgrader);
    let attacker = Address::generate(&env);
    let wasm_hash = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let r = client.try_upgrade(&attacker, &wasm_hash);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_upgrade_rejects_admin_when_not_upgrader() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let upgrader = Address::generate(&env);
    client.set_upgrader(&admin, &upgrader);
    let wasm_hash = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let r = client.try_upgrade(&admin, &wasm_hash);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_upgrade_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &id);
    let caller = Address::generate(&env);
    let wasm_hash = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let r = client.try_upgrade(&caller, &wasm_hash);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_upgrader_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(KeystoreContract, ());
    let client = KeystoreContractClient::new(&env, &id);
    let addr = Address::generate(&env);
    let r = client.try_set_upgrader(&addr, &addr);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_upgrade_rejects_zero_wasm_hash() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let upgrader = Address::generate(&env);
    client.set_upgrader(&admin, &upgrader);
    let zero_hash = BytesN::<32>::from_array(&env, &[0u8; 32]);
    let r = client.try_upgrade(&upgrader, &zero_hash);
    assert!(
        matches!(r, Err(Ok(Error::InvalidWasmHash))),
        "expected Error::InvalidWasmHash from this call specifically, got {:?}",
        r
    );
}

// Composite freeze-by-rotation (audit R4 LOW-02): admin rotates Upgrader to
// a fresh address; the previously-valid upgrader can no longer upgrade.
// Mirrors the burn-address freeze model introduced by d7533b9.
#[test]
fn test_upgrade_rejects_after_admin_rotates_upgrader() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let upgrader_a = Address::generate(&env);
    client.set_upgrader(&admin, &upgrader_a);

    // Admin rotates Upgrader to a burn-address stand-in.
    let burn_address = Address::generate(&env);
    client.set_upgrader(&admin, &burn_address);

    // Previously-valid upgrader must now be rejected with NotAuthorized (#13).
    let wasm_hash = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let r = client.try_upgrade(&upgrader_a, &wasm_hash);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}


// ── BN254 scalar-field range validation (MOL-7 boundary) ──
//
// Closes four relaxation-sweep survivors: lib.rs:351, :354, :472, :475 all
// SURVIVED `>=` -> `>`, meaning a value EXACTLY equal to the field modulus was
// accepted and no test noticed. `p` is the boundary that matters here: in the
// scalar field `p` and `0` are the same element, so accepting `p` would admit a
// value the circuit reduces to zero — the case a `>=` guard exists to reject.
//
// Each guard gets both halves of the boundary per MOL-7: `p` must be REJECTED
// and `p - 1` must be ACCEPTED. Testing only that some huge value is rejected
// leaves the equality case unpinned, which is exactly how these four survived.

/// The BN254 scalar field modulus `p`, as the contract computes it.
fn field_mod(env: &Env) -> U256 {
    U256::from_be_bytes(
        env,
        &soroban_sdk::Bytes::from_slice(env, &SNARK_SCALAR_FIELD_BYTES),
    )
}

fn field_mod_minus_one(env: &Env) -> U256 {
    field_mod(env).sub(&U256::from_u32(env, 1))
}

#[test]
fn test_set_auth_policy_rejects_nullifying_key_hash_equal_to_field_modulus() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let owner = Address::generate(&env);
    let r = client.try_set_auth_policy(&owner, &field_mod(&env), &U256::from_u32(&env, 7));
    assert!(
        matches!(r, Err(Ok(Error::OutOfScalarField))),
        "nullifying_key_hash == p must be rejected (p reduces to 0 in the field)"
    );
}

#[test]
fn test_set_auth_policy_rejects_auth_digest_equal_to_field_modulus() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let owner = Address::generate(&env);
    let r = client.try_set_auth_policy(&owner, &U256::from_u32(&env, 7), &field_mod(&env));
    assert!(
        matches!(r, Err(Ok(Error::OutOfScalarField))),
        "auth_digest == p must be rejected"
    );
}

/// The other half of MOL-7: the largest legal value must be ACCEPTED.
/// Without this, degrading `>=` to `>` goes unnoticed.
#[test]
fn test_set_auth_policy_accepts_field_modulus_minus_one() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let owner = Address::generate(&env);
    let max_legal = field_mod_minus_one(&env);
    client.set_auth_policy(&owner, &max_legal, &max_legal);
    assert_eq!(client.get_nullifying_key(&owner), max_legal);
}

#[test]
fn test_update_auth_policy_rejects_old_auth_digest_equal_to_field_modulus() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let owner = Address::generate(&env);
    client.set_auth_policy(&owner, &U256::from_u32(&env, 5), &U256::from_u32(&env, 7));
    let r = client.try_update_auth_policy(
        &owner,
        &field_mod(&env),
        &U256::from_u32(&env, 9),
        &soroban_sdk::vec![&env],
    );
    assert!(
        matches!(r, Err(Ok(Error::OutOfScalarField))),
        "old_auth_digest == p must be rejected"
    );
}

#[test]
fn test_update_auth_policy_rejects_new_auth_digest_equal_to_field_modulus() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let owner = Address::generate(&env);
    client.set_auth_policy(&owner, &U256::from_u32(&env, 5), &U256::from_u32(&env, 7));
    let r = client.try_update_auth_policy(
        &owner,
        &U256::from_u32(&env, 7),
        &field_mod(&env),
        &soroban_sdk::vec![&env],
    );
    assert!(
        matches!(r, Err(Ok(Error::OutOfScalarField))),
        "new_auth_digest == p must be rejected"
    );
}

/// Closes the relaxation survivor at lib.rs:247 (`<` -> `<=`).
///
/// The existing liveness tests check "time unchanged" (known) and
/// "valid_until + 1" (expired). Neither pins the boundary itself, so degrading
/// the comparison to `<=` — which would keep a root alive for one extra instant
/// — passed the whole suite.
///
/// The semantics are that `valid_until` is EXCLUSIVE: at exactly that timestamp
/// the root is already expired. This matches the SDK-side convention recorded
/// in docs/DEVIATIONS.md INTL-16, where a commitment expiring exactly now is
/// rejected.
#[test]
fn test_superseded_root_expiry_boundary_is_exclusive() {
    let env = Env::default();
    let (client, _) = setup(&env);
    env.ledger().set_timestamp(1_000);

    let user1 = Address::generate(&env);
    client.set_auth_policy(&user1, &U256::from_u32(&env, 100), &U256::from_u32(&env, 200));
    let root1 = client.latest_root();

    let user2 = Address::generate(&env);
    client.set_auth_policy(&user2, &U256::from_u32(&env, 101), &U256::from_u32(&env, 201));

    let valid_until = client.previous_root_valid_until(&root1);
    assert_eq!(valid_until, 1_000 + KEYSTORE_ROOT_LIVENESS);

    // The last instant at which the root is still live.
    env.ledger().set_timestamp(valid_until - 1);
    assert!(
        client.is_known_root(&root1),
        "a superseded root must remain known at valid_until - 1"
    );

    // Exactly at valid_until it is already gone — the bound is exclusive.
    env.ledger().set_timestamp(valid_until);
    assert!(
        !client.is_known_root(&root1),
        "valid_until is exclusive: the root must be expired at exactly that timestamp"
    );
}

// Direct coverage in the crate that OWNS the function. It was previously
// exercised only through contracts/relay's register_and_relay tests — real
// coverage, but not in the crate responsible for it.
#[test]
fn test_get_nullifying_key_or_zero_returns_zero_when_unregistered() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let stranger = Address::generate(&env);
    assert_eq!(
        client.get_nullifying_key_or_zero(&stranger),
        U256::from_u32(&env, 0),
        "an unregistered account must probe as 0 — the sentinel register_and_relay relies on"
    );
}

#[test]
fn test_get_nullifying_key_or_zero_returns_the_stored_hash_once_registered() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let owner = Address::generate(&env);
    let nkh = U256::from_u32(&env, 4242);
    client.set_auth_policy(&owner, &nkh, &U256::from_u32(&env, 7));
    assert_eq!(client.get_nullifying_key_or_zero(&owner), nkh);
}

/// ALIGNMENT-R2 (CRITICAL) — a stale-but-still-"known" proof must NOT mutate the tree.
///
/// `update_auth_policy` used to gate on `root_is_known(computed_root)`, which
/// accepts any superseded root still inside the liveness window (INTL-14, 1h by
/// default). That is the right check for a READ-ONLY consumer of a historical
/// root, but this is a tree-MUTATING path.
///
/// EVM never does this: `Keystore.updateAuthPolicy` does not call `isKnownRoot`
/// at all. It delegates to LeanIMT `_update`, which requires
/// `oldRoot == _root(self)` EXACTLY and only rewrites a side node when
/// `sideNodes[level] == oldRoot`.
///
/// The consequence, proven below before the fix: Alice fetches a proof, Dave
/// registers, Alice submits. Her proof still verified against its own
/// superseded root, so it passed — and the update then wrote a root computed
/// over the OLD leaf set, silently dropping Dave. Every later insert builds on
/// the corrupted side-node cache, permanently desynchronising the on-chain root
/// from any correctly-computed off-chain root, which breaks `pool.transact` and
/// `pool.ragequit` keystore-root checks for the whole pool.
///
/// No malice required — two honest users, an ordinary race, inside the window.
#[test]
fn test_update_auth_policy_rejects_stale_proof_after_growth() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    let dave = Address::generate(&env);

    let (nk_a, nk_b, nk_c, nk_d) = (
        U256::from_u32(&env, 111),
        U256::from_u32(&env, 222),
        U256::from_u32(&env, 333),
        U256::from_u32(&env, 444),
    );
    let (ad_a, ad_b, ad_c, ad_d) = (
        U256::from_u32(&env, 1000),
        U256::from_u32(&env, 2000),
        U256::from_u32(&env, 3000),
        U256::from_u32(&env, 4000),
    );

    client.set_auth_policy(&alice, &nk_a, &ad_a);
    client.set_auth_policy(&bob, &nk_b, &ad_b);
    client.set_auth_policy(&charlie, &nk_c, &ad_c);
    assert_eq!(client.tree_size(), 3);

    // Alice's proof, generated against tree_size = 3.
    let bob_leaf = soroban_v2_utils::poseidon::poseidon_hash_three(
        &env,
        &soroban_v2_utils::address_to_field(&env, &bob),
        &nk_b,
        &ad_b,
    );
    let charlie_leaf = soroban_v2_utils::poseidon::poseidon_hash_three(
        &env,
        &soroban_v2_utils::address_to_field(&env, &charlie),
        &nk_c,
        &ad_c,
    );
    let stale_siblings = soroban_sdk::vec![&env, bob_leaf, charlie_leaf];

    // Dave registers before Alice submits. The old root is now superseded, but
    // still within its liveness window — so `root_is_known` would accept it.
    client.set_auth_policy(&dave, &nk_d, &ad_d);
    assert_eq!(client.tree_size(), 4);
    let root_with_dave = client.latest_root();
    let stale_root = client.previous_root_valid_until(&root_with_dave);
    let _ = stale_root;

    let r = client.try_update_auth_policy(
        &alice,
        &ad_a,
        &U256::from_u32(&env, 9999),
        &stale_siblings,
    );

    assert!(
        matches!(r, Err(Ok(Error::UnknownRoot))),
        "a proof against a superseded root must be rejected on a tree-mutating \
         path, even while that root is still 'known' for read purposes, got {:?}",
        r
    );
    assert_eq!(
        client.latest_root(),
        root_with_dave,
        "the tree must be untouched by the rejected update"
    );
    assert_eq!(client.tree_size(), 4);
}

/// The other half: a FRESH proof against the current root still works. Without
/// this, the fix above could be "achieved" by rejecting every update.
#[test]
fn test_update_auth_policy_accepts_a_fresh_proof() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let nk_a = U256::from_u32(&env, 111);
    let nk_b = U256::from_u32(&env, 222);
    let ad_a = U256::from_u32(&env, 1000);
    let ad_b = U256::from_u32(&env, 2000);

    client.set_auth_policy(&alice, &nk_a, &ad_a);
    client.set_auth_policy(&bob, &nk_b, &ad_b);

    let bob_leaf = soroban_v2_utils::poseidon::poseidon_hash_three(
        &env,
        &soroban_v2_utils::address_to_field(&env, &bob),
        &nk_b,
        &ad_b,
    );
    let before = client.latest_root();
    client.update_auth_policy(
        &alice,
        &ad_a,
        &U256::from_u32(&env, 9999),
        &soroban_sdk::vec![&env, bob_leaf],
    );
    assert!(client.latest_root() != before, "a fresh proof must still update the tree");
}

/// AUDIT-R2 (CRITICAL) — a VALID rotation must not leave the side-node cache
/// stale, or the NEXT insert derives a root for a leaf set that no longer
/// exists.
///
/// `lean_imt_update` used to write a side node only on the rightmost path. EVM's
/// `InternalLeanIMT._update` also refreshes a cached side node on the
/// left-child-with-sibling branch, when that node still holds the intermediate
/// being replaced.
///
/// The root returned by the update call itself was always correct, which is why
/// nothing caught this: the damage is LATENT. The stale cache is read by the
/// next `set_auth_policy`, and from then on the chain's tree has permanently
/// forked from any honestly-reconstructed client tree — so no valid membership
/// proof can ever land again, breaking `transact` and `ragequit` pool-wide.
///
/// Triggered by entirely ordinary use: any key rotation followed by any
/// registration. No malice, no race, no adversary.
///
/// The assertion compares against an independent oracle — a second keystore
/// built from scratch over the same final leaf set — rather than merely
/// checking that the root changed, which is what the pre-existing rotation
/// tests did.
#[test]
fn test_rotation_then_insert_keeps_canonical_root() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    let dave = Address::generate(&env);
    let (nk_a, nk_b, nk_c, nk_d) = (
        U256::from_u32(&env, 111), U256::from_u32(&env, 222),
        U256::from_u32(&env, 333), U256::from_u32(&env, 444),
    );
    let (ad_a, ad_b, ad_c, ad_d) = (
        U256::from_u32(&env, 1000), U256::from_u32(&env, 2000),
        U256::from_u32(&env, 3000), U256::from_u32(&env, 4000),
    );
    let new_ad_a = U256::from_u32(&env, 9999);

    client.set_auth_policy(&alice, &nk_a, &ad_a);
    client.set_auth_policy(&bob, &nk_b, &ad_b);
    client.set_auth_policy(&charlie, &nk_c, &ad_c);

    // A FRESH, valid rotation against the current root — alice is a left child
    // at level 1, i.e. NOT on the rightmost path.
    let bob_leaf = soroban_v2_utils::poseidon::poseidon_hash_three(
        &env, &soroban_v2_utils::address_to_field(&env, &bob), &nk_b, &ad_b);
    let charlie_leaf = soroban_v2_utils::poseidon::poseidon_hash_three(
        &env, &soroban_v2_utils::address_to_field(&env, &charlie), &nk_c, &ad_c);
    client.update_auth_policy(&alice, &ad_a, &new_ad_a,
        &soroban_sdk::vec![&env, bob_leaf, charlie_leaf]);

    // Now an ordinary registration, which reads the cached side nodes.
    client.set_auth_policy(&dave, &nk_d, &ad_d);
    let after_insert = client.latest_root();

    // ORACLE: a second keystore built from scratch over the SAME final leaf set.
    let admin2 = Address::generate(&env);
    let ks2 = env.register(KeystoreContract, ());
    let c2 = KeystoreContractClient::new(&env, &ks2);
    c2.initialize(&admin2, &KEYSTORE_ROOT_LIVENESS, &MAX_KEYSTORE_TREE_SIZE);
    c2.set_auth_policy(&alice, &nk_a, &new_ad_a);
    c2.set_auth_policy(&bob, &nk_b, &ad_b);
    c2.set_auth_policy(&charlie, &nk_c, &ad_c);
    c2.set_auth_policy(&dave, &nk_d, &ad_d);
    let correct = c2.latest_root();

    std::println!("roots_match_after_rotation_then_insert : {}", after_insert == correct);
    assert_eq!(
        after_insert, correct,
        "after a VALID rotation, the next insert must still produce the canonical \
         root for the true leaf set — if this fails, the side-node cache went stale"
    );
}
