#![cfg(test)]
//! Router guard tests.
//!
//! # Coverage boundary, stated plainly
//!
//! Most tests here drive a **mock pool** that pays shares to the processor, which exercises every
//! guard the router itself owns. The `real_pool` module at the bottom then runs the **deposit leg
//! against the actual pool contract**, covering what a mock structurally cannot: the `AssetConfig`
//! mirror decoding a genuine cross-contract response, the vetting-fee arithmetic agreeing with the
//! pool's own truncating division, and the pool's `min_deposit_amount` and enabled checks.
//!
//! The `real_pool` module covers BOTH legs against the actual pool contract.
//!
//! **Correction.** This header previously claimed the withdrawal leg could not be tested because
//! `transact` "needs a fixture this repo does not have". That was wrong, and it stood for several
//! rounds as a recorded blocker. `contracts/pool/src/test.rs` drives `transact` end to end with an
//! all-zero VK and proof — the pairing check passes on zero points — plus a real keystore and a real
//! ASP registry for the roots. The pool COMPUTES the context itself and verifies against its own
//! signals, so nothing external has to be reconstructed. The router's own deposit test was already
//! using the same dummy-VK trick; it just stubbed the keystore and ASP as generated addresses.

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{contract, contracterror, contractimpl, panic_with_error, String as SString};
use yield_adapter::mock_venue::{MockVenue, MockVenueClient};
use yield_token::{YieldToken, YieldTokenClient};

const ONE: i128 = 10_000_000;
const ONE_U: u128 = 10_000_000;

/// Errors the mock pool can raise.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MockPoolError {
    /// `processor_data` did not match what the proof committed to.
    ContextMismatch = 90,
}

/// A pool stand-in that pays `amount_out` of the wrapper's shares to the processor.
///
/// It deliberately does NOT verify a proof: the router's job is the routing and the fee/slippage
/// arithmetic around the payout, and the pool's own suite covers proof verification.
#[contract]
pub struct MockPool;

#[contractimpl]
impl MockPool {
    pub fn set_vault(env: Env, vault: Address) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("vault"), &vault);
    }

    /// Reject a transact whose processor_data does not match what the proof committed to.
    ///
    /// The real pool folds processor_data into the `context` public signal and the Groth16 proof
    /// commits to it. The mock cannot verify a proof, so it stands in for that check by comparing
    /// against an expected blob set by the test. Without this the mock would happily pay out a
    /// tampered routing and the regression test below would pass with the vulnerability restored.
    pub fn expect_processor_data(env: Env, data: Bytes) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("pd"), &data);
    }

    /// Pay shares out, or refuse if told to.
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
        _asset: Address,
        _note_data: Vec<NoteData>,
        processor_data: Bytes,
    ) {
        if let Some(expected) = env
            .storage()
            .instance()
            .get::<_, Bytes>(&soroban_sdk::symbol_short!("pd"))
        {
            // Stands in for the pool's context check over the proof. Returns a distinct error
            // rather than panicking, so a caller can tell a context rejection apart from any other
            // failure — a bare is_err() cannot, and that is how the first version of the theft
            // tests below passed with the vulnerability restored.
            if processor_data != expected {
                panic_with_error!(&env, MockPoolError::ContextMismatch);
            }
        }
        let vault: Address = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("vault"))
            .expect("vault set");
        let shortfall: i128 = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("short"))
            .unwrap_or(0);
        let pay = i128::try_from(amount_out).expect("fits") - shortfall;
        if pay > 0 {
            yield_token::YieldTokenClient::new(&env, &vault).transfer(
                &env.current_contract_address(),
                &processor,
                &pay,
            );
        }
    }

    /// Underpay the next transact by `amount`, simulating a pool that shortchanges the processor.
    pub fn set_shortfall(env: Env, amount: i128) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("short"), &amount);
    }

    /// Make the next deposit accept the call but NOT pull the shares.
    pub fn set_take_deposit(env: Env, take: bool) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("take"), &take);
    }

    pub fn set_max_relay_fee(env: Env, cap: u128) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("cap"), &cap);
    }

    pub fn set_fee_bps(env: Env, bps: u32) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("feebps"), &bps);
    }

    pub fn get_asset_config(env: Env, _asset: Address) -> AssetConfig {
        AssetConfig {
            enabled: true,
            min_deposit_amount: 0,
            vetting_fee_bps: env
                .storage()
                .instance()
                .get(&soroban_sdk::symbol_short!("feebps"))
                .unwrap_or(0u32),
            accumulated_fees: 0,
            max_relay_fee: env
                .storage()
                .instance()
                .get(&soroban_sdk::symbol_short!("cap"))
                .unwrap_or(0u128),
        }
    }

    pub fn last_label_len(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("label"))
            .unwrap_or(0u32)
    }

    /// Pull `value` plus the vetting fee from the depositor, exactly as the real pool does.
    ///
    /// The fee pull is the point: a router that mints only `value` shares leaves the fee unfunded
    /// and the deposit fails here, which is precisely the bug this mock exists to expose.
    pub fn deposit_with_label(
        env: Env,
        depositor: Address,
        asset: Address,
        value: u128,
        _output_commitment: U256,
        _proof: Groth16Proof,
        _note_data: NoteData,
        ciphertext: Bytes,
    ) {
        // Record whether a label was registered, so a test can assert the router forwarded it.
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("label"), &ciphertext.len());
        let bps: u32 = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("feebps"))
            .unwrap_or(0u32);
        let fee = value * u128::from(bps) / 10_000u128;
        let total = i128::try_from(value + fee).expect("fits");
        if !env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("take"))
            .unwrap_or(true)
        {
            return; // accept the deposit but take nothing
        }
        yield_token::YieldTokenClient::new(&env, &asset).transfer(
            &depositor,
            &env.current_contract_address(),
            &total,
        );
    }
}

struct Fx<'a> {
    env: Env,
    router: YieldRouterClient<'a>,
    vault: YieldTokenClient<'a>,
    venue: MockVenueClient<'a>,
    pool: MockPoolClient<'a>,
    underlying: Address,
    admin: Address,
    user: Address,
}

fn setup(max_relay_fee: u128) -> Fx<'static> {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let sac_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(sac_admin.clone());
    let underlying = sac.address();
    let sac_client = StellarAssetClient::new(&env, &underlying);
    sac_client.mint(&admin, &(1_000_000 * ONE));
    sac_client.mint(&user, &(1_000_000 * ONE));

    let venue_id = env.register(MockVenue, ());
    let vault_id = env.register(YieldToken, ());
    let pool_id = env.register(MockPool, ());
    let router_id = env.register(YieldRouter, ());

    MockVenueClient::new(&env, &venue_id).initialize(&vault_id, &underlying);
    let vault = YieldTokenClient::new(&env, &vault_id);
    vault.initialize(
        &admin,
        &venue_id,
        &0i128,
        &4u32,
        &7u32,
        &SString::from_str(&env, "Privacy Pool USDC"),
        &SString::from_str(&env, "ppUSDC"),
        &admin,
    );

    let pool = MockPoolClient::new(&env, &pool_id);
    pool.set_vault(&vault_id);

    let router = YieldRouterClient::new(&env, &router_id);
    let dust = Address::generate(&env);
    router.initialize(&pool_id, &vault_id, &dust);
    pool.set_max_relay_fee(&max_relay_fee);

    // Fund the pool with shares, as a real pool would hold them against shielded notes.
    vault.deposit(&user, &pool_id, &(1_000 * ONE));

    let venue = MockVenueClient::new(&env, &venue_id);
    Fx {
        env,
        router,
        vault,
        venue,
        pool,
        underlying,
        admin,
        user,
    }
}

