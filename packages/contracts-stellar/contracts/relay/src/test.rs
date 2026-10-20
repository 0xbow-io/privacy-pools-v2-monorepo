//! Relay contract unit tests.
//!
//! Happy-path end-to-end (real proof + pool.transact + split) is
//! exercised by `scripts/test-relay-e2e.mjs` against a live local
//! Stellar network — we can't run real Groth16 verification in the
//! Soroban test harness without fixture data.
//!
//! The tests here focus on:
//!   - initialization flow (immutability — no setter, no re-init)
//!   - pre-flight checks before the pool CCO (zero withdrawal,
//!     fee > max_relay_fee, fee > amount_out, NotInitialized)
//!   - `encode_routing` determinism
//!
//! All pool-side checks (proof validity, context match, state/ASP roots)
//! are covered by pool's own test suite, so we don't re-cover them here.

use super::*;
use soroban_sdk::Event as _;
extern crate std;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{BytesN, Env};

fn dummy_proof(env: &Env) -> Groth16Proof {
    Groth16Proof {
        a: BytesN::from_array(env, &[1u8; 64]),
        b: BytesN::from_array(env, &[2u8; 128]),
        c: BytesN::from_array(env, &[3u8; 64]),
    }
}

fn dummy_note(env: &Env) -> NoteData {
    NoteData {
        hint: BytesN::from_array(env, &[0u8; 32]),
        data: Bytes::new(env),
    }
}

fn setup_relay(env: &Env) -> (RelayContractClient, Address, Address) {
    env.mock_all_auths();
    // A REAL pool, not a generated address: `initialize` reads
    // `pool.root_history_size()` to enforce the C-2 MAX_BATCH invariant, so a
    // dummy address can no longer be initialized against. Mirrors EVM, whose
    // constructor makes the same cross-contract read.
    let admin = Address::generate(env);
    let pool_id = env.register(pool::PoolContract, ());
    pool::PoolContractClient::new(env, &pool_id).initialize(
        &admin,
        &Address::generate(env),
        &Address::generate(env),
        &16u32,
        &1024u32,
    );
    let relay_id = env.register(RelayContract, ());
    let client = RelayContractClient::new(env, &relay_id);
    client.initialize(&pool_id, &pool_id);
    (client, pool_id.clone(), pool_id)
}

// ── initialize ──

#[test]
fn test_initialize_sets_pool_and_entrypoint() {
    let env = Env::default();
    let (client, pool_addr, entrypoint_addr) = setup_relay(&env);
    assert_eq!(client.pool(), pool_addr);
    assert_eq!(client.entrypoint(), entrypoint_addr);
}

