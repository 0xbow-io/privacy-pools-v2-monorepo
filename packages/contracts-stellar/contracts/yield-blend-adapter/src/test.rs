#![cfg(test)]
//! Integration tests against the **real Blend pool**, not a mock.
//!
//! `blend-contract-sdk` ships the deployed pool/backstop/emitter/factory WASM, so these run the
//! actual contract rather than a stand-in. That distinction is the point of the whole exercise: a
//! stub kills the same mutant a real dependency would, so an adapter validated only against
//! `MockVenue` would report coverage it does not have (TEST-10). Everything the adapter gets wrong
//! about Blend specifically — the `b_rate` scalar, the request-type codes, the bToken indirection —
//! is invisible to a mock and visible here.

use super::*;
use blend_contract_sdk::testutils::{default_reserve_config, BlendFixture};
use soroban_sdk::testutils::{Address as _, BytesN as _, Ledger as _};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{BytesN, String as SString};

const ONE: i128 = 10_000_000;

/// A minimal price oracle, so a Blend reserve can actually be BORROWED from.
///
/// The stock `BlendFixture` wires `Address::generate` as the oracle, which means any pool call that
/// prices an asset traps. Without a working oracle there can be no borrower, without a borrower
/// there is no utilisation, and without utilisation `b_rate` never moves — so every test in this
/// file was running against a frozen 1.0 exchange rate and could not observe rate-dependent
/// behaviour at all.
#[soroban_sdk::contract]
pub struct MockOracle;

#[soroban_sdk::contractimpl]
impl MockOracle {
    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn lastprice(
        env: Env,
        _asset: blend_contract_sdk::pool::Asset,
    ) -> Option<blend_contract_sdk::pool::PriceData> {
        // Everything is worth exactly 1.0; relative prices are irrelevant here, only that a price
        // exists so the pool will let a position be opened.
        Some(blend_contract_sdk::pool::PriceData {
            price: 1_0000000,
            timestamp: env.ledger().timestamp(),
        })
    }
}

struct BlendEnv<'a> {
    env: Env,
    adapter: BlendAdapterClient<'a>,
    underlying: Address,
    owner: Address,
    supplier: Address,
    pool_id: Address,
    deployer: Address,
}

/// Stand up Blend, a pool with one reserve, and an adapter bound to it.
fn setup() -> BlendEnv<'static> {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    // The DEFAULT budget, not an unlimited one.
    //
    // This fixture stands up the real Blend protocol from its shipped WASM and runs our adapter
    // against it, so it is the only place the real cross-contract cost is observable at all — and
    // it was running with the budget switched off, which meant the entire Blend path had no cost
    // bound anywhere. The router's `a_yield_withdrawal_fits_in_the_mainnet_cpu_budget` measures the
    // MOCK venue, so it says nothing about Blend.
    //
    // Measured when tightening this: all 21 tests pass under the default budget, so nothing was
    // being hidden — but nothing was being enforced either, and a regression in the Blend path
    // would have been invisible until a live submission.
    env.cost_estimate().budget().reset_default();

    let deployer = Address::generate(&env);
    let blnd = env
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();
    let usdc = env
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();
    let blend = BlendFixture::deploy(&env, &deployer, &blnd, &usdc);
    let oracle = env.register(MockOracle, ());

    let underlying = env
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();

    let pool = blend.pool_factory.deploy(
        &deployer,
        &SString::from_str(&env, "pp-yield"),
        &BytesN::<32>::random(&env),
        &oracle,
        &0_1000000,
        &4,
        &1_0000000,
    );
    let pool_client = blend_contract_sdk::pool::Client::new(&env, &pool);
    pool_client.queue_set_reserve(&underlying, &default_reserve_config());
    pool_client.set_reserve(&underlying);

    blend.backstop.deposit(&deployer, &pool, &50_000_0000000);
    pool_client.set_status(&3);
    pool_client.update_status();

    // The wrapper is the only caller allowed to move value; here a plain address stands in for it.
    let owner = Address::generate(&env);
    let supplier = Address::generate(&env);
    StellarAssetClient::new(&env, &underlying).mint(&supplier, &(10_000 * ONE));

    let adapter_id = env.register(BlendAdapter, ());
    let adapter = BlendAdapterClient::new(&env, &adapter_id);
    adapter.initialize(&owner, &pool, &underlying);

    BlendEnv {
        env,
        adapter,
        underlying,
        owner,
        supplier,
        pool_id: pool,
        deployer,
    }
}

#[test]
fn an_empty_position_is_worth_nothing() {
    let b = setup();
    assert_eq!(b.adapter.position_value(), 0);
}

#[test]
fn supplying_credits_the_position_with_what_was_supplied() {
    // The headline check: real bTokens, real b_rate, real reserve index. If SCALAR_12 were wrong —
    // and Blend v1 used SCALAR_9 for this exact field — the value would be off by 1000x here.
    let b = setup();
    let amount = 100 * ONE;

    let delta = b.adapter.supply(&b.supplier, &amount);
    assert_eq!(delta, amount, "a fresh supply credits its face value");
    assert_eq!(b.adapter.position_value(), amount);
}