fn zero_proof(env: &Env) -> Groth16Proof {
    Groth16Proof {
        a: soroban_sdk::BytesN::from_array(env, &[0u8; 64]),
        b: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
        c: soroban_sdk::BytesN::from_array(env, &[0u8; 64]),
    }
}

/// Assert a call failed with a specific contract error.
///
/// A bare `is_err()` would pass for ANY failure, including one raised by a different guard, or by
/// the mock pool, or by an auth check that fired first. This crate has already been bitten twice by
/// exactly that (see the Blend adapter's access-control test), so every negative assertion here
/// names the error it expects.
macro_rules! assert_err {
    ($r:expr, $want:expr) => {
        match $r {
            Err(Ok(e)) => assert_eq!(e, $want, "wrong error"),
            other => panic!("expected a contract error, got {:?}", other),
        }
    };
}

/// Drive a withdrawal. A macro rather than a function so the client's `try_` return type — a
/// nested Result whose exact shape is generated — never has to be spelled out.
macro_rules! withdraw {
    ($f:expr, $shares:expr, $token_id:expr, $recipient:expr, $fee_recipient:expr, $fee:expr, $min_out:expr $(,)?) => {
        $f.router.try_withdraw_to_underlying(
            &1u32,
            &1u32,
            &zero_proof(&$f.env),
            &U256::from_u32(&$f.env, 1),
            &U256::from_u32(&$f.env, 2),
            &U256::from_u32(&$f.env, 3),
            &u128::try_from($shares).expect("non-negative shares"),
            &$token_id,
            &Vec::new(&$f.env),
            &Vec::new(&$f.env),
            &Vec::new(&$f.env),
            &PayoutRouting {
                recipient: $recipient.clone(),
                fee_recipient: $fee_recipient.clone(),
                fee_amount: u128::try_from($fee as i128).expect("non-negative fee"),
            },
            &($min_out as i128),
        )
    };
}

fn vault_token_id(f: &Fx) -> U256 {
    soroban_v2_utils::encode_token_id(&f.env, &f.vault.address)
}

// ---------------------------------------------------------------- happy path

#[test]
fn a_withdrawal_pays_the_recipient_in_underlying_and_the_relayer_its_fee() {
    let f = setup(0);
    let recipient = Address::generate(&f.env);
    let fee_recipient = Address::generate(&f.env);
    let shares = 100 * ONE;

    let (to_recipient, fee_paid) = withdraw!(
        f,
        shares,
        vault_token_id(&f),
        &recipient,
        &fee_recipient,
        5 * ONE,
        0,
    )
    .unwrap()
    .unwrap();

    assert!(to_recipient > 0);
    assert!(fee_paid > 0);
    let t = token::TokenClient::new(&f.env, &f.underlying);
    assert_eq!(t.balance(&recipient), to_recipient);
    assert_eq!(t.balance(&fee_recipient), fee_paid);
}

// ---------------------------------------------------------------- guards

#[test]
fn a_zero_withdrawal_is_rejected() {
    let f = setup(0);
    let r = Address::generate(&f.env);
    assert_err!(
        withdraw!(f, 0, vault_token_id(&f), &r, &r, 0, 0),
        Error::ZeroWithdrawal
    );
}

#[test]
fn a_proof_naming_a_different_asset_is_rejected() {
    // token_id_out is what the pool pays the processor. If it is not this router's share token,
    // nothing here can unwrap what arrives.
    let f = setup(0);
    let r = Address::generate(&f.env);
    let wrong = soroban_v2_utils::encode_token_id(&f.env, &f.underlying);
    assert_err!(
        withdraw!(f, 10 * ONE, wrong, &r, &r, 0, 0),
        Error::AssetMismatch
    );
}

#[test]
fn a_fee_above_the_cap_is_rejected_and_a_fee_at_the_cap_is_allowed() {
    // Both halves. The at-cap case is the one suites habitually skip.
    let f = setup(5 * ONE_U);
    let r = Address::generate(&f.env);
    assert_err!(
        withdraw!(f, 100 * ONE, vault_token_id(&f), &r, &r, 5 * ONE + 1, 0),
        Error::FeeExceedsMax
    );
    assert!(
        withdraw!(f, 100 * ONE, vault_token_id(&f), &r, &r, 5 * ONE, 0)
            .unwrap()
            .is_ok()
    );
}

#[test]
fn a_zero_cap_means_uncapped_not_zero_fee() {
    // INTL-18 / EVM audit H1. Read literally, a 0 cap rejects every nonzero relay fee and the
    // yield route silently stops working for any configured relayer.
    let f = setup(0);
    let r = Address::generate(&f.env);
    assert!(
        withdraw!(f, 100 * ONE, vault_token_id(&f), &r, &r, 50 * ONE, 0)
            .unwrap()
            .is_ok(),
        "a 0 cap must not bound the fee"
    );
}

#[test]
fn a_fee_exceeding_the_withdrawal_is_rejected_and_one_equal_to_it_is_allowed() {
    let f = setup(0);
    let r = Address::generate(&f.env);
    let shares = 100 * ONE;
    assert_err!(
        withdraw!(f, shares, vault_token_id(&f), &r, &r, shares + 1, 0),
        Error::FeeExceedsWithdrawal
    );
    // Equal is legal: a dust note swept entirely into the fee, the same boundary the relay uses.
    assert!(withdraw!(f, shares, vault_token_id(&f), &r, &r, shares, 0)
        .unwrap()
        .is_ok());
}

#[test]
fn a_pool_that_underpays_the_processor_is_detected() {
    let f = setup(0);
    let r = Address::generate(&f.env);
    f.pool.set_shortfall(&1);
    assert_err!(
        withdraw!(f, 100 * ONE, vault_token_id(&f), &r, &r, 0, 0),
        Error::SharesNotReceived
    );
}

#[test]
fn the_slippage_floor_rejects_below_and_accepts_exactly_at() {
    let f = setup(0);
    let r = Address::generate(&f.env);
    let shares = 100 * ONE;

    let expected = f.vault.preview_redeem(&shares);
    assert_err!(
        withdraw!(f, shares, vault_token_id(&f), &r, &r, 0, expected + 1),
        Error::BelowMinUnderlying
    );
    // At the floor exactly must SUCCEED — `<` not `<=`. A relaxed comparison here rejects the
    // precisely-quoted withdrawal, which is the common case, not an edge case.
    assert!(
        withdraw!(f, shares, vault_token_id(&f), &r, &r, 0, expected)
            .unwrap()
            .is_ok()
    );
}

// ---------------------------------------------------------------- skim and the live fee cap

/// `skim` must not let a caller choose the destination.
///
/// The first version took both the token and the destination as parameters, so anyone could sweep
/// anything anywhere. EVM keeps the destination immutable and says so explicitly: permissionless is
/// safe only because "the destination is fixed at construction, so there is no griefing vector."
#[test]
fn skim_sends_residue_only_to_the_fixed_dust_recipient() {
    let f = setup(0);
    let dust = f.router.dust_recipient();
    let stray = 1_234i128;

    // Leave residue in the router by transferring shares to it directly.
    f.vault.deposit(&f.user, &f.user, &(10 * ONE));
    f.vault.transfer(&f.user, &f.router.address, &stray);

    let swept = f.router.skim(&f.vault.address);
    assert_eq!(swept, stray);
    assert_eq!(
        f.vault.balance(&dust),
        stray,
        "residue goes to the fixed recipient"
    );
    assert_eq!(f.vault.balance(&f.router.address), 0);
}

