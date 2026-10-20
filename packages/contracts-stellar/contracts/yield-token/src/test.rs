#![cfg(test)]
//! Invariant tests for the yield wrapper.
//!
//! Every case here corresponds to a row in `docs/LENDING_DESIGN.md`, which in turn cites a real
//! guard or a real finding in `PPYieldToken.sol` — none of these are invented. Numeric guards are
//! tested on BOTH halves: the over-limit rejection AND the at-limit acceptance. That discipline is
//! not generic caution; the upstream mutation sweep found `PPYieldToken`'s constructor rejecting a
//! deploy at exactly `MAX_FEE_BPS` while the setter accepted it, because only the rejection side
//! had ever been tested.

use super::*;

use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::token::StellarAssetClient;
use yield_adapter::mock_venue::{MockVenue, MockVenueClient};

const OFFSET: u32 = 4;
const DECIMALS: u32 = 7;
const ONE: i128 = 10_000_000; // 1.0 underlying at 7dp

impl Fixture<'_> {
    fn venue_position_of(&self, venue: &Address) -> i128 {
        MockVenueClient::new(&self.env, venue).position_value()
    }

    fn underlying_balance(&self, who: &Address) -> i128 {
        soroban_sdk::token::TokenClient::new(&self.env, &self.underlying).balance(who)
    }
}

struct Fixture<'a> {
    env: Env,
    token: YieldTokenClient<'a>,
    venue: MockVenueClient<'a>,
    underlying: Address,
    sac: StellarAssetClient<'a>,
    admin: Address,
    user: Address,
}

fn setup(fee_bps: i128) -> Fixture<'static> {
    setup_with(fee_bps, OFFSET)
}

/// A fixture at a chosen share-decimals value, for the `decimals` bound.
fn setup_with_decimals(decimals: u32) -> Fixture<'static> {
    setup_full(0, OFFSET, decimals)
}

fn setup_with(fee_bps: i128, offset: u32) -> Fixture<'static> {
    setup_full(fee_bps, offset, DECIMALS)
}

fn setup_full(fee_bps: i128, offset: u32, decimals: u32) -> Fixture<'static> {
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
    let token_id = env.register(YieldToken, ());

    let venue = MockVenueClient::new(&env, &venue_id);
    venue.initialize(&token_id, &underlying);

    let token = YieldTokenClient::new(&env, &token_id);
    token.initialize(
        &admin,
        &venue_id,
        &fee_bps,
        &offset,
        &decimals,
        &String::from_str(&env, "Privacy Pool USDC"),
        &String::from_str(&env, "ppUSDC"),
        &admin,
    );

    Fixture {
        env,
        token,
        venue,
        underlying,
        sac: sac_client,
        admin,
        user,
    }
}

// ---------------------------------------------------------------- invariant 1: fee bound

#[test]
fn fee_at_the_cap_is_accepted_at_init() {
    // The at-limit half. This is the exact case the upstream constructor got wrong.
    let f = setup(MAX_FEE_BPS);
    assert_eq!(f.token.fee_bps(), MAX_FEE_BPS);
}

#[test]
fn fee_above_the_cap_is_rejected_at_init() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    StellarAssetClient::new(&env, &sac.address()).mint(&admin, &(1_000 * ONE));

    let venue_id = env.register(MockVenue, ());
    let token_id = env.register(YieldToken, ());
    MockVenueClient::new(&env, &venue_id).initialize(&token_id, &sac.address());

    let r = YieldTokenClient::new(&env, &token_id).try_initialize(
        &admin,
        &venue_id,
        &(MAX_FEE_BPS + 1),
        &OFFSET,
        &DECIMALS,
        &String::from_str(&env, "n"),
        &String::from_str(&env, "s"),
        &admin,
    );
    assert!(matches!(r, Err(Ok(Error::FeeTooHigh))));
}

#[test]
fn fee_at_the_cap_is_accepted_by_the_setter() {
    let f = setup(0);
    f.token.set_fee_bps(&MAX_FEE_BPS);
    assert_eq!(f.token.fee_bps(), MAX_FEE_BPS);
}

#[test]
fn fee_above_the_cap_is_rejected_by_the_setter() {
    let f = setup(0);
    assert!(matches!(
        f.token.try_set_fee_bps(&(MAX_FEE_BPS + 1)),
        Err(Ok(Error::FeeTooHigh))
    ));
    assert_eq!(
        f.token.fee_bps(),
        0,
        "a rejected setter must not have taken effect"
    );
}

/// The offset IS the inflation buffer, so it needs a floor as well as a ceiling.
///
/// An offset of 0 makes virtual shares `10^0 = 1` and the first-depositor defence that `math.rs` is
/// built around effectively vanishes. EVM cannot be misconfigured this way because it DERIVES the
/// offset; bounding only the top — which this originally did — leaves the dangerous end open.
#[test]
fn an_offset_below_the_minimum_is_rejected_and_the_minimum_itself_is_accepted() {
    let f = setup_with(0, MIN_DECIMALS_OFFSET);
    assert_eq!(
        f.token.total_supply(),
        DEAD_SHARES,
        "the minimum offset is usable"
    );

    for bad in [0u32, MIN_DECIMALS_OFFSET - 1] {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        StellarAssetClient::new(&env, &sac.address()).mint(&admin, &(1_000 * ONE));
        let venue_id = env.register(MockVenue, ());
        let token_id = env.register(YieldToken, ());
        MockVenueClient::new(&env, &venue_id).initialize(&token_id, &sac.address());

        let r = YieldTokenClient::new(&env, &token_id).try_initialize(
            &admin,
            &venue_id,
            &0,
            &bad,
            &DECIMALS,
            &String::from_str(&env, "n"),
            &String::from_str(&env, "s"),
            &admin,
        );
        assert!(
            matches!(r, Err(Ok(Error::UnsupportedDecimals))),
            "offset {bad} must be rejected"
        );
    }
}

/// Admin and vault actions must be observable.
///
/// Without events an indexer cannot see a fee change, a fee claim, a pause or an admin handover at
/// all — off-chain fee accounting has nothing to reconcile against.
#[test]
fn admin_and_vault_actions_emit_events() {
    let f = setup(0);

    // The test env's event buffer reflects the MOST RECENT invocation, so each action is checked
    // immediately after its own call. Comparing counts across calls silently measures nothing —
    // an earlier version of this test did exactly that and failed for that reason.
    let emitted = |f: &Fixture| {
        f.env
            .events()
            .all()
            .filter_by_contract(&f.token.address)
            .events()
            .len()
    };

    f.token.set_fee_bps(&100);
    assert!(emitted(&f) > 0, "set_fee_bps must emit");

    f.token.pause();
    assert!(emitted(&f) > 0, "pause must emit");

    f.token.unpause();
    assert!(emitted(&f) > 0, "unpause must emit");

    f.token.deposit(&f.user, &f.user, &(10 * ONE));
    assert!(emitted(&f) > 0, "deposit must emit");

    f.token.claim_fees(&f.admin);
    assert!(emitted(&f) > 0, "claim_fees must emit");

    let next = Address::generate(&f.env);
    f.token.transfer_admin(&next);
    assert!(emitted(&f) > 0, "transfer_admin must emit");
}

/// `rescue_token` must reject a non-positive amount as a contract error.
#[test]
fn rescuing_a_non_positive_amount_is_rejected() {
    let f = setup(0);
    let other_admin = Address::generate(&f.env);
    let other = f
        .env
        .register_stellar_asset_contract_v2(other_admin.clone());
    assert!(matches!(
        f.token.try_rescue_token(&other.address(), &f.admin, &0),
        Err(Ok(Error::InvalidAmount))
    ));
}

// ---------------------------------------------------------------- invariant 2: delta accounting

#[test]
fn deposited_principal_is_never_charged_a_fee() {
    // The fee applies to YIELD, and principal arriving is not yield. If the checkpoint were taken
    // after the supply instead of before it, every deposit would be taxed as if it were interest.
    let f = setup(MAX_FEE_BPS);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    assert_eq!(f.token.claimable_fees(), 0);
}

#[test]
fn the_fee_is_charged_on_yield_only() {
    let f = setup(1_000); // 10%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(10 * ONE)); // 10 underlying of yield
    assert_eq!(
        f.token.claimable_fees(),
        ONE,
        "10% of the 10 gained, not of the 110 held"
    );
}

#[test]
fn a_fee_rise_is_not_retroactive() {
    // Yield earned under the old rate is settled at the old rate before the new one applies.
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(10 * ONE)); // earned while the fee was 0
    f.token.set_fee_bps(&MAX_FEE_BPS);
    assert_eq!(
        f.token.claimable_fees(),
        0,
        "the 10 gained at 0 bps stays untaxed"
    );
    // This covers the rise alone. The drawdown path — where an untaxed gain used to buy free
    // re-baselining capacity and let the new rate reach back over the old era — is
    // `a_fee_rise_cannot_be_applied_retroactively_through_the_basis`.

    f.venue.accrue(&f.admin, &(10 * ONE)); // earned under the new rate
    assert_eq!(
        f.token.claimable_fees(),
        2 * ONE,
        "20% of the second 10 only"
    );
}

/// SURVIVOR: deleting the pre-deposit checkpoint changed no test result.
///
/// The tests above only checked that principal is NOT taxed. Nothing checked the converse — that
/// yield already earned when someone deposits is still owed. Without the checkpoint, the baseline
/// jumps straight to the post-deposit position and the fee accrued before it is erased, so the
/// protocol silently loses every fee that a deposit happens to land on top of.
#[test]
fn yield_earned_before_a_deposit_survives_that_deposit() {
    let f = setup(1_000); // 10%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(10 * ONE));
    assert_eq!(
        f.token.claimable_fees(),
        ONE,
        "1 owed before anyone deposits again"
    );

    f.token.deposit(&f.user, &f.user, &(50 * ONE));
    assert_eq!(
        f.token.claimable_fees(),
        ONE,
        "the fee already earned must survive a later deposit, not be reset by it"
    );
}

/// SURVIVOR: flipping `preview_mint` from Up to Down changed no test result.
///
/// Every rounding direction must favour the vault. `withdraw` rounding shares up was covered;
/// `mint` rounding the ASSET COST up was not, so a flip let a minter pay a stroop less than their
/// shares are worth — free value, repeatable.
#[test]
fn minting_costs_at_least_what_the_shares_are_worth() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(33 * ONE)); // non-integral rate

    // Find a share count whose asset cost does not divide evenly. Scanning rather than hardcoding
    // keeps this robust to the virtual offset, but the assertion is not conditional: if no
    // inexact case exists the test fails rather than silently proving nothing.
    let mut found = false;
    for shares in 1..2_000i128 {
        let up = f.token.preview_mint(&shares);
        let down = f.token.preview_redeem(&shares);
        assert!(
            up >= down,
            "mint must never cost less than a redeem returns"
        );
        if up > down {
            found = true;
            break;
        }
    }
    assert!(
        found,
        "no inexact case found — this test would prove nothing"
    );
}

/// A venue that credits less than it was given must not mint shares for the full amount.
///
/// The adapter interface documents its return as "the delta this call added to the position, never
/// the resulting absolute value … the only figure attributable to this call". The wrapper was
/// discarding it. A venue that keeps a cut therefore had the shortfall socialized across every
/// existing holder, repeatably, at the depositor's choosing.
#[test]
fn a_partial_supply_mints_shares_only_for_what_the_position_actually_gained() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));

    let other = Address::generate(&f.env);
    f.sac.mint(&other, &(1_000 * ONE));
    let value_before = f.token.preview_redeem(&f.token.balance(&f.user));

    // The venue now keeps 10% of everything supplied.
    f.venue.set_shortfall_bps(&1_000);
    f.token.deposit(&other, &other, &(100 * ONE));

    let value_after = f.token.preview_redeem(&f.token.balance(&f.user));
    assert!(
        value_after >= value_before,
        "an existing holder must not be diluted by another depositor's venue shortfall: \
         {value_before} -> {value_after}"
    );
}

/// And a partial withdrawal must not report the amount requested as if it were delivered.
///
/// `redeem` returned the PREVIEWED assets, not what the venue paid. The router takes that return as
/// ground truth for its `min_underlying_out` floor, so a partial fill passed the floor with a
/// number that was never paid — the recipient receives less than their stated minimum and the call
/// succeeds.
#[test]
fn a_partial_withdrawal_does_not_report_more_than_the_venue_delivered() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let shares = f.token.balance(&f.user);

    f.venue.set_shortfall_bps(&1_000); // the venue delivers 90%
    let before = f.underlying_balance(&f.user);
    let reported = f.token.redeem(&f.user, &f.user, &shares);
    let actually_received = f.underlying_balance(&f.user) - before;

    assert_eq!(
        reported, actually_received,
        "redeem must report what was delivered, not what was requested"
    );
}

// ---------------------------------------------------------------- invariants 3 & 4: dust

