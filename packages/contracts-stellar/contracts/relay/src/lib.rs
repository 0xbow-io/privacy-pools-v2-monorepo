//! Privacy Pool V2 — Relay contract.
//!
//! Mirrors `v2-monorepo/packages/contracts/src/contracts/PrivacyPoolRelay.sol`.
//!
//! ## Purpose
//!
//! Relays private withdrawals on behalf of users: the relayer pays the
//! transaction gas, withdrawn funds go to `recipient`, and an optional
//! relay fee is split off to `fee_recipient`. The context-binding in the
//! transact proof commits to `(recipient, fee_recipient, fee_amount)`
//! via `processor_data`, so a different relayer cannot redirect the
//! payment nor modify the fee.
//!
//! ## Immutability (security-critical)
//!
//! This contract is **intentionally immutable** — there is no `upgrade()`
//! entrypoint. An upgradeable relay could be replaced with one that skips
//! the context check and steals the full withdrawal. Matches EVM:
//! `PrivacyPoolRelay.sol` does not inherit `UUPSUpgradeable`.
//!
//! ## References
//!
//! * EVM: `v2-monorepo/.../PrivacyPoolRelay.sol`
//! * Deviation: `docs/DEVIATIONS.md` INTL-01 (reversed), INTL-12 (reversed).

#![no_std]

use contract_types::{Groth16Proof, NoteData};
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Bytes, Env, Vec, U256,
};
use soroban_v2_utils::encode_token_id;

/// Maximum number of withdrawals in one `relay_batch` call.
///
/// Must be **strictly less than** the pool's `root_history_size` — enforced at
/// `initialize` (EVM audit finding **C-2**). Every item in a batch validates
/// against the same pre-batch state root, so a batch that can outgrow the ring
/// buffer would evict that root before the last item is checked, and the batch
/// would revert with an unknown-root error that looks like a proof problem.
pub const MAX_BATCH: u32 = 10;

/// TTL management: extend instance entries to prevent expiration.
const LIFETIME_THRESHOLD: u32 = 17_280; // ~1 day in ledgers
const BUMP_AMOUNT: u32 = 518_400; // ~30 days in ledgers

/// Cross-contract client for the Pool. Mirrors the subset of `PoolContract`
/// entrypoints the relay needs: `transact` (for the withdrawal) and
/// `get_asset_config` (to read `max_relay_fee`; 0 = uncapped, INTL-18).
#[contractclient(crate_path = "soroban_sdk", name = "PoolClient")]
pub trait PoolInterface {
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

    fn get_asset_config(env: Env, asset: Address) -> Result<AssetConfigRead, soroban_sdk::Error>;

    /// Resolved at call time rather than cached: the relay is immutable
    /// (INTL-01), so a cached keystore address could never be corrected.
    fn keystore(env: Env) -> Result<Address, soroban_sdk::Error>;

    /// Size of the pool's state-root ring buffer. Read once at relay
    /// initialize to enforce the MAX_BATCH invariant (audit C-2).
    fn root_history_size(env: Env) -> Result<u32, soroban_sdk::Error>;
}

/// Cross-contract client for the Keystore. Only the two entrypoints
/// `register_and_relay` needs: read the current registration, and create one.
#[contractclient(crate_path = "soroban_sdk", name = "KeystoreClient")]
pub trait KeystoreInterface {
    /// Non-failing probe: returns 0 for an unregistered account, mirroring the
    /// EVM public-mapping read. The failing `get_nullifying_key` cannot be used
    /// here — an unregistered account is the ordinary cold-start case, not an
    /// error to recover across a call boundary.
    fn get_nullifying_key_or_zero(env: Env, account: Address) -> U256;

    fn set_auth_policy(
        env: Env,
        owner: Address,
        nullifying_key_hash: U256,
        auth_digest: U256,
    ) -> Result<(), soroban_sdk::Error>;
}

