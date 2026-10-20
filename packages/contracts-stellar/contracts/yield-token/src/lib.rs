#![no_std]
//! `PPYieldToken` for Soroban — a non-rebasing share token over a lending position.
//!
//! Ported from `v2-monorepo@b2a37959:packages/contracts/src/contracts/PPYieldToken.sol`.
//!
//! A depositor's underlying is supplied to a lending venue through a [`yield_adapter`]; the
//! depositor holds *shares* whose exchange rate rises as the position accrues. Because the share
//! balance is fixed while its value grows, a shielded note denominated in shares leaks no value
//! delta over time — which is the whole reason the wrapper is non-rebasing. Yield is realised when
//! shares are redeemed.
//!
//! # What differs from EVM, and why
//!
//! EVM wraps an Aave **aToken**, so the vault's position is an ERC-20 balance it holds and
//! `asset.balanceOf(this)` is the accounting input. A Blend position is per-address state inside
//! the pool, not a token, so there is nothing to hold. `adapter.position_value()` takes exactly the
//! place `balanceOf` occupies on EVM, and every fee/checkpoint formula below ports across
//! unchanged. See [`yield_adapter`] for the seam.
//!
//! Shares are themselves a Soroban token, because ppUSDC has to be registerable as an ordinary pool
//! asset — the pool and entrypoint are untouched by the yield machinery, exactly as on EVM.

mod math;
#[cfg(test)]
mod test;

use math::{mul_div, pow10, Rounding};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, String, Symbol, Vec,
};
use yield_adapter::LendingAdapterClient;

/// Basis-point denominator.
pub const MAX_BPS: i128 = 10_000;

/// Ceiling on the protocol yield fee: 20%. Mirrors `PPYieldToken.MAX_FEE_BPS`.
pub const MAX_FEE_BPS: i128 = 2_000;

/// Largest virtual-share offset accepted at creation.
///
/// EVM derives the offset as `18 - assetDecimals` because ERC-20 convention fixes shares at 18
/// places. Soroban has no such convention (classic assets are 7), so the offset is explicit — but
/// it is bounded, because it feeds a `10^offset` that participates in every conversion.
pub const MAX_DECIMALS_OFFSET: u32 = 18;

/// Largest share-decimals value accepted at creation.
///
/// `10^decimals` must fit in `i128` for `exchange_rate` to work at all; 38 is the ceiling there.
/// Bounded well below it because share decimals beyond an asset's own are meaningless.
pub const MAX_DECIMALS: u32 = 18;

/// Smallest virtual-share offset accepted at creation.
///
/// The offset IS the first-depositor inflation buffer: virtual shares are `10^offset`, so an offset
/// of 0 gives a buffer of 1 and the defence `math.rs` is built around effectively vanishes. EVM
/// cannot be misconfigured this way because it derives the offset rather than accepting it, so
/// bounding only the top — which is what this did originally — leaves the dangerous end open.
pub const MIN_DECIMALS_OFFSET: u32 = 3;

/// Shares minted to an unrecoverable address at creation, against first-depositor inflation.
///
/// EVM audit **C-6 → L-6**. Seeded by the factory there; seeded at initialization here, so a
/// directly-deployed wrapper cannot skip the defence — on EVM that gap is exactly what the finding
/// was about, and it needed a deploy-script fix as well as a factory.
pub const DEAD_SHARES: i128 = 1_000;

/// Contract errors.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Already initialized.
    AlreadyInitialized = 1,
    /// Not yet initialized.
    NotInitialized = 2,
    /// Caller is not the admin.
    Unauthorized = 3,
    /// Fee exceeds `MAX_FEE_BPS`.
    FeeTooHigh = 4,
    /// The requested decimals offset exceeds `MAX_DECIMALS_OFFSET`.
    UnsupportedDecimals = 5,
    /// A deposit that would round to zero shares.
    ZeroShares = 6,
    /// A redeem that would round to zero assets.
    ZeroAssets = 7,
    /// Deposits are paused.
    Paused = 8,
    /// Contract is not paused.
    NotPaused = 9,
    /// Arithmetic overflowed.
    Overflow = 10,
    /// Insufficient share balance.
    InsufficientBalance = 11,
    /// Insufficient allowance.
    InsufficientAllowance = 12,
    /// The underlying asset can never be rescued.
    CannotRescueAsset = 13,
    /// A non-positive amount was supplied where a positive one is required.
    InvalidAmount = 14,
    /// The venue could not satisfy the request.
    VenueRejected = 15,
    /// The venue credited or delivered less than the call required.
    VenueShortfall = 17,
    /// The approval's expiration ledger is already in the past.
    InvalidExpiration = 18,
    /// The current adapter is healthy, so it cannot be replaced.
    AdapterStillHealthy = 19,
    /// No pending admin transfer to accept.
    NoPendingAdmin = 16,
}

/// Storage keys.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Current admin.
    Admin,
    /// Pending admin in a two-step transfer.
    PendingAdmin,
    /// The lending adapter holding the position.
    Adapter,
    /// The underlying asset, cached from the adapter at initialization.
    Underlying,
    /// Protocol yield fee, in bps.
    FeeBps,
    /// Fees settled but not yet claimed, in underlying.
    AccumulatedFees,
    /// The cumulative GAIN that `AccumulatedFees` was charged on.
    ///
    /// Stored so a loss can be reversed at the rate the fee was actually banked at, without
    /// storing the rate itself: the refund is `acc * reversed_gain / basis`, which is
    /// rate-independent by construction.
    AccumulatedFeeBasis,
    /// Position value at the last checkpoint, in underlying.
    LastCheckpointBalance,
    /// Total shares outstanding.
    TotalSupply,
    /// Virtual-share offset.
    DecimalsOffset,
    /// Deposits paused.
    Paused,
    /// Share decimals.
    Decimals,
    /// Share token name.
    Name,
    /// Share token symbol.
    Symbol,
    /// Share balance of an address.
    Balance(Address),
    /// Allowance from owner to spender.
    Allowance(Address, Address),
}

const DAY_LEDGERS: u32 = 17_280;
const LIFETIME_THRESHOLD: u32 = DAY_LEDGERS * 30;
const BUMP_AMOUNT: u32 = DAY_LEDGERS * 60;

/// Non-rebasing share token over a lending position.
#[contract]
pub struct YieldToken;