#[test]
fn a_deposit_rounding_to_zero_shares_is_rejected() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    // Inflate the rate so that 1 stroop buys less than one share. Sized from the funder's actual
    // balance: the admin also paid for the dead-share seed, so a round 1_000_000 is one stroop
    // more than it holds.
    f.venue.accrue(&f.admin, &(999_999 * ONE));
    assert!(matches!(
        f.token.try_deposit(&f.user, &f.user, &1),
        Err(Ok(Error::ZeroShares))
    ));
}

#[test]
fn a_redeem_rounding_to_zero_assets_is_rejected() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    assert!(matches!(
        f.token.try_redeem(&f.user, &f.user, &1),
        Err(Ok(Error::ZeroAssets))
    ));
}

// ---------------------------------------------------------------- invariant 5: floor at zero

/// A loss larger than the banked fees must not lock the vault.
///
/// RESTORED: I wrote this test, watched it fail, fixed the code — and then deleted it, by replacing
/// a span that happened to contain it. The suite total still rose (other tests were being added at
/// the same time), so nothing flagged it, and the mutation sweep is what noticed: the symmetric
/// fee reversal survived because the only test proving it existed had been removed.
#[test]
fn a_venue_loss_larger_than_the_banked_fees_does_not_lock_the_vault() {
    let f = setup(1_000); // 10%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(50 * ONE));

    // Bank 5 ONE of fees without claiming them.
    f.token.set_fee_bps(&1_000);
    assert_eq!(f.token.claimable_fees(), 5 * ONE);

    // Lose almost everything: the position falls far below the fees owed against it.
    let position = f.venue.position_value();
    f.venue.slash(&f.admin, &(position - 4 * ONE));
    assert_eq!(f.venue.position_value(), 4 * ONE);

    // Fees on evaporated yield must not outrank principal, and must not strand the remainder.
    let shares = f.token.balance(&f.user);
    let got = f.token.redeem(&f.user, &f.user, &shares);
    assert!(
        got > 0,
        "the surviving position must remain redeemable; got {got}"
    );
}

/// A drawdown past the taxed basis returns the WHOLE fee to depositors, and the claim is honest.
///
/// REWRITTEN TWICE, and the second attempt is the interesting one. The original asserted `is_ok()`
/// on a call returning `Ok(0)` in a state its own name did not describe — `claim_fees` could have
/// been replaced by `Ok(0)` and passed. My first rewrite tried to force the fee cap to bind by
/// changing the rate before the loss, on the theory that a zero rate refunds nothing.
///
/// That theory was wrong. The refund is `acc * reversed / basis` — proportional to the taxed BASIS,
/// deliberately rate-independent — so a loss of at least the basis refunds the entire fee whatever
/// the rate is. The cap therefore cannot be made to bind through a loss at all, which is precisely
/// why it is recorded in the source as an accepted mutation survivor.
///
/// So this asserts the property that is actually true and actually matters: the depositor gets the
/// surviving position back, undiminished by fees on yield that no longer exists.
#[test]
fn a_drawdown_past_the_taxed_basis_returns_the_whole_fee_to_depositors() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(50 * ONE));
    f.token.set_fee_bps(&MAX_FEE_BPS);
    assert_eq!(
        f.token.claimable_fees(),
        10 * ONE,
        "10 banked on a basis of 50"
    );

    // Lose more than the taxed gain: 147 against a basis of 50.
    let position = f.venue.position_value();
    f.venue.slash(&f.admin, &(position - 3 * ONE));

    assert_eq!(
        f.token.claimable_fees(),
        0,
        "a loss exceeding the taxed basis reverses the whole fee"
    );
    assert_eq!(
        f.token.total_assets(),
        3 * ONE,
        "so the entire surviving position backs the shares, not the admin"
    );

    // The claim is honest about there being nothing to take.
    let before = f.underlying_balance(&f.admin);
    assert_eq!(f.token.claim_fees(&f.admin), 0);
    assert_eq!(f.underlying_balance(&f.admin), before, "and moves nothing");

    // And the depositor can actually get the survivors out.
    let shares = f.token.balance(&f.user);
    assert!(f.token.redeem(&f.user, &f.user, &shares) > 0);
}

#[test]
fn fees_can_never_exceed_the_position_backing_them() {
    // This test previously asserted `total_assets() == 0` after a near-total loss, and accepted
    // `ZeroAssets` from the redeem as a pass. Both were encoding the bug: fees banked on evaporated
    // yield outranked principal, floored total_assets to zero, and locked the vault for everyone.
    // What it should have been asserting is that the situation cannot arise.
    let f = setup(1_000);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(50 * ONE));
    f.token.set_fee_bps(&1_000);
    assert_eq!(
        f.token.claimable_fees(),
        5 * ONE,
        "10% of the 50 gained is banked"
    );

    let position = f.venue.position_value();
    f.venue.slash(&f.admin, &(position - 1));

    assert!(
        f.token.claimable_fees() <= f.venue.position_value(),
        "fees must never exceed the position backing them"
    );
    assert!(f.token.claimable_fees() >= 0, "and must never go negative");
    assert!(
        f.token.total_assets() >= 0,
        "total_assets must not be inflated by a negative fee"
    );
}

// ---------------------------------------------------------------- invariant 6: dead shares

#[test]
fn dead_shares_are_seeded_to_an_unspendable_holder() {
    let f = setup(0);
    let held = f.token.balance(&f.token.address);
    assert_eq!(held, DEAD_SHARES, "the contract itself holds the seed");
    assert!(f.token.total_supply() >= DEAD_SHARES);
}

#[test]
fn the_dead_share_seed_bounds_first_depositor_inflation() {
    // The classic attack: mint one share, donate a large balance, and the next depositor's shares
    // round to zero — their deposit is absorbed. The seed plus the virtual offset must make that
    // uneconomic rather than merely unlikely.
    let f = setup(0);
    let attacker = f.user.clone();
    let victim = Address::generate(&f.env);
    f.sac.mint(&victim, &(1_000 * ONE));

    f.token.mint(&attacker, &attacker, &1);
    f.venue.accrue(&attacker, &(100 * ONE)); // donate straight into the position

    let got = f.token.deposit(&victim, &victim, &(10 * ONE));
    assert!(
        got > 0,
        "the victim's deposit must still mint shares, not round to nothing"
    );

    let back = f.token.preview_redeem(&got);
    assert!(
        back > 9 * ONE,
        "the victim must recover nearly all of a 10-unit deposit, got {back}"
    );
}

// ---------------------------------------------------------------- invariant 7: admin cannot vanish

#[test]
fn the_admin_role_transfers_only_in_two_steps() {
    let f = setup(0);
    let next = Address::generate(&f.env);

    f.token.transfer_admin(&next);
    assert_eq!(
        f.token.admin(),
        f.admin,
        "the role does not move until accepted"
    );

    f.token.accept_admin();
    assert_eq!(f.token.admin(), next);
}

#[test]
fn accepting_without_a_pending_transfer_is_rejected() {
    let f = setup(0);
    assert!(matches!(
        f.token.try_accept_admin(),
        Err(Ok(Error::NoPendingAdmin))
    ));
}

/// Venue incentives must be reachable through the wrapper, because nothing else can reach them.
///
/// The adapter's owner is the WRAPPER contract, so an adapter-only claim entrypoint is callable by
/// no address on chain. The first attempt at fixing stranded emissions added exactly that, and its
/// test passed only because the fixture used a plain account as the owner — the substitution hid
/// the defect. Here the owner is the real wrapper.
#[test]
fn venue_emissions_are_claimable_through_the_wrapper() {
    let f = setup(0);
    let treasury = Address::generate(&f.env);

    let claimed = f
        .token
        .claim_venue_emissions(&soroban_sdk::vec![&f.env, 0u32], &treasury);
    assert_eq!(claimed, 0, "the mock venue has no incentive programme");
}

#[test]
fn only_the_admin_may_claim_venue_emissions() {
    let f = setup(0);
    let treasury = Address::generate(&f.env);
    f.env.mock_auths(&[]);
    assert!(f
        .token
        .try_claim_venue_emissions(&soroban_sdk::vec![&f.env, 0u32], &treasury)
        .is_err());
}

// ---------------------------------------------------------------- invariant 8: rescue

#[test]
fn the_underlying_can_never_be_rescued() {
    let f = setup(0);
    assert!(matches!(
        f.token.try_rescue_token(&f.underlying, &f.admin, &1),
        Err(Ok(Error::CannotRescueAsset))
    ));
}

#[test]
fn a_stray_token_can_be_rescued() {
    // The guard must be specific to the underlying, not a blanket refusal — otherwise a token
    // mistakenly sent here is stranded forever and the function has no purpose.
    let f = setup(0);
    let other_admin = Address::generate(&f.env);
    let other = f
        .env
        .register_stellar_asset_contract_v2(other_admin.clone());
    StellarAssetClient::new(&f.env, &other.address()).mint(&f.token.address, &500);

    f.token.rescue_token(&other.address(), &f.admin, &500);
    assert_eq!(
        soroban_sdk::token::TokenClient::new(&f.env, &other.address()).balance(&f.admin),
        500
    );
}

// ---------------------------------------------------------------- invariant 10: pause

#[test]
fn pausing_blocks_deposits_but_never_the_exit() {
    // A pause that also froze redemption would trap depositors in a contract its admin has just
    // declared unhealthy. The emergency exit stays open by design.
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.token.pause();

    assert!(matches!(
        f.token.try_deposit(&f.user, &f.user, &ONE),
        Err(Ok(Error::Paused))
    ));
    assert!(matches!(
        f.token.try_mint(&f.user, &f.user, &1),
        Err(Ok(Error::Paused))
    ));

    let shares = f.token.balance(&f.user);
    assert!(
        f.token.try_redeem(&f.user, &f.user, &shares).is_ok(),
        "redeem stays open"
    );
}

#[test]
fn pausing_twice_and_unpausing_when_live_are_both_rejected() {
    let f = setup(0);
    assert!(matches!(f.token.try_unpause(), Err(Ok(Error::NotPaused))));
    f.token.pause();
    assert!(matches!(f.token.try_pause(), Err(Ok(Error::Paused))));
    f.token.unpause();
    assert!(f.token.try_pause().is_ok());
}

// ---------------------------------------------------------------- share math

#[test]
fn a_deposit_and_redeem_round_trip_never_pays_out_more_than_it_took_in() {
    // Rounding must always favour the vault. If any direction rounded the other way, a loop of
    // deposit/redeem would drain the backing a stroop at a time.
    let f = setup(0);
    for amount in [ONE, 3 * ONE + 7, 999_999, 12_345_678] {
        let before = f.sac.address.clone();
        let _ = before;
        let shares = f.token.deposit(&f.user, &f.user, &amount);
        let back = f.token.redeem(&f.user, &f.user, &shares);
        assert!(back <= amount, "round trip returned {back} for {amount}");
    }
}

#[test]
fn preview_matches_what_the_action_actually_does() {
    let f = setup(500);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(7 * ONE));

    let predicted = f.token.preview_deposit(&(5 * ONE));
    let actual = f.token.deposit(&f.user, &f.user, &(5 * ONE));
    assert_eq!(predicted, actual);
}

#[test]
fn withdraw_rounds_shares_up_and_redeem_rounds_assets_down() {
    // Both directions round against the caller. Asserting the pair together is what catches a
    // single flipped `Rounding` argument, which a one-sided test would not.
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(33 * ONE)); // make the rate non-integral

    let assets = 7 * ONE + 3;
    let shares_needed = f.token.preview_withdraw(&assets);
    let assets_back = f.token.preview_redeem(&shares_needed);
    assert!(
        assets_back >= assets,
        "burning the shares withdraw asks for must cover the request: {assets_back} < {assets}"
    );
}

#[test]
fn an_offset_above_the_maximum_is_rejected_and_the_maximum_itself_is_accepted() {
    let f = setup_with(0, MAX_DECIMALS_OFFSET);
    assert_eq!(f.token.total_supply(), DEAD_SHARES);

    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    StellarAssetClient::new(&env, &sac.address()).mint(&admin, &(1_000 * ONE));
    let venue_id = env.register(MockVenue, ());
    let token_id = env.register(YieldToken, ());
    MockVenueClient::new(&env, &venue_id).initialize(&token_id, &sac.address());

    let r = YieldTokenClient::new(&env, &token_id).try_initialize(
        &admin,
        &venue_id,
        &0,
        &(MAX_DECIMALS_OFFSET + 1),
        &DECIMALS,
        &String::from_str(&env, "n"),
        &String::from_str(&env, "s"),
        &admin,
    );
    assert!(matches!(r, Err(Ok(Error::UnsupportedDecimals))));
}

// ---------------------------------------------------------------- venue behaviour