#[test]
fn test_initialize_rejects_double_init() {
    let env = Env::default();
    let (client, _, _) = setup_relay(&env);
    // Attempting a second init must fail — matches EVM's immutable refs
    // (constructor only runs once).
    let another_pool = Address::generate(&env);
    let another_ep = Address::generate(&env);
    let r = client.try_initialize(&another_pool, &another_ep);
    assert!(
        matches!(r, Err(Ok(Error::AlreadyInitialized))),
        "expected Error::AlreadyInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_relay_contract_has_no_upgrade_entrypoint() {
    // This is a compile-time smoke test: if someone adds `pub fn upgrade`
    // to RelayContract, this test will fail to match (we search source).
    // The policy is documented inline in lib.rs; this test encodes it
    // as a source-level invariant so an accidental addition is caught
    // in CI.
    let src = include_str!("lib.rs");
    assert!(
        !src.contains("fn upgrade("),
        "Relay contract must remain immutable (no upgrade entrypoint)."
    );
    assert!(
        !src.contains("fn set_pool(") && !src.contains("fn set_entrypoint("),
        "Relay pool/entrypoint refs must remain immutable (no setters)."
    );
}

// ── relay preflight ──
//
// These tests register the relay but NOT a real pool. The pool cross-contract
// call will fail, but since we only care about checks that run BEFORE the
// CCO, we assert on #<error code> panics that fire in the preflight block.

#[test]
fn test_relay_rejects_zero_withdrawal() {
    let env = Env::default();
    let (client, _, _) = setup_relay(&env);
    let asset = Address::generate(&env);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let r = client.try_relay(
        &recipient.clone(), // relayer = any auth'd address (mock_all_auths)
        &1u32,
        &1u32,
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &0u128, // amount_out = 0 — triggers ZeroWithdrawal (#4)
        &U256::from_u32(&env, 0),
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &asset,
        &soroban_sdk::vec![&env, dummy_note(&env)],
        &PayoutRouting {
            recipient,
            fee_recipient,
            fee_amount: 0,
        },
    );
    assert!(
        matches!(r, Err(Ok(Error::ZeroWithdrawal))),
        "expected Error::ZeroWithdrawal from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_pool_getter_rejects_not_initialized() {
    let env = Env::default();
    let relay_id = env.register(RelayContract, ());
    let client = RelayContractClient::new(&env, &relay_id);
    let r = client.try_pool();
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_entrypoint_getter_rejects_not_initialized() {
    let env = Env::default();
    let relay_id = env.register(RelayContract, ());
    let client = RelayContractClient::new(&env, &relay_id);
    let r = client.try_entrypoint();
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

#[test]
fn test_relay_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let relay_id = env.register(RelayContract, ());
    let client = RelayContractClient::new(&env, &relay_id);
    let asset = Address::generate(&env);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let r = client.try_relay(
        &recipient.clone(), // relayer = any auth'd address (mock_all_auths)
        &1u32,
        &1u32,
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &100u128,
        &U256::from_u32(&env, 0),
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &asset,
        &soroban_sdk::vec![&env, dummy_note(&env)],
        &PayoutRouting {
            recipient,
            fee_recipient,
            fee_amount: 10,
        },
    );
    assert!(
        matches!(r, Err(Ok(Error::NotInitialized))),
        "expected Error::NotInitialized from this call specifically, got {:?}",
        r
    );
}

// ── encode_routing ──

#[test]
fn test_encode_routing_is_deterministic() {
    let env = Env::default();
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let r1 = PayoutRouting {
        recipient: recipient.clone(),
        fee_recipient: fee_recipient.clone(),
        fee_amount: 123u128,
    };
    let r2 = r1.clone();
    let a = encode_routing(&env, &r1);
    let b = encode_routing(&env, &r2);
    assert_eq!(a.len(), b.len());
    // Length: 56 (recipient strkey) + 56 (fee strkey) + 16 (fee LE) = 128
    assert_eq!(a.len(), 128);
}

#[test]
fn test_encode_routing_sensitive_to_recipient() {
    let env = Env::default();
    let fee_recipient = Address::generate(&env);
    let rec1 = Address::generate(&env);
    let rec2 = Address::generate(&env);
    let a = encode_routing(
        &env,
        &PayoutRouting {
            recipient: rec1,
            fee_recipient: fee_recipient.clone(),
            fee_amount: 100u128,
        },
    );
    let b = encode_routing(
        &env,
        &PayoutRouting {
            recipient: rec2,
            fee_recipient,
            fee_amount: 100u128,
        },
    );
    assert_ne!(
        a, b,
        "distinct recipients must produce distinct processor_data"
    );
}

#[test]
fn test_encode_routing_sensitive_to_fee_amount() {
    let env = Env::default();
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let a = encode_routing(
        &env,
        &PayoutRouting {
            recipient: recipient.clone(),
            fee_recipient: fee_recipient.clone(),
            fee_amount: 10u128,
        },
    );
    let b = encode_routing(
        &env,
        &PayoutRouting {
            recipient,
            fee_recipient,
            fee_amount: 11u128,
        },
    );
    assert_ne!(
        a, b,
        "distinct fee amounts must produce distinct processor_data"
    );
}

// ── AssetMismatch (ALIGN-ARCH-R1-02 fix) ──

#[test]
fn test_relay_rejects_asset_mismatch() {
    let env = Env::default();
    let (client, _, _) = setup_relay(&env);
    let asset = Address::generate(&env);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    // token_id_out = 0 is never equal to encode_token_id(random_asset)
    let r = client.try_relay(
        &recipient.clone(), // relayer = any auth'd address (mock_all_auths)
        &1u32,
        &1u32,
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &100u128,
        &U256::from_u32(&env, 0), // deliberately wrong token_id_out
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &asset,
        &soroban_sdk::vec![&env, dummy_note(&env)],
        &PayoutRouting {
            recipient,
            fee_recipient,
            fee_amount: 5,
        },
    );
    assert!(
        matches!(r, Err(Ok(Error::AssetMismatch))),
        "expected Error::AssetMismatch from this call specifically, got {:?}",
        r
    );
}

// ── fee cap: real cross-contract entrypoint (TEST-10: not a mock) ──
//
// The tests above only reach the preflight block, because `setup_relay` wires
// dummy addresses. The fee-cap guard at lib.rs:319 reads the entrypoint's asset
// config over a real cross-contract call, so it can only be exercised against a
// real pool contract. That is also what [TEST-10] requires: this guard must not
// be covered by a mock alone.

/// Register a real pool contract and use it as BOTH pool and entrypoint, then
/// configure `asset` with `max_relay_fee`. Returns (relay client, asset).
fn setup_relay_with_entrypoint(env: &Env, max_relay_fee: u128) -> (RelayContractClient, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let keystore = Address::generate(env);
    let asp = Address::generate(env);

    let pool_id = env.register(pool::PoolContract, ());
    let pool_client = pool::PoolContractClient::new(env, &pool_id);
    pool_client.initialize(&admin, &keystore, &asp, &16u32, &1024u32);
    let _ = &keystore;

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let asset = sac.address();
    pool_client.set_asset_config(&admin, &asset, &true, &1u128, &0u32, &max_relay_fee);

    let relay_id = env.register(RelayContract, ());
    let client = RelayContractClient::new(env, &relay_id);
    client.initialize(&pool_id, &pool_id);
    (client, asset)
}

/// Drive `relay()` with a well-formed preflight so execution reaches the
/// fee-cap check. `token_id_out` is derived from the asset so the asset
/// cross-check at lib.rs:304 passes.
///
/// A macro rather than a fn: the client's `try_*` return type is generated and
/// awkward to name, and naming it wrong is a compile error that says nothing
/// useful about the test.
macro_rules! try_relay_with_fee {
    ($env:expr, $client:expr, $asset:expr, $amount_out:expr, $fee_amount:expr) => {{
        let recipient = Address::generate($env);
        let fee_recipient = Address::generate($env);
        $client.try_relay(
            &recipient.clone(),
            &1u32,
            &1u32,
            &dummy_proof($env),
            &U256::from_u32($env, 0),
            &U256::from_u32($env, 0),
            &U256::from_u32($env, 0),
            &$amount_out,
            &encode_token_id($env, $asset),
            &soroban_sdk::vec![$env, U256::from_u32($env, 1)],
            &soroban_sdk::vec![$env, U256::from_u32($env, 1)],
            $asset,
            &soroban_sdk::vec![$env, dummy_note($env)],
            &PayoutRouting {
                recipient,
                fee_recipient,
                fee_amount: $fee_amount,
            },
        )
    }};
}

// NOTE — cross-contract error-code collision (read before adding tests here).
//
// `try_relay` decodes ANY contract error raised during the call through the
// RELAY error enum, including errors raised by the pool inside the transact
// cross-contract call. The two enums overlap:
//
//     pool #5 NullifierAlreadySpent  <->  relay #5 FeeExceedsMax
//     pool #6 UnknownRoot            <->  relay #6 FeeExceedsWithdrawal
//
// So a relay test whose call reaches the pool CCO cannot assert a bare error
// code and claim it identified the guard. With a dummy proof the pool fails
// with UnknownRoot, which surfaces here as `FeeExceedsWithdrawal`.
//
// The tests below are written around that: they assert on FeeExceedsMax (#5),
// which the pool cannot produce on this path (it fails at root validation, #6,
// before any nullifier check). Boundary tests for the guards at lib.rs:292,
// :359 and :366 need a pool stub that lets `transact` SUCCEED so distribution
// is reachable — filed in agents/mutation/FINDINGS_r1.md rather than written
// as an ambiguous assertion here.

/// The pool cannot raise #5 on this path, so #5 unambiguously means the relay's
/// own fee-cap guard fired.
fn is_fee_exceeds_max<T>(r: &Result<T, Result<Error, soroban_sdk::InvokeError>>) -> bool {
    matches!(r, Err(Ok(Error::FeeExceedsMax)))
}

#[test]
fn test_relay_fee_below_max_passes_fee_cap() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 100);
    let r = try_relay_with_fee!(&env, client, &asset, 1000u128, 50u128);
    assert!(
        !is_fee_exceeds_max(&r),
        "fee below the cap must not trip FeeExceedsMax"
    );
}

/// Closes the relaxation survivor at lib.rs:319 (`>` -> `>=`).
/// A fee EXACTLY equal to the cap must be ACCEPTED. Testing only that an
/// over-cap fee is rejected leaves this case unpinned — that is the recurring
/// `<=`/`<` boundary class.
#[test]
fn test_relay_fee_exactly_at_max_is_accepted() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 100);
    let r = try_relay_with_fee!(&env, client, &asset, 1000u128, 100u128);
    assert!(
        !is_fee_exceeds_max(&r),
        "fee_amount == max_relay_fee must be accepted (the cap is inclusive)"
    );
}

/// Closes the neuter survivor at lib.rs:319 — the guard itself was deletable.
#[test]
fn test_relay_fee_above_max_is_rejected() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 100);
    let r = try_relay_with_fee!(&env, client, &asset, 1000u128, 101u128);
    assert!(
        is_fee_exceeds_max(&r),
        "fee_amount > max_relay_fee must be rejected"
    );
}

/// `max_relay_fee == 0` means UNCAPPED, not "no fee allowed".
/// Ported from v2-monorepo `2cea13ae`; see docs/DEVIATIONS.md INTL-18.
/// Upstream audit finding #200 proposed the opposite reading and was rejected
/// as a false positive — this test pins the sentinel so it cannot be "fixed"
/// back.
#[test]
fn test_max_relay_fee_zero_means_uncapped() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 0);
    let r = try_relay_with_fee!(&env, client, &asset, 1_000_000u128, 999_999u128);
    assert!(
        !is_fee_exceeds_max(&r),
        "max_relay_fee == 0 is the uncapped sentinel; no fee may be rejected by the cap"
    );
}

/// Pins the collision documented above, so that if either error enum is
/// renumbered the ambiguity is re-surfaced rather than silently changing what
/// the tests in this module actually prove.
#[test]
fn test_relay_and_pool_error_codes_collide_on_5_and_6() {
    assert_eq!(Error::FeeExceedsMax as u32, 5);
    assert_eq!(Error::FeeExceedsWithdrawal as u32, 6);
    assert_eq!(pool::Error::NullifierAlreadySpent as u32, 5);
    assert_eq!(pool::Error::UnknownRoot as u32, 6);
}

