#![no_std]
//! `PPRouter` for Soroban — the pool `processor` for yield-bearing withdrawals.
//!
//! Ported from `v2-monorepo@b2a37959:packages/contracts/src/contracts/PPRouter.sol`.
//!
//! A yield withdrawal is a normal `transact` whose `token_id_out` is the wrapper's share token and
//! whose `processor` is this router. The pool pays the shares to the processor; the router then
//! unwraps them to underlying for the recipient, and separately for the relayer's fee.
//!
//! # Why the router must be the processor
//!
//! The pool pays `amount_out` of `token_id_out` to whatever address the proof names as processor.
//! If the router did not insist on being that address, a caller could have the pool pay the shares
//! somewhere else and still drive this contract's unwrap path. Requiring `processor == this` is
//! what binds the payout to the code that is about to unwrap it.
//!
//! A consequence worth stating, because it is a real limitation rather than an oversight: a yield
//! withdrawal can **never** be a `relay_batch` item, since the batch relay is itself the processor.
//! The two paths are mutually exclusive on EVM for the same reason.

#[cfg(test)]
mod test;

use contract_types::{Groth16Proof, NoteData};
use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, vec, Address, Bytes, Env, IntoVal,
    Symbol, Vec, U256,
};

/// Local mirror of the pool's `AssetConfig`.
///
/// Deliberately duplicated rather than imported. Depending on the `pool` crate for this one struct
/// pulls the entire pool contract into this WASM — it measured 112KB against a ~64KB limit, and it
/// broke `stellar contract build` outright, because LTO cannot link a second `cdylib`.
///
/// `contracttype` structs marshal as field-name maps, so a structurally identical mirror decodes
/// the real thing. The drift risk that duplication introduces is closed by a test rather than by
/// linkage: `the_local_asset_config_mirror_matches_the_pools` round-trips a real `pool::AssetConfig`
/// through this type and fails if a field is added, removed or retyped upstream.
#[contracttype]
#[derive(Clone, Debug)]
pub struct AssetConfig {
    /// Whether deposits are enabled for this asset.
    pub enabled: bool,
    /// Minimum deposit amount.
    pub min_deposit_amount: u128,
    /// Vetting fee in basis points (0-10000).
    pub vetting_fee_bps: u32,
    /// Accumulated fees available for withdrawal.
    pub accumulated_fees: u128,
    /// Maximum relay fee for this asset (nominal token amount).
    pub max_relay_fee: u128,
}

/// Contract errors.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Already initialized.
    AlreadyInitialized = 1,
    /// Not yet initialized.
    NotInitialized = 2,
    /// A withdrawal of zero shares.
    ZeroWithdrawal = 3,
    /// `token_id_out` is not this router's share token.
    AssetMismatch = 4,
    /// Reserved. The processor cannot be named by a caller — [`Self::withdraw_to_underlying`]
    /// hardcodes this contract as the processor and the pool folds it into the proof context, so
    /// EVM's `PPRouter_InvalidProcessor` check is structurally unreachable here. Kept as a
    /// placeholder so existing error codes keep their values.
    InvalidProcessorUnused = 5,
    /// The fee exceeds the per-asset cap.
    FeeExceedsMax = 6,
    /// The fee exceeds the withdrawal it is taken from.
    FeeExceedsWithdrawal = 7,
    /// The pool did not pay the expected shares.
    SharesNotReceived = 8,
    /// The unwrapped underlying is below the caller's floor.
    BelowMinUnderlying = 9,
    /// Arithmetic overflowed.
    Overflow = 10,
    /// The pool call failed.
    PoolRejected = 11,
    /// The wrapper call failed.
    VaultRejected = 12,
    /// A deposit of zero value.
    ZeroValue = 13,
    /// The underlying required exceeds the caller's ceiling.
    SlippageExceeded = 14,
}

/// Where a yield withdrawal's proceeds go.
///
/// Identical in shape and encoding to `relay::PayoutRouting`, deliberately: both are committed
/// into the same `context` public signal by the same pool, so the two encoders must agree
/// byte-for-byte or a proof built for one will not verify against the other.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PayoutRouting {
    /// Where the user's underlying goes.
    pub recipient: Address,
    /// Where the relay fee goes.
    pub fee_recipient: Address,
    /// Relay fee, denominated in SHARES (the pool pays `amount_out` in shares).
    pub fee_amount: u128,
}