#[test]
fn an_illiquid_venue_fails_the_withdrawal_cleanly_and_leaves_the_shares_intact() {
    // INTL-10 / AW-L-03 carried over: under illiquidity the withdrawal reverts. What matters is
    // that it reverts ATOMICALLY — the shares must still be there to retry with.
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let shares = f.token.balance(&f.user);

    f.venue.set_locked(&(100 * ONE));
    assert!(matches!(
        f.token.try_redeem(&f.user, &f.user, &shares),
        Err(Ok(Error::VenueRejected))
    ));
    assert_eq!(
        f.token.balance(&f.user),
        shares,
        "a failed exit burns nothing"
    );

    f.venue.set_locked(&0);
    assert!(
        f.token.try_redeem(&f.user, &f.user, &shares).is_ok(),
        "and it is retryable"
    );
}

#[test]
fn shares_are_transferable_so_the_wrapper_can_be_a_pool_asset() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(10 * ONE));
    let shares = f.token.balance(&f.user);
    let other = Address::generate(&f.env);

    f.token.transfer(&f.user, &other, &shares);
    assert_eq!(f.token.balance(&other), shares);
    assert_eq!(f.token.balance(&f.user), 0);
}

// ---------------------------------------------------------------- token interface (SEP-41)

/// An approval must expire.
///
/// `expiration_ledger` is the mechanism that bounds a stale infinite approval. Without it — which
/// is how this contract shipped originally — an approval granted once was live forever.
#[test]
fn an_allowance_expires_at_the_ledger_it_names() {
    use soroban_sdk::testutils::Ledger as _;
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(10 * ONE));
    let spender = Address::generate(&f.env);

    let now = f.env.ledger().sequence();
    f.token.approve(&f.user, &spender, &1_000, &(now + 10));
    assert_eq!(f.token.allowance(&f.user, &spender), 1_000);

    f.env.ledger().set_sequence_number(now + 11);
    assert_eq!(
        f.token.allowance(&f.user, &spender),
        0,
        "an expired allowance must read as zero"
    );
    assert!(matches!(
        f.token.try_transfer_from(&spender, &f.user, &spender, &1),
        Err(Ok(Error::InsufficientAllowance))
    ));
}

#[test]
fn an_approval_expiring_in_the_past_is_rejected_unless_it_zeroes() {
    use soroban_sdk::testutils::Ledger as _;
    let f = setup(0);
    let spender = Address::generate(&f.env);
    f.env.ledger().set_sequence_number(100);

    assert!(matches!(
        f.token.try_approve(&f.user, &spender, &1_000, &50),
        Err(Ok(Error::InvalidExpiration))
    ));
    // Zeroing an allowance must always be possible, whatever the expiry.
    assert!(f.token.try_approve(&f.user, &spender, &0, &50).is_ok());
}

/// A negative amount must be rejected BEFORE the allowance is touched.
///
/// With the sign check left to `move_shares`, `allowed < amount` was `0 < -5` — false — so the
/// allowance was written to `0 - (-5) = 5` and only the later rollback saved it. A guard that
/// depends on rollback ordering is not a guard.
#[test]
fn a_negative_transfer_from_cannot_inflate_the_allowance() {
    let f = setup(0);
    let spender = Address::generate(&f.env);
    let now = f.env.ledger().sequence();
    f.token.approve(&f.user, &spender, &0, &(now + 100));

    assert!(matches!(
        f.token.try_transfer_from(&spender, &f.user, &spender, &-5),
        Err(Ok(Error::InvalidAmount))
    ));
    assert_eq!(
        f.token.allowance(&f.user, &spender),
        0,
        "the allowance must not have moved"
    );
}

#[test]
fn burning_shares_reduces_supply_without_paying_out() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(10 * ONE));
    let before_supply = f.token.total_supply();
    let before_underlying = f.underlying_balance(&f.user);
    let burn = f.token.balance(&f.user) / 4;

    f.token.burn(&f.user, &burn);

    assert_eq!(f.token.total_supply(), before_supply - burn);
    assert_eq!(
        f.underlying_balance(&f.user),
        before_underlying,
        "burning forfeits the backing rather than redeeming it"
    );
}

#[test]
fn burn_from_spends_the_allowance() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(10 * ONE));
    let spender = Address::generate(&f.env);
    let now = f.env.ledger().sequence();
    f.token.approve(&f.user, &spender, &500, &(now + 100));

    f.token.burn_from(&spender, &f.user, &200);
    assert_eq!(f.token.allowance(&f.user, &spender), 300);

    assert!(matches!(
        f.token.try_burn_from(&spender, &f.user, &400),
        Err(Ok(Error::InsufficientAllowance))
    ));
}

// ---------------------------------------------------------------- mutation survivors, closed

/// Exact-output mint must refuse a venue shortfall rather than mint unbacked shares.
///
/// The partial-fill tests above exercise `deposit`, which prices on the delta. `mint` cannot do
/// that — the caller named the share count — so its only correct response to a short credit is to
/// refuse. Nothing covered that path.
#[test]
fn an_exact_mint_refuses_when_the_venue_credits_less_than_quoted() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));

    f.venue.set_shortfall_bps(&1_000); // the venue keeps 10%
    let target = f.token.balance(&f.user) / 10;
    assert!(matches!(
        f.token.try_mint(&f.user, &f.user, &target),
        Err(Ok(Error::VenueShortfall))
    ));
}

/// The fee cap must bind when the loss reversal cannot clear the accumulator.
///
/// Two wrong premises were built into this test before it was measured, and both are worth keeping
/// visible. The first: that a small fee RATE makes the refund small. It does not — the refund uses
/// the same rate the fee accrued at, so a proportional loss refunds proportionally and the rate
/// never enters. The second, which outlived the round-1 fix and described behaviour that no longer
/// existed: that after the rate is dropped to 0 a loss "refunds nothing". It does not — the round-1
/// fix made the refund `acc * reversible / basis`, which reads no rate at all, so the drop to 0 has
/// no effect on the refund whatsoever.
///
/// What actually bounds the refund is the BASIS: only `min(loss, basis)` of a drawdown is
/// reversible, so a loss larger than the gains that were taxed leaves an accumulator the reversal
/// cannot clear. That is when the cap is the only thing keeping fees inside the position, and it is
/// what this test builds.
#[test]
fn the_fee_cap_binds_when_a_rate_change_leaves_the_reversal_unable_to_clear_it() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(50 * ONE));

    // Bank 10 ONE at 20%, then drop the rate to zero.
    f.token.set_fee_bps(&MAX_FEE_BPS);
    assert_eq!(f.token.claimable_fees(), 10 * ONE);
    f.token.set_fee_bps(&0);
    assert_eq!(
        f.token.claimable_fees(),
        10 * ONE,
        "the banked fee survives the rate change"
    );

    // Now lose almost everything. The loss far exceeds the basis, so only the basis is reversible
    // and the refund cannot clear the accumulator — the cap is what keeps fees inside the position.
    let position = f.venue.position_value();
    f.venue.slash(&f.admin, &(position - ONE));

    assert!(
        f.token.claimable_fees() <= f.venue.position_value(),
        "the cap must bind: fees {} vs position {}",
        f.token.claimable_fees(),
        f.venue.position_value()
    );
    assert!(
        f.token.total_assets() >= 0,
        "and total_assets must not go negative"
    );
    assert!(
        f.token.try_claim_fees(&f.admin).is_ok(),
        "and the claim must degrade to what is there rather than revert"
    );
}

/// The wrapper is one-shot, like every other contract in the port.
#[test]
fn the_wrapper_cannot_be_re_initialized() {
    let f = setup(0);
    let attacker = Address::generate(&f.env);
    let r = f.token.try_initialize(
        &attacker,
        &f.token.adapter_address(),
        &0,
        &OFFSET,
        &DECIMALS,
        &String::from_str(&f.env, "evil"),
        &String::from_str(&f.env, "EVIL"),
        &attacker,
    );
    assert!(matches!(r, Err(Ok(Error::AlreadyInitialized))));
    assert_eq!(f.token.admin(), f.admin, "the admin must not have moved");
}

// ---------------------------------------------------------------- audit R1: economic attacks

/// AUDIT HIGH-1: an admin must not be able to convert banked fees into a claim on principal by
/// lowering the rate before a drawdown.
///
/// The reversal used the LIVE fee rate rather than the rate the fee was banked at, so: bank at 20%,
/// set the rate to 0, and the banked amount becomes immune to reversal. The position returns to its
/// original principal and the admin still extracts 20% of the drawdown.
///
/// The scenario was already in this suite — `the_fee_cap_binds_when_a_rate_change...` builds exactly
/// this state — but every assertion there was about LIVENESS (fees <= position, total_assets >= 0,
/// claim does not revert). None asked whether the depositor's principal survived. A test can walk
/// through an exploit and pass.
#[test]
fn lowering_the_fee_rate_before_a_loss_cannot_convert_fees_into_a_claim_on_principal() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let principal = 100 * ONE;

    f.venue.accrue(&f.admin, &(50 * ONE)); // position 150
    f.token.set_fee_bps(&MAX_FEE_BPS); // bank 10 at 20%
    f.token.set_fee_bps(&0); // then drop the rate

    // Give the whole gain back: the position returns to the principal (plus the 1 stroop the
    // dead-share seed put in at initialization).
    f.venue.slash(&f.admin, &(50 * ONE));
    assert_eq!(f.venue.position_value(), principal + 1);

    // The depositor is the only shareholder besides the dead-share seed, so they should be able to
    // recover essentially all of the principal.
    let shares = f.token.balance(&f.user);
    let recoverable = f.token.preview_redeem(&shares);
    assert!(
        recoverable >= principal - (principal / 1000),
        "principal must survive a round trip to nothing: {recoverable} of {principal}"
    );
}

/// AUDIT HIGH-2: a recovery from a drawdown must not be taxable as fresh yield.
///
/// The reversal was clamped at zero, so a loss larger than the banked fees discarded the excess —
/// but any caller could then force a checkpoint with a 1-stroop deposit, re-baselining to the
/// trough. The subsequent recovery to the ORIGINAL level was then taxed as if it were new yield.
/// Anyone could trigger it; no admin privilege needed.
#[test]
fn a_recovery_from_a_drawdown_is_not_taxed_as_fresh_yield() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let start = f.venue.position_value();

    // Drawdown with nothing banked to reverse.
    f.venue.slash(&f.admin, &(20 * ONE));
    assert_eq!(
        f.token.claimable_fees(),
        0,
        "nothing was banked to begin with"
    );

    // ANY caller forces a checkpoint at the trough.
    let poker = Address::generate(&f.env);
    f.sac.mint(&poker, &(1_000 * ONE));
    f.token.deposit(&poker, &poker, &ONE);

    // The position recovers to where it started. That is not yield.
    f.venue.accrue(&f.admin, &(20 * ONE));
    assert!(
        f.venue.position_value() >= start,
        "the position has recovered"
    );
    assert_eq!(
        f.token.claimable_fees(),
        0,
        "recovering a drawdown is not yield and must not be taxed"
    );
}

/// Claiming a fee must retire the basis that produced it.
///
/// The refund on a loss is `acc * reversed / basis`. A claimed fee can never be refunded, so if its
/// basis stays behind the denominator is inflated and every later loss refunds proportionally less
/// than it should — quietly favouring the admin. The two have to move together.
#[test]
fn claiming_a_fee_retires_its_share_of_the_reversal_basis() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));

    // Gain 50, bank 10 on a basis of 50, then claim it all.
    f.venue.accrue(&f.admin, &(50 * ONE));
    f.token.set_fee_bps(&MAX_FEE_BPS);
    assert_eq!(f.token.claimable_fees(), 10 * ONE);
    f.token.claim_fees(&f.admin);
    assert_eq!(f.token.claimable_fees(), 0);

    // Earn again on a fresh basis, then give it all back. With the claimed basis retired, the
    // second fee reverses completely; with it left behind, part of it survives the loss.
    f.venue.accrue(&f.admin, &(50 * ONE));
    f.token.set_fee_bps(&MAX_FEE_BPS);
    assert_eq!(
        f.token.claimable_fees(),
        10 * ONE,
        "10 banked on the second gain"
    );

    f.venue.slash(&f.admin, &(50 * ONE));
    assert_eq!(
        f.token.claimable_fees(),
        0,
        "giving back the whole second gain must reverse the whole second fee"
    );
}

/// A partial fee payout must leave the remainder claimable, not forfeit it.
///
/// Zeroing the accumulator before the venue call — which is how this originally worked — converts
/// whatever the venue could not pay into shareholder value and the protocol can never recover it.
#[test]
fn a_partially_filled_fee_claim_leaves_the_remainder_banked() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(50 * ONE));
    f.token.set_fee_bps(&MAX_FEE_BPS);
    assert_eq!(f.token.claimable_fees(), 10 * ONE);

    // The venue now fills only 90% of any withdrawal.
    f.venue.set_shortfall_bps(&1_000);
    let paid = f.token.claim_fees(&f.admin);

    assert!(
        paid > 0 && paid < 10 * ONE,
        "the claim was partially filled: {paid}"
    );
    assert!(
        f.token.claimable_fees() > 0,
        "the unpaid remainder must stay claimable, not become shareholder value"
    );
}

