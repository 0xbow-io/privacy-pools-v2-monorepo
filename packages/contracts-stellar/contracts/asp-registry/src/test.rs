//! ASP Registry contract unit tests.

use super::*;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::Event as _;

fn setup(env: &Env) -> (AspRegistryContractClient, Address, Address) {
    env.mock_all_auths();
    let contract_id = env.register(AspRegistryContract, ());
    let client = AspRegistryContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let postman = Address::generate(env);
    client.initialize(&admin, &postman);
    (client, admin, postman)
}

// ── Initialization ──

#[test]
fn test_initialize() {
    let env = Env::default();
    let (client, _, _) = setup(&env);
    assert_eq!(client.root_count(), 0);
}

#[test]
fn test_initialize_rejects_double_init() {
    let env = Env::default();
    let (client, _, _) = setup(&env);
    let admin2 = Address::generate(&env);
    let postman2 = Address::generate(&env);
    let r = client.try_initialize(&admin2, &postman2);
    assert!(
        matches!(r, Err(Ok(Error::AlreadyInitialized))),
        "expected Error::AlreadyInitialized from this call specifically, got {:?}",
        r
    );
}

// ── set_postman ──

#[test]
fn test_set_postman() {
    let env = Env::default();
    let (client, admin, postman) = setup(&env);

    // Submit a root with original postman
    let root = U256::from_u32(&env, 42);
    let cid = Bytes::from_slice(&env, b"QmTest");
    client.update_asp_root(&postman, &root, &cid);
    assert_eq!(client.root_count(), 1);

    // Change postman
    let new_postman = Address::generate(&env);
    client.set_postman(&admin, &new_postman);

    // New postman can submit
    let root2 = U256::from_u32(&env, 43);
    let cid2 = Bytes::from_slice(&env, b"QmTest2");
    client.update_asp_root(&new_postman, &root2, &cid2);
    assert_eq!(client.root_count(), 2);
}

#[test]
fn test_set_postman_emits_event() {
    let env = Env::default();
    let (client, admin, _) = setup(&env);

    let new_postman = Address::generate(&env);
    client.set_postman(&admin, &new_postman);

    let expected = PostmanUpdated {
        new_postman: new_postman.clone(),
    };
    let events = env.events().all();
    let contract_id = client.address.clone();
    assert!(
        events.events().contains(&expected.to_xdr(&env, &contract_id)),
        "PostmanUpdated event not found"
    );
}