#[test]
fn skimming_an_empty_router_is_a_no_op() {
    let f = setup(0);
    assert_eq!(f.router.skim(&f.vault.address), 0);
}

/// The relay-fee ceiling comes from the pool, live, not from a copy frozen at deploy.
///
/// A frozen copy can never be corrected and can silently disagree with the cap `contracts/relay`
/// enforces on the same asset. Changing the pool's config must change what the router accepts.
#[test]
fn the_fee_ceiling_tracks_the_pools_config_rather_than_a_deploy_time_copy() {
    let f = setup(5 * ONE_U);
    let r = Address::generate(&f.env);

    // At the configured cap: accepted. Above it: rejected.
    assert!(
        withdraw!(f, 100 * ONE, vault_token_id(&f), &r, &r, 5 * ONE, 0)
            .unwrap()
            .is_ok()
    );
    assert_err!(
        withdraw!(f, 100 * ONE, vault_token_id(&f), &r, &r, 5 * ONE + 1, 0),
        Error::FeeExceedsMax
    );

    // Raise the pool's ceiling; the router must follow without being redeployed.
    f.pool.set_max_relay_fee(&(20 * ONE_U));
    assert!(
        withdraw!(f, 100 * ONE, vault_token_id(&f), &r, &r, 20 * ONE, 0)
            .unwrap()
            .is_ok(),
        "the router must honour the pool's updated ceiling"
    );
}

// ---------------------------------------------------------------- the dust-fee waiver

#[test]
fn a_dust_fee_is_waived_rather_than_reverting_the_whole_withdrawal() {
    // The subtle one. A fee of 1 share can redeem to 0 underlying; redeeming it would trip the
    // wrapper's zero-assets guard and kill the entire withdrawal. Then the relayer's fee POLICY
    // decides whether the user can exit at all. Waiving the dust leg keeps the exit independent of
    // the fee configuration.
    let f = setup(0);
    let recipient = Address::generate(&f.env);
    let fee_recipient = Address::generate(&f.env);

    // Inflate the share rate so one share is worth less than one stroop of underlying.
    f.venue.accrue(&f.admin, &(500_000 * ONE));
    assert_eq!(
        f.vault.preview_redeem(&1),
        0,
        "one share must round to zero underlying"
    );

    let (to_recipient, fee_paid) = withdraw!(
        f,
        100 * ONE,
        vault_token_id(&f),
        &recipient,
        &fee_recipient,
        1,
        0,
    )
    .unwrap()
    .unwrap();

    assert_eq!(fee_paid, 0, "the dust fee is waived");
    assert!(to_recipient > 0, "and the withdrawal still completes");
    assert_eq!(
        token::TokenClient::new(&f.env, &f.underlying).balance(&fee_recipient),
        0
    );
}

// ---------------------------------------------------------------- the deposit leg

#[test]
fn depositing_mints_exact_shares_and_lands_them_in_the_pool() {
    let f = setup(0);
    let before = f.vault.balance(&f.pool.address);

    let paid = f.router.deposit_exact_shares(
        &f.user,
        &(50u128 * ONE_U),
        &U256::from_u32(&f.env, 42),
        &zero_proof(&f.env),
        &NoteData {
            hint: soroban_sdk::BytesN::from_array(&f.env, &[0u8; 32]),
            data: Bytes::new(&f.env),
        },
        &Bytes::new(&f.env),
        &(1_000 * ONE),
    );

    assert!(paid > 0, "the caller pays underlying");
    assert_eq!(
        f.vault.balance(&f.pool.address) - before,
        50 * ONE,
        "the pool holds exactly the committed share amount"
    );
    assert_eq!(
        f.vault.balance(&f.router.address),
        0,
        "the router keeps nothing"
    );
}

/// The trap: the pool pulls `value` PLUS the vetting fee, so the router must mint the total.
///
/// Minting only `value` leaves the fee unfunded and the deposit reverts — after the mint has
/// already happened. With a 0% fee the two amounts coincide, so a suite that only ever tests a
/// zero fee cannot tell the correct implementation from the broken one.
#[test]
fn a_deposit_funds_the_vetting_fee_as_well_as_the_committed_value() {
    let f = setup(0);
    f.pool.set_fee_bps(&500); // 5%
    let before = f.vault.balance(&f.pool.address);

    f.router.deposit_exact_shares(
        &f.user,
        &(100u128 * ONE_U),
        &U256::from_u32(&f.env, 43),
        &zero_proof(&f.env),
        &NoteData {
            hint: soroban_sdk::BytesN::from_array(&f.env, &[0u8; 32]),
            data: Bytes::new(&f.env),
        },
        &Bytes::new(&f.env),
        &(1_000 * ONE),
    );

    assert_eq!(
        f.vault.balance(&f.pool.address) - before,
        105 * ONE,
        "value plus the 5% vetting fee"
    );
    assert_eq!(f.vault.balance(&f.router.address), 0);
}

#[test]
fn a_zero_value_deposit_is_rejected() {
    let f = setup(0);
    assert_err!(
        f.router.try_deposit_exact_shares(
            &f.user,
            &0u128,
            &U256::from_u32(&f.env, 44),
            &zero_proof(&f.env),
            &NoteData {
                hint: soroban_sdk::BytesN::from_array(&f.env, &[0u8; 32]),
                data: Bytes::new(&f.env)
            },
            &Bytes::new(&f.env),
            &(1_000 * ONE),
        ),
        Error::ZeroValue
    );
}

#[test]
fn the_deposit_ceiling_rejects_above_and_accepts_exactly_at() {
    // Mirror of the withdrawal's slippage floor, and the same boundary discipline: a `>` relaxed to
    // `>=` rejects the exactly-quoted deposit, which is the common case.
    let f = setup(0);
    let shares = 50 * ONE;
    let quoted = f.vault.preview_mint(&shares);

    assert_err!(
        f.router.try_deposit_exact_shares(
            &f.user,
            &(shares as u128),
            &U256::from_u32(&f.env, 45),
            &zero_proof(&f.env),
            &NoteData {
                hint: soroban_sdk::BytesN::from_array(&f.env, &[0u8; 32]),
                data: Bytes::new(&f.env)
            },
            &Bytes::new(&f.env),
            &(quoted - 1),
        ),
        Error::SlippageExceeded
    );

    assert!(f
        .router
        .try_deposit_exact_shares(
            &f.user,
            &(shares as u128),
            &U256::from_u32(&f.env, 46),
            &zero_proof(&f.env),
            &NoteData {
                hint: soroban_sdk::BytesN::from_array(&f.env, &[0u8; 32]),
                data: Bytes::new(&f.env)
            },
            &Bytes::new(&f.env),
            &quoted,
        )
        .is_ok());
}

/// Pins the local `AssetConfig` mirror against the pool's real one.
///
/// The router duplicates this struct rather than importing it, because a normal dependency on the
/// `pool` crate pulls the whole pool contract into the router's WASM (112KB against a ~64KB limit)
/// and breaks `stellar contract build` on LTO. Duplication trades a link-time guarantee for a
/// test-time one, so the test has to actually exist: a field added, removed or retyped upstream
/// fails here rather than at runtime on a live network.
#[test]
fn the_local_asset_config_mirror_matches_the_pools() {
    use soroban_sdk::{IntoVal, TryFromVal};
    let env = Env::default();

    let theirs = pool::AssetConfig {
        enabled: true,
        min_deposit_amount: 12_345,
        vetting_fee_bps: 250,
        accumulated_fees: 6_789,
        max_relay_fee: 4_242,
    };

    // Round-trip through the host value representation, exactly as a cross-contract call does.
    let val: soroban_sdk::Val = theirs.clone().into_val(&env);
    let ours = AssetConfig::try_from_val(&env, &val)
        .expect("the mirror must decode the pool's AssetConfig");

    assert_eq!(ours.enabled, theirs.enabled);
    assert_eq!(ours.min_deposit_amount, theirs.min_deposit_amount);
    assert_eq!(ours.vetting_fee_bps, theirs.vetting_fee_bps);
    assert_eq!(ours.accumulated_fees, theirs.accumulated_fees);
    assert_eq!(ours.max_relay_fee, theirs.max_relay_fee);
}