// Silence unused-crate warnings from dev-deps kept for future integration tests.
#[allow(dead_code)]
fn _keep_pool_dep(_: pool::PoolContract) {}
#[allow(dead_code)]
fn _keep_ks_dep(_: keystore::KeystoreContract) {}
#[allow(dead_code)]
fn _keep_asp_dep(_: asp_registry::AspRegistryContract) {}
#[allow(dead_code)]
fn _keep_token_client(_: TokenClient, _: StellarAssetClient) {}

// ── FeeExceedsWithdrawal (GAP-RELAY-R1-03) ──

#[test]
fn test_relay_rejects_fee_exceeds_withdrawal() {
    let env = Env::default();
    let (client, _, _) = setup_relay(&env);
    let asset = Address::generate(&env);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let r = client.try_relay(
        &recipient.clone(),
        &1u32,
        &1u32,
        &dummy_proof(&env),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &U256::from_u32(&env, 0),
        &100u128, // amount_out
        &U256::from_u32(&env, 0),
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &soroban_sdk::vec![&env, U256::from_u32(&env, 1)],
        &asset,
        &soroban_sdk::vec![&env, dummy_note(&env)],
        &PayoutRouting {
            recipient,
            fee_recipient,
            fee_amount: 101u128, // fee > amount_out
        },
    );
    assert!(
        matches!(r, Err(Ok(Error::FeeExceedsWithdrawal))),
        "expected Error::FeeExceedsWithdrawal from this call specifically, got {:?}",
        r
    );
}

// ── register_and_relay (Phase 4 / A1) ──

/// Like `setup_relay_with_entrypoint`, but wires a REAL keystore contract into
/// the pool so `register_and_relay` can resolve it via `pool.keystore()`.
fn setup_relay_with_keystore(
    env: &Env,
) -> (
    RelayContractClient,
    Address,
    keystore::KeystoreContractClient<'static>,
) {
    // NOT `mock_all_auths()`. In register_and_relay the keystore's
    // `owner.require_auth()` fires inside a NESTED cross-contract call (relay ->
    // keystore), which plain mock_all_auths does not authorize — the call comes
    // back as an opaque `Err(Err(Abort))` that looks like a contract bug.
    env.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(env);
    let asp = Address::generate(env);

    let ks_id = env.register(keystore::KeystoreContract, ());
    let ks_client = keystore::KeystoreContractClient::new(env, &ks_id);
    ks_client.initialize(&admin, &1_000_000u64, &1024u32);

    let pool_id = env.register(pool::PoolContract, ());
    let pool_client = pool::PoolContractClient::new(env, &pool_id);
    pool_client.initialize(&admin, &ks_id, &asp, &16u32, &1024u32);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let asset = sac.address();
    pool_client.set_asset_config(&admin, &asset, &true, &1u128, &0u32, &0u128);

    let relay_id = env.register(RelayContract, ());
    let client = RelayContractClient::new(env, &relay_id);
    client.initialize(&pool_id, &pool_id);
    (client, asset, ks_client)
}

macro_rules! try_register_and_relay {
    ($env:expr, $client:expr, $asset:expr, $owner:expr, $nkh:expr) => {{
        let recipient = Address::generate($env);
        let fee_recipient = Address::generate($env);
        $client.try_register_and_relay(
            &recipient.clone(),
            $owner,
            $nkh,
            &U256::from_u32($env, 222),
            &1u32,
            &1u32,
            &dummy_proof($env),
            &U256::from_u32($env, 0),
            &U256::from_u32($env, 0),
            &U256::from_u32($env, 0),
            &1000u128,
            &encode_token_id($env, $asset),
            &soroban_sdk::vec![$env, U256::from_u32($env, 1)],
            &soroban_sdk::vec![$env, U256::from_u32($env, 2)],
            $asset,
            &soroban_sdk::vec![$env, dummy_note($env)],
            &PayoutRouting {
                recipient,
                fee_recipient,
                fee_amount: 0,
            },
        )
    }};
}

// Registration is ATOMIC with the relay: if the relay leg fails, the
// registration rolls back with it. That is the correct behaviour — the whole
// point of register_and_relay — but it means these tests cannot assert on
// keystore state afterwards, because the dummy proof always fails the relay
// leg. They assert on the OUTCOME instead.
//
// A failed registration surfaces as `Error::RegistrationFailed` (relay #11).
// The relay maps it deliberately: a nested keystore failure would otherwise
// reach the caller as an opaque `Abort`, and the keystore's codes overlap this
// contract's (keystore `AlreadyRegistered` is 4, same as `ZeroWithdrawal`
// here), so neither the abort nor the raw code identifies the failing leg.

fn is_registration_failed<T>(r: &Result<T, Result<Error, soroban_sdk::InvokeError>>) -> bool {
    matches!(r, Err(Ok(Error::RegistrationFailed)))
}

#[test]
fn test_register_and_relay_registers_an_unregistered_owner() {
    let env = Env::default();
    let (client, asset, _ks) = setup_relay_with_keystore(&env);
    let owner = Address::generate(&env);
    let r = try_register_and_relay!(&env, client, &asset, &owner, &U256::from_u32(&env, 111));
    assert!(
        !is_registration_failed(&r),
        "an unregistered owner must be registered, not rejected"
    );
}

/// EVM audit finding L-1 — front-run resilience.
///
/// A third party can watch the pending transaction, replay the registration
/// itself for no gain, and land it first. Without idempotency the bundle then
/// reverts, because registration is one-time per account. Here the owner is
/// already registered with the SAME key, so registration must be SKIPPED and
/// the call must degrade to a plain relay.
#[test]
fn test_register_and_relay_is_idempotent_when_already_registered() {
    let env = Env::default();
    let (client, asset, ks) = setup_relay_with_keystore(&env);
    let owner = Address::generate(&env);
    let nkh = U256::from_u32(&env, 111);

    // The front-runner registers first, directly.
    ks.set_auth_policy(&owner, &nkh, &U256::from_u32(&env, 222));

    let r = try_register_and_relay!(&env, client, &asset, &owner, &nkh);
    assert!(
        !is_registration_failed(&r),
        "an owner already registered with the SAME key must not brick the bundle"
    );
}

/// The discriminating case: proves the idempotency check actually COMPARES the
/// key rather than skipping unconditionally. A different key is a different
/// account state than the caller asked for, and must still fail.
#[test]
fn test_register_and_relay_rejects_a_mismatched_existing_key() {
    let env = Env::default();
    let (client, asset, ks) = setup_relay_with_keystore(&env);
    let owner = Address::generate(&env);

    ks.set_auth_policy(
        &owner,
        &U256::from_u32(&env, 111),
        &U256::from_u32(&env, 222),
    );

    // Ask to register a DIFFERENT nullifying key for the same owner.
    let r = try_register_and_relay!(&env, client, &asset, &owner, &U256::from_u32(&env, 999));
    assert!(
        is_registration_failed(&r),
        "a mismatched existing key must still hit the keystore's one-time guard"
    );
}

// ── relay_batch (Phase 4 / A2) ──