/// Mirror of `pool::AssetConfig` for the read-only cross-contract query.
/// Matches the layout exactly (fields in declaration order, same names).
#[contracttype]
#[derive(Clone, Debug)]
pub struct AssetConfigRead {
    pub enabled: bool,
    pub min_deposit_amount: u128,
    pub vetting_fee_bps: u32,
    pub accumulated_fees: u128,
    pub max_relay_fee: u128,
}

/// One withdrawal within a `relay_batch` call.
///
/// The asset, recipient and fee recipient are NOT per-item: every item in a
/// batch must share them, so they are passed once to `relay_batch` and
/// cross-checked against each item.
#[contracttype]
#[derive(Clone, Debug)]
pub struct BatchItem {
    pub n: u32,
    pub m: u32,
    pub proof: Groth16Proof,
    pub state_root: U256,
    pub keystore_root: U256,
    pub asp_root: U256,
    pub amount_out: u128,
    pub token_id_out: U256,
    pub nullifier_hashes: Vec<U256>,
    pub output_commitments: Vec<U256>,
    pub note_data: Vec<NoteData>,
    pub routing: PayoutRouting,
}

/// Storage keys. Only two entries — both set once at init and never mutated.
#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    /// Pool contract address (immutable after initialize).
    /// EVM: `IPoolVault public immutable POOL;`
    Pool,
    /// Entrypoint contract address (immutable after initialize).
    /// EVM: `IEntrypoint public immutable ENTRYPOINT;`
    /// On Stellar, Pool and Entrypoint are collapsed into one contract
    /// (see `docs/DEVIATIONS.md` INTL-04), so this normally equals `Pool`;
    /// kept as a distinct slot for EVM-layout parity (and future split).
    Entrypoint,
    /// Reentrancy guard. Set at start of `relay`, cleared before return.
    /// Defense-in-depth against a custom SAC whose `transfer` re-enters
    /// `relay()`. Matches AUDIT-XCC-R1-01.
    Entered,
}

/// Relay contract errors.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Already initialized.
    AlreadyInitialized = 1,
    /// Not initialized.
    NotInitialized = 2,
    /// Pool or entrypoint address was zero-like (unsupported).
    ZeroAddress = 3,
    /// Withdrawn value is zero.
    ZeroWithdrawal = 4,
    /// Relay fee exceeds per-asset cap (`AssetConfig.max_relay_fee`).
    /// Never raised when the cap is 0 — 0 means "uncapped" (INTL-18).
    FeeExceedsMax = 5,
    /// Relay fee exceeds the withdrawn value.
    FeeExceedsWithdrawal = 6,
    /// Arithmetic overflow.
    ArithmeticOverflow = 7,
    /// Caller-supplied `asset` does not match the proof's `token_id_out`.
    /// Mirrors EVM single-source-of-truth `_asset = _proof.tokenIdOut()`.
    AssetMismatch = 9,
    /// Reentrancy detected — a nested `relay()` call attempted while an
    /// outer `relay()` is still executing (e.g. via a malicious SAC
    /// `transfer` hook).
    Reentrancy = 10,
    /// Batch is empty.
    EmptyBatch = 12,
    /// Batch exceeds `MAX_BATCH`.
    BatchTooLarge = 13,
    /// A batch item withdraws a different asset than item 0.
    InconsistentAsset = 14,
    /// A batch item pays a different recipient or fee recipient than item 0.
    InconsistentRecipient = 15,
    /// `MAX_BATCH` is not strictly below the pool's `root_history_size`
    /// (audit C-2) — checked once, at `initialize`.
    RootHistoryTooSmall = 16,
    /// `register_and_relay` could not register the owner in the keystore.
    ///
    /// Raised instead of letting the keystore's own error abort the call. A
    /// nested contract failure surfaces to the caller as an opaque `Abort`,
    /// and the keystore's codes overlap this contract's (keystore
    /// `AlreadyRegistered` is 4, same as `ZeroWithdrawal` here), so neither the
    /// raw abort nor the raw code is attributable. This variant says exactly
    /// which leg failed.
    RegistrationFailed = 11,
    // (No `PoolCallFailed` variant: pool errors bubble up verbatim, matching
    // EVM's default Solidity revert-propagation from `POOL.transact()` — the
    // relay is a thin passthrough for the verification failure.)
}