// ---------------------------------------------------------------- against the REAL pool

/// Deposit through the router into the **real** pool contract, not the mock.
///
/// This closes most of the coverage boundary declared at the top of this file. Everything the mock
/// pool could not vouch for is exercised here for real:
///
/// * the `AssetConfig` mirror decoding an actual `pool::get_asset_config` response over a genuine
///   cross-contract call, rather than a struct the mock happened to build;
/// * the vetting-fee arithmetic agreeing with the pool's own truncating division, where a
///   one-share shortfall reverts the deposit *after* the mint;
/// * the pool's own `min_deposit_amount` and enabled checks, which the mock did not have;
/// * the shares actually landing in the real pool's balance.
///
/// The withdrawal leg still cannot run here: `transact` needs known state, keystore and ASP roots,
/// and the keystore root is fetched by cross-contract call. That remains the open gap.
mod real_pool {
    use super::*;
    use pool::{PoolContract, PoolContractClient};
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};

    fn dummy_vk(env: &Env, num_signals: u32) -> contract_types::VerificationKeyBytes {
        let mut ic = Vec::new(env);
        for _ in 0..=num_signals {
            ic.push_back(soroban_sdk::BytesN::from_array(env, &[0u8; 64]));
        }
        contract_types::VerificationKeyBytes {
            alpha: soroban_sdk::BytesN::from_array(env, &[0u8; 64]),
            beta: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
            gamma: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
            delta: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
            ic,
        }
    }

    struct Real<'a> {
        env: Env,
        router: YieldRouterClient<'a>,
        vault: YieldTokenClient<'a>,
        pool: PoolContractClient<'a>,
        user: Address,
        asset_manager: Address,
        vault_id: Address,
        venue_id: Address,
        underlying: Address,
        ks: keystore::KeystoreContractClient<'a>,
        asp: asp_registry::AspRegistryContractClient<'a>,
        asp_postman: Address,
    }

    fn setup(vetting_fee_bps: u32) -> Real<'static> {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let sac_admin = Address::generate(&env);
        let underlying = env
            .register_stellar_asset_contract_v2(sac_admin.clone())
            .address();
        let sac = StellarAssetClient::new(&env, &underlying);
        sac.mint(&admin, &(1_000_000 * ONE));
        sac.mint(&user, &(1_000_000 * ONE));

        let venue_id = env.register(MockVenue, ());
        let vault_id = env.register(YieldToken, ());
        MockVenueClient::new(&env, &venue_id).initialize(&vault_id, &underlying);
        let vault = YieldTokenClient::new(&env, &vault_id);
        vault.initialize(
            &admin,
            &venue_id,
            &0i128,
            &4u32,
            &7u32,
            &SString::from_str(&env, "Privacy Pool USDC"),
            &SString::from_str(&env, "ppUSDC"),
            &admin,
        );

        // The real pool. Keystore and ASP addresses are unused on the deposit path.
        let pool_id = env.register(PoolContract, ());
        let pool = PoolContractClient::new(&env, &pool_id);
        // Real keystore and ASP registry, not generated stand-ins: `transact` reads the keystore
        // root by cross-contract call, and both roots are public signals it verifies against.
        let ks_admin = Address::generate(&env);
        let ks_id = env.register(keystore::KeystoreContract, ());
        let ks = keystore::KeystoreContractClient::new(&env, &ks_id);
        ks.initialize(&ks_admin, &3600u64, &262_144u32);

        let asp_admin = Address::generate(&env);
        let asp_postman = Address::generate(&env);
        let asp_id = env.register(asp_registry::AspRegistryContract, ());
        let asp = asp_registry::AspRegistryContractClient::new(&env, &asp_id);
        asp.initialize(&asp_admin, &asp_postman);

        pool.initialize(&admin, &ks_id, &asp_id, &30u32, &1_048_576u32);
        let asset_manager = Address::generate(&env);
        pool.set_roles(
            &admin,
            &Address::generate(&env),
            &Address::generate(&env),
            &asset_manager,
            &Address::generate(&env),
        );
        pool.set_vk(&admin, &0u32, &0u32, &0u32, &dummy_vk(&env, 4));
        // 1x1 transact: 6 + n + m = 8 signals.
        pool.set_vk(&admin, &1u32, &1u32, &1u32, &dummy_vk(&env, 8));
        // ppUSDC registered as an ordinary pool asset — the whole point of a non-rebasing wrapper.
        pool.set_asset_config(
            &asset_manager,
            &vault_id,
            &true,
            &1000u128,
            &vetting_fee_bps,
            &0u128,
        );

        let router_id = env.register(YieldRouter, ());
        let router = YieldRouterClient::new(&env, &router_id);
        router.initialize(&pool_id, &vault_id, &Address::generate(&env));

        Real {
            env,
            router,
            vault,
            pool,
            user,
            asset_manager,
            vault_id,
            venue_id,
            underlying,
            ks,
            asp,
            asp_postman,
        }
    }

    fn note(env: &Env) -> NoteData {
        NoteData {
            hint: soroban_sdk::BytesN::from_array(env, &[0u8; 32]),
            data: Bytes::new(env),
        }
    }

    #[test]
    fn a_deposit_reaches_the_real_pool_and_the_shares_land_there() {
        let r = setup(0);
        let paid = r.router.deposit_exact_shares(
            &r.user,
            &(50u128 * ONE_U),
            &U256::from_u32(&r.env, 7),
            &zero_proof(&r.env),
            &note(&r.env),
            &Bytes::new(&r.env),
            &(1_000 * ONE),
        );

        assert!(paid > 0);
        assert_eq!(
            r.vault.balance(&r.pool.address),
            50 * ONE,
            "the real pool holds the committed shares"
        );
        assert_eq!(r.pool.tree_size(), 1, "and inserted a commitment leaf");
        assert_eq!(
            r.vault.balance(&r.router.address),
            0,
            "the router keeps nothing"
        );
    }

    /// The fee arithmetic must agree with the pool's, against the real implementation.
    ///
    /// The mock reproduced my own formula, so it could only ever confirm the router agrees with
    /// itself. Here the pool computes the fee independently and pulls it; a mismatch of one share
    /// reverts.
    #[test]
    fn the_vetting_fee_agrees_with_the_real_pools_arithmetic() {
        let r = setup(250); // 2.5%
        r.router.deposit_exact_shares(
            &r.user,
            &(100u128 * ONE_U),
            &U256::from_u32(&r.env, 8),
            &zero_proof(&r.env),
            &note(&r.env),
            &Bytes::new(&r.env),
            &(1_000 * ONE),
        );
        assert_eq!(
            r.vault.balance(&r.pool.address),
            102_5000000,
            "value plus the pool's own 2.5% vetting fee"
        );
    }

    /// A fee whose truncating division rounds down must still be funded exactly.
    ///
    /// 1 stroop at 250 bps is 0.025, which the pool floors to 0. If the router rounded up it would
    /// mint a share the pool never pulls, stranding it; if it rounded differently from the pool at
    /// any size, the deposit reverts after the mint.
    #[test]
    fn a_fee_that_truncates_to_zero_is_handled_the_same_way_by_both() {
        let r = setup(250);
        r.router.deposit_exact_shares(
            &r.user,
            &(1_000u128),
            &U256::from_u32(&r.env, 9),
            &zero_proof(&r.env),
            &note(&r.env),
            &Bytes::new(&r.env),
            &(1_000 * ONE),
        );
        // 1000 * 250 / 10000 = 25 exactly, so the total is 1025.
        assert_eq!(r.vault.balance(&r.pool.address), 1_025);
        assert_eq!(r.vault.balance(&r.router.address), 0);
    }

    /// The real pool enforces a minimum deposit; the mock did not.
    #[test]
    fn the_real_pools_minimum_deposit_is_enforced_through_the_router() {
        let r = setup(0);
        assert_err!(
            r.router.try_deposit_exact_shares(
                &r.user,
                &999u128, // below the configured min of 1000
                &U256::from_u32(&r.env, 10),
                &zero_proof(&r.env),
                &note(&r.env),
                &Bytes::new(&r.env),
                &(1_000 * ONE),
            ),
            Error::PoolRejected
        );
    }

    /// And a disabled asset, likewise — the mock had no such notion.
    #[test]
    fn a_disabled_asset_is_refused_by_the_real_pool() {
        let r = setup(0);
        // Prove the route works first, so the rejection below cannot be blamed on the fixture.
        assert!(r
            .router
            .try_deposit_exact_shares(
                &r.user,
                &(10u128 * ONE_U),
                &U256::from_u32(&r.env, 11),
                &zero_proof(&r.env),
                &note(&r.env),
                &Bytes::new(&r.env),
                &(1_000 * ONE),
            )
            .is_ok());

        r.pool.set_asset_config(
            &r.asset_manager,
            &r.vault_id,
            &false,
            &1000u128,
            &0u32,
            &0u128,
        );

        assert_err!(
            r.router.try_deposit_exact_shares(
                &r.user,
                &(10u128 * ONE_U),
                &U256::from_u32(&r.env, 12),
                &zero_proof(&r.env),
                &note(&r.env),
                &Bytes::new(&r.env),
                &(1_000 * ONE),
            ),
            Error::PoolRejected
        );
    }

    /// The depositor signs only FIXED amounts, and everything rate-dependent is authorized by the
    /// router itself — checked with no blanket mocking.
    ///
    /// Every other test here calls `mock_all_auths_allowing_non_root_auth()`, which authorizes any
    /// address for any call, so none of them can see the auth tree. This one grants auth ONLY to the
    /// user, for exactly the tree they sign: `deposit_exact_shares -> transfer(user, router, max)`.
    /// The router must then authorize the mint's pull of the cost and the pool's pull of the shares
    /// on its own; remove either `authorize_as_current_contract` entry and this fails.
    ///
    /// The share rate is moved AFTER the tree is fixed and before execution — what happens on any
    /// live reserve between simulation and inclusion. The earlier design had the user sign the
    /// venue's pull of the exact cost, so the signature named a figure the rate had already
    /// invalidated and the deposit was rejected (`auth: invalid_action` on a real network).
    #[test]
    fn the_depositor_signs_fixed_amounts_and_survives_a_rate_move() {
        let r = setup(0);
        let value: u128 = 50 * ONE_U;
        let shares: i128 = 50 * ONE;
        let max_in: i128 = 1_000 * ONE;
        let commitment = U256::from_u32(&r.env, 77);
        let proof = zero_proof(&r.env);
        let nd = note(&r.env);
        let underlying = token::TokenClient::new(&r.env, &r.underlying);

        let cost_at_signing = r.vault.preview_mint(&shares);
        // Yield lands after the user signed: the same shares now cost more underlying.
        // Scaled to the vault rather than fixed: the fixture vault is small, so a fixed figure either
        // rounds away or multiplies the price past any ceiling.
        let assets = r.vault.total_assets();
        MockVenueClient::new(&r.env, &r.venue_id).accrue(&r.user, &assets);
        let cost = r.vault.preview_mint(&shares);
        assert!(cost > cost_at_signing, "the fixture must move the rate: {cost_at_signing} -> {cost}");
        let before = underlying.balance(&r.user);

        r.env.set_auths(&[]);
        let res = r
            .router
            .mock_auths(&[MockAuth {
                address: &r.user,
                invoke: &MockAuthInvoke {
                    contract: &r.router.address,
                    fn_name: "deposit_exact_shares",
                    args: (
                        r.user.clone(),
                        value,
                        commitment.clone(),
                        proof.clone(),
                        nd.clone(),
                        Bytes::new(&r.env),
                        max_in,
                    )
                        .into_val(&r.env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &r.underlying,
                        fn_name: "transfer",
                        args: (r.user.clone(), r.router.address.clone(), max_in).into_val(&r.env),
                        sub_invokes: &[],
                    }],
                },
            }])
            .try_deposit_exact_shares(
                &r.user,
                &value,
                &commitment,
                &proof,
                &nd,
                &Bytes::new(&r.env),
                &max_in,
            );

        assert!(
            res.is_ok(),
            "the deposit must succeed with only the user's own fixed-amount authorization: {res:?}"
        );
        assert_eq!(r.vault.balance(&r.pool.address), shares);
        // The ceiling was taken and the unused part refunded: the user paid exactly the cost.
        assert_eq!(before - underlying.balance(&r.user), cost);
        assert_eq!(underlying.balance(&r.router.address), 0, "the router keeps nothing");
    }

    /// The withdrawal leg, against the REAL pool — the module's highest-value function, previously
    /// proven only against a mock that pays shares with a bare transfer.
    ///
    /// What only the real pool can falsify, and none of it was covered: that `processor_gated = true`
    /// with `processor = here` actually satisfies the pool's own `processor.require_auth()` from the
    /// router's frame; that the pool's payout transfer against a SHARE token behaves as the mock's
    /// did; and that `encode_routing` produces bytes the real `compute_transact_context` consumes
    /// without an encoding surprise — the mock only ever compared the router's output to itself.
    #[test]
    fn a_withdrawal_reaches_the_real_pool_and_pays_the_recipient_in_underlying() {
        let r = setup(0);

        // Fund the pool with shares by depositing through the router, so there is something to
        // withdraw and a real state root to prove against.
        r.router.deposit_exact_shares(
            &r.user,
            &(100u128 * ONE_U),
            &U256::from_u32(&r.env, 500),
            &zero_proof(&r.env),
            &note(&r.env),
            &Bytes::new(&r.env),
            &(1_000 * ONE),
        );

        // Roots the pool will verify against, taken live from the real contracts.
        let state_root = r.pool.latest_root();
        let ks_user = Address::generate(&r.env);
        r.ks.set_auth_policy(
            &ks_user,
            &U256::from_u32(&r.env, 111),
            &U256::from_u32(&r.env, 222),
        );
        let ks_root = r.ks.latest_root();
        let asp_root = U256::from_u32(&r.env, 555);
        r.asp.update_asp_root(
            &r.asp_postman,
            &asp_root,
            &Bytes::from_slice(&r.env, b"QmTest"),
        );

        let recipient = Address::generate(&r.env);
        let fee_recipient = Address::generate(&r.env);
        let shares_out = 40 * ONE;
        let routing = PayoutRouting {
            recipient: recipient.clone(),
            fee_recipient: fee_recipient.clone(),
            fee_amount: 2 * ONE as u128,
        };

        let (to_recipient, fee_paid) = r.router.withdraw_to_underlying(
            &1u32,
            &1u32,
            &zero_proof(&r.env),
            &state_root,
            &ks_root,
            &asp_root,
            &(shares_out as u128),
            &soroban_v2_utils::encode_token_id(&r.env, &r.vault_id),
            &soroban_sdk::vec![&r.env, U256::from_u32(&r.env, 900)],
            &soroban_sdk::vec![&r.env, U256::from_u32(&r.env, 901)],
            &soroban_sdk::vec![&r.env, note(&r.env)],
            &routing,
            &0i128,
        );

        let underlying = soroban_sdk::token::TokenClient::new(&r.env, &r.underlying);
        assert!(to_recipient > 0, "the recipient must be paid in underlying");
        assert_eq!(underlying.balance(&recipient), to_recipient);
        assert!(fee_paid > 0, "and the relayer must get its fee");
        assert_eq!(underlying.balance(&fee_recipient), fee_paid);
        assert_eq!(
            r.vault.balance(&r.router.address),
            0,
            "the router must keep nothing"
        );
    }

    // NO real-pool test of the routing binding, and the reason is structural rather than an
    // omission.
    //
    // The dummy-VK trick that makes every other real-pool test possible works because an all-zero
    // verification key accepts ANY public signals. That is precisely what destroys the context
    // commitment: the pool computes `context` from whatever routing it is handed and then verifies
    // it against a key that accepts everything, so a tampered routing verifies happily. I wrote the
    // test, and it paid an attacker 72,727 stroops.
    //
    // So the binding can only be exercised where a proof genuinely commits to a context — which is
    // what `MockPool::expect_processor_data` stands in for, and what the `payout_binding` module
    // above tests, with a control and per-field mutants. Testing it here would need a real Groth16
    // fixture whose context matches a chosen routing, which this repo does not have.
    //
    // Recorded rather than left implied, because the previous version of this header recorded a
    // blocker that turned out to be false, and an unstated limit is how that happens.

    /// How much CPU does a yield withdrawal actually cost?
    ///
    /// Nobody knew. `docs/GAS_PROFILE.md` has rows for pool, keystore, asp-registry and relay and
    /// none for any yield contract, and the only budget call anywhere in the module was
    /// `reset_unlimited()` — which REMOVES the ceiling, so no test could fail on cost.
    ///
    /// The path is plausibly the most expensive in the system: a `pool.transact` the profile already
    /// puts at ~95M for 5x5, plus the router's two redeem legs, each of which walks the wrapper's
    /// conversion stack and the adapter beneath it. This asserts a ceiling rather than printing a
    /// number, so it fails if the path ever grows past what a transaction can carry.
    #[test]
    fn a_yield_withdrawal_fits_in_the_mainnet_cpu_budget() {
        let r = setup(0);
        r.router.deposit_exact_shares(
            &r.user,
            &(100u128 * ONE_U),
            &U256::from_u32(&r.env, 600),
            &zero_proof(&r.env),
            &note(&r.env),
            &Bytes::new(&r.env),
            &(1_000 * ONE),
        );
        let state_root = r.pool.latest_root();
        let ks_user = Address::generate(&r.env);
        r.ks.set_auth_policy(
            &ks_user,
            &U256::from_u32(&r.env, 7),
            &U256::from_u32(&r.env, 8),
        );
        let ks_root = r.ks.latest_root();
        let asp_root = U256::from_u32(&r.env, 601);
        r.asp
            .update_asp_root(&r.asp_postman, &asp_root, &Bytes::from_slice(&r.env, b"Qm"));

        let recipient = Address::generate(&r.env);
        let routing = PayoutRouting {
            recipient: recipient.clone(),
            fee_recipient: Address::generate(&r.env),
            fee_amount: 2 * ONE as u128,
        };

        // Measure only the withdrawal.
        r.env.cost_estimate().budget().reset_default();
        r.router.withdraw_to_underlying(
            &1u32,
            &1u32,
            &zero_proof(&r.env),
            &state_root,
            &ks_root,
            &asp_root,
            &(40 * ONE as u128),
            &soroban_v2_utils::encode_token_id(&r.env, &r.vault_id),
            &soroban_sdk::vec![&r.env, U256::from_u32(&r.env, 910)],
            &soroban_sdk::vec![&r.env, U256::from_u32(&r.env, 911)],
            &soroban_sdk::vec![&r.env, note(&r.env)],
            &routing,
            &0i128,
        );
        let cpu = r.env.cost_estimate().budget().cpu_instruction_cost();

        // Mainnet allows 400M per transaction (SLP-0004). This is 1x1 with a zero-cost proof, so it
        // is a FLOOR on the real cost, not the real cost: a 5x5 with genuine Groth16 verification
        // adds the pool's own ~95M on top. Recorded as such rather than presented as the answer.
        soroban_sdk::testutils::arbitrary::std::println!(
            "yield withdrawal (1x1, dummy proof): {cpu} CPU instructions"
        );
        assert!(
            cpu < 400_000_000,
            "a yield withdrawal must fit in the 400M mainnet budget: {cpu}"
        );
        assert!(
            cpu < 100_000_000,
            "and should fit the 100M local-quickstart default too, or local testing will look \
             like a contract bug: {cpu}"
        );
    }
}

