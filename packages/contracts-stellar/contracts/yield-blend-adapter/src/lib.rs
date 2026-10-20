#![no_std]
//! [`LendingAdapter`](yield_adapter::LendingAdapter) over a Blend v2 lending pool.
//!
//! # Sourcing
//!
//! Every constant and conversion here was read out of Blend's own source, not inferred:
//!
//! * `RequestType::Supply = 0`, `Withdraw = 1` — `blend-contracts-v2/pool/src/pool/actions.rs`.
//! * `to_asset_from_b_token(b) = b * b_rate / SCALAR_12` (floor) —
//!   `blend-contracts-v2/pool/src/pool/reserve.rs`.
//! * `SCALAR_12 = 1e12` — `blend-contracts-v2/pool/src/constants.rs`.
//!
//! The scalar is worth stating plainly because **Blend v1 used `SCALAR_9`** for the same field.
//! Carrying the v1 figure into a v2 pool misprices every share by a factor of a thousand, silently,
//! in the direction that over-credits depositors. This adapter targets v2 (`blend-contract-sdk`
//! 2.x) and pins that dependency exactly, so the scalar cannot drift underneath it.
//!
//! The client itself is not hand-written: `blend-contract-sdk` generates it with `contractimport!`
//! from the deployed pool WASM, so the call surface cannot disagree with the live contract.
//!
//! # Position accounting
//!
//! Blend credits a supplier in **bTokens**, a non-rebasing receipt whose exchange rate to the
//! underlying rises as interest accrues. That is convenient here: the wrapper above only ever asks
//! `position_value()`, and converting bTokens through the live `b_rate` yields the underlying value
//! including accrued interest, with no bookkeeping of our own to drift.

#[cfg(test)]
mod test;

use blend_contract_sdk::pool::{Client as BlendPoolClient, Request};
use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::{contract, contractimpl, contracttype, token, vec, Address, Env, IntoVal, Symbol};
use yield_adapter::AdapterError;

/// Blend `RequestType::Supply`.
const REQUEST_SUPPLY: u32 = 0;
/// Blend `RequestType::Withdraw`.
const REQUEST_WITHDRAW: u32 = 1;
/// Blend v2's 12-decimal fixed-point scalar for `b_rate`. **v1 used 1e9.**
const SCALAR_12: i128 = 1_000_000_000_000;

/// Storage keys.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The wrapper permitted to move value through this adapter.
    Owner,
    /// Set the first time this adapter successfully supplies.
    ///
    /// Lets `position_value` tell "never supplied" apart from "supplied, and the venue has stopped
    /// reporting it" — the second is a silent, unrecoverable lock of the vault above.
    HasSupplied,
    /// The Blend pool contract.
    Pool,
    /// The underlying asset supplied to Blend.
    Underlying,
}

const DAY_LEDGERS: u32 = 17_280;
const LIFETIME_THRESHOLD: u32 = DAY_LEDGERS * 30;
const BUMP_AMOUNT: u32 = DAY_LEDGERS * 60;

