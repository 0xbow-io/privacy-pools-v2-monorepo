//! Pool contract unit tests.

use super::*;
use contract_types::NoteData;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::Event as _;

/// Circuit-aligned state-tree cap used in tests (= 2^STATE_MAX_DEPTH = 2^22).
const MAX_STATE_TREE_SIZE: u32 = 4_194_304;

fn empty_note(env: &Env) -> NoteData {
    NoteData {
        hint: BytesN::from_array(env, &[0u8; 32]),
        data: Bytes::new(env),
    }
}

fn empty_note_vec(env: &Env) -> Vec<NoteData> {
    soroban_sdk::vec![env, empty_note(env)]
}

fn empty_note_vec_n(env: &Env, n: u32) -> Vec<NoteData> {
    let mut v = Vec::<NoteData>::new(env);
    for _ in 0..n {
        v.push_back(empty_note(env));
    }
    v
}

fn setup(env: &Env) -> (PoolContractClient, Address, Address, Address, Address) {
    env.mock_all_auths();
    let contract_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let keystore = Address::generate(env);
    let asp_registry = Address::generate(env);
    client.initialize(&admin, &keystore, &asp_registry, &30, &MAX_STATE_TREE_SIZE);

    let pauser = Address::generate(env);
    let unpauser = Address::generate(env);
    let asset_manager = Address::generate(env);
    let upgrader = Address::generate(env);
    client.set_roles(&admin, &pauser, &unpauser, &asset_manager, &upgrader);

    (client, admin, pauser, unpauser, asset_manager)
}

fn setup_asset(env: &Env, client: &PoolContractClient, asset_manager: &Address, asset: &Address) {
    client.set_asset_config(asset_manager, asset, &true, &1000, &100, &0); // 1% fee, min 1000
}

/// Setup pool with real keystore and ASP registry contracts registered.
/// Returns (pool_client, admin, pauser, unpauser, asset_manager, keystore_client, asp_client).
fn setup_with_contracts(
    env: &Env,
) -> (
    PoolContractClient,
    Address,
    Address,
    Address,
    Address,
    keystore::KeystoreContractClient,
    asp_registry::AspRegistryContractClient,
    Address,
) {
    env.mock_all_auths();

    // Register keystore
    let ks_admin = Address::generate(env);
    let ks_id = env.register(keystore::KeystoreContract, ());
    let ks_client = keystore::KeystoreContractClient::new(env, &ks_id);
    ks_client.initialize(&ks_admin, &3600u64, &262_144u32);

    // Register ASP registry
    let asp_admin = Address::generate(env);
    let asp_postman = Address::generate(env);
    let asp_id = env.register(asp_registry::AspRegistryContract, ());
    let asp_client = asp_registry::AspRegistryContractClient::new(env, &asp_id);
    asp_client.initialize(&asp_admin, &asp_postman);

    // Register pool with real contract addresses
    let pool_id = env.register(PoolContract, ());
    let pool_client = PoolContractClient::new(env, &pool_id);
    let admin = Address::generate(env);
    pool_client.initialize(&admin, &ks_id, &asp_id, &30, &MAX_STATE_TREE_SIZE);

    let pauser = Address::generate(env);
    let unpauser = Address::generate(env);
    let asset_manager = Address::generate(env);
    let upgrader = Address::generate(env);
    pool_client.set_roles(&admin, &pauser, &unpauser, &asset_manager, &upgrader);

    (
        pool_client,
        admin,
        pauser,
        unpauser,
        asset_manager,
        ks_client,
        asp_client,
        asp_postman,
    )
}

/// Setup pool with real keystore and ASP registry contracts and custom root history size.
fn setup_with_contracts_custom_history(
    env: &Env,
    root_history_size: u32,
) -> (
    PoolContractClient,
    Address,
    Address,
    Address,
    Address,
    keystore::KeystoreContractClient,
    asp_registry::AspRegistryContractClient,
    Address,
) {
    env.mock_all_auths();

    // Register keystore
    let ks_admin = Address::generate(env);
    let ks_id = env.register(keystore::KeystoreContract, ());
    let ks_client = keystore::KeystoreContractClient::new(env, &ks_id);
    ks_client.initialize(&ks_admin, &3600u64, &262_144u32);

    // Register ASP registry
    let asp_admin = Address::generate(env);
    let asp_postman = Address::generate(env);
    let asp_id = env.register(asp_registry::AspRegistryContract, ());
    let asp_client = asp_registry::AspRegistryContractClient::new(env, &asp_id);
    asp_client.initialize(&asp_admin, &asp_postman);

    // Register pool with custom root history size
    let pool_id = env.register(PoolContract, ());
    let pool_client = PoolContractClient::new(env, &pool_id);
    let admin = Address::generate(env);
    pool_client.initialize(&admin, &ks_id, &asp_id, &root_history_size, &MAX_STATE_TREE_SIZE);

    let pauser = Address::generate(env);
    let unpauser = Address::generate(env);
    let asset_manager = Address::generate(env);
    let upgrader = Address::generate(env);
    pool_client.set_roles(&admin, &pauser, &unpauser, &asset_manager, &upgrader);

    (
        pool_client,
        admin,
        pauser,
        unpauser,
        asset_manager,
        ks_client,
        asp_client,
        asp_postman,
    )
}

fn dummy_proof(env: &Env) -> Groth16Proof {
    Groth16Proof {
        a: soroban_sdk::BytesN::from_array(env, &[0u8; 64]),
        b: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
        c: soroban_sdk::BytesN::from_array(env, &[0u8; 64]),
    }
}

fn dummy_vk(env: &Env, num_signals: u32) -> VerificationKeyBytes {
    let mut ic = soroban_sdk::Vec::new(env);
    for _ in 0..=num_signals {
        ic.push_back(soroban_sdk::BytesN::from_array(env, &[0u8; 64]));
    }
    VerificationKeyBytes {
        alpha: soroban_sdk::BytesN::from_array(env, &[0u8; 64]),
        beta: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
        gamma: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
        delta: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
        ic,
    }
}

// ── Initialization ──

#[test]
fn test_initialize() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
    assert_eq!(client.tree_size(), 0);
}

#[test]
fn test_initialize_rejects_double_init() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
    let admin = Address::generate(&env);
    let ks = Address::generate(&env);
    let asp = Address::generate(&env);
    let r = client.try_initialize(&admin, &ks, &asp, &30, &MAX_STATE_TREE_SIZE);
    assert!(
        matches!(r, Err(Ok(Error::AlreadyInitialized))),
        "expected Error::AlreadyInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_initialize_rejects_zero_root_history_size() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let ks = Address::generate(&env);
    let asp = Address::generate(&env);
    let r = client.try_initialize(&admin, &ks, &asp, &0, &MAX_STATE_TREE_SIZE);
    assert!(
        matches!(r, Err(Ok(Error::InvalidRootHistorySize))),
        "expected Error::InvalidRootHistorySize from this call specifically, got {:?}",
        r
    );
}

// ── set_roles ──

#[test]
fn test_set_roles() {
    let env = Env::default();
    let (client, admin, _, _, _) = setup(&env);
    let p = Address::generate(&env);
    let u = Address::generate(&env);
    let am = Address::generate(&env);
    let up = Address::generate(&env);
    client.set_roles(&admin, &p, &u, &am, &up);
}

#[test]
fn test_set_roles_rejects_non_admin() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
    let non_admin = Address::generate(&env);
    let p = Address::generate(&env);
    let u = Address::generate(&env);
    let am = Address::generate(&env);
    let up = Address::generate(&env);
    let r = client.try_set_roles(&non_admin, &p, &u, &am, &up);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

// ── set_asset_config ──

#[test]
fn test_set_asset_config() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    client.set_asset_config(&asset_manager, &asset, &true, &1000, &100, &0);

    let config = client.get_asset_config(&asset);
    assert!(config.enabled);
    assert_eq!(config.min_deposit_amount, 1000);
    assert_eq!(config.vetting_fee_bps, 100);
    assert_eq!(config.accumulated_fees, 0);
}

#[test]
fn test_set_asset_config_admin_can_also_set() {
    let env = Env::default();
    let (client, admin, _, _, _) = setup(&env);
    let asset = Address::generate(&env);
    client.set_asset_config(&admin, &asset, &true, &500, &50, &0);

    let config = client.get_asset_config(&asset);
    assert!(config.enabled);
}

#[test]
fn test_set_asset_config_rejects_unauthorized() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
    let rando = Address::generate(&env);
    let asset = Address::generate(&env);
    let r = client.try_set_asset_config(&rando, &asset, &true, &1000, &100, &0);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_asset_config_preserves_accumulated_fees() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    client.set_asset_config(&asset_manager, &asset, &true, &1000, &100, &0);

    // Simulate fee accumulation by updating config (fees stay)
    // Re-configure asset, fees should be preserved
    client.set_asset_config(&asset_manager, &asset, &true, &2000, &200, &0);
    let config = client.get_asset_config(&asset);
    assert_eq!(config.min_deposit_amount, 2000);
    assert_eq!(config.vetting_fee_bps, 200);
    assert_eq!(config.accumulated_fees, 0); // No deposits yet, so 0
}

#[test]
fn test_set_asset_config_rejects_token_id_collision() {
    // Two distinct assets sharing a 160-bit tokenId (cffcaca9 INS-1 truncation)
    // must not both register. A real keccak collision is infeasible to
    // construct, so we seed the reverse index (TokenIdAsset -> a *different*
    // asset) and assert the guard rejects the second registration with
    // TokenIdCollision (#30).
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);
    let tid_b = encode_token_id(&env, &asset_b);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::TokenIdAsset(tid_b), &asset_a);
    });
    // tid_b is now owned by asset_a; registering asset_b trips the guard.
    let r = client.try_set_asset_config(&asset_manager, &asset_b, &true, &1000, &100, &0);
    assert!(
        matches!(r, Err(Ok(Error::TokenIdCollision))),
        "expected Error::TokenIdCollision from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_asset_config_rejects_fee_bps_too_high() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    // 10000 bps = 100%, should be rejected
    let r = client.try_set_asset_config(&asset_manager, &asset, &true, &1000, &10_000, &0);
    assert!(
        matches!(r, Err(Ok(Error::InvalidFeeBps))),
        "expected Error::InvalidFeeBps from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_asset_config_accepts_max_valid_fee_bps() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    // 9999 bps = 99.99%, should be accepted
    client.set_asset_config(&asset_manager, &asset, &true, &1000, &9_999, &0);
    let config = client.get_asset_config(&asset);
    assert_eq!(config.vetting_fee_bps, 9_999);
}

#[test]
fn test_set_asset_config_rejects_enabled_with_zero_min() {
    // M-02: an enabled asset must have min_deposit_amount > 0.
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    let r = client.try_set_asset_config(&asset_manager, &asset, &true, &0, &100, &0);
    assert!(
        matches!(r, Err(Ok(Error::InvalidMinAmount))),
        "expected Error::InvalidMinAmount from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_asset_config_allows_disabled_with_zero_min() {
    // A disabled asset may keep min_deposit_amount == 0.
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    client.set_asset_config(&asset_manager, &asset, &false, &0, &100, &0);
    let config = client.get_asset_config(&asset);
    assert!(!config.enabled);
    assert_eq!(config.min_deposit_amount, 0);
}

// ── max state tree size (M-1 configurable cap) ──

/// Minimal pool (no real keystore/asp needed for deposit) with a known upgrader
/// and a chosen state-tree cap.
fn setup_capped_pool(
    env: &Env,
    cap: u32,
) -> (PoolContractClient, Address, Address, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let ks = Address::generate(env);
    let asp = Address::generate(env);
    let pool_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(env, &pool_id);
    client.initialize(&admin, &ks, &asp, &30, &cap);
    let pauser = Address::generate(env);
    let unpauser = Address::generate(env);
    let asset_manager = Address::generate(env);
    let upgrader = Address::generate(env);
    client.set_roles(&admin, &pauser, &unpauser, &asset_manager, &upgrader);
    (client, admin, asset_manager, upgrader)
}

/// The over-cap deposit is rejected, attributed to the deposit that actually exceeds the cap.
///
/// This was a `#[should_panic(expected = "#33")]` test, and it could not do what its name claimed.
/// Its FIRST deposit fills the tree to exactly the cap. Degrade the guard from `>` to `>=` and that
/// first deposit raises the very same #33, `should_panic` is satisfied, the test passes — and its
/// `assert_eq!(tree_size, 1)` never runs. A should_panic test proves only that SOMETHING raised the
/// code, never which call did, and here the two calls are the two sides of the boundary.
///
/// Now the at-cap deposit must SUCCEED (asserted, with the tree size checked) and only the
/// over-cap deposit is matched against the error. `test_deposit_filling_tree_to_exactly_cap_is_accepted`
/// covers the same boundary from the other direction.
#[test]
fn test_state_tree_cap_enforced_on_deposit() {
    let env = Env::default();
    let (client, admin, asset_manager, _upgrader) = setup_capped_pool(&env, 1); // cap = 1
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Fills the tree to exactly the cap. This MUST succeed — it is the boundary case, and the whole
    // reason the old test could pass at the wrong line.
    do_deposit(&env, &client, &depositor, &asset, 10_000, 42);
    assert_eq!(client.tree_size(), 1, "the at-cap deposit must be accepted");

    // Only this one exceeds the cap.
    let r = client.try_deposit(
        &depositor,
        &asset,
        &10_000u128,
        &U256::from_u32(&env, 43),
        &dummy_proof(&env),
        &empty_note(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::StateTreeFull))),
        "expected Error::StateTreeFull from the OVER-cap deposit specifically, got {:?}",
        r
    );
    assert_eq!(client.tree_size(), 1, "a rejected deposit must not grow the tree");
}

#[test]
fn test_set_max_state_tree_size_happy() {
    let env = Env::default();
    let (client, _admin, _am, upgrader) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);
    assert_eq!(client.max_state_tree_size(), MAX_STATE_TREE_SIZE);
    client.set_max_state_tree_size(&upgrader, &(MAX_STATE_TREE_SIZE * 2));
    assert_eq!(client.max_state_tree_size(), MAX_STATE_TREE_SIZE * 2);
}

#[test]
fn test_set_max_state_tree_size_rejects_non_upgrader() {
    let env = Env::default();
    let (client, _admin, _am, _upgrader) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);
    let rando = Address::generate(&env);
    let r = client.try_set_max_state_tree_size(&rando, &(MAX_STATE_TREE_SIZE * 2));
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_max_state_tree_size_rejects_not_above_current_size() {
    // New cap must exceed the current tree size (here size 0, so 0 is invalid).
    let env = Env::default();
    let (client, _admin, _am, upgrader) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);
    let r = client.try_set_max_state_tree_size(&upgrader, &0);
    assert!(
        matches!(r, Err(Ok(Error::InvalidMaxTreeSize))),
        "expected Error::InvalidMaxTreeSize from this call specifically, got {:?}",
        r
    );
}

// ── pause / unpause ──

#[test]
fn test_pause_unpause() {
    let env = Env::default();
    let (client, _, pauser, unpauser, _) = setup(&env);
    client.pause(&pauser);
    client.unpause(&unpauser);
}

#[test]
fn test_pause_rejects_non_pauser() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
    let rando = Address::generate(&env);
    let r = client.try_pause(&rando);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_unpause_rejects_non_unpauser() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
    let rando = Address::generate(&env);
    let r = client.try_unpause(&rando);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

// ── set_vk ──

#[test]
fn test_set_vk() {
    let env = Env::default();
    let (client, admin, _, _, _) = setup(&env);

    // Create a dummy VK
    let vk = VerificationKeyBytes {
        alpha: soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        beta: soroban_sdk::BytesN::from_array(&env, &[0u8; 128]),
        gamma: soroban_sdk::BytesN::from_array(&env, &[0u8; 128]),
        delta: soroban_sdk::BytesN::from_array(&env, &[0u8; 128]),
        ic: soroban_sdk::vec![
            &env,
            soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
            soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        ],
    };

    client.set_vk(&admin, &0, &0, &0, &vk);
}

#[test]
fn test_set_vk_emits_event() {
    let env = Env::default();
    let (client, admin, _, _, _) = setup(&env);

    let vk = VerificationKeyBytes {
        alpha: soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        beta: soroban_sdk::BytesN::from_array(&env, &[0u8; 128]),
        gamma: soroban_sdk::BytesN::from_array(&env, &[0u8; 128]),
        delta: soroban_sdk::BytesN::from_array(&env, &[0u8; 128]),
        ic: soroban_sdk::vec![
            &env,
            soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
            soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        ],
    };

    client.set_vk(&admin, &1, &2, &3, &vk);

    let expected = VkUpdated {
        proof_type: 1,
        n: 2,
        m: 3,
    };
    let events = env.events().all();
    let contract_id = client.address.clone();
    assert!(
        events.events().contains(&expected.to_xdr(&env, &contract_id)),
        "VkUpdated event not found"
    );
}

