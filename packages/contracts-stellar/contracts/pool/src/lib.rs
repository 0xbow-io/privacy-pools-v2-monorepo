//! Privacy Pool V2 — Main pool contract.
//!
//! Handles deposit, transact (NxM), ragequit, pause/unpause,
//! role management, multi-asset configuration, and fee collection.
//! Groth16 proof verification is inline (not cross-contract).
//! Reads keystore and ASP roots via cross-contract calls.

#![no_std]

extern crate alloc;

use contract_types::{Groth16Proof, NoteData, VerificationKeyBytes, SNARK_SCALAR_FIELD_BYTES};
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    token, Address, Bytes, BytesN, Env, U256, Vec,
};
use soroban_v2_utils::{
    address_to_field, encode_token_id, groth16::verify_groth16, lean_imt::lean_imt_insert,
    lean_imt::lean_imt_insert_many_ctx, poseidon::commitment_leaf_tag,
    poseidon::nullifier_leaf_tag, poseidon::poseidon_hash_three,
    poseidon::poseidon_hash_three_ctx, poseidon::PoseidonT3Ctx, poseidon::PoseidonT4Ctx,
    root_buffer,
};

/// TTL management: extend persistent entries to prevent expiration.
const LIFETIME_THRESHOLD: u32 = 17_280; // ~1 day in ledgers
const BUMP_AMOUNT: u32 = 518_400; // ~30 days in ledgers

/// Cross-contract client interface for Keystore.
#[contractclient(crate_path = "soroban_sdk", name = "KeystoreClient")]
pub trait KeystoreInterface {
    /// Check if a root is known in the keystore's root history.
    fn is_known_root(env: Env, root: U256) -> Result<bool, soroban_sdk::Error>;
}

/// Cross-contract client interface for ASP Registry.
#[contractclient(crate_path = "soroban_sdk", name = "AspRegistryClient")]
pub trait AspRegistryInterface {
    /// Get the latest ASP root.
    fn latest_asp_root(env: Env) -> Result<U256, soroban_sdk::Error>;

    /// Register a label (permissionless; emits `LabelRegistered`).
    fn register_label(env: Env, ciphertext: soroban_sdk::Bytes);
}

/// Storage keys for pool contract.
#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    /// Contract admin address.
    Admin,
    /// Pauser role address.
    Pauser,
    /// Unpauser role address.
    Unpauser,
    /// Asset manager role address.
    AssetManager,
    /// Upgrader role address (mirrors EVM UPGRADER_ROLE). Unset = no
    /// upgrader assigned; `upgrade()` will reject. Admin can rotate via
    /// `set_roles`; to "freeze" upgrades, admin rotates to a known-dead
    /// address (equivalent to EVM `renounceRole` cooperation model).
    Upgrader,
    /// Whether the pool is paused.
    Paused,
    /// Keystore contract address.
    Keystore,
    /// ASP Registry contract address.
    AspRegistry,
    /// Per-asset configuration.
    AssetConfig(Address),
    /// Reverse index: 160-bit token id -> the asset Address that owns it.
    /// Enforces tokenId uniqueness across registered assets (cffcaca9 INS-1
    /// truncates tokenId to 160 bits; this guards against a colliding
    /// registration confusing two assets in proofs).
    TokenIdAsset(U256),
    /// Commitment existence marker.
    Commitment(U256),
    /// Nullifier spend marker.
    Nullifier(U256),
    /// LeanIMT side node at level.
    SideNode(u32),
    /// LeanIMT tree size.
    TreeSize,
    /// Configured circuit-aligned max state-tree size (= 2^stateMaxDepth).
    MaxStateTreeSize,
    /// Root history entry at index.
    Root(u32),
    /// Current root index in circular buffer.
    CurrentRootIndex,
    /// Root history buffer size.
    RootHistorySize,
    /// Verification key for (proof_type, n, m).
    Vk(u32, u32, u32),
}

/// Per-asset configuration.
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
    /// Maximum relay fee for this asset (in nominal token amount).
    /// Enforced by the external Relay contract (see `contracts/relay/`).
    /// Mirrors EVM `IEntrypoint.AssetConfig.maxRelayFee`.
    pub max_relay_fee: u128,
}

/// Pool contract errors.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Caller is not authorized.
    NotAuthorized = 1,
    /// Contract already initialized.
    AlreadyInitialized = 2,
    /// Contract not initialized.
    NotInitialized = 3,
    /// Invalid proof.
    InvalidProof = 4,
    /// Nullifier already spent.
    NullifierAlreadySpent = 5,
    /// Unknown state root.
    UnknownRoot = 6,
    /// Commitment already exists.
    DuplicateCommitment = 7,
    /// Pool is paused.
    PoolPaused = 8,
    /// Asset not configured or disabled.
    AssetNotEnabled = 10,
    /// Deposit below minimum.
    BelowMinDeposit = 11,
    /// Arithmetic overflow.
    ArithmeticOverflow = 12,
    /// Insufficient fees for withdrawal.
    InsufficientFees = 13,
    /// Invalid token ID.
    InvalidTokenId = 14,
    /// Keystore root not found.
    UnknownKeystoreRoot = 15,
    /// ASP root mismatch.
    InvalidAspRoot = 16,
    /// Tree is full.
    TreeFull = 18,
    /// Invalid NxM configuration.
    InvalidNxM = 19,
    /// Commitment not found (ragequit).
    CommitmentNotFound = 21,
    /// VK not found for this proof type/config.
    VkNotFound = 22,
    /// Invalid deposit value (zero).
    InvalidValue = 23,
    /// Duplicate nullifier within same transaction.
    DuplicateNullifier = 24,
    /// Root history size must be non-zero.
    InvalidRootHistorySize = 25,
    /// Vetting fee BPS must be less than 10000.
    InvalidFeeBps = 26,
    /// `new_wasm_hash` is zero or otherwise invalid.
    InvalidWasmHash = 28,
    /// `max_relay_fee` exceeds the sanity ceiling (10^30 nominal units).
    InvalidMaxRelayFee = 29,
    /// A different asset is already registered with the same 160-bit token id.
    TokenIdCollision = 30,
    /// An enabled asset must have a strictly-positive minimum deposit amount.
    InvalidMinAmount = 31,
    /// New max state-tree size must exceed the current tree size.
    InvalidMaxTreeSize = 32,
    /// State tree is full (configured circuit-aligned cap reached).
    StateTreeFull = 33,
    /// Ragequit value must be non-zero.
    ZeroValueRagequit = 34,
    /// A withdrawal (`amount_out > 0`) must be processor-gated: ungated, the processor is neither
    /// authorised nor bound by the proof, so anyone could resubmit it paying themselves.
    UngatedWithdrawal = 35,
}

/// Emitted when a deposit is made.
#[contractevent]
#[derive(Clone)]
pub struct Deposited {
    /// The output commitment.
    #[topic]
    pub commitment: U256,
    /// The asset deposited.
    pub asset: Address,
    /// The value deposited (before fee).
    pub value: u128,
    /// The depositor address.
    pub depositor: Address,
}

/// Emitted when roles are updated.
#[contractevent]
#[derive(Clone)]
pub struct RolesUpdated {
    /// New pauser address.
    pub pauser: Address,
    /// New unpauser address.
    pub unpauser: Address,
    /// New asset manager address.
    pub asset_manager: Address,
    /// New upgrader address.
    pub upgrader: Address,
}

/// Emitted when the max state-tree size is updated.
#[contractevent]
#[derive(Clone)]
pub struct MaxStateTreeSizeUpdated {
    /// Previous max state-tree size.
    pub previous: u32,
    /// New max state-tree size.
    pub new_max: u32,
}