/// Encode a routing into the `processor_data` bytes the proof's `context` commits to.
///
/// Must stay byte-identical to `relay::encode_routing` and to the SDK's `computeRelayContext`.
fn encode_routing(env: &Env, r: &PayoutRouting) -> Bytes {
    let mut buf = Bytes::new(env);
    buf.append(&r.recipient.to_string().to_bytes());
    buf.append(&r.fee_recipient.to_string().to_bytes());
    buf.append(&Bytes::from_slice(env, &r.fee_amount.to_le_bytes()));
    buf
}

/// Storage keys.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The privacy pool.
    Pool,
    /// The yield wrapper whose shares this router unwraps.
    Vault,
    /// Fixed destination for swept residue.
    DustRecipient,
}

const DAY_LEDGERS: u32 = 17_280;
const LIFETIME_THRESHOLD: u32 = DAY_LEDGERS * 30;
const BUMP_AMOUNT: u32 = DAY_LEDGERS * 60;

/// Cross-contract view of the yield wrapper.
#[soroban_sdk::contractclient(name = "VaultClient")]
pub trait VaultInterface {
    /// Underlying returned for redeeming `shares`.
    fn preview_redeem(env: Env, shares: i128) -> Result<i128, soroban_sdk::Error>;
    /// Burn `shares` from `owner`, sending underlying to `receiver`.
    fn redeem(
        env: Env,
        owner: Address,
        receiver: Address,
        shares: i128,
    ) -> Result<i128, soroban_sdk::Error>;
    /// Share balance of `id`.
    fn balance(env: Env, id: Address) -> i128;
    /// Underlying required to mint `shares`.
    fn preview_mint(env: Env, shares: i128) -> Result<i128, soroban_sdk::Error>;
    /// Mint exactly `shares` to `receiver`, pulling the underlying from `from`.
    fn mint(
        env: Env,
        from: Address,
        receiver: Address,
        shares: i128,
    ) -> Result<i128, soroban_sdk::Error>;
    /// The underlying asset the shares wrap.
    fn underlying(env: Env) -> Result<Address, soroban_sdk::Error>;
    /// The venue adapter the wrapper supplies through — where a mint pulls the underlying to.
    fn adapter_address(env: Env) -> Result<Address, soroban_sdk::Error>;
}

/// Cross-contract view of the pool.
#[soroban_sdk::contractclient(name = "PoolClient")]
pub trait PoolInterface {
    /// Spend notes and pay `amount_out` of `token_id_out` to the processor.
    #[allow(clippy::too_many_arguments)]
    fn transact(
        env: Env,
        processor: Address,
        processor_gated: bool,
        n: u32,
        m: u32,
        proof: Groth16Proof,
        state_root: U256,
        keystore_root: U256,
        asp_root: U256,
        amount_out: u128,
        token_id_out: U256,
        nullifier_hashes: Vec<U256>,
        output_commitments: Vec<U256>,
        asset: Address,
        note_data: Vec<NoteData>,
        processor_data: Bytes,
    ) -> Result<(), soroban_sdk::Error>;

    /// Insert a deposit commitment and register the ASP label atomically.
    fn deposit_with_label(
        env: Env,
        depositor: Address,
        asset: Address,
        value: u128,
        output_commitment: U256,
        proof: Groth16Proof,
        note_data: NoteData,
        ciphertext: Bytes,
    ) -> Result<(), soroban_sdk::Error>;

    /// Insert a deposit commitment, pulling `value` plus the vetting fee from `depositor`.
    fn deposit(
        env: Env,
        depositor: Address,
        asset: Address,
        value: u128,
        output_commitment: U256,
        proof: Groth16Proof,
        note_data: NoteData,
    ) -> Result<(), soroban_sdk::Error>;

    /// Per-asset configuration, including the vetting fee.
    fn get_asset_config(env: Env, asset: Address) -> Result<AssetConfig, soroban_sdk::Error>;
}