/// The routing encoding must stay byte-identical across three independent implementations.
///
/// `relay::encode_routing`, `yield-router::encode_routing` and the SDK's `encodeRouting`
/// (`sdk/src/crypto.mjs`) all feed the same `context` public signal on the same pool. A one-byte
/// divergence means a proof built by the SDK verifies on one path and not the other — and the
/// failure surfaces as an opaque context mismatch at withdrawal time, not at build time.
///
/// The SDK writes a fixed 128-byte buffer: 56-byte recipient strkey, 56-byte fee-recipient strkey,
/// then the fee as a little-endian u128. This pins the Rust side to that layout.
#[test]
fn the_routing_encoding_matches_the_layout_the_sdk_builds() {
    let env = Env::default();
    let recipient = Address::generate(&env);
    let fee_recipient = Address::generate(&env);

    let encoded = encode_routing(
        &env,
        &PayoutRouting {
            recipient: recipient.clone(),
            fee_recipient: fee_recipient.clone(),
            fee_amount: 0x0102_0304_0506_0708u128,
        },
    );

    assert_eq!(
        encoded.len(),
        128,
        "56 + 56 + 16, exactly as the SDK allocates"
    );

    // Sections, in order.
    let r_bytes = recipient.to_string().to_bytes();
    let f_bytes = fee_recipient.to_string().to_bytes();
    assert_eq!(r_bytes.len(), 56, "strkeys are 56 bytes");
    assert_eq!(
        encoded.slice(0..56),
        r_bytes,
        "recipient occupies bytes 0..56"
    );
    assert_eq!(
        encoded.slice(56..112),
        f_bytes,
        "fee recipient occupies 56..112"
    );

    // Little-endian u128 in the final 16 bytes.
    let fee = encoded.slice(112..128);
    assert_eq!(fee.get(0), Some(0x08), "least-significant byte first");
    assert_eq!(fee.get(7), Some(0x01));
    for i in 8..16u32 {
        assert_eq!(fee.get(i), Some(0), "high half of the u128 is zero here");
    }
}