/// Routing for the relay payout. Mirrors EVM `PayoutRouting` struct.
/// Encoded into `processor_data` for context binding — the same encoding
/// MUST be reproduced by the SDK when generating the proof.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PayoutRouting {
    /// Where the user funds go (amount_out − fee_amount).
    pub recipient: Address,
    /// Where the relay fee goes.
    pub fee_recipient: Address,
    /// Relay fee (nominal token amount).
    pub fee_amount: u128,
}

/// Emitted when a relayed BATCH completes.
///
/// Mirrors EVM `RelayedBatch`: one aggregate event for the whole batch, not one
/// per item. `recipient_amount` and `fee_amount` are the batch totals, and
/// `count` is the number of withdrawals folded into them — an indexer that
/// needs per-item detail reads the pool's own `Transacted` events.
#[contractevent]
#[derive(Clone)]
pub struct RelayedBatch {
    /// Asset transferred.
    #[topic]
    pub asset: Address,
    /// The caller that submitted the batch (pays gas).
    #[topic]
    pub relayer: Address,
    /// Shared recipient of every withdrawal in the batch.
    pub recipient: Address,
    /// TOTAL amount delivered to the recipient across the batch.
    pub recipient_amount: u128,
    /// Shared fee recipient.
    pub fee_recipient: Address,
    /// TOTAL fee paid across the batch.
    pub fee_amount: u128,
    /// Number of withdrawals in the batch.
    pub count: u32,
}

/// Emitted when a relayed withdrawal completes.
#[contractevent]
#[derive(Clone)]
pub struct Relayed {
    /// Asset transferred.
    #[topic]
    pub asset: Address,
    /// The caller that submitted the relay tx (pays gas). Off-chain
    /// indexers use this to track per-relayer activity. On Stellar,
    /// distinct from `fee_recipient` (no implicit `msg.sender` fallback —
    /// see `docs/DEVIATIONS.md` INTL-01 sub-deviations).
    #[topic]
    pub relayer: Address,
    /// Recipient of the withdrawal.
    pub recipient: Address,
    /// Amount delivered to the recipient.
    pub recipient_amount: u128,
    /// Address that received the fee.
    pub fee_recipient: Address,
    /// Fee amount paid to fee_recipient.
    pub fee_amount: u128,
}

/// PrivacyPoolRelay contract.
#[contract]
pub struct RelayContract;