// ---------------------------------------------------------------- audit R1: the escape hatch

/// A healthy adapter must NOT be replaceable.
///
/// An admin who can swap adapters at will controls `position_value`, which prices every share —
/// they could mint unbounded shares and drain the vault. The escape hatch has to be unavailable in
/// the normal case or it is worse than the problem it solves.
#[test]
fn a_healthy_adapter_cannot_be_replaced() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));

    let hostile = f.env.register(MockVenue, ());
    MockVenueClient::new(&f.env, &hostile).initialize(&f.token.address, &f.underlying);

    assert!(matches!(
        f.token.try_replace_broken_adapter(&hostile),
        Err(Ok(Error::AdapterStillHealthy))
    ));
    assert_eq!(
        f.token.adapter_address(),
        f.venue.address,
        "the adapter is unchanged"
    );
}

/// A broken adapter must be replaceable, or the funds are unrecoverable by anyone.
#[test]
fn a_broken_adapter_can_be_replaced_and_the_vault_recovers() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));

    // The venue stops reporting the position. Everything that prices shares now fails.
    f.venue.set_broken(&true);
    assert!(
        f.token.try_total_assets().is_err(),
        "the vault is locked while broken"
    );

    // Stand up a replacement over the same underlying, holding the same value.
    let replacement = f.env.register(MockVenue, ());
    MockVenueClient::new(&f.env, &replacement).initialize(&f.token.address, &f.underlying);
    let repl = MockVenueClient::new(&f.env, &replacement);
    repl.accrue(&f.admin, &(100 * ONE));

    f.token.replace_broken_adapter(&replacement);

    assert_eq!(f.token.adapter_address(), replacement);
    assert!(f.token.total_assets() > 0, "the vault reads again");
    let shares = f.token.balance(&f.user);
    assert!(
        f.token.redeem(&f.user, &f.user, &shares) > 0,
        "and the exit works"
    );
}

/// A replacement wrapping a different asset would silently redenominate every share.
#[test]
fn a_replacement_over_a_different_underlying_is_refused() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.set_broken(&true);

    let other_admin = Address::generate(&f.env);
    let other = f
        .env
        .register_stellar_asset_contract_v2(other_admin.clone())
        .address();
    let wrong = f.env.register(MockVenue, ());
    MockVenueClient::new(&f.env, &wrong).initialize(&f.token.address, &other);

    assert!(matches!(
        f.token.try_replace_broken_adapter(&wrong),
        Err(Ok(Error::VenueRejected))
    ));
}

// ---------------------------------------------------------------- MOL-7: allowance boundaries

/// The at-limit cases for every allowance comparison.
///
/// Six sites — `allowance`'s `exp >= seq`, `approve`'s `exp < seq`, and `transfer_from`/`burn_from`'s
/// `exp < seq` and `allowed < amount` — all survived mutation, because the existing tests only ever
/// probed strictly-over and strictly-under. The recurring `<=`/`<` class: a suite reliably tests
/// that exceeding a limit is rejected and never that hitting it exactly is accepted.
#[test]
fn an_allowance_is_live_on_its_final_ledger_and_dead_the_next() {
    use soroban_sdk::testutils::Ledger as _;
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(10 * ONE));
    let spender = Address::generate(&f.env);
    let now = f.env.ledger().sequence();

    f.token.approve(&f.user, &spender, &1_000, &(now + 10));

    // Exactly AT the expiration ledger: still live.
    f.env.ledger().set_sequence_number(now + 10);
    assert_eq!(
        f.token.allowance(&f.user, &spender),
        1_000,
        "an allowance must survive its own expiration ledger"
    );
    assert!(
        f.token
            .try_transfer_from(&spender, &f.user, &spender, &1)
            .is_ok(),
        "and must still be spendable on it"
    );

    // One past it: dead.
    f.env.ledger().set_sequence_number(now + 11);
    assert_eq!(f.token.allowance(&f.user, &spender), 0);
}

#[test]
fn an_approval_expiring_exactly_now_is_accepted() {
    use soroban_sdk::testutils::Ledger as _;
    let f = setup(0);
    let spender = Address::generate(&f.env);
    f.env.ledger().set_sequence_number(100);

    // `exp == seq` is the boundary: an approval good for the current ledger is legal.
    assert!(
        f.token.try_approve(&f.user, &spender, &1_000, &100).is_ok(),
        "an approval expiring on the current ledger must be accepted"
    );
    assert_eq!(f.token.allowance(&f.user, &spender), 1_000);
}

#[test]
fn spending_exactly_the_allowance_is_permitted() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(10 * ONE));
    let spender = Address::generate(&f.env);
    let now = f.env.ledger().sequence();
    f.token.approve(&f.user, &spender, &500, &(now + 100));

    // Exactly the approved amount, on both spend paths.
    f.token.transfer_from(&spender, &f.user, &spender, &500);
    assert_eq!(f.token.allowance(&f.user, &spender), 0);

    f.token.approve(&f.user, &spender, &300, &(now + 100));
    f.token.burn_from(&spender, &f.user, &300);
    assert_eq!(f.token.allowance(&f.user, &spender), 0);
}

// ---------------------------------------------------------------- withdraw (exact-assets exit)

/// `withdraw` had NO test at all — it is a public entrypoint with its own error contract.
///
/// Unlike `redeem`, it names an exact asset amount, so a short delivery is a broken promise rather
/// than an honest report. Deleting that guard survived the suite, because nothing called the
/// function.
#[test]
fn withdraw_pays_the_exact_amount_asked_for() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let receiver = Address::generate(&f.env);

    let before = f.underlying_balance(&receiver);
    let shares_burned = f.token.withdraw(&f.user, &receiver, &(30 * ONE));

    assert_eq!(
        f.underlying_balance(&receiver) - before,
        30 * ONE,
        "withdraw names an exact amount and must deliver it exactly"
    );
    assert_eq!(shares_burned, f.token.preview_withdraw(&(30 * ONE)));
}

#[test]
fn withdraw_refuses_a_short_delivery_rather_than_reporting_it() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let receiver = Address::generate(&f.env);

    f.venue.set_shortfall_bps(&1_000); // the venue delivers 90%
    assert!(matches!(
        f.token.try_withdraw(&f.user, &receiver, &(30 * ONE)),
        Err(Ok(Error::VenueShortfall))
    ));
    assert_eq!(
        f.underlying_balance(&receiver),
        0,
        "a refused withdrawal must move nothing"
    );
    assert_eq!(
        f.token.balance(&f.user),
        f.token.total_supply() - DEAD_SHARES,
        "and must burn nothing"
    );
}

// ---------------------------------------------------------------- authorization, exhaustively

/// Every gated entrypoint, proven to require the RIGHT address.
///
/// The rest of this suite runs under `mock_all_auths_allowing_non_root_auth()`, which authorizes any
/// address for any call — so no admin check was ever exercised. Dropping `require_admin` from five
/// separate entrypoints, including `replace_broken_adapter` (which chooses the adapter that prices
/// every share), survived the entire suite.
///
/// `mock_auths(&[])` is NOT the fix: with nothing authorized everything fails, so "it failed" proves
/// nothing — this repo has been bitten by that twice. Each case grants authorization to a STRANGER
/// for exactly the call under test. With the gate present the call fails, because the required
/// address is absent; with the gate removed it succeeds, because nothing is required. Every case is
/// paired with a control granting the correct address, which must succeed.
mod authorization {
    use super::*;
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal;

    /// Build a client whose only authorization is `who`, for `fn_name(args)` on the token.
    macro_rules! as_only {
        ($f:expr, $who:expr, $fn_name:literal, $args:expr) => {
            $f.token.mock_auths(&[MockAuth {
                address: $who,
                invoke: &MockAuthInvoke {
                    contract: &$f.token.address,
                    fn_name: $fn_name,
                    args: $args,
                    sub_invokes: &[],
                },
            }])
        };
    }

    #[test]
    fn only_the_admin_may_set_the_fee() {
        let f = setup(0);
        let stranger = Address::generate(&f.env);
        let bps = 100i128;
        assert!(
            as_only!(f, &stranger, "set_fee_bps", (bps,).into_val(&f.env))
                .try_set_fee_bps(&bps)
                .is_err()
        );
        assert_eq!(f.token.fee_bps(), 0, "a refused call must not take effect");

        as_only!(f, &f.admin, "set_fee_bps", (bps,).into_val(&f.env)).set_fee_bps(&bps);
        assert_eq!(f.token.fee_bps(), bps, "the admin's own call must succeed");
    }

    #[test]
    fn only_the_admin_may_pause_and_unpause() {
        let f = setup(0);
        let stranger = Address::generate(&f.env);

        assert!(as_only!(f, &stranger, "pause", ().into_val(&f.env))
            .try_pause()
            .is_err());
        assert!(!f.token.is_paused(), "a refused pause must not take effect");

        as_only!(f, &f.admin, "pause", ().into_val(&f.env)).pause();
        assert!(f.token.is_paused());

        assert!(as_only!(f, &stranger, "unpause", ().into_val(&f.env))
            .try_unpause()
            .is_err());
        assert!(
            f.token.is_paused(),
            "a refused unpause must not take effect"
        );

        as_only!(f, &f.admin, "unpause", ().into_val(&f.env)).unpause();
        assert!(!f.token.is_paused());
    }

    #[test]
    fn only_the_admin_may_claim_fees() {
        let f = setup(1_000);
        f.token.deposit(&f.user, &f.user, &(100 * ONE));
        f.venue.accrue(&f.admin, &(50 * ONE));
        let stranger = Address::generate(&f.env);

        assert!(as_only!(
            f,
            &stranger,
            "claim_fees",
            (stranger.clone(),).into_val(&f.env)
        )
        .try_claim_fees(&stranger)
        .is_err());
        assert!(f.token.claimable_fees() > 0, "the fee must still be there");

        let before = f.underlying_balance(&f.admin);
        as_only!(
            f,
            &f.admin,
            "claim_fees",
            (f.admin.clone(),).into_val(&f.env)
        )
        .claim_fees(&f.admin);
        assert!(f.underlying_balance(&f.admin) > before);
    }

    #[test]
    fn only_the_admin_may_begin_an_admin_transfer() {
        let f = setup(0);
        let stranger = Address::generate(&f.env);

        assert!(as_only!(
            f,
            &stranger,
            "transfer_admin",
            (stranger.clone(),).into_val(&f.env)
        )
        .try_transfer_admin(&stranger)
        .is_err());
        // Nothing pending, so an accept must have nothing to accept.
        assert!(matches!(
            f.token.try_accept_admin(),
            Err(Ok(Error::NoPendingAdmin))
        ));

        let next = Address::generate(&f.env);
        as_only!(
            f,
            &f.admin,
            "transfer_admin",
            (next.clone(),).into_val(&f.env)
        )
        .transfer_admin(&next);
        assert_eq!(f.token.admin(), f.admin, "still not accepted");
    }

    #[test]
    fn only_the_pending_admin_may_accept() {
        let f = setup(0);
        let next = Address::generate(&f.env);
        let stranger = Address::generate(&f.env);
        f.token.transfer_admin(&next);

        assert!(as_only!(f, &stranger, "accept_admin", ().into_val(&f.env))
            .try_accept_admin()
            .is_err());
        assert_eq!(f.token.admin(), f.admin, "a stranger cannot take the role");

        as_only!(f, &next, "accept_admin", ().into_val(&f.env)).accept_admin();
        assert_eq!(f.token.admin(), next);
    }

    #[test]
    fn only_the_admin_may_rescue_a_token() {
        let f = setup(0);
        let stranger = Address::generate(&f.env);
        let other_admin = Address::generate(&f.env);
        let other = f
            .env
            .register_stellar_asset_contract_v2(other_admin.clone());
        StellarAssetClient::new(&f.env, &other.address()).mint(&f.token.address, &500);

        let args = (other.address(), stranger.clone(), 500i128).into_val(&f.env);
        assert!(as_only!(f, &stranger, "rescue_token", args)
            .try_rescue_token(&other.address(), &stranger, &500)
            .is_err());
        assert_eq!(
            soroban_sdk::token::TokenClient::new(&f.env, &other.address()).balance(&stranger),
            0,
            "a refused rescue must move nothing"
        );

        let args2 = (other.address(), f.admin.clone(), 500i128).into_val(&f.env);
        as_only!(f, &f.admin, "rescue_token", args2).rescue_token(&other.address(), &f.admin, &500);
        assert_eq!(
            soroban_sdk::token::TokenClient::new(&f.env, &other.address()).balance(&f.admin),
            500
        );
    }

    #[test]
    fn only_the_admin_may_claim_venue_emissions() {
        let f = setup(0);
        let stranger = Address::generate(&f.env);
        let ids = soroban_sdk::vec![&f.env, 0u32];

        let args = (ids.clone(), stranger.clone()).into_val(&f.env);
        assert!(as_only!(f, &stranger, "claim_venue_emissions", args)
            .try_claim_venue_emissions(&ids, &stranger)
            .is_err());

        let args2 = (ids.clone(), f.admin.clone()).into_val(&f.env);
        assert_eq!(
            as_only!(f, &f.admin, "claim_venue_emissions", args2)
                .claim_venue_emissions(&ids, &f.admin),
            0
        );
    }

