//! Share/asset conversion with a virtual-share offset.
//!
//! Ported from OpenZeppelin's ERC-4626 as `PPYieldToken` uses it: a virtual `+1` asset and
//! `+10^offset` virtual shares. The offset is the first-depositor inflation buffer — an attacker
//! who mints one share and donates a large balance can only round a victim's deposit down by a
//! factor bounded by the virtual amounts.
//!
//! All arithmetic goes through `U256`. On EVM the intermediate of `assets * (supply + virtual)`
//! fits in 256 bits by construction; in `i128` it does not, and a 7-decimal Stellar asset with an
//! 11-place offset puts realistic deposits within reach of overflowing the intermediate while both
//! operands and the result are perfectly representable. Computing in 256 bits and narrowing once at
//! the end removes the failure mode rather than bounding inputs to avoid it.

use soroban_sdk::{Env, U256};

/// Rounding direction for a conversion.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Rounding {
    /// Round toward zero — used where rounding must not favour the caller.
    Down,
    /// Round away from zero — used where rounding must not favour the caller.
    Up,
}

/// `a * b / denom`, computed in 256 bits and narrowed once.
///
/// Returns `None` if `denom` is zero or the result does not fit in `i128`.
pub fn mul_div(env: &Env, a: i128, b: i128, denom: i128, rounding: Rounding) -> Option<i128> {
    if denom <= 0 || a < 0 || b < 0 {
        return None;
    }
    let a256 = U256::from_u128(env, u128::try_from(a).ok()?);
    let b256 = U256::from_u128(env, u128::try_from(b).ok()?);
    let d256 = U256::from_u128(env, u128::try_from(denom).ok()?);

    let prod = a256.mul(&b256);
    let mut q = prod.div(&d256);

    if rounding == Rounding::Up {
        // Round up exactly when the division was not exact. Recomputing the product rather than
        // testing a remainder keeps this correct without a `rem` on U256.
        if q.mul(&d256) != prod {
            q = q.add(&U256::from_u32(env, 1));
        }
    }

    let narrowed = q.to_u128()?;
    i128::try_from(narrowed).ok()
}

/// Ten raised to `exp`, as `i128`. `None` on overflow.
pub fn pow10(exp: u32) -> Option<i128> {
    10i128.checked_pow(exp)
}
