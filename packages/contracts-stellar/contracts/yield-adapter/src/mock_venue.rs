//! A test venue: a real adapter over a real SAC token, with venue behaviour we can drive.
//!
//! This is not a stub that echoes its arguments back. It moves actual tokens, holds an actual
//! position, and can be told to accrue yield or to run short of liquidity. That distinction is the
//! point: a stub kills the same mutant a real dependency would, so a suite written only against a
//! stub reports coverage it does not have (TEST-10/TEST-11). The illiquidity lever exists because
//! partial fills are the venue behaviour the wrapper's accounting is most likely to get wrong, and
//! no amount of happy-path mocking reaches it.

use crate::AdapterError;
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};

fn env_ref(e: &Env) -> &Env {
    e
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The wrapper allowed to move value through this adapter.
    Owner,
    /// The underlying SAC token.
    Underlying,
    /// Underlying the venue will refuse to release, simulating illiquidity.
    Locked,
    /// Whether `position_value` should fail outright.
    Broken,
    /// Underlying a single supply understates by, simulating a venue that floors.
    SupplyBuffer,
    /// The position, tracked explicitly.
    ///
    /// A real venue's position is NOT its token holdings — a supply fee it keeps sits in its
    /// balance without being credited to the supplier. Deriving the position from the raw balance
    /// made a kept cut indistinguishable from a credited one, so a supply fee could not be modelled
    /// at all and the wrapper's "the depositor bears their own venue's shortfall" was unexpressible.
    Position,
    /// Fraction (in bps) of each supply/withdraw the venue silently keeps, simulating a venue
    /// fee or a rounding shortfall — i.e. a PARTIAL FILL.
    ShortfallBps,
    SurplusBps,
}

/// A `LendingAdapter` backed by a real token balance.
#[contract]
pub struct MockVenue;

#[contractimpl]
impl MockVenue {
    /// Bind this adapter to its wrapper and underlying asset.
    pub fn initialize(env: Env, owner: Address, underlying: Address) -> Result<(), AdapterError> {
        // Same one-shot guard as the production adapter. A test double that is MORE permissive than
        // the real thing cannot certify the real thing.
        if env.storage().instance().has(&DataKey::Owner) {
            return Err(AdapterError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage()
            .instance()
            .set(&DataKey::Underlying, &underlying);
        env.storage().instance().set(&DataKey::Locked, &0i128);
        Ok(())
    }

    /// Simulate venue yield by minting underlying into the position.
    ///
    /// Test-only. Real accrual happens inside the venue; what the wrapper must handle is simply
    /// that `position_value` rose without any deposit having occurred.
    pub fn accrue(env: Env, from: Address, amount: i128) {
        from.require_auth();
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::Underlying)
            .expect("initialized");
        token::TokenClient::new(&env, &underlying).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        Self::add_position(&env, amount).expect("position");
    }

    /// Simulate a venue loss — a bad-debt socialization or a negative rebase.
    ///
    /// The wrapper must not brick when the position falls below its last checkpoint; that is what
    /// EVM's floor-at-zero in `totalAssets` defends.
    pub fn slash(env: Env, to: Address, amount: i128) {
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::Underlying)
            .expect("initialized");
        token::TokenClient::new(&env, &underlying).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        Self::add_position(&env, amount.checked_neg().expect("neg")).expect("position");
    }

    /// Make every `position_value` fail, simulating a venue that has stopped reporting the
    /// position — a re-indexed reserve, a migration, an upgrade. This is the state that locks the
    /// vault above, so it has to be reachable in a test.
    pub fn set_broken(env: Env, broken: bool) {
        env.storage().instance().set(&DataKey::Broken, &broken);
    }

    /// Withhold `amount` of underlying from withdrawals, simulating illiquidity.
    pub fn set_locked(env: Env, amount: i128) {
        env.storage().instance().set(&DataKey::Locked, &amount);
    }