#[test]
fn the_position_is_reported_in_underlying_not_in_btokens() {
    // bTokens and underlying coincide only while b_rate is exactly 1.0. Asserting the round figure
    // above could pass against a raw bToken count; this pins that the conversion is applied.
    let b = setup();
    b.adapter.supply(&b.supplier, &(100 * ONE));

    let pool = blend_contract_sdk::pool::Client::new(&b.env, &b.adapter.pool());
    let reserve = pool.get_reserve(&b.underlying);
    let positions = pool.get_positions(&b.adapter.address);
    let b_tokens = positions.supply.get(reserve.config.index).unwrap_or(0);

    assert_eq!(
        b.adapter.position_value(),
        b_tokens * reserve.data.b_rate / 1_000_000_000_000,
        "must equal Blend's own to_asset_from_b_token"
    );
}

#[test]
fn withdrawing_returns_underlying_to_the_recipient_and_reduces_the_position() {
    let b = setup();
    b.adapter.supply(&b.supplier, &(100 * ONE));

    let recipient = Address::generate(&b.env);
    let removed = b.adapter.withdraw(&recipient, &(40 * ONE));

    assert_eq!(removed, 40 * ONE);
    assert_eq!(b.adapter.underlying_balance(&recipient), 40 * ONE);
    assert_eq!(b.adapter.position_value(), 60 * ONE);
}

/// SURVIVOR CLOSED (second attempt): deleting `owner.require_auth()` left every test green.
///
/// Two earlier versions of this test failed to distinguish anything:
///
/// 1. `env.set_auths(&[])` does not revoke `mock_all_auths` — once enabled it stays in force — so
///    the assertion was measuring some unrelated failure.
/// 2. `env.mock_auths(&[])` genuinely revokes, but then `supply` fails on the depositor's token
///    transfer before it ever reaches the gate. With no authorization at all, everything fails, so
///    "it failed" proves nothing about WHY.
///
/// `withdraw` is the leg that isolates the gate: the adapter is its own spender there, so the
/// owner's authorization is the ONLY external one the call needs. Gate present, this is refused;
/// gate deleted, the adapter authorizes its own submit and the withdrawal goes through. That
/// difference is what makes the test worth having.
///
/// This is the `is_err()`-for-the-wrong-reason trap in the repo's Lessons Learned, hit twice in a
/// row, and only mutation exposed it either time.
#[test]
fn only_the_owning_wrapper_may_withdraw() {
    let b = setup();
    b.adapter.supply(&b.supplier, &(100 * ONE));

    let thief = Address::generate(&b.env);
    b.env.mock_auths(&[]);

    assert!(
        b.adapter.try_withdraw(&thief, &(50 * ONE)).is_err(),
        "an unauthorized withdraw must be refused"
    );
    assert_eq!(
        b.adapter.underlying_balance(&thief),
        0,
        "and must move nothing"
    );
    assert_eq!(
        b.adapter.position_value(),
        100 * ONE,
        "the position is untouched"
    );
    let _ = &b.owner;
}

/// And the converse, so the test above cannot pass merely because everything fails: with the
/// owner's authorization present, the same calls succeed.
#[test]
fn the_owning_wrapper_itself_is_permitted() {
    let b = setup();
    assert_eq!(b.adapter.supply(&b.supplier, &(10 * ONE)), 10 * ONE);
}

#[test]
fn a_non_positive_amount_is_rejected_on_both_legs() {
    let b = setup();
    assert!(matches!(
        b.adapter.try_supply(&b.supplier, &0),
        Err(Ok(AdapterError::InvalidAmount))
    ));
    assert!(matches!(
        b.adapter.try_withdraw(&b.supplier, &-1),
        Err(Ok(AdapterError::InvalidAmount))
    ));
}

#[test]
fn a_second_supply_credits_only_its_own_delta() {
    // C-7. The figure returned must be attributable to THIS call, never the resulting position.
    let b = setup();
    b.adapter.supply(&b.supplier, &(100 * ONE));
    let delta = b.adapter.supply(&b.supplier, &(25 * ONE));
    assert_eq!(
        delta,
        25 * ONE,
        "the second call must not be credited the whole position"
    );
}