/// Register a pool with an explicit root-history size and initialize a relay
/// against it. Returns `Err` if the relay refuses (audit C-2).
fn try_init_relay_against_history(
    env: &Env,
    history: u32,
) -> Result<Result<(), soroban_sdk::ConversionError>, Result<Error, soroban_sdk::InvokeError>> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let pool_id = env.register(pool::PoolContract, ());
    pool::PoolContractClient::new(env, &pool_id).initialize(
        &admin,
        &Address::generate(env),
        &Address::generate(env),
        &history,
        &1024u32,
    );
    let relay_id = env.register(RelayContract, ());
    RelayContractClient::new(env, &relay_id).try_initialize(&pool_id, &pool_id)
}

/// Audit C-2: MAX_BATCH must be STRICTLY below the pool's root-history size.
/// A batch that can outgrow the ring buffer evicts the shared pre-batch root
/// before the last item validates against it.
#[test]
fn test_initialize_rejects_root_history_not_above_max_batch() {
    let env = Env::default();
    let r = try_init_relay_against_history(&env, MAX_BATCH);
    assert!(
        matches!(r, Err(Ok(Error::RootHistoryTooSmall))),
        "root_history_size == MAX_BATCH must be rejected — the bound is strict"
    );
}

/// The other half of the boundary (MOL-7): the smallest LEGAL history size must
/// be accepted. Without this, tightening `>=` to `>` would go unnoticed.
#[test]
fn test_initialize_accepts_root_history_exactly_one_above_max_batch() {
    let env = Env::default();
    let r = try_init_relay_against_history(&env, MAX_BATCH + 1);
    assert!(
        r.is_ok(),
        "root_history_size == MAX_BATCH + 1 is the smallest legal value and must be accepted"
    );
}

fn batch_item(
    env: &Env,
    asset: &Address,
    recipient: &Address,
    fee_recipient: &Address,
    amount: u128,
) -> BatchItem {
    BatchItem {
        n: 1,
        m: 1,
        proof: dummy_proof(env),
        state_root: U256::from_u32(env, 0),
        keystore_root: U256::from_u32(env, 0),
        asp_root: U256::from_u32(env, 0),
        amount_out: amount,
        token_id_out: encode_token_id(env, asset),
        nullifier_hashes: soroban_sdk::vec![env, U256::from_u32(env, 1)],
        output_commitments: soroban_sdk::vec![env, U256::from_u32(env, 2)],
        note_data: soroban_sdk::vec![env, dummy_note(env)],
        routing: PayoutRouting {
            recipient: recipient.clone(),
            fee_recipient: fee_recipient.clone(),
            fee_amount: 0,
        },
    }
}

#[test]
fn test_relay_batch_rejects_empty_batch() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 0);
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &soroban_sdk::vec![&env]);
    assert!(matches!(r, Err(Ok(Error::EmptyBatch))));
}

#[test]
fn test_relay_batch_rejects_batch_larger_than_max() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 0);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let mut items = Vec::<BatchItem>::new(&env);
    for _ in 0..(MAX_BATCH + 1) {
        items.push_back(batch_item(&env, &asset, &recipient, &fee_recipient, 100));
    }
    // MOL-10: the batch SIZE is the whole point of this test and nothing asserted it. A wrong loop
    // bound leaves the fixture the wrong size, the call still reaches the pool, and the test passes
    // having exercised a different case than its name claims.
    assert_eq!(items.len(), MAX_BATCH + 1, "the fixture must actually be one item OVER the cap");
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(matches!(r, Err(Ok(Error::BatchTooLarge))));
}

/// MOL-7 again: a batch of EXACTLY MAX_BATCH is legal and must not be rejected
/// for its size. It still fails downstream on the dummy proof, which is fine —
/// the assertion is that it is not turned away at the size check.
#[test]
fn test_relay_batch_accepts_exactly_max_batch() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);

    // The fee is loaded on EXACTLY ONE item, as EVM's `_assertNativeBatchSucceeds` does. A batch
    // where every item carries a zero fee never exercises the fee leg at the boundary at all, and
    // the aggregate-fee arithmetic is only interesting when the fee does not come from every item.
    let mut items = Vec::<BatchItem>::new(&env);
    items.push_back(batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 100));
    for _ in 1..(MAX_BATCH) {
        items.push_back(batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 0));
    }
    // MOL-10: the batch SIZE is the whole point of this test. A wrong loop bound leaves the fixture
    // the wrong size and the test passes having exercised a different case than its name claims.
    assert_eq!(items.len(), MAX_BATCH, "the fixture must actually be exactly MAX_BATCH");

    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(r.is_ok(), "a batch of exactly MAX_BATCH must COMPLETE, got {:?}", r);

    let total = 1000i128 * i128::from(MAX_BATCH);
    assert_eq!(
        token.balance(&recipient),
        total - 100,
        "one aggregated payout: every item's withdrawal less the single fee"
    );
    assert_eq!(
        token.balance(&fee_recipient),
        100,
        "the fee carried by one item must be the whole aggregate fee"
    );
}

/// The OTHER branch of the batch's consistency guard.
///
/// `relay_batch` rejects on `item.recipient != reference.recipient || item.fee_recipient !=
/// reference.fee_recipient` — one line, two branches, and only the first was tested. MOL-8: a
/// compound condition is separate scenarios even where the code path coincides. A batch mixing fee
/// recipients pays a stranger out of the aggregate, and the existing mixed-recipient test would not
/// have noticed if that half of the condition were dropped.
///
/// Ported from EVM `test_RelayBatch_WhenAnItemHasADifferentFeeRecipient`.
/// The aggregate `RelayedBatch` event, asserted field by field.
///
/// It was emitted and **no test read it**. EVM pins every field with `vm.expectEmit()` because this
/// event is the only on-chain record of a batch relay — an indexer reconstructing withdrawals, or a
/// relayer reconciling what it submitted, has nothing else to read. A wrong `count`, or totals that
/// disagree with the transfers actually made, would have shipped silently.
///
/// The totals are asserted against the TOKEN BALANCES from the same call rather than against the
/// numbers the test fed in, so the event is checked against what really moved.
#[test]
fn test_relay_batch_event_reports_the_true_aggregate() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let relayer = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);

    let items = soroban_sdk::vec![
        &env,
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 100),
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 500, 50),
    ];
    assert!(client.try_relay_batch(&relayer, &asset, &items).is_ok());
    // Captured IMMEDIATELY. `env.events().all()` reports the most recent invocation only, so any
    // contract call in between — including a `balance` read — clears it. The first version of this
    // test read balances first and asserted against an empty event list.
    let all = env.events().all();
    let events = all.events();

    let paid_recipient = token.balance(&recipient);
    let paid_fee = token.balance(&fee_recipient);
    assert_eq!(paid_recipient, 1350, "(1000-100) + (500-50)");
    assert_eq!(paid_fee, 150, "100 + 50");

    // Constructed from what ACTUALLY MOVED, then matched against the emitted event. Building the
    // expectation from the token balances rather than from the numbers fed in is what makes this an
    // assertion about the contract instead of about the test's own arithmetic.
    let expected = RelayedBatch {
        asset: asset.clone(),
        relayer: relayer.clone(),
        recipient: recipient.clone(),
        recipient_amount: u128::try_from(paid_recipient).unwrap(),
        fee_recipient: fee_recipient.clone(),
        fee_amount: u128::try_from(paid_fee).unwrap(),
        count: 2,
    };
    assert!(
        events.contains(&expected.to_xdr(&env, &client.address)),
        "RelayedBatch must report the true aggregate: {:?}",
        events
    );
}

