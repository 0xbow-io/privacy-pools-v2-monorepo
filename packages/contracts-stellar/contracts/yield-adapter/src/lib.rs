#![no_std]
//! Lending-venue adapter interface for the yield module.
//!
//! # Why this layer exists
//!
//! EVM's `PPYieldToken` wraps an Aave **aToken** directly: the vault's position IS an ERC-20
//! balance it holds, so `asset.balanceOf(this)` is both the position and the accounting input.
//!
//! Soroban's lending venue is Blend, and a Blend position is **not** a transferable token. It is
//! per-address state inside the pool contract, read back with `get_positions`. There is no balance
//! to hold, so the EVM shape does not survive a literal port.
//!
//! This trait is the seam. Everything the core wrapper needs from a venue is three operations —
//! put underlying in, take underlying out, ask what the position is worth — and the wrapper is
//! written against those, never against a venue. Two consequences that matter:
//!
//! 1. Every audited invariant (fee bound, balance-delta accounting, zero-share/zero-asset dust,
//!    dead shares, floor-at-zero) lives in the **core**, where it is provable today against
//!    `MockVenue`. A venue adapter cannot silently drop one, because it never sees them.
//! 2. `position_value` plays exactly the role `asset.balanceOf(this)` plays on EVM, so the
//!    checkpoint and fee formulas port across line by line rather than being re-derived.

use soroban_sdk::{contractclient, contracterror, Address, Env};

#[cfg(any(test, feature = "testutils"))]
pub mod mock_venue;

/// Errors an adapter may raise.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AdapterError {
    /// The adapter has not been initialized.
    NotInitialized = 1,
    /// The caller is not the wrapper this adapter serves.
    Unauthorized = 2,
    /// The venue could not satisfy the request (illiquidity, cap, or venue-side failure).
    VenueRejected = 3,
    /// A supply or withdraw was asked for a non-positive amount.
    InvalidAmount = 4,
    /// Arithmetic overflowed.
    Overflow = 5,
    /// The adapter has supplied before but the venue no longer reports a position for it.
    ///
    /// Distinguishing this from "no position" matters more than it looks. If the venue silently
    /// reports zero for a position that still exists, the wrapper above prices every share at zero:
    /// redemptions round to nothing, deposits mint nothing, and fee claims withdraw nothing — the
    /// vault locks with the funds still inside it and no path reaches them. Failing loudly turns an
    /// unrecoverable silent lock into a visible, diagnosable error.
    PositionMissing = 7,
    /// The adapter has already been initialized.
    ///
    /// Without this an adapter can be re-initialized by anyone, who then names themselves owner and
    /// withdraws the whole position. Every other contract in this port has carried a one-shot guard
    /// from the start; the absence of the error variant here is what shows the guard was never
    /// contemplated rather than deliberately omitted.
    AlreadyInitialized = 6,
}

/// The venue-facing surface the yield wrapper depends on.
///
/// Implementations hold the position and are owned by exactly one wrapper, which they authorize on
/// every value-moving call. Read-only `position_value` is deliberately ungated.
#[contractclient(name = "LendingAdapterClient")]
pub trait LendingAdapter {
    /// Move `amount` of underlying from `from` into the venue.
    ///
    /// Returns the **delta** this call added to the position, never the resulting absolute value.
    /// That is EVM audit C-7 carried across: crediting a caller with an absolute balance lets
    /// anyone donate into the contract and have the next caller sweep it (last-caller-wins). The
    /// delta is the only figure attributable to this call.
    fn supply(env: Env, from: Address, amount: i128) -> Result<i128, AdapterError>;

    /// Take `amount` of underlying out of the venue and send it to `to`.
    ///
    /// Returns the delta actually removed, for the same reason as `supply`. A venue that can only
    /// partially fill must return what it filled rather than silently reporting the request.
    fn withdraw(env: Env, to: Address, amount: i128) -> Result<i128, AdapterError>;

    /// The current value of the position, denominated in underlying.
    ///
    /// This is the Soroban stand-in for EVM's `asset.balanceOf(address(this))`.
    fn position_value(env: Env) -> Result<i128, AdapterError>;

    /// The underlying asset this adapter supplies to its venue.
    fn underlying(env: Env) -> Result<Address, AdapterError>;

    /// Extra underlying to supply so an exact-output mint can never revert on venue rounding.
    ///
    /// EVM carries this as a constant. `PPYieldTokenZap`:
    ///
    /// > Underlying over-supplied so the exact `mint` can never revert on Aave's index round-trip.
    /// > A single `supply(x)` credits `x` or `x - 1` wei of aToken (scaledBalance round-trip), so a
    /// > 1-wei buffer suffices; 2 is used for margin.
    ///
    /// A constant is right there because Aave's loss is one wei whatever the index. It is wrong
    /// here: Blend floors in bToken space, and one bToken is `b_rate` underlying, so the loss
    /// scales with how much interest the reserve has accrued — one stroop at `b_rate` 1.0, five at
    /// the 4.645 measured on testnet, and growing as a reserve matures. Hard-coding 2 would work on
    /// the local fixture, where `b_rate` is pinned at 1.0, and fail on every live reserve. So the
    /// buffer is asked of the venue rather than written down.
    ///
    /// Returns 0 for a venue that credits exactly what it is given.
    fn supply_buffer(env: Env) -> Result<i128, AdapterError>;

    /// Claim venue incentives accrued to this adapter's position, sending them to `to`.
    ///
    /// On the interface rather than only on the concrete adapter, because the OWNER of an adapter
    /// is the wrapper contract — so anything the wrapper cannot call is unreachable by every
    /// address on chain. A claim entrypoint the wrapper has no path to leaves the incentives
    /// exactly as stranded as having no entrypoint at all.
    ///
    /// `venue_ids` are venue-specific stream identifiers (for Blend, per-reserve emission indices).
    /// Passed in rather than derived: a reserve has separate supply and borrow streams and only the
    /// caller knows which apply, and a wrong id claims nothing rather than claiming wrongly.
    fn claim_emissions(
        env: Env,
        venue_ids: soroban_sdk::Vec<u32>,
        to: Address,
    ) -> Result<i128, AdapterError>;
}