#[contractimpl]
impl RelayContract {
    /// Initialize the relay with **immutable** references to Pool and
    /// Entrypoint. Both addresses are set once and cannot be changed —
    /// the contract has no setter and no upgrade entrypoint.
    ///
    /// Mirrors EVM `PrivacyPoolRelay(accessRouter, pool, entrypoint)`
    /// constructor.
    pub fn initialize(env: Env, pool: Address, entrypoint: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Pool) {
            return Err(Error::AlreadyInitialized);
        }
        // Audit C-2: MAX_BATCH must be STRICTLY below the pool's root-history
        // size. Checked here because this contract is immutable (INTL-01) —
        // there is no later opportunity to correct it, so a misconfigured pair
        // must be caught at deploy time rather than surfacing as a confusing
        // unknown-root revert on the first full batch.
        let history = PoolClient::new(&env, &pool).root_history_size();
        if MAX_BATCH >= history {
            return Err(Error::RootHistoryTooSmall);
        }
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.storage()
            .instance()
            .set(&DataKey::Entrypoint, &entrypoint);
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(())
    }

    /// Maximum batch size (EVM: `MAX_BATCH()`).
    ///
    /// Exposed as a contract function, not just a Rust constant, so off-chain
    /// code can cross-check it against the pool's `root_history_size()` against
    /// the DEPLOYED values rather than a mirrored copy (DRIFT-1). Used by
    /// `scripts/deploy/verify-deployment.mjs` for the audit C-2 invariant.
    pub fn max_batch(_env: Env) -> u32 {
        MAX_BATCH
    }

    /// Returns the stored Pool address (EVM: `POOL()`).
    pub fn pool(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)
    }

    /// Returns the stored Entrypoint address (EVM: `ENTRYPOINT()`).
    ///
    /// On the current Stellar deployment this is identical to `pool()`
    /// (see INTL-04). Kept as a distinct slot for EVM-layout parity
    /// and to leave room for splitting Pool and Entrypoint later —
    /// callers should NOT rely on `pool() != entrypoint()`.
    pub fn entrypoint(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::Entrypoint)
            .ok_or(Error::NotInitialized)
    }

    /// Relay a transact-withdrawal. The relayer invokes this on behalf of
    /// the user who signed the proof. Steps:
    ///
    /// 1. Validate `fee_amount <= max_relay_fee` (per-asset cap from Entrypoint;
    ///    `max_relay_fee == 0` is the "uncapped" sentinel — see INTL-18).
    /// 2. Validate `fee_amount <= amount_out`.
    /// 3. Serialize `routing` into `processor_data` (deterministic encoding).
    /// 4. Call `pool.transact(..., processor=self, processor_data=<encoded>)`.
    ///    Pool recomputes the context hash from `processor + processor_data +
    ///    note_data` and rejects if it doesn't match the proof's context
    ///    public signal — this is the mechanism that binds the proof to the
    ///    exact `(recipient, fee_recipient, fee_amount)` tuple. Pool transfers
    ///    `amount_out` to this contract.
    /// 5. Split: `amount_out - fee_amount` → `recipient`; `fee_amount` →
    ///    `fee_recipient` (if non-zero).
    /// 6. Emit `Relayed` event.
    ///
    /// Mirrors EVM `PrivacyPoolRelay.relay()`.
    #[allow(clippy::too_many_arguments)]
    pub fn relay(
        env: Env,
        // The relayer (caller who submits this tx, pays gas). Required
        // explicitly because Soroban has no `msg.sender` primitive
        // accessible to contracts under cross-contract calls; taking
        // it as a parameter + `require_auth` gives an attributable
        // identity for the `Relayed` event.
        relayer: Address,
        // Transact params (mirror of pool.transact; routed through)
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
        // Relay-specific payout routing (also enforces context binding)
        routing: PayoutRouting,
    ) -> Result<(), Error> {
        relayer.require_auth();
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Reentrancy guard (AUDIT-XCC-R1-01). If a malicious SAC's
        // `transfer` re-enters `relay()`, this short-circuits before
        // any nested pool CCO fires.
        let entered: bool = env
            .storage()
            .instance()
            .get(&DataKey::Entered)
            .unwrap_or(false);
        if entered {
            return Err(Error::Reentrancy);
        }
        env.storage().instance().set(&DataKey::Entered, &true);

        // Load pool ref (always needed for the transact CCO)
        let pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        // EVM: `require(_withdrawnValue > 0, PrivacyPoolRelay_ZeroWithdrawal())`
        if amount_out == 0 {
            return Err(Error::ZeroWithdrawal);
        }

        // EVM: `require(_withdrawnValue >= _payout.feeAmount, PrivacyPoolRelay_FeeExceedsWithdrawal())`
        // Cheap check first; saves ~300 CPU on malformed requests over
        // running encode_token_id upfront (AUDIT-INFO-R1-02).
        if routing.fee_amount > amount_out {
            return Err(Error::FeeExceedsWithdrawal);
        }

        // Cross-check asset ↔ proof's tokenIdOut. EVM derives
        // `_asset = _proof.tokenIdOut()` — one source of truth. On Stellar
        // the asset is a separate param (needed to build the SAC client), so
        // we enforce consistency explicitly to eliminate the degree of
        // freedom a malicious relayer could otherwise exploit (different
        // asset → different max_relay_fee).
        if encode_token_id(&env, &asset) != token_id_out {
            return Err(Error::AssetMismatch);
        }

        // EVM: `require(_maxRelayFee == 0 || _payout.feeAmount <= _maxRelayFee,
        //         PrivacyPoolRelay_FeeExceedsMax())`
        //
        // `max_relay_fee == 0` means "NO CAP", not "no fee allowed". This is an
        // intentional, spec-documented sentinel: `IEntrypoint.AssetConfig`
        // documents 0 as "no maximum", and the SDK and relayer already assume
        // it. Without the sentinel a 0-config rejects every non-zero relay fee,
        // which is the opposite of what an operator configuring 0 intends.
        //
        // Ported from v2-monorepo `2cea13ae` ("honor maxRelayFee == 0 as
        // 'uncapped' on the core relay paths"). Upstream audit finding #200
        // proposed the reverse reading and was REJECTED as a false positive —
        // see docs/DEVIATIONS.md INTL-18. Do not "fix" this back.
        //
        // Only read the entrypoint config when a fee is actually being
        // charged — saves ~5-10M CPU on zero-fee relays (ALIGN-TOKEN-R1-09).
        // Entrypoint ref is loaded lazily here for the same reason
        // (REVIEW-STATE-R1-01).
        if routing.fee_amount > 0 {
            let entrypoint_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::Entrypoint)
                .ok_or(Error::NotInitialized)?;
            let entrypoint_client = PoolClient::new(&env, &entrypoint_addr);
            let asset_cfg = entrypoint_client.get_asset_config(&asset);
            if asset_cfg.max_relay_fee != 0 && routing.fee_amount > asset_cfg.max_relay_fee {
                return Err(Error::FeeExceedsMax);
            }
        }

        // Serialize routing into processor_data (binds context).
        // The SDK must produce bytewise-identical output.
        let processor_data = encode_routing(&env, &routing);

        // Invoke pool.transact with this contract as the (gated) processor.
        // Pool will recompute context = f(self_address, processor_data, note_data)
        // and reject on mismatch — this is what prevents fee/recipient MITM.
        let pool_client = PoolClient::new(&env, &pool_addr);
        let self_addr = env.current_contract_address();
        pool_client.transact(
            &self_addr,
            &true, // processor_gated
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
            &asset,
            &note_data,
            &processor_data,
        );
        // Pool transferred amount_out → this contract. Now split.

        let recipient_amount = amount_out
            .checked_sub(routing.fee_amount)
            .ok_or(Error::ArithmeticOverflow)?;

        let token_client = token::TokenClient::new(&env, &asset);

        // Payout to user recipient
        if recipient_amount > 0 {
            let amt_i128 =
                i128::try_from(recipient_amount).map_err(|_| Error::ArithmeticOverflow)?;
            token_client.transfer(&self_addr, &routing.recipient, &amt_i128);
        }

        // Payout to relayer (fee recipient). Matches EVM "if (_payout.feeAmount != 0)"
        if routing.fee_amount > 0 {
            let fee_i128 =
                i128::try_from(routing.fee_amount).map_err(|_| Error::ArithmeticOverflow)?;
            token_client.transfer(&self_addr, &routing.fee_recipient, &fee_i128);
        }

        Relayed {
            asset,
            relayer,
            recipient: routing.recipient,
            recipient_amount,
            fee_recipient: routing.fee_recipient,
            fee_amount: routing.fee_amount,
        }
        .publish(&env);

        // Clear the reentrancy guard on the happy path. Error paths
        // short-circuit earlier (before the guard is set), so this is
        // only reachable when the guard was set above.
        env.storage().instance().remove(&DataKey::Entered);

        Ok(())
    }

    /// Register the owner in the keystore if needed, then relay the
    /// withdrawal — atomically, in one transaction.
    ///
    /// Mirrors EVM `PrivacyPoolRelay.registerAndRelay` (v2-monorepo `0fb6ffcd`,
    /// hardened by `6d2a26e1`). This is the cold-start flow: a fresh owner with
    /// no gas can be registered and paid out by a relayer in a single
    /// transaction, with the registration gas absorbed into the relay fee.
    ///
    /// ## Why there is no signature parameter (deviation from EVM)
    ///
    /// EVM needs `setAuthPolicyWithSig(..., deadline, signature)` — an EIP-712
    /// typed payload plus `ecrecover`/EIP-1271 — because `msg.sender` there is
    /// the relayer, so the account's intent has to be re-proved in-contract.
    /// Audit finding C-8 then had to add a `deadline` to that payload, because
    /// a hand-rolled signature scheme has no expiry of its own.
    ///
    /// Soroban separates authorization from invocation natively. `set_auth_policy`
    /// already calls `owner.require_auth()`, and a relayer submits the
    /// transaction carrying the owner's pre-signed `SorobanAuthorizationEntry`.
    /// That entry's `SorobanAddressCredentials` carries **both** a `nonce` and a
    /// `signature_expiration_ledger`, enforced by the protocol, and the signed
    /// payload is already bound to the network and the invoked contract.
    ///
    /// So the three properties C-8 and its EIP-712 wrapper exist to provide —
    /// expiry, replay protection, and domain separation — are provided by the
    /// platform here. Adding a `deadline` parameter and a second signature
    /// scheme would be strictly worse: a hand-rolled duplicate of an audited
    /// protocol mechanism. See docs/DEVIATIONS.md INTL-23.
    ///
    /// ## Idempotency (EVM audit finding L-1)
    ///
    /// If the owner is ALREADY registered with the exact `nullifying_key_hash`
    /// requested, registration is skipped and this degrades to a plain relay
    /// rather than failing. Without that, a third party who observes the pending
    /// transaction can replay the registration on its own — for no gain to
    /// themselves — and brick the bundle, because `set_auth_policy` is one-time
    /// per account. The skip is safe: the authorization only ever covered this
    /// exact registration, which is now already done, and the withdrawal stays
    /// gated by the proof, whose keystore root is unaffected by who submitted
    /// the registration.
    ///
    /// A *mismatched* existing key still fails, in the keystore's own one-time
    /// guard — that is a different account state than the caller asked for.
    #[allow(clippy::too_many_arguments)]
    pub fn register_and_relay(
        env: Env,
        relayer: Address,
        // Keystore registration for the withdrawing owner.
        owner: Address,
        nullifying_key_hash: U256,
        auth_digest: U256,
        // Transact params, forwarded verbatim to `relay`.
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
        routing: PayoutRouting,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Resolve the keystore through the pool so there is one source of
        // truth, and so an immutable relay can never hold a stale address.
        let pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        let keystore_addr = PoolClient::new(&env, &pool_addr).keystore();
        let ks = KeystoreClient::new(&env, &keystore_addr);

        // Registration must complete BEFORE the withdrawal: the proof's
        // keystore-membership check needs the leaf already inserted.
        //
        // 0 means "not registered" and can never be a stored value, so this
        // single read distinguishes all three cases: unregistered (register),
        // registered with the same key (skip — the L-1 idempotency case), and
        // registered with a different key (attempt, and let the keystore's
        // one-time guard reject it).
        let existing = ks.get_nullifying_key_or_zero(&owner);

        if existing != nullifying_key_hash {
            // `try_` so a keystore rejection becomes an attributable relay
            // error rather than an opaque nested abort. The common cause is a
            // mismatched existing key — a different account state than the
            // caller asked for, which must NOT be silently skipped.
            ks.try_set_auth_policy(&owner, &nullifying_key_hash, &auth_digest)
                .map_err(|_| Error::RegistrationFailed)?
                .map_err(|_| Error::RegistrationFailed)?;
        }

        Self::relay(
            env,
            relayer,
            n,
            m,
            proof,
            state_root,
            keystore_root,
            asp_root,
            amount_out,
            token_id_out,
            nullifier_hashes,
            output_commitments,
            asset,
            note_data,
            routing,
        )
    }

    /// Relay several withdrawals of the SAME asset to the SAME recipient in one
    /// atomic transaction, with a single aggregate payout at the end.
    ///
    /// Mirrors EVM `PrivacyPoolRelay.relayBatch` (v2-monorepo `2398d737`,
    /// hardened by `423cea65`).
    ///
    /// Invariants, in enforced order:
    /// 1. the batch is non-empty and at most `MAX_BATCH` items;
    /// 2. every item withdraws the same `asset` as declared (and as bound into
    ///    its own proof via `token_id_out`);
    /// 3. every item pays the same recipient and fee recipient as item 0 — no
    ///    mixed-destination batches;
    /// 4. every item withdraws a non-zero amount, with a fee not exceeding that
    ///    item's own withdrawal;
    /// 5. the fee is within the per-asset cap, honouring the `0 = uncapped`
    ///    sentinel (INTL-18);
    /// 6. execution is atomic — any item's failure aborts the whole batch,
    ///    which on Soroban is the default host behaviour for a failed
    ///    cross-contract call, so there is nothing to unwind by hand;
    /// 7. all items validate against the same pre-batch state root, which is
    ///    what `MAX_BATCH < root_history_size` (audit C-2, checked at
    ///    `initialize`) exists to guarantee.
    ///
    /// Payout is a SINGLE transfer per leg at the end, not one per item: the
    /// pool credits this contract for each `transact`, and the totals are
    /// forwarded once.
    ///
    /// Unlike EVM there is no native-gas leg to reconcile — Stellar's
    /// `PayoutRouting` carries no `gas_funding` (INTL-01), so the EVM
    /// `msg.value == sum(nativeGas)` check has no counterpart here.
    pub fn relay_batch(
        env: Env,
        relayer: Address,
        asset: Address,
        items: Vec<BatchItem>,
    ) -> Result<(), Error> {
        relayer.require_auth();
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);

        let count = items.len();
        if count == 0 {
            return Err(Error::EmptyBatch);
        }
        if count > MAX_BATCH {
            return Err(Error::BatchTooLarge);
        }

        // Reentrancy guard, same as `relay`.
        let entered: bool = env
            .storage()
            .instance()
            .get(&DataKey::Entered)
            .unwrap_or(false);
        if entered {
            return Err(Error::Reentrancy);
        }
        env.storage().instance().set(&DataKey::Entered, &true);

        let pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        let entrypoint_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Entrypoint)
            .ok_or(Error::NotInitialized)?;

        let expected_token_id = encode_token_id(&env, &asset);
        let reference = items.get_unchecked(0).routing;

        // Read the per-asset cap once for the whole batch — every item shares
        // the asset, so the cap cannot differ between them.
        let max_relay_fee = PoolClient::new(&env, &entrypoint_addr)
            .get_asset_config(&asset)
            .max_relay_fee;

        let mut total_recipient: u128 = 0;
        let mut total_fee: u128 = 0;

        // PASS 1 — validate EVERY item before executing ANY of them.
        //
        // This is a STELLAR-SIDE DESIGN CHOICE, not a port of an EVM refactor.
        // EVM's `relayBatch` is single-pass at `b2a37959`: its loop validates
        // item i and immediately calls `POOL.transact` for item i before
        // validating item i+1, relying on revert-unwind for atomicity. (An
        // earlier version of this comment credited `423cea65` with a fail-fast
        // restructure; that commit was a cosmetic operand swap,
        // `feeAmount <= amountOut` to `amountOut >= feeAmount`, and nothing
        // more. Corrected after an alignment audit — do not cite it as evidence
        // that EVM is two-pass. See docs/DEVIATIONS.md INTL-27.)
        //
        // The externally observable result is identical — all-or-nothing either
        // way. Two-pass is preferred here because proof verification is the
        // expensive step: validating first means a malformed item N is caught
        // without paying for items 0..N-1's proofs, and the caller gets the real
        // rejection reason rather than whatever item 0 happened to hit.
        for item in items.iter() {
            if item.amount_out == 0 {
                return Err(Error::ZeroWithdrawal);
            }
            if item.token_id_out != expected_token_id {
                return Err(Error::InconsistentAsset);
            }
            if item.routing.recipient != reference.recipient
                || item.routing.fee_recipient != reference.fee_recipient
            {
                return Err(Error::InconsistentRecipient);
            }
            if item.routing.fee_amount > item.amount_out {
                return Err(Error::FeeExceedsWithdrawal);
            }
            // `max_relay_fee == 0` means uncapped (INTL-18).
            if max_relay_fee != 0 && item.routing.fee_amount > max_relay_fee {
                return Err(Error::FeeExceedsMax);
            }

            let recipient_amount = item
                .amount_out
                .checked_sub(item.routing.fee_amount)
                .ok_or(Error::ArithmeticOverflow)?;
            total_recipient = total_recipient
                .checked_add(recipient_amount)
                .ok_or(Error::ArithmeticOverflow)?;
            total_fee = total_fee
                .checked_add(item.routing.fee_amount)
                .ok_or(Error::ArithmeticOverflow)?;
        }

        // PASS 2 — execute. Every item is already known well-formed.
        for item in items.iter() {
            // Each item binds its own routing into its own proof context, so
            // the per-item encoding is preserved even though the payout is
            // aggregated.
            let processor_data = encode_routing(&env, &item.routing);
            PoolClient::new(&env, &pool_addr).transact(
                &env.current_contract_address(),
                &true,
                &item.n,
                &item.m,
                &item.proof,
                &item.state_root,
                &item.keystore_root,
                &item.asp_root,
                &item.amount_out,
                &item.token_id_out,
                &item.nullifier_hashes,
                &item.output_commitments,
                &asset,
                &item.note_data,
                &processor_data,
            );
        }

        // Single aggregate payout per leg.
        let self_addr = env.current_contract_address();
        let token_client = token::TokenClient::new(&env, &asset);
        if total_recipient > 0 {
            let amt = i128::try_from(total_recipient).map_err(|_| Error::ArithmeticOverflow)?;
            token_client.transfer(&self_addr, &reference.recipient, &amt);
        }
        if total_fee > 0 {
            let fee = i128::try_from(total_fee).map_err(|_| Error::ArithmeticOverflow)?;
            token_client.transfer(&self_addr, &reference.fee_recipient, &fee);
        }

        RelayedBatch {
            asset,
            relayer,
            recipient: reference.recipient,
            recipient_amount: total_recipient,
            fee_recipient: reference.fee_recipient,
            fee_amount: total_fee,
            count,
        }
        .publish(&env);

        env.storage().instance().remove(&DataKey::Entered);
        Ok(())
    }
}

/// Serialize `PayoutRouting` into deterministic bytes for the
/// `processor_data` context binding.
///
/// Encoding (length-prefixed; deliberately the same discipline as the pool
/// context encoder):
///
/// ```text
/// recipient_strkey       (56 bytes, strkey charset is ASCII-compatible)
/// fee_recipient_strkey   (56 bytes, strkey charset is ASCII-compatible)
/// fee_amount             (16 bytes u128 little-endian)
/// ```
///
/// The strkey alphabet (`[GC][A-Z2-7]{55}`) is a strict subset of
/// ASCII, so `to_string().to_bytes()` produces identical output to any
/// of {ASCII, latin1, UTF-8} encodings.
///
/// The SDK's `computeRelayContext` MUST produce the identical bytes.
fn encode_routing(env: &Env, r: &PayoutRouting) -> Bytes {
    let mut buf = Bytes::new(env);
    buf.append(&r.recipient.to_string().to_bytes());
    buf.append(&r.fee_recipient.to_string().to_bytes());
    buf.append(&Bytes::from_slice(env, &r.fee_amount.to_le_bytes()));
    buf
}

#[cfg(test)]
mod test;