#[test]
fn test_set_postman_rejects_non_admin() {
    let env = Env::default();
    let (client, _, _) = setup(&env);
    let non_admin = Address::generate(&env);
    let new_postman = Address::generate(&env);
    let r = client.try_set_postman(&non_admin, &new_postman);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

// ── update_asp_root ──

#[test]
fn test_update_asp_root() {
    let env = Env::default();
    let (client, _, postman) = setup(&env);

    let root = U256::from_u32(&env, 42);
    let cid = Bytes::from_slice(&env, b"QmTest123");
    client.update_asp_root(&postman, &root, &cid);

    assert_eq!(client.latest_asp_root(), root);
    assert_eq!(client.root_count(), 1);
    assert_eq!(client.get_root_at(&0), root);
    assert_eq!(client.get_cid_at(&0), cid);
}

#[test]
fn test_update_asp_root_multiple() {
    let env = Env::default();
    let (client, _, postman) = setup(&env);

    let root1 = U256::from_u32(&env, 1);
    let root2 = U256::from_u32(&env, 2);
    let root3 = U256::from_u32(&env, 3);
    let cid = Bytes::from_slice(&env, b"QmCid");

    client.update_asp_root(&postman, &root1, &cid);
    client.update_asp_root(&postman, &root2, &cid);
    client.update_asp_root(&postman, &root3, &cid);

    assert_eq!(client.root_count(), 3);
    assert_eq!(client.latest_asp_root(), root3);
    assert_eq!(client.get_root_at(&0), root1);
    assert_eq!(client.get_root_at(&1), root2);
    assert_eq!(client.get_root_at(&2), root3);
}

#[test]
fn test_update_asp_root_rejects_non_postman() {
    let env = Env::default();
    let (client, _, _) = setup(&env);
    let non_postman = Address::generate(&env);
    let root = U256::from_u32(&env, 42);
    let cid = Bytes::from_slice(&env, b"QmTest");
    let r = client.try_update_asp_root(&non_postman, &root, &cid);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_update_asp_root_rejects_zero_root() {
    let env = Env::default();
    let (client, _, postman) = setup(&env);
    let zero = U256::from_u32(&env, 0);
    let cid = Bytes::from_slice(&env, b"QmTest");
    let r = client.try_update_asp_root(&postman, &zero, &cid);
    assert!(
        matches!(r, Err(Ok(Error::EmptyRoot))),
        "expected Error::EmptyRoot from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_update_asp_root_rejects_root_at_field_modulus() {
    // root == SNARK_SCALAR_FIELD is not a valid field element (da346809 I-0).
    let env = Env::default();
    let (client, _, postman) = setup(&env);
    let field = U256::from_be_bytes(&env, &Bytes::from_slice(&env, &SNARK_SCALAR_FIELD_BYTES));
    let cid = Bytes::from_slice(&env, b"QmTest");
    let r = client.try_update_asp_root(&postman, &field, &cid);
    assert!(
        matches!(r, Err(Ok(Error::RootOutOfField))),
        "expected Error::RootOutOfField from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_update_asp_root_accepts_max_valid_field_element() {
    // root == SNARK_SCALAR_FIELD - 1 is the largest valid field element.
    let env = Env::default();
    let (client, _, postman) = setup(&env);
    let field = U256::from_be_bytes(&env, &Bytes::from_slice(&env, &SNARK_SCALAR_FIELD_BYTES));
    let max_valid = field.sub(&U256::from_u32(&env, 1));
    let cid = Bytes::from_slice(&env, b"QmTest");
    client.update_asp_root(&postman, &max_valid, &cid);
    assert_eq!(client.latest_asp_root(), max_valid);
}

#[test]
fn test_update_asp_root_rejects_empty_cid() {
    let env = Env::default();
    let (client, _, postman) = setup(&env);
    let root = U256::from_u32(&env, 42);
    let empty_cid = Bytes::new(&env);
    let r = client.try_update_asp_root(&postman, &root, &empty_cid);
    assert!(
        matches!(r, Err(Ok(Error::EmptyCid))),
        "expected Error::EmptyCid from this call specifically, got {:?}",
        r
    );
}

// ── register_label ──

#[test]
fn test_register_label() {
    let env = Env::default();
    let (client, _, _) = setup(&env);
    // Should not panic — permissionless
    client.register_label(&Bytes::from_slice(&env, b"encrypted_label_data"));
}

// ── latest_asp_root ──

#[test]
fn test_latest_asp_root_rejects_no_roots() {
    let env = Env::default();
    let (client, _, _) = setup(&env);
    let r = client.try_latest_asp_root();
    assert!(
        matches!(r, Err(Ok(Error::NoRoots))),
        "expected Error::NoRoots from this call specifically, got {:?}",
        r
    );
}

// ── get_root_at ──

#[test]
fn test_get_root_at_rejects_out_of_range() {
    let env = Env::default();
    let (client, _, postman) = setup(&env);
    let root = U256::from_u32(&env, 42);
    let cid = Bytes::from_slice(&env, b"QmTest");
    client.update_asp_root(&postman, &root, &cid);
    // Index 1 doesn't exist (only index 0)
    let r = client.try_get_root_at(&1);
    assert!(
        matches!(r, Err(Ok(Error::IndexOutOfRange))),
        "expected Error::IndexOutOfRange from this call specifically, got {:?}",
        r
    );
}

// ── get_cid_at ──

#[test]
fn test_get_cid_at_rejects_out_of_range() {
    let env = Env::default();
    let (client, _, _) = setup(&env);
    let r = client.try_get_cid_at(&0);
    assert!(
        matches!(r, Err(Ok(Error::IndexOutOfRange))),
        "expected Error::IndexOutOfRange from this call specifically, got {:?}",
        r
    );
}

// ── NotInitialized ──

#[test]
fn test_set_postman_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AspRegistryContract, ());
    let client = AspRegistryContractClient::new(&env, &contract_id);
    let addr = Address::generate(&env);
    let r = client.try_set_postman(&addr, &addr);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_update_asp_root_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AspRegistryContract, ());
    let client = AspRegistryContractClient::new(&env, &contract_id);
    let addr = Address::generate(&env);
    let root = U256::from_u32(&env, 42);
    let cid = Bytes::from_slice(&env, b"QmTest");
    let r = client.try_update_asp_root(&addr, &root, &cid);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_latest_asp_root_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AspRegistryContract, ());
    let client = AspRegistryContractClient::new(&env, &contract_id);
    let r = client.try_latest_asp_root();
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_get_root_at_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AspRegistryContract, ());
    let client = AspRegistryContractClient::new(&env, &contract_id);
    let r = client.try_get_root_at(&0);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_get_cid_at_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AspRegistryContract, ());
    let client = AspRegistryContractClient::new(&env, &contract_id);
    let r = client.try_get_cid_at(&0);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_root_count_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AspRegistryContract, ());
    let client = AspRegistryContractClient::new(&env, &contract_id);
    let r = client.try_root_count();
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

// ── Event emission tests ──

#[test]
fn test_update_asp_root_emits_event() {
    let env = Env::default();
    let (client, _, postman) = setup(&env);

    let root = U256::from_u32(&env, 42);
    let cid = Bytes::from_slice(&env, b"QmTestCid");
    client.update_asp_root(&postman, &root, &cid);

    let expected = ASPRootUpdated {
        root: root.clone(),
        index: 0,
        ipfs_cid: cid.clone(),
    };
    let events = env.events().all();
    let contract_id = client.address.clone();
    assert!(
        events.events().contains(&expected.to_xdr(&env, &contract_id)),
        "ASPRootUpdated event not found"
    );
}