#[test]
fn test_relay_batch_rejects_mixed_fee_recipients() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 0);
    let recipient = Address::generate(&env);
    let items = soroban_sdk::vec![
        &env,
        batch_item(&env, &asset, &recipient, &Address::generate(&env), 100),
        batch_item(&env, &asset, &recipient, &Address::generate(&env), 100),
    ];
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(
        matches!(r, Err(Ok(Error::InconsistentRecipient))),
        "a batch must not mix FEE recipients either, got {:?}",
        r
    );
}

/// A batch of exactly one item. Ported from EVM `test_RelayBatch_WhenBatchHasASingleItem`.
///
/// The degenerate size, and the one where an aggregation bug hides: with a single item the
/// per-item and aggregate figures coincide, so this is the case that must keep working while
/// `test_relay_batch_aggregates_into_one_payout_per_leg` proves the multi-item behaviour.
#[test]
fn test_relay_batch_accepts_a_single_item() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);
    let items = soroban_sdk::vec![
        &env,
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 100)
    ];
    assert_eq!(items.len(), 1, "the fixture must actually be a single item");

    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(r.is_ok(), "a one-item batch must COMPLETE, got {:?}", r);
    // With one item the per-item and aggregate figures coincide, which is exactly where an
    // aggregation bug hides — `test_relay_batch_aggregates_into_one_payout_per_leg` proves the
    // multi-item case, and this proves the degenerate one still pays correctly.
    assert_eq!(token.balance(&recipient), 900, "1000 - 100");
    assert_eq!(token.balance(&fee_recipient), 100, "the single item's fee");
}

/// `MAX_BATCH - 1`. The third point of the boundary, and the one nobody writes.
///
/// MOL-7 asks for `0`, `1`, `MAX-1` and `MAX`. This file already covers the empty batch (0), a
/// single item (1, above), and exactly `MAX_BATCH`. Without this, a guard degraded from
/// `count > MAX_BATCH` to `count >= MAX_BATCH` is caught, but one degraded the other way — rejecting
/// one item early — is not.
///
/// Ported from EVM `test_RelayBatch_WhenBatchIsMaxBatchMinusOne`.
#[test]
fn test_relay_batch_accepts_max_batch_minus_one() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);

    // The fee is loaded on EXACTLY ONE item, as EVM's `_assertNativeBatchSucceeds` does. A batch
    // where every item carries a zero fee never exercises the fee leg at the boundary at all, and
    // the aggregate-fee arithmetic is only interesting when the fee does not come from every item.
    let mut items = Vec::<BatchItem>::new(&env);
    items.push_back(batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 100));
    for _ in 1..(MAX_BATCH - 1) {
        items.push_back(batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 0));
    }
    // MOL-10: the batch SIZE is the whole point of this test. A wrong loop bound leaves the fixture
    // the wrong size and the test passes having exercised a different case than its name claims.
    assert_eq!(items.len(), MAX_BATCH - 1, "the fixture must actually be one item BELOW the cap");

    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(r.is_ok(), "a batch of one item BELOW the cap must COMPLETE, got {:?}", r);

    let total = 1000i128 * i128::from(MAX_BATCH - 1);
    assert_eq!(
        token.balance(&recipient),
        total - 100,
        "one aggregated payout: every item's withdrawal less the single fee"
    );
    assert_eq!(
        token.balance(&fee_recipient),
        100,
        "the fee carried by one item must be the whole aggregate fee"
    );
}

#[test]
fn test_relay_batch_rejects_mixed_recipients() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 0);
    let fee_recipient = Address::generate(&env);
    let items = soroban_sdk::vec![
        &env,
        batch_item(&env, &asset, &Address::generate(&env), &fee_recipient, 100),
        batch_item(&env, &asset, &Address::generate(&env), &fee_recipient, 100),
    ];
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(
        matches!(r, Err(Ok(Error::InconsistentRecipient))),
        "a batch must not mix destinations"
    );
}

#[test]
fn test_relay_batch_rejects_item_with_foreign_asset() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 0);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let mut foreign = batch_item(&env, &asset, &recipient, &fee_recipient, 100);
    foreign.token_id_out = U256::from_u32(&env, 12345); // not encode_token_id(asset)
    let items = soroban_sdk::vec![
        &env,
        batch_item(&env, &asset, &recipient, &fee_recipient, 100),
        foreign,
    ];
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(matches!(r, Err(Ok(Error::InconsistentAsset))));
}

#[test]
fn test_relay_batch_rejects_zero_amount_item() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 0);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let items = soroban_sdk::vec![
        &env,
        batch_item(&env, &asset, &recipient, &fee_recipient, 0),
    ];
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(matches!(r, Err(Ok(Error::ZeroWithdrawal))));
}

// ── Pool stub: a `transact` that SUCCEEDS, so distribution is reachable ──
//
// The relay's payout logic — the recipient/fee split at lib.rs and its three
// zero-dispatch branches — sits downstream of `pool.transact`. With a real pool
// and a dummy proof, transact always fails first, so those branches were
// unreachable and their mutants SURVIVED.
//
// This stub is deliberately NOT a general-purpose mock: it exists only to let
// the call reach distribution. Everything the relay itself enforces is still
// enforced for real. Per [TEST-10], the guards it stands in front of (the fee
// cap, the asset cross-check, C-2) all have real-pool tests elsewhere in this
// file; this covers the one path a real pool cannot reach in a unit test.

#[soroban_sdk::contract]
pub struct StubPool;