#[contractimpl]
impl YieldToken {
    /// Create the wrapper.
    ///
    /// `dead_share_funder` supplies the underlying backing [`DEAD_SHARES`]. Those shares are minted
    /// to the contract itself, which has no way to spend them, so they are permanently locked.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        env: Env,
        admin: Address,
        adapter: Address,
        initial_fee_bps: i128,
        decimals_offset: u32,
        decimals: u32,
        name: String,
        symbol: String,
        dead_share_funder: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        // Bounds checked at INIT as well as in the setter. EVM's mutation sweep found the
        // constructor rejecting a deploy at exactly MAX_FEE_BPS while the setter accepted it — the
        // boundary tested on one path and not the other.
        if initial_fee_bps < 0 || initial_fee_bps > MAX_FEE_BPS {
            return Err(Error::FeeTooHigh);
        }
        if !(MIN_DECIMALS_OFFSET..=MAX_DECIMALS_OFFSET).contains(&decimals_offset) {
            return Err(Error::UnsupportedDecimals);
        }
        // `decimals` was bounded nowhere and feeds `pow10` in `exchange_rate`, so a value of 39
        // overflowed and bricked that view permanently. It is also immutable after init and is what
        // every wallet formats against.
        if decimals > MAX_DECIMALS {
            return Err(Error::UnsupportedDecimals);
        }