/// Does the credited delta ever fall short of the amount supplied?
///
/// `position_value` floors, and Blend's own `to_b_token_down` floors when converting underlying to
/// bTokens, so two floors sit between the amount a caller hands over and the position it produces.
/// Whether that actually loses anything is a question about the real pool, not about my reasoning,
/// so this measures it across awkward sizes instead of arguing about it.
#[test]
fn measure_whether_supply_ever_credits_less_than_it_was_given() {
    let b = setup();
    let mut worst = 0i128;
    for amount in [
        1i128,
        3,
        7,
        99,
        1_001,
        12_345,
        999_999,
        ONE + 1,
        7 * ONE + 3,
        123_456_789,
    ] {
        let before = b.adapter.position_value();
        let delta = b.adapter.supply(&b.supplier, &amount);
        let after = b.adapter.position_value();

        assert_eq!(
            delta,
            after - before,
            "the reported delta must be the real one"
        );
        let shortfall = amount - delta;
        if shortfall > worst {
            worst = shortfall;
        }
    }
    // `worst == 0` here ONLY because this fixture has no borrower, so utilisation is zero and
    // `b_rate` is pinned at exactly 1.0, where both floors are identities. Measured under real
    // utilisation (see `the_supply_delta_is_exact_even_after_b_rate_has_moved`) the shortfall is
    // one stroop per supply. Asserting 0 as a general property would be false; asserting it for
    // THIS fixture documents the boundary of what the fixture can see.
    assert_eq!(
        worst, 0,
        "at b_rate == 1.0 the conversion is an identity and the delta must be exact"
    );
}

/// Emissions must be claimable, and only by the owning wrapper.
///
/// Before this existed, BLND accrued to the adapter's Blend position was unreachable by ANY address
/// — the wrapper's rescue_token moves the wrapper's balances, not the adapter's. The value was
/// simply stranded.
#[test]
fn emissions_are_claimable_by_the_owner_and_nobody_else() {
    let b = setup();
    b.adapter.supply(&b.supplier, &(100 * ONE));
    let treasury = Address::generate(&b.env);

    // With no emissions configured this claims zero — what matters is that the path EXISTS and is
    // reachable, which it previously was not, and that it is gated.
    let claimed = b
        .adapter
        .claim_emissions(&soroban_sdk::vec![&b.env, 0u32], &treasury);
    assert!(claimed >= 0);

    b.env.mock_auths(&[]);
    assert!(
        b.adapter
            .try_claim_emissions(&soroban_sdk::vec![&b.env, 0u32], &treasury)
            .is_err(),
        "an unauthorized claim must be refused"
    );
}

/// CRITICAL: anyone could re-initialize the adapter and take the position.
///
/// `initialize` had no authorization and no one-shot guard — the only contract of the seven in this
/// port lacking one. An attacker calls it a second time naming themselves owner, and `require_owner`
/// then loads THEM; `withdraw` drains the whole Blend position. One unsigned, unprivileged call.
///
/// Mutation could not have found this: it deletes guards, and this guard was never written.
#[test]
fn the_adapter_cannot_be_re_initialized_and_seized() {
    let b = setup();
    b.adapter.supply(&b.supplier, &(100 * ONE));
    assert_eq!(b.adapter.position_value(), 100 * ONE);

    let attacker = Address::generate(&b.env);
    let r = b
        .adapter
        .try_initialize(&attacker, &b.adapter.pool(), &b.underlying);
    assert!(
        matches!(r, Err(Ok(AdapterError::AlreadyInitialized))),
        "a second initialize must be refused, got {r:?}"
    );

    // And the position is still the wrapper's.
    assert_eq!(b.adapter.position_value(), 100 * ONE);
    assert_eq!(b.adapter.underlying_balance(&attacker), 0);
}