#[test]
fn test_set_vk_rejects_non_admin() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
    let rando = Address::generate(&env);

    let vk = VerificationKeyBytes {
        alpha: soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        beta: soroban_sdk::BytesN::from_array(&env, &[0u8; 128]),
        gamma: soroban_sdk::BytesN::from_array(&env, &[0u8; 128]),
        delta: soroban_sdk::BytesN::from_array(&env, &[0u8; 128]),
        ic: soroban_sdk::vec![&env],
    };

    let r = client.try_set_vk(&rando, &0, &0, &0, &vk);

    assert!(

        matches!(r, Err(Ok(Error::NotAuthorized))),

        "expected Error::NotAuthorized from this call specifically, got {:?}",

        r

    );
}

// ── deposit validation (pre-proof) ──

#[test]
fn test_deposit_rejects_when_paused() {
    let env = Env::default();
    let (client, _, pauser, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    setup_asset(&env, &client, &asset_manager, &asset);

    client.pause(&pauser);

    let depositor = Address::generate(&env);
    let commitment = U256::from_u32(&env, 42);
    let proof = dummy_proof(&env);
    let r = client.try_deposit(&depositor, &asset, &5000, &commitment, &proof, &empty_note(&env));
    assert!(
        matches!(r, Err(Ok(Error::PoolPaused))),
        "expected Error::PoolPaused from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_deposit_rejects_zero_value() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    setup_asset(&env, &client, &asset_manager, &asset);

    let depositor = Address::generate(&env);
    let commitment = U256::from_u32(&env, 42);
    let proof = dummy_proof(&env);
    let r = client.try_deposit(&depositor, &asset, &0, &commitment, &proof, &empty_note(&env));
    assert!(
        matches!(r, Err(Ok(Error::InvalidValue))),
        "expected Error::InvalidValue from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_deposit_rejects_unconfigured_asset() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
    let asset = Address::generate(&env);

    let depositor = Address::generate(&env);
    let commitment = U256::from_u32(&env, 42);
    let proof = dummy_proof(&env);
    let r = client.try_deposit(&depositor, &asset, &5000, &commitment, &proof, &empty_note(&env));
    assert!(
        matches!(r, Err(Ok(Error::AssetNotEnabled))),
        "expected Error::AssetNotEnabled from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_deposit_rejects_disabled_asset() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    client.set_asset_config(&asset_manager, &asset, &false, &1000, &100, &0);

    let depositor = Address::generate(&env);
    let commitment = U256::from_u32(&env, 42);
    let proof = dummy_proof(&env);
    let r = client.try_deposit(&depositor, &asset, &5000, &commitment, &proof, &empty_note(&env));
    assert!(
        matches!(r, Err(Ok(Error::AssetNotEnabled))),
        "expected Error::AssetNotEnabled from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_deposit_rejects_below_minimum() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    setup_asset(&env, &client, &asset_manager, &asset); // min = 1000

    let depositor = Address::generate(&env);
    let commitment = U256::from_u32(&env, 42);
    let proof = dummy_proof(&env);
    let r = client.try_deposit(&depositor, &asset, &999, &commitment, &proof, &empty_note(&env));
    assert!(
        matches!(r, Err(Ok(Error::BelowMinDeposit))),
        "expected Error::BelowMinDeposit from this call specifically, got {:?}",
        r
    );
}

// ── is_known_root ──

#[test]
fn test_is_known_root_false_when_empty() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
    let unknown = U256::from_u32(&env, 9999);
    assert!(!client.is_known_root(&unknown));
}

#[test]
fn test_is_known_root_false_for_zero() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
    let zero = U256::from_u32(&env, 0);
    assert!(!client.is_known_root(&zero));
}

// ── withdraw_fees ──

#[test]
fn test_withdraw_fees_rejects_non_asset_manager() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    setup_asset(&env, &client, &asset_manager, &asset);

    let rando = Address::generate(&env);
    let recipient = Address::generate(&env);
    let r = client.try_withdraw_fees(&rando, &asset, &100, &recipient);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_withdraw_fees_rejects_insufficient() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    setup_asset(&env, &client, &asset_manager, &asset);

    let recipient = Address::generate(&env);
    // No deposits yet, so 0 fees accumulated
    let r = client.try_withdraw_fees(&asset_manager, &asset, &100, &recipient);
    assert!(
        matches!(r, Err(Ok(Error::InsufficientFees))),
        "expected Error::InsufficientFees from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_withdraw_fees_emits_event() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, _ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    // Set deposit VK and configure asset
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Deposit to accumulate fees (1% of 10000 = 100)
    do_deposit(&env, &client, &depositor, &asset, 10_000, 42);

    // Withdraw fees
    let recipient = Address::generate(&env);
    client.withdraw_fees(&asset_manager, &asset, &100, &recipient);

    let expected = FeesWithdrawn {
        asset: asset.clone(),
        amount: 100,
        recipient: recipient.clone(),
    };
    let events = env.events().all();
    let contract_id = client.address.clone();
    assert!(
        events.events().contains(&expected.to_xdr(&env, &contract_id)),
        "FeesWithdrawn event not found"
    );
}

// ── transact validation (pre-proof) ──

#[test]
fn test_transact_rejects_when_paused() {
    let env = Env::default();
    let (client, _, pauser, _, _, _, _, _) = setup_with_contracts(&env);
    client.pause(&pauser);

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 2)];

    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );

    assert!(

        matches!(r, Err(Ok(Error::PoolPaused))),

        "expected Error::PoolPaused from this call specifically, got {:?}",

        r

    );
}

#[test]
fn test_transact_rejects_n_zero() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers: Vec<U256> = soroban_sdk::vec![&env];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 2)];

    let r = client.try_transact(
        &processor,
        &true,
        &0, // n=0 invalid
        &1,
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );

    assert!(

        matches!(r, Err(Ok(Error::InvalidNxM))),

        "expected Error::InvalidNxM from this call specifically, got {:?}",

        r

    );
}

#[test]
fn test_transact_rejects_n_too_large() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers: Vec<U256> = soroban_sdk::vec![&env];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 2)];
    let r = client.try_transact(
        &processor,
        &true,
        &6, // n=6 invalid
        &1,
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::InvalidNxM))),
        "expected Error::InvalidNxM from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_transact_rejects_m_zero() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    let commitments: Vec<U256> = soroban_sdk::vec![&env];
    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &0, // m=0 invalid
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::InvalidNxM))),
        "expected Error::InvalidNxM from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_transact_rejects_vec_length_mismatch() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    // n=2 but only 1 nullifier provided
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 2)];
    let r = client.try_transact(
        &processor,
        &true,
        &2, // n=2 but vec has 1
        &1,
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::InvalidNxM))),
        "expected Error::InvalidNxM from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_transact_rejects_unknown_state_root() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 2)];


    // Use non-zero state root — no roots exist yet, so this must fail
    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &U256::from_u32(&env, 42), // unknown state root
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::UnknownRoot))),
        "expected Error::UnknownRoot from this call specifically, got {:?}",
        r
    );
}

// NOTE: test_transact_rejects_unknown_keystore_root placeholder removed.
// Replaced by test_transact_rejects_unknown_keystore_root_real which uses
// env.as_contract to inject a fake state root, bypassing the ordering issue.

// ── transact: permissionless mode ──

#[test]
fn test_transact_permissionless_happy_path() {
    let env = Env::default();
    let (client, admin, _, _, _, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    let vk = dummy_vk(&env, 8); // 1x1: N+M+6 = 8
    client.set_vk(&admin, &1, &1, &1, &vk);

    let processor = Address::generate(&env);

    // Inject a state root
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    // Register user in keystore and submit ASP root
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();
    let asp_root = U256::from_u32(&env, 333);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    // Permissionless mode: processor_gated=false, no require_auth
    // Will fail at proof verification (mock VK), but should NOT fail at auth
    let result = client.try_transact(
        &processor,
        &false,
        &1,
        &1,
        &dummy_proof(&env),
        &fake_root,
        &ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &soroban_sdk::vec![&env, U256::from_u32(&env, 2)],
        &Address::generate(&env),
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    // Should fail at proof verification (#4), not auth
    match result {
        Err(Ok(Error::NotAuthorized)) => panic!("should not require auth in permissionless mode"),
        Err(Ok(Error::InvalidProof)) => {} // Expected
        _ => {} // Any other result is also fine
    }
}

#[test]
fn test_transact_rejects_permissionless_withdrawal() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    let vk = dummy_vk(&env, 8); // 1x1
    client.set_vk(&admin, &1, &1, &1, &vk);

    // Setup real token for withdrawal
    let asset_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(asset_admin.clone());
    let asset = sac.address();
    client.set_asset_config(&asset_manager, &asset, &true, &1000, &100, &0);

    let processor = Address::generate(&env);

    // Inject state root
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();
    let asp_root = U256::from_u32(&env, 333);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let token_id = soroban_v2_utils::encode_token_id(&env, &asset);

    // Permissionless mode with a withdrawal: the processor is unbound by the proof and is paid
    // the withdrawal, so this must be refused before anything else (EVM da346809 L-1).
    let result = client.try_transact(
        &processor,
        &false,
        &1,
        &1,
        &dummy_proof(&env),
        &fake_root,
        &ks_root,
        &asp_root,
        &100u128, // amount_out > 0
        &token_id,
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &soroban_sdk::vec![&env, U256::from_u32(&env, 2)],
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(result, Err(Ok(Error::UngatedWithdrawal))),
        "an ungated withdrawal must be refused, got {:?}",
        result
    );
}

// ── ragequit validation (pre-proof) ──

#[test]
fn test_ragequit_rejects_commitment_not_found() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    let owner = Address::generate(&env);
    let commitment = U256::from_u32(&env, 999);
    let nullifier = U256::from_u32(&env, 888);
    let keystore_root = U256::from_u32(&env, 0);
    let token_id = U256::from_u32(&env, 0);
    let label = U256::from_u32(&env, 0);
    let asset = Address::generate(&env);

    let r = client.try_ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier,
        &commitment, // not in storage
        &keystore_root,
        &5000u128,
        &token_id,
        &label,
        &asset,
    );

    assert!(

        matches!(r, Err(Ok(Error::CommitmentNotFound))),

        "expected Error::CommitmentNotFound from this call specifically, got {:?}",

        r

    );
}

#[test]
fn test_ragequit_rejects_zero_value() {
    // L-01: ragequit with value == 0 is rejected before any other validation.
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    let owner = Address::generate(&env);
    let commitment = U256::from_u32(&env, 999);
    let nullifier = U256::from_u32(&env, 888);
    let keystore_root = U256::from_u32(&env, 0);
    let token_id = U256::from_u32(&env, 0);
    let label = U256::from_u32(&env, 0);
    let asset = Address::generate(&env);

    let r = client.try_ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier,
        &commitment,
        &keystore_root,
        &0u128, // zero value
        &token_id,
        &label,
        &asset,
    );

    assert!(

        matches!(r, Err(Ok(Error::ZeroValueRagequit))),

        "expected Error::ZeroValueRagequit from this call specifically, got {:?}",

        r

    );
}

#[test]
fn test_ragequit_works_when_paused() {
    // Ragequit should not check pause status.
    // We can only verify it doesn't fail with Error(Contract, #8).
    // It will fail with CommitmentNotFound (#21) which is the expected
    // first validation after the (absent) pause check.
    let env = Env::default();
    let (client, _, pauser, _, _, _, _, _) = setup_with_contracts(&env);

    client.pause(&pauser);

    let owner = Address::generate(&env);
    let commitment = U256::from_u32(&env, 999);
    let nullifier = U256::from_u32(&env, 888);
    let keystore_root = U256::from_u32(&env, 0);
    let token_id = U256::from_u32(&env, 0);
    let label = U256::from_u32(&env, 0);
    let asset = Address::generate(&env);

    // Should fail with CommitmentNotFound (#21), NOT PoolPaused (#8)
    let result = client.try_ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier,
        &commitment,
        &keystore_root,
        &5000u128,
        &token_id,
        &label,
        &asset,
    );
    // Verify it's not a PoolPaused error
    assert!(result.is_err());
    // The error should be CommitmentNotFound (#21), not PoolPaused (#8)
}

// ── compute_transact_context ──

#[test]
fn test_compute_transact_context_deterministic() {
    let env = Env::default();
    let processor = Address::generate(&env);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![
        &env,
        NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[1, 2, 3]) },
        NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[4, 5, 6]) },
    ];

    let empty_data = Bytes::new(&env);
    let ctx1 = compute_transact_context(&env, &processor, &empty_data, &note_data_vec, true);
    let ctx2 = compute_transact_context(&env, &processor, &empty_data, &note_data_vec, true);
    assert_eq!(ctx1, ctx2);
}

#[test]
fn test_compute_transact_context_different_processor() {
    let env = Env::default();
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[1, 2, 3]) }];

    let empty_data = Bytes::new(&env);
    let ctx1 = compute_transact_context(&env, &p1, &empty_data, &note_data_vec, true);
    let ctx2 = compute_transact_context(&env, &p2, &empty_data, &note_data_vec, true);
    assert_ne!(ctx1, ctx2);
}

#[test]
fn test_compute_transact_context_different_note_data() {
    let env = Env::default();
    let processor = Address::generate(&env);
    let note_data1: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[1, 2, 3]) }];
    let note_data2: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[4, 5, 6]) }];

    let empty_data = Bytes::new(&env);
    let ctx1 = compute_transact_context(&env, &processor, &empty_data, &note_data1, true);
    let ctx2 = compute_transact_context(&env, &processor, &empty_data, &note_data2, true);
    assert_ne!(ctx1, ctx2);
}

#[test]
fn test_compute_transact_context_empty_note_data() {
    let env = Env::default();
    let processor = Address::generate(&env);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env];

    // Should not panic on empty note_data
    let empty_data = Bytes::new(&env);
    let _ctx = compute_transact_context(&env, &processor, &empty_data, &note_data_vec, true).unwrap();
}

#[test]
fn test_compute_transact_context_within_field() {
    use contract_types::SNARK_SCALAR_FIELD_BYTES;

    let env = Env::default();
    let processor = Address::generate(&env);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[42u8; 100]) }];

    let empty_data = Bytes::new(&env);
    let ctx = compute_transact_context(&env, &processor, &empty_data, &note_data_vec, true).unwrap();
    let field = U256::from_be_bytes(
        &env,
        &soroban_sdk::Bytes::from_slice(&env, &SNARK_SCALAR_FIELD_BYTES),
    );
    // ctx should be less than the SNARK scalar field
    assert!(ctx < field);
}

// ── compute_transact_context: permissionless vs gated ──

#[test]
fn test_compute_transact_context_permissionless_vs_gated_differ() {
    let env = Env::default();
    let processor = Address::generate(&env);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![
        &env,
        NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[1, 2, 3]) },
    ];

    let empty_data = Bytes::new(&env);
    let ctx_gated = compute_transact_context(&env, &processor, &empty_data, &note_data_vec, true).unwrap();
    let ctx_permissionless = compute_transact_context(&env, &processor, &empty_data, &note_data_vec, false).unwrap();

    // Same processor + note_data, different gating → different contexts
    assert_ne!(ctx_gated, ctx_permissionless);
}

#[test]
fn test_compute_transact_context_permissionless_deterministic() {
    let env = Env::default();
    let processor = Address::generate(&env);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![
        &env,
        NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[1, 2, 3]) },
    ];

    let empty_data = Bytes::new(&env);
    let ctx1 = compute_transact_context(&env, &processor, &empty_data, &note_data_vec, false).unwrap();
    let ctx2 = compute_transact_context(&env, &processor, &empty_data, &note_data_vec, false).unwrap();

    // Same inputs → same output
    assert_eq!(ctx1, ctx2);
}

#[test]
fn test_compute_transact_context_permissionless_same_for_different_processors() {
    let env = Env::default();
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![
        &env,
        NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[1, 2, 3]) },
    ];

    let empty_data = Bytes::new(&env);
    let ctx1 = compute_transact_context(&env, &p1, &empty_data, &note_data_vec, false).unwrap();
    let ctx2 = compute_transact_context(&env, &p2, &empty_data, &note_data_vec, false).unwrap();

    // Permissionless mode uses zeros for processor → same context regardless of processor
    assert_eq!(ctx1, ctx2);
}

// ── compute_transact_context: processor_data ──

#[test]
fn test_compute_transact_context_different_processor_data() {
    let env = Env::default();
    let processor = Address::generate(&env);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[1, 2, 3]) }];

    let data1 = Bytes::from_slice(&env, &[10, 20, 30]);
    let data2 = Bytes::from_slice(&env, &[40, 50, 60]);

    let ctx1 = compute_transact_context(&env, &processor, &data1, &note_data_vec, true).unwrap();
    let ctx2 = compute_transact_context(&env, &processor, &data2, &note_data_vec, true).unwrap();

    // Different processor data → different contexts
    assert_ne!(ctx1, ctx2);
}