    // --- ROUND 3: the holder-facing gates, which no sweep reached until now ---
    //
    // `sweep_auth_gates.py` enumerated `require_admin` sites and nothing else, so eleven gates
    // across the yield crates had never been mutated — `deposit`, `mint`, `withdraw` and
    // `burn_from` among them. The fixture calls `mock_all_auths_allowing_non_root_auth()`, which
    // satisfies every `require_auth()` in the module, so deleting any of them left the suite
    // green. These use `mock_auths` to grant a SINGLE address's authorization and nothing else.
    //
    // Each of these is mutation-verified, and where a gate turns out NOT to be distinguishable
    // that is recorded on the test rather than papered over.

    /// Spending somebody else's shares is the exploitable one: `withdraw` burns from stored
    /// balances, so without the gate no token transfer stands in the way of an attacker naming
    /// any holder as `owner` and paying themselves.
    #[test]
    fn only_the_owner_may_withdraw_their_shares() {
        let f = setup(0);
        f.token.deposit(&f.user, &f.user, &(100 * ONE));
        let held = f.token.balance(&f.user);

        let thief = Address::generate(&f.env);
        let args = (f.user.clone(), thief.clone(), 10 * ONE).into_val(&f.env);
        // A Soroban auth rejection surfaces as `Err(Err(InvokeError::Abort))`. `is_err()` also
        // passes on InsufficientBalance, InvalidAmount, Paused or a venue rejection — the exact
        // "passed for the wrong reason" class this repo has logged three times.
        assert!(
            matches!(
                as_only!(f, &thief, "withdraw", args).try_withdraw(&f.user, &thief, &(10 * ONE)),
                Err(Err(_))
            ),
            "a stranger's own authorization must not move another holder's shares, and it must \
             fail on AUTHORIZATION rather than on any contract-level check"
        );
        assert_eq!(f.token.balance(&f.user), held, "and nothing may have moved");

        // CONTROL: the holder's own withdrawal still works, so the assertion above is about the
        // gate and not about `withdraw` being broken for everyone.
        assert!(f.token.try_withdraw(&f.user, &f.user, &(10 * ONE)).is_ok());
    }

    /// `burn_from` destroys another account's shares against an allowance. The spender's
    /// authorization is the only thing separating "spend an allowance I was granted" from
    /// "burn an allowance somebody else was granted".
    #[test]
    fn only_the_spender_may_burn_against_their_own_allowance() {
        let f = setup(0);
        f.token.deposit(&f.user, &f.user, &(100 * ONE));
        let held = f.token.balance(&f.user);

        let spender = Address::generate(&f.env);
        let outsider = Address::generate(&f.env);
        f.token.approve(
            &f.user,
            &spender,
            &(held / 2),
            &(f.env.ledger().sequence() + 1000),
        );

        // The outsider authorizes their own call, but the allowance belongs to `spender`.
        let args = (spender.clone(), f.user.clone(), held / 4).into_val(&f.env);
        // `Err(Err(_))` — a host auth abort, not a contract error. `is_err()` would also pass on
        // InsufficientAllowance, which is exactly the wrong reason here since the allowance is
        // deliberately sufficient.
        assert!(
            matches!(
                as_only!(f, &outsider, "burn_from", args).try_burn_from(
                    &spender,
                    &f.user,
                    &(held / 4)
                ),
                Err(Err(_))
            ),
            "the outsider's own authorization must not spend the spender's allowance"
        );
        assert_eq!(
            f.token.balance(&f.user),
            held,
            "no shares may have been burned"
        );

        // CONTROL: the spender's own call against their own allowance succeeds.
        let args2 = (spender.clone(), f.user.clone(), held / 4).into_val(&f.env);
        as_only!(f, &spender, "burn_from", args2).burn_from(&spender, &f.user, &(held / 4));
        assert_eq!(f.token.balance(&f.user), held - held / 4);
    }

    /// Depositing somebody else's funds.
    ///
    /// An attacker names the victim as `from` and themselves as `receiver`, converting the
    /// victim's underlying into the attacker's shares. This asserts the PROPERTY holds; it does not
    /// prove which layer holds it.
    ///
    /// Measured, not assumed: `verify_test_bites.py` reports this test "passes BOTH ways" against
    /// deleting `from.require_auth()` here. The SAC transfer that follows requires the same
    /// address's authorization, so it rejects the call whether the entrypoint gate is present or
    /// not — the gate is SHADOWED and no test can distinguish it. Recorded as such in
    /// `agents/mutation/sweep_all_auth.py` rather than counted as coverage it does not provide.
    ///
    /// The gate stays, and this test stays: the day the transfer moves behind an allowance, or the
    /// underlying becomes a token that does not re-check its sender, the entrypoint gate becomes
    /// the only barrier — and this test is what would still be asserting the property.
    #[test]
    fn only_the_funder_may_deposit_their_own_underlying() {
        let f = setup(0);
        let thief = Address::generate(&f.env);
        let before = soroban_sdk::token::TokenClient::new(&f.env, &f.underlying).balance(&f.user);

        let args = (f.user.clone(), thief.clone(), 10 * ONE).into_val(&f.env);
        assert!(
            matches!(
                as_only!(f, &thief, "deposit", args).try_deposit(&f.user, &thief, &(10 * ONE)),
                Err(Err(_))
            ),
            "a stranger must not spend another account's underlying, and the refusal must be an \
             authorization abort rather than a contract-level rejection"
        );
        assert_eq!(
            soroban_sdk::token::TokenClient::new(&f.env, &f.underlying).balance(&f.user),
            before,
            "nothing may have moved"
        );
        assert_eq!(
            f.token.balance(&thief),
            0,
            "and no shares may have been minted"
        );

        // CONTROL: the owner's own deposit still works.
        assert!(f.token.try_deposit(&f.user, &f.user, &(10 * ONE)).is_ok());
    }

    /// `mint` is the same attack named in shares rather than assets — and equally shadowed by the
    /// transfer's own auth, confirmed the same way.
    #[test]
    fn only_the_funder_may_mint_against_their_own_underlying() {
        let f = setup(0);
        let thief = Address::generate(&f.env);
        let before = soroban_sdk::token::TokenClient::new(&f.env, &f.underlying).balance(&f.user);
        let shares = 10 * ONE;

        let args = (f.user.clone(), thief.clone(), shares).into_val(&f.env);
        assert!(
            matches!(
                as_only!(f, &thief, "mint", args).try_mint(&f.user, &thief, &shares),
                Err(Err(_))
            ),
            "a stranger must not mint against another account's underlying"
        );
        assert_eq!(
            soroban_sdk::token::TokenClient::new(&f.env, &f.underlying).balance(&f.user),
            before
        );
        assert_eq!(f.token.balance(&thief), 0);

        assert!(f.token.try_mint(&f.user, &f.user, &shares).is_ok());
    }

    /// The most consequential gate in the contract: the adapter prices every share.
    #[test]
    fn only_the_admin_may_replace_a_broken_adapter() {
        let f = setup(0);
        f.token.deposit(&f.user, &f.user, &(100 * ONE));
        f.venue.set_broken(&true);

        let stranger = Address::generate(&f.env);
        let hostile = f.env.register(MockVenue, ());
        MockVenueClient::new(&f.env, &hostile).initialize(&f.token.address, &f.underlying);

        let args = (hostile.clone(),).into_val(&f.env);
        assert!(as_only!(f, &stranger, "replace_broken_adapter", args)
            .try_replace_broken_adapter(&hostile)
            .is_err());
        assert_eq!(
            f.token.adapter_address(),
            f.venue.address,
            "a stranger must not be able to choose the adapter that prices every share"
        );

        let args2 = (hostile.clone(),).into_val(&f.env);
        as_only!(f, &f.admin, "replace_broken_adapter", args2).replace_broken_adapter(&hostile);
        assert_eq!(f.token.adapter_address(), hostile);
    }

    // ---- non-admin authorization: the holder's own funds ----

    #[test]
    fn only_the_holder_may_move_their_shares() {
        let f = setup(0);
        f.token.deposit(&f.user, &f.user, &(10 * ONE));
        let thief = Address::generate(&f.env);
        let shares = f.token.balance(&f.user);

        let args = (f.user.clone(), thief.clone(), shares).into_val(&f.env);
        assert!(as_only!(f, &thief, "transfer", args)
            .try_transfer(&f.user, &thief, &shares)
            .is_err());
        assert_eq!(f.token.balance(&thief), 0);

        let args2 = (f.user.clone(), thief.clone(), shares).into_val(&f.env);
        as_only!(f, &f.user, "transfer", args2).transfer(&f.user, &thief, &shares);
        assert_eq!(f.token.balance(&thief), shares);
    }

    #[test]
    fn only_the_owner_may_redeem_their_shares() {
        let f = setup(0);
        f.token.deposit(&f.user, &f.user, &(10 * ONE));
        let thief = Address::generate(&f.env);
        let shares = f.token.balance(&f.user);

        let args = (f.user.clone(), thief.clone(), shares).into_val(&f.env);
        assert!(as_only!(f, &thief, "redeem", args)
            .try_redeem(&f.user, &thief, &shares)
            .is_err());
        assert_eq!(
            f.underlying_balance(&thief),
            0,
            "a thief must receive nothing"
        );

        let args2 = (f.user.clone(), f.user.clone(), shares).into_val(&f.env);
        assert!(as_only!(f, &f.user, "redeem", args2).redeem(&f.user, &f.user, &shares) > 0);
    }

    #[test]
    fn only_the_owner_may_burn_their_shares() {
        let f = setup(0);
        f.token.deposit(&f.user, &f.user, &(10 * ONE));
        let stranger = Address::generate(&f.env);
        let shares = f.token.balance(&f.user) / 2;

        let args = (f.user.clone(), shares).into_val(&f.env);
        assert!(as_only!(f, &stranger, "burn", args)
            .try_burn(&f.user, &shares)
            .is_err());
        let before = f.token.total_supply();

        let args2 = (f.user.clone(), shares).into_val(&f.env);
        as_only!(f, &f.user, "burn", args2).burn(&f.user, &shares);
        assert_eq!(f.token.total_supply(), before - shares);
    }

    #[test]
    fn only_the_spender_may_use_an_allowance() {
        let f = setup(0);
        f.token.deposit(&f.user, &f.user, &(10 * ONE));
        let spender = Address::generate(&f.env);
        let outsider = Address::generate(&f.env);
        let now = f.env.ledger().sequence();
        f.token.approve(&f.user, &spender, &1_000, &(now + 100));

        let args = (spender.clone(), f.user.clone(), outsider.clone(), 500i128).into_val(&f.env);
        assert!(as_only!(f, &outsider, "transfer_from", args)
            .try_transfer_from(&spender, &f.user, &outsider, &500)
            .is_err());
        assert_eq!(f.token.allowance(&f.user, &spender), 1_000, "untouched");

        let args2 = (spender.clone(), f.user.clone(), outsider.clone(), 500i128).into_val(&f.env);
        as_only!(f, &spender, "transfer_from", args2)
            .transfer_from(&spender, &f.user, &outsider, &500);
        assert_eq!(f.token.allowance(&f.user, &spender), 500);
    }

    #[test]
    fn only_the_holder_may_grant_an_allowance() {
        let f = setup(0);
        let spender = Address::generate(&f.env);
        let now = f.env.ledger().sequence();

        let args = (f.user.clone(), spender.clone(), 1_000i128, now + 100).into_val(&f.env);
        assert!(as_only!(f, &spender, "approve", args)
            .try_approve(&f.user, &spender, &1_000, &(now + 100))
            .is_err());
        assert_eq!(f.token.allowance(&f.user, &spender), 0);

        let args2 = (f.user.clone(), spender.clone(), 1_000i128, now + 100).into_val(&f.env);
        as_only!(f, &f.user, "approve", args2).approve(&f.user, &spender, &1_000, &(now + 100));
        assert_eq!(f.token.allowance(&f.user, &spender), 1_000);
    }
}

// ---------------------------------------------------------------- test-gap R1: uncovered guards

/// `InsufficientBalance` had zero tests at either site, and the share token is a pool asset — a
/// balance underflow here is a mint.
#[test]
fn spending_more_shares_than_owned_is_refused_at_every_site() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(10 * ONE));
    let held = f.token.balance(&f.user);
    let other = Address::generate(&f.env);

    assert!(matches!(
        f.token.try_transfer(&f.user, &other, &(held + 1)),
        Err(Ok(Error::InsufficientBalance))
    ));
    assert!(matches!(
        f.token.try_redeem(&f.user, &f.user, &(held + 1)),
        Err(Ok(Error::InsufficientBalance))
    ));
    assert!(matches!(
        f.token.try_burn(&f.user, &(held + 1)),
        Err(Ok(Error::InsufficientBalance))
    ));

    // The at-limit half: spending EXACTLY the balance must succeed. This is the `<`/`<=` class the
    // rejection cases alone cannot see.
    f.token.transfer(&f.user, &other, &held);
    assert_eq!(f.token.balance(&f.user), 0);
    assert_eq!(f.token.balance(&other), held);
}