/// Does `b_rate` drift between the two `position_value` reads that bracket `pool.submit`?
///
/// Both legs compute a delta across `submit`, which is what makes donation-sweeping impossible
/// (EVM audit C-7). Its correctness rests entirely on whether `get_reserve` returns a `b_rate`
/// already accrued to the current ledger, or the last STORED one. If it returns the stored rate,
/// `submit` persists an accrual and `after` is computed at a higher rate than `before` — so the
/// delta is polluted by interest that accrued on the PRE-EXISTING position, and a depositor is
/// credited with other holders' yield.
///
/// Settling this needed two things the suite did not have: a working **oracle** (the stock fixture
/// wires a generated address, so any priced call traps) and therefore a **borrower**, since with
/// zero utilisation there is no interest and `b_rate` is pinned at 1.0 forever. Every other test in
/// this file runs in that frozen world, which is why the question was open.
#[test]
fn the_supply_delta_is_exact_even_after_b_rate_has_moved() {
    let b = setup();
    let pool = blend_contract_sdk::pool::Client::new(&b.env, &b.pool_id);

    // The adapter takes a position first, so any drift has something to be stolen from.
    b.adapter.supply(&b.supplier, &(1_000 * ONE));
    let rate_start = pool.get_reserve(&b.underlying).data.b_rate;

    // Create utilisation: a borrower posts collateral and draws against it.
    let borrower = Address::generate(&b.env);
    StellarAssetClient::new(&b.env, &b.underlying).mint(&borrower, &(5_000 * ONE));
    pool.submit(
        &borrower,
        &borrower,
        &borrower,
        &soroban_sdk::vec![
            &b.env,
            Request {
                request_type: 2,
                address: b.underlying.clone(),
                amount: 2_000 * ONE
            },
            Request {
                request_type: 4,
                address: b.underlying.clone(),
                amount: 500 * ONE
            },
        ],
    );

    // Let interest accrue on that borrow for a year.
    b.env
        .ledger()
        .set_timestamp(b.env.ledger().timestamp() + 365 * 24 * 60 * 60);

    let rate_moved = pool.get_reserve(&b.underlying).data.b_rate;
    assert!(
        rate_moved > rate_start,
        "the fixture must actually move b_rate or this test proves nothing: {rate_start} -> {rate_moved}"
    );

    // NOW the question has teeth: does a fresh supply get credited only its own amount?
    let before = b.adapter.position_value();
    let credited = b.adapter.supply(&b.supplier, &(100 * ONE));
    let after = b.adapter.position_value();

    assert_eq!(
        credited,
        after - before,
        "the reported delta must be the real one"
    );
    // MEASURED: b_rate moved 1.000000000000 -> 1.003166680000 over the year, and supplying
    // 1_000_000_000 stroops credited 999_999_999 — one stroop LESS, never more. So `get_reserve`
    // accrues on read, both reads see the same rate, and no pre-existing interest leaks to the
    // depositor. The audit flagged the opposite as possible; this settles it by experiment.
    //
    // The one-stroop shortfall is the double floor, and it is exactly why the wrapper prices shares
    // on `credited` rather than on the requested amount — otherwise that stroop would be
    // socialized across existing holders on every deposit.
    assert!(
        credited <= 100 * ONE,
        "a supply must never be credited MORE than it supplied — the excess would be other \
         holders' accrued interest handed to this depositor (b_rate {rate_start} -> {rate_moved}, \
         credited {credited} for 100 units)"
    );

    let recipient = Address::generate(&b.env);
    let removed = b.adapter.withdraw(&recipient, &(50 * ONE));
    assert!(
        removed >= 50 * ONE,
        "a withdrawal must remove at least what was asked, or the wrapper's shortfall guard \
         fires spuriously on every withdrawal after an idle period: removed {removed}"
    );
    let _ = &b.deployer;
}

/// Can the LAST holder get out?
///
/// Blend deletes the supply entry when a position reaches zero. The `PositionMissing` guard — added
/// so a venue that stops reporting a live position fails loudly instead of silently pricing every
/// share at zero — cannot tell that apart from a legitimate full exit. So draining the position
/// exactly reverts, while draining it minus one stroop succeeds: the vault's last redeemer is
/// trapped, and so is any full migration.
///
/// The exact-cap case, on the side no suite tests.
#[test]
fn the_entire_position_can_be_withdrawn() {
    let b = setup();
    b.adapter.supply(&b.supplier, &(100 * ONE));
    let position = b.adapter.position_value();

    let recipient = Address::generate(&b.env);
    let removed = b.adapter.withdraw(&recipient, &position);

    assert_eq!(removed, position, "the whole position must be withdrawable");
    assert_eq!(b.adapter.underlying_balance(&recipient), position);
    assert_eq!(
        b.adapter.position_value(),
        0,
        "and the position reads as empty afterwards"
    );
}

// ---------------------------------------------------------------- authorization, exhaustively

/// The owner gate must check the OWNER, not merely "somebody".
///
/// The previous test asserted `is_err()` under `mock_auths(&[])`, where everything fails. That
/// could not distinguish an owner-gated call from one gated on any other stored address: rewriting
/// `require_owner` to load `DataKey::Pool` instead of `DataKey::Owner` — a guard on the WRONG
/// predicate — left the whole suite green. Deletion-style mutation cannot see that class at all,
/// because the guard is still there and still fires.
///
/// Granting a stranger authorization for exactly the call under test separates the two: with the
/// gate on the right predicate the call fails, and the paired control granting the real owner
/// succeeds.
mod authorization {
    use super::*;
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal;

    macro_rules! as_only {
        ($b:expr, $who:expr, $fn_name:literal, $args:expr) => {
            $b.adapter.mock_auths(&[MockAuth {
                address: $who,
                invoke: &MockAuthInvoke {
                    contract: &$b.adapter.address,
                    fn_name: $fn_name,
                    args: $args,
                    sub_invokes: &[],
                },
            }])
        };
    }

    #[test]
    fn only_the_owner_may_withdraw() {
        let b = setup();
        b.adapter.supply(&b.supplier, &(100 * ONE));
        let thief = Address::generate(&b.env);

        let args = (thief.clone(), 50 * ONE).into_val(&b.env);
        assert!(as_only!(b, &thief, "withdraw", args)
            .try_withdraw(&thief, &(50 * ONE))
            .is_err());
        assert_eq!(b.adapter.underlying_balance(&thief), 0, "and moves nothing");
        assert_eq!(b.adapter.position_value(), 100 * ONE, "position untouched");

        // Control: the real owner's authorization works.
        let args2 = (thief.clone(), 50 * ONE).into_val(&b.env);
        assert_eq!(
            as_only!(b, &b.owner, "withdraw", args2).withdraw(&thief, &(50 * ONE)),
            50 * ONE
        );
    }