#[soroban_sdk::contractimpl]
impl StubPool {
    /// Configure what `get_asset_config` reports and fund the stub so it can
    /// pay the relay.
    pub fn setup(env: Env, asset: Address, max_relay_fee: u128) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("asset"), &asset);
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("mrf"), &max_relay_fee);
    }

    /// Arm the stub to RE-ENTER `relay()` from inside `transact`.
    ///
    /// The relay sets its reentrancy flag before calling the pool, so a
    /// re-entrant pool is a faithful stand-in for the malicious-SAC scenario the
    /// guard was written for (AUDIT-XCC-R1-01) — and far smaller than
    /// implementing a whole token contract that re-enters on `transfer`.
    pub fn arm_reentry(env: Env, relay: Address, relayer: Address) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("reent"), &relay);
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("reentr"), &relayer);
    }

    /// Mirrors the pool: credits the PROCESSOR (the relay) with `amount_out`,
    /// which is exactly what the real pool does before the relay splits it.
    #[allow(clippy::too_many_arguments)]
    pub fn transact(
        env: Env,
        processor: Address,
        _processor_gated: bool,
        _n: u32,
        _m: u32,
        _proof: Groth16Proof,
        _state_root: U256,
        _keystore_root: U256,
        _asp_root: U256,
        amount_out: u128,
        _token_id_out: U256,
        _nullifier_hashes: Vec<U256>,
        _output_commitments: Vec<U256>,
        asset: Address,
        _note_data: Vec<NoteData>,
        _processor_data: Bytes,
    ) {
        // If armed, re-enter the relay before doing anything else.
        if let Some(relay) = env
            .storage()
            .instance()
            .get::<_, Address>(&soroban_sdk::symbol_short!("reent"))
        {
            // ONE-SHOT: disarm before re-entering, or the nested relay's own
            // pool call re-arms this branch and the stub recurses until the
            // host aborts on call depth — which looks exactly like the guard
            // failing, and is how the first version of this test misreported.
            env.storage()
                .instance()
                .remove(&soroban_sdk::symbol_short!("reent"));
            let inner = RelayContractClient::new(&env, &relay);
            // A nested relay() while the outer one is still executing. Uses
            // try_ and RECORDS the inner error so the test can assert which
            // guard fired — `is_err()` on the outer call cannot tell reentrancy
            // apart from any other abort.
            // A real relayer address, not the relay contract itself: relay()
            // calls `relayer.require_auth()` BEFORE the reentrancy check, so
            // passing a contract address makes the nested call die on auth and
            // never reach the guard under test.
            let nested_relayer: Address = env
                .storage()
                .instance()
                .get(&soroban_sdk::symbol_short!("reentr"))
                .expect("arm_reentry supplies a relayer");
            // Diagnostic: can the stub call the relay AT ALL from inside this
            // frame? If even a trivial getter aborts, the problem is the
            // stub->relay call, not the guard under test.
            let getter_ok = inner.try_pool().is_ok();
            env.storage()
                .instance()
                .set(&soroban_sdk::symbol_short!("getterok"), &getter_ok);

            let nested = inner.try_relay(
                &nested_relayer,
                &1u32,
                &1u32,
                &_proof,
                &_state_root,
                &_keystore_root,
                &_asp_root,
                &amount_out,
                &_token_id_out,
                &_nullifier_hashes,
                &_output_commitments,
                &asset,
                &_note_data,
                &PayoutRouting {
                    recipient: processor.clone(),
                    fee_recipient: processor.clone(),
                    fee_amount: 0,
                },
            );
            let code: u32 = match nested {
                Err(Ok(e)) => e as u32,
                Err(Err(soroban_sdk::InvokeError::Contract(c))) => 100_000 + c,
                Err(Err(soroban_sdk::InvokeError::Abort)) => u32::MAX,
                Ok(_) => 0, // the nested call SUCCEEDED — guard gone
            };
            env.storage()
                .instance()
                .set(&soroban_sdk::symbol_short!("innererr"), &code);
        }

        if amount_out > 0 {
            let amt = i128::try_from(amount_out).expect("amount fits i128");
            token::TokenClient::new(&env, &asset).transfer(
                &env.current_contract_address(),
                &processor,
                &amt,
            );
        }
    }

    pub fn get_asset_config(env: Env, _asset: Address) -> AssetConfigRead {
        AssetConfigRead {
            enabled: true,
            min_deposit_amount: 1,
            vetting_fee_bps: 0,
            accumulated_fees: 0,
            max_relay_fee: env
                .storage()
                .instance()
                .get(&soroban_sdk::symbol_short!("mrf"))
                .unwrap_or(0u128),
        }
    }

    pub fn keystore(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("asset"))
            .expect("setup called")
    }

    pub fn root_history_size(_env: Env) -> u32 {
        16
    }

    /// Error code the nested `relay()` returned: 0 = it SUCCEEDED (the guard is
    /// gone), u32::MAX = aborted for an unrelated reason.
    pub fn getter_ok(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("getterok"))
            .unwrap_or(false)
    }

    pub fn inner_err(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("innererr"))
            .unwrap_or(u32::MAX)
    }
}

/// Relay wired to a StubPool that pays out, plus a funded asset.
fn setup_relay_paying(
    env: &Env,
    max_relay_fee: u128,
    funding: i128,
) -> (RelayContractClient<'static>, Address, Address) {
    env.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let asset = sac.address();

    let stub_id = env.register(StubPool, ());
    StubPoolClient::new(env, &stub_id).setup(&asset, &max_relay_fee);
    StellarAssetClient::new(env, &asset).mint(&stub_id, &funding);

    let relay_id = env.register(RelayContract, ());
    let client = RelayContractClient::new(env, &relay_id);
    client.initialize(&stub_id, &stub_id);
    (client, asset, stub_id)
}

macro_rules! relay_paying {
    ($env:expr, $client:expr, $asset:expr, $recipient:expr, $fee_recipient:expr, $amount:expr, $fee:expr) => {{
        $client.try_relay(
            &Address::generate($env),
            &1u32,
            &1u32,
            &dummy_proof($env),
            &U256::from_u32($env, 0),
            &U256::from_u32($env, 0),
            &U256::from_u32($env, 0),
            &$amount,
            &encode_token_id($env, $asset),
            &soroban_sdk::vec![$env, U256::from_u32($env, 1)],
            &soroban_sdk::vec![$env, U256::from_u32($env, 2)],
            $asset,
            &soroban_sdk::vec![$env, dummy_note($env)],
            &PayoutRouting {
                recipient: $recipient.clone(),
                fee_recipient: $fee_recipient.clone(),
                fee_amount: $fee,
            },
        )
    }};
}

#[test]
fn test_relay_splits_recipient_and_fee() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);

    let r = relay_paying!(
        &env,
        client,
        &asset,
        recipient,
        fee_recipient,
        1000u128,
        250u128
    );
    assert!(
        r.is_ok(),
        "relay should complete through distribution: {:?}",
        r
    );
    assert_eq!(
        token.balance(&recipient),
        750,
        "recipient gets amount_out - fee"
    );
    assert_eq!(
        token.balance(&fee_recipient),
        250,
        "fee recipient gets the fee"
    );
}

/// Closes the relaxation survivor on `fee_amount > amount_out`: a fee EXACTLY
/// equal to the withdrawal is legal and leaves the recipient nothing.
#[test]
fn test_relay_fee_exactly_equal_to_amount_out_is_accepted() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);

    let r = relay_paying!(
        &env,
        client,
        &asset,
        recipient,
        fee_recipient,
        1000u128,
        1000u128
    );
    assert!(r.is_ok(), "fee == amount_out must be accepted: {:?}", r);
    assert_eq!(
        token.balance(&recipient),
        0,
        "nothing left for the recipient"
    );
    assert_eq!(token.balance(&fee_recipient), 1000);
}

/// Closes the relaxation survivors on the two zero-dispatch branches
/// (`recipient_amount > 0` and `fee_amount > 0`): a zero leg must be SKIPPED,
/// not attempted. Degrading either to `>=` makes the contract attempt a
/// zero-value transfer.
#[test]
fn test_relay_zero_fee_pays_only_the_recipient() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);

    let r = relay_paying!(
        &env,
        client,
        &asset,
        recipient,
        fee_recipient,
        1000u128,
        0u128
    );
    assert!(r.is_ok(), "zero-fee relay must succeed: {:?}", r);
    assert_eq!(token.balance(&recipient), 1000);
    assert_eq!(
        token.balance(&fee_recipient),
        0,
        "no fee leg when fee is zero"
    );
}