/// The `decimals` bound and the view it exists to protect.
///
/// The guard was added because a value of 39 overflowed `exchange_rate` and bricked it permanently —
/// and `exchange_rate` was then never called by any test, so neither the guard nor the view was
/// exercised. Both `UnsupportedDecimals` assertions in the suite were about the OFFSET.
#[test]
fn decimals_at_the_ceiling_are_accepted_and_the_rate_is_readable() {
    let f = setup_with_decimals(MAX_DECIMALS);
    assert!(
        f.token.try_exchange_rate().is_ok(),
        "the view the bound protects must actually evaluate at the ceiling"
    );
}

#[test]
fn decimals_above_the_ceiling_are_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    StellarAssetClient::new(&env, &sac.address()).mint(&admin, &(1_000 * ONE));
    let venue_id = env.register(MockVenue, ());
    let token_id = env.register(YieldToken, ());
    MockVenueClient::new(&env, &venue_id).initialize(&token_id, &sac.address());

    assert!(matches!(
        YieldTokenClient::new(&env, &token_id).try_initialize(
            &admin,
            &venue_id,
            &0,
            &OFFSET,
            &(MAX_DECIMALS + 1),
            &String::from_str(&env, "n"),
            &String::from_str(&env, "s"),
            &admin,
        ),
        Err(Ok(Error::UnsupportedDecimals))
    ));
}

/// The NEGATIVE half of both fee bounds — `a || b` tested only on `b`.
///
/// A negative rate is not merely invalid input: it flows into `mul_div(gain, fee_bps, MAX_BPS)`,
/// which returns `None` for a negative operand, so `checkpoint` returns Overflow and every deposit,
/// redeem and fee claim is bricked permanently.
#[test]
fn a_negative_fee_is_rejected_at_init_and_by_the_setter() {
    let f = setup(0);
    assert!(matches!(
        f.token.try_set_fee_bps(&-1),
        Err(Ok(Error::FeeTooHigh))
    ));
    assert_eq!(f.token.fee_bps(), 0, "and must not take effect");
    // Zero is the accepted lower boundary.
    assert!(f.token.try_set_fee_bps(&0).is_ok());

    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    StellarAssetClient::new(&env, &sac.address()).mint(&admin, &(1_000 * ONE));
    let venue_id = env.register(MockVenue, ());
    let token_id = env.register(YieldToken, ());
    MockVenueClient::new(&env, &venue_id).initialize(&token_id, &sac.address());

    assert!(matches!(
        YieldTokenClient::new(&env, &token_id).try_initialize(
            &admin,
            &venue_id,
            &-1,
            &OFFSET,
            &DECIMALS,
            &String::from_str(&env, "n"),
            &String::from_str(&env, "s"),
            &admin,
        ),
        Err(Ok(Error::FeeTooHigh))
    ));
}

/// The metadata surface every wallet and the pool's asset registration reads — untested, and a
/// name/symbol swap would be invisible.
#[test]
fn the_metadata_surface_reports_what_it_was_initialized_with() {
    let f = setup(0);
    assert_eq!(
        f.token.name(),
        String::from_str(&f.env, "Privacy Pool USDC")
    );
    assert_eq!(f.token.symbol(), String::from_str(&f.env, "ppUSDC"));
    assert_eq!(f.token.decimals(), DECIMALS);
    assert_eq!(f.token.underlying(), f.underlying);
}

/// The ERC-4626-parity converters, and their negative-input guards, reached by no entrypoint.
#[test]
fn the_converters_round_trip_and_reject_negative_input() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));

    let shares = f.token.convert_to_shares(&(10 * ONE));
    assert!(shares > 0);
    assert!(
        f.token.convert_to_assets(&shares) <= 10 * ONE,
        "rounding favours the vault"
    );

    assert!(matches!(
        f.token.try_convert_to_shares(&-1),
        Err(Ok(Error::InvalidAmount))
    ));
    assert!(matches!(
        f.token.try_convert_to_assets(&-1),
        Err(Ok(Error::InvalidAmount))
    ));
}

/// A half-deployed contract must fail cleanly, not trap — and half-deployed is the likeliest first
/// state on chain, since no deploy script touches these contracts yet.
#[test]
fn an_uninitialized_wrapper_reports_not_initialized() {
    let env = Env::default();
    let client = YieldTokenClient::new(&env, &env.register(YieldToken, ()));
    assert!(matches!(client.try_admin(), Err(Ok(Error::NotInitialized))));
    assert!(matches!(
        client.try_underlying(),
        Err(Ok(Error::NotInitialized))
    ));
    assert!(matches!(
        client.try_adapter_address(),
        Err(Ok(Error::NotInitialized))
    ));
    assert!(matches!(
        client.try_exchange_rate(),
        Err(Ok(Error::NotInitialized))
    ));
}

/// ROUND 2: an adapter swap must not tax the recovered position as fresh yield.
///
/// `replace_broken_adapter` writes only the adapter key. `LastCheckpointBalance`,
/// `AccumulatedFees` and `AccumulatedFeeBasis` all survive it — so the REPLACEMENT's position is
/// measured against the BROKEN adapter's baseline. A replacement that reports more than that
/// baseline has the difference read as a gain and taxed at up to 20% of depositor principal, in a
/// recovery where by definition nothing was earned.
#[test]
fn replacing_a_broken_adapter_does_not_tax_the_recovered_position() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let recoverable = f.venue.position_value();

    // The venue breaks with the funds still in it.
    f.venue.set_broken(&true);

    // A replacement is stood up holding MORE than the old baseline — which is the realistic case
    // when the break was an under-report, and is what my own recovery test already constructs.
    let replacement = f.env.register(MockVenue, ());
    let repl = MockVenueClient::new(&f.env, &replacement);
    repl.initialize(&f.token.address, &f.underlying);
    repl.accrue(&f.admin, &(recoverable + 20 * ONE));

    f.token.replace_broken_adapter(&replacement);

    assert_eq!(
        f.token.claimable_fees(),
        0,
        "a recovery is not yield: the admin must not be owed a fee for funds coming back"
    );
}

/// A replacement holding LESS than the banked fees must not leave fees exceeding their backing.
///
/// The swap keeps fees earned before the break — correct, they were earned — but the replacement
/// may recover only part of the position. Without the cap, banked fees would exceed the whole new
/// position, `total_assets` would floor to zero, and the vault would lock: the exact failure the
/// escape hatch exists to undo.
#[test]
fn a_swap_to_a_smaller_position_caps_the_banked_fee_at_it() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(50 * ONE));
    f.token.set_fee_bps(&MAX_FEE_BPS); // bank 10
    assert_eq!(f.token.claimable_fees(), 10 * ONE);

    f.venue.set_broken(&true);

    // Only a fraction of the position is recovered — less than the banked fee.
    let replacement = f.env.register(MockVenue, ());
    let repl = MockVenueClient::new(&f.env, &replacement);
    repl.initialize(&f.token.address, &f.underlying);
    repl.accrue(&f.admin, &(4 * ONE));

    f.token.replace_broken_adapter(&replacement);

    assert!(
        f.token.claimable_fees() <= f.venue_position_of(&replacement),
        "fees must never exceed the position backing them after a swap"
    );
    assert!(
        f.token.total_assets() >= 0,
        "and total_assets must not underflow"
    );
    assert!(
        f.token.try_claim_fees(&f.admin).is_ok(),
        "the claim must not revert forever"
    );
}

/// ROUND 2: a fee RISE must not become retroactive through the basis.
///
/// The basis accumulates every gain, including gains taxed at 0. So `acc / basis` is a blended
/// HISTORICAL rate, and after a rate rise the untaxed portion is free re-baselining capacity: a
/// drawdown reverses `min(loss, basis)` off the baseline while refunding almost nothing, and the
/// recovery is then taxed at the NEW rate. The position round-trips, earns nothing, and the
/// difference comes out of principal.
///
/// `a_recovery_from_a_drawdown_is_not_taxed_as_fresh_yield` only covers `basis == 0`, which is the
/// one case where the loss branch is inert.
#[test]
fn a_fee_rise_cannot_be_applied_retroactively_through_the_basis() {
    let f = setup(0); // launched at zero fee — standard practice
    f.token.deposit(&f.user, &f.user, &(100 * ONE));

    // Earn 10 while the fee is zero. Nothing is charged, but the gain enters the basis.
    f.venue.accrue(&f.admin, &(10 * ONE));
    f.token.set_fee_bps(&MAX_FEE_BPS); // raise to 20% — checkpoints at the OLD rate first
    assert_eq!(f.token.claimable_fees(), 0, "the 0-rate era stays untaxed");

    // Give the gain back, then poke a checkpoint. ANY caller can do this.
    f.venue.slash(&f.admin, &(10 * ONE));
    let poker = Address::generate(&f.env);
    f.sac.mint(&poker, &(1_000 * ONE));
    f.token.deposit(&poker, &poker, &ONE);

    // The position merely returns to where it was. That is not yield.
    f.venue.accrue(&f.admin, &(10 * ONE));
    assert_eq!(
        f.token.claimable_fees(),
        0,
        "a round trip through a drawdown must not be taxed at the new rate"
    );

    // CONTROL: the fee engine is LIVE in this fixture.
    //
    // Every assertion above is `claimable_fees() == 0`, and a vault that never charges anything
    // satisfies all of them. Mutation proved it: replacing the rate lookup with a constant 0 kills
    // seven tests in this crate and leaves this one green — and deleting the `set_fee_bps` call
    // that gives the test its name leaves it green too. A genuine NEW gain must still be taxed.
    f.venue.accrue(&f.admin, &(10 * ONE));
    f.token.deposit(&poker, &poker, &ONE); // bank it
    assert_eq!(
        f.token.claimable_fees(),
        2 * ONE,
        "20% of a real 10-unit gain — without this the test passes against a dead fee engine"
    );
}

/// ROUND 2: the escape hatch must not consume itself.
///
/// `replace_broken_adapter` refuses whenever `position_value` READS, and an empty-but-functional
/// adapter reads perfectly well — it answers zero. So the first swap into an adapter that turns out
/// to hold nothing leaves the vault in the exact state the hatch exists to escape (real shares, no
/// backing) with the hatch permanently answering `AdapterStillHealthy`. It is a one-shot tool that
/// disarms itself precisely when it was aimed wrong, and nothing else can move the adapter pointer.
#[test]
fn the_escape_hatch_survives_a_swap_into_an_empty_adapter() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.set_broken(&true);

    // Swap to a replacement that reads fine but holds nothing — a wrong address, an adapter over a
    // pool the funds never reached, a recovery that has not landed yet.
    let empty = f.env.register(MockVenue, ());
    MockVenueClient::new(&f.env, &empty).initialize(&f.token.address, &f.underlying);
    f.token.replace_broken_adapter(&empty);
    assert_eq!(
        f.token.total_assets(),
        0,
        "depositors are backed by nothing"
    );
    assert!(
        f.token.total_supply() > DEAD_SHARES,
        "yet shares are outstanding"
    );

    // The funds are found. The hatch must still open.
    let real = f.env.register(MockVenue, ());
    MockVenueClient::new(&f.env, &real).initialize(&f.token.address, &f.underlying);
    MockVenueClient::new(&f.env, &real).accrue(&f.admin, &(100 * ONE));
    f.token.replace_broken_adapter(&real);
    assert_eq!(f.token.adapter_address(), real);
    // Assert the OUTCOME, not that two things were merely non-zero. `&&` short-circuits, so a zero
    // balance meant the redeem never ran and the message named neither half — and `> 0` accepts one
    // stroop back from a 100-unit deposit, on a test whose whole point is that the funds are
    // recoverable.
    let shares = f.token.balance(&f.user);
    assert!(shares > 0, "the depositor still holds shares");
    assert_eq!(
        f.token.redeem(&f.user, &f.user, &shares),
        100 * ONE - 1,
        "and the deposit comes back essentially whole, not merely something — one stroop stays \
         behind with the unredeemable dead shares"
    );
}