    #[test]
    fn only_the_owner_may_supply() {
        let b = setup();
        let stranger = Address::generate(&b.env);

        let args = (b.supplier.clone(), 10 * ONE).into_val(&b.env);
        assert!(as_only!(b, &stranger, "supply", args)
            .try_supply(&b.supplier, &(10 * ONE))
            .is_err());
        assert_eq!(b.adapter.position_value(), 0);
    }

    #[test]
    fn only_the_owner_may_claim_emissions() {
        let b = setup();
        let stranger = Address::generate(&b.env);
        let ids = soroban_sdk::vec![&b.env, 0u32];

        let args = (ids.clone(), stranger.clone()).into_val(&b.env);
        assert!(as_only!(b, &stranger, "claim_emissions", args)
            .try_claim_emissions(&ids, &stranger)
            .is_err());

        let args2 = (ids.clone(), b.owner.clone()).into_val(&b.env);
        assert_eq!(
            as_only!(b, &b.owner, "claim_emissions", args2).claim_emissions(&ids, &b.owner),
            0
        );
    }
}

// ============================================================ the live rate regime, measured

/// The highest `b_rate` observed on Blend's testnet pool, 2026-08-25.
///
/// Recorded in `docs/deployments.testnet.blend.json`: the four live reserves sit at 1.056 (USDC),
/// 1.847 (XLM), 2.901 (wBTC) and 4.645 (wETH). This constant is the wETH figure, rounded down.
const LIVE_MAX_B_RATE: i128 = 4_645_000_000_000;

/// Drive the reserve's `b_rate` to at least `target`, and assert it got there.
///
/// **Why a second rate helper.** The existing moved-rate tests reach `b_rate` 1.0032 — one year at
/// low utilisation. That is the right *sign* of effect and the wrong *regime*. Every conversion this
/// adapter performs floors in bToken space, and one bToken is `b_rate` underlying stroops, so the
/// rounding loss the whole suite was written to characterise scales linearly with `b_rate`. At
/// 1.0032 it is one stroop and reads like an off-by-one; at the live 4.645 it is four or five, and
/// any test that hard-codes "at most one stroop" is asserting a property of the fixture rather than
/// of the code. Reserves that have been live for years are the normal case, not the exotic one — a
/// vault deployed against wETH meets 4.645 on its first deposit.
///
/// Blend accrues on read from `last_time`, so advancing the ledger clock is enough; the borrower is
/// only needed because with zero utilisation there is no interest at all. The loop does not touch
/// the pool between jumps: once enough interest has accrued the borrower is no longer healthy, and
/// any `submit` from them fails the position check (#1216) rather than the rate check.
fn drive_b_rate_to(env: &Env, pool_id: &Address, underlying: &Address, target: i128) -> i128 {
    let pool = blend_contract_sdk::pool::Client::new(env, pool_id);
    let borrower = Address::generate(env);
    StellarAssetClient::new(env, underlying).mint(&borrower, &(50_000 * ONE));
    pool.submit(
        &borrower,
        &borrower,
        &borrower,
        &soroban_sdk::vec![
            &env.clone(),
            Request {
                request_type: 2,
                address: underlying.clone(),
                amount: 50_000 * ONE
            },
            // Half the collateral: the default reserve config's c_factor and l_factor are both
            // 0.75, so 0.5625 is the most that can be drawn and stay healthy.
            Request {
                request_type: 4,
                address: underlying.clone(),
                amount: 25_000 * ONE
            },
        ],
    );

    for _ in 0..64 {
        if pool.get_reserve(underlying).data.b_rate >= target {
            break;
        }
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 10 * 365 * 24 * 60 * 60);
    }

    let rate = pool.get_reserve(underlying).data.b_rate;
    assert!(
        rate >= target,
        "the fixture must reach b_rate {target} or this test says nothing about the live regime: \
         reached {rate}"
    );
    rate
}

/// The supply delta stays exact at the highest `b_rate` any live Blend reserve is running.
///
/// Same invariant as `the_supply_delta_is_exact_even_after_b_rate_has_moved`, four and a half times
/// further from 1.0 — and with the rounding loss asserted against a bound DERIVED from `b_rate`
/// rather than against the single stroop the 1.0032 fixture happens to produce.
#[test]
fn the_supply_delta_is_exact_at_the_live_maximum_b_rate() {
    let b = setup();
    b.adapter.supply(&b.supplier, &(1_000 * ONE));
    let rate = drive_b_rate_to(&b.env, &b.pool_id, &b.underlying, LIVE_MAX_B_RATE);

    let before = b.adapter.position_value();
    let credited = b.adapter.supply(&b.supplier, &(100 * ONE));
    let after = b.adapter.position_value();

    assert_eq!(
        credited,
        after - before,
        "the reported delta must be the real one at b_rate {rate}"
    );
    assert!(
        credited <= 100 * ONE,
        "a supply must never be credited MORE than it supplied: credited {credited} at b_rate {rate}"
    );

    // The double floor can cost at most one bToken, and one bToken is `b_rate` underlying stroops.
    // Asserting that bound rather than a literal is what makes this test regime-independent: if the
    // conversion ever loses a PROPORTION instead of a remainder, this fails no matter the rate.
    let lost = 100 * ONE - credited;
    let one_b_token = rate / SCALAR_12 + 1;
    assert!(
        lost <= one_b_token,
        "at b_rate {rate} the floor may cost at most one bToken ({one_b_token} stroops); lost {lost}"
    );
}