#[test]
fn test_compute_transact_context_empty_vs_nonempty_processor_data() {
    let env = Env::default();
    let processor = Address::generate(&env);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[1, 2, 3]) }];

    let empty_data = Bytes::new(&env);
    let some_data = Bytes::from_slice(&env, &[42, 43, 44]);

    let ctx_empty = compute_transact_context(&env, &processor, &empty_data, &note_data_vec, true).unwrap();
    let ctx_some = compute_transact_context(&env, &processor, &some_data, &note_data_vec, true).unwrap();

    // Empty vs non-empty processor data → different contexts
    assert_ne!(ctx_empty, ctx_some);
}

#[test]
fn test_compute_transact_context_processor_data_deterministic() {
    let env = Env::default();
    let processor = Address::generate(&env);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, &[1, 2, 3]) }];
    let data = Bytes::from_slice(&env, &[10, 20, 30]);

    let ctx1 = compute_transact_context(&env, &processor, &data, &note_data_vec, true).unwrap();
    let ctx2 = compute_transact_context(&env, &processor, &data, &note_data_vec, true).unwrap();

    assert_eq!(ctx1, ctx2);
}

// ── Cross-contract client registration ──

#[test]
fn test_setup_with_contracts() {
    let env = Env::default();
    let (client, _, _, _, _, ks_client, asp_client, _) = setup_with_contracts(&env);

    // Pool is initialized
    assert_eq!(client.tree_size(), 0);

    // Keystore is initialized
    assert_eq!(ks_client.tree_size(), 0);

    // ASP registry is initialized
    assert_eq!(asp_client.root_count(), 0);
}

// ── transact VK not found ──

#[test]
fn test_transact_unknown_root_with_real_contracts() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 100)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 200)];


    // No deposits have been made, so no state roots exist
    // Any non-zero root should be rejected as unknown
    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &U256::from_u32(&env, 12345), // unknown root
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::UnknownRoot))),
        "expected Error::UnknownRoot from this call specifically, got {:?}",
        r
    );
}

// ── deposit: DuplicateCommitment ──

#[test]
fn test_deposit_rejects_duplicate_commitment() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Set a deposit VK (4 signals)
    let vk = dummy_vk(&env, 4);
    client.set_vk(&admin, &0, &0, &0, &vk);

    // Write a commitment directly to storage to simulate prior deposit
    let commitment = U256::from_u32(&env, 42);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(commitment.clone()), &true);
    });

    let depositor = Address::generate(&env);
    let proof = dummy_proof(&env);
    // Deposit will pass proof verification (dummy VK/proof both zero),
    // but should fail on duplicate commitment check
    let r = client.try_deposit(&depositor, &asset, &5000, &commitment, &proof, &empty_note(&env));
    assert!(
        matches!(r, Err(Ok(Error::DuplicateCommitment))),
        "expected Error::DuplicateCommitment from this call specifically, got {:?}",
        r
    );
}

// ── transact: DuplicateNullifier within same tx ──

#[test]
fn test_transact_rejects_duplicate_nullifier_in_tx() {
    let env = Env::default();
    let (client, admin, _, _, _, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set a transact VK for 2x1 (n=2, m=1 → 2+1+6 = 9 signals)
    let vk = dummy_vk(&env, 9);
    client.set_vk(&admin, &1, &2, &1, &vk);

    // Inject a state root at Root(0)
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    // Register a user in keystore to get a valid keystore root
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Submit an ASP root
    let asp_root = U256::from_u32(&env, 333);
    let cid = Bytes::from_slice(&env, b"QmTest");
    asp_client.update_asp_root(&asp_postman, &asp_root, &cid);

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let dup_null = U256::from_u32(&env, 42);
    let nullifiers = soroban_sdk::vec![&env, dup_null.clone(), dup_null.clone()];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    let r = client.try_transact(
        &processor,
        &true,
        &2,
        &1,
        &dummy_proof(&env),
        &fake_root,
        &ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::DuplicateNullifier))),
        "expected Error::DuplicateNullifier from this call specifically, got {:?}",
        r
    );
}

// ── transact: NullifierAlreadySpent ──

#[test]
fn test_transact_rejects_already_spent_nullifier() {
    let env = Env::default();
    let (client, admin, _, _, _, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set a transact VK for 1x1 (n=1, m=1 → 1+1+6 = 8 signals)
    let vk = dummy_vk(&env, 8);
    client.set_vk(&admin, &1, &1, &1, &vk);

    // Inject a state root at Root(0)
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    // Register a user in keystore to get a valid keystore root
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Submit an ASP root
    let asp_root = U256::from_u32(&env, 333);
    let cid = Bytes::from_slice(&env, b"QmTest");
    asp_client.update_asp_root(&asp_postman, &asp_root, &cid);

    // Write a spent nullifier directly
    let spent_null = U256::from_u32(&env, 777);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Nullifier(spent_null.clone()), &true);
    });

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, spent_null];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &fake_root,
        &ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::NullifierAlreadySpent))),
        "expected Error::NullifierAlreadySpent from this call specifically, got {:?}",
        r
    );
}

// ── transact: InvalidAspRoot ──

#[test]
fn test_transact_rejects_invalid_asp_root() {
    let env = Env::default();
    let (client, admin, _, _, _, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set a transact VK for 1x1
    let vk = dummy_vk(&env, 8);
    client.set_vk(&admin, &1, &1, &1, &vk);

    // Inject a state root
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    // Register a user in keystore
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Submit an ASP root
    let real_asp_root = U256::from_u32(&env, 333);
    let cid = Bytes::from_slice(&env, b"QmTest");
    asp_client.update_asp_root(&asp_postman, &real_asp_root, &cid);

    // Use a WRONG ASP root — should fail with InvalidAspRoot (#16)
    let wrong_asp_root = U256::from_u32(&env, 444);

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 2)];
    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &fake_root,
        &ks_root,
        &wrong_asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::InvalidAspRoot))),
        "expected Error::InvalidAspRoot from this call specifically, got {:?}",
        r
    );
}

// ── ragequit: NullifierAlreadySpent ──

#[test]
fn test_ragequit_rejects_already_spent_nullifier() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    // Inject a commitment so CommitmentNotFound check passes
    let commitment = U256::from_u32(&env, 100);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(commitment.clone()), &true);
    });

    // Inject a spent nullifier
    let nullifier = U256::from_u32(&env, 200);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Nullifier(nullifier.clone()), &true);
    });

    let owner = Address::generate(&env);
    let r = client.try_ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier,
        &commitment,
        &U256::from_u32(&env, 0),
        &1000u128,
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &Address::generate(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::NullifierAlreadySpent))),
        "expected Error::NullifierAlreadySpent from this call specifically, got {:?}",
        r
    );
}

// ── ragequit: UnknownKeystoreRoot ──

#[test]
fn test_ragequit_rejects_unknown_keystore_root() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    // Inject a commitment
    let commitment = U256::from_u32(&env, 100);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(commitment.clone()), &true);
    });

    let owner = Address::generate(&env);
    let unknown_ks_root = U256::from_u32(&env, 999);

    // No user registered in keystore, so unknown_ks_root won't be found
    let r = client.try_ragequit(
        &owner,
        &dummy_proof(&env),
        &U256::from_u32(&env, 1),
        &commitment,
        &unknown_ks_root,
        &1000u128,
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &Address::generate(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::UnknownKeystoreRoot))),
        "expected Error::UnknownKeystoreRoot from this call specifically, got {:?}",
        r
    );
}

// ── transact: InvalidTokenId (post-proof, amount_out > 0) ──

#[test]
fn test_transact_rejects_invalid_token_id() {
    let env = Env::default();
    let (client, admin, _, _, _, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set a transact VK for 1x1
    let vk = dummy_vk(&env, 8);
    client.set_vk(&admin, &1, &1, &1, &vk);

    // Inject a state root
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    // Register a user in keystore
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Submit ASP root
    let asp_root = U256::from_u32(&env, 333);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let wrong_token_id = U256::from_u32(&env, 12345); // Won't match keccak(asset)

    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &fake_root,
        &ks_root,
        &asp_root,
        &100u128, // amount_out > 0 triggers token_id check
        &wrong_token_id,
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &soroban_sdk::vec![&env, U256::from_u32(&env, 2)],
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );

    assert!(

        matches!(r, Err(Ok(Error::InvalidTokenId))),

        "expected Error::InvalidTokenId from this call specifically, got {:?}",

        r

    );
}

// ── transact: withdrawal succeeds with disabled asset ──

#[test]
fn test_transact_withdrawal_succeeds_with_disabled_asset() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set a transact VK for 1x1
    let vk = dummy_vk(&env, 8);
    client.set_vk(&admin, &1, &1, &1, &vk);

    // Configure asset as ENABLED first so we can deposit
    let asset_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(asset_admin.clone());
    let asset = sac.address();
    client.set_asset_config(&asset_manager, &asset, &true, &1000, &100, &0);

    // Mint tokens to pool for withdrawal
    let sac_admin = StellarAssetClient::new(&env, &asset);
    sac_admin.mint(&client.address, &10_000);

    // Inject a state root
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    // Register a user in keystore
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Submit ASP root
    let asp_root = U256::from_u32(&env, 333);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    // Now DISABLE the asset
    client.set_asset_config(&asset_manager, &asset, &false, &1000, &100, &0);

    // Compute the correct token_id for this asset
    let token_id = soroban_v2_utils::encode_token_id(&env, &asset);
    let processor = Address::generate(&env);

    // This should NOT panic — withdrawals must succeed even with disabled asset.
    // It will fail at proof verification (mock VK), but that's after the
    // asset-enabled check was previously located. The point is it doesn't
    // fail with AssetNotEnabled (#10).
    let result = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &fake_root,
        &ks_root,
        &asp_root,
        &100u128, // amount_out > 0
        &token_id,
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &soroban_sdk::vec![&env, U256::from_u32(&env, 2)],
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    // Should fail at proof verification (#4), NOT asset-not-enabled (#10)
    match result {
        Err(Ok(Error::AssetNotEnabled)) => panic!("should not reject for disabled asset on withdrawal"),
        _ => {} // Any other error (like InvalidProof) is expected
    }
}

// ── ragequit: InvalidTokenId (post-proof, value > 0) ──

#[test]
fn test_ragequit_rejects_invalid_token_id() {
    let env = Env::default();
    let (client, admin, _, _, _, ks_client, _, _) = setup_with_contracts(&env);

    // Set a ragequit VK (proof_type=2, 7 signals)
    let vk = dummy_vk(&env, 7);
    client.set_vk(&admin, &2, &0, &0, &vk);

    // Inject a commitment
    let commitment = U256::from_u32(&env, 100);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(commitment.clone()), &true);
    });

    // Register user in keystore for a valid root
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    let owner = Address::generate(&env);
    let wrong_token_id = U256::from_u32(&env, 12345); // Won't match keccak(asset)
    let asset = Address::generate(&env);

    let r = client.try_ragequit(
        &owner,
        &dummy_proof(&env),
        &U256::from_u32(&env, 1), // nullifier_hash
        &commitment,
        &ks_root,
        &1000u128,        // value > 0 triggers token_id check
        &wrong_token_id,  // mismatched token_id
        &U256::from_u32(&env, 0), // label
        &asset,
    );

    assert!(

        matches!(r, Err(Ok(Error::InvalidTokenId))),

        "expected Error::InvalidTokenId from this call specifically, got {:?}",

        r

    );
}

// ── Pool: NotInitialized tests ──

#[test]
fn test_set_roles_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &contract_id);
    let addr = Address::generate(&env);
    let r = client.try_set_roles(&addr, &addr, &addr, &addr, &addr);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_asset_config_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &contract_id);
    let addr = Address::generate(&env);
    let r = client.try_set_asset_config(&addr, &addr, &true, &1000, &100, &0);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_vk_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &contract_id);
    let addr = Address::generate(&env);
    let vk = dummy_vk(&env, 4);
    let r = client.try_set_vk(&addr, &0, &0, &0, &vk);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_pause_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &contract_id);
    let addr = Address::generate(&env);
    let r = client.try_pause(&addr);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_unpause_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &contract_id);
    let addr = Address::generate(&env);
    let r = client.try_unpause(&addr);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

// ── InvalidProof tests (IC length mismatch via wrong dummy_vk signal count) ──

#[test]
fn test_deposit_rejects_invalid_proof() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Set deposit VK with WRONG signal count (2 instead of 3).
    // Deposit builds 4 signals → needs IC.len() = 5.
    // dummy_vk(env, 2) creates IC.len() = 3 → mismatch → InvalidProof.
    let bad_vk = dummy_vk(&env, 2);
    client.set_vk(&admin, &0, &0, &0, &bad_vk);

    let depositor = Address::generate(&env);
    let commitment = U256::from_u32(&env, 42);
    let proof = dummy_proof(&env);
    let r = client.try_deposit(&depositor, &asset, &5000, &commitment, &proof, &empty_note(&env));
    assert!(
        matches!(r, Err(Ok(Error::InvalidProof))),
        "expected Error::InvalidProof from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_transact_rejects_invalid_proof() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);
    let asset = Address::generate(&env);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Set transact VK for 1x1 with WRONG signal count (7 instead of 8).
    // 1x1 transact builds N+M+6 = 8 signals → needs IC.len() = 9.
    // dummy_vk(env, 7) creates IC.len() = 8 → mismatch → InvalidProof.
    let bad_vk = dummy_vk(&env, 7);
    client.set_vk(&admin, &1, &1, &1, &bad_vk);

    // Inject a state root at Root(0)
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    // Register a user in keystore so it has a valid root
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Submit an ASP root
    let asp_root = U256::from_u32(&env, 777);
    let cid = soroban_sdk::Bytes::from_slice(&env, b"QmTest");
    asp_client.update_asp_root(&asp_postman, &asp_root, &cid);

    let processor = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 100)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 200)];
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: soroban_sdk::Bytes::from_slice(&env, b"payload") }];
    let proof = dummy_proof(&env);
    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &proof,
        &fake_root,
        &ks_root,
        &asp_root,
        &0,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::InvalidProof))),
        "expected Error::InvalidProof from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_ragequit_rejects_invalid_proof() {
    let env = Env::default();
    let (client, admin, _, _, _, ks_client, _, _) = setup_with_contracts(&env);

    // Set ragequit VK with WRONG signal count (6 instead of 7).
    // Ragequit builds 7 signals → needs IC.len() = 8.
    // dummy_vk(env, 6) creates IC.len() = 7 → mismatch → InvalidProof.
    let bad_vk = dummy_vk(&env, 6);
    client.set_vk(&admin, &2, &0, &0, &bad_vk);

    // Inject a commitment so ragequit passes the CommitmentNotFound check
    let commitment = U256::from_u32(&env, 42);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(commitment.clone()), &true);
    });

    // Register a user in keystore so it has a valid root
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    let nullifier = U256::from_u32(&env, 999);
    let proof = dummy_proof(&env);
    let r = client.try_ragequit(
        &user,
        &proof,
        &nullifier,
        &commitment,
        &ks_root,
        &5000,
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &Address::generate(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::InvalidProof))),
        "expected Error::InvalidProof from this call specifically, got {:?}",
        r
    );
}

// ── Error path gap tests (EVM parity) ──