/// The `<= DEAD_SHARES` boundary in the escape-hatch gate.
///
/// The recurring class this repo has logged four times: a suite tests that exceeding a bound is
/// refused and never that the bound itself behaves. Relaxing `total_supply() <= DEAD_SHARES` to
/// `<` survived the entire crate — and the exactly-at-`DEAD_SHARES` case is reachable, not
/// theoretical: a vault whose only remaining shares are the unredeemable seed.
///
/// It matters because the hatch repoints the adapter that prices every share. A depositor-free
/// vault holding nothing is not "broken" in the sense the hatch exists for — there is nobody to
/// rescue — and an admin must not be able to swap the adapter on that basis.
#[test]
fn a_vault_holding_only_dead_shares_is_not_a_broken_adapter() {
    let f = setup(0);
    assert_eq!(
        f.token.total_supply(),
        DEAD_SHARES,
        "exactly at the boundary: only the inflation-guard seed is outstanding"
    );

    // Take the seed's backing away, so the position reads zero while those shares remain.
    f.venue.slash(&f.admin, &f.venue.position_value());
    assert_eq!(f.token.total_assets(), 0, "and nothing backs them");

    let replacement = f.env.register(MockVenue, ());
    MockVenueClient::new(&f.env, &replacement).initialize(&f.token.address, &f.underlying);

    assert_eq!(
        f.token.try_replace_broken_adapter(&replacement),
        Err(Ok(Error::AdapterStillHealthy)),
        "at exactly DEAD_SHARES there is no depositor to rescue — the hatch must stay shut"
    );

    // CONTROL: one real depositor above the seed and the hatch opens, so this is a boundary and
    // not a gate that refuses everything.
    f.token.deposit(&f.user, &f.user, &(10 * ONE));
    f.venue.slash(&f.admin, &f.venue.position_value());
    assert!(f.token.total_supply() > DEAD_SHARES);
    f.token.replace_broken_adapter(&replacement);
    assert_eq!(f.token.adapter_address(), replacement);
}

/// ROUND 2: a partial recovery is a LOSS being reversed, not yield.
///
/// The swap re-baselines to the replacement's position but never runs the loss branch, so
/// `AccumulatedFees` crosses the break untouched while the baseline collapses to whatever was
/// recovered. `fee_state` then caps the fee at the position — and when the recovery is smaller than
/// the banked fee, that cap is the whole recovery. Depositors get nothing; the admin takes 100% of
/// what came back, on a break where by definition nothing was earned.
#[test]
fn a_partial_recovery_is_not_taken_entirely_as_fees() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));

    // Earn 20, of which 4 is banked as fee. Then the venue breaks.
    f.venue.accrue(&f.admin, &(20 * ONE));
    f.token.deposit(&f.user, &f.user, &ONE); // any flow banks the fee
    assert_eq!(f.token.claimable_fees(), 4 * ONE);
    f.venue.set_broken(&true);

    // A rescue recovers 4 of the 120. That is a 96% loss, not a gain.
    let replacement = f.env.register(MockVenue, ());
    MockVenueClient::new(&f.env, &replacement).initialize(&f.token.address, &f.underlying);
    MockVenueClient::new(&f.env, &replacement).accrue(&f.admin, &(4 * ONE));
    f.token.replace_broken_adapter(&replacement);

    assert_eq!(
        f.token.claimable_fees(),
        0,
        "the banked fee must be refunded against the loss, not paid out of the rescue"
    );
    assert_eq!(
        f.token.total_assets(),
        4 * ONE,
        "depositors keep the recovery"
    );
}

/// ROUND 2: the mock must report a POSITION delta, not a position minus a balance.
///
/// `MockVenue::supply` measured `before` as the adapter's token balance and `after` as its tracked
/// position, then returned the difference between the two. The units cancel only while the adapter
/// holds nothing but its position — the moment anything else sits there (a donation, a shortfall
/// the venue kept from an earlier supply) the reported credit is wrong by that amount.
///
/// This matters beyond the mock: C-7 delta accounting exists precisely so a donation cannot be
/// attributed to a depositor, and a mock that mis-measures the delta is a mock that cannot show
/// C-7 working. It is the instrument, so it has to be right.
#[test]
fn the_mock_venue_reports_the_position_delta_it_actually_credited() {
    let f = setup(0);

    let seeded = f.token.total_assets(); // the dead-share seed, present before anything happens

    // Someone donates straight into the adapter — an airdrop, a fat-fingered transfer, a griefer.
    f.sac.mint(&f.venue.address, &(500 * ONE));

    // ASSERT THE PREMISE. The whole bite of this test rests on this donation, and nothing said so:
    // deleting the mint above left the test passing. The adapter must now HOLD more than its
    // position reports — that gap is precisely what the old `balance` vs `position` mix-up read as
    // a negative delta.
    let held =
        soroban_sdk::token::TokenClient::new(&f.env, &f.underlying).balance(&f.venue.address);
    assert_eq!(
        held - f.venue.position_value(),
        500 * ONE,
        "the adapter must hold 500 more than its position, or there is nothing to be confused by"
    );

    // The deposit must credit exactly what was supplied, undisturbed by the donation. Before the
    // fix this reverted outright with `Overflow`: an unpermissioned, permanent DoS on every deposit.
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    assert_eq!(
        f.token.total_assets(),
        seeded + 100 * ONE,
        "the donation is not the depositor's, and not the depositor's loss either"
    );
    let shares = f.token.balance(&f.user);
    assert_eq!(f.token.redeem(&f.user, &f.user, &shares), 100 * ONE);
}

/// ROUND 2: shares must never be burned for nothing.
///
/// `withdraw_inner` burns first and asks the venue second, then returns whatever the venue
/// delivered. `withdraw` names an exact asset amount, so it rejects any short fill — but `redeem`
/// names a share count and deliberately reports a partial fill honestly rather than failing. That
/// is right for a partial fill and wrong for a total one: a venue that fills with ZERO — a 100%
/// haircut, a paused market, a rounding floor at dust — takes every share and hands back nothing,
/// and the balance is destroyed with no asset ever leaving. Honest reporting of a zero fill is not
/// enough; the burn has to be undone, and on Soroban the only way to undo it is to fail the call.
#[test]
fn a_redemption_that_delivers_nothing_burns_no_shares() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let shares_before = f.token.balance(&f.user);

    f.venue.set_shortfall_bps(&10_000); // the venue fills with nothing at all

    assert_eq!(
        f.token.try_redeem(&f.user, &f.user, &(10 * ONE)),
        Err(Ok(Error::ZeroAssets)),
        "a zero fill must revert, not consume the shares"
    );
    assert_eq!(
        f.token.balance(&f.user),
        shares_before,
        "the shares survive the failed redemption"
    );

    // A merely PARTIAL fill still goes through and still reports the smaller figure — that
    // behaviour is deliberate and must not be swept up by the zero-fill guard.
    f.venue.set_shortfall_bps(&5_000);
    let got = f.token.redeem(&f.user, &f.user, &(10 * ONE));
    assert!(
        got > 0 && got < 10 * ONE,
        "partial fills still report honestly"
    );
}

/// ROUND 2: the fee cap must not leave `acc` and `basis` describing different rates.
///
/// The cap `min(owed, balance)` is the terminal safety net that keeps fees from outgrowing their
/// backing. But `checkpoint` PERSISTS the capped figure while storing the UNCAPPED basis beside it,
/// so once the cap bites, `acc / basis` — the rate at which a later drawdown is refunded — reads
/// far below any rate ever charged. The admin then keeps more of the next loss than they charged on
/// the way up. The cap is documented as unreachable-in-tests, which is not the same as unreachable:
/// a full redemption leaves the vault holding almost nothing but the banked fee, and any slash
/// after that binds it.
#[test]
fn the_fee_cap_keeps_the_accumulator_and_its_basis_on_the_same_rate() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.accrue(&f.admin, &(100 * ONE)); // acc = 20, basis = 100

    // Everyone leaves. The vault now holds essentially just the banked fee.
    let shares = f.token.balance(&f.user);
    f.token.redeem(&f.user, &f.user, &shares);
    assert_eq!(f.token.claimable_fees(), 20 * ONE);

    // A slash then drives the position below the accumulator and binds the cap.
    f.venue.slash(&f.admin, &(10 * ONE));
    let capped = f.token.claimable_fees();
    assert!(capped < 20 * ONE, "the cap bound, as constructed");

    // Fresh capital arrives, lifting the position clear of the accumulator so that reads are no
    // longer pinned by the cap. Deposits are flows and change no fee state, so what `claimable_fees`
    // reports now IS the stored accumulator. Comparing two capped reads instead would have compared
    // the balance with itself and seen nothing.
    let other = Address::generate(&f.env);
    f.sac.mint(&other, &(10_000 * ONE));
    f.token.deposit(&other, &other, &(1_000 * ONE));
    let stored = f.token.claimable_fees();
    assert_eq!(
        stored, capped,
        "the deposit exposed the stored figure, unchanged"
    );

    // A pure round trip: earn 100, lose the same 100. Charged at 20% on the way up, it must be
    // refunded at 20% on the way down — leaving the accumulator exactly where it started.
    f.venue.accrue(&f.admin, &(100 * ONE));
    f.token.deposit(&other, &other, &ONE); // bank the gain — without a checkpoint between the two
    f.venue.slash(&f.admin, &(100 * ONE)); // legs they cancel and neither branch ever runs
    assert_eq!(
        f.token.claimable_fees(),
        stored,
        "a round trip must be rate-symmetric even after the cap has bound"
    );
}

/// ROUND 3 (alignment F3): both deposit paths must baseline by what the venue actually credited.
///
/// `deposit_assets` passes `credited` to `finish_deposit`; `deposit_inner` — the `mint` path —
/// passed the REQUESTED `assets`. When a venue credits more than it was handed, that excess sits
/// above the baseline and is taxed at the next checkpoint as if it were yield. It is not yield: it
/// entered as part of the deposit, and a flow is never taxed. EVM has no such split because
/// `PPYieldToken` re-reads the absolute balance after every deposit.
#[test]
fn a_venue_that_over_credits_a_mint_does_not_make_the_excess_taxable() {
    let f = setup(MAX_FEE_BPS); // 20%, so any mis-baselined amount shows up as a fee
    f.venue.set_surplus_bps(&1_000); // the venue credits 10% more than it is handed

    // `mint` names SHARES, not assets, and at this offset 100 * ONE shares costs about 0.018
    // underlying — four orders of magnitude smaller than the literal reads. Measure the position
    // rather than reasoning about it.
    let sac = soroban_sdk::token::TokenClient::new(&f.env, &f.underlying);
    let position_before = f.venue.position_value();
    let wallet_before = sac.balance(&f.user);
    f.token.mint(&f.user, &f.user, &(100 * ONE));
    let credited = f.venue.position_value() - position_before;
    let paid = wallet_before - sac.balance(&f.user);

    // ASSERT THE PREMISE, against what the user ACTUALLY PAID.
    //
    // Everything below rests on the venue having over-credited, and nothing said so: deleting the
    // `set_surplus_bps` call left this test green, and neutering the mock's surplus lever caused
    // zero failures anywhere in the crate. A first attempt at this assertion compared `credited`
    // against a fraction of itself, which is true for any positive value and caught nothing —
    // the premise has to be measured against an independent quantity.
    assert!(
        credited > paid,
        "the venue must credit MORE than it was handed: credited {} vs paid {}",
        credited,
        paid
    );

    assert_eq!(
        f.token.claimable_fees(),
        0,
        "the surplus arrived with the deposit; taxing it charges a fee on principal"
    );

    // CONTROL: `deposit` was already correct, and must stay that way.
    let g = setup(MAX_FEE_BPS);
    g.venue.set_surplus_bps(&1_000);
    g.token.deposit(&g.user, &g.user, &(100 * ONE));
    assert_eq!(g.token.claimable_fees(), 0);
}

/// AUDIT ROUND 3 HIGH-1: principal that arrives AFTER the swap must not be taxed as yield.
///
/// `replace_broken_adapter` runs the loss branch and then discards its `new_last`, writing the
/// trough as the baseline instead. With nothing banked the loss branch is inert (`basis == 0`, so
/// `reversible == 0` and `new_last == last`), and overwriting it with the trough means every unit of
/// principal recovered afterwards reads as a `balance > last` GAIN at the next checkpoint.
///
/// A rescue that lands in stages is the normal shape of a rescue, so this fires on honest use of the
/// hatch — and an admin who chooses the moment of lowest reported position maximises it.
///
/// The round-2 tests asserted the state immediately AFTER the swap, where this is invisible.
#[test]
fn principal_recovered_after_a_swap_is_not_taxed_as_yield() {
    let f = setup(MAX_FEE_BPS); // 20%
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    assert_eq!(f.token.claimable_fees(), 0, "nothing has been earned");

    f.venue.set_broken(&true);

    // The rescue adapter recovers 60 of the 100 by the time of the swap.
    let replacement = f.env.register(MockVenue, ());
    MockVenueClient::new(&f.env, &replacement).initialize(&f.token.address, &f.underlying);
    let repl = MockVenueClient::new(&f.env, &replacement);
    repl.accrue(&f.admin, &(60 * ONE));
    f.token.replace_broken_adapter(&replacement);
    assert_eq!(
        f.token.claimable_fees(),
        0,
        "still nothing earned at the swap"
    );

    // The remaining 40 of PRINCIPAL is then recovered into the same adapter.
    repl.accrue(&f.admin, &(40 * ONE));

    assert_eq!(
        f.token.claimable_fees(),
        0,
        "recovered principal is not yield — nothing was ever earned here"
    );
    assert_eq!(
        f.token.total_assets(),
        100 * ONE,
        "the depositor is whole again"
    );

    // CONTROL: real yield ON TOP of the recovered principal IS taxed. Without this, the assertions
    // above hold just as well for a vault whose fee engine never charges anything at all.
    repl.accrue(&f.admin, &(10 * ONE));
    assert_eq!(
        f.token.claimable_fees(),
        2 * ONE - 1,
        "20% of a genuine gain above the restored principal — one stroop short of a round 2          because the baseline carries the dead-share seed, and the fee floors"
    );
}