/// Extend the instance TTL.
///
/// See the router's note: an instance entry is not bumped by invocation, so `initialize`-only
/// extension archives this adapter on a fixed clock. For the adapter that is worse than an
/// inconvenience — the wrapper's `redeem` runs through it, so the archival window is a withdrawal
/// outage for every yield note.
fn touch(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

/// Supplies the wrapper's underlying into a Blend pool.
#[contract]
pub struct BlendAdapter;

#[contractimpl]
impl BlendAdapter {
    /// Bind this adapter to its wrapper, a Blend pool, and the asset it supplies.
    pub fn initialize(
        env: Env,
        owner: Address,
        pool: Address,
        underlying: Address,
    ) -> Result<(), AdapterError> {
        let s = env.storage().instance();
        // One-shot. Without this, anyone can re-initialize the adapter, name themselves owner, and
        // withdraw the entire position — `require_owner` simply loads whoever was written last.
        if s.has(&DataKey::Owner) {
            return Err(AdapterError::AlreadyInitialized);
        }
        s.set(&DataKey::Owner, &owner);
        s.set(&DataKey::Pool, &pool);
        s.set(&DataKey::Underlying, &underlying);
        s.extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(())
    }

    /// The Blend pool this adapter supplies to.
    pub fn pool(env: Env) -> Result<Address, AdapterError> {
        env.storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(AdapterError::NotInitialized)
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

    fn parts(env: &Env) -> Result<(BlendPoolClient<'static>, Address), AdapterError> {
        let pool: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(AdapterError::NotInitialized)?;
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::Underlying)
            .ok_or(AdapterError::NotInitialized)?;
        Ok((BlendPoolClient::new(env, &pool), underlying))
    }

    /// Underlying value of this adapter's Blend supply position, interest included.
    ///
    /// Reads the reserve's live `b_rate` on every call rather than caching one. A cached rate is a
    /// stale price, and here it would be a stale price for minting shares.
    /// The supply entry, or `None` if the venue reports none.
    ///
    /// Separated from [`Self::position_value`] because a missing entry has two very different
    /// meanings and only the caller knows which applies: after a withdrawal that drained the
    /// position it is correct and expected, while on an ordinary read it means the venue has
    /// stopped reporting a position that still exists.
    fn raw_position(env: &Env) -> Result<Option<i128>, AdapterError> {
        let (pool, underlying) = Self::parts(env)?;
        let reserve = pool.get_reserve(&underlying);
        let positions = pool.get_positions(&env.current_contract_address());

        match positions.supply.get(reserve.config.index) {
            None => Ok(None),
            Some(b_tokens) => Ok(Some(
                b_tokens
                    .checked_mul(reserve.data.b_rate)
                    .ok_or(AdapterError::Overflow)?
                    .checked_div(SCALAR_12)
                    .ok_or(AdapterError::Overflow)?,
            )),
        }
    }

    /// Underlying value of this adapter's Blend supply position, interest included.
    ///
    /// Reads the reserve's live `b_rate` on every call rather than caching one. A cached rate is a
    /// stale price, and here it would be a stale price for minting shares.
    ///
    /// A missing entry is an ERROR once this adapter has supplied and still holds a position.
    /// `unwrap_or(0)` cannot distinguish "no position" from "we have lost track of the index" — a
    /// reserve re-index, a removal, a migration to the collateral map — and reporting zero for a
    /// position that still exists prices every share at zero and locks the vault above with the
    /// funds inside it, reachable by nobody.
    pub fn position_value(env: Env) -> Result<i128, AdapterError> {
        touch(&env);
        match Self::raw_position(&env)? {
            Some(v) => Ok(v),
            None => {
                if env.storage().instance().has(&DataKey::HasSupplied) {
                    Err(AdapterError::PositionMissing)
                } else {
                    Ok(0)
                }
            }
        }
    }

    /// See [`yield_adapter::LendingAdapter::supply_buffer`].
    ///
    /// One bToken, rounded up. `supply` converts underlying into bTokens with a floor, so a single
    /// call can credit up to one bToken less than it was handed, and one bToken is
    /// `b_rate / SCALAR_12` underlying.
    ///
    /// The `+ 1` is margin, not arithmetic necessity, and a mutant that removes it SURVIVES — this
    /// is accepted, not an untested guard. A floor loses strictly less than one bToken, so
    /// `b_rate / SCALAR_12` alone is already sufficient for every `b_rate >= SCALAR_12`, which is
    /// every value a supply index can take. EVM makes the same choice for the same reason:
    /// "a 1-wei buffer suffices; 2 is used for margin".
    pub fn supply_buffer(env: Env) -> Result<i128, AdapterError> {
        let (pool, underlying) = Self::parts(&env)?;
        pool.get_reserve(&underlying)
            .data
            .b_rate
            .checked_div(SCALAR_12)
            .ok_or(AdapterError::Overflow)?
            .checked_add(1)
            .ok_or(AdapterError::Overflow)
    }

    /// See [`yield_adapter::LendingAdapter::supply`].
    pub fn supply(env: Env, from: Address, amount: i128) -> Result<i128, AdapterError> {
        touch(&env);
        Self::require_owner(&env)?;
        if amount <= 0 {
            return Err(AdapterError::InvalidAmount);
        }
        let (pool, underlying) = Self::parts(&env)?;
        let here = env.current_contract_address();

        // Delta across the call, never the resulting absolute position (EVM audit C-7). Anyone can
        // supply to a Blend pool on this adapter's behalf; crediting an absolute figure would let a
        // donation be swept by whoever calls next.
        let before = Self::position_value(env.clone())?;

        // Pull the underlying in FIRST, then supply it as our own spender.
        //
        // This used to pass `from` straight to Blend as the `spender`. That made the depositor's
        // signature cover Blend's `submit` and the underlying `transfer` with this exact `amount` —
        // and for an exact-output mint the amount is derived from the share rate at EXECUTION. A
        // signature taken at simulation therefore stopped matching the moment `b_rate` moved a
        // stroop's worth, and Blend rejected the deposit (`auth: invalid_action`). On a reserve
        // with borrowers that is most deposits; it was invisible only because the local fixture's
        // rate was frozen at 1.0 and every test mocks auth.
        //
        // Now the only thing `from` authorizes is this plain transfer (`from` is the router, which
        // authorizes it at run time; a direct depositor names a fixed amount). Blend then sees this
        // adapter as both `from` and `spender` — the direct invoker of `submit` — and the one call
        // Blend makes on our behalf, moving the underlying into the pool, is pre-authorized here
        // with the amount we computed ourselves.
        token::TokenClient::new(&env, &underlying).transfer(&from, &here, &amount);
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: underlying.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (here.clone(), pool.address.clone(), amount).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);
        pool.submit(
            &here,
            &here,
            &here,
            &vec![
                &env,
                Request {
                    request_type: REQUEST_SUPPLY,
                    address: underlying,
                    amount,
                },
            ],
        );
        env.storage().instance().set(&DataKey::HasSupplied, &true);
        let after = Self::position_value(env.clone())?;
        after.checked_sub(before).ok_or(AdapterError::Overflow)
    }

    /// See [`yield_adapter::LendingAdapter::withdraw`].
    ///
    /// Blend fills a withdrawal only up to the position, and an illiquid pool can fail outright.
    /// The delta returned is what actually left, so a partial fill can never be reported as a full
    /// one to the wrapper's accounting.
    pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<i128, AdapterError> {
        touch(&env);
        Self::require_owner(&env)?;
        if amount <= 0 {
            return Err(AdapterError::InvalidAmount);
        }
        let (pool, underlying) = Self::parts(&env)?;
        let here = env.current_contract_address();

        let before = Self::position_value(env.clone())?;
        pool.submit(
            &here,
            &here,
            &to,
            &vec![
                &env,
                Request {
                    request_type: REQUEST_WITHDRAW,
                    address: underlying,
                    amount,
                },
            ],
        );
        // Read the post-withdrawal position TOLERANTLY. Blend deletes the supply entry when the
        // position reaches zero, so a full exit legitimately leaves no entry — and treating that as
        // `PositionMissing` trapped the vault's last redeemer, and any full migration, while a
        // withdrawal of one stroop less succeeded. The exact-cap case, on the side no suite tests.
        //
        // Clearing `HasSupplied` here is what keeps the guard honest afterwards: a later read of a
        // genuinely empty position returns 0 rather than erroring, and the guard re-arms on the
        // next supply.
        let after = match Self::raw_position(&env)? {
            Some(v) => v,
            None => {
                env.storage().instance().remove(&DataKey::HasSupplied);
                0
            }
        };
        let removed = before.checked_sub(after).ok_or(AdapterError::Overflow)?;
        if removed <= 0 {
            return Err(AdapterError::VenueRejected);
        }
        Ok(removed)
    }

    /// Claim BLND emissions accrued to this adapter's Blend position, sending them to `to`.
    ///
    /// Without this, emissions are **permanently unreachable**: they accrue to the adapter's own
    /// address inside Blend, and nothing else can call `claim` on its behalf. The wrapper's
    /// `rescue_token` cannot help — it moves the WRAPPER's balances, not the adapter's. That is
    /// real value stranded, not a missing convenience, and it is why EVM carries
    /// `claimRewards`/`rewardsController` on `PPYieldToken`.
    ///
    /// Owner-gated, like every other value-moving call here. Emissions are protocol revenue, not
    /// depositor backing: claiming them cannot touch the supply position, because Blend's `claim`
    /// only moves accrued reward tokens.
    ///
    /// `reserve_token_ids` are Blend's per-reserve emission indices. They are passed in rather than
    /// derived because a reserve has separate supply and borrow emission streams and only the
    /// caller knows which apply; a wrong id claims nothing rather than claiming wrongly.
    pub fn claim_emissions(
        env: Env,
        reserve_token_ids: soroban_sdk::Vec<u32>,
        to: Address,
    ) -> Result<i128, AdapterError> {
        touch(&env);
        Self::require_owner(&env)?;
        let (pool, _underlying) = Self::parts(&env)?;
        Ok(pool.claim(&env.current_contract_address(), &reserve_token_ids, &to))
    }

    /// See [`yield_adapter::LendingAdapter::underlying`].
    pub fn underlying(env: Env) -> Result<Address, AdapterError> {
        env.storage()
            .instance()
            .get(&DataKey::Underlying)
            .ok_or(AdapterError::NotInitialized)
    }

    /// Token client for the underlying, for callers that need to inspect balances.
    pub fn underlying_balance(env: Env, of: Address) -> Result<i128, AdapterError> {
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::Underlying)
            .ok_or(AdapterError::NotInitialized)?;
        Ok(token::TokenClient::new(&env, &underlying).balance(&of))
    }
}