#[test]
fn test_transact_rejects_m_too_large() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    // m=6 is out of [1,5] range
    let commitments = soroban_sdk::vec![
        &env,
        U256::from_u32(&env, 1),
        U256::from_u32(&env, 2),
        U256::from_u32(&env, 3),
        U256::from_u32(&env, 4),
        U256::from_u32(&env, 5),
        U256::from_u32(&env, 6),
    ];
    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &6, // m=6 exceeds max of 5
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::InvalidNxM))),
        "expected Error::InvalidNxM from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_ragequit_rejects_wrong_owner() {
    // Ragequit calls owner.require_auth(). Without mock_all_auths, a call
    // from an unauthorized address must fail with an auth error.
    // We set up contracts using a mocked env, then verify the auth requirement
    // in a separate env where auth is NOT mocked.
    let env = Env::default();
    // Do NOT call env.mock_all_auths() globally — mock selectively.

    let ks_id = env.register(keystore::KeystoreContract, ());
    let ks_client = keystore::KeystoreContractClient::new(&env, &ks_id);
    let asp_id = env.register(asp_registry::AspRegistryContract, ());
    let pool_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &pool_id);

    // Setup requires auth — mock temporarily
    env.mock_all_auths();
    let admin = Address::generate(&env);
    ks_client.initialize(&admin, &3600u64, &262_144u32);
    client.initialize(&admin, &ks_id, &asp_id, &30, &MAX_STATE_TREE_SIZE);
    client.set_roles(
        &admin,
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
    );
    client.set_vk(&admin, &2, &0, &0, &dummy_vk(&env, 7));

    // Inject commitment into pool storage
    let commitment = U256::from_u32(&env, 42);
    env.as_contract(&pool_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(commitment.clone()), &true);
    });

    // Register user in keystore for a valid root
    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Now call ragequit without mocked auth.
    // mock_all_auths is sticky, so we use a second env for the auth test.
    let env2 = Env::default();
    // Do NOT mock_all_auths on env2

    let ks_id2 = env2.register(keystore::KeystoreContract, ());
    let ks_client2 = keystore::KeystoreContractClient::new(&env2, &ks_id2);
    let asp_id2 = env2.register(asp_registry::AspRegistryContract, ());
    let pool_id2 = env2.register(PoolContract, ());
    let client2 = PoolContractClient::new(&env2, &pool_id2);

    env2.mock_all_auths(); // setup only
    let admin2 = Address::generate(&env2);
    ks_client2.initialize(&admin2, &3600u64, &262_144u32);
    client2.initialize(&admin2, &ks_id2, &asp_id2, &30, &MAX_STATE_TREE_SIZE);
    client2.set_roles(
        &admin2,
        &Address::generate(&env2),
        &Address::generate(&env2),
        &Address::generate(&env2),
        &Address::generate(&env2),
    );
    client2.set_vk(&admin2, &2, &0, &0, &dummy_vk(&env2, 7));
    let commitment2 = U256::from_u32(&env2, 42);
    env2.as_contract(&pool_id2, || {
        env2.storage()
            .persistent()
            .set(&DataKey::Commitment(commitment2.clone()), &true);
    });
    let ks_user2 = Address::generate(&env2);
    ks_client2.set_auth_policy(&ks_user2, &U256::from_u32(&env2, 111), &U256::from_u32(&env2, 222));
    let ks_root2 = ks_client2.latest_root();

    // Ragequit without auth — should fail because owner.require_auth() is not satisfied
    let owner = Address::generate(&env2);
    let result = client2.try_ragequit(
        &owner,
        &dummy_proof(&env2),
        &U256::from_u32(&env2, 888),
        &commitment2,
        &ks_root2,
        &1000u128,
        &U256::from_u32(&env2, 0),
        &U256::from_u32(&env2, 0),
        &Address::generate(&env2),
    );
    assert!(result.is_err());
}

// ── Happy path tests (EVM parity) ──

/// Create a SAC token, mint tokens to `to`, and return the token address.
fn create_token(env: &Env, admin: &Address, to: &Address, amount: i128) -> Address {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let sac_client = StellarAssetClient::new(env, &sac.address());
    sac_client.mint(to, &amount);
    sac.address()
}

/// Perform a full deposit into the pool, returning the commitment used.
/// Requires deposit VK already set and asset configured.
fn do_deposit(
    env: &Env,
    client: &PoolContractClient,
    depositor: &Address,
    asset: &Address,
    value: u128,
    commitment_seed: u32,
) -> U256 {
    let commitment = U256::from_u32(env, commitment_seed);
    let proof = dummy_proof(env);
    client.deposit(depositor, asset, &value, &commitment, &proof, &empty_note(env));
    commitment
}

#[test]
fn test_deposit_happy_path() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, _ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    // Set deposit VK (4 signals: outputCommitment, tokenId, value, context)
    let vk = dummy_vk(&env, 4);
    client.set_vk(&admin, &0, &0, &0, &vk);

    // Create and configure token
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset); // 1% fee, min 1000

    let token = TokenClient::new(&env, &asset);
    let pool_addr = client.address.clone();

    // State before
    let depositor_balance_before = token.balance(&depositor);
    let pool_balance_before = token.balance(&pool_addr);
    assert_eq!(client.tree_size(), 0);

    // Deposit 10000 tokens (fee = 10000 * 100/10000 = 100, total = 10100)
    let commitment = do_deposit(&env, &client, &depositor, &asset, 10_000, 42);

    // Verify state after deposit
    assert_eq!(client.tree_size(), 1);

    // Token balances: depositor loses value + fee, pool gains value + fee
    let depositor_balance_after = token.balance(&depositor);
    let pool_balance_after = token.balance(&pool_addr);
    assert_eq!(
        depositor_balance_before - depositor_balance_after,
        10_100i128 // value (10000) + fee (100)
    );
    assert_eq!(pool_balance_after - pool_balance_before, 10_100i128);

    // Fee accumulated correctly
    let config = client.get_asset_config(&asset);
    assert_eq!(config.accumulated_fees, 100);

    // Root updated and is known
    let root = client.latest_root();
    assert!(client.is_known_root(&root));

    // Commitment is recorded (duplicate would fail)
    let result = client.try_deposit(&depositor, &asset, &10_000, &commitment, &dummy_proof(&env), &empty_note(&env));
    assert!(result.is_err()); // DuplicateCommitment
}

#[test]
fn test_transact_happy_path_with_withdrawal() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set deposit VK (4 signals) and transact VK for 1x1 (8 signals)
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8));

    // Create token and mint to depositor
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Do a deposit first to get a state root and fund the pool
    let _dep_commitment = do_deposit(&env, &client, &depositor, &asset, 50_000, 100);
    let state_root = client.latest_root();

    // Setup keystore root
    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Setup ASP root
    let asp_root = U256::from_u32(&env, 555);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);
    let pool_addr = client.address.clone();

    let pool_balance_before = token.balance(&pool_addr);
    let processor_balance_before = token.balance(&processor);
    let tree_size_before = client.tree_size();

    // Transact 1x1 with withdrawal of 5000
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 200)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 300)];
    let token_id_out = soroban_v2_utils::encode_token_id(&env, &asset);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, b"enc_payload") }];

    client.transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &state_root,
        &ks_root,
        &asp_root,
        &5_000u128,
        &token_id_out,
        &nullifiers,
        &commitments,
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );

    // Verify state changes
    // Tree size: +2 (1 commitment leaf + 1 nullifier leaf for 1x1)
    assert_eq!(client.tree_size(), tree_size_before + 2);

    // Token transfer: pool → processor
    let pool_balance_after = token.balance(&pool_addr);
    let processor_balance_after = token.balance(&processor);
    assert_eq!(pool_balance_before - pool_balance_after, 5_000i128);
    assert_eq!(processor_balance_after - processor_balance_before, 5_000i128);

    // Root updated
    let new_root = client.latest_root();
    assert!(new_root != state_root);
    assert!(client.is_known_root(&new_root));

    // Nullifier is spent (trying again would fail)
    let result = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &new_root,
        &ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &soroban_sdk::vec![&env, U256::from_u32(&env, 400)],
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );
    assert!(result.is_err()); // NullifierAlreadySpent
}

#[test]
fn test_transact_happy_path_pure_transfer() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set VKs
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8));

    // Create token and deposit
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);
    let _dep = do_deposit(&env, &client, &depositor, &asset, 50_000, 100);
    let state_root = client.latest_root();

    // Setup cross-contract roots
    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();
    let asp_root = U256::from_u32(&env, 555);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);
    let pool_addr = client.address.clone();

    let pool_balance_before = token.balance(&pool_addr);
    let tree_size_before = client.tree_size();

    // Transact 1x1 with amountOut=0 (pure transfer, no withdrawal)
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 500)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 600)];
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, b"payload") }];

    client.transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &state_root,
        &ks_root,
        &asp_root,
        &0u128,                     // no withdrawal
        &U256::from_u32(&env, 0),   // tokenIdOut = 0
        &nullifiers,
        &commitments,
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );

    // Verify: no token transfer occurred
    let pool_balance_after = token.balance(&pool_addr);
    assert_eq!(pool_balance_before, pool_balance_after);

    // But tree still updated
    assert_eq!(client.tree_size(), tree_size_before + 2);

    // Nullifier spent
    let new_root = client.latest_root();
    assert!(new_root != state_root);
    assert!(client.is_known_root(&new_root));
}

#[test]
fn test_ragequit_happy_path() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    // Set deposit VK (4 signals) and ragequit VK (7 signals)
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &2, &0, &0, &dummy_vk(&env, 7));

    // Create token and deposit
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let deposit_value: u128 = 50_000;
    let commitment = do_deposit(&env, &client, &depositor, &asset, deposit_value, 42);

    // Register user in keystore for a valid keystore root
    let owner = Address::generate(&env);
    ks_client.set_auth_policy(&owner, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    let token = TokenClient::new(&env, &asset);
    let pool_addr = client.address.clone();

    let pool_balance_before = token.balance(&pool_addr);
    let owner_balance_before = token.balance(&owner);
    let tree_size_before = client.tree_size();

    // Ragequit: withdraw full value (no fee)
    let nullifier_hash = U256::from_u32(&env, 888);
    let token_id = soroban_v2_utils::encode_token_id(&env, &asset);
    let label = U256::from_u32(&env, 777);

    client.ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier_hash,
        &commitment,
        &ks_root,
        &deposit_value,
        &token_id,
        &label,
        &asset,
    );

    // Verify state changes
    // Tree: +1 (nullifier leaf inserted)
    assert_eq!(client.tree_size(), tree_size_before + 1);

    // Token transfer: pool → owner (full value, no fee)
    let pool_balance_after = token.balance(&pool_addr);
    let owner_balance_after = token.balance(&owner);
    assert_eq!(
        pool_balance_before - pool_balance_after,
        deposit_value as i128
    );
    assert_eq!(
        owner_balance_after - owner_balance_before,
        deposit_value as i128
    );

    // Root updated
    let new_root = client.latest_root();
    assert!(client.is_known_root(&new_root));

    // Nullifier is spent
    let result = client.try_ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier_hash,
        &commitment,
        &ks_root,
        &deposit_value,
        &token_id,
        &label,
        &asset,
    );
    assert!(result.is_err()); // NullifierAlreadySpent
}

// ── Missing error path tests (TEST-01) ──

#[test]
fn test_deposit_rejects_vk_not_found() {
    let env = Env::default();
    let (client, _, _, _, asset_manager, _ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    // Configure asset but do NOT set a deposit VK
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let commitment = U256::from_u32(&env, 42);
    let r = client.try_deposit(&depositor, &asset, &10_000, &commitment, &dummy_proof(&env), &empty_note(&env));
    assert!(
        matches!(r, Err(Ok(Error::VkNotFound))),
        "expected Error::VkNotFound from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_transact_rejects_duplicate_commitment_in_tx() {
    let env = Env::default();
    let (client, admin, _, _, _, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set a transact VK for 1x2 (n=1, m=2 → 1+2+6 = 9 signals)
    let vk = dummy_vk(&env, 9);
    client.set_vk(&admin, &1, &1, &2, &vk);

    // Inject a fake state root
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    // Setup keystore and ASP roots
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();
    let asp_root = U256::from_u32(&env, 333);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let dup_commitment = U256::from_u32(&env, 77);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    // Two identical output commitments
    let commitments = soroban_sdk::vec![&env, dup_commitment.clone(), dup_commitment.clone()];
    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &2,
        &dummy_proof(&env),
        &fake_root,
        &ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec_n(&env, 2),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::DuplicateCommitment))),
        "expected Error::DuplicateCommitment from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_transact_rejects_nonzero_token_id_with_zero_amount() {
    let env = Env::default();
    let (client, admin, _, _, _, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set a transact VK for 1x1 (8 signals)
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8));

    // Inject a fake state root
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    // Setup keystore and ASP roots
    let user = Address::generate(&env);
    ks_client.set_auth_policy(&user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();
    let asp_root = U256::from_u32(&env, 333);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 2)];


    // amount_out = 0 but token_id_out != 0 → InvalidTokenId
    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &fake_root,
        &ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 42), // non-zero tokenIdOut
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(r, Err(Ok(Error::InvalidTokenId))),
        "expected Error::InvalidTokenId from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_withdraw_fees_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &contract_id);
    // Do NOT call initialize
    let rando = Address::generate(&env);
    let asset = Address::generate(&env);
    let recipient = Address::generate(&env);
    let r = client.try_withdraw_fees(&rando, &asset, &100, &recipient);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

// ── Boundary condition tests (TEST-04) ──

#[test]
fn test_deposit_at_exact_minimum() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, _ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    // min_deposit = 1000, fee_bps = 100 (1%)
    setup_asset(&env, &client, &asset_manager, &asset);

    let commitment = U256::from_u32(&env, 42);
    // Deposit exactly 1000 (minimum) — should succeed
    client.deposit(&depositor, &asset, &1000, &commitment, &dummy_proof(&env), &empty_note(&env));
    assert_eq!(client.tree_size(), 1);
}

// ── Fix placeholder test (TEST-07) ──

#[test]
fn test_transact_rejects_unknown_keystore_root_real() {
    let env = Env::default();
    let (client, admin, _, _, _, _ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set a transact VK for 1x1 (8 signals)
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8));

    // Inject a fake state root so we pass the state root check
    let fake_root = U256::from_u32(&env, 999);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Root(0u32), &fake_root);
    });

    // Setup ASP root but do NOT register anyone in keystore
    let asp_root = U256::from_u32(&env, 333);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let asset = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 1)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 2)];


    // Use a bogus keystore root that won't be in the keystore's root buffer
    let bogus_ks_root = U256::from_u32(&env, 777);

    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &fake_root,
        &bogus_ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &commitments,
        &asset,
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );

    assert!(

        matches!(r, Err(Ok(Error::UnknownKeystoreRoot))),

        "expected Error::UnknownKeystoreRoot from this call specifically, got {:?}",

        r

    );
}

#[test]
fn test_root_buffer_evicts_oldest_root() {
    let env = Env::default();
    // Use a very small root history (3) so we can trigger eviction with just 4 deposits
    let (client, admin, _, _, asset_manager, _ks_client, _asp_client, _asp_postman) =
        setup_with_contracts_custom_history(&env, 3);

    // Set deposit VK
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Do 4 deposits, capture each root
    // Buffer size is 3, so after 4 deposits, root1 should be evicted
    let _c1 = do_deposit(&env, &client, &depositor, &asset, 10_000, 1);
    let root1 = client.latest_root();

    let _c2 = do_deposit(&env, &client, &depositor, &asset, 10_000, 2);
    let root2 = client.latest_root();

    let _c3 = do_deposit(&env, &client, &depositor, &asset, 10_000, 3);
    let root3 = client.latest_root();

    // All 3 roots should be known at this point
    assert!(client.is_known_root(&root1));
    assert!(client.is_known_root(&root2));
    assert!(client.is_known_root(&root3));

    // 4th deposit: root1 is evicted (overwritten at index 0 in circular buffer)
    let _c4 = do_deposit(&env, &client, &depositor, &asset, 10_000, 4);
    let root4 = client.latest_root();

    // root1 is now evicted
    assert!(!client.is_known_root(&root1));

    // roots 2, 3, 4 are still known
    assert!(client.is_known_root(&root2));
    assert!(client.is_known_root(&root3));
    assert!(client.is_known_root(&root4));
}

#[test]
fn test_deposit_rejects_insufficient_balance() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, _ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    // Set deposit VK (4 signals)
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));

    // Create depositor with only 5000 tokens (insufficient for 10000 + 1% fee = 10100)
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 5_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Attempt deposit of 10000 (total = 10100 with fee) — should fail
    let commitment = U256::from_u32(&env, 42);
    let result = client.try_deposit(&depositor, &asset, &10_000, &commitment, &dummy_proof(&env), &empty_note(&env));
    assert!(result.is_err());
}

#[test]
fn test_transact_withdrawal_fails_insufficient_pool_balance() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set deposit VK (4 signals) and transact VK for 1x1 (8 signals)
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8));

    // Create token and mint to depositor
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Deposit 10_000 (pool gets 10_100 with fee)
    let _dep_commitment = do_deposit(&env, &client, &depositor, &asset, 10_000, 100);
    let state_root = client.latest_root();

    // Setup keystore root
    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Setup ASP root
    let asp_root = U256::from_u32(&env, 555);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);

    // Attempt transact 1x1 with withdrawal of 50_000 (exceeds pool balance of 10_100)
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 200)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 300)];
    let token_id_out = soroban_v2_utils::encode_token_id(&env, &asset);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, b"enc_payload") }];

    let result = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &state_root,
        &ks_root,
        &asp_root,
        &50_000u128,
        &token_id_out,
        &nullifiers,
        &commitments,
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );
    assert!(result.is_err());
}