/// A full round trip at the live maximum rate must not lose more than the rounding bound.
///
/// At `b_rate` 1.0 every conversion is an identity, so a deposit-then-withdraw round trip could
/// never have shown a proportional loss. Here each leg floors in a different direction.
#[test]
fn a_round_trip_at_the_live_maximum_b_rate_loses_only_rounding() {
    let b = setup();
    b.adapter.supply(&b.supplier, &(1_000 * ONE));
    let rate = drive_b_rate_to(&b.env, &b.pool_id, &b.underlying, LIVE_MAX_B_RATE);

    let before = b.adapter.position_value();
    let credited = b.adapter.supply(&b.supplier, &(500 * ONE));
    let recipient = Address::generate(&b.env);
    let removed = b.adapter.withdraw(&recipient, &credited);
    let after = b.adapter.position_value();

    assert!(
        removed >= credited,
        "a withdrawal must remove at least what was asked, or the wrapper's shortfall guard fires \
         on every exit at a live rate: asked {credited}, removed {removed}, b_rate {rate}"
    );
    let bound = 2 * (rate / SCALAR_12 + 1);
    let drift = (after - before).abs();
    assert!(
        drift <= bound,
        "a round trip must return the position to within two bTokens ({bound} stroops) at b_rate \
         {rate}: {before} -> {after}"
    );
}

// ================================================================ the real wrapper, the real venue

/// `YieldToken` over a real `BlendAdapter` — the seam neither crate had ever crossed.
///
/// All 68 wrapper tests and all 35 router tests run over `MockVenue`; the Blend adapter was only
/// ever exercised in isolation. So the wrapper's entire conversion stack had never seen a position
/// that FLOORS — which real bToken conversion does routinely — and the one-stroop supply shortfall
/// this crate measured at a moved `b_rate` was never fed to the code that prices shares off it.
///
/// The dev-dependency for this was already in Cargo.toml, unused: wired for exactly this test, and
/// the test never written.
mod real_wrapper {
    use super::*;
    use yield_token::{YieldToken, YieldTokenClient};