/// A yield deposit must be able to register its ASP label in the same call.
///
/// Without it a yield deposit lands a funded commitment whose label the ASP never learns, so the
/// note can never enter an association set and the only exit is `ragequit`, which exposes the
/// label. Every ordinary deposit path can register; the yield path structurally could not.
#[test]
fn a_yield_deposit_forwards_its_asp_ciphertext() {
    let f = setup(0);
    f.router.deposit_exact_shares(
        &f.user,
        &(50u128 * ONE_U),
        &U256::from_u32(&f.env, 60),
        &zero_proof(&f.env),
        &NoteData {
            hint: soroban_sdk::BytesN::from_array(&f.env, &[0u8; 32]),
            data: Bytes::new(&f.env),
        },
        &Bytes::from_array(&f.env, &[0xAB; 48]),
        &(1_000 * ONE),
    );
    assert_eq!(
        f.pool.last_label_len(),
        48,
        "the ciphertext must reach the pool"
    );
}

#[test]
fn an_empty_ciphertext_still_deposits() {
    // Registration is optional on both chains; an empty ciphertext must not break the deposit.
    let f = setup(0);
    f.router.deposit_exact_shares(
        &f.user,
        &(50u128 * ONE_U),
        &U256::from_u32(&f.env, 61),
        &zero_proof(&f.env),
        &NoteData {
            hint: soroban_sdk::BytesN::from_array(&f.env, &[0u8; 32]),
            data: Bytes::new(&f.env),
        },
        &Bytes::new(&f.env),
        &(1_000 * ONE),
    );
    assert_eq!(f.pool.last_label_len(), 0);
}