#[test]
fn test_ragequit_fails_insufficient_pool_balance() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    // Set deposit VK (4 signals) and ragequit VK (7 signals)
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &2, &0, &0, &dummy_vk(&env, 7));

    // Create token and deposit
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Deposit 10_000 (pool gets 10_100 with fee)
    let _dep_commitment = do_deposit(&env, &client, &depositor, &asset, 10_000, 42);

    // Register user in keystore for a valid keystore root
    let owner = Address::generate(&env);
    ks_client.set_auth_policy(&owner, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Attempt ragequit with value=50_000 (exceeds pool balance of 10_100)
    let nullifier_hash = U256::from_u32(&env, 888);
    let commitment = U256::from_u32(&env, 42); // same seed as deposited
    let token_id = soroban_v2_utils::encode_token_id(&env, &asset);
    let label = U256::from_u32(&env, 777);

    let result = client.try_ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier_hash,
        &commitment,
        &ks_root,
        &50_000u128,
        &token_id,
        &label,
        &asset,
    );
    assert!(result.is_err());
}

#[test]
fn test_withdraw_fees_verifies_balances() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, _ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    // Set deposit VK and configure asset
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Deposit 10_000 (fee = 1% of 10_000 = 100)
    do_deposit(&env, &client, &depositor, &asset, 10_000, 42);

    let token = TokenClient::new(&env, &asset);
    let pool_addr = client.address.clone();
    let recipient = Address::generate(&env);

    // Balances before withdrawal
    let pool_before = token.balance(&pool_addr);
    let recipient_before = token.balance(&recipient);

    // Withdraw all accumulated fees
    client.withdraw_fees(&asset_manager, &asset, &100, &recipient);

    // Verify balances after withdrawal
    assert_eq!(token.balance(&recipient), recipient_before + 100);
    assert_eq!(token.balance(&pool_addr), pool_before - 100);

    // Verify accumulated fees are now zero
    let config = client.get_asset_config(&asset);
    assert_eq!(config.accumulated_fees, 0);
}

#[test]
fn test_transact_happy_path_2x2() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set VKs: deposit (4 signals), transact 2x2 (10 signals), transact 1x1 (8 signals for re-spend check)
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &1, &2, &2, &dummy_vk(&env, 10));
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8)); // for nullifier re-spend check

    // Create token and deposit
    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let _dep = do_deposit(&env, &client, &depositor, &asset, 50_000, 100);
    let state_root = client.latest_root();

    // Keystore + ASP
    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();
    let asp_root = U256::from_u32(&env, 555);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);
    let pool_addr = client.address.clone();

    let pool_before = token.balance(&pool_addr);
    let proc_before = token.balance(&processor);
    let tree_before = client.tree_size();

    // 2x2 transact with withdrawal of 5000
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 201), U256::from_u32(&env, 202)];
    let commitments =
        soroban_sdk::vec![&env, U256::from_u32(&env, 301), U256::from_u32(&env, 302)];
    let token_id_out = soroban_v2_utils::encode_token_id(&env, &asset);
    let note_data_vec = empty_note_vec_n(&env, 2);

    client.transact(
        &processor,
        &true,
        &2,
        &2,
        &dummy_proof(&env),
        &state_root,
        &ks_root,
        &asp_root,
        &5_000u128,
        &token_id_out,
        &nullifiers,
        &commitments,
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );

    // Tree: +4 (2 nullifier leaves + 2 commitment leaves = N+M)
    assert_eq!(client.tree_size(), tree_before + 4);

    // Balances
    assert_eq!(pool_before - token.balance(&pool_addr), 5_000i128);
    assert_eq!(token.balance(&processor) - proc_before, 5_000i128);

    // Root updated
    let new_root = client.latest_root();
    assert!(new_root != state_root);
    assert!(client.is_known_root(&new_root));

    // Both nullifiers are spent — check each via 1x1 re-spend attempt
    for i in 0..2u32 {
        let null_i = if i == 0 {
            U256::from_u32(&env, 201)
        } else {
            U256::from_u32(&env, 202)
        };
        let result = client.try_transact(
            &processor,
            &true,
            &1,
            &1,
            &dummy_proof(&env),
            &new_root,
            &ks_root,
            &asp_root,
            &0u128,
            &U256::from_u32(&env, 0),
            &soroban_sdk::vec![&env, null_i],
            &soroban_sdk::vec![&env, U256::from_u32(&env, 400 + i)],
            &asset,
            &empty_note_vec(&env),
            &Bytes::new(&env),
        );
        assert!(result.is_err()); // NullifierAlreadySpent
    }

    // Both commitments recorded — re-deposit each → DuplicateCommitment
    for seed in [301u32, 302] {
        let result = client.try_deposit(
            &depositor,
            &asset,
            &10_000,
            &U256::from_u32(&env, seed),
            &dummy_proof(&env),
            &empty_note(&env),
        );
        assert!(result.is_err()); // DuplicateCommitment
    }
}

#[test]
fn test_transact_happy_path_3x1() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set VKs
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &1, &3, &1, &dummy_vk(&env, 10));
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8)); // for nullifier re-spend

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let _dep = do_deposit(&env, &client, &depositor, &asset, 50_000, 100);
    let state_root = client.latest_root();

    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();
    let asp_root = U256::from_u32(&env, 555);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);
    let pool_addr = client.address.clone();

    let pool_before = token.balance(&pool_addr);
    let proc_before = token.balance(&processor);
    let tree_before = client.tree_size();

    // 3x1 transact with withdrawal of 3000
    let nullifiers = soroban_sdk::vec![
        &env,
        U256::from_u32(&env, 501),
        U256::from_u32(&env, 502),
        U256::from_u32(&env, 503),
    ];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 601)];
    let token_id_out = soroban_v2_utils::encode_token_id(&env, &asset);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, b"enc1") }];

    client.transact(
        &processor,
        &true,
        &3,
        &1,
        &dummy_proof(&env),
        &state_root,
        &ks_root,
        &asp_root,
        &3_000u128,
        &token_id_out,
        &nullifiers,
        &commitments,
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );

    // Tree: +4 (3 nullifier leaves + 1 commitment leaf = N+M)
    assert_eq!(client.tree_size(), tree_before + 4);

    // Balances
    assert_eq!(pool_before - token.balance(&pool_addr), 3_000i128);
    assert_eq!(token.balance(&processor) - proc_before, 3_000i128);

    // Root updated
    let new_root = client.latest_root();
    assert!(new_root != state_root);
    assert!(client.is_known_root(&new_root));

    // All 3 nullifiers are spent
    for seed in [501u32, 502, 503] {
        let result = client.try_transact(
            &processor,
            &true,
            &1,
            &1,
            &dummy_proof(&env),
            &new_root,
            &ks_root,
            &asp_root,
            &0u128,
            &U256::from_u32(&env, 0),
            &soroban_sdk::vec![&env, U256::from_u32(&env, seed)],
            &soroban_sdk::vec![&env, U256::from_u32(&env, seed + 200)],
            &asset,
            &empty_note_vec(&env),
            &Bytes::new(&env),
        );
        assert!(result.is_err()); // NullifierAlreadySpent
    }

    // 1 commitment recorded
    let result = client.try_deposit(
        &depositor,
        &asset,
        &10_000,
        &U256::from_u32(&env, 601),
        &dummy_proof(&env),
        &empty_note(&env),
    );
    assert!(result.is_err()); // DuplicateCommitment
}

#[test]
fn test_e2e_deposit_transact_ragequit() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    // Set all 3 VKs
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4)); // deposit
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8)); // transact 1x1
    client.set_vk(&admin, &2, &0, &0, &dummy_vk(&env, 7)); // ragequit

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let token = TokenClient::new(&env, &asset);
    let pool_addr = client.address.clone();

    // ── Phase 1: Deposit ──
    let initial_depositor_balance = token.balance(&depositor);
    let commitment_1 = do_deposit(&env, &client, &depositor, &asset, 10_000, 42);
    assert_eq!(client.tree_size(), 1);

    let depositor_after_deposit = token.balance(&depositor);
    assert_eq!(
        initial_depositor_balance - depositor_after_deposit,
        10_100i128
    ); // value + 1% fee
    assert_eq!(token.balance(&pool_addr), 10_100i128);

    let root_after_deposit = client.latest_root();
    assert!(client.is_known_root(&root_after_deposit));

    // ── Phase 2: Transact 1x1 (withdraw 3000) ──
    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();
    let asp_root = U256::from_u32(&env, 555);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 200)];
    let output_commitment = U256::from_u32(&env, 300);
    let commitments = soroban_sdk::vec![&env, output_commitment.clone()];
    let token_id_out = soroban_v2_utils::encode_token_id(&env, &asset);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, b"enc") }];

    client.transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &root_after_deposit,
        &ks_root,
        &asp_root,
        &3_000u128,
        &token_id_out,
        &nullifiers,
        &commitments,
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );

    assert_eq!(client.tree_size(), 3); // 1 from deposit + 2 from transact (N+M=1+1)
    assert_eq!(token.balance(&pool_addr), 7_100i128); // 10100 - 3000
    assert_eq!(token.balance(&processor), 3_000i128);

    let root_after_transact = client.latest_root();
    assert!(root_after_transact != root_after_deposit);
    assert!(client.is_known_root(&root_after_transact));

    // Nullifier 200 is spent
    let result = client.try_transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &root_after_transact,
        &ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &nullifiers,
        &soroban_sdk::vec![&env, U256::from_u32(&env, 999)],
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );
    assert!(result.is_err());

    // Output commitment 300 is recorded
    let result = client.try_deposit(
        &depositor,
        &asset,
        &10_000,
        &output_commitment,
        &dummy_proof(&env),
        &empty_note(&env),
    );
    assert!(result.is_err()); // DuplicateCommitment

    // ── Phase 3: Ragequit (using original deposit commitment) ──
    let owner = Address::generate(&env);
    // Need a fresh keystore root (owner must be registered for ragequit to verify)
    ks_client.set_auth_policy(&owner, &U256::from_u32(&env, 333), &U256::from_u32(&env, 444));
    let ks_root_rq = ks_client.latest_root();

    let nullifier_rq = U256::from_u32(&env, 888);
    let token_id = soroban_v2_utils::encode_token_id(&env, &asset);
    let label = U256::from_u32(&env, 777);

    let pool_before_rq = token.balance(&pool_addr);
    let owner_before = token.balance(&owner);

    // Ragequit for 7000 (pool has 7100 = 10100 deposit - 3000 transact withdrawal)
    client.ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier_rq,
        &commitment_1,
        &ks_root_rq,
        &7_000u128,
        &token_id,
        &label,
        &asset,
    );

    assert_eq!(client.tree_size(), 4); // 3 from before + 1 nullifier leaf
    assert_eq!(
        pool_before_rq - token.balance(&pool_addr),
        7_000i128
    ); // ragequit value
    assert_eq!(token.balance(&owner) - owner_before, 7_000i128);

    let root_after_rq = client.latest_root();
    assert!(client.is_known_root(&root_after_rq));

    // Ragequit nullifier is spent
    let result = client.try_ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier_rq,
        &commitment_1,
        &ks_root_rq,
        &7_000u128,
        &token_id,
        &label,
        &asset,
    );
    assert!(result.is_err()); // NullifierAlreadySpent

    // Final state: all 3 roots are known (deposit + transact + ragequit)
    assert!(client.is_known_root(&root_after_deposit));
    assert!(client.is_known_root(&root_after_transact));
    assert!(client.is_known_root(&root_after_rq));

    // Fees: 100 accumulated from deposit (1% of 10000)
    assert_eq!(client.get_asset_config(&asset).accumulated_fees, 100);
}

// ── Event emission tests (meta-alignment audit coverage) ──

#[test]
fn test_deposit_emits_event() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, _ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let commitment = U256::from_u32(&env, 42);
    client.deposit(&depositor, &asset, &10_000, &commitment, &dummy_proof(&env), &empty_note(&env));

    let expected = Deposited {
        commitment: commitment.clone(),
        asset: asset.clone(),
        value: 10_000,
        depositor: depositor.clone(),
    };
    let events = env.events().all();
    assert!(
        events.events().contains(&expected.to_xdr(&env, &client.address)),
        "Deposited event not found"
    );

    // Verify NoteEvent emitted
    let expected_note = NoteEvent {
        hint: BytesN::from_array(&env, &[0u8; 32]),
        data: Bytes::new(&env),
    };
    assert!(
        events.events().contains(&expected_note.to_xdr(&env, &client.address)),
        "NoteEvent not found in deposit"
    );
}

#[test]
fn test_transact_emits_event() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    do_deposit(&env, &client, &depositor, &asset, 50_000, 100);
    let state_root = client.latest_root();

    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    let asp_root = U256::from_u32(&env, 555);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 200)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 300)];
    let token_id_out = soroban_v2_utils::encode_token_id(&env, &asset);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, b"enc_payload") }];

    client.transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &state_root,
        &ks_root,
        &asp_root,
        &5_000u128,
        &token_id_out,
        &nullifiers,
        &commitments,
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );

    let expected = Transacted {
        commitments,
        nullifiers,
        asset: asset.clone(),
        amount_out: 5_000,
        processor: processor.clone(),
    };
    let events = env.events().all();
    assert!(
        events.events().contains(&expected.to_xdr(&env, &client.address)),
        "Transacted event not found"
    );

    // Verify NoteEvent emitted for each output note
    let expected_note = NoteEvent {
        hint: BytesN::from_array(&env, &[0u8; 32]),
        data: Bytes::from_slice(&env, b"enc_payload"),
    };
    assert!(
        events.events().contains(&expected_note.to_xdr(&env, &client.address)),
        "NoteEvent not found in transact"
    );
}

#[test]
fn test_ragequit_emits_event() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &2, &0, &0, &dummy_vk(&env, 7));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let deposit_value: u128 = 50_000;
    let commitment = do_deposit(&env, &client, &depositor, &asset, deposit_value, 42);

    let owner = Address::generate(&env);
    ks_client.set_auth_policy(&owner, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    let nullifier_hash = U256::from_u32(&env, 888);
    let token_id = soroban_v2_utils::encode_token_id(&env, &asset);
    let label = U256::from_u32(&env, 777);

    client.ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier_hash,
        &commitment,
        &ks_root,
        &deposit_value,
        &token_id,
        &label,
        &asset,
    );

    let expected = RagequitEvent {
        owner: owner.clone(),
        asset: asset.clone(),
        value: deposit_value,
        commitment,
        nullifier_hash,
        label,
    };
    let events = env.events().all();
    assert!(
        events.events().contains(&expected.to_xdr(&env, &client.address)),
        "RagequitEvent not found"
    );
}

// ── LeavesInserted event tests ──

#[test]
fn test_deposit_emits_leaves_inserted_event() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, _ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let commitment = U256::from_u32(&env, 42);
    client.deposit(&depositor, &asset, &10_000, &commitment, &dummy_proof(&env), &empty_note(&env));

    // Capture events BEFORE any other contract calls (which reset the event buffer)
    let events = env.events().all();

    // Compute expected leaf: Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)
    let timestamp = env.ledger().timestamp();
    let ts_u256 = U256::from_u128(&env, u128::from(timestamp));
    let expected_leaf =
        poseidon_hash_three(&env, &commitment_leaf_tag(&env), &commitment, &ts_u256);

    // Get root after capturing events
    let root = client.latest_root();

    let expected = LeavesInserted {
        leaves: soroban_sdk::vec![&env, expected_leaf],
        root,
        start_index: 0,
    };
    assert!(
        events.events().contains(&expected.to_xdr(&env, &client.address)),
        "LeavesInserted event not found in deposit"
    );
}

#[test]
fn test_transact_emits_leaves_inserted_event() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    do_deposit(&env, &client, &depositor, &asset, 50_000, 100);
    let state_root = client.latest_root();
    let tree_size_before = client.tree_size();

    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    let asp_root = U256::from_u32(&env, 555);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let nullifier = U256::from_u32(&env, 200);
    let commitment_out = U256::from_u32(&env, 300);
    let nullifiers = soroban_sdk::vec![&env, nullifier.clone()];
    let commitments = soroban_sdk::vec![&env, commitment_out.clone()];
    let token_id_out = encode_token_id(&env, &asset);
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![&env, NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::from_slice(&env, b"enc_payload") }];

    client.transact(
        &processor,
        &true,
        &1,
        &1,
        &dummy_proof(&env),
        &state_root,
        &ks_root,
        &asp_root,
        &5_000u128,
        &token_id_out,
        &nullifiers,
        &commitments,
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );

    // Capture events BEFORE any other contract calls (which reset the event buffer)
    let events = env.events().all();

    // Compute expected leaves: [Poseidon(COMMITMENT_LEAF_TAG, commitment, ts),
    //                           Poseidon(NULLIFIER_LEAF_TAG, nullifier, ts)]
    // m=1 commitments first, then n=1 nullifiers
    let timestamp = env.ledger().timestamp();
    let ts_u256 = U256::from_u128(&env, u128::from(timestamp));
    let leaf_cm = poseidon_hash_three(&env, &commitment_leaf_tag(&env), &commitment_out, &ts_u256);
    let leaf_null = poseidon_hash_three(&env, &nullifier_leaf_tag(&env), &nullifier, &ts_u256);

    // Get root after capturing events
    let root = client.latest_root();

    let expected = LeavesInserted {
        leaves: soroban_sdk::vec![&env, leaf_cm, leaf_null],
        root,
        start_index: tree_size_before,
    };
    assert!(
        events.events().contains(&expected.to_xdr(&env, &client.address)),
        "LeavesInserted event not found in transact"
    );
}