/// Emitted when the keystore dependency is repointed (EVM `KeystoreSet`).
#[contractevent]
#[derive(Clone)]
pub struct KeystoreSet {
    /// Previous keystore contract.
    pub previous: Address,
    /// New keystore contract.
    pub new_keystore: Address,
}

/// Emitted when the ASP registry dependency is repointed (EVM `AspRegistrySet`).
#[contractevent]
#[derive(Clone)]
pub struct AspRegistrySet {
    /// Previous ASP registry contract.
    pub previous: Address,
    /// New ASP registry contract.
    pub new_asp_registry: Address,
}

/// Emitted when an asset config is updated.
#[contractevent]
#[derive(Clone)]
pub struct AssetConfigUpdated {
    /// Asset address.
    #[topic]
    pub asset: Address,
    /// Whether enabled.
    pub enabled: bool,
    /// Minimum deposit amount.
    pub min_deposit: u128,
    /// Fee in basis points.
    pub vetting_fee_bps: u32,
    /// Maximum relay fee (nominal token amount).
    pub max_relay_fee: u128,
}

/// Emitted when a transact is processed.
/// Note: encrypted payloads are emitted separately via NoteEvent (one per output note).
#[contractevent]
#[derive(Clone)]
pub struct Transacted {
    /// Output commitments.
    pub commitments: Vec<U256>,
    /// Spent nullifiers.
    pub nullifiers: Vec<U256>,
    /// Withdrawal asset (if any).
    pub asset: Address,
    /// Withdrawal amount.
    pub amount_out: u128,
    /// Transaction processor.
    pub processor: Address,
}

/// Emitted when a ragequit is processed.
#[contractevent]
#[derive(Clone)]
pub struct RagequitEvent {
    /// Owner address (exposed).
    #[topic]
    pub owner: Address,
    /// Asset withdrawn.
    pub asset: Address,
    /// Value withdrawn.
    pub value: u128,
    /// Commitment being nullified.
    pub commitment: U256,
    /// Nullifier hash.
    pub nullifier_hash: U256,
    /// Label (exposed, breaks privacy).
    pub label: U256,
}

/// Emitted when pool is paused.
#[contractevent]
#[derive(Clone)]
pub struct PoolPausedEvent {}

/// Emitted when pool is unpaused.
#[contractevent]
#[derive(Clone)]
pub struct PoolUnpausedEvent {}

/// Emitted when a verification key is stored.
#[contractevent]
#[derive(Clone)]
pub struct VkUpdated {
    /// Proof type (0 = deposit, 1 = transact, 2 = ragequit).
    pub proof_type: u32,
    /// Number of inputs (N).
    pub n: u32,
    /// Number of outputs (M).
    pub m: u32,
}

/// Emitted when fees are withdrawn.
#[contractevent]
#[derive(Clone)]
pub struct FeesWithdrawn {
    /// Asset address.
    #[topic]
    pub asset: Address,
    /// Amount withdrawn.
    pub amount: u128,
    /// Recipient address.
    pub recipient: Address,
}

/// Emitted once per output note (shared across deposit and transact flows).
/// Matches EVM's `Note(bytes32 indexed hint, bytes data)` event.
#[contractevent]
#[derive(Clone)]
pub struct NoteEvent {
    /// Indexed tag for RPC-level log filtering (opaque to the contract).
    #[topic]
    pub hint: BytesN<32>,
    /// Encrypted note payload (opaque to the contract).
    pub data: Bytes,
}

/// Emitted when leaves are inserted into the state tree.
/// Matches EVM's `LeavesInserted(uint256[] _newLeaves, uint256 _root, uint256 _startIndex)`.
#[contractevent]
#[derive(Clone)]
pub struct LeavesInserted {
    /// The new leaves inserted.
    pub leaves: Vec<U256>,
    /// The new Merkle root.
    pub root: U256,
    /// Start index of the insertion.
    pub start_index: u32,
}

/// Compute context hash for deposit proof binding.
///
/// Encoding: `keccak256(hint || data_len_le32 || data) % SNARK_SCALAR_FIELD`
///
/// This binds the deposit proof to the note discovery data (hint + encrypted payload),
/// preventing replay with different note metadata.
fn compute_deposit_context(
    env: &Env,
    note_data: &NoteData,
) -> U256 {
    let mut buf = Bytes::new(env);

    // Hint (32 bytes, raw)
    let hint_bytes: BytesN<32> = note_data.hint.clone();
    buf.append(&Bytes::from_slice(env, &hint_bytes.to_array()));

    // Data with length prefix (4 bytes LE)
    let data_len = note_data.data.len();
    buf.append(&Bytes::from_slice(env, &data_len.to_le_bytes()));
    buf.append(&note_data.data);

    // keccak256 mod field
    let hash = env.crypto().keccak256(&buf);
    let hash_u256 = U256::from_be_bytes(env, &Bytes::from_slice(env, &hash.to_array()));
    let field = U256::from_be_bytes(env, &Bytes::from_slice(env, &SNARK_SCALAR_FIELD_BYTES));
    hash_u256.rem_euclid(&field)
}

/// Compute context hash for transact proof binding.
///
/// Encoding: `keccak256(processor_strkey || processor_data_len_le32 || processor_data || num_notes_le32 || [hint || data_len_le32 || data]...) % SNARK_SCALAR_FIELD`
///
/// This binds the proof to the specific processor, processor data (e.g. fee parameters),
/// and note discovery data (hints + encrypted payloads), preventing front-running and replay.
fn compute_transact_context(
    env: &Env,
    processor: &Address,
    processor_data: &Bytes,
    note_data: &Vec<NoteData>,
    processor_gated: bool,
) -> Result<U256, Error> {
    let mut buf = Bytes::new(env);

    // Processor address: use strkey when gated, 32 zero bytes when permissionless
    // (matches EVM address(0) pattern for permissionless mode)
    if processor_gated {
        let strkey_bytes = processor.to_string().to_bytes();
        buf.append(&strkey_bytes);
    } else {
        buf.append(&Bytes::from_slice(env, &[0u8; 32]));
    }

    // Processor data with length prefix (4 bytes LE)
    let pd_len = processor_data.len();
    buf.append(&Bytes::from_slice(env, &pd_len.to_le_bytes()));
    buf.append(processor_data);

    // Number of notes (4 bytes LE)
    let num = note_data.len();
    buf.append(&Bytes::from_slice(env, &num.to_le_bytes()));

    // Each note: hint (32 bytes) + data with length prefix
    for i in 0..note_data.len() {
        let nd = note_data.get(i).ok_or(Error::ArithmeticOverflow)?;
        // Hint (32 bytes, raw)
        let hint_bytes: BytesN<32> = nd.hint.clone();
        buf.append(&Bytes::from_slice(env, &hint_bytes.to_array()));
        // Data with length prefix (4 bytes LE)
        let data_len = nd.data.len();
        buf.append(&Bytes::from_slice(env, &data_len.to_le_bytes()));
        buf.append(&nd.data);
    }

    // keccak256 mod field
    let hash = env.crypto().keccak256(&buf);
    let hash_u256 = U256::from_be_bytes(env, &Bytes::from_slice(env, &hash.to_array()));
    let field = U256::from_be_bytes(env, &Bytes::from_slice(env, &SNARK_SCALAR_FIELD_BYTES));
    Ok(hash_u256.rem_euclid(&field))
}

/// Privacy Pool V2 contract.
#[contract]
pub struct PoolContract;