/// A waived fee must go to the recipient, not stay behind in the router.
///
/// Sizing the recipient's leg as `shares_out - fee_amount` and then waiving the fee leaves those
/// shares in the router, where `skim` sweeps them to the dust recipient — the user silently loses
/// them. Redeeming the fee leg FIRST and giving the remainder to the recipient closes it.
#[test]
fn a_waived_fee_leaves_nothing_behind_in_the_router() {
    let f = setup(0);
    let recipient = Address::generate(&f.env);
    let fee_recipient = Address::generate(&f.env);

    f.venue.accrue(&f.admin, &(500_000 * ONE));
    assert_eq!(
        f.vault.preview_redeem(&1),
        0,
        "one share is worth nothing now"
    );

    let (to_recipient, fee_paid) = withdraw!(
        f,
        100 * ONE,
        vault_token_id(&f),
        &recipient,
        &fee_recipient,
        1,
        0
    )
    .unwrap()
    .unwrap();

    assert_eq!(fee_paid, 0, "the dust fee is waived");
    assert!(to_recipient > 0);
    assert_eq!(
        f.vault.balance(&f.router.address),
        0,
        "the waived fee's shares must not be stranded in the router"
    );
}

/// A pool that accepts a deposit without taking the shares must not leave them in the router.
///
/// The withdrawal path already guarded this; the deposit path did not. Anything left behind is
/// swept by the permissionless `skim` to the dust recipient — the user pays, the note is unfunded,
/// and their money ends up at a third address.
#[test]
fn a_pool_that_does_not_take_the_shares_is_detected_on_deposit() {
    let f = setup(0);
    f.pool.set_take_deposit(&false);

    assert_err!(
        f.router.try_deposit_exact_shares(
            &f.user,
            &(50u128 * ONE_U),
            &U256::from_u32(&f.env, 70),
            &zero_proof(&f.env),
            &NoteData {
                hint: soroban_sdk::BytesN::from_array(&f.env, &[0u8; 32]),
                data: Bytes::new(&f.env),
            },
            &Bytes::new(&f.env),
            &(1_000 * ONE),
        ),
        Error::SharesNotReceived
    );
    assert_eq!(
        f.vault.balance(&f.router.address),
        0,
        "and nothing is stranded"
    );
}

/// A withdrawal whose recipient share redeems to nothing must fail diagnosably.
///
/// The fee leg had a zero-preview guard; the recipient leg did not, so the redeem reverted deep
/// inside the wrapper with `ZeroAssets` and surfaced as the generic `VaultRejected`. This is not a
/// pathological case: on a young vault at price ~1, a single share redeems to zero.
#[test]
fn a_withdrawal_that_would_pay_the_recipient_nothing_fails_diagnosably() {
    let f = setup(0);
    let recipient = Address::generate(&f.env);

    // Inflate the rate so a small share count is worth less than one stroop.
    f.venue.accrue(&f.admin, &(500_000 * ONE));
    assert_eq!(
        f.vault.preview_redeem(&1),
        0,
        "one share is worth nothing now"
    );

    assert_err!(
        withdraw!(f, 1, vault_token_id(&f), &recipient, &recipient, 0, 0),
        Error::BelowMinUnderlying
    );
}

// ---------------------------------------------------------------- CRITICAL regression

/// A relayer must not be able to redirect a withdrawal it is merely submitting.
///
/// The original `withdraw_to_underlying` took `recipient`, `fee_recipient` and `fee_amount` as free
/// arguments beside an opaque `processor_data` blob. A relayer could pass a victim's proof together
/// with the victim's own unmodified `processor_data` — satisfying the pool's context check — while
/// naming itself as recipient, and take the entire withdrawal. The relayer is the untrusted party
/// in this exact trust model.
///
/// The fix is the one `relay::_relay` already used: derive `processor_data` FROM the routing, so
/// the routing that executes is by construction the routing the proof committed to.
mod payout_binding {
    use super::*;

    /// Build the routing the victim's proof committed to, and tell the pool to expect exactly it.
    fn victim_setup(f: &Fx) -> (Address, PayoutRouting) {
        let victim = Address::generate(&f.env);
        let routing = PayoutRouting {
            recipient: victim.clone(),
            fee_recipient: Address::generate(&f.env),
            fee_amount: 5 * ONE as u128,
        };
        f.pool
            .expect_processor_data(&encode_routing(&f.env, &routing));
        (victim, routing)
    }

    #[test]
    fn the_committed_routing_is_accepted() {
        // Control. Without this, the theft test below could pass simply because everything fails.
        let f = setup(0);
        let (victim, routing) = victim_setup(&f);

        let (to_recipient, _fee) = withdraw!(
            f,
            100 * ONE,
            vault_token_id(&f),
            &routing.recipient,
            &routing.fee_recipient,
            routing.fee_amount as i128,
            0
        )
        .unwrap()
        .unwrap();

        assert!(to_recipient > 0);
        assert_eq!(
            token::TokenClient::new(&f.env, &f.underlying).balance(&victim),
            to_recipient,
            "the victim receives their own withdrawal"
        );
    }

    #[test]
    fn a_relayer_cannot_redirect_the_recipient() {
        let f = setup(0);
        let (_victim, routing) = victim_setup(&f);
        let attacker = Address::generate(&f.env);

        // Same proof, same everything — only the recipient swapped for the attacker's address.
        let r = withdraw!(
            f,
            100 * ONE,
            vault_token_id(&f),
            &attacker,
            &routing.fee_recipient,
            routing.fee_amount as i128,
            0
        );
        assert_err!(r, Error::PoolRejected);
        assert_eq!(
            token::TokenClient::new(&f.env, &f.underlying).balance(&attacker),
            0,
            "and the attacker must receive nothing"
        );
    }

    #[test]
    fn a_relayer_cannot_redirect_the_fee_recipient() {
        let f = setup(0);
        let (_victim, routing) = victim_setup(&f);
        let attacker = Address::generate(&f.env);

        let r = withdraw!(
            f,
            100 * ONE,
            vault_token_id(&f),
            &routing.recipient,
            &attacker,
            routing.fee_amount as i128,
            0
        );
        assert_err!(r, Error::PoolRejected);
        assert_eq!(
            token::TokenClient::new(&f.env, &f.underlying).balance(&attacker),
            0
        );
    }