    struct Real<'a> {
        env: Env,
        token: YieldTokenClient<'a>,
        adapter: BlendAdapterClient<'a>,
        pool_id: Address,
        underlying: Address,
        admin: Address,
        user: Address,
    }

    /// Same Blend rig as `setup()`, but with the adapter owned by a real wrapper.
    fn setup_wrapped() -> Real<'static> {
        let b = setup();
        // A second adapter, this time owned by the wrapper rather than a stand-in account.
        let token_id = b.env.register(YieldToken, ());
        let adapter_id = b.env.register(BlendAdapter, ());
        BlendAdapterClient::new(&b.env, &adapter_id).initialize(
            &token_id,
            &b.pool_id,
            &b.underlying,
        );

        let token = YieldTokenClient::new(&b.env, &token_id);
        token.initialize(
            &b.deployer,
            &adapter_id,
            &0i128,
            &4u32,
            &7u32,
            &soroban_sdk::String::from_str(&b.env, "Privacy Pool USDC"),
            &soroban_sdk::String::from_str(&b.env, "ppUSDC"),
            &b.supplier,
        );

        let adapter = BlendAdapterClient::new(&b.env, &adapter_id);
        Real {
            env: b.env,
            token,
            adapter,
            pool_id: b.pool_id,
            underlying: b.underlying,
            admin: b.deployer,
            user: b.supplier,
        }
    }

    #[test]
    fn a_real_wrapper_over_a_real_blend_position_round_trips() {
        let r = setup_wrapped();
        let before = soroban_sdk::token::TokenClient::new(&r.env, &r.underlying).balance(&r.user);

        let shares = r.token.deposit(&r.user, &r.user, &(100 * ONE));
        assert!(shares > 0);
        assert!(r.adapter.position_value() >= 100 * ONE);

        let out = r.token.redeem(&r.user, &r.user, &shares);
        let after = soroban_sdk::token::TokenClient::new(&r.env, &r.underlying).balance(&r.user);

        // Floors mean a stroop or two can be lost to rounding; nothing more.
        assert!(out > 0);
        assert!(
            before - after <= 10,
            "a round trip through a real venue must not lose materially: {before} -> {after}"
        );
        assert_eq!(
            r.token.total_supply(),
            yield_token::DEAD_SHARES,
            "only the dead-share seed remains"
        );
    }

    /// The one-stroop shortfall this crate measured must not break the exact-output mint.
    ///
    /// `deposit_inner` rejects `credited < assets` with `VenueShortfall`. Against real Blend at a
    /// moved `b_rate` the double floor makes `credited` systematically one stroop short — so if the
    /// wrapper is too strict, EVERY exact mint (the router's whole deposit leg) reverts on a live
    /// network, and no mock could show it.
    #[test]
    fn an_exact_mint_survives_a_moved_b_rate() {
        let r = setup_wrapped();
        r.token.deposit(&r.user, &r.user, &(1_000 * ONE));

        // Create utilisation and let a year of interest accrue, so b_rate leaves 1.0.
        let pool = blend_contract_sdk::pool::Client::new(&r.env, &r.pool_id);
        let borrower = Address::generate(&r.env);
        StellarAssetClient::new(&r.env, &r.underlying).mint(&borrower, &(5_000 * ONE));
        pool.submit(
            &borrower,
            &borrower,
            &borrower,
            &soroban_sdk::vec![
                &r.env,
                Request {
                    request_type: 2,
                    address: r.underlying.clone(),
                    amount: 2_000 * ONE
                },
                Request {
                    request_type: 4,
                    address: r.underlying.clone(),
                    amount: 500 * ONE
                },
            ],
        );
        r.env
            .ledger()
            .set_timestamp(r.env.ledger().timestamp() + 365 * 24 * 60 * 60);
        assert!(
            pool.get_reserve(&r.underlying).data.b_rate > 1_000_000_000_000,
            "the fixture must move b_rate or this proves nothing"
        );

        // The router's deposit leg is exactly this call.
        let target = 10 * ONE;
        let res = r.token.try_mint(&r.user, &r.user, &target);
        assert!(
            res.is_ok(),
            "an exact mint must survive real bToken rounding: {res:?}"
        );
        assert_eq!(r.token.balance(&r.user) >= target, true);
    }

    /// The exact-output mint — the router's whole deposit leg — over a RANGE of share targets.
    ///
    /// The first version of this test asserted a single target and passed. That result was a
    /// coincidence of one value. Measured across 30 targets, exact mints succeed 0-2 times out of 30
    /// at every `b_rate` above 1.0, and `mint(10 * ONE)` — the literal this test and
    /// `an_exact_mint_survives_a_moved_b_rate` both used — succeeds at 4.765 and fails at 1.188,
    /// 2.129 and every rate between. A single-value assertion here is a coin flip reported as a
    /// proof. The claim is "the deposit leg works on a reserve that has accrued interest", and that
    /// is a claim about the input space, not about one input.
    ///
    /// `deposit` (variable output) is unaffected — 30/30 at every rate — so this is specific to the
    /// exact-output path, which is the one the router uses.
    #[test]
    fn exact_mints_survive_the_live_maximum_b_rate_across_the_input_range() {
        let r = setup_wrapped();
        r.token.deposit(&r.user, &r.user, &(1_000 * ONE));
        let rate = drive_b_rate_to(&r.env, &r.pool_id, &r.underlying, LIVE_MAX_B_RATE);

        let mut failed = 0;
        // Keep the FIRST failure, not just the count. `is_err()` alone reports "30/30 reverted"
        // without saying whether that was VenueShortfall, a paused vault or an unreachable venue —
        // three very different bugs (MOL-5). The count is the assertion; the cause is the diagnosis.
        let mut first: Option<(i128, Result<yield_token::Error, soroban_sdk::InvokeError>)> = None;
        for k in 0..30i128 {
            let target = 5 * ONE + k * 17;
            if let Err(e) = r.token.try_mint(&r.user, &r.user, &target) {
                failed += 1;
                if first.is_none() {
                    first = Some((target, e));
                }
            }
        }
        assert_eq!(
            failed, 0,
            "the router's deposit leg must work on a reserve that has accrued interest: \
             {failed}/30 exact mints reverted at b_rate {rate}; first was mint({}) -> {:?}",
            first.as_ref().map(|f| f.0).unwrap_or(0),
            first.as_ref().map(|f| f.1),
        );
    }


    /// The EXIT paths at the live maximum `b_rate` — the mirror of the deposit-leg bug.
    ///
    /// `withdraw` names an exact asset amount and rejects a short delivery with `VenueShortfall`,
    /// which is structurally the same promise `mint` makes about shares. That one turned out to be
    /// unkeepable against a flooring venue for 28-30 of every 30 inputs, so this one cannot be
    /// assumed — and an exit that reverts is strictly worse than a deposit that reverts, because it
    /// is a vault nobody can leave.
    ///
    /// MEASURED: 30/30 for both `withdraw` and `redeem` at `b_rate` 4.765. The asymmetry is real
    /// rather than lucky — Blend burns `ceil(amount / b_rate)` bTokens on a withdrawal, so it never
    /// under-delivers the named amount, while `supply` floors and therefore does under-credit. The
    /// buffer belongs on the deposit side only, and this test is what says so.
    #[test]
    fn both_exit_paths_survive_the_live_maximum_b_rate_across_the_input_range() {
        let r = setup_wrapped();
        r.token.deposit(&r.user, &r.user, &(1_000 * ONE));
        let rate = drive_b_rate_to(&r.env, &r.pool_id, &r.underlying, LIVE_MAX_B_RATE);

        let mut failed = 0;
        for k in 0..30i128 {
            if r.token
                .try_withdraw(&r.user, &r.user, &(2 * ONE + k * 13))
                .is_err()
            {
                failed += 1;
            }
        }
        assert_eq!(
            failed, 0,
            "exact-amount withdrawal must work on a mature reserve: {failed}/30 reverted at \
             b_rate {rate}"
        );

        let mut failed = 0;
        for k in 0..30i128 {
            if r.token.try_redeem(&r.user, &r.user, &(ONE + k * 7)).is_err() {
                failed += 1;
            }
        }
        assert_eq!(
            failed, 0,
            "redemption must work on a mature reserve: {failed}/30 reverted at b_rate {rate}"
        );
    }

}