/// Closes the relaxation survivors on the two payout zero-dispatch branches.
///
/// A zero-value SAC transfer SUCCEEDS silently — which is exactly why relaxing
/// `> 0` to `>= 0` on either leg went unnoticed by a balance assertion: the
/// balances are identical either way. The observable difference is the EVENT.
/// A skipped leg emits nothing; an attempted zero leg emits a spurious transfer
/// that an indexer would count.
///
/// This is the assertion a balance check cannot make, and it is what makes
/// these branches correctness rather than pure gas optimisation.
#[test]
fn test_relay_zero_legs_emit_no_transfer_events() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);

    // fee == amount_out  =>  recipient leg is zero and must be SKIPPED.
    let r = relay_paying!(
        &env,
        client,
        &asset,
        recipient,
        fee_recipient,
        1000u128,
        1000u128
    );
    assert!(r.is_ok());

    let with_zero_leg = env.events().all().events().len();

    // Same relay, but both legs non-zero.
    let env2 = Env::default();
    let (client2, asset2, _stub2) = setup_relay_paying(&env2, 0, 1_000_000);
    let r2 = client2.address.clone();
    let recipient2 = Address::generate(&env2);
    let fee_recipient2 = Address::generate(&env2);
    let _ = r2;
    let ok = relay_paying!(
        &env2,
        client2,
        &asset2,
        recipient2,
        fee_recipient2,
        1000u128,
        250u128
    );
    assert!(ok.is_ok());
    let with_both_legs = env2.events().all().events().len();

    assert!(
        with_zero_leg < with_both_legs,
        "a zero recipient leg must be SKIPPED, not emitted as a zero-value transfer \
         (zero-leg run emitted {} events, both-legs run emitted {})",
        with_zero_leg,
        with_both_legs
    );

    // Mirror case: a zero FEE leg must be skipped too. Same reasoning, other
    // branch — covering only one of the two leaves the other unpinned.
    let env3 = Env::default();
    let (client3, asset3, _stub3) = setup_relay_paying(&env3, 0, 1_000_000);
    let recipient3 = Address::generate(&env3);
    let fee_recipient3 = Address::generate(&env3);
    let ok3 = relay_paying!(
        &env3,
        client3,
        &asset3,
        recipient3,
        fee_recipient3,
        1000u128,
        0u128
    );
    assert!(ok3.is_ok());
    let with_zero_fee = env3.events().all().events().len();

    assert!(
        with_zero_fee < with_both_legs,
        "a zero fee leg must be SKIPPED, not emitted as a zero-value transfer \
         (zero-fee run emitted {} events, both-legs run emitted {})",
        with_zero_fee,
        with_both_legs
    );
}

/// Documents WHY the reentrancy guard's mutant legitimately survives.
///
/// The guard at `relay()` was written for a malicious SAC whose `transfer`
/// re-enters (AUDIT-XCC-R1-01). Trying to trigger it revealed that **Soroban
/// prohibits reentrancy at the host level**: a contract cannot be called while
/// it is already on the call stack, and the attempt aborts before any of the
/// callee's own code runs.
///
/// The evidence is the read-only case below. The stub calls `relay.pool()` — a
/// side-effect-free getter — from inside the relay's own frame, and even THAT
/// aborts. Nothing in the relay's body executes, so the manual `Entered` flag
/// is never consulted and cannot be what rejects the call.
///
/// Consequence for the mutation sweep: the `Error::Reentrancy` guard is an
/// **obviated check** (MOL-5) on this platform — defence-in-depth against
/// something the host already prevents. Its SURVIVED result is correct and must
/// not be scored as a coverage gap. See docs/DEVIATIONS.md INTL-24.
#[test]
fn test_soroban_host_prohibits_reentering_the_relay() {
    let env = Env::default();
    let (client, asset, stub) = setup_relay_paying(&env, 0, 1_000_000);
    let nested_relayer = Address::generate(&env);
    StubPoolClient::new(&env, &stub).arm_reentry(&client.address, &nested_relayer);

    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let r = relay_paying!(
        &env,
        client,
        &asset,
        recipient,
        fee_recipient,
        1000u128,
        0u128
    );
    assert!(r.is_ok(), "outer relay should complete: {:?}", r);

    let sc = StubPoolClient::new(&env, &stub);

    // A read-only getter back into the executing relay is refused by the host.
    assert!(
        !sc.getter_ok(),
        "Soroban should refuse ANY call into a contract already on the stack, \
         including a side-effect-free getter"
    );

    // And the nested relay() is an Abort (host-level), not the contract's own
    // Error::Reentrancy — the guard is never reached.
    assert_eq!(
        sc.inner_err(),
        u32::MAX,
        "a nested relay() must abort at the host boundary, not return \
         Error::Reentrancy — if this ever becomes {} the platform behaviour \
         changed and the manual guard becomes load-bearing",
        Error::Reentrancy as u32
    );
}

// ── relay_batch: per-item guards and payout legs ──
//
// The batch preflight tests above cover size/consistency. These cover the
// per-item fee checks and the aggregate payout, which the full mutation sweep
// flagged as unpinned in the batch path specifically.

fn batch_item_fee(
    env: &Env,
    asset: &Address,
    recipient: &Address,
    fee_recipient: &Address,
    amount: u128,
    fee: u128,
) -> BatchItem {
    let mut it = batch_item(env, asset, recipient, fee_recipient, amount);
    it.routing.fee_amount = fee;
    it
}

#[test]
fn test_relay_batch_rejects_item_fee_exceeding_its_withdrawal() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let items = soroban_sdk::vec![
        &env,
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 100),
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 1001), // fee > amount
    ];
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(matches!(r, Err(Ok(Error::FeeExceedsWithdrawal))));
}

/// Boundary half: a per-item fee EXACTLY equal to that item's withdrawal is
/// legal, mirroring the single-relay path.
#[test]
fn test_relay_batch_item_fee_exactly_equal_to_its_withdrawal_is_accepted() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let items = soroban_sdk::vec![
        &env,
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 1000),
    ];
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(
        r.is_ok(),
        "fee == amount_out must be accepted in a batch too: {:?}",
        r
    );
}

#[test]
fn test_relay_batch_rejects_item_fee_above_the_cap() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 100, 1_000_000); // cap = 100
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let items = soroban_sdk::vec![
        &env,
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 101),
    ];
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(matches!(r, Err(Ok(Error::FeeExceedsMax))));
}

/// Boundary half + the uncapped sentinel, in the batch path.
#[test]
fn test_relay_batch_item_fee_exactly_at_cap_is_accepted() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 100, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let items = soroban_sdk::vec![
        &env,
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 100),
    ];
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(r.is_ok(), "fee == cap must be accepted in a batch: {:?}", r);
}

#[test]
fn test_relay_batch_aggregates_into_one_payout_per_leg() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = TokenClient::new(&env, &asset);
    let items = soroban_sdk::vec![
        &env,
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 100),
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 500, 50),
    ];
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(r.is_ok(), "batch should complete: {:?}", r);
    assert_eq!(token.balance(&recipient), 1350, "(1000-100) + (500-50)");
    assert_eq!(token.balance(&fee_recipient), 150, "100 + 50");
}