#[test]
fn test_ragequit_emits_leaves_inserted_event() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &2, &0, &0, &dummy_vk(&env, 7));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let deposit_value: u128 = 50_000;
    let commitment = do_deposit(&env, &client, &depositor, &asset, deposit_value, 42);
    let tree_size_before_rq = client.tree_size();

    let owner = Address::generate(&env);
    ks_client.set_auth_policy(&owner, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    let nullifier_hash = U256::from_u32(&env, 888);
    let token_id = encode_token_id(&env, &asset);
    let label = U256::from_u32(&env, 777);

    client.ragequit(
        &owner,
        &dummy_proof(&env),
        &nullifier_hash,
        &commitment,
        &ks_root,
        &deposit_value,
        &token_id,
        &label,
        &asset,
    );

    // Capture events BEFORE any other contract calls (which reset the event buffer)
    let events = env.events().all();

    // Compute expected leaf: Poseidon(NULLIFIER_LEAF_TAG, nullifier_hash, timestamp)
    let timestamp = env.ledger().timestamp();
    let ts_u256 = U256::from_u128(&env, u128::from(timestamp));
    let expected_leaf =
        poseidon_hash_three(&env, &nullifier_leaf_tag(&env), &nullifier_hash, &ts_u256);

    // Get root after capturing events
    let root = client.latest_root();

    let expected = LeavesInserted {
        leaves: soroban_sdk::vec![&env, expected_leaf],
        root,
        start_index: tree_size_before_rq,
    };
    assert!(
        events.events().contains(&expected.to_xdr(&env, &client.address)),
        "LeavesInserted event not found in ragequit"
    );
}

// ── compute_deposit_context unit tests ──

#[test]
fn test_compute_deposit_context_deterministic() {
    let env = Env::default();
    let note = NoteData {
        hint: BytesN::from_array(&env, &[7u8; 32]),
        data: Bytes::from_slice(&env, b"test_payload"),
    };
    let result1 = super::compute_deposit_context(&env, &note);
    let result2 = super::compute_deposit_context(&env, &note);
    assert_eq!(result1, result2, "compute_deposit_context should be deterministic");
}

#[test]
fn test_compute_deposit_context_different_inputs() {
    let env = Env::default();
    let note_a = NoteData {
        hint: BytesN::from_array(&env, &[1u8; 32]),
        data: Bytes::from_slice(&env, b"payload_a"),
    };
    let note_b = NoteData {
        hint: BytesN::from_array(&env, &[2u8; 32]),
        data: Bytes::from_slice(&env, b"payload_b"),
    };
    let result_a = super::compute_deposit_context(&env, &note_a);
    let result_b = super::compute_deposit_context(&env, &note_b);
    assert!(result_a != result_b, "Different inputs should produce different context hashes");

    // Also verify different data with same hint produces different results
    let note_c = NoteData {
        hint: BytesN::from_array(&env, &[1u8; 32]),
        data: Bytes::from_slice(&env, b"payload_c"),
    };
    let result_c = super::compute_deposit_context(&env, &note_c);
    assert!(result_a != result_c, "Different data with same hint should produce different context hashes");
}

// ── note_data length mismatch test ──

#[test]
fn test_transact_rejects_note_data_length_mismatch() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &1, &1, &1, &dummy_vk(&env, 8));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    do_deposit(&env, &client, &depositor, &asset, 50_000, 100);
    let state_root = client.latest_root();

    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    let asp_root = U256::from_u32(&env, 555);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    let processor = Address::generate(&env);
    let nullifiers = soroban_sdk::vec![&env, U256::from_u32(&env, 200)];
    let commitments = soroban_sdk::vec![&env, U256::from_u32(&env, 300)];
    let token_id_out = encode_token_id(&env, &asset);

    // m=1 but note_data has 2 elements — should fail with InvalidNxM (#19)
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![
        &env,
        NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::new(&env) },
        NoteData { hint: BytesN::from_array(&env, &[1u8; 32]), data: Bytes::new(&env) }
    ];

    let r = client.try_transact(
        &processor,
        &true,
        &1,
        &1, // m=1 but note_data has 2 elements
        &dummy_proof(&env),
        &state_root,
        &ks_root,
        &asp_root,
        &5_000u128,
        &token_id_out,
        &nullifiers,
        &commitments,
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );

    assert!(

        matches!(r, Err(Ok(Error::InvalidNxM))),

        "expected Error::InvalidNxM from this call specifically, got {:?}",

        r

    );
}

/// Blind / out-of-band recipients publish no Note event, so a transact may carry fewer note_data
/// entries than outputs.
#[test]
fn test_transact_accepts_fewer_note_data_than_outputs() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, asp_client, asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &1, &1, &2, &dummy_vk(&env, 9));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    do_deposit(&env, &client, &depositor, &asset, 50_000, 100);
    let state_root = client.latest_root();

    let ks_user = Address::generate(&env);
    ks_client.set_auth_policy(&ks_user, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    let asp_root = U256::from_u32(&env, 555);
    asp_client.update_asp_root(&asp_postman, &asp_root, &Bytes::from_slice(&env, b"QmTest"));

    // m=2 (change + recipient) but only the change note is published
    let note_data_vec: Vec<NoteData> = soroban_sdk::vec![
        &env,
        NoteData { hint: BytesN::from_array(&env, &[0u8; 32]), data: Bytes::new(&env) }
    ];

    let result = client.try_transact(
        &Address::generate(&env),
        &false,
        &1,
        &2,
        &dummy_proof(&env),
        &state_root,
        &ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &soroban_sdk::vec![&env, U256::from_u32(&env, 200)],
        &soroban_sdk::vec![&env, U256::from_u32(&env, 300), U256::from_u32(&env, 301)],
        &asset,
        &note_data_vec,
        &Bytes::new(&env),
    );
    assert_eq!(result, Ok(Ok(())));
}

// ── upgrade (mirrors EVM UPGRADER_ROLE) ──

#[test]
fn test_upgrade_rejects_non_upgrader() {
    let env = Env::default();
    let (client, _, _, _, _) = setup(&env);
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
    let (client, admin, _, _, _) = setup(&env);
    // set_roles assigned upgrader to a separate address; admin must not be
    // able to upgrade on its own — least-privilege, mirrors EVM AccessRouter.
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
    let id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &id);
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
fn test_upgrade_rejects_initialized_but_roles_not_set() {
    let env = Env::default();
    env.mock_all_auths();
    let ks_id = env.register(keystore::KeystoreContract, ());
    let asp_id = env.register(asp_registry::AspRegistryContract, ());
    let pool_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &pool_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &ks_id, &asp_id, &30, &MAX_STATE_TREE_SIZE);
    // set_roles NOT called — Upgrader slot still empty
    let wasm_hash = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let r = client.try_upgrade(&admin, &wasm_hash);
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_upgrade_rejects_zero_wasm_hash() {
    let env = Env::default();
    let (client, _admin, _, _, _) = setup(&env);
    let upgrader_addr = Address::generate(&env);
    // Re-assign upgrader so the caller in the next step matches.
    // set_roles already sets one random upgrader in setup(), so use that.
    // Simpler: call with an admin's 'admin' address but since admin != stored
    // upgrader, the zero-hash guard must fire BEFORE the auth check.
    let zero_hash = BytesN::<32>::from_array(&env, &[0u8; 32]);
    let r = client.try_upgrade(&upgrader_addr, &zero_hash);
    assert!(
        matches!(r, Err(Ok(Error::InvalidWasmHash))),
        "expected Error::InvalidWasmHash from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_set_asset_config_rejects_max_relay_fee_ceiling() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    // 10^30 + 1 — one above ceiling.
    let over_ceiling: u128 = 1_000_000_000_000_000_000_000_000_000_001u128;
    let r = client.try_set_asset_config(&asset_manager, &asset, &true, &1000, &100, &over_ceiling);
    assert!(
        matches!(r, Err(Ok(Error::InvalidMaxRelayFee))),
        "expected Error::InvalidMaxRelayFee from this call specifically, got {:?}",
        r
    );
}

// ── New gaps (GAP-STATE-R1-01, GAP-BND-R1-01, GAP-EVT-R1-02) ──

#[test]
fn test_set_asset_config_persists_max_relay_fee() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    client.set_asset_config(&asset_manager, &asset, &true, &1000, &100, &42_000_000u128);
    let cfg = client.get_asset_config(&asset);
    assert_eq!(cfg.max_relay_fee, 42_000_000u128,
        "max_relay_fee must round-trip through set_asset_config / get_asset_config");
}

#[test]
fn test_set_asset_config_accepts_max_relay_fee_at_exact_ceiling() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    // Exactly at ceiling — should succeed (strict `>` check).
    let ceiling: u128 = 1_000_000_000_000_000_000_000_000_000_000u128;
    client.set_asset_config(&asset_manager, &asset, &true, &1000, &100, &ceiling);
    let cfg = client.get_asset_config(&asset);
    assert_eq!(cfg.max_relay_fee, ceiling);
}

#[test]
fn test_set_asset_config_emits_updated_event_with_max_relay_fee() {
    let env = Env::default();
    let (client, _, _, _, asset_manager) = setup(&env);
    let asset = Address::generate(&env);
    let fee_cap: u128 = 1_000_000u128;
    client.set_asset_config(&asset_manager, &asset, &true, &1000, &100, &fee_cap);
    let expected = AssetConfigUpdated {
        asset,
        enabled: true,
        min_deposit: 1000,
        vetting_fee_bps: 100,
        max_relay_fee: fee_cap,
    };
    let events = env.events().all();
    assert!(
        events.events().contains(&expected.to_xdr(&env, &client.address)),
        "AssetConfigUpdated event must include max_relay_fee",
    );
}

// ── Upgrade freeze-by-rotation (composite, audit R4 LOW-02) ──
//
// The Phase-A trim (d7533b9) removed the dedicated `clear_upgrader` /
// `UpgradeFrozen` mechanism. Freezing upgrades is now expressed by the
// admin rotating the Upgrader role to a burn address via `set_roles`.
// Individual transitions (set_roles auth, upgrade auth) are covered
// elsewhere; this test verifies the composite flow end-to-end.

#[test]
fn test_upgrade_rejects_after_admin_rotates_upgrader() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let keystore = Address::generate(&env);
    let asp_registry = Address::generate(&env);
    client.initialize(&admin, &keystore, &asp_registry, &30, &MAX_STATE_TREE_SIZE);

    let pauser = Address::generate(&env);
    let unpauser = Address::generate(&env);
    let asset_manager = Address::generate(&env);
    let upgrader_a = Address::generate(&env);
    client.set_roles(&admin, &pauser, &unpauser, &asset_manager, &upgrader_a);

    // Admin rotates Upgrader to a fresh address, simulating the burn-address
    // freeze model. No one controls the new address, so upgrades are
    // effectively disabled — but the previously-valid `upgrader_a` is the
    // one whose continued access we want to rule out here.
    let burn_address = Address::generate(&env);
    client.set_roles(&admin, &pauser, &unpauser, &asset_manager, &burn_address);

    // The previously-valid upgrader can no longer upgrade — the pool
    // checks stored Upgrader against `caller` and errors NotAuthorized (#1).
    let wasm_hash = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let r = client.try_upgrade(&upgrader_a, &wasm_hash);
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "expected Error::NotAuthorized from this call specifically, got {:?}",
        r
    );
}


// ── state-tree capacity: the OTHER half of the boundary (MOL-7) ──
//
// Closes relaxation-sweep survivors at lib.rs:895 (deposit) and :1604
// (ragequit). Both guards are `new_size > max_state_tree_size`, and both
// SURVIVED `>` -> `>=` — meaning filling the tree to EXACTLY the cap could be
// rejected and no test noticed.
//
// `test_state_tree_cap_enforced_on_deposit` above looks like it covers this,
// but it cannot: it is a `#[should_panic(expected = "#33")]` test whose FIRST
// deposit is the exactly-at-cap case. Under `>=` that first deposit panics with
// the very same #33, `should_panic` matches, and the test passes at the wrong
// line — its `assert_eq!(tree_size, 1)` never runs. A should_panic test proves
// only that SOMETHING raised that code, not which call did.
//
// So the exactly-at-cap case needs a test that must SUCCEED.

#[test]
fn test_deposit_filling_tree_to_exactly_cap_is_accepted() {
    let env = Env::default();
    let (client, admin, asset_manager, _upgrader) = setup_capped_pool(&env, 1); // cap = 1
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    // new_tree_size == max_state_tree_size == 1 — the cap is INCLUSIVE.
    do_deposit(&env, &client, &depositor, &asset, 10_000, 42);
    assert_eq!(
        client.tree_size(),
        1,
        "a deposit that fills the tree to exactly the cap must succeed"
    );
}

#[test]
fn test_ragequit_filling_tree_to_exactly_cap_is_accepted() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &2, &0, &0, &dummy_vk(&env, 7));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let deposit_value: u128 = 50_000;
    let commitment = do_deposit(&env, &client, &depositor, &asset, deposit_value, 42);

    let owner = Address::generate(&env);
    ks_client.set_auth_policy(&owner, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Tighten the cap so the ragequit's nullifier leaf lands EXACTLY on it.
    // Written directly to storage because setup_with_contracts does not return
    // the upgrader; this mirrors the fake-root injection used elsewhere here.
    let tree_size_before = client.tree_size();
    let exact_cap = tree_size_before + 1;
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::MaxStateTreeSize, &exact_cap);
    });

    // Ragequit is the EMERGENCY EXIT. A one-sided cap here would block the last
    // legal exit at the boundary — which is why upstream flagged the identical
    // shape on EVM (PoolVault, three one-sided StateTreeFull caps, one on
    // ragequit). This asserts the boundary is inclusive.
    client.ragequit(
        &owner,
        &dummy_proof(&env),
        &U256::from_u32(&env, 888),
        &commitment,
        &ks_root,
        &deposit_value,
        &soroban_v2_utils::encode_token_id(&env, &asset),
        &U256::from_u32(&env, 777),
        &asset,
    );

    assert_eq!(
        client.tree_size(),
        exact_cap,
        "a ragequit that fills the tree to exactly the cap must succeed — \
         the emergency exit must not be blocked at the boundary"
    );
}

/// Closes the NEUTER survivor at lib.rs:1604 — the cap on ragequit was
/// deletable. The positive test above cannot catch that: removing the guard
/// makes the exactly-at-cap ragequit succeed too. A cap needs both halves.
#[test]
fn test_ragequit_exceeding_tree_cap_is_rejected() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, ks_client, _asp_client, _asp_postman) =
        setup_with_contracts(&env);

    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));
    client.set_vk(&admin, &2, &0, &0, &dummy_vk(&env, 7));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let deposit_value: u128 = 50_000;
    let commitment = do_deposit(&env, &client, &depositor, &asset, deposit_value, 42);

    let owner = Address::generate(&env);
    ks_client.set_auth_policy(&owner, &U256::from_u32(&env, 111), &U256::from_u32(&env, 222));
    let ks_root = ks_client.latest_root();

    // Cap == current size, so the ragequit's nullifier leaf would be one too many.
    let exact_cap = client.tree_size();
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::MaxStateTreeSize, &exact_cap);
    });

    let r = client.try_ragequit(
        &owner,
        &dummy_proof(&env),
        &U256::from_u32(&env, 888),
        &commitment,
        &ks_root,
        &deposit_value,
        &soroban_v2_utils::encode_token_id(&env, &asset),
        &U256::from_u32(&env, 777),
        &asset,
    );
    assert!(
        matches!(r, Err(Ok(Error::StateTreeFull))),
        "a ragequit that would exceed the tree cap must be rejected"
    );
}

/// Closes the NEUTER survivor at lib.rs:433. A zero state-tree capacity would
/// let the tree accept inserts the circuit cannot prove.
#[test]
fn test_initialize_rejects_zero_max_state_tree_size() {
    let env = Env::default();
    env.mock_all_auths();
    let pool_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &pool_id);
    let r = client.try_initialize(
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
        &30u32,
        &0u32, // max_state_tree_size = 0
    );
    assert!(
        matches!(r, Err(Ok(Error::InvalidMaxTreeSize))),
        "max_state_tree_size == 0 must be rejected at initialize"
    );
}