/// The `HasSupplied` lifecycle: a full exit must clear it, and a re-supply must re-arm it.
///
/// The flag is what lets `position_value` tell "never supplied" apart from "supplied and the venue
/// has stopped reporting" — the second being an unrecoverable silent lock of the vault above. Both
/// halves were untested: nothing asserted the flag cleared after a full exit (a stale flag makes the
/// NEXT ordinary read fail), and nothing supplied again afterwards, so "the guard re-arms" was an
/// unverified claim in a comment.
#[test]
fn a_full_exit_clears_the_supplied_flag_and_a_re_supply_re_arms_it() {
    let b = setup();
    let recipient = Address::generate(&b.env);

    b.adapter.supply(&b.supplier, &(100 * ONE));
    b.adapter.withdraw(&recipient, &b.adapter.position_value());

    // Cleared: an ordinary read of a genuinely empty position must return 0, not an error.
    assert_eq!(
        b.adapter.position_value(),
        0,
        "a fully-exited position reads as empty, not as missing"
    );

    // Re-armed: the whole cycle works again.
    b.adapter.supply(&b.supplier, &(50 * ONE));
    assert_eq!(b.adapter.position_value(), 50 * ONE);
    assert_eq!(b.adapter.withdraw(&recipient, &(50 * ONE)), 50 * ONE);
    assert_eq!(b.adapter.position_value(), 0);
}

/// Over-withdrawing is CLAMPED by Blend, and the adapter must report the clamped figure.
///
/// MEASURED, not assumed: asking for `position + 1` delivers exactly the position, empties it, and
/// returns 1_000_000_000 for a 1_000_000_001 request. My first version of this test asserted the
/// call would be REFUSED — it is not.
///
/// The property that matters is therefore not rejection but honesty: the adapter returns what
/// actually moved, so `withdraw_inner`'s `delivered` is trustworthy. `YieldToken::withdraw`, which
/// names an exact amount, then rejects the shortfall itself; `redeem` reports it.
#[test]
fn over_withdrawing_is_clamped_and_reported_honestly() {
    let b = setup();
    b.adapter.supply(&b.supplier, &(100 * ONE));
    let recipient = Address::generate(&b.env);

    let removed = b.adapter.withdraw(&recipient, &(100 * ONE + 1));

    assert_eq!(
        removed,
        100 * ONE,
        "the reported figure is what MOVED, not what was asked"
    );
    assert_eq!(b.adapter.underlying_balance(&recipient), 100 * ONE);
    assert_eq!(b.adapter.position_value(), 0);
}

/// `underlying()` had no test at all.
#[test]
fn the_adapter_reports_the_asset_it_was_initialized_with() {
    let b = setup();
    assert_eq!(b.adapter.underlying(), b.underlying);
}

// NO test of the `PositionMissing` branch, and the reason is that it is UNREACHABLE against the
// deployed Blend WASM — established by trying, not by assuming.
//
// The branch fires when `HasSupplied` is set AND the supply entry is absent. With real Blend that
// needs the reserve index our entry is keyed under to move, and Blend refuses a duplicate index
// (`set_reserve` traps with error #1203), so a second reserve cannot displace ours. The only other
// route to an absent entry is a full exit, which the tolerant read in `withdraw` handles by clearing
// the flag — that path IS tested.
//
// The scenarios the guard exists for — a Blend upgrade that re-indexes reserves, a migration to the
// collateral map, an adapter pointed at the wrong underlying after a redeploy — are venue-side
// changes no test in this repo can induce.
//
// Consequence, stated so a clean sweep is not misread: three mutants in
// `agents/mutation/sweep_yield_blend_adapter.py` legitimately SURVIVE — deleting the
// `PositionMissing` branch, deleting the `HasSupplied` write, and deleting `removed <= 0` (the
// availability check at the top of `withdraw` rejects first, so the delta is never non-positive).
// They are kept because the failure they prevent is unrecoverable: a live position reported as zero
// prices every share at zero and locks the vault with the funds inside it, reachable by nobody.