    /// Make the venue fill only part of each request, keeping `bps` of it.
    ///
    /// Without this the mock could not express a partial fill at all: `supply` transferred exactly
    /// what it was asked for and `withdraw` either filled completely or rejected. So the wrapper
    /// discarding the adapter's returned delta was **equivalent under this mock** — which is how
    /// that defect survived 26 tests and a 16/16 mutation sweep. A mock that cannot produce the
    /// venue behaviour you are defending against certifies nothing about the defence.
    /// Credit MORE than was supplied.
    ///
    /// A venue can hand back more than it was given: an interest tick landing inside the same
    /// frame, a rounding that favours the depositor, a rebasing token. The wrapper's two deposit
    /// paths disagreed about what to do with the excess, and without this lever neither behaviour
    /// was reachable from a test.
    pub fn set_surplus_bps(env: Env, bps: i128) {
        env.storage().instance().set(&DataKey::SurplusBps, &bps);
    }

    pub fn set_shortfall_bps(env: Env, bps: i128) {
        env.storage().instance().set(&DataKey::ShortfallBps, &bps);
    }

    fn raw_position(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Position)
            .unwrap_or(0)
    }

    fn add_position(env: &Env, delta: i128) -> Result<(), AdapterError> {
        let next = Self::raw_position(env)
            .checked_add(delta)
            .ok_or(AdapterError::Overflow)?
            .max(0);
        env.storage().instance().set(&DataKey::Position, &next);
        Ok(())
    }

    fn shortfall(env: &Env, amount: i128) -> i128 {
        let bps: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ShortfallBps)
            .unwrap_or(0);
        if bps <= 0 {
            return 0;
        }
        amount.checked_mul(bps).unwrap_or(0) / 10_000
    }

    fn require_owner(env: &Env) -> Result<(), AdapterError> {
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .ok_or(AdapterError::NotInitialized)?;
        owner.require_auth();
        Ok(())
    }

    fn underlying_addr(env: &Env) -> Result<Address, AdapterError> {
        env.storage()
            .instance()
            .get(&DataKey::Underlying)
            .ok_or(AdapterError::NotInitialized)
    }

    /// See [`crate::LendingAdapter::supply`].
    pub fn supply(env: Env, from: Address, amount: i128) -> Result<i128, AdapterError> {
        Self::require_owner(&env)?;
        if amount <= 0 {
            return Err(AdapterError::InvalidAmount);
        }
        let underlying = Self::underlying_addr(&env)?;
        let client = token::TokenClient::new(&env, &underlying);
        let here = env.current_contract_address();

        // Delta, not the absolute balance (C-7). Measured across the transfer so a donation sitting
        // in the adapter is never attributed to this caller.
        //
        // Both sides must be the POSITION. This read used to be `client.balance(&here)` while
        // `after` was the position, and the units only cancelled while the adapter held nothing but
        // its position. A donation straight into the adapter made `before` exceed `after`, the
        // subtraction went negative, and every deposit reverted with `Overflow` until the position
        // grew past the donation — an unpermissioned, permanent griefing DoS on the vault, inside
        // the very instrument that is supposed to demonstrate C-7 defeating donations.
        // `yield-blend-adapter::supply` takes `position_value` on both sides; so does this now.
        let before = Self::raw_position(&env);
        // A venue that keeps a cut credits less than it was handed, and KEEPS the difference.
        //
        // This used to refund `kept` to `from`, which made the caller whole and therefore made the
        // property the wrapper claims — "the depositor bears their own venue's shortfall" —
        // impossible to express, let alone test. A mock that quietly refunds is a mock that cannot
        // model a supply fee at all.
        // A flooring venue also loses an ABSOLUTE remainder, independent of any proportional fee:
        // Blend converts underlying into bTokens with a floor, so one call credits up to one bToken
        // less than it was handed. `set_shortfall_bps` cannot express that — it is proportional, so
        // it scales away at small amounts, while the flooring loss is the SAME few stroops whatever
        // the size of the supply, and is exactly what broke every exact-output mint on a live
        // reserve. A mock that cannot produce a failure certifies nothing about defending it.
        let floored: i128 = env
            .storage()
            .instance()
            .get(&DataKey::SupplyBuffer)
            .unwrap_or(0i128);
        let kept = Self::shortfall(env_ref(&env), amount)
            .checked_add(floored)
            .unwrap_or(amount)
            .min(amount);
        client.transfer(&from, &here, &amount);
        // The caller paid the full amount; only `amount - kept` is credited to the position. The
        // cut stays in the venue's holdings, exactly as a real supply fee does.
        let bonus: i128 = env
            .storage()
            .instance()
            .get(&DataKey::SurplusBps)
            .unwrap_or(0i128);
        let extra = if bonus > 0 {
            amount.checked_mul(bonus).unwrap_or(0) / 10_000
        } else {
            0
        };
        Self::add_position(
            &env,
            amount
                .checked_sub(kept)
                .unwrap_or(0)
                .checked_add(extra)
                .ok_or(AdapterError::Overflow)?,
        )?;
        let after = Self::raw_position(&env);
        after.checked_sub(before).ok_or(AdapterError::Overflow)
    }

    /// See [`crate::LendingAdapter::withdraw`].
    pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<i128, AdapterError> {
        Self::require_owner(&env)?;
        if amount <= 0 {
            return Err(AdapterError::InvalidAmount);
        }
        let underlying = Self::underlying_addr(&env)?;
        let client = token::TokenClient::new(&env, &underlying);
        let here = env.current_contract_address();

        let locked: i128 = env.storage().instance().get(&DataKey::Locked).unwrap_or(0);
        let balance = Self::raw_position(&env);
        let available = balance.checked_sub(locked).unwrap_or(0).max(0);
        if amount > available {
            return Err(AdapterError::VenueRejected);
        }

        let before = balance;
        // A partial fill: deliver less than asked, and report the smaller figure.
        let short = Self::shortfall(env_ref(&env), amount);
        let filled = amount.checked_sub(short).unwrap_or(amount);
        client.transfer(&here, &to, &filled);
        Self::add_position(&env, filled.checked_neg().ok_or(AdapterError::Overflow)?)?;
        let after = Self::raw_position(&env);
        before.checked_sub(after).ok_or(AdapterError::Overflow)
    }

    /// See [`crate::LendingAdapter::position_value`].
    pub fn position_value(env: Env) -> Result<i128, AdapterError> {
        if env
            .storage()
            .instance()
            .get(&DataKey::Broken)
            .unwrap_or(false)
        {
            return Err(AdapterError::PositionMissing);
        }
        Self::underlying_addr(&env)?;
        Ok(Self::raw_position(&env))
    }

    /// See [`crate::LendingAdapter::claim_emissions`]. The mock venue has no incentive programme,
    /// so this claims nothing — its purpose here is to keep the interface implementable and the
    /// wrapper's pass-through exercised.
    pub fn claim_emissions(
        env: Env,
        _venue_ids: soroban_sdk::Vec<u32>,
        _to: Address,
    ) -> Result<i128, AdapterError> {
        Self::require_owner(&env)?;
        Ok(0)
    }

    /// See [`crate::LendingAdapter::supply_buffer`].
    ///
    /// Zero by default: the mock credits exactly what it is given, which is the whole reason a real
    /// venue's rounding was invisible to 68 wrapper tests. `set_supply_buffer` exists so the
    /// wrapper's buffered path can be exercised without standing up Blend.
    pub fn supply_buffer(env: Env) -> Result<i128, AdapterError> {
        Ok(env
            .storage()
            .instance()
            .get(&DataKey::SupplyBuffer)
            .unwrap_or(0i128))
    }

    /// Test hook: make this mock understate a supply the way a flooring venue does.
    pub fn set_supply_buffer(env: Env, buffer: i128) {
        env.storage()
            .instance()
            .set(&DataKey::SupplyBuffer, &buffer);
    }

    /// See [`crate::LendingAdapter::underlying`].
    pub fn underlying(env: Env) -> Result<Address, AdapterError> {
        Self::underlying_addr(&env)
    }
}