#[contractimpl]
impl PoolContract {
    /// Initialize the pool contract.
    pub fn initialize(
        env: Env,
        admin: Address,
        keystore: Address,
        asp_registry: Address,
        root_history_size: u32,
        max_state_tree_size: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if root_history_size == 0 {
            return Err(Error::InvalidRootHistorySize);
        }
        // Circuit-aligned state-tree capacity (= 2^stateMaxDepth). Must be
        // non-zero; an over-capacity insert would yield unverifiable proofs.
        if max_state_tree_size == 0 {
            return Err(Error::InvalidMaxTreeSize);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Keystore, &keystore);
        env.storage()
            .instance()
            .set(&DataKey::AspRegistry, &asp_registry);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::RootHistorySize, &root_history_size);
        env.storage()
            .instance()
            .set(&DataKey::MaxStateTreeSize, &max_state_tree_size);
        env.storage()
            .instance()
            .set(&DataKey::CurrentRootIndex, &0u32);
        env.storage().instance().set(&DataKey::TreeSize, &0u32);
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(())
    }

    /// Set role addresses (admin only). Mirrors EVM AccessRouter role grants:
    /// pauser → PAUSER_ROLE, unpauser → UNPAUSER_ROLE,
    /// asset_manager → ENTRYPOINT_MANAGER_ROLE, upgrader → UPGRADER_ROLE.
    pub fn set_roles(
        env: Env,
        admin: Address,
        pauser: Address,
        unpauser: Address,
        asset_manager: Address,
        upgrader: Address,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if admin != stored_admin {
            return Err(Error::NotAuthorized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Pauser, &pauser);
        env.storage().instance().set(&DataKey::Unpauser, &unpauser);
        env.storage()
            .instance()
            .set(&DataKey::AssetManager, &asset_manager);
        env.storage().instance().set(&DataKey::Upgrader, &upgrader);

        RolesUpdated {
            pauser,
            unpauser,
            asset_manager,
            upgrader,
        }
        .publish(&env);

        Ok(())
    }

    /// Upgrade the contract WASM (upgrader role only).
    ///
    /// Mirrors EVM `_authorizeUpgrade` gated by `UPGRADER_ROLE`.
    /// Admin does NOT have upgrade authority by default — gated only by
    /// the dedicated Upgrader role (least-privilege). To "freeze" the
    /// upgrade path, admin rotates Upgrader via `set_roles(...)` to a
    /// burned/dead address — mirrors EVM's `renounceRole` cooperative
    /// freeze semantics.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        if new_wasm_hash == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(Error::InvalidWasmHash);
        }
        let upgrader: Address = env
            .storage()
            .instance()
            .get(&DataKey::Upgrader)
            .ok_or(Error::NotInitialized)?;
        if caller != upgrader {
            return Err(Error::NotAuthorized);
        }
        caller.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Update the configured max state-tree size (upgrader role only).
    ///
    /// Mirrors EVM `setMaxStateTreeSize`: the new cap must exceed the current
    /// tree size. Governance must keep it equal to `2^stateMaxDepth` so inserts
    /// stay within circuit capacity (an over-capacity leaf yields unverifiable
    /// proofs).
    /// Repoint the keystore dependency (EVM `PoolVault.setKeystore`).
    ///
    /// UPGRADER-gated. Until 2026-08-24 this port had NO such setter — the
    /// address was written once at `initialize` and could only be changed by a
    /// full WASM `upgrade()`. `docs/DEVIATIONS.md` INTL-22 asserted the setter
    /// existed and was role-gated; it did not exist at all.
    ///
    /// **Operational warning (INTL-22, unchanged).** There is no on-chain
    /// coherence assert and none is feasible: keystore root history lives in the
    /// keystore, not here, so continuity cannot be checked from this side. The
    /// safe path is an in-place keystore upgrade that PRESERVES known-root
    /// history. Repointing to a fresh keystore has no known roots, which freezes
    /// `transact` and `ragequit` for every existing note. That remains a
    /// governance/runbook responsibility, which is exactly why this is gated on
    /// the timelocked upgrader rather than the admin.
    pub fn set_keystore(env: Env, caller: Address, new_keystore: Address) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let upgrader: Address = env
            .storage()
            .instance()
            .get(&DataKey::Upgrader)
            .ok_or(Error::NotInitialized)?;
        if caller != upgrader {
            return Err(Error::NotAuthorized);
        }
        caller.require_auth();

        let previous: Address = env
            .storage()
            .instance()
            .get(&DataKey::Keystore)
            .ok_or(Error::NotInitialized)?;
        env.storage().instance().set(&DataKey::Keystore, &new_keystore);
        KeystoreSet { previous, new_keystore }.publish(&env);
        Ok(())
    }

    /// Repoint the ASP registry dependency (EVM `PoolVault.setAspRegistry`).
    ///
    /// UPGRADER-gated. Same history and the same INTL-22 operational caveat as
    /// `set_keystore`: no on-chain coherence assert is feasible, so dependency
    /// coherence is a deployment-procedure responsibility.
    pub fn set_asp_registry(
        env: Env,
        caller: Address,
        new_asp_registry: Address,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let upgrader: Address = env
            .storage()
            .instance()
            .get(&DataKey::Upgrader)
            .ok_or(Error::NotInitialized)?;
        if caller != upgrader {
            return Err(Error::NotAuthorized);
        }
        caller.require_auth();

        let previous: Address = env
            .storage()
            .instance()
            .get(&DataKey::AspRegistry)
            .ok_or(Error::NotInitialized)?;
        env.storage()
            .instance()
            .set(&DataKey::AspRegistry, &new_asp_registry);
        AspRegistrySet { previous, new_asp_registry }.publish(&env);
        Ok(())
    }

    /// Get the configured ASP registry contract address (EVM `aspRegistry()`).
    pub fn asp_registry(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::AspRegistry)
            .ok_or(Error::NotInitialized)
    }

    pub fn set_max_state_tree_size(env: Env, caller: Address, new_max: u32) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let upgrader: Address = env
            .storage()
            .instance()
            .get(&DataKey::Upgrader)
            .ok_or(Error::NotInitialized)?;
        if caller != upgrader {
            return Err(Error::NotAuthorized);
        }
        caller.require_auth();

        let tree_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TreeSize)
            .ok_or(Error::NotInitialized)?;
        if new_max <= tree_size {
            return Err(Error::InvalidMaxTreeSize);
        }
        let previous: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxStateTreeSize)
            .ok_or(Error::NotInitialized)?;
        env.storage()
            .instance()
            .set(&DataKey::MaxStateTreeSize, &new_max);

        MaxStateTreeSizeUpdated { previous, new_max }.publish(&env);
        Ok(())
    }

    /// Configure an asset (admin or asset manager).
    pub fn set_asset_config(
        env: Env,
        caller: Address,
        asset: Address,
        enabled: bool,
        min_deposit_amount: u128,
        vetting_fee_bps: u32,
        max_relay_fee: u128,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        // Admin or asset manager can configure assets
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        let is_admin = caller == admin;
        let is_asset_manager = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::AssetManager)
            .map(|am| am == caller)
            .unwrap_or(false);

        if !is_admin && !is_asset_manager {
            return Err(Error::NotAuthorized);
        }
        caller.require_auth();

        // Validate fee BPS (must be < 10000, i.e. < 100%)
        if u128::from(vetting_fee_bps) >= soroban_v2_utils::MAX_FEE_BPS {
            return Err(Error::InvalidFeeBps);
        }

        // An enabled asset must have a strictly-positive minimum deposit (M-02).
        // Mirrors Entrypoint.setAssetConfiguration: require(!enabled || minAmount != 0).
        // A disabled asset may keep min == 0.
        if enabled && min_deposit_amount == 0 {
            return Err(Error::InvalidMinAmount);
        }

        // Sanity bound on max_relay_fee. 10^30 is ≈ 10^12 × 10^18 —
        // well past any plausible per-asset fee cap (trillion-unit
        // stable at 18 decimals). Rejects u128::MAX and similarly
        // absurd values that would effectively disable the relay cap
        // without anyone noticing. Matches AUDIT-MATH-R1-01.
        const MAX_RELAY_FEE_CEILING: u128 = 1_000_000_000_000_000_000_000_000_000_000u128;
        if max_relay_fee > MAX_RELAY_FEE_CEILING {
            return Err(Error::InvalidMaxRelayFee);
        }

        // Enforce tokenId uniqueness across assets. Since encode_token_id
        // truncates to 160 bits (cffcaca9 INS-1), two distinct asset addresses
        // could in principle collide on the same token id (~2^80 birthday
        // bound). Registration is privileged, but we additionally refuse to
        // register a *different* asset under an already-claimed token id so a
        // collision can never be introduced even by a careless/compromised
        // registration. Re-registering the same asset is allowed.
        let token_id = encode_token_id(&env, &asset);
        let tid_key = DataKey::TokenIdAsset(token_id.clone());
        if let Some(existing) = env
            .storage()
            .persistent()
            .get::<_, Address>(&tid_key)
        {
            if existing != asset {
                return Err(Error::TokenIdCollision);
            }
        }
        env.storage().persistent().set(&tid_key, &asset);
        env.storage()
            .persistent()
            .extend_ttl(&tid_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Preserve accumulated fees if config already exists
        let accumulated_fees = env
            .storage()
            .persistent()
            .get::<_, AssetConfig>(&DataKey::AssetConfig(asset.clone()))
            .map(|c| c.accumulated_fees)
            .unwrap_or(0);

        let config = AssetConfig {
            enabled,
            min_deposit_amount,
            vetting_fee_bps,
            accumulated_fees,
            max_relay_fee,
        };
        let ac_key = DataKey::AssetConfig(asset.clone());
        env.storage().persistent().set(&ac_key, &config);
        env.storage()
            .persistent()
            .extend_ttl(&ac_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        AssetConfigUpdated {
            asset,
            enabled,
            min_deposit: min_deposit_amount,
            vetting_fee_bps,
            max_relay_fee,
        }
        .publish(&env);

        Ok(())
    }

    /// Store a verification key (admin only).
    pub fn set_vk(
        env: Env,
        admin: Address,
        proof_type: u32,
        n: u32,
        m: u32,
        vk: VerificationKeyBytes,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if admin != stored_admin {
            return Err(Error::NotAuthorized);
        }
        admin.require_auth();
        let vk_key = DataKey::Vk(proof_type, n, m);
        env.storage().persistent().set(&vk_key, &vk);
        env.storage()
            .persistent()
            .extend_ttl(&vk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        VkUpdated {
            proof_type,
            n,
            m,
        }
        .publish(&env);

        Ok(())
    }

    /// Pause the pool (pauser only).
    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let pauser: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pauser)
            .ok_or(Error::NotInitialized)?;
        if caller != pauser {
            return Err(Error::NotAuthorized);
        }
        caller.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        PoolPausedEvent {}.publish(&env);
        Ok(())
    }

    /// Unpause the pool (unpauser only).
    pub fn unpause(env: Env, caller: Address) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let unpauser: Address = env
            .storage()
            .instance()
            .get(&DataKey::Unpauser)
            .ok_or(Error::NotInitialized)?;
        if caller != unpauser {
            return Err(Error::NotAuthorized);
        }
        caller.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        PoolUnpausedEvent {}.publish(&env);
        Ok(())
    }

    /// Deposit tokens into the pool with a Groth16 proof.
    ///
    /// Deposit proof signals: [outputCommitment, tokenId, value, context]
    /// where context = keccak256(note_data) % SNARK_SCALAR_FIELD
    /// Deposit and register the ASP label in ONE call (CG-3).
    ///
    /// Mirrors `Entrypoint.deposit`'s third argument. EVM registers the label
    /// only when the ciphertext is non-empty, so registration is optional there
    /// too — an empty `ciphertext` here behaves exactly like plain `deposit`,
    /// and this is a convenience, not a new obligation.
    ///
    /// Two reasons it exists rather than leaving callers to make two calls:
    ///
    /// 1. Atomicity. Soroban permits only one Soroban operation per
    ///    transaction, so a client CANNOT bundle `deposit` and `register_label`
    ///    into a single atomic transaction the way it could on EVM. Two
    ///    transactions can half-succeed, leaving a funded commitment whose label
    ///    the ASP never sees.
    /// 2. One source of truth for the registry address. EVM reads it back from
    ///    PoolVault for exactly this reason. A caller making the second call
    ///    itself supplies the registry address from its own config, which can
    ///    drift from the pool's after a `set_asp_registry`, sending the label to
    ///    a registry nobody is reading.
    ///
    /// Added alongside `deposit` rather than as a parameter on it, because
    /// Soroban has no overloading and changing the signature would break every
    /// existing caller for a feature they may not want.
    pub fn deposit_with_label(
        env: Env,
        depositor: Address,
        asset: Address,
        value: u128,
        output_commitment: U256,
        proof: Groth16Proof,
        note_data: NoteData,
        ciphertext: soroban_sdk::Bytes,
    ) -> Result<(), Error> {
        Self::deposit(
            env.clone(),
            depositor,
            asset,
            value,
            output_commitment,
            proof,
            note_data,
        )?;

        // Registered after the deposit for readability, not for safety: the
        // ordering is not what makes this correct. A failing deposit rolls the
        // whole invocation back, emitted events included, so registering first
        // would be equally safe — verified by mutation, where swapping the two
        // left every test green. What DOES matter is that both legs live in one
        // invocation, so they cannot half-succeed.
        if ciphertext.len() != 0 {
            let asp_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::AspRegistry)
                .ok_or(Error::NotInitialized)?;
            AspRegistryClient::new(&env, &asp_addr).register_label(&ciphertext);
        }

        Ok(())
    }

    pub fn deposit(
        env: Env,
        depositor: Address,
        asset: Address,
        value: u128,
        output_commitment: U256,
        proof: Groth16Proof,
        note_data: NoteData,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        depositor.require_auth();

        // Check pool is not paused
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .ok_or(Error::NotInitialized)?;
        if paused {
            return Err(Error::PoolPaused);
        }

        // Check value is non-zero
        if value == 0 {
            return Err(Error::InvalidValue);
        }

        // Load and validate asset config
        let ac_key = DataKey::AssetConfig(asset.clone());
        let mut asset_config: AssetConfig = env
            .storage()
            .persistent()
            .get(&ac_key)
            .ok_or(Error::AssetNotEnabled)?;
        env.storage()
            .persistent()
            .extend_ttl(&ac_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        if !asset_config.enabled {
            return Err(Error::AssetNotEnabled);
        }
        if value < asset_config.min_deposit_amount {
            return Err(Error::BelowMinDeposit);
        }

        // Compute token ID (asset address -> BN254 field element)
        let token_id = encode_token_id(&env, &asset);

        // Compute fee
        let fee = soroban_v2_utils::vetting_fee(value, asset_config.vetting_fee_bps)
            .ok_or(Error::ArithmeticOverflow)?;
        let total_amount = value
            .checked_add(fee)
            .ok_or(Error::ArithmeticOverflow)?;

        // Compute deposit context: keccak256(hint || data) % SNARK_SCALAR_FIELD
        let context = compute_deposit_context(&env, &note_data);

        // Build public signals: [outputCommitment, tokenId, value, context]
        // Circom: outputs first, then public inputs
        let value_u256 = U256::from_u128(&env, value);
        let mut signals = Vec::<U256>::new(&env);
        signals.push_back(output_commitment.clone());
        signals.push_back(token_id);
        signals.push_back(value_u256);
        signals.push_back(context);

        // Load deposit VK and verify proof
        let vk_key = DataKey::Vk(0, 0, 0);
        let vk: VerificationKeyBytes = env
            .storage()
            .persistent()
            .get(&vk_key)
            .ok_or(Error::VkNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&vk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        if !verify_groth16(&env, &vk, &proof, &signals) {
            return Err(Error::InvalidProof);
        }

        // Check commitment not already used
        if env
            .storage()
            .persistent()
            .has(&DataKey::Commitment(output_commitment.clone()))
        {
            return Err(Error::DuplicateCommitment);
        }

        // Mark commitment as used
        let cm_key = DataKey::Commitment(output_commitment.clone());
        env.storage().persistent().set(&cm_key, &env.ledger().timestamp());
        env.storage()
            .persistent()
            .extend_ttl(&cm_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Compute domain-tagged state-tree leaf: Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)
        let timestamp = env.ledger().timestamp();
        let timestamp_u256 = U256::from_u128(&env, u128::from(timestamp));
        let leaf = poseidon_hash_three(&env, &commitment_leaf_tag(&env), &output_commitment, &timestamp_u256);

        // Insert leaf into LeanIMT
        let tree_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TreeSize)
            .ok_or(Error::NotInitialized)?;

        let get_side_node = |level: u32| -> Option<U256> {
            let sn_key = DataKey::SideNode(level);
            let val = env.storage().persistent().get(&sn_key);
            if val.is_some() {
                env.storage()
                    .persistent()
                    .extend_ttl(&sn_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
            }
            val
        };
        let set_side_node = |level: u32, val: &U256| {
            let sn_key = DataKey::SideNode(level);
            env.storage().persistent().set(&sn_key, val);
            env.storage()
                .persistent()
                .extend_ttl(&sn_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        };

        // Enforce circuit-aligned capacity before inserting (M-1): size + 1 <= max.
        // TreeFull (u32 overflow) stays as an unreachable backstop behind StateTreeFull.
        let new_tree_size = tree_size.checked_add(1).ok_or(Error::TreeFull)?;
        let max_state_tree_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxStateTreeSize)
            .ok_or(Error::NotInitialized)?;
        if new_tree_size > max_state_tree_size {
            return Err(Error::StateTreeFull);
        }

        let new_root = lean_imt_insert(&env, &leaf, &get_side_node, &set_side_node, tree_size);
        env.storage()
            .instance()
            .set(&DataKey::TreeSize, &new_tree_size);

        // Update root buffer
        let current_root_index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CurrentRootIndex)
            .ok_or(Error::NotInitialized)?;
        let history_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RootHistorySize)
            .ok_or(Error::NotInitialized)?;

        root_buffer::record_root(
            &new_root,
            current_root_index,
            history_size,
            &|idx, root| {
                let r_key = DataKey::Root(idx);
                env.storage().persistent().set(&r_key, root);
                env.storage()
                    .persistent()
                    .extend_ttl(&r_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
            },
            &|idx| {
                env.storage()
                    .instance()
                    .set(&DataKey::CurrentRootIndex, &idx);
            },
        );

        // Accumulate fee
        asset_config.accumulated_fees = asset_config
            .accumulated_fees
            .checked_add(fee)
            .ok_or(Error::ArithmeticOverflow)?;
        let ac_key2 = DataKey::AssetConfig(asset.clone());
        env.storage().persistent().set(&ac_key2, &asset_config);
        env.storage()
            .persistent()
            .extend_ttl(&ac_key2, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Transfer tokens from depositor to pool
        let pool_address = env.current_contract_address();
        let token_client = token::TokenClient::new(&env, &asset);
        let total_i128 = i128::try_from(total_amount).map_err(|_| Error::ArithmeticOverflow)?;
        token_client.transfer(&depositor, &pool_address, &total_i128);

        // Emit events
        let mut leaf_vec = Vec::<U256>::new(&env);
        leaf_vec.push_back(leaf.clone());
        LeavesInserted {
            leaves: leaf_vec,
            root: new_root,
            start_index: tree_size,
        }
        .publish(&env);

        NoteEvent {
            hint: note_data.hint,
            data: note_data.data,
        }
        .publish(&env);

        Deposited {
            commitment: output_commitment,
            asset,
            value,
            depositor,
        }
        .publish(&env);

        Ok(())
    }

    /// Withdraw accumulated fees (asset manager only).
    pub fn withdraw_fees(
        env: Env,
        caller: Address,
        asset: Address,
        amount: u128,
        recipient: Address,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let asset_manager: Address = env
            .storage()
            .instance()
            .get(&DataKey::AssetManager)
            .ok_or(Error::NotInitialized)?;
        if caller != asset_manager {
            return Err(Error::NotAuthorized);
        }
        caller.require_auth();

        let ac_key = DataKey::AssetConfig(asset.clone());
        let mut config: AssetConfig = env
            .storage()
            .persistent()
            .get(&ac_key)
            .ok_or(Error::AssetNotEnabled)?;

        if amount > config.accumulated_fees {
            return Err(Error::InsufficientFees);
        }

        config.accumulated_fees = config
            .accumulated_fees
            .checked_sub(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        env.storage().persistent().set(&ac_key, &config);
        env.storage()
            .persistent()
            .extend_ttl(&ac_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        let pool_address = env.current_contract_address();
        let token_client = token::TokenClient::new(&env, &asset);
        let amount_i128 = i128::try_from(amount).map_err(|_| Error::ArithmeticOverflow)?;
        token_client.transfer(&pool_address, &recipient, &amount_i128);

        FeesWithdrawn {
            asset,
            amount,
            recipient,
        }
        .publish(&env);

        Ok(())
    }

    /// Check if a root is in the root history buffer.
    pub fn is_known_root(env: Env, root: U256) -> Result<bool, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        // Zero root is never valid (matches EVM isKnownRoot behavior).
        if root == U256::from_u32(&env, 0) {
            return Ok(false);
        }
        let history_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RootHistorySize)
            .ok_or(Error::NotInitialized)?;

        Ok(root_buffer::is_known_root(&env, &root, history_size, &|idx| {
            let rk = DataKey::Root(idx);
            let val = env.storage().persistent().get::<_, U256>(&rk);
            if val.is_some() {
                env.storage()
                    .persistent()
                    .extend_ttl(&rk, LIFETIME_THRESHOLD, BUMP_AMOUNT);
            }
            val
        }))
    }

    /// Get the latest state root.
    pub fn latest_root(env: Env) -> Result<U256, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let current_index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CurrentRootIndex)
            .ok_or(Error::NotInitialized)?;
        let history_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RootHistorySize)
            .ok_or(Error::NotInitialized)?;

        root_buffer::latest_root(current_index, history_size, &|idx| {
            let rk = DataKey::Root(idx);
            let val = env.storage().persistent().get::<_, U256>(&rk);
            if val.is_some() {
                env.storage()
                    .persistent()
                    .extend_ttl(&rk, LIFETIME_THRESHOLD, BUMP_AMOUNT);
            }
            val
        })
        .ok_or(Error::NotInitialized)
    }

    /// Whether a nullifier has been spent, read directly from pool state.
    ///
    /// Mirrors the EVM public mapping `PoolVault.spentNullifiers(hash)`.
    ///
    /// Exists for the SDK's guarded `REJECTED -> ACTIVE` note recovery (upstream
    /// audit finding **#501**). A note demoted by a transient or incorrect ASP
    /// rejection is otherwise stranded forever, but re-activating it needs a
    /// double-count guard: a note that has actually been spent must go to SPENT,
    /// never back to ACTIVE.
    ///
    /// It must be THIS read, not an event-derived nullifier set. Upstream's
    /// first version of that guard built the set from an ASP snapshot plus a
    /// chain tail; a snapshot lagging the chain can omit a recent spend, and on
    /// snapshot failure the scan resumes from the sync cursor, so older spends
    /// are invisible. Only authoritative pool state answers the question.
    pub fn is_nullifier_spent(env: Env, nullifier_hash: U256) -> bool {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier_hash))
    }

    /// Ledger timestamp at which a nullifier was spent, or `None` if unspent.
    ///
    /// Mirrors EVM `PoolVault.spentNullifiers(hash)`, which stores
    /// `block.timestamp` rather than a flag. This port previously stored a bare
    /// `true`, discarding the timestamp (parity gap CG-4).
    ///
    /// The timestamp is load-bearing, not decorative: upstream records it so a
    /// user can still collect yield accrued on a commitment *after* spending it,
    /// which matters now that lending is in scope (`docs/LENDING_DESIGN.md`).
    /// It is also what any hold-time proof would need.
    pub fn nullifier_spent_at(env: Env, nullifier_hash: U256) -> Option<u64> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .persistent()
            .get(&DataKey::Nullifier(nullifier_hash))
    }

    /// Ledger timestamp at which a commitment entered the state tree, or `None`.
    ///
    /// Mirrors EVM `PoolVault.commitments(hash)`. Same reasoning as
    /// `nullifier_spent_at`.
    pub fn commitment_created_at(env: Env, commitment: U256) -> Option<u64> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .persistent()
            .get(&DataKey::Commitment(commitment))
    }

    /// Whether the pool is paused (EVM `PoolVault.paused()`).
    ///
    /// Only ragequit remains available while paused — it is the emergency exit.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Get the configured state-root history size.
    ///
    /// Exposed so the relay can enforce, at deploy time, that its MAX_BATCH is
    /// strictly below this (EVM audit finding C-2). Every item in a batch
    /// validates against the same pre-batch state root, so a batch larger than
    /// the ring buffer would evict that root before the last item is checked.
    pub fn root_history_size(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::RootHistorySize)
            .ok_or(Error::NotInitialized)
    }

    /// Get the current index into the state-root ring buffer (CG-4).
    ///
    /// Mirrors EVM `PoolVault.currentRootIndex()`. With `roots(i)` below this
    /// lets an indexer walk the retained history directly instead of replaying
    /// every `Deposit`/`Transact` event to reconstruct which roots are still
    /// accepted — the set a proof must target.
    pub fn current_root_index(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::CurrentRootIndex)
            .ok_or(Error::NotInitialized)
    }

    /// Read one slot of the state-root ring buffer (CG-4).
    ///
    /// Mirrors EVM `PoolVault.roots(i)`. Returns `None` for a slot that has not
    /// been written yet, which is distinct from a slot holding root zero — a
    /// caller walking a partially-filled buffer needs to tell those apart, and
    /// EVM's mapping returns 0 for both. Out-of-range indices return `None`
    /// rather than erroring, since "no root there" is the honest answer.
    pub fn root_at(env: Env, index: u32) -> Result<Option<U256>, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let history_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RootHistorySize)
            .ok_or(Error::NotInitialized)?;
        if index >= history_size {
            return Ok(None);
        }
        let rk = DataKey::Root(index);
        let val = env.storage().persistent().get::<_, U256>(&rk);
        if val.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&rk, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        }
        Ok(val)
    }

    /// Read a stored verification key (CG-4).
    ///
    /// Mirrors EVM's public verifier lookup. `proof_type` is 0 = deposit,
    /// 1 = transact, 2 = ragequit; `n`/`m` are the transact input/output counts
    /// and are 0 for the other two. Returns `None` when no key is registered for
    /// that configuration, so a client can discover which of the 25 NxM configs
    /// this deployment actually supports rather than finding out from a failed
    /// proof submission.
    pub fn get_vk(
        env: Env,
        proof_type: u32,
        n: u32,
        m: u32,
    ) -> Option<VerificationKeyBytes> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let vk_key = DataKey::Vk(proof_type, n, m);
        let val = env
            .storage()
            .persistent()
            .get::<_, VerificationKeyBytes>(&vk_key);
        if val.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&vk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        }
        val
    }

    /// Get the configured keystore contract address.
    ///
    /// Mirrors EVM `PoolVault.keystore()`. Exposed so the relay contract can
    /// resolve the keystore at call time rather than caching its own copy —
    /// the relay is immutable (INTL-01), so a cached address could not be
    /// corrected if the pool's keystore is ever repointed. Reading through the
    /// pool keeps one source of truth (INTL-22).
    pub fn keystore(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::Keystore)
            .ok_or(Error::NotInitialized)
    }

    /// Get the current tree size.
    pub fn tree_size(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::TreeSize)
            .ok_or(Error::NotInitialized)
    }

    /// Get the configured max state-tree size (= 2^stateMaxDepth).
    pub fn max_state_tree_size(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::MaxStateTreeSize)
            .ok_or(Error::NotInitialized)
    }

    /// Get asset config.
    pub fn get_asset_config(env: Env, asset: Address) -> Result<AssetConfig, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let ac_key = DataKey::AssetConfig(asset);
        let config: AssetConfig = env
            .storage()
            .persistent()
            .get(&ac_key)
            .ok_or(Error::AssetNotEnabled)?;
        env.storage()
            .persistent()
            .extend_ttl(&ac_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(config)
    }

    /// Process a transact (NxM spend + optional withdrawal).
    ///
    /// Spends N input nullifiers, creates M output commitments, and optionally
    /// withdraws tokens. Requires valid Groth16 proof, known roots, and
    /// matching context hash.
    ///
    /// Transact proof signals (circom output-first ordering):
    /// `[nullifierHashes[0..N], outputCommitments[0..M], stateRoot, keystoreRoot, aspRoot, amountOut, tokenIdOut, context]`
    #[allow(clippy::too_many_arguments)]
    pub fn transact(
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
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        if processor_gated {
            processor.require_auth();
        } else if amount_out > 0 {
            // Permissionless mode hashes 32 zero bytes in place of the processor, so the proof does
            // not bind it — and the withdrawal is paid TO the processor. Anyone who saw the
            // transaction (pending or failed) could resubmit it naming themselves. EVM removed the
            // permissionless path entirely (da346809 L-1); here it stays for internal transfers,
            // where nothing is paid out and the proof binds everything that matters.
            return Err(Error::UngatedWithdrawal);
        }

        // Check pool is not paused
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .ok_or(Error::NotInitialized)?;
        if paused {
            return Err(Error::PoolPaused);
        }

        // Validate N, M in [1, 5]
        if n < 1 || n > 5 || m < 1 || m > 5 {
            return Err(Error::InvalidNxM);
        }
        if nullifier_hashes.len() != n || output_commitments.len() != m {
            return Err(Error::InvalidNxM);
        }
        // At most one Note event per output, but outputs may carry none: a blind or out-of-band
        // recipient's note is delivered off-chain (mirrors EVM PoolVault, which emits one Note per
        // entry independent of the commitment count). The proof's context binds whatever is sent.
        if note_data.len() > m {
            return Err(Error::InvalidNxM);
        }

        // Verify state root is in local root buffer
        let history_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RootHistorySize)
            .ok_or(Error::NotInitialized)?;
        let state_root_known = root_buffer::is_known_root(&env, &state_root, history_size, &|idx| {
            let rk = DataKey::Root(idx);
            let val = env.storage().persistent().get::<_, U256>(&rk);
            if val.is_some() {
                env.storage()
                    .persistent()
                    .extend_ttl(&rk, LIFETIME_THRESHOLD, BUMP_AMOUNT);
            }
            val
        });
        if !state_root_known {
            return Err(Error::UnknownRoot);
        }

        // Cross-contract: verify keystore root is known
        let keystore_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Keystore)
            .ok_or(Error::NotInitialized)?;
        let keystore_client = KeystoreClient::new(&env, &keystore_addr);
        let ks_known: bool = keystore_client.is_known_root(&keystore_root);
        if !ks_known {
            return Err(Error::UnknownKeystoreRoot);
        }

        // Cross-contract: verify ASP root matches latest
        let asp_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::AspRegistry)
            .ok_or(Error::NotInitialized)?;
        let asp_client = AspRegistryClient::new(&env, &asp_addr);
        let latest_asp: U256 = asp_client.latest_asp_root();
        if latest_asp != asp_root {
            return Err(Error::InvalidAspRoot);
        }

        // Compute context hash from processor + processor data + note data (hints + payloads)
        let context = compute_transact_context(&env, &processor, &processor_data, &note_data, processor_gated)?;

        // Build signals: [nulls[0..N], commits[0..M], stateRoot, keystoreRoot, aspRoot, amountOut, tokenIdOut, context]
        let amount_out_u256 = U256::from_u128(&env, amount_out);
        let mut signals = Vec::<U256>::new(&env);
        for i in 0..n {
            signals.push_back(nullifier_hashes.get(i).ok_or(Error::ArithmeticOverflow)?);
        }
        for i in 0..m {
            signals.push_back(output_commitments.get(i).ok_or(Error::ArithmeticOverflow)?);
        }
        signals.push_back(state_root.clone());
        signals.push_back(keystore_root);
        signals.push_back(asp_root);
        signals.push_back(amount_out_u256);
        signals.push_back(token_id_out.clone());
        signals.push_back(context);

        // Load transact VK (proof_type=1) and verify proof
        let vk_key = DataKey::Vk(1, n, m);
        let vk: VerificationKeyBytes = env
            .storage()
            .persistent()
            .get(&vk_key)
            .ok_or(Error::VkNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&vk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        if !verify_groth16(&env, &vk, &proof, &signals) {
            return Err(Error::InvalidProof);
        }

        // Validate token ID before any state mutations
        let zero = U256::from_u32(&env, 0);
        if amount_out > 0 {
            let expected_token_id = encode_token_id(&env, &asset);
            if token_id_out != expected_token_id {
                return Err(Error::InvalidTokenId);
            }
        } else if token_id_out != zero {
            return Err(Error::InvalidTokenId);
        }

        // Check no duplicate nullifiers within transaction
        for i in 0..n {
            let ni = nullifier_hashes.get(i).ok_or(Error::ArithmeticOverflow)?;
            let mut j = i.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
            while j < n {
                let nj = nullifier_hashes.get(j).ok_or(Error::ArithmeticOverflow)?;
                if ni == nj {
                    return Err(Error::DuplicateNullifier);
                }
                j = j.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
            }
        }

        // Check no duplicate commitments within transaction
        for i in 0..m {
            let ci = output_commitments.get(i).ok_or(Error::ArithmeticOverflow)?;
            let mut j = i.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
            while j < m {
                let cj = output_commitments.get(j).ok_or(Error::ArithmeticOverflow)?;
                if ci == cj {
                    return Err(Error::DuplicateCommitment);
                }
                j = j.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
            }
        }

        // Process nullifiers: check not already spent, mark spent
        for i in 0..n {
            let nh = nullifier_hashes.get(i).ok_or(Error::ArithmeticOverflow)?;
            let nh_key = DataKey::Nullifier(nh.clone());
            if env.storage().persistent().has(&nh_key) {
                return Err(Error::NullifierAlreadySpent);
            }
            env.storage().persistent().set(&nh_key, &env.ledger().timestamp());
            env.storage()
                .persistent()
                .extend_ttl(&nh_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        }

        // Process commitments: check not already used, mark used
        for i in 0..m {
            let cm = output_commitments.get(i).ok_or(Error::ArithmeticOverflow)?;
            let cm_key = DataKey::Commitment(cm.clone());
            if env.storage().persistent().has(&cm_key) {
                return Err(Error::DuplicateCommitment);
            }
            env.storage().persistent().set(&cm_key, &env.ledger().timestamp());
            env.storage()
                .persistent()
                .extend_ttl(&cm_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        }

        // Build domain-tagged state-tree leaves: commitments first [0..M], then nullifiers [M..M+N].
        // Leaf = Poseidon(TAG, value, timestamp) with distinct commitment/nullifier tags (M-0).
        //
        // Perf: transact does ~M+N 3-input (t=4) leaf hashes plus a per-insert
        // tree-walk of 2-input (t=3) internal-node hashes. Pre-build BOTH MDS +
        // round-constants contexts once and share the references across every
        // call (the `Vec<Vec<U256>>` materialization is ~300K CPU each). At 5x5
        // with a non-trivial tree this saves tens of millions of CPU.
        let poseidon_ctx = PoseidonT3Ctx::new(&env); // 2-input: LeanIMT internal nodes
        let leaf_ctx = PoseidonT4Ctx::new(&env); // 3-input: domain-tagged leaves
        let cm_tag = commitment_leaf_tag(&env);
        let nh_tag = nullifier_leaf_tag(&env);

        let timestamp = env.ledger().timestamp();
        let ts_u256 = U256::from_u128(&env, u128::from(timestamp));

        let total_leaves = m.checked_add(n).ok_or(Error::ArithmeticOverflow)?;
        let mut leaves =
            alloc::vec::Vec::with_capacity(usize::try_from(total_leaves).map_err(|_| Error::ArithmeticOverflow)?);

        for i in 0..m {
            let cm = output_commitments.get(i).ok_or(Error::ArithmeticOverflow)?;
            leaves.push(poseidon_hash_three_ctx(&env, &leaf_ctx, &cm_tag, &cm, &ts_u256));
        }
        for i in 0..n {
            let nh = nullifier_hashes.get(i).ok_or(Error::ArithmeticOverflow)?;
            leaves.push(poseidon_hash_three_ctx(&env, &leaf_ctx, &nh_tag, &nh, &ts_u256));
        }

        // Batch insert into LeanIMT
        let tree_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TreeSize)
            .ok_or(Error::NotInitialized)?;

        let get_side_node = |level: u32| -> Option<U256> {
            let sn_key = DataKey::SideNode(level);
            let val = env.storage().persistent().get(&sn_key);
            if val.is_some() {
                env.storage()
                    .persistent()
                    .extend_ttl(&sn_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
            }
            val
        };
        let set_side_node = |level: u32, val: &U256| {
            let sn_key = DataKey::SideNode(level);
            env.storage().persistent().set(&sn_key, val);
            env.storage()
                .persistent()
                .extend_ttl(&sn_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        };

        // Enforce circuit-aligned capacity before inserting (M-1): size + (M+N) <= max.
        let new_size = tree_size
            .checked_add(total_leaves)
            .ok_or(Error::TreeFull)?;
        let max_state_tree_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxStateTreeSize)
            .ok_or(Error::NotInitialized)?;
        if new_size > max_state_tree_size {
            return Err(Error::StateTreeFull);
        }

        let new_root =
            lean_imt_insert_many_ctx(&env, &poseidon_ctx, &leaves, &get_side_node, &set_side_node, tree_size);

        env.storage()
            .instance()
            .set(&DataKey::TreeSize, &new_size);

        // Update root buffer
        let current_root_index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CurrentRootIndex)
            .ok_or(Error::NotInitialized)?;

        root_buffer::record_root(
            &new_root,
            current_root_index,
            history_size,
            &|idx, root| {
                let r_key = DataKey::Root(idx);
                env.storage().persistent().set(&r_key, root);
                env.storage()
                    .persistent()
                    .extend_ttl(&r_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
            },
            &|idx| {
                env.storage()
                    .instance()
                    .set(&DataKey::CurrentRootIndex, &idx);
            },
        );

        // Handle withdrawal (token ID already validated above)
        if amount_out > 0 {
            // Transfer tokens from pool to processor (no asset-enabled check:
            // withdrawals must always succeed even if the asset is later disabled,
            // matching EVM behavior)
            let pool_address = env.current_contract_address();
            let token_client = token::TokenClient::new(&env, &asset);
            let amount_i128 =
                i128::try_from(amount_out).map_err(|_| Error::ArithmeticOverflow)?;
            token_client.transfer(&pool_address, &processor, &amount_i128);
        }

        // Emit LeavesInserted event
        let mut leaf_vec = Vec::<U256>::new(&env);
        for l in &leaves {
            leaf_vec.push_back(l.clone());
        }
        LeavesInserted {
            leaves: leaf_vec,
            root: new_root,
            start_index: tree_size,
        }
        .publish(&env);

        // Emit Note events (one per note, matching EVM pattern)
        for i in 0..note_data.len() {
            if let Some(nd) = note_data.get(i) {
                NoteEvent {
                    hint: nd.hint,
                    data: nd.data,
                }
                .publish(&env);
            }
        }

        // Emit transact event (without payloads — payloads are in separate Note events)
        Transacted {
            commitments: output_commitments,
            nullifiers: nullifier_hashes,
            asset,
            amount_out,
            processor,
        }
        .publish(&env);

        Ok(())
    }

    /// Emergency exit (ragequit). Always available, even when pool is paused.
    ///
    /// Proves ownership and nullifies a commitment, withdrawing the full value.
    /// Exposes the label (breaks privacy) but guarantees fund recovery.
    ///
    /// Ragequit proof signals (circom output-first ordering):
    /// `[nullifierHash, commitment, keystoreRoot, ownerAddress, value, tokenId, label]`
    pub fn ragequit(
        env: Env,
        owner: Address,
        proof: Groth16Proof,
        nullifier_hash: U256,
        commitment: U256,
        keystore_root: U256,
        value: u128,
        token_id: U256,
        label: U256,
        asset: Address,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        owner.require_auth();

        // Reject zero-value ragequit (L-01). Mirrors PoolVault.ragequit:
        // require(_proof.value() != 0, PoolVault_ZeroValueRagequit()).
        if value == 0 {
            return Err(Error::ZeroValueRagequit);
        }

        // NO pause check — ragequit is the emergency exit, always available

        // Verify commitment exists in state
        let cm_key = DataKey::Commitment(commitment.clone());
        if !env.storage().persistent().has(&cm_key) {
            return Err(Error::CommitmentNotFound);
        }
        env.storage()
            .persistent()
            .extend_ttl(&cm_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Verify nullifier not already spent
        let nh_key = DataKey::Nullifier(nullifier_hash.clone());
        if env.storage().persistent().has(&nh_key) {
            return Err(Error::NullifierAlreadySpent);
        }

        // Cross-contract: verify keystore root is known
        let keystore_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Keystore)
            .ok_or(Error::NotInitialized)?;
        let keystore_client = KeystoreClient::new(&env, &keystore_addr);
        let ks_known: bool = keystore_client.is_known_root(&keystore_root);
        if !ks_known {
            return Err(Error::UnknownKeystoreRoot);
        }

        // Compute owner address field element
        let owner_address_field = address_to_field(&env, &owner);

        // Build signals: [nullifierHash, commitment, keystoreRoot, ownerAddress, value, tokenId, label]
        let value_u256 = U256::from_u128(&env, value);
        let mut signals = Vec::<U256>::new(&env);
        signals.push_back(nullifier_hash.clone());
        signals.push_back(commitment.clone());
        signals.push_back(keystore_root);
        signals.push_back(owner_address_field);
        signals.push_back(value_u256);
        signals.push_back(token_id.clone());
        signals.push_back(label.clone());

        // Load ragequit VK (proof_type=2) and verify proof
        let vk_key = DataKey::Vk(2, 0, 0);
        let vk: VerificationKeyBytes = env
            .storage()
            .persistent()
            .get(&vk_key)
            .ok_or(Error::VkNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&vk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        if !verify_groth16(&env, &vk, &proof, &signals) {
            return Err(Error::InvalidProof);
        }

        // Mark nullifier as spent
        env.storage().persistent().set(&nh_key, &env.ledger().timestamp());
        env.storage()
            .persistent()
            .extend_ttl(&nh_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Insert domain-tagged nullifier leaf into state tree: Poseidon(NULLIFIER_LEAF_TAG, nullifierHash, timestamp)
        let timestamp = env.ledger().timestamp();
        let ts_u256 = U256::from_u128(&env, u128::from(timestamp));
        let leaf = poseidon_hash_three(&env, &nullifier_leaf_tag(&env), &nullifier_hash, &ts_u256);

        let tree_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TreeSize)
            .ok_or(Error::NotInitialized)?;

        let get_side_node = |level: u32| -> Option<U256> {
            let sn_key = DataKey::SideNode(level);
            let val = env.storage().persistent().get(&sn_key);
            if val.is_some() {
                env.storage()
                    .persistent()
                    .extend_ttl(&sn_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
            }
            val
        };
        let set_side_node = |level: u32, val: &U256| {
            let sn_key = DataKey::SideNode(level);
            env.storage().persistent().set(&sn_key, val);
            env.storage()
                .persistent()
                .extend_ttl(&sn_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        };

        // Enforce circuit-aligned capacity before inserting (M-1): size + 1 <= max.
        let new_size = tree_size.checked_add(1).ok_or(Error::TreeFull)?;
        let max_state_tree_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxStateTreeSize)
            .ok_or(Error::NotInitialized)?;
        if new_size > max_state_tree_size {
            return Err(Error::StateTreeFull);
        }

        let new_root = lean_imt_insert(&env, &leaf, &get_side_node, &set_side_node, tree_size);

        env.storage()
            .instance()
            .set(&DataKey::TreeSize, &new_size);

        // Update root buffer
        let current_root_index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CurrentRootIndex)
            .ok_or(Error::NotInitialized)?;
        let history_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RootHistorySize)
            .ok_or(Error::NotInitialized)?;

        root_buffer::record_root(
            &new_root,
            current_root_index,
            history_size,
            &|idx, root| {
                let r_key = DataKey::Root(idx);
                env.storage().persistent().set(&r_key, root);
                env.storage()
                    .persistent()
                    .extend_ttl(&r_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
            },
            &|idx| {
                env.storage()
                    .instance()
                    .set(&DataKey::CurrentRootIndex, &idx);
            },
        );

        // Transfer tokens (no fee for ragequit)
        //
        // NOTE: this condition is ALWAYS TRUE here — `ragequit` returns
        // `ZeroValueRagequit` above (the L-01 guard) before reaching this point,
        // so `value` cannot be 0. It is kept as defence-in-depth against a
        // future edit that relaxes or moves that guard.
        //
        // Consequence for the mutation sweep: this site legitimately SURVIVES
        // the relaxation operator (`>` -> `>=`), because no reachable input
        // distinguishes the two. That is an *obviated check* (MOL-5), not a
        // missing test — do not try to close it by writing a test, and do not
        // score the SURVIVED as a coverage gap.
        if value > 0 {
            // Verify token_id matches asset
            let expected_token_id = encode_token_id(&env, &asset);
            if token_id != expected_token_id {
                return Err(Error::InvalidTokenId);
            }
            let pool_address = env.current_contract_address();
            let token_client = token::TokenClient::new(&env, &asset);
            let amount_i128 = i128::try_from(value).map_err(|_| Error::ArithmeticOverflow)?;
            token_client.transfer(&pool_address, &owner, &amount_i128);
        }

        // Emit LeavesInserted event
        let mut leaf_vec = Vec::<U256>::new(&env);
        leaf_vec.push_back(leaf.clone());
        LeavesInserted {
            leaves: leaf_vec,
            root: new_root,
            start_index: tree_size,
        }
        .publish(&env);

        // Emit ragequit event
        RagequitEvent {
            owner,
            asset,
            value,
            commitment,
            nullifier_hash,
            label,
        }
        .publish(&env);

        Ok(())
    }
}

#[cfg(test)]
mod test;