/// Closes both relaxation survivors on lib.rs:1174
/// (`if n < 1 || n > 5 || m < 1 || m > 5`).
///
/// Every existing NxM test asserts that an OUT-OF-RANGE value is rejected
/// (n=0, n=6, m=0). Nothing asserted that the maximum LEGAL value is accepted,
/// so degrading `n > 5` to `n >= 5` rejected a 5x5 transact and the whole suite
/// stayed green — despite 5x5 being a supported configuration with its own
/// real-proof fixture.
///
/// Per MOL-8 this compound condition is four independent sites; per MOL-7 each
/// needs the MAX case proven to pass, not just MAX+1 proven to fail.
///
/// The call still fails later at proof verification (dummy VK), which is fine:
/// the assertion is that it does NOT fail with InvalidNxM. Reaching proof
/// verification at all proves the bounds check let 5x5 through.
///
/// CAUTION — `InvalidNxM` (#19) is raised from THREE different checks in
/// `transact`: the n/m range (lib.rs:1175), the nullifier/commitment vector
/// lengths (:1178), and `note_data.len() != m` (:1181). A test asserting #19
/// cannot tell which one fired, so every argument here must be shaped for a
/// genuine 5x5 call or the test silently probes the wrong guard. The first
/// draft of this test passed a 1-element note vector and failed at :1181,
/// looking exactly like a 5x5 rejection at :1175.
#[test]
fn test_transact_accepts_max_legal_nxm_5x5() {
    let env = Env::default();
    let (client, _, _, _, _, _, _, _) = setup_with_contracts(&env);

    let five = |seed: u32| -> Vec<U256> {
        soroban_sdk::vec![
            &env,
            U256::from_u32(&env, seed),
            U256::from_u32(&env, seed + 1),
            U256::from_u32(&env, seed + 2),
            U256::from_u32(&env, seed + 3),
            U256::from_u32(&env, seed + 4),
        ]
    };

    let r = client.try_transact(
        &Address::generate(&env),
        &true,
        &5, // n = 5, the maximum legal value
        &5, // m = 5, the maximum legal value
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &0u128,
        &U256::from_u32(&env, 0),
        &five(100),
        &five(200),
        &Address::generate(&env),
        &empty_note_vec_n(&env, 5), // note_data.len() must equal m
        &Bytes::new(&env),
    );
    // Asserted POSITIVELY. "did not fail with InvalidNxM" passes on ANY other error — including an
    // uninitialised pool or a setup mistake — so it cannot distinguish "the bounds check stayed
    // silent" from "nothing reached it". A well-formed 5x5 call gets as far as the root check, and
    // `UnknownRoot` is the proof it cleared the NxM bounds: MEASURED, not assumed.
    assert!(
        matches!(r, Err(Ok(Error::UnknownRoot))),
        "5x5 is supported and must clear the NxM bounds to reach the root check, got {:?}",
        r
    );
}

// ── REAL-PROOF transact (closes the post-verification coverage gap) ──
//
// Everything after proof verification at lib.rs:1261 — the duplicate-commitment
// guards, the state-tree cap, nullifier insertion, the state transition — was
// unreachable from the unit suite, because a dummy VK always fails
// verification first. Three mutation survivors sat behind that wall
// (agents/mutation/FINDINGS_r1.md: :1295, :1319, :1391), and their only real
// coverage was the network-gated e2e suite, which `cargo test` does not run.
//
// Two things had to change to make a real proof drivable from a unit test:
//
// 1. The fixture's `context` used to be a random field element, so the pool
//    always rejected it with ProofContextMismatch. It is now computed the way
//    the contract computes it, in PERMISSIONLESS mode — where the processor
//    contributes 32 zero bytes rather than a runtime-generated contract
//    address, which is what makes it reproducible here.
//
// 2. The transfer is INTERNAL (amountOut = 0, tokenIdOut = 0). A withdrawal's
//    tokenIdOut must equal encode_token_id(asset) for a real asset address
//    that a static fixture cannot know. An internal transfer has no asset
//    dependency at all and still exercises the whole post-verification path.

extern crate std;

#[derive(serde::Deserialize)]
struct RpVk {
    alpha: std::string::String,
    beta: std::string::String,
    gamma: std::string::String,
    delta: std::string::String,
    ic: std::vec::Vec<std::string::String>,
}

#[derive(serde::Deserialize)]
struct RpProof {
    a: std::string::String,
    b: std::string::String,
    c: std::string::String,
}

#[derive(serde::Deserialize)]
struct RpFixture {
    vk: RpVk,
    proof: RpProof,
    public_signals: std::vec::Vec<std::string::String>,
}

fn rp_hex(hex: &str) -> std::vec::Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("valid hex"))
        .collect()
}

fn rp_load(name: &str) -> RpFixture {
    let path = std::format!(
        "{}/../../tests/fixtures/{}.json",
        env!("CARGO_MANIFEST_DIR"),
        name
    );
    let data = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| std::panic!("failed to read fixture {}: {}", path, e));
    serde_json::from_str(&data).expect("valid fixture JSON")
}

fn rp_u256(env: &Env, hex: &str) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_slice(env, &rp_hex(hex)))
}

fn rp_vk(env: &Env, f: &RpVk) -> VerificationKeyBytes {
    let mut ic = soroban_sdk::Vec::<BytesN<64>>::new(env);
    for p in &f.ic {
        ic.push_back(BytesN::from_array(
            env,
            &<[u8; 64]>::try_from(rp_hex(p).as_slice()).expect("IC 64 bytes"),
        ));
    }
    VerificationKeyBytes {
        alpha: BytesN::from_array(
            env,
            &<[u8; 64]>::try_from(rp_hex(&f.alpha).as_slice()).expect("alpha 64"),
        ),
        beta: BytesN::from_array(
            env,
            &<[u8; 128]>::try_from(rp_hex(&f.beta).as_slice()).expect("beta 128"),
        ),
        gamma: BytesN::from_array(
            env,
            &<[u8; 128]>::try_from(rp_hex(&f.gamma).as_slice()).expect("gamma 128"),
        ),
        delta: BytesN::from_array(
            env,
            &<[u8; 128]>::try_from(rp_hex(&f.delta).as_slice()).expect("delta 128"),
        ),
        ic,
    }
}

fn rp_proof(env: &Env, f: &RpProof) -> Groth16Proof {
    Groth16Proof {
        a: BytesN::from_array(env, &<[u8; 64]>::try_from(rp_hex(&f.a).as_slice()).expect("A 64")),
        b: BytesN::from_array(env, &<[u8; 128]>::try_from(rp_hex(&f.b).as_slice()).expect("B 128")),
        c: BytesN::from_array(env, &<[u8; 64]>::try_from(rp_hex(&f.c).as_slice()).expect("C 64")),
    }
}

/// Wire a pool + real keystore + real ASP registry so the fixture's roots are
/// all recognised, then run the real-proof internal transfer.
fn rp_setup(
    env: &Env,
) -> (
    PoolContractClient<'static>,
    RpFixture,
    Address,
) {
    env.mock_all_auths();
    let f = rp_load("transact_1x1_internal");

    let admin = Address::generate(env);
    let ks_id = env.register(keystore::KeystoreContract, ());
    keystore::KeystoreContractClient::new(env, &ks_id).initialize(&admin, &1_000_000u64, &1024u32);

    let asp_id = env.register(asp_registry::AspRegistryContract, ());
    let asp_client = asp_registry::AspRegistryContractClient::new(env, &asp_id);
    let postman = Address::generate(env);
    asp_client.initialize(&admin, &postman);

    let pool_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(env, &pool_id);
    client.initialize(&admin, &ks_id, &asp_id, &16u32, &1024u32);

    // Real transact VK for the 1x1 configuration.
    client.set_vk(&admin, &1, &1, &1, &rp_vk(env, &f.vk));

    // The fixture's roots are fixed, so make each authority recognise them.
    let state_root = rp_u256(env, &f.public_signals[2]);
    let ks_root = rp_u256(env, &f.public_signals[3]);
    let asp_root = rp_u256(env, &f.public_signals[4]);

    env.as_contract(&pool_id, || {
        env.storage().persistent().set(&DataKey::Root(0u32), &state_root);
    });
    env.as_contract(&ks_id, || {
        env.storage()
            .instance()
            .set(&keystore::DataKey::CurrentRoot, &ks_root);
    });
    asp_client.update_asp_root(&postman, &asp_root, &Bytes::from_slice(env, b"QmReal"));

    (client, f, Address::generate(env))
}

fn rp_transact(
    env: &Env,
    client: &PoolContractClient,
    f: &RpFixture,
    processor: &Address,
) -> Result<Result<(), soroban_sdk::ConversionError>, Result<Error, soroban_sdk::InvokeError>> {
    client.try_transact(
        processor,
        &false, // permissionless — matches how the fixture's context was computed
        &1,
        &1,
        &rp_proof(env, &f.proof),
        &rp_u256(env, &f.public_signals[2]),
        &rp_u256(env, &f.public_signals[3]),
        &rp_u256(env, &f.public_signals[4]),
        &0u128, // amountOut = 0, internal transfer
        &U256::from_u32(env, 0), // tokenIdOut = 0
        &soroban_sdk::vec![env, rp_u256(env, &f.public_signals[0])],
        &soroban_sdk::vec![env, rp_u256(env, &f.public_signals[1])],
        &Address::generate(env),
        &empty_note_vec(env),
        &Bytes::new(env),
    )
}

#[test]
fn test_real_proof_internal_transact_succeeds() {
    let env = Env::default();
    let (client, f, processor) = rp_setup(&env);
    let tree_before = client.tree_size();

    let r = rp_transact(&env, &client, &f, &processor);
    assert!(
        r.is_ok(),
        "a real 1x1 proof with a contract-computed context must be accepted: {:?}",
        r
    );

    // 1 nullifier + 1 commitment inserted.
    assert_eq!(
        client.tree_size(),
        tree_before + 2,
        "transact must insert one nullifier leaf and one commitment leaf"
    );
}

/// Closes the neuter survivor at the commitment-already-used guard.
/// Reachable only now that a real proof gets past verification.
#[test]
fn test_real_proof_transact_rejects_already_used_commitment() {
    let env = Env::default();
    let (client, f, processor) = rp_setup(&env);
    let commitment = rp_u256(&env, &f.public_signals[1]);

    // Pre-mark the output commitment as already used.
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(commitment.clone()), &true);
    });

    let r = rp_transact(&env, &client, &f, &processor);
    assert!(
        matches!(r, Err(Ok(Error::DuplicateCommitment))),
        "a commitment already present in state must be rejected, got {:?}",
        r
    );
}

/// Closes the neuter survivor on the transact state-tree cap, and its
/// relaxation half. A 1x1 transact inserts TWO leaves (one nullifier, one
/// commitment), so a cap of `tree_size + 1` is one short.
#[test]
fn test_real_proof_transact_rejects_when_tree_would_overflow() {
    let env = Env::default();
    let (client, f, processor) = rp_setup(&env);
    let one_short = client.tree_size() + 1;
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::MaxStateTreeSize, &one_short);
    });

    let r = rp_transact(&env, &client, &f, &processor);
    assert!(
        matches!(r, Err(Ok(Error::StateTreeFull))),
        "a transact whose inserts exceed the cap must be rejected, got {:?}",
        r
    );
}

/// The other half of that boundary (MOL-7): a cap of EXACTLY the resulting size
/// must be accepted. Without this, degrading `>` to `>=` goes unnoticed.
#[test]
fn test_real_proof_transact_accepts_tree_exactly_at_cap() {
    let env = Env::default();
    let (client, f, processor) = rp_setup(&env);
    let exact = client.tree_size() + 2; // one nullifier + one commitment
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::MaxStateTreeSize, &exact);
    });

    let r = rp_transact(&env, &client, &f, &processor);
    assert!(r.is_ok(), "filling the tree to exactly the cap must succeed: {:?}", r);
    assert_eq!(client.tree_size(), exact);
}

#[test]
fn test_is_nullifier_spent_reflects_authoritative_state() {
    let env = Env::default();
    let (client, f, processor) = rp_setup(&env);
    let nullifier = rp_u256(&env, &f.public_signals[0]);

    assert!(
        !client.is_nullifier_spent(&nullifier),
        "an unspent nullifier must read false"
    );

    let r = rp_transact(&env, &client, &f, &processor);
    assert!(r.is_ok(), "real-proof transact should succeed: {:?}", r);

    assert!(
        client.is_nullifier_spent(&nullifier),
        "after a real transact the nullifier must read spent — this is the \
         authoritative read the SDK's REJECTED -> ACTIVE recovery depends on"
    );
}

/// Real-proof 1x2: one input, TWO outputs. Exercises the multi-output path —
/// three leaf insertions (one nullifier + two commitments) rather than two.
#[test]
fn test_real_proof_internal_transact_1x2_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let f = rp_load("transact_1x2_internal");

    let admin = Address::generate(&env);
    let ks_id = env.register(keystore::KeystoreContract, ());
    keystore::KeystoreContractClient::new(&env, &ks_id).initialize(&admin, &1_000_000u64, &1024u32);

    let asp_id = env.register(asp_registry::AspRegistryContract, ());
    let asp_client = asp_registry::AspRegistryContractClient::new(&env, &asp_id);
    let postman = Address::generate(&env);
    asp_client.initialize(&admin, &postman);

    let pool_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &pool_id);
    client.initialize(&admin, &ks_id, &asp_id, &16u32, &1024u32);
    client.set_vk(&admin, &1, &1, &2, &rp_vk(&env, &f.vk));

    // 1x2 signal order: [nullifier, commitment0, commitment1, stateRoot,
    // keystoreRoot, aspRoot, amountOut, tokenIdOut, context]
    let state_root = rp_u256(&env, &f.public_signals[3]);
    let ks_root = rp_u256(&env, &f.public_signals[4]);
    let asp_root = rp_u256(&env, &f.public_signals[5]);

    env.as_contract(&pool_id, || {
        env.storage().persistent().set(&DataKey::Root(0u32), &state_root);
    });
    env.as_contract(&ks_id, || {
        env.storage()
            .instance()
            .set(&keystore::DataKey::CurrentRoot, &ks_root);
    });
    asp_client.update_asp_root(&postman, &asp_root, &Bytes::from_slice(&env, b"QmReal12"));

    let before = client.tree_size();
    let r = client.try_transact(
        &Address::generate(&env),
        &false,
        &1,
        &2,
        &rp_proof(&env, &f.proof),
        &state_root,
        &ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &soroban_sdk::vec![&env, rp_u256(&env, &f.public_signals[0])],
        &soroban_sdk::vec![
            &env,
            rp_u256(&env, &f.public_signals[1]),
            rp_u256(&env, &f.public_signals[2])
        ],
        &Address::generate(&env),
        &empty_note_vec_n(&env, 2),
        &Bytes::new(&env),
    );
    assert!(r.is_ok(), "real 1x2 proof must be accepted: {:?}", r);
    assert_eq!(
        client.tree_size(),
        before + 3,
        "1x2 inserts one nullifier leaf and two commitment leaves"
    );
}

// The NotInitialized path on the two getters added this branch. Every other
// getter in this file has one; these were missed.
#[test]
fn test_keystore_getter_rejects_not_initialized() {
    let env = Env::default();
    let client = PoolContractClient::new(&env, &env.register(PoolContract, ()));
    assert!(matches!(client.try_keystore(), Err(Ok(Error::NotInitialized))));
}

#[test]
fn test_root_history_size_getter_rejects_not_initialized() {
    let env = Env::default();
    let client = PoolContractClient::new(&env, &env.register(PoolContract, ()));
    assert!(matches!(
        client.try_root_history_size(),
        Err(Ok(Error::NotInitialized))
    ));
}