/// Closes the batch payout zero-dispatch branches. Same reasoning as the
/// single-relay case: a zero-value transfer succeeds silently, so only the
/// event count distinguishes a skipped leg from an attempted zero one.
#[test]
fn test_relay_batch_zero_legs_emit_no_transfer_events() {
    let env = Env::default();
    let (client, asset, _stub) = setup_relay_paying(&env, 0, 1_000_000);
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    // Whole amount goes to the fee: the recipient leg totals zero.
    let items = soroban_sdk::vec![
        &env,
        batch_item_fee(&env, &asset, &recipient, &fee_recipient, 1000, 1000),
    ];
    assert!(client
        .try_relay_batch(&Address::generate(&env), &asset, &items)
        .is_ok());
    let zero_recipient_leg = env.events().all().events().len();

    // Zero fee: the fee leg totals zero.
    let env2 = Env::default();
    let (client2, asset2, _s2) = setup_relay_paying(&env2, 0, 1_000_000);
    let r2 = Address::generate(&env2);
    let fr2 = Address::generate(&env2);
    let items2 = soroban_sdk::vec![&env2, batch_item_fee(&env2, &asset2, &r2, &fr2, 1000, 0)];
    assert!(client2
        .try_relay_batch(&Address::generate(&env2), &asset2, &items2)
        .is_ok());
    let zero_fee_leg = env2.events().all().events().len();

    // Both legs non-zero.
    let env3 = Env::default();
    let (client3, asset3, _s3) = setup_relay_paying(&env3, 0, 1_000_000);
    let r3 = Address::generate(&env3);
    let fr3 = Address::generate(&env3);
    let items3 = soroban_sdk::vec![&env3, batch_item_fee(&env3, &asset3, &r3, &fr3, 1000, 100)];
    assert!(client3
        .try_relay_batch(&Address::generate(&env3), &asset3, &items3)
        .is_ok());
    let both_legs = env3.events().all().events().len();

    assert!(
        zero_recipient_leg < both_legs,
        "a zero aggregate recipient leg must be skipped ({} vs {})",
        zero_recipient_leg,
        both_legs
    );
    assert!(
        zero_fee_leg < both_legs,
        "a zero aggregate fee leg must be skipped ({} vs {})",
        zero_fee_leg,
        both_legs
    );
}

/// The getter must report the same value the constructor guard enforces —
/// otherwise the deploy-time C-2 cross-check validates a different number than
/// the contract actually uses (DRIFT-1).
#[test]
fn test_max_batch_getter_matches_the_enforced_constant() {
    let env = Env::default();
    let (client, _, _) = setup_relay(&env);
    assert_eq!(client.max_batch(), MAX_BATCH);
    assert_eq!(
        client.max_batch(),
        10,
        "MAX_BATCH is mirrored in scripts/deploy/validate-config.mjs"
    );
}

// ── batch fee cap against a REAL pool ([TEST-10] no-mock-only) ──
//
// The batch fee-cap tests above use StubPool, whose `get_asset_config` echoes
// back whatever `setup()` was handed. The equivalent guard on the SINGLE-relay
// path is tested against a real `pool::PoolContract` with `set_asset_config`
// called for real — the batch path had no such counterpart.
//
// Mutation-kill and mock-only are orthogonal: a stub test kills the same mutant
// a real-pool test would, so the sweep reported this guard closed while it was
// still mock-only. These close that.
//
// These are PASS-1 checks, so they do not need `transact` to succeed.

fn batch_items_with_fee(
    env: &Env,
    asset: &Address,
    amount: u128,
    fee: u128,
) -> soroban_sdk::Vec<BatchItem> {
    let recipient = Address::generate(env);
    let fee_recipient = Address::generate(env);
    soroban_sdk::vec![
        env,
        batch_item_fee(env, asset, &recipient, &fee_recipient, amount, fee)
    ]
}

#[test]
fn test_relay_batch_rejects_item_fee_above_the_cap_real_pool() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 100); // real pool, cap = 100
    let items = batch_items_with_fee(&env, &asset, 1000, 101);
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    assert!(
        matches!(r, Err(Ok(Error::FeeExceedsMax))),
        "a per-item fee above the REAL pool's configured cap must be rejected, got {:?}",
        r
    );
}

#[test]
fn test_relay_batch_item_fee_exactly_at_cap_is_accepted_real_pool() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 100);
    let items = batch_items_with_fee(&env, &asset, 1000, 100);
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    // Positive, not "did not fail with FeeExceedsMax" — see the note on the batch-size tests. The
    // POOL's `UnknownRoot` surfaces as #6 through the relay's enum (these fixtures carry
    // `state_root: 0`), and reaching it is what proves the fee cap let this item through.
    assert!(
        matches!(r, Err(Ok(Error::FeeExceedsWithdrawal))),
        "a per-item fee exactly at the REAL pool's cap must pass (the cap is inclusive), got {:?}",
        r
    );
}

#[test]
fn test_relay_batch_uncapped_sentinel_against_real_pool() {
    let env = Env::default();
    let (client, asset) = setup_relay_with_entrypoint(&env, 0); // 0 = UNCAPPED (INTL-18)
    let items = batch_items_with_fee(&env, &asset, 1_000_000, 999_999);
    let r = client.try_relay_batch(&Address::generate(&env), &asset, &items);
    // Positive, not "did not fail with FeeExceedsMax" — see the note on the batch-size tests. The
    // POOL's `UnknownRoot` surfaces as #6 through the relay's enum (these fixtures carry
    // `state_root: 0`), and reaching it is what proves the fee cap let this item through.
    assert!(
        matches!(r, Err(Ok(Error::FeeExceedsWithdrawal))),
        "max_relay_fee == 0 is the uncapped sentinel on the batch path too, got {:?}",
        r
    );
}

/// CROSS-LANGUAGE GOLDEN VECTOR for `encode_routing`.
///
/// This byte string IS the context binding. The pool recomputes
/// `context = f(processor, processor_data, note_data)` and rejects a mismatch, which is what stops a
/// relayer from rewriting the recipient or the fee. If the SDK and this contract ever disagree by a
/// single byte, every relay fails on chain with an opaque context mismatch — and neither suite would
/// notice, because BOTH sides only tested determinism and sensitivity against themselves. Two
/// implementations each proved self-consistent, and nothing compared them.
///
/// So both languages assert the same literal, and the literal is derived independently from the
/// documented layout — 56 bytes of recipient strkey, 56 of fee-recipient strkey, 16 of little-endian
/// u128 — rather than being whatever one implementation happened to emit. The SDK counterpart is
/// `encodeRouting matches the contract's golden vector` in sdk/test/crypto.test.mjs; changing this
/// vector without changing that one turns one of them red.
#[test]
fn encode_routing_matches_the_cross_language_golden_vector() {
    let env = Env::default();
    // Fixed strkeys, so the vector is reproducible in both languages. `Address::generate` is random
    // and cannot be expressed on the JavaScript side.
    let recipient = Address::from_str(
        &env,
        "GDPH4SB6JJ7BIFEEYYYGMRDOJKMFNIIP7O5AYUZRI3GIPQNEBM266I34",
    );
    let fee_recipient = Address::from_str(
        &env,
        "GCUNOZNC3AS7J3JJOEXUDRP43PJ4ZKM3YVKHIYXEATEOL4CCMRRLOLRA",
    );
    let routing = PayoutRouting {
        recipient: recipient.clone(),
        fee_recipient: fee_recipient.clone(),
        fee_amount: 1_234_567_890_u128,
    };

    let encoded = encode_routing(&env, &routing);

    // Independently constructed from the layout, not copied from the output.
    let mut expected = std::vec::Vec::new();
    expected.extend_from_slice(b"GDPH4SB6JJ7BIFEEYYYGMRDOJKMFNIIP7O5AYUZRI3GIPQNEBM266I34");
    expected.extend_from_slice(b"GCUNOZNC3AS7J3JJOEXUDRP43PJ4ZKM3YVKHIYXEATEOL4CCMRRLOLRA");
    expected.extend_from_slice(&1_234_567_890_u128.to_le_bytes());
    assert_eq!(expected.len(), 128, "56 + 56 + 16");

    let mut actual = std::vec::Vec::new();
    for b in encoded.iter() {
        actual.push(b);
    }
    assert_eq!(
        actual, expected,
        "encode_routing must match the layout the SDK also encodes to"
    );
}


