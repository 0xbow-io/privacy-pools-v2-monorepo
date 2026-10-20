//! A local-only SEP-40 price oracle, so a local Blend pool can actually be BORROWED from.
//!
//! Never deployed outside the local network. Blend prices assets only for borrowing and collateral
//! checks; with no working oracle there can be no borrower, with no borrower no utilisation, and
//! with no utilisation `b_rate` stays at exactly 1.0 — which hides every rate-dependent path of the
//! yield module. `scripts/blend/deploy-local-blend.mts` wires this as the pool's oracle and opens a
//! borrow against it. Same shape as `MockOracle` in `yield-blend-adapter`'s tests.
#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

/// SEP-40's asset identifier; mirrors Blend's `pool::Asset` so the XDR matches.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    /// A Stellar asset, by its contract address.
    Stellar(Address),
    /// Any other asset, by symbol.
    Other(Symbol),
}

/// SEP-40's price record; mirrors Blend's `pool::PriceData`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    /// The price, in `decimals()` fixed point.
    pub price: i128,
    /// When the price was observed, in ledger seconds.
    pub timestamp: u64,
}

/// Prices every asset at exactly 1.0, always fresh.
#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    /// Prices are 7-decimal fixed point, as Blend's own fixtures assume.
    pub fn decimals(_env: Env) -> u32 {
        7
    }

    /// 1.0 for any asset, stamped with the current ledger time so Blend never sees it as stale.
    pub fn lastprice(env: Env, _asset: Asset) -> Option<PriceData> {
        Some(PriceData {
            price: 10_000_000,
            timestamp: env.ledger().timestamp(),
        })
    }
}