/// Closes the LAST mutation survivor: the within-transaction
/// duplicate-commitment guard (`if ci == cj`).
///
/// It sits AFTER proof verification, so simply passing duplicated commitments
/// fails verification first — reaching it requires a proof whose circuit output
/// genuinely contains the collision. `transact_1x2_dup` is generated with both
/// outputs sharing a recipient, secret and value, so their commitments are
/// identical, and snarkjs verifies the proof.
///
/// That the circuit ACCEPTS such a proof is the point: the guard is real
/// defence, not dead code. Without it the same commitment would be inserted
/// into the state tree twice.
#[test]
fn test_real_proof_transact_rejects_duplicate_commitments_within_one_tx() {
    let env = Env::default();
    env.mock_all_auths();
    let f = rp_load("transact_1x2_dup");

    // 1x2 signal order: [nullifier, commitment0, commitment1, stateRoot,
    // keystoreRoot, aspRoot, amountOut, tokenIdOut, context]
    let c0 = rp_u256(&env, &f.public_signals[1]);
    let c1 = rp_u256(&env, &f.public_signals[2]);
    assert_eq!(c0, c1, "fixture precondition: the two commitments must collide");

    let admin = Address::generate(&env);
    let ks_id = env.register(keystore::KeystoreContract, ());
    keystore::KeystoreContractClient::new(&env, &ks_id).initialize(&admin, &1_000_000u64, &1024u32);
    let asp_id = env.register(asp_registry::AspRegistryContract, ());
    let asp_client = asp_registry::AspRegistryContractClient::new(&env, &asp_id);
    let postman = Address::generate(&env);
    asp_client.initialize(&admin, &postman);

    let pool_id = env.register(PoolContract, ());
    let client = PoolContractClient::new(&env, &pool_id);
    client.initialize(&admin, &ks_id, &asp_id, &16u32, &1024u32);
    client.set_vk(&admin, &1, &1, &2, &rp_vk(&env, &f.vk));

    let state_root = rp_u256(&env, &f.public_signals[3]);
    let ks_root = rp_u256(&env, &f.public_signals[4]);
    let asp_root = rp_u256(&env, &f.public_signals[5]);
    env.as_contract(&pool_id, || {
        env.storage().persistent().set(&DataKey::Root(0u32), &state_root);
    });
    env.as_contract(&ks_id, || {
        env.storage()
            .instance()
            .set(&keystore::DataKey::CurrentRoot, &ks_root);
    });
    asp_client.update_asp_root(&postman, &asp_root, &Bytes::from_slice(&env, b"QmDup"));

    let before = client.tree_size();
    let r = client.try_transact(
        &Address::generate(&env),
        &false,
        &1,
        &2,
        &rp_proof(&env, &f.proof),
        &state_root,
        &ks_root,
        &asp_root,
        &0u128,
        &U256::from_u32(&env, 0),
        &soroban_sdk::vec![&env, rp_u256(&env, &f.public_signals[0])],
        &soroban_sdk::vec![&env, c0, c1],
        &Address::generate(&env),
        &empty_note_vec_n(&env, 2),
        &Bytes::new(&env),
    );

    assert!(
        matches!(r, Err(Ok(Error::DuplicateCommitment))),
        "a VALID proof carrying two identical output commitments must still be \
         rejected — the circuit permits the collision, so the contract is the \
         only thing stopping a double insert. Got {:?}",
        r
    );
    assert_eq!(client.tree_size(), before, "nothing may be inserted");
}

// ── CG-1 / CG-2: dependency setters (EVM setKeystore / setAspRegistry) ──
//
// Neither existed until 2026-08-24 — the addresses were written once at
// initialize, so repointing needed a full WASM upgrade. INTL-22 asserted these
// setters existed and were role-gated; they did not exist at all.

#[test]
fn test_set_keystore_repoints_and_emits() {
    let env = Env::default();
    let (client, _admin, _am, upgrader) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);
    let new_ks = Address::generate(&env);
    client.set_keystore(&upgrader, &new_ks);
    assert_eq!(client.keystore(), new_ks);
}

#[test]
fn test_set_asp_registry_repoints_and_is_readable() {
    let env = Env::default();
    let (client, _admin, _am, upgrader) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);
    let new_asp = Address::generate(&env);
    client.set_asp_registry(&upgrader, &new_asp);
    assert_eq!(client.asp_registry(), new_asp);
}

/// Gated on the UPGRADER, not the admin — repointing a dependency can freeze
/// transact and ragequit pool-wide (INTL-22), so it belongs behind the
/// timelocked role.
#[test]
fn test_set_keystore_rejects_non_upgrader() {
    let env = Env::default();
    let (client, admin, _am, _upgrader) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);
    let r = client.try_set_keystore(&admin, &Address::generate(&env));
    assert!(
        matches!(r, Err(Ok(Error::NotAuthorized))),
        "even the admin must not repoint the keystore — upgrader only"
    );
}

#[test]
fn test_set_asp_registry_rejects_non_upgrader() {
    let env = Env::default();
    let (client, admin, _am, _upgrader) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);
    let r = client.try_set_asp_registry(&admin, &Address::generate(&env));
    assert!(matches!(r, Err(Ok(Error::NotAuthorized))));
}

#[test]
fn test_dependency_setters_reject_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let client = PoolContractClient::new(&env, &env.register(PoolContract, ()));
    let who = Address::generate(&env);
    assert!(matches!(
        client.try_set_keystore(&who, &Address::generate(&env)),
        Err(Ok(Error::NotInitialized))
    ));
    assert!(matches!(
        client.try_asp_registry(),
        Err(Ok(Error::NotInitialized))
    ));
}

// ── CG-4: spend/creation timestamps and the paused getter ──
//
// EVM stores block.timestamp in spentNullifiers/commitments; this port stored a
// bare `true` and discarded it. The timestamp is load-bearing — upstream uses it
// so a user can collect yield accrued on a commitment AFTER spending it, which
// matters now that lending is in scope.

#[test]
fn test_nullifier_spent_at_records_the_ledger_timestamp() {
    let env = Env::default();
    env.ledger().set_timestamp(1_700_000_000);
    let (client, f, processor) = rp_setup(&env);
    let nullifier = rp_u256(&env, &f.public_signals[0]);

    assert_eq!(
        client.nullifier_spent_at(&nullifier),
        None,
        "an unspent nullifier has no timestamp"
    );

    assert!(rp_transact(&env, &client, &f, &processor).is_ok());

    assert_eq!(
        client.nullifier_spent_at(&nullifier),
        Some(1_700_000_000),
        "the spend must record WHEN, not merely THAT — yield accrual depends on it"
    );
    assert!(client.is_nullifier_spent(&nullifier), "the boolean view still works");
}

#[test]
fn test_commitment_created_at_records_the_ledger_timestamp() {
    let env = Env::default();
    env.ledger().set_timestamp(1_700_000_500);
    let (client, f, processor) = rp_setup(&env);
    let commitment = rp_u256(&env, &f.public_signals[1]);

    assert_eq!(client.commitment_created_at(&commitment), None);
    assert!(rp_transact(&env, &client, &f, &processor).is_ok());
    assert_eq!(client.commitment_created_at(&commitment), Some(1_700_000_500));
}

#[test]
fn test_is_paused_getter_tracks_pause_state() {
    let env = Env::default();
    let (client, admin, _am, _up) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);
    assert!(!client.is_paused(), "a fresh pool is unpaused");

    let pauser = Address::generate(&env);
    let unpauser = Address::generate(&env);
    let am = Address::generate(&env);
    let up = Address::generate(&env);
    client.set_roles(&admin, &pauser, &unpauser, &am, &up);

    client.pause(&pauser);
    assert!(client.is_paused());
    client.unpause(&unpauser);
    assert!(!client.is_paused());
}

// ---- CG-4: the last three EVM getters (current_root_index, root_at, get_vk) ----

#[test]
fn test_current_root_index_getter_rejects_not_initialized() {
    let env = Env::default();
    let client = PoolContractClient::new(&env, &env.register(PoolContract, ()));
    assert!(matches!(
        client.try_current_root_index(),
        Err(Ok(Error::NotInitialized))
    ));
}

#[test]
fn test_root_at_getter_rejects_not_initialized() {
    let env = Env::default();
    let client = PoolContractClient::new(&env, &env.register(PoolContract, ()));
    assert!(matches!(client.try_root_at(&0), Err(Ok(Error::NotInitialized))));
}

/// `root_at` distinguishes an unwritten slot from one holding root zero.
///
/// EVM's `roots(i)` mapping returns 0 for both, so a caller walking a
/// partially-filled ring buffer cannot tell "nothing here yet" from "the root
/// is zero". Returning `Option` is the deviation, and it is the point of the
/// getter: an indexer needs to know where the real history ends.
///
/// Note `initialize` seeds NO root here — unlike EVM, which writes an initial
/// empty-tree root at construction. A freshly initialized pool therefore has an
/// entirely empty ring, and `latest_root` reports NotInitialized until the first
/// deposit. Asserted rather than assumed, because a getter walking this buffer
/// has to handle it.
#[test]
fn test_root_at_reports_unwritten_slots_as_none() {
    let env = Env::default();
    let (client, ..) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);

    for idx in 0..30u32 {
        assert_eq!(client.root_at(&idx), None, "slot {idx} was never written");
    }
    assert!(matches!(
        client.try_latest_root(),
        Err(Ok(Error::NotInitialized))
    ));
    assert_eq!(client.current_root_index(), 0);
}

/// Out-of-range asks are answered `None`, not an error — "no root there" is the
/// honest answer, and an indexer probing past the end should not have to
/// distinguish a failure from an empty slot.
#[test]
fn test_root_at_returns_none_past_the_end_of_the_buffer() {
    let env = Env::default();
    let (client, ..) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);
    assert_eq!(client.root_at(&30), None, "index == size is out of range");
    assert_eq!(client.root_at(&u32::MAX), None);
}

/// The index advances as roots are recorded, and the two getters agree: the
/// most recent root sits at `current_root_index - 1`, because `record_root`
/// writes at the current slot and *then* advances. Getting that off by one is
/// exactly the mistake this pairing exists to prevent.
#[test]
fn test_current_root_index_advances_and_pairs_with_root_at() {
    let env = Env::default();
    let (client, admin, asset_manager, _up) = setup_capped_pool(&env, MAX_STATE_TREE_SIZE);
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    do_deposit(&env, &client, &depositor, &asset, 10_000, 42);
    assert_eq!(client.current_root_index(), 1, "first root lands in slot 0");
    assert_eq!(client.root_at(&0), Some(client.latest_root()));
    assert_eq!(client.root_at(&1), None, "slot 1 is next, not yet written");

    do_deposit(&env, &client, &depositor, &asset, 10_000, 43);
    assert_eq!(client.current_root_index(), 2);
    assert_eq!(client.root_at(&1), Some(client.latest_root()));
    assert_ne!(
        client.root_at(&0),
        client.root_at(&1),
        "a second deposit must move the root"
    );
}

/// `get_vk` is a discovery tool: `None` means "this deployment cannot verify
/// that configuration", which a client should learn before building a proof
/// rather than from a failed submission.
#[test]
fn test_get_vk_returns_none_for_an_unregistered_configuration() {
    let env = Env::default();
    let (client, ..) = setup_with_contracts_custom_history(&env, 8);
    // Nothing registers a 5x5 transact key in this fixture.
    assert!(client.get_vk(&1, &5, &5).is_none());
    // Nor a nonsense proof type.
    assert!(client.get_vk(&99, &0, &0).is_none());
}

/// And it returns what was actually stored, keyed by the full (type, n, m)
/// tuple. Asserting only the `None` case would pass against a getter that
/// always returns `None`.
#[test]
fn test_get_vk_returns_the_key_registered_for_that_configuration() {
    let env = Env::default();
    let (client, admin, ..) = setup_with_contracts_custom_history(&env, 8);

    let vk = dummy_vk(&env, 9);
    client.set_vk(&admin, &1, &2, &3, &vk);

    let got = client.get_vk(&1, &2, &3).expect("registered key must be readable");
    assert_eq!(got.alpha, vk.alpha);
    assert_eq!(got.ic.len(), 10, "IC length identifies which key came back (dummy_vk is inclusive)");

    // Neighbouring slots stay empty — the key is the whole tuple, not just the
    // proof type.
    assert!(client.get_vk(&1, &3, &2).is_none());
    assert!(client.get_vk(&0, &2, &3).is_none());
}

// ---- CG-3: atomic deposit + label registration ----

/// Count events emitted by a given contract. The registry's only event on this
/// path is `LabelRegistered`, so its presence is the observable proof that the
/// cross-contract call happened.
fn asp_events(env: &Env, asp: &Address) -> usize {
    env.events().all().filter_by_contract(asp).events().len()
}

/// The label reaches the ASP registry in the same call as the deposit.
///
/// Soroban allows only one Soroban operation per transaction, so a client
/// cannot bundle `deposit` and `register_label` atomically the way EVM's
/// `Entrypoint.deposit` does. Two separate transactions can half-succeed,
/// leaving a funded commitment whose label the ASP never sees.
#[test]
fn test_deposit_with_label_registers_the_label() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, _ks, asp_client, _pm) = setup_with_contracts(&env);
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    let ciphertext = Bytes::from_array(&env, &[0xAB; 32]);
    client.deposit_with_label(
        &depositor,
        &asset,
        &10_000u128,
        &U256::from_u32(&env, 77),
        &dummy_proof(&env),
        &empty_note(&env),
        &ciphertext,
    );

    // Capture BEFORE any further invocation: the test env's event buffer
    // reflects the most recent invocation, so a read-only getter in between
    // silently empties it — which is exactly how this assertion first read 0.
    let registered = asp_events(&env, &asp_client.address);
    assert_eq!(client.tree_size(), 1, "the deposit itself still happens");
    assert_eq!(
        registered,
        1,
        "the ASP registry must have emitted LabelRegistered"
    );
}

/// An empty ciphertext skips registration, exactly as EVM's
/// `if (_aspCiphertext.length != 0)` does — registration is optional on both
/// chains, so this must stay a convenience and not become an obligation.
#[test]
fn test_deposit_with_label_skips_registration_for_an_empty_ciphertext() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, _ks, asp_client, _pm) = setup_with_contracts(&env);
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    client.deposit_with_label(
        &depositor,
        &asset,
        &10_000u128,
        &U256::from_u32(&env, 78),
        &dummy_proof(&env),
        &empty_note(&env),
        &Bytes::new(&env),
    );

    // Captured before tree_size() for the same reason as above — otherwise this
    // reads 0 whether or not the registry was called, and passes either way.
    let registered = asp_events(&env, &asp_client.address);
    assert_eq!(client.tree_size(), 1);
    assert_eq!(registered, 0, "an empty ciphertext must not call the registry");
}

/// A failed deposit registers nothing.
///
/// This holds because the whole invocation rolls back, not because the
/// registration is sequenced after the deposit: moving it before survives this
/// test unchanged. The guarantee being tested is the atomicity of the pair, and
/// that is exactly the guarantee two separate transactions cannot give.
#[test]
fn test_deposit_with_label_registers_nothing_when_the_deposit_fails() {
    let env = Env::default();
    let (client, admin, _, _, asset_manager, _ks, asp_client, _pm) = setup_with_contracts(&env);
    client.set_vk(&admin, &0, &0, &0, &dummy_vk(&env, 4));

    let depositor = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = create_token(&env, &token_admin, &depositor, 1_000_000);
    setup_asset(&env, &client, &asset_manager, &asset);

    // Deposit an unconfigured asset so the deposit leg fails.
    let other = create_token(&env, &token_admin, &depositor, 1_000_000);
    let r = client.try_deposit_with_label(
        &depositor,
        &other,
        &10_000u128,
        &U256::from_u32(&env, 79),
        &dummy_proof(&env),
        &empty_note(&env),
        &Bytes::from_array(&env, &[0xCD; 32]),
    );
    assert!(r.is_err(), "an unconfigured asset must not deposit");

    assert_eq!(
        asp_events(&env, &asp_client.address),
        0,
        "no label may be registered for a failed deposit"
    );
}


/// The field-aliasing double-spend, end to end. Before the canonical-signal check in
/// `verify_groth16`, replaying a spent proof with `nullifier + r` and `commitment + r` was
/// ACCEPTED: the proof verified against the reduced values while the pool keyed state on the raw
/// ones, so the "new" nullifier was unspent. The plain replay is the control.
#[test]
fn test_real_proof_transact_rejects_field_aliased_replay() {
    let env = Env::default();
    let (client, f, processor) = rp_setup(&env);
    // Keep the proof's root inside the history window, as it is on-chain for the next
    // root_history_size updates (rp_setup plants it in slot 0, which the first spend reuses).
    let state_root = rp_u256(&env, &f.public_signals[2]);
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Root(5u32), &state_root);
    });
    assert!(rp_transact(&env, &client, &f, &processor).is_ok(), "first spend must succeed");
    assert!(
        matches!(rp_transact(&env, &client, &f, &processor), Err(Ok(Error::NullifierAlreadySpent))),
        "a plain replay must be refused as already spent"
    );

    let r = U256::from_be_bytes(&env, &Bytes::from_slice(&env, &contract_types::SNARK_SCALAR_FIELD_BYTES));
    let replay = client.try_transact(
        &processor,
        &false,
        &1,
        &1,
        &rp_proof(&env, &f.proof),
        &state_root,
        &rp_u256(&env, &f.public_signals[3]),
        &rp_u256(&env, &f.public_signals[4]),
        &0u128,
        &U256::from_u32(&env, 0),
        &soroban_sdk::vec![&env, rp_u256(&env, &f.public_signals[0]).add(&r)],
        &soroban_sdk::vec![&env, rp_u256(&env, &f.public_signals[1]).add(&r)],
        &Address::generate(&env),
        &empty_note_vec(&env),
        &Bytes::new(&env),
    );
    assert!(
        matches!(replay, Err(Ok(Error::InvalidProof))),
        "a replay with the nullifier and commitment lifted by r must be rejected, got {:?}",
        replay
    );
}