#[test]
fn test_register_label_emits_event() {
    let env = Env::default();
    let (client, _, _) = setup(&env);

    let ciphertext = Bytes::from_slice(&env, b"encrypted_label_data");
    client.register_label(&ciphertext);

    let expected = LabelRegistered {
        ciphertext: ciphertext.clone(),
    };
    let events = env.events().all();
    let contract_id = client.address.clone();
    assert!(
        events.events().contains(&expected.to_xdr(&env, &contract_id)),
        "LabelRegistered event not found"
    );
}

// ── Old postman rejection after set_postman ──

#[test]
fn test_old_postman_rejected_after_set_postman() {
    let env = Env::default();
    let (client, admin, old_postman) = setup(&env);

    // Change to new postman
    let new_postman = Address::generate(&env);
    client.set_postman(&admin, &new_postman);

    // Old postman should be rejected
    let root = U256::from_u32(&env, 42);
    let cid = Bytes::from_slice(&env, b"QmTest");
    let r = client.try_update_asp_root(&old_postman, &root, &cid);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

// ── Permissionless label registration by non-admin ──

#[test]
fn test_register_label_by_non_admin() {
    let env = Env::default();
    let (client, _, _) = setup(&env);

    // Any address can register a label — no auth required
    let ciphertext = Bytes::from_slice(&env, b"encrypted_data_from_random_user");
    client.register_label(&ciphertext);
    // No panic = success. register_label is truly permissionless.
}

// ── Duplicate root values ──

#[test]
fn test_update_asp_root_accepts_duplicate_values() {
    let env = Env::default();
    let (client, _, postman) = setup(&env);

    let root = U256::from_u32(&env, 42);
    let cid1 = Bytes::from_slice(&env, b"QmCid1");
    let cid2 = Bytes::from_slice(&env, b"QmCid2");

    // Submit same root value twice (different CIDs)
    client.update_asp_root(&postman, &root, &cid1);
    client.update_asp_root(&postman, &root, &cid2);

    assert_eq!(client.root_count(), 2);
    assert_eq!(client.get_root_at(&0), root);
    assert_eq!(client.get_root_at(&1), root);
    assert_eq!(client.get_cid_at(&0), cid1);
    assert_eq!(client.get_cid_at(&1), cid2);
}

// ── set_upgrader / upgrade (mirrors EVM UPGRADER_ROLE) ──

#[test]
fn test_set_upgrader_happy_path() {
    let env = Env::default();
    let (client, admin, _) = setup(&env);
    let upgrader = Address::generate(&env);
    client.set_upgrader(&admin, &upgrader);
}

#[test]
fn test_set_upgrader_rejects_non_admin() {
    let env = Env::default();
    let (client, _, _) = setup(&env);
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
    let (client, admin, _) = setup(&env);
    let upgrader = Address::generate(&env);
    client.set_upgrader(&admin, &upgrader);
    let attacker = Address::generate(&env);
    let wasm_hash = soroban_sdk::BytesN::<32>::from_array(&env, &[1u8; 32]);
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
    let (client, admin, _) = setup(&env);
    // Admin grants upgrader role to someone else
    let upgrader = Address::generate(&env);
    client.set_upgrader(&admin, &upgrader);
    // Admin tries to upgrade — must fail (least-privilege, mirrors EVM)
    let wasm_hash = soroban_sdk::BytesN::<32>::from_array(&env, &[1u8; 32]);
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
    let id = env.register(AspRegistryContract, ());
    let client = AspRegistryContractClient::new(&env, &id);
    let caller = Address::generate(&env);
    let wasm_hash = soroban_sdk::BytesN::<32>::from_array(&env, &[1u8; 32]);
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
    let id = env.register(AspRegistryContract, ());
    let client = AspRegistryContractClient::new(&env, &id);
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
    let (client, admin, _) = setup(&env);
    let upgrader = Address::generate(&env);
    client.set_upgrader(&admin, &upgrader);
    let zero_hash = soroban_sdk::BytesN::<32>::from_array(&env, &[0u8; 32]);
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
    let (client, admin, _) = setup(&env);
    let upgrader_a = Address::generate(&env);
    client.set_upgrader(&admin, &upgrader_a);

    // Admin rotates Upgrader to a burn-address stand-in.
    let burn_address = Address::generate(&env);
    client.set_upgrader(&admin, &burn_address);

    // Previously-valid upgrader must now be rejected with NotAuthorized (#1).
    let wasm_hash = soroban_sdk::BytesN::<32>::from_array(&env, &[1u8; 32]);
    let r = client.try_upgrade(&upgrader_a, &wasm_hash);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