/// The maximal form: swap into an adapter holding nothing, then recover everything into it.
#[test]
fn a_full_recovery_after_an_empty_swap_is_not_taxed_as_yield() {
    let f = setup(MAX_FEE_BPS);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    f.venue.set_broken(&true);

    let empty = f.env.register(MockVenue, ());
    MockVenueClient::new(&f.env, &empty).initialize(&f.token.address, &f.underlying);
    f.token.replace_broken_adapter(&empty);

    let repl = MockVenueClient::new(&f.env, &empty);
    repl.accrue(&f.admin, &(100 * ONE));
    assert_eq!(
        f.token.claimable_fees(),
        0,
        "20% of the entire principal would be the admin's, on a vault that never earned anything"
    );

    // CONTROL: anything ABOVE the restored principal is yield, and is taxed.
    repl.accrue(&f.admin, &(10 * ONE));
    assert_eq!(
        f.token.claimable_fees(),
        2 * ONE - 1,
        "the fee engine is live in this fixture (one stroop of dead-share seed, floored)"
    );
}

// ---------------------------------------------------------- round 3: non-positive amounts

/// TEST-GAP CRITICAL: every entrypoint must refuse a non-positive amount, and the NEGATIVE case is
/// the one that matters.
///
/// Mutation showed the guards on `burn` and `move_shares` could both be deleted with the whole
/// suite green. They are not hygiene checks — a negative amount turns each of them into a primitive:
///
///   `burn(from, -5)`          -> `burn_shares` computes `bal.checked_sub(-5)` = `bal + 5` and
///                                `total_supply.checked_sub(-5)` = `supply + 5`. Free minting.
///   `transfer(from, to, -5)`  -> `move_shares` gives the SENDER `fb + 5` and the receiver `tb - 5`.
///                                Theft from any holder, by naming them as the recipient.
///   `burn_from(spender, -5)`  -> additionally INFLATES the allowance on the way through.
///
/// The identical guard on `transfer_from` IS tested, which is what makes the absence on its siblings
/// a gap rather than a decision.
///
/// Each case asserts the specific error AND that no balance or supply moved — a status-only
/// assertion would not distinguish "refused" from "accepted and silently did nothing".
#[test]
fn burning_a_non_positive_amount_is_refused_and_mints_nothing() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let held = f.token.balance(&f.user);
    let supply = f.token.total_supply();

    for bad in [0i128, -1, -(5 * ONE)] {
        assert_eq!(
            f.token.try_burn(&f.user, &bad),
            Err(Ok(Error::InvalidAmount)),
            "burn({bad}) must be refused"
        );
        assert_eq!(f.token.balance(&f.user), held, "no balance may be created");
        assert_eq!(f.token.total_supply(), supply, "no supply may be created");
    }

    // CONTROL: a positive burn still works, so the assertions above are about the sign and not
    // about `burn` being broken outright.
    f.token.burn(&f.user, &ONE);
    assert_eq!(f.token.balance(&f.user), held - ONE);
    assert_eq!(f.token.total_supply(), supply - ONE);
}

#[test]
fn transferring_a_negative_amount_is_refused_and_steals_nothing() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let victim = Address::generate(&f.env);
    f.token.transfer(&f.user, &victim, &(10 * ONE));

    let attacker = f.user.clone();
    let before_attacker = f.token.balance(&attacker);
    let before_victim = f.token.balance(&victim);

    // Naming the victim as RECIPIENT with a negative amount would pull from them.
    assert_eq!(
        f.token.try_transfer(&attacker, &victim, &-(5 * ONE)),
        Err(Ok(Error::InvalidAmount)),
        "a negative transfer must be refused"
    );
    assert_eq!(f.token.balance(&attacker), before_attacker);
    assert_eq!(
        f.token.balance(&victim),
        before_victim,
        "the victim must not have been drained"
    );

    // CONTROL
    f.token.transfer(&attacker, &victim, &ONE);
    assert_eq!(f.token.balance(&victim), before_victim + ONE);
}

#[test]
fn burn_from_refuses_a_non_positive_amount_and_does_not_inflate_the_allowance() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let spender = Address::generate(&f.env);
    let exp = f.env.ledger().sequence() + 1000;
    f.token.approve(&f.user, &spender, &(10 * ONE), &exp);

    let held = f.token.balance(&f.user);
    let allowance = f.token.allowance(&f.user, &spender);

    for bad in [0i128, -(5 * ONE)] {
        assert_eq!(
            f.token.try_burn_from(&spender, &f.user, &bad),
            Err(Ok(Error::InvalidAmount)),
            "burn_from({bad}) must be refused"
        );
        assert_eq!(f.token.balance(&f.user), held);
        assert_eq!(
            f.token.allowance(&f.user, &spender),
            allowance,
            "a negative burn must not inflate the allowance"
        );
    }

    // CONTROL
    f.token.burn_from(&spender, &f.user, &ONE);
    assert_eq!(f.token.balance(&f.user), held - ONE);
}

#[test]
fn approving_a_negative_allowance_is_refused() {
    let f = setup(0);
    let spender = Address::generate(&f.env);
    let exp = f.env.ledger().sequence() + 1000;

    assert_eq!(
        f.token.try_approve(&f.user, &spender, &-ONE, &exp),
        Err(Ok(Error::InvalidAmount)),
        "a negative allowance must be refused"
    );
    assert_eq!(f.token.allowance(&f.user, &spender), 0);

    // CONTROL: zero IS legal for approve — it is how an allowance is revoked, unlike the burn paths
    // where zero is meaningless. Asserting it here stops a future "tighten to > 0" from passing.
    f.token.approve(&f.user, &spender, &0, &exp);
    assert_eq!(f.token.allowance(&f.user, &spender), 0);
    f.token.approve(&f.user, &spender, &ONE, &exp);
    assert_eq!(f.token.allowance(&f.user, &spender), ONE);
}

#[test]
fn the_vault_entrypoints_refuse_non_positive_amounts() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(100 * ONE));
    let held = f.token.balance(&f.user);

    for bad in [0i128, -ONE] {
        assert_eq!(
            f.token.try_deposit(&f.user, &f.user, &bad),
            Err(Ok(Error::InvalidAmount)),
            "deposit({bad})"
        );
        assert_eq!(
            f.token.try_mint(&f.user, &f.user, &bad),
            Err(Ok(Error::InvalidAmount)),
            "mint({bad})"
        );
        assert_eq!(
            f.token.try_withdraw(&f.user, &f.user, &bad),
            Err(Ok(Error::InvalidAmount)),
            "withdraw({bad})"
        );
        assert_eq!(
            f.token.try_redeem(&f.user, &f.user, &bad),
            Err(Ok(Error::InvalidAmount)),
            "redeem({bad})"
        );
    }
    assert_eq!(f.token.balance(&f.user), held, "nothing may have moved");
}

/// TEST-GAP HIGH: accepting the admin role must CONSUME the pending slot.
///
/// `the_admin_role_transfers_only_in_two_steps` asserts only that `admin()` moved, so deleting the
/// `remove(&DataKey::PendingAdmin)` at the end of `accept_admin` left the whole suite green.
///
/// Without the removal the pending entry survives acceptance, and `accept_admin` has no
/// once-only gate of its own — it only requires the pending address's auth. So a former admin who
/// was once accepted keeps a PERMANENT right to call it again and re-take the role, at any later
/// time, including after they have handed it on to a third party. Silent takeover persistence:
/// nothing about the vault's visible state says the old holder can still walk back in.
#[test]
fn accepting_the_admin_role_consumes_the_pending_slot() {
    let f = setup(0);
    let b = Address::generate(&f.env);

    f.token.transfer_admin(&b);
    f.token.accept_admin();
    assert_eq!(f.token.admin(), b, "the role moved");

    // The slot must be empty now — a second acceptance has nothing to accept.
    assert_eq!(
        f.token.try_accept_admin(),
        Err(Ok(Error::NoPendingAdmin)),
        "the pending slot must be consumed, not merely superseded"
    );

    // And the property that matters: after handing on to C, B cannot walk back in.
    let c = Address::generate(&f.env);
    f.token.transfer_admin(&c); // the fixture mocks auth, so this runs as the current admin
    f.token.accept_admin();
    assert_eq!(f.token.admin(), c);
    assert_eq!(
        f.token.try_accept_admin(),
        Err(Ok(Error::NoPendingAdmin)),
        "B must not be able to re-take a role it handed on"
    );
}

// ==================================================== the venue's rounding, expressed without Blend

/// An exact-output mint must survive a venue that FLOORS what it credits.
///
/// This is the fast, deterministic twin of `yield-blend-adapter`'s
/// `exact_mints_survive_the_live_maximum_b_rate_across_the_input_range`. It exists because the
/// failure it guards against was invisible to all 38 tests in this file: `MockVenue` credited
/// exactly what it was handed, which is the behaviour of a venue whose exchange rate is exactly
/// 1.0, and every real Blend reserve has left 1.0 by the time anyone deposits into it.
///
/// Measured before the fix, against real Blend: 0/30 exact mints succeeded at `b_rate` 1.188, 2/30
/// at 2.129, 0/30 at 4.765. `deposit` was 30/30 throughout — the bug is specific to exact output,
/// which is the router's deposit leg.
#[test]
fn an_exact_mint_survives_a_venue_that_floors() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(1_000 * ONE));

    // The venue now under-credits every supply by 5 stroops and says so. 5 is the shortfall
    // measured against the live testnet wETH reserve, whose b_rate is 4.645.
    f.venue.set_supply_buffer(&5);

    // The premise, measured rather than assumed: the venue must now credit LESS than it is handed.
    // Without this, deleting the `set_supply_buffer` line above leaves the test GREEN — it would
    // pass against a venue that floors nothing, which is exactly the condition that hid the bug it
    // was written for. Measured against an independent quantity (the venue's own position delta),
    // not against another figure the wrapper computed.
    let before = f.venue.position_value();
    f.token.deposit(&f.user, &f.user, &ONE);
    assert_eq!(
        f.venue.position_value() - before,
        ONE - 5,
        "the venue must actually floor, or this test proves nothing"
    );

    for k in 0..20i128 {
        let target = 3 * ONE + k * 11;
        let res = f.token.try_mint(&f.user, &f.user, &target);
        assert!(
            res.is_ok(),
            "mint({target}) must survive a venue that floors: {res:?}"
        );
    }
}

/// The quote must include the buffer, or the caller's slippage ceiling protects the wrong number.
///
/// EVM splits these across two contracts — `PPYieldToken.previewMint` returns the aToken figure and
/// `PPYieldTokenZap.quoteBuy` adds `_SUPPLY_ROUNDING_BUFFER` on top. Here the wrapper reaches the
/// venue itself, so both halves have to be in the one quote, and `preview_mint` disagreeing with
/// what `mint` charges is exactly the gap a slippage ceiling cannot see.
#[test]
fn preview_mint_quotes_what_mint_actually_charges_when_the_venue_floors() {
    let f = setup(0);
    f.token.deposit(&f.user, &f.user, &(1_000 * ONE));
    f.venue.set_supply_buffer(&5);

    // The premise, measured rather than assumed: the venue must now credit LESS than it is handed.
    // Without this, deleting the `set_supply_buffer` line above leaves the test GREEN — it would
    // pass against a venue that floors nothing, which is exactly the condition that hid the bug it
    // was written for. Measured against an independent quantity (the venue's own position delta),
    // not against another figure the wrapper computed.
    let before = f.venue.position_value();
    f.token.deposit(&f.user, &f.user, &ONE);
    assert_eq!(
        f.venue.position_value() - before,
        ONE - 5,
        "the venue must actually floor, or this test proves nothing"
    );

    let shares = 7 * ONE;
    let quoted = f.token.preview_mint(&shares);
    let before = f.underlying_balance(&f.user);
    let charged = f.token.mint(&f.user, &f.user, &shares);
    let paid = before - f.underlying_balance(&f.user);

    assert_eq!(
        charged, quoted,
        "the quote and the charge must agree, or the router's ceiling binds the wrong figure"
    );
    // Assert against what actually left the wallet, not against another figure the contract
    // computed — the two agreeing proves nothing if both come from the same wrong expression.
    assert_eq!(paid, quoted, "the caller must pay exactly what was quoted");
}