/// Extend the instance TTL.
///
/// Soroban does NOT bump an instance entry just because the contract was invoked, so a contract
/// whose only `extend_ttl` is in `initialize` archives on a fixed clock regardless of how much
/// traffic it carries — for this router, a full withdrawal outage every 60 days. The pool and the
/// wrapper both bump on every entrypoint; these did not.
fn touch(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

/// Routes yield-bearing withdrawals out of the pool.
#[contract]
pub struct YieldRouter;

#[contractimpl]
impl YieldRouter {
    /// Bind the router to its pool and wrapper.
    ///
    /// `dust_recipient` is the fixed destination for [`Self::skim`]. It is set once here rather
    /// than passed per call so the sweep can stay permissionless without being a griefing vector.
    ///
    /// The relay-fee ceiling is deliberately NOT stored: it is read live from the pool's per-asset
    /// config on every withdrawal (see [`Self::withdraw_to_underlying`]).
    pub fn initialize(
        env: Env,
        pool: Address,
        vault: Address,
        dust_recipient: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Pool) {
            return Err(Error::AlreadyInitialized);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Pool, &pool);
        s.set(&DataKey::Vault, &vault);
        s.set(&DataKey::DustRecipient, &dust_recipient);
        s.extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(())
    }

    /// The pool this router withdraws from.
    pub fn pool(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)
    }

    /// The wrapper whose shares this router unwraps.
    pub fn vault(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Vault)
            .ok_or(Error::NotInitialized)
    }

    /// Supply underlying, mint exactly the shares a shielded note commits to, and deposit them.
    ///
    /// The note commits to a **share** amount, not an underlying amount — that is what makes the
    /// position non-rebasing and therefore safe to shield. So the mint must be exact-output: the
    /// caller names the shares, and the underlying cost falls out of the current rate.
    ///
    /// `max_underlying_in` is the caller's ceiling on that cost, and it is the mirror of
    /// `min_underlying_out` on the way back: the share rate moves between quoting and execution,
    /// and without a ceiling a deposit executes at whatever rate it finds.
    ///
    /// The pool pulls `value` **plus the vetting fee** from the depositor, so the router must hold
    /// that total in shares — minting only `value` leaves the fee unfunded and the deposit reverts.
    ///
    /// The depositor transfers exactly `max_underlying_in` to the router and is refunded whatever
    /// the mint did not use, so the depositor's signature only ever covers fixed amounts. It must
    /// therefore HOLD `max_underlying_in`, not just the quoted cost. The alternative — the depositor
    /// authorizing the venue's pull of the exact cost — cannot work on Soroban: that cost is set by
    /// the share rate at execution, while the signature fixes the arguments at simulation, so any
    /// rate movement in between invalidates it (see `yield-blend-adapter::supply`). This is EVM's
    /// approve-the-ceiling, pull-what-is-needed shape.
    ///
    /// `asp_ciphertext` registers the note's label with the ASP in the same call, matching EVM's
    /// third `depositExactShares` argument. Empty skips registration, as it does upstream. Without
    /// it a yield deposit lands a funded commitment the ASP never learns the label for, so the note
    /// can never enter an association set and the only exit is `ragequit`, which exposes the label
    /// — a hazard the ordinary deposit path does not have.
    pub fn deposit_exact_shares(
        env: Env,
        from: Address,
        value: u128,
        output_commitment: U256,
        proof: Groth16Proof,
        note_data: NoteData,
        asp_ciphertext: Bytes,
        max_underlying_in: i128,
    ) -> Result<i128, Error> {
        touch(&env);
        from.require_auth();

        let pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        let vault_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Vault)
            .ok_or(Error::NotInitialized)?;
        let here = env.current_contract_address();

        if value == 0 {
            return Err(Error::ZeroValue);
        }

        let pool = PoolClient::new(&env, &pool_addr);
        let config = pool
            .try_get_asset_config(&vault_addr)
            .map_err(|_| Error::PoolRejected)?
            .map_err(|_| Error::PoolRejected)?;

        // The pool's own fee function, not a copy of it: deriving the fee any other way risks
        // minting a share too few, which the pool would reject only after the mint had happened.
        let fee = soroban_v2_utils::vetting_fee(value, config.vetting_fee_bps).ok_or(Error::Overflow)?;
        let total = value.checked_add(fee).ok_or(Error::Overflow)?;
        let total_shares = i128::try_from(total).map_err(|_| Error::Overflow)?;

        let vault = VaultClient::new(&env, &vault_addr);
        let quoted = vault
            .try_preview_mint(&total_shares)
            .map_err(|_| Error::VaultRejected)?
            .map_err(|_| Error::VaultRejected)?;
        // ACCEPTED MUTATION SURVIVORS, as a pair.
        //
        // This check and the one on the actual charge below cover each other, so neutering EITHER
        // alone changes no test result while neutering BOTH turns the suite red — verified. They
        // are not redundant in purpose: this one fails fast, before minting and before touching the
        // pool, so a caller whose ceiling is already exceeded does not pay for the work; the other
        // binds the guard to what was actually charged rather than to an invariant of a separate
        // contract. Mutation cannot distinguish members of a mutually-covering pair, and that is a
        // property of the technique, not a hole in the tests.
        if quoted > max_underlying_in {
            return Err(Error::SlippageExceeded);
        }

        // Baseline taken BEFORE the mint: the invariant is that the router ends the call holding
        // no more than it started with, i.e. the pool consumed exactly what was minted. Measuring
        // after the mint instead would treat the pool's correct pull as a mismatch.
        let shares_before = vault.balance(&here);

        let underlying_addr = vault.try_underlying().map_err(|_| Error::VaultRejected)?.map_err(|_| Error::VaultRejected)?;
        let adapter_addr = vault
            .try_adapter_address()
            .map_err(|_| Error::VaultRejected)?
            .map_err(|_| Error::VaultRejected)?;
        let underlying = token::TokenClient::new(&env, &underlying_addr);

        // Take the depositor's ceiling — a FIXED amount, so the depositor's signature over this
        // transfer cannot go stale between simulation and execution.
        underlying.transfer(&from, &here, &max_underlying_in);

        // The mint pulls its cost from us via the adapter (`transfer(router, adapter, cost)`),
        // two frames below — outside the invoker-auth fast path, so it is authorized here. The cost
        // is `quoted`: `preview_mint` and `mint` compute it in this same frame, against the same
        // state. If they ever disagreed the mint would fail on auth rather than over-charge.
        // An authorization covers only the NEXT call this contract makes, so each is set right
        // before the call it is for.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: underlying_addr.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (here.clone(), adapter_addr, quoted).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        // Exact-output mint, paid by the router out of the ceiling it now holds.
        let underlying_in = vault
            .try_mint(&here, &here, &total_shares)
            .map_err(|_| Error::VaultRejected)?
            .map_err(|_| Error::VaultRejected)?;

        // The pool pulls the shares with `transfer(from = this router, to = pool, total)`, and the
        // wrapper's `transfer` calls `from.require_auth()` inside a call the pool makes — again
        // outside the invoker-auth fast path. This is the EVM `forceApprove(ENTRYPOINT, _total)`
        // step, expressed the Soroban way. Every test in this crate but one mocks auth blanketly,
        // so only `the_depositor_signs_fixed_amounts_and_survives_a_rate_move` can see either.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: vault_addr.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (here.clone(), pool_addr.clone(), total_shares).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        pool.try_deposit_with_label(
            &here,
            &vault_addr,
            &value,
            &output_commitment,
            &proof,
            &note_data,
            &asp_ciphertext,
        )
        .map_err(|_| Error::PoolRejected)?
        .map_err(|_| Error::PoolRejected)?;

        if vault.balance(&here) != shares_before {
            return Err(Error::SharesNotReceived);
        }

        if underlying_in > max_underlying_in {
            // Enforced against the CHARGE as well as the quote. The two are provably equal today —
            // preview_mint and mint compute the same thing in the same frame — but that is an
            // invariant of a separate contract, and the ceiling is the caller's only protection.
            return Err(Error::SlippageExceeded);
        }

        // Refund what the mint did not use. Never negative: the ceiling check above holds.
        let refund = max_underlying_in.checked_sub(underlying_in).ok_or(Error::Overflow)?;
        if refund > 0 {
            underlying.transfer(&here, &from, &refund);
        }

        Ok(underlying_in)
    }

    /// Withdraw yield-bearing shares from the pool and pay the recipient in underlying.
    ///
    /// `routing` is **not** a free parameter. The `processor_data` handed to the pool is DERIVED
    /// from it here, and the pool folds that into the proof's `context` public signal — so a
    /// submitter who changes the recipient, the fee recipient or the fee produces a context the
    /// proof does not commit to, and the pool rejects it.
    ///
    /// This mirrors `relay::_relay`, and it is the only thing standing between an untrusted relayer
    /// and the whole withdrawal. An earlier version of this function took `recipient`,
    /// `fee_recipient` and `fee_amount` as free arguments alongside an opaque `processor_data`
    /// blob: a relayer could then submit a victim's proof with the victim's unmodified
    /// `processor_data` — satisfying the context check — while naming itself as recipient, and take
    /// 100% of the withdrawal. Found by the alignment lens; see the regression tests.
    ///
    /// `min_underlying_out` is the recipient's slippage floor: the share rate can move between
    /// quoting and execution, and without a floor a withdrawal executes at whatever rate it finds.
    /// It is deliberately NOT part of the routing — it is the submitter's own protection and
    /// tightening it can only cause a revert, never a redirection. EVM makes the same split.
    #[allow(clippy::too_many_arguments)]
    pub fn withdraw_to_underlying(
        env: Env,
        n: u32,
        m: u32,
        proof: Groth16Proof,
        state_root: U256,
        keystore_root: U256,
        asp_root: U256,
        amount_out: u128,
        token_id_out: U256,
        nullifier_hashes: Vec<U256>,
        output_commitments: Vec<U256>,
        note_data: Vec<NoteData>,
        routing: PayoutRouting,
        min_underlying_out: i128,
    ) -> Result<(i128, i128), Error> {
        touch(&env);
        let pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        let vault_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Vault)
            .ok_or(Error::NotInitialized)?;
        let here = env.current_contract_address();

        // The routing the caller supplied is the routing the proof must have committed to.
        let processor_data = encode_routing(&env, &routing);
        let recipient = routing.recipient.clone();
        let fee_recipient = routing.fee_recipient.clone();
        let fee_amount = i128::try_from(routing.fee_amount).map_err(|_| Error::Overflow)?;

        let shares_out = i128::try_from(amount_out).map_err(|_| Error::Overflow)?;
        if shares_out == 0 {
            return Err(Error::ZeroWithdrawal);
        }

        // `token_id_out` is the asset the pool pays the processor. It must be this router's share
        // token, or there is nothing here that can unwrap what arrives.
        if token_id_out != Self::asset_id(&env, &vault_addr) {
            return Err(Error::AssetMismatch);
        }

        // Read the ceiling LIVE from the pool's per-asset config rather than from a copy frozen
        // at deploy. A local copy can never be corrected, and can silently disagree with the cap
        // `contracts/relay` enforces on the same asset — this port's own INTL-22/INTL-25 say to
        // resolve such things through the pool so there is one source of truth.
        //
        // 0 means UNCAPPED, not "no fee permitted" (INTL-18 / EVM audit H1).
        let cap = i128::try_from(
            PoolClient::new(&env, &pool_addr)
                .try_get_asset_config(&vault_addr)
                .map_err(|_| Error::PoolRejected)?
                .map_err(|_| Error::PoolRejected)?
                .max_relay_fee,
        )
        .map_err(|_| Error::Overflow)?;
        if cap != 0 && fee_amount > cap {
            return Err(Error::FeeExceedsMax);
        }
        if fee_amount > shares_out {
            return Err(Error::FeeExceedsWithdrawal);
        }

        let vault = VaultClient::new(&env, &vault_addr);

        // Defensive: measure the shares this call actually delivered, tolerant of pre-existing dust.
        let before = vault.balance(&here);
        PoolClient::new(&env, &pool_addr)
            .try_transact(
                &here,
                &true,
                &n,
                &m,
                &proof,
                &state_root,
                &keystore_root,
                &asp_root,
                &amount_out,
                &token_id_out,
                &nullifier_hashes,
                &output_commitments,
                &vault_addr,
                &note_data,
                &processor_data,
            )
            .map_err(|_| Error::PoolRejected)?
            .map_err(|_| Error::PoolRejected)?;
        let after = vault.balance(&here);
        if after.checked_sub(before).ok_or(Error::Overflow)? != shares_out {
            return Err(Error::SharesNotReceived);
        }

        // The FEE leg redeems FIRST, and its waiver is decided at that moment.
        //
        // A fee leg that redeems to zero underlying is waived rather than charged: redeeming it
        // would trip the wrapper's zero-assets guard and revert the ENTIRE withdrawal, putting the
        // user's exit at the mercy of the relayer's fee policy — which is what the waiver exists to
        // prevent.
        //
        // Ordering it before the recipient leg is what makes the waiver sound. Decided beforehand
        // and executed afterwards, the decision uses a price the recipient's own redeem has since
        // moved: the wrapper re-baselines on every withdrawal, so a fee that previewed non-zero can
        // redeem to zero by the time it runs, and the revert is reachable again. EVM has no such
        // exposure — its zap unwraps 1:1 against a balanceOf-backed vault, so the price cannot move
        // between the legs. A floor-converted venue position can.
        let mut underlying_fee = 0i128;
        let payable_fee = if fee_amount != 0
            && vault
                .try_preview_redeem(&fee_amount)
                .map_err(|_| Error::VaultRejected)?
                .map_err(|_| Error::VaultRejected)?
                != 0
        {
            fee_amount
        } else {
            0
        };
        if payable_fee != 0 {
            underlying_fee = vault
                .try_redeem(&here, &fee_recipient, &payable_fee)
                .map_err(|_| Error::VaultRejected)?
                .map_err(|_| Error::VaultRejected)?;
        }

        // Whatever is left goes to the recipient — including the fee shares when the fee is waived,
        // so nothing is stranded in the router for `skim` to sweep away.
        let recipient_shares = shares_out.checked_sub(payable_fee).ok_or(Error::Overflow)?;
        // The fee leg is guarded against a zero preview; the recipient leg was not, so a
        // withdrawal whose recipient share redeems to nothing reverted deep inside the wrapper and
        // surfaced as the opaque `VaultRejected`. Diagnosable failure beats a generic one.
        let mut underlying_to_recipient = 0i128;
        if recipient_shares != 0
            && vault
                .try_preview_redeem(&recipient_shares)
                .map_err(|_| Error::VaultRejected)?
                .map_err(|_| Error::VaultRejected)?
                == 0
        {
            return Err(Error::BelowMinUnderlying);
        }
        if recipient_shares != 0 {
            underlying_to_recipient = vault
                .try_redeem(&here, &recipient, &recipient_shares)
                .map_err(|_| Error::VaultRejected)?
                .map_err(|_| Error::VaultRejected)?;
        }
        if underlying_to_recipient < min_underlying_out {
            return Err(Error::BelowMinUnderlying);
        }

        Ok((underlying_to_recipient, underlying_fee))
    }

    /// The pool's `token_id` for a contract address.
    ///
    /// The pool identifies assets by a field element derived from the address, so the router has to
    /// speak the same encoding to compare `token_id_out` against its own vault.
    fn asset_id(env: &Env, addr: &Address) -> U256 {
        soroban_v2_utils::encode_token_id(env, addr)
    }

    /// Sweep residue to the dust recipient fixed at initialization.
    ///
    /// Permissionless, and safe only because the destination is NOT a parameter. EVM's `skim`
    /// sweeps one token to an immutable `DUST_RECIPIENT` for exactly this reason
    /// (`IPPRouter.sol`: "the destination is fixed at construction, so there is no griefing
    /// vector"). The first version of this function took both the token and the destination from
    /// the caller, so anyone could sweep anything anywhere — under normal atomic operation the
    /// router holds nothing between calls, but that is an argument about reachability, not a
    /// guard.
    ///
    /// The token stays a parameter because a Soroban router can accumulate residue in either the
    /// share token or the underlying, and neither is knowable at initialization. The destination is
    /// what matters, and it is fixed.
    pub fn skim(env: Env, token_addr: Address) -> Result<i128, Error> {
        touch(&env);
        let to: Address = env
            .storage()
            .instance()
            .get(&DataKey::DustRecipient)
            .ok_or(Error::NotInitialized)?;
        let here = env.current_contract_address();
        let client = token::TokenClient::new(&env, &token_addr);
        let bal = client.balance(&here);
        if bal > 0 {
            client.transfer(&here, &to, &bal);
            env.events()
                .publish((Symbol::new(&env, "skimmed"), token_addr, to), bal);
        }
        Ok(bal)
    }

    /// The fixed destination for swept residue.
    pub fn dust_recipient(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::DustRecipient)
            .ok_or(Error::NotInitialized)
    }
}