        let underlying = LendingAdapterClient::new(&env, &adapter)
            .try_underlying()
            .map_err(|_| Error::VenueRejected)?
            .map_err(|_| Error::VenueRejected)?;

        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Adapter, &adapter);
        s.set(&DataKey::Underlying, &underlying);
        s.set(&DataKey::FeeBps, &initial_fee_bps);
        s.set(&DataKey::AccumulatedFees, &0i128);
        s.set(&DataKey::AccumulatedFeeBasis, &0i128);
        s.set(&DataKey::LastCheckpointBalance, &0i128);
        s.set(&DataKey::TotalSupply, &0i128);
        s.set(&DataKey::DecimalsOffset, &decimals_offset);
        s.set(&DataKey::Decimals, &decimals);
        s.set(&DataKey::Name, &name);
        s.set(&DataKey::Symbol, &symbol);
        s.set(&DataKey::Paused, &false);
        s.extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Seed the dead shares through the ordinary deposit path so they are genuinely backed.
        dead_share_funder.require_auth();
        Self::deposit_inner(
            &env,
            &dead_share_funder,
            &env.current_contract_address(),
            DEAD_SHARES,
        )?;

        Ok(())
    }

    // ---- admin ----

    /// Set the protocol yield fee.
    ///
    /// Yield accrued so far is settled at the OLD rate before the change, so a fee rise is never
    /// retroactive.
    pub fn set_fee_bps(env: Env, new_fee_bps: i128) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if new_fee_bps < 0 || new_fee_bps > MAX_FEE_BPS {
            return Err(Error::FeeTooHigh);
        }
        let old = Self::get_i128(&env, &DataKey::FeeBps);
        // `checkpoint` already settled at the OLD rate and left the baseline where it belongs.
        Self::checkpoint(&env)?;
        env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        Self::touch(&env);
        env.events()
            .publish((Symbol::new(&env, "fee_updated"),), (old, new_fee_bps));
        Ok(())
    }

    /// Claim settled fees to `recipient`.
    ///
    /// Pays whatever the venue actually delivers and writes down only that much. Zeroing the
    /// accumulator before the withdraw — as this originally did — forfeits the remainder of a
    /// partial fill into shareholder value rather than leaving it claimable.
    pub fn claim_fees(env: Env, recipient: Address) -> Result<i128, Error> {
        Self::require_admin(&env)?;
        Self::checkpoint(&env)?;

        let banked: i128 = Self::get_i128(&env, &DataKey::AccumulatedFees);
        let paid = if banked > 0 {
            Self::adapter(&env)?
                .try_withdraw(&recipient, &banked)
                .map_err(|_| Error::VenueRejected)?
                .map_err(|_| Error::VenueRejected)?
        } else {
            0
        };

        env.storage().instance().set(
            &DataKey::AccumulatedFees,
            &banked.checked_sub(paid).ok_or(Error::Overflow)?.max(0),
        );

        // Retire the BASIS in proportion to what was paid. A claimed fee can never be refunded, so
        // leaving its basis behind inflates the denominator in `acc * reversed / basis` and makes
        // every later loss refund proportionally less than it should — quietly favouring the admin.
        // The two have to move together or the ratio stops meaning anything.
        let basis = Self::get_i128(&env, &DataKey::AccumulatedFeeBasis);
        if banked > 0 && basis > 0 {
            let retired =
                mul_div(&env, basis, paid, banked, Rounding::Down).ok_or(Error::Overflow)?;
            env.storage().instance().set(
                &DataKey::AccumulatedFeeBasis,
                &basis.checked_sub(retired).ok_or(Error::Overflow)?.max(0),
            );
        }

        // A fee claim is a flow out of the position, not a loss.
        Self::adjust_baseline(&env, -paid)?;
        Self::touch(&env);
        env.events()
            .publish((Symbol::new(&env, "fees_claimed"), recipient), paid);
        Ok(paid)
    }

    /// Begin a two-step admin transfer.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        Self::touch(&env);
        env.events()
            .publish((Symbol::new(&env, "admin_start"),), new_admin);
        Ok(())
    }

    /// Complete a two-step admin transfer.
    ///
    /// There is deliberately no renounce. EVM overrides `renounceOwnership` to revert (audit #233)
    /// so fee and reward collection can never be stranded; here the same property holds by
    /// construction, since Soroban has no zero `Address` to hand the role to. The two-step
    /// handshake is what remains load-bearing: it makes an unreachable-but-valid address a mistake
    /// the recipient must confirm rather than one the admin can make alone.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(Error::NoPendingAdmin)?;
        pending.require_auth();
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Self::touch(&env);
        env.events()
            .publish((Symbol::new(&env, "admin_set"),), pending);
        Ok(())
    }

    /// Pause deposits. Redemption stays open — the emergency exit is never gated.
    pub fn pause(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }
        env.storage().instance().set(&DataKey::Paused, &true);
        Self::touch(&env);
        env.events().publish((Symbol::new(&env, "paused"),), ());
        Ok(())
    }

    /// Resume deposits.
    pub fn unpause(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if !Self::is_paused(env.clone()) {
            return Err(Error::NotPaused);
        }
        env.storage().instance().set(&DataKey::Paused, &false);
        Self::touch(&env);
        env.events().publish((Symbol::new(&env, "unpaused"),), ());
        Ok(())
    }

    /// Claim venue incentives accrued to the adapter's position.
    ///
    /// The wrapper OWNS the adapter, so the adapter's own claim entrypoint is reachable only from
    /// here — every other address fails its owner check. Without this pass-through the incentives
    /// are stranded no matter what the adapter exposes, which is what the first attempt at fixing
    /// this missed: the entrypoint existed and nothing could call it.
    ///
    /// Incentives are protocol revenue, not depositor backing: a venue claim moves only accrued
    /// reward tokens and cannot touch the supply position.
    pub fn claim_venue_emissions(
        env: Env,
        venue_ids: Vec<u32>,
        to: Address,
    ) -> Result<i128, Error> {
        Self::require_admin(&env)?;
        let claimed = Self::adapter(&env)?
            .try_claim_emissions(&venue_ids, &to)
            .map_err(|_| Error::VenueRejected)?
            .map_err(|_| Error::VenueRejected)?;
        Self::touch(&env);
        env.events()
            .publish((Symbol::new(&env, "emissions"), to), claimed);
        Ok(claimed)
    }

    /// Replace a BROKEN adapter, and only a broken one.
    ///
    /// Without any escape path, a venue that permanently stops reporting the position locks this
    /// vault forever: shares price at zero, so redemptions round to nothing, deposits mint nothing,
    /// and fee claims withdraw nothing — with the funds still sitting in the venue and no call that
    /// reaches them. That is unrecoverable by anyone, and it is a design gap rather than a bug.
    ///
    /// The obvious fix — an admin-gated setter — is worse than the problem. An admin who can swap
    /// in an adapter of their choosing controls `position_value`, and `position_value` is what
    /// prices every share: they could mint unbounded shares and drain the vault. So the swap is
    /// permitted **only while the current adapter is failing**. A healthy one cannot be replaced,
    /// which removes the power entirely in the normal case and leaves it available in exactly the
    /// case it exists for — a re-indexed reserve, a migrated position, a venue upgrade.
    ///
    /// This narrows the admin's reach; it does not eliminate it. An admin whose adapter is already
    /// broken can point at anything. That residual is the price of the funds being recoverable at
    /// all, and it is recorded rather than hidden.
    pub fn replace_broken_adapter(env: Env, new_adapter: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;

        // Refuse while the adapter is doing its job.
        //
        // "Doing its job" is not merely "answers when asked". An empty-but-functional adapter
        // answers perfectly well — it answers zero — so gating on readability alone made this a
        // one-shot tool that disarmed itself exactly when it was aimed wrong: the first swap into
        // an adapter that turned out to hold nothing left the vault in the precise state the hatch
        // exists to escape (real shares, no backing) and every later attempt got
        // `AdapterStillHealthy`. Nothing else can move the adapter pointer, so that was terminal.
        //
        // Outstanding shares with no assets behind them is a broken adapter whatever it reports.
        // `DEAD_SHARES` is excluded because those are the unredeemable inflation-guard shares, which
        // legitimately outlive an empty vault.
        match Self::position_value(&env) {
            Err(_) => {}
            Ok(position) => {
                if position > 0 || Self::total_supply(env.clone()) <= DEAD_SHARES {
                    return Err(Error::AdapterStillHealthy);
                }
            }
        }

        let underlying = LendingAdapterClient::new(&env, &new_adapter)
            .try_underlying()
            .map_err(|_| Error::VenueRejected)?
            .map_err(|_| Error::VenueRejected)?;
        let current: Address = env
            .storage()
            .instance()
            .get(&DataKey::Underlying)
            .ok_or(Error::NotInitialized)?;
        if underlying != current {
            // A replacement that wraps a different asset would silently redenominate every share.
            return Err(Error::VenueRejected);
        }

        env.storage()
            .instance()
            .set(&DataKey::Adapter, &new_adapter);

        // Re-baseline to the NEW adapter's position.
        //
        // Without this, the replacement's position is measured against the BROKEN adapter's
        // baseline — every one of `LastCheckpointBalance`, `AccumulatedFees` and
        // `AccumulatedFeeBasis` survives the swap — so a replacement holding more than that
        // baseline has the difference read as a gain and taxed. The admin is owed a fee for funds
        // merely coming back, in a recovery where by definition nothing was earned. Measured at 20%
        // of the difference before this existed.
        //
        // Fees already banked are kept: they were earned before the break. The basis is kept with
        // them so the reversal ratio stays coherent. Only the baseline moves, because the position
        // it referred to no longer exists — and `fee_state`'s own cap keeps fees inside whatever
        // the replacement recovered, including when that is less than the banked fee.
        // No cap on the banked fee here: `fee_state` already caps at the position on every read,
        // so a swap-time cap changes no outcome — `verify_test_bites` reported the test passing
        // both ways. One cap, in one place.
        let position = Self::position_value(&env)?;
        let last = Self::get_i128(&env, &DataKey::LastCheckpointBalance);
        if position < last {
            // A partial recovery is a LOSS being reversed, not yield — settle it as one.
            //
            // Re-baselining alone moved `LastCheckpointBalance` while `AccumulatedFees` crossed the
            // break untouched, and `fee_state` then capped the fee at the position. When the rescue
            // came back smaller than the banked fee, that cap WAS the whole rescue: depositors got
            // nothing and the admin took 100% of what was recovered, on a break where by definition
            // nothing was earned. Running the loss branch refunds the banked fee against the
            // drawdown first, at the same rate it was charged.
            //
            // Only the loss direction. The gain branch must never run here: a replacement holding
            // more than the dead adapter's stale baseline has not earned that difference, and
            // taxing it is the round-1 finding this re-baselining was added to fix.
            //
            // KEEP the loss branch's baseline. Discarding it and writing the trough instead was a
            // 20%-of-principal leak: with nothing banked the loss branch is inert (`basis == 0`, so
            // `reversible == 0` and `new_last == last`), and overwriting `last` with the recovered
            // position made every unit of principal recovered AFTERWARDS read as a gain at the next
            // checkpoint. A rescue that lands in stages is the normal shape of a rescue, so this
            // fired on honest use of the hatch; an admin choosing the moment of lowest reported
            // position maximised it. Measured at 20% of the entire deposit when the swap went to an
            // adapter that had recovered nothing yet.
            //
            // `new_last >= position` by construction here (`reversible <= loss`), so the baseline
            // never drops below what is actually held.
            let (settled, new_last, new_basis) = Self::fee_state(&env, position)?;
            let s = env.storage().instance();
            s.set(&DataKey::AccumulatedFees, &settled);
            s.set(&DataKey::AccumulatedFeeBasis, &new_basis);
            s.set(&DataKey::LastCheckpointBalance, &new_last);
        } else {
            // The replacement holds at least the stale baseline. That difference was not earned
            // either, so re-baseline up to it rather than taxing it — the round-1 finding.
            env.storage()
                .instance()
                .set(&DataKey::LastCheckpointBalance, &position);
        }

        Self::touch(&env);
        env.events()
            .publish((Symbol::new(&env, "adapter_swap"),), new_adapter);
        Ok(())
    }

    /// Move a stray token out of the wrapper.
    ///
    /// The underlying can never be rescued, so depositor backing is unreachable to the admin.
    pub fn rescue_token(
        env: Env,
        token_addr: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::Underlying)
            .ok_or(Error::NotInitialized)?;
        if token_addr == underlying {
            return Err(Error::CannotRescueAsset);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        token::TokenClient::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        Self::touch(&env);
        env.events()
            .publish((Symbol::new(&env, "rescued"), token_addr, to), amount);
        Ok(())
    }

    // ---- vault ----

    /// Deposit `assets` of underlying, minting shares to `receiver`.
    pub fn deposit(
        env: Env,
        from: Address,
        receiver: Address,
        assets: i128,
    ) -> Result<i128, Error> {
        from.require_auth();
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }
        Self::deposit_assets(&env, &from, &receiver, assets)
    }

    /// Mint exactly `shares` to `receiver`, pulling whatever underlying that costs.
    pub fn mint(env: Env, from: Address, receiver: Address, shares: i128) -> Result<i128, Error> {
        from.require_auth();
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }
        Self::deposit_inner(&env, &from, &receiver, shares)
    }

    /// Burn shares from `owner` and send `assets` of underlying to `receiver`.
    pub fn withdraw(
        env: Env,
        owner: Address,
        receiver: Address,
        assets: i128,
    ) -> Result<i128, Error> {
        owner.require_auth();
        if assets <= 0 {
            return Err(Error::InvalidAmount);
        }
        let shares = Self::preview_withdraw(env.clone(), assets)?;
        // `withdraw` names an exact asset amount, so a short delivery is a broken promise.
        let delivered = Self::withdraw_inner(&env, &owner, &receiver, assets, shares)?;
        if delivered < assets {
            return Err(Error::VenueShortfall);
        }
        Ok(shares)
    }

    /// Burn exactly `shares` from `owner`, sending the resulting underlying to `receiver`.
    pub fn redeem(
        env: Env,
        owner: Address,
        receiver: Address,
        shares: i128,
    ) -> Result<i128, Error> {
        owner.require_auth();
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        // No zero-assets check here: `withdraw_inner` performs it, and a duplicate is unreachable.
        // Mutation proved it — deleting this one changed no test result, because the inner guard
        // caught every case. Dead defence reads as coverage it does not provide.
        let assets = Self::preview_redeem(env.clone(), shares)?;
        // `redeem` names a share count and returns what they were worth, so a short delivery is
        // reported honestly rather than treated as a failure.
        Self::withdraw_inner(&env, &owner, &receiver, assets, shares)
    }

    // ---- views ----

    /// Net assets backing the shares: position value minus all fees, floored at zero.
    ///
    /// The floor is not cosmetic. If the venue ever reports a position below the last checkpoint —
    /// bad-debt socialization, a negative rebase — an unfloored subtraction underflows and bricks
    /// every path that reads it, including redemption. Flooring keeps the exit open.
    pub fn total_assets(env: Env) -> Result<i128, Error> {
        let balance = Self::position_value(&env)?;
        // No floor branch here any more. `fee_state` already caps fees at the position, so
        // `balance - fees` cannot go negative and the old `if balance > fees { … } else { 0 }` was
        // arithmetically identical to the subtraction — mutation proved it, by replacing the
        // condition with `true` and changing no test result. Keeping it would read as a guard the
        // contract no longer needs, which is the same dead-defence trap already removed twice here.
        let fees = Self::current_fees(&env, balance)?;
        balance.checked_sub(fees).ok_or(Error::Overflow)
    }

    /// Total shares outstanding.
    pub fn total_supply(env: Env) -> i128 {
        Self::get_i128(&env, &DataKey::TotalSupply)
    }

    /// Shares that `assets` would mint.
    pub fn convert_to_shares(env: Env, assets: i128) -> Result<i128, Error> {
        Self::to_shares(&env, assets, Rounding::Down)
    }

    /// Assets that `shares` are worth.
    pub fn convert_to_assets(env: Env, shares: i128) -> Result<i128, Error> {
        Self::to_assets(&env, shares, Rounding::Down)
    }

    /// Shares minted for a deposit of `assets`.
    pub fn preview_deposit(env: Env, assets: i128) -> Result<i128, Error> {
        Self::to_shares(&env, assets, Rounding::Down)
    }

    /// Assets required to mint `shares`, including the venue's supply rounding buffer.
    ///
    /// EVM splits this across two contracts — the vault's `previewMint` returns the aToken figure
    /// and the zap's `quoteBuy` adds `_SUPPLY_ROUNDING_BUFFER` on top. Here the wrapper talks to the
    /// venue directly, so both halves belong in one quote. The router enforces its slippage ceiling
    /// against this value and again against what `mint` actually charged; they must agree.
    pub fn preview_mint(env: Env, shares: i128) -> Result<i128, Error> {
        Self::to_assets(&env, shares, Rounding::Up)?
            .checked_add(Self::supply_buffer(&env)?)
            .ok_or(Error::Overflow)
    }

    /// Shares burned to withdraw `assets`.
    pub fn preview_withdraw(env: Env, assets: i128) -> Result<i128, Error> {
        Self::to_shares(&env, assets, Rounding::Up)
    }

    /// Assets returned for redeeming `shares`.
    pub fn preview_redeem(env: Env, shares: i128) -> Result<i128, Error> {
        Self::to_assets(&env, shares, Rounding::Down)
    }

    /// Fees claimable right now, including yield accrued since the last checkpoint.
    pub fn claimable_fees(env: Env) -> Result<i128, Error> {
        let balance = Self::position_value(&env)?;
        Self::current_fees(&env, balance)
    }

    /// Value of one whole share.
    pub fn exchange_rate(env: Env) -> Result<i128, Error> {
        let decimals: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Decimals)
            .ok_or(Error::NotInitialized)?;
        let one = pow10(decimals).ok_or(Error::Overflow)?;
        Self::to_assets(&env, one, Rounding::Down)
    }

    /// Whether deposits are paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// The current admin.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// The lending adapter address.
    pub fn adapter_address(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Adapter)
            .ok_or(Error::NotInitialized)
    }

    /// The underlying asset.
    pub fn underlying(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Underlying)
            .ok_or(Error::NotInitialized)
    }

    /// The protocol yield fee, in bps.
    pub fn fee_bps(env: Env) -> i128 {
        Self::get_i128(&env, &DataKey::FeeBps)
    }

    // ---- internals ----

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    /// Emit an event and refresh the instance TTL.
    ///
    /// Bundled deliberately: every entrypoint that changes state must do both, and pairing them in
    /// one call makes it hard to add a path that does neither.
    fn touch(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
    }

    fn get_i128(env: &Env, key: &DataKey) -> i128 {
        env.storage().instance().get(key).unwrap_or(0)
    }

    fn adapter(env: &Env) -> Result<LendingAdapterClient<'static>, Error> {
        let addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Adapter)
            .ok_or(Error::NotInitialized)?;
        Ok(LendingAdapterClient::new(env, &addr))
    }

    fn supply_buffer(env: &Env) -> Result<i128, Error> {
        Self::adapter(env)?
            .try_supply_buffer()
            .map_err(|_| Error::VenueRejected)?
            .map_err(|_| Error::VenueRejected)
    }

    fn position_value(env: &Env) -> Result<i128, Error> {
        Self::adapter(env)?
            .try_position_value()
            .map_err(|_| Error::VenueRejected)?
            .map_err(|_| Error::VenueRejected)
    }

    /// Fees owed against a given live position, and the baseline/basis that produced them.
    ///
    /// Returns `(fees_owed, new_baseline, new_basis)`. This is the single source of truth: both the
    /// views and the state-changing paths call it, so a view can never disagree with what a write
    /// would do.
    ///
    /// # The model, and the two attacks that shaped it
    ///
    /// Fees accrue on gains above the baseline, and **un-accrue on losses**. Two things make that
    /// sound, and the audit found the code failing at both:
    ///
    /// 1. **The reversal must not depend on the CURRENT rate.** The first implementation refunded
    ///    `loss * fee_bps / 10_000` using whatever rate was live at the time of the loss. An admin
    ///    could therefore bank at 20%, set the rate to 0, and the banked amount became immune to
    ///    reversal — a one-way ratchet converting fees into a claim on principal, worth
    ///    `banking_rate * drawdown` per cycle and unbounded across cycles. Storing the gain BASIS
    ///    alongside the amount makes the refund `acc * reversed / basis`, which is rate-independent.
    ///
    /// 2. **A principal drawdown must not lower the baseline.** Only the part of a loss that
    ///    reverses previously-taxed gain may move it. Lowering it by the full loss made the
    ///    subsequent RECOVERY look like fresh yield, and any caller could force that re-baselining
    ///    with a one-stroop deposit. A position that went 1.0M → 0.8M → 1.0M earned nothing and was
    ///    charged 4% of principal.
    ///
    /// Fees are additionally capped at the position: without that, a loss can leave fees exceeding
    /// the whole remaining position, `total_assets` floors to zero, every redemption rounds to
    /// `ZeroAssets`, and the vault locks with funds inside it.
    fn fee_state(env: &Env, balance: i128) -> Result<(i128, i128, i128), Error> {
        let acc = Self::get_i128(env, &DataKey::AccumulatedFees);
        let basis = Self::get_i128(env, &DataKey::AccumulatedFeeBasis);
        let last = Self::get_i128(env, &DataKey::LastCheckpointBalance);

        let (owed, new_last, new_basis) = if balance > last {
            // Gain above the baseline: tax it, and raise the baseline to match.
            let gain = balance.checked_sub(last).ok_or(Error::Overflow)?;
            let fee_bps = Self::get_i128(env, &DataKey::FeeBps);
            let fee =
                mul_div(env, gain, fee_bps, MAX_BPS, Rounding::Down).ok_or(Error::Overflow)?;
            // Only TAXED gain enters the basis.
            //
            // The basis is the denominator of the refund `acc * reversed / basis`, so it must
            // represent the gain whose tax is actually held in `acc`. Adding EVERY gain — including
            // gain earned at a zero rate, and dust gain whose fee floors to zero — makes
            // `acc / basis` a blended rate below any rate ever charged, and the untaxed remainder
            // becomes free re-baselining capacity: a drawdown reverses `min(loss, basis)` off the
            // baseline while refunding almost nothing, and the recovery is then taxed at the
            // CURRENT rate. A vault launched at 0% and later raised to 20% could have the forgone
            // fee collected retroactively out of principal, one drawdown-recovery cycle at a time,
            // by an admin who can force the trough checkpoint himself.
            //
            // Gating on `fee > 0` rather than `fee_bps > 0` also closes the dust lever: at 2000 bps
            // a gain of four stroops is taxed nothing but would still have enlarged the basis.
            let taxed = if fee > 0 { gain } else { 0 };
            (
                acc.checked_add(fee).ok_or(Error::Overflow)?,
                balance,
                basis.checked_add(taxed).ok_or(Error::Overflow)?,
            )
        } else if balance < last {
            // Loss. Only the portion that unwinds previously-taxed gain is reversible; the rest is
            // principal, and principal loss moves neither the fee nor the baseline.
            let loss = last.checked_sub(balance).ok_or(Error::Overflow)?;
            let reversible = if loss > basis { basis } else { loss };
            let refund = if basis > 0 {
                mul_div(env, acc, reversible, basis, Rounding::Down).ok_or(Error::Overflow)?
            } else {
                0
            };
            (
                acc.checked_sub(refund).ok_or(Error::Overflow)?.max(0),
                last.checked_sub(reversible).ok_or(Error::Overflow)?,
                basis.checked_sub(reversible).ok_or(Error::Overflow)?,
            )
        } else {
            (acc, last, basis)
        };

        // The cap: fees never exceed the position backing them.
        //
        // This was carried for a round as an ACCEPTED MUTATION SURVIVOR — kept on the asymmetry
        // argument (one comparison against an unrecoverable failure) even though no test could tell
        // whether it was there. That is no longer true, and the note is worth keeping for what it
        // shows: "no test distinguishes it" was a statement about the SUITE, never about
        // reachability, and it read like the latter. The cap binds after any full redemption, which
        // leaves the vault holding little but the banked fee, and
        // `the_fee_cap_keeps_the_accumulator_and_its_basis_on_the_same_rate` now fails without it.
        //
        // The invariant is still the one whose violation is unrecoverable: `total_assets` floors to
        // zero, every redemption rounds to `ZeroAssets`, and the vault locks with everyone's funds
        // inside it, permanently. That already happened once here.
        //
        // When it DOES bind, the basis must come down with it. `checkpoint` persists both, and
        // `acc / basis` is the rate at which the next drawdown is refunded — so storing a capped
        // accumulator beside an uncapped basis records a rate far below any rate ever charged, and
        // the admin keeps more of the next loss than they took on the way up. Measured at 4.2 of a
        // 100 round trip after one cap event. Scaling the basis by the same ratio keeps the pair
        // describing one rate.
        let capped = if owed > balance { balance } else { owed };
        let basis_out = if capped < owed && owed > 0 {
            mul_div(env, new_basis, capped, owed, Rounding::Down).ok_or(Error::Overflow)?
        } else {
            new_basis
        };
        Ok((capped, new_last, basis_out))
    }

    fn current_fees(env: &Env, balance: i128) -> Result<i128, Error> {
        Ok(Self::fee_state(env, balance)?.0)
    }

    /// Settle the effective fee, baseline and basis; returns the position read.
    fn checkpoint(env: &Env) -> Result<i128, Error> {
        let balance = Self::position_value(env)?;
        let (settled, new_last, new_basis) = Self::fee_state(env, balance)?;
        let s = env.storage().instance();
        s.set(&DataKey::AccumulatedFees, &settled);
        s.set(&DataKey::LastCheckpointBalance, &new_last);
        s.set(&DataKey::AccumulatedFeeBasis, &new_basis);
        Ok(balance)
    }

    /// Move the baseline by an explicit FLOW (deposit in, withdrawal out).
    ///
    /// Flows are not yield and must not be taxed, so the baseline tracks them one-for-one. Setting
    /// it to the post-action position instead would work only while the baseline equals the
    /// position — which is exactly what a drawdown breaks.
    fn adjust_baseline(env: &Env, delta: i128) -> Result<(), Error> {
        let last = Self::get_i128(env, &DataKey::LastCheckpointBalance);
        let next = last.checked_add(delta).ok_or(Error::Overflow)?.max(0);
        env.storage()
            .instance()
            .set(&DataKey::LastCheckpointBalance, &next);
        Ok(())
    }

    fn virtual_shares(env: &Env) -> Result<i128, Error> {
        let offset: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DecimalsOffset)
            .ok_or(Error::NotInitialized)?;
        pow10(offset).ok_or(Error::Overflow)
    }

    /// `to_shares` against an explicit pre-action state.
    ///
    /// A deposit must be priced on the state BEFORE the supply landed, but the number of assets is
    /// only known AFTER it — so the two cannot both come from live reads.
    fn to_shares_at(
        env: &Env,
        assets: i128,
        supply_before: i128,
        assets_before: i128,
        rounding: Rounding,
    ) -> Result<i128, Error> {
        let supply = supply_before
            .checked_add(Self::virtual_shares(env)?)
            .ok_or(Error::Overflow)?;
        let total = assets_before.checked_add(1).ok_or(Error::Overflow)?;
        mul_div(env, assets, supply, total, rounding).ok_or(Error::Overflow)
    }

    fn to_shares(env: &Env, assets: i128, rounding: Rounding) -> Result<i128, Error> {
        if assets < 0 {
            return Err(Error::InvalidAmount);
        }
        let supply = Self::total_supply(env.clone())
            .checked_add(Self::virtual_shares(env)?)
            .ok_or(Error::Overflow)?;
        let assets_total = Self::total_assets(env.clone())?
            .checked_add(1)
            .ok_or(Error::Overflow)?;
        mul_div(env, assets, supply, assets_total, rounding).ok_or(Error::Overflow)
    }

    fn to_assets(env: &Env, shares: i128, rounding: Rounding) -> Result<i128, Error> {
        if shares < 0 {
            return Err(Error::InvalidAmount);
        }
        let supply = Self::total_supply(env.clone())
            .checked_add(Self::virtual_shares(env)?)
            .ok_or(Error::Overflow)?;
        let assets_total = Self::total_assets(env.clone())?
            .checked_add(1)
            .ok_or(Error::Overflow)?;
        mul_div(env, shares, assets_total, supply, rounding).ok_or(Error::Overflow)
    }

    /// Deposit a caller-chosen amount of underlying.
    ///
    /// Shares are minted against the delta the venue actually credited, NOT against the amount the
    /// caller handed over. A venue that keeps a cut — a supply fee, a rounding shortfall — would
    /// otherwise have that shortfall socialized across every existing holder, repeatably, at a
    /// depositor's choosing. The depositor bears their own venue's shortfall.
    fn deposit_assets(
        env: &Env,
        from: &Address,
        receiver: &Address,
        assets: i128,
    ) -> Result<i128, Error> {
        if assets <= 0 {
            return Err(Error::InvalidAmount);
        }
        // Fee settled against the PRE-deposit position, so principal is never taxed as yield.
        Self::checkpoint(env)?;
        let supply_before = Self::total_supply(env.clone());
        let assets_before = Self::total_assets(env.clone())?;

        let credited = Self::supply_to_venue(env, from, assets)?;
        let shares =
            Self::to_shares_at(env, credited, supply_before, assets_before, Rounding::Down)?;
        if shares == 0 {
            return Err(Error::ZeroShares);
        }
        Self::finish_deposit(env, from, receiver, credited, shares)?;
        Ok(shares)
    }

    /// Deposit whatever `shares` costs.
    ///
    /// Exact-output: the caller names the share count. If the venue credits less than the quoted
    /// cost, those shares cannot be backed, so the call reverts rather than minting unbacked ones.
    fn deposit_inner(
        env: &Env,
        from: &Address,
        receiver: &Address,
        shares: i128,
    ) -> Result<i128, Error> {
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        Self::checkpoint(env)?;
        let assets = Self::to_assets(env, shares, Rounding::Up)?;
        if assets <= 0 {
            return Err(Error::InvalidAmount);
        }
        // Over-supply by the venue's rounding granularity so an exact-output mint cannot revert on
        // it. This is EVM `PPYieldTokenZap.buyFixedYieldToken`'s `_SUPPLY_ROUNDING_BUFFER`, asked
        // of the adapter rather than hard-coded — see `LendingAdapter::supply_buffer` for why a
        // constant is right on Aave and wrong on Blend.
        //
        // MEASURED before this existed: at `b_rate` 1.188, 2.129 and 4.765, exact mints succeeded
        // 0, 2 and 0 times out of 30. `deposit` (variable output) was unaffected at 30/30. The
        // whole exact-output path — which is the router's entire deposit leg — was unusable on any
        // reserve that had ever accrued interest, and invisible to every test because `MockVenue`
        // and the local Blend fixture both sit at an exchange rate of exactly 1.0, where the
        // conversion is an identity and nothing floors.
        let buffer = Self::supply_buffer(env)?;
        let charged = assets.checked_add(buffer).ok_or(Error::Overflow)?;
        let credited = Self::supply_to_venue(env, from, charged)?;
        // Kept as the post-buffer safety net, exactly as EVM keeps `InsufficientWrap` after adding
        // its buffer: the buffer makes the ordinary case pass, this catches a venue whose shortfall
        // exceeds what it declared.
        if credited < assets {
            return Err(Error::VenueShortfall);
        }
        // Baseline by what the venue CREDITED, not by what was requested — the same as
        // `deposit_assets`. A venue that hands back more than it was given (an interest tick inside
        // the frame, a rounding in the depositor's favour) left the excess above the baseline,
        // where the next checkpoint read it as yield and taxed it. It is not yield: it arrived as
        // part of the deposit, and a flow is never taxed. The two paths disagreed; this one was
        // wrong. `PPYieldToken` has no such split because it re-reads the absolute balance after
        // every deposit.
        Self::finish_deposit(env, from, receiver, credited, shares)?;
        // The CHARGE, not the pre-buffer figure: the caller paid `charged`, and `preview_mint`
        // quoted `charged`. Returning `assets` here would under-report what left the caller's
        // wallet and break the router's slippage ceiling, which is enforced against this value.
        Ok(charged)
    }

    /// Supply to the venue and return the delta it actually credited.
    fn supply_to_venue(env: &Env, from: &Address, assets: i128) -> Result<i128, Error> {
        Self::adapter(env)?
            .try_supply(from, &assets)
            .map_err(|_| Error::VenueRejected)?
            .map_err(|_| Error::VenueRejected)
    }

    fn finish_deposit(
        env: &Env,
        from: &Address,
        receiver: &Address,
        assets: i128,
        shares: i128,
    ) -> Result<(), Error> {
        Self::mint_shares(env, receiver, shares)?;

        // A deposit is a flow, not yield: move the baseline by exactly what arrived.
        Self::adjust_baseline(env, assets)?;
        Self::touch(env);
        env.events().publish(
            (Symbol::new(env, "deposit"), from.clone(), receiver.clone()),
            (assets, shares),
        );
        Ok(())
    }

    fn withdraw_inner(
        env: &Env,
        owner: &Address,
        receiver: &Address,
        assets: i128,
        shares: i128,
    ) -> Result<i128, Error> {
        if assets == 0 {
            return Err(Error::ZeroAssets);
        }
        if shares == 0 {
            return Err(Error::ZeroShares);
        }
        Self::checkpoint(env)?;
        Self::burn_shares(env, owner, shares)?;

        // The delta the venue actually removed, which is what reached the receiver. Reporting the
        // REQUESTED figure instead defeats every downstream slippage check: the router takes this
        // return as ground truth for `min_underlying_out`, so a partial fill would clear a floor
        // with a number that was never paid.
        let delivered = Self::adapter(env)?
            .try_withdraw(receiver, &assets)
            .map_err(|_| Error::VenueRejected)?
            .map_err(|_| Error::VenueRejected)?;

        // Shares are burned above, before the venue is asked. A fill of exactly zero must therefore
        // FAIL, not report honestly: `withdraw` rejects any short fill, but `redeem` deliberately
        // tolerates a partial one, so a venue filling with nothing took every share and handed back
        // nothing — the balance destroyed with no asset ever leaving. Soroban's only way to undo the
        // burn is to fail the call. A genuinely partial fill is untouched by this and still reports
        // the smaller figure, which is what `redeem` promises.
        if delivered <= 0 {
            return Err(Error::ZeroAssets);
        }

        // A withdrawal is a flow: move the baseline down by exactly what left.
        Self::adjust_baseline(env, delivered.checked_neg().ok_or(Error::Overflow)?)?;
        Self::touch(env);
        env.events().publish(
            (
                Symbol::new(env, "withdraw"),
                owner.clone(),
                receiver.clone(),
            ),
            (delivered, shares),
        );
        Ok(delivered)
    }

    fn mint_shares(env: &Env, to: &Address, shares: i128) -> Result<(), Error> {
        let key = DataKey::Balance(to.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&key, &bal.checked_add(shares).ok_or(Error::Overflow)?);
        env.storage()
            .persistent()
            .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        let supply = Self::total_supply(env.clone())
            .checked_add(shares)
            .ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::TotalSupply, &supply);
        env.events()
            .publish((Symbol::new(env, "mint"), to.clone()), shares);
        Ok(())
    }

    fn burn_shares(env: &Env, from: &Address, shares: i128) -> Result<(), Error> {
        let key = DataKey::Balance(from.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if bal < shares {
            return Err(Error::InsufficientBalance);
        }
        env.storage()
            .persistent()
            .set(&key, &bal.checked_sub(shares).ok_or(Error::Overflow)?);
        // `set` on an existing persistent entry does not reset live_until. A holder whose only
        // interactions are partial redeems or burns would never have their balance key bumped and
        // it would archive — the same INTL-10 defect already fixed in `move_shares`, one function
        // over.
        env.storage()
            .persistent()
            .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let supply = Self::total_supply(env.clone())
            .checked_sub(shares)
            .ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::TotalSupply, &supply);
        env.events()
            .publish((Symbol::new(env, "burn"), from.clone()), shares);
        Ok(())
    }

    // ---- share token interface ----

    /// Share balance of `id`.
    pub fn balance(env: Env, id: Address) -> i128 {
        let key = DataKey::Balance(id);
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if bal > 0 {
            env.storage()
                .persistent()
                .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        }
        bal
    }

    /// Transfer shares.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        Self::touch(&env);
        Self::move_shares(&env, &from, &to, amount)
    }

    /// Approve `spender` to move `amount` of `from`'s shares until `expiration_ledger`.
    ///
    /// `expiration_ledger` is not decoration: it bounds a stale infinite approval. Without it — as
    /// this contract originally had it — an approval granted once lives forever. It is also part of
    /// the token interface every wallet and `TokenClient` expects, so omitting it made this
    /// contract uncallable by a standard integrator rather than merely unusual.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        // A live allowance must not already be expired; a zeroing approval may be.
        if amount > 0 && expiration_ledger < env.ledger().sequence() {
            return Err(Error::InvalidExpiration);
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        env.storage()
            .persistent()
            .set(&key, &(amount, expiration_ledger));
        env.storage()
            .persistent()
            .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Self::touch(&env);
        env.events().publish(
            (Symbol::new(&env, "approve"), from, spender),
            (amount, expiration_ledger),
        );
        Ok(())
    }

    /// Remaining allowance from `from` to `spender`; zero once expired.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        let key = DataKey::Allowance(from, spender);
        match env.storage().persistent().get::<_, (i128, u32)>(&key) {
            Some((amount, exp)) if exp >= env.ledger().sequence() => amount,
            _ => 0,
        }
    }

    /// Transfer shares using an allowance.
    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        spender.require_auth();
        // Validate the sign BEFORE touching the allowance. With the check left to `move_shares`,
        // a negative amount passed `allowed < amount` (`0 < -5` is false) and INCREASED the
        // allowance; it failed only because the later error rolled the frame back.
        //
        // NOT test-distinguishable, and recorded as such rather than claimed: the whole invocation
        // rolls back either way, so no test can observe the difference — a mutation of this line
        // legitimately SURVIVES. It is defence against a future edit that moves the allowance write
        // past the point of no return, not against anything reachable today.
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let (allowed, exp) = Self::allowance_raw(&env, &from, &spender);
        if exp < env.ledger().sequence() || allowed < amount {
            return Err(Error::InsufficientAllowance);
        }
        Self::spend_allowance(&env, &from, &spender, allowed, exp, amount)?;
        Self::touch(&env);
        Self::move_shares(&env, &from, &to, amount)
    }

    /// Burn `amount` of `from`'s shares without redeeming them.
    ///
    /// Part of the token interface. Burning forfeits the backing to the remaining holders rather
    /// than paying it out, so it is deliberately not a redemption path.
    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        Self::burn_shares(&env, &from, amount)?;
        Self::touch(&env);
        Ok(())
    }

    /// Burn `amount` of `from`'s shares using an allowance.
    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) -> Result<(), Error> {
        spender.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let (allowed, exp) = Self::allowance_raw(&env, &from, &spender);
        if exp < env.ledger().sequence() || allowed < amount {
            return Err(Error::InsufficientAllowance);
        }
        Self::spend_allowance(&env, &from, &spender, allowed, exp, amount)?;
        Self::burn_shares(&env, &from, amount)?;
        Self::touch(&env);
        Ok(())
    }

    fn allowance_raw(env: &Env, from: &Address, spender: &Address) -> (i128, u32) {
        env.storage()
            .persistent()
            .get::<_, (i128, u32)>(&DataKey::Allowance(from.clone(), spender.clone()))
            .unwrap_or((0, 0))
    }

    fn spend_allowance(
        env: &Env,
        from: &Address,
        spender: &Address,
        allowed: i128,
        exp: u32,
        amount: i128,
    ) -> Result<(), Error> {
        let key = DataKey::Allowance(from.clone(), spender.clone());
        env.storage().persistent().set(
            &key,
            &(allowed.checked_sub(amount).ok_or(Error::Overflow)?, exp),
        );
        // Refresh on write too: an allowance only ever spent down would otherwise never have its
        // TTL bumped and would archive mid-life.
        env.storage()
            .persistent()
            .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(())
    }

    /// Share decimals.
    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap_or(7)
    }

    /// Share token name.
    pub fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Name)
            .unwrap_or_else(|| String::from_str(&env, ""))
    }

    /// Share token symbol.
    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, ""))
    }

    fn move_shares(env: &Env, from: &Address, to: &Address, amount: i128) -> Result<(), Error> {
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let fk = DataKey::Balance(from.clone());
        let fb: i128 = env.storage().persistent().get(&fk).unwrap_or(0);
        // Extend the SOURCE key too, not only the destination: a holder who only ever sends would
        // otherwise let their own balance entry expire (INTL-10).
        if fb > 0 {
            env.storage()
                .persistent()
                .extend_ttl(&fk, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        }
        if fb < amount {
            return Err(Error::InsufficientBalance);
        }
        env.storage()
            .persistent()
            .set(&fk, &fb.checked_sub(amount).ok_or(Error::Overflow)?);

        let tk = DataKey::Balance(to.clone());
        let tb: i128 = env.storage().persistent().get(&tk).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&tk, &tb.checked_add(amount).ok_or(Error::Overflow)?);
        env.storage()
            .persistent()
            .extend_ttl(&tk, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        env.events().publish(
            (Symbol::new(env, "transfer"), from.clone(), to.clone()),
            amount,
        );
        Ok(())
    }
}