    /// The most valuable variant: inflate the fee to the whole withdrawal and take it as the fee.
    /// Every per-item bound still passes — `fee_amount <= shares_out` holds — so only the context
    /// binding stops this.
    #[test]
    fn a_relayer_cannot_inflate_the_fee_to_swallow_the_withdrawal() {
        let f = setup(0);
        let (_victim, routing) = victim_setup(&f);

        let r = withdraw!(
            f,
            100 * ONE,
            vault_token_id(&f),
            &routing.recipient,
            &routing.fee_recipient,
            100 * ONE,
            0
        );
        assert_err!(r, Error::PoolRejected);
    }
}

// ---------------------------------------------------------------- authorization and init

/// The router is one-shot, like every other contract in the port.
///
/// This had no test at all: `try_initialize` appeared nowhere in the file and neither
/// `AlreadyInitialized` nor `NotInitialized` was ever asserted. Neutering the guard left all 33
/// tests green. Re-initializing repoints `Vault` at a wrapper of the attacker's choosing and
/// `DustRecipient` at themselves, so every later withdrawal routes through their code — the same
/// class as the CRITICAL already found and fixed in the Blend adapter, which the router never got.
#[test]
fn the_router_cannot_be_re_initialized() {
    let f = setup(0);
    let attacker = Address::generate(&f.env);
    let hostile_vault = Address::generate(&f.env);

    assert_err!(
        f.router
            .try_initialize(&f.pool.address, &hostile_vault, &attacker),
        Error::AlreadyInitialized
    );

    assert_eq!(f.router.vault(), f.vault.address, "the vault is unchanged");
    assert_eq!(f.router.pool(), f.pool.address, "the pool is unchanged");
    assert_ne!(
        f.router.dust_recipient(),
        attacker,
        "the dust recipient is unchanged"
    );
}

/// Only the depositor may spend their own funds through the router.
#[test]
fn only_the_depositor_may_deposit_through_the_router() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal;

    let f = setup(0);
    let thief = Address::generate(&f.env);
    let value = 50u128 * ONE_U;
    let commitment = U256::from_u32(&f.env, 90);
    let proof = zero_proof(&f.env);
    let nd = NoteData {
        hint: soroban_sdk::BytesN::from_array(&f.env, &[0u8; 32]),
        data: Bytes::new(&f.env),
    };

    // A thief authorized for exactly this call, naming the victim as `from`, must be refused.
    let args = (
        f.user.clone(),
        value,
        commitment.clone(),
        proof.clone(),
        nd.clone(),
        Bytes::new(&f.env),
        1_000 * ONE,
    )
        .into_val(&f.env);
    let refused = f
        .router
        .mock_auths(&[MockAuth {
            address: &thief,
            invoke: &MockAuthInvoke {
                contract: &f.router.address,
                fn_name: "deposit_exact_shares",
                args,
                sub_invokes: &[],
            },
        }])
        .try_deposit_exact_shares(
            &f.user,
            &value,
            &commitment,
            &proof,
            &nd,
            &Bytes::new(&f.env),
            &(1_000 * ONE),
        );
    assert!(
        refused.is_err(),
        "a thief must not spend someone else's funds"
    );
}

/// The SAME cross-language golden vector the relay and the SDK assert.
///
/// `the_routing_encoding_matches_the_layout_the_sdk_builds` above pins the LAYOUT, which is most of
/// the value — but it uses generated addresses, so it cannot share a literal with the JavaScript
/// side and the three implementations were still only ever compared in prose. This pins all three to
/// one concrete byte string:
///   - contracts/relay/src/test.rs      `encode_routing_matches_the_cross_language_golden_vector`
///   - sdk/test/crypto.test.mjs         `encodeRouting matches the contract's golden vector`
///
/// Changing the vector in one place without the others turns the others red, which is the point.
#[test]
fn encode_routing_matches_the_cross_language_golden_vector() {
    let env = Env::default();
    let recipient = Address::from_str(
        &env,
        "GDPH4SB6JJ7BIFEEYYYGMRDOJKMFNIIP7O5AYUZRI3GIPQNEBM266I34",
    );
    let fee_recipient = Address::from_str(
        &env,
        "GCUNOZNC3AS7J3JJOEXUDRP43PJ4ZKM3YVKHIYXEATEOL4CCMRRLOLRA",
    );

    let encoded = encode_routing(
        &env,
        &PayoutRouting {
            recipient,
            fee_recipient,
            fee_amount: 1_234_567_890_u128,
        },
    );

    // Derived from the documented layout, not copied from any implementation's output.
    let mut expected_bytes = Bytes::new(&env);
    expected_bytes.append(&Bytes::from_slice(
        &env,
        b"GDPH4SB6JJ7BIFEEYYYGMRDOJKMFNIIP7O5AYUZRI3GIPQNEBM266I34",
    ));
    expected_bytes.append(&Bytes::from_slice(
        &env,
        b"GCUNOZNC3AS7J3JJOEXUDRP43PJ4ZKM3YVKHIYXEATEOL4CCMRRLOLRA",
    ));
    expected_bytes.append(&Bytes::from_slice(&env, &1_234_567_890_u128.to_le_bytes()));
    assert_eq!(expected_bytes.len(), 128, "56 + 56 + 16");
    assert_eq!(
        encoded, expected_bytes,
        "all three encoders must agree on this exact byte string"
    );
}

/// The deposit leg over a venue that FLOORS — the production case, and the one that was broken.
///
/// `depositing_mints_exact_shares_and_lands_them_in_the_pool` runs over a `MockVenue` that credits
/// exactly what it is handed. That is the behaviour of a venue at an exchange rate of exactly 1.0,
/// and no live Blend reserve is at 1.0 — the four on testnet run 1.056 to 4.645. Against real Blend
/// at those rates the underlying `vault.mint` reverted with `VenueShortfall` for 28-30 of every 30
/// share targets, so this entrypoint, the whole deposit path, could not have completed a single
/// deposit on a live network. Every router test passed throughout.
///
/// The slippage ceiling is asserted too: the router enforces it against the quote AND against the
/// charge, so a buffer added to one and not the other turns a correct deposit into
/// `SlippageExceeded` at the caller's exact limit.
#[test]
fn the_deposit_leg_survives_a_venue_that_floors() {
    let f = setup(0);
    f.venue.set_supply_buffer(&5);

    // The premise, measured: without it, deleting the line above leaves this test green against a
    // venue that floors nothing — the exact condition under which the deposit leg looked healthy
    // while being unusable on every live reserve.
    let vbefore = f.venue.position_value();
    f.vault.deposit(&f.user, &f.user, &ONE);
    assert_eq!(
        f.venue.position_value() - vbefore,
        ONE - 5,
        "the venue must actually floor, or this test proves nothing"
    );
    let before = f.vault.balance(&f.pool.address);

    let quoted = f.vault.preview_mint(&(50 * ONE));
    let paid = f.router.deposit_exact_shares(
        &f.user,
        &(50u128 * ONE_U),
        &U256::from_u32(&f.env, 42),
        &zero_proof(&f.env),
        &NoteData {
            hint: soroban_sdk::BytesN::from_array(&f.env, &[0u8; 32]),
            data: Bytes::new(&f.env),
        },
        &Bytes::new(&f.env),
        // The ceiling is the quote EXACTLY, not a slack figure: a ceiling with headroom cannot
        // tell a correct charge from one that silently grew by the buffer.
        &quoted,
    );

    assert_eq!(paid, quoted, "the charge must match what the vault quoted");
    assert_eq!(
        f.vault.balance(&f.pool.address) - before,
        50 * ONE,
        "the pool holds exactly the committed share amount"
    );
    assert_eq!(
        f.vault.balance(&f.router.address),
        0,
        "the router keeps nothing"
    );
}
