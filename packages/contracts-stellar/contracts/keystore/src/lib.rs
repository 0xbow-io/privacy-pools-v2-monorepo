//! Keystore contract — user authorization registry.
//!
//! Manages nullifying keys, auth policies, and viewing keys in a LeanIMT.
//! Pool contract reads root history via cross-contract calls.

#![no_std]

extern crate alloc;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env, U256,
    Vec,
};
use contract_types::SNARK_SCALAR_FIELD_BYTES;
use soroban_v2_utils::{
    address_to_field,
    lean_imt::{lean_imt_insert, lean_imt_update, lean_imt_verify_proof},
    poseidon::poseidon_hash_three,
};

/// TTL management: extend persistent entries to prevent expiration.
const LIFETIME_THRESHOLD: u32 = 17_280; // ~1 day in ledgers
const BUMP_AMOUNT: u32 = 518_400; // ~30 days in ledgers

/// Storage keys for keystore contract.
#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    /// Contract admin address.
    Admin,
    /// Upgrader role address (mirrors EVM UPGRADER_ROLE). Freezing =
    /// admin rotates via `set_upgrader` to a burned address (EVM
    /// `renounceRole` cooperative model).
    Upgrader,
    /// Nullifying key hash for an address.
    NullifyingKey(Address),
    /// Viewing key for an address.
    ViewingKey(Address),
    /// Leaf index for an address (leaf position in tree).
    LeafIndex(Address),
    /// LeanIMT side node at level.
    SideNode(u32),
    /// LeanIMT tree size.
    TreeSize,
    /// Circuit-aligned max keystore-tree size (= 2^keystoreMaxDepth).
    MaxKeystoreTreeSize,
    /// The current (latest) keystore root.
    CurrentRoot,
    /// Liveness window (seconds) a superseded root stays accepted.
    KeystoreRootLiveness,
    /// `valid_until` ledger timestamp for a superseded root (time-based history).
    PreviousRoot(U256),
}

/// Keystore contract errors.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract already initialized.
    AlreadyInitialized = 2,
    /// Contract not initialized.
    NotInitialized = 3,
    /// Nullifying key already registered for this address.
    AlreadyRegistered = 4,
    /// Unknown root (not in history).
    UnknownRoot = 6,
    /// Tree is full.
    TreeFull = 7,
    /// Invalid nullifying key hash (zero).
    InvalidNullifyingKeyHash = 8,
    /// Invalid Merkle proof.
    InvalidProof = 9,
    /// Auth policy not set (for update).
    NotRegistered = 10,
    /// Value exceeds BN254 scalar field modulus.
    OutOfScalarField = 12,
    /// Caller is not authorized.
    NotAuthorized = 13,
    /// `new_wasm_hash` is zero or otherwise invalid.
    InvalidWasmHash = 15,
    /// Keystore root liveness must be non-zero.
    InvalidRootLiveness = 16,
    /// Max keystore-tree size must be non-zero / exceed current size.
    InvalidMaxTreeSize = 17,
    /// Keystore tree is full (configured circuit-aligned cap reached).
    KeystoreTreeFull = 18,
}

/// Emitted when a new leaf is inserted into the keystore tree.
#[contractevent]
#[derive(Clone)]
pub struct LeafInserted {
    /// The leaf hash.
    #[topic]
    pub leaf: U256,
    /// The new Merkle root.
    pub root: U256,
    /// Leaf index in the tree.
    pub index: u32,
}

/// Emitted when an auth policy is set for the first time.
#[contractevent]
#[derive(Clone)]
pub struct AuthPolicySet {
    /// Account that registered.
    #[topic]
    pub account: Address,
    /// The nullifying key hash.
    pub nullifying_key_hash: U256,
    /// The auth digest.
    pub auth_digest: U256,
}

/// Emitted when a leaf is updated in the keystore tree.
#[contractevent]
#[derive(Clone)]
pub struct LeafUpdated {
    /// The new leaf hash.
    #[topic]
    pub leaf: U256,
    /// The new Merkle root.
    pub root: U256,
    /// Leaf index in the tree.
    pub index: u32,
}

/// Emitted when an auth policy is updated.
#[contractevent]
#[derive(Clone)]
pub struct AuthPolicyUpdated {
    /// Account that updated.
    #[topic]
    pub account: Address,
    /// The old auth digest being replaced.
    pub old_auth_digest: U256,
    /// The new auth digest.
    pub new_auth_digest: U256,
}

/// Emitted when a viewing key is set.
#[contractevent]
#[derive(Clone)]
pub struct ViewingKeySet {
    /// Account that set the key.
    #[topic]
    pub account: Address,
    /// The previous viewing key (zero if none).
    pub old_viewing_key: BytesN<32>,
    /// The new viewing key.
    pub viewing_key: BytesN<32>,
}

/// Emitted when the current root is superseded by a new root.
#[contractevent]
#[derive(Clone)]
pub struct RootSuperseded {
    /// The previous current root (zero on first insertion).
    pub old_root: U256,
    /// The new current root.
    pub new_root: U256,
    /// `valid_until` ledger timestamp stamped on the old root (zero if old==0).
    pub valid_until: u64,
}

/// Emitted when the keystore root liveness window is updated.
#[contractevent]
#[derive(Clone)]
pub struct KeystoreRootLivenessUpdated {
    /// Previous liveness (seconds).
    pub previous: u64,
    /// New liveness (seconds).
    pub new_liveness: u64,
}

/// Emitted when the max keystore-tree size is updated.
#[contractevent]
#[derive(Clone)]
pub struct MaxKeystoreTreeSizeUpdated {
    /// Previous max keystore-tree size.
    pub previous: u32,
    /// New max keystore-tree size.
    pub new_max: u32,
}

/// Stamp the current root as superseded (valid for `liveness` seconds) and set
/// `new_root` as the current root. Mirrors EVM Keystore._updateRoot.
fn update_root(env: &Env, new_root: &U256) {
    let zero = U256::from_u32(env, 0);
    let old_root: U256 = env
        .storage()
        .instance()
        .get(&DataKey::CurrentRoot)
        .unwrap_or_else(|| zero.clone());

    let mut valid_until: u64 = 0;
    if old_root != zero {
        let liveness: u64 = env
            .storage()
            .instance()
            .get(&DataKey::KeystoreRootLiveness)
            .unwrap_or(0);
        valid_until = env.ledger().timestamp().saturating_add(liveness);
        let pk = DataKey::PreviousRoot(old_root.clone());
        env.storage().persistent().set(&pk, &valid_until);
        env.storage()
            .persistent()
            .extend_ttl(&pk, LIFETIME_THRESHOLD, BUMP_AMOUNT);
    }

    // Clear any stale validUntil for the new root (handles re-insertion).
    let npk = DataKey::PreviousRoot(new_root.clone());
    if env.storage().persistent().has(&npk) {
        env.storage().persistent().remove(&npk);
    }
    env.storage().instance().set(&DataKey::CurrentRoot, new_root);

    RootSuperseded {
        old_root,
        new_root: new_root.clone(),
        valid_until,
    }
    .publish(env);
}

/// Time-based root-history check (EVM Keystore.isKnownRoot):
/// `root != 0 && (root == currentRoot || now < previousRoots[root])`.
fn root_is_known(env: &Env, root: &U256) -> bool {
    let zero = U256::from_u32(env, 0);
    if *root == zero {
        return false;
    }
    let current: U256 = env
        .storage()
        .instance()
        .get(&DataKey::CurrentRoot)
        .unwrap_or_else(|| zero.clone());
    if *root == current {
        return true;
    }
    let pk = DataKey::PreviousRoot(root.clone());
    if let Some(valid_until) = env.storage().persistent().get::<_, u64>(&pk) {
        env.storage()
            .persistent()
            .extend_ttl(&pk, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        return env.ledger().timestamp() < valid_until;
    }
    false
}

/// Keystore contract.
#[contract]
pub struct KeystoreContract;

#[contractimpl]
impl KeystoreContract {
    /// Initialize the keystore contract.
    pub fn initialize(
        env: Env,
        admin: Address,
        keystore_root_liveness: u64,
        max_keystore_tree_size: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        // A zero liveness would make every superseded root immediately unknown.
        if keystore_root_liveness == 0 {
            return Err(Error::InvalidRootLiveness);
        }
        // Circuit-aligned keystore-tree capacity (= 2^keystoreMaxDepth).
        if max_keystore_tree_size == 0 {
            return Err(Error::InvalidMaxTreeSize);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::KeystoreRootLiveness, &keystore_root_liveness);
        env.storage()
            .instance()
            .set(&DataKey::MaxKeystoreTreeSize, &max_keystore_tree_size);
        env.storage().instance().set(&DataKey::TreeSize, &0u32);
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(())
    }

    /// Update the upgrader address (admin only). Mirrors EVM `grantRole(UPGRADER_ROLE, ...)`.
    pub fn set_upgrader(env: Env, admin: Address, new_upgrader: Address) -> Result<(), Error> {
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
        env.storage()
            .instance()
            .set(&DataKey::Upgrader, &new_upgrader);
        Ok(())
    }

    /// Upgrade the contract WASM (upgrader role only).
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

    /// Register auth policy (one-time per address).
    ///
    /// Computes keystoreLeaf = Poseidon(addressHash, nullifyingKeyHash, authDigest)
    /// and inserts into the keystore tree.
    pub fn set_auth_policy(
        env: Env,
        owner: Address,
        nullifying_key_hash: U256,
        auth_digest: U256,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        owner.require_auth();

        // Validate inputs are within BN254 scalar field
        let field_mod = U256::from_be_bytes(
            &env,
            &soroban_sdk::Bytes::from_slice(&env, &SNARK_SCALAR_FIELD_BYTES),
        );
        if nullifying_key_hash >= field_mod {
            return Err(Error::OutOfScalarField);
        }
        if auth_digest >= field_mod {
            return Err(Error::OutOfScalarField);
        }

        // Validate nullifying key hash is non-zero
        let zero = U256::from_u32(&env, 0);
        if nullifying_key_hash == zero {
            return Err(Error::InvalidNullifyingKeyHash);
        }

        // Check not already registered
        if env
            .storage()
            .persistent()
            .has(&DataKey::NullifyingKey(owner.clone()))
        {
            return Err(Error::AlreadyRegistered);
        }

        // Compute address hash
        let address_hash = address_to_field(&env, &owner);

        // Compute keystore leaf: Poseidon(addressHash, nullifyingKeyHash, authDigest)
        let leaf = poseidon_hash_three(&env, &address_hash, &nullifying_key_hash, &auth_digest);

        // Get current tree size
        let tree_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TreeSize)
            .ok_or(Error::NotInitialized)?;

        // Insert leaf into LeanIMT
        let get_side_node = |level: u32| -> Option<U256> {
            env.storage()
                .persistent()
                .get(&DataKey::SideNode(level))
        };
        let set_side_node = |level: u32, value: &U256| {
            let sn_key = DataKey::SideNode(level);
            env.storage().persistent().set(&sn_key, value);
            env.storage()
                .persistent()
                .extend_ttl(&sn_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        };

        // Enforce circuit-aligned capacity before inserting: size + 1 <= max.
        // TreeFull (u32 overflow) stays an unreachable backstop behind KeystoreTreeFull.
        let new_size = tree_size.checked_add(1).ok_or(Error::TreeFull)?;
        let max_keystore_tree_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxKeystoreTreeSize)
            .ok_or(Error::NotInitialized)?;
        if new_size > max_keystore_tree_size {
            return Err(Error::KeystoreTreeFull);
        }

        let new_root = lean_imt_insert(&env, &leaf, &get_side_node, &set_side_node, tree_size);

        // Store leaf index for this user (for future updates)
        let li_key = DataKey::LeafIndex(owner.clone());
        env.storage().persistent().set(&li_key, &tree_size);
        env.storage()
            .persistent()
            .extend_ttl(&li_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Update tree size
        env.storage().instance().set(&DataKey::TreeSize, &new_size);

        // Store nullifying key (immutable after this)
        let nk_key = DataKey::NullifyingKey(owner.clone());
        env.storage().persistent().set(&nk_key, &nullifying_key_hash);
        env.storage()
            .persistent()
            .extend_ttl(&nk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Update the time-based root history (supersede the old current root).
        update_root(&env, &new_root);

        // Emit events
        LeafInserted {
            leaf,
            root: new_root,
            index: tree_size,
        }
        .publish(&env);

        AuthPolicySet {
            account: owner,
            nullifying_key_hash,
            auth_digest,
        }
        .publish(&env);

        Ok(())
    }

    /// Update auth policy (rotate authDigest, keep nullifyingKeyHash).
    ///
    /// Requires a Merkle proof (sibling nodes) to verify the old leaf exists.
    pub fn update_auth_policy(
        env: Env,
        owner: Address,
        old_auth_digest: U256,
        new_auth_digest: U256,
        sibling_nodes: Vec<U256>,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        owner.require_auth();

        // Validate inputs are within BN254 scalar field
        let field_mod = U256::from_be_bytes(
            &env,
            &soroban_sdk::Bytes::from_slice(&env, &SNARK_SCALAR_FIELD_BYTES),
        );
        if old_auth_digest >= field_mod {
            return Err(Error::OutOfScalarField);
        }
        if new_auth_digest >= field_mod {
            return Err(Error::OutOfScalarField);
        }

        // Must be registered
        let nk_key = DataKey::NullifyingKey(owner.clone());
        let nullifying_key_hash: U256 = env
            .storage()
            .persistent()
            .get(&nk_key)
            .ok_or(Error::NotRegistered)?;
        env.storage()
            .persistent()
            .extend_ttl(&nk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Get leaf index
        let li_key = DataKey::LeafIndex(owner.clone());
        let leaf_index: u32 = env
            .storage()
            .persistent()
            .get(&li_key)
            .ok_or(Error::NotRegistered)?;
        env.storage()
            .persistent()
            .extend_ttl(&li_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        // Compute address hash
        let address_hash = address_to_field(&env, &owner);

        // Compute old leaf
        let old_leaf =
            poseidon_hash_three(&env, &address_hash, &nullifying_key_hash, &old_auth_digest);

        // Get tree size
        let tree_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TreeSize)
            .ok_or(Error::NotInitialized)?;

        // Collect siblings into a rust vec for the lean_imt functions
        let mut sibling_vec = alloc::vec::Vec::new();
        for i in 0..sibling_nodes.len() {
            sibling_vec.push(sibling_nodes.get(i).ok_or(Error::InvalidProof)?);
        }

        // Verify old leaf exists: recompute root from old leaf + siblings
        let computed_root =
            lean_imt_verify_proof(&env, &old_leaf, leaf_index, &sibling_vec, tree_size)
                .ok_or(Error::InvalidProof)?;

        // The recomputed root must equal the tree's CURRENT root, exactly.
        //
        // NOT `root_is_known` — that accepts any superseded root still inside
        // the liveness window (INTL-14), which is correct for a READ-ONLY
        // consumer of a historical root (`pool.transact` validating a
        // circuit-committed keystore root) but wrong for a tree-MUTATING path.
        //
        // `lean_imt_update` below trusts the caller's siblings to describe the
        // current tree and rewrites the side-node cache along that path. A
        // proof generated one insert ago still verifies against its own
        // (superseded but live) root, so it passed this gate while describing a
        // tree shape that no longer exists — and the update then overwrote the
        // cached root with a value computed over the OLD leaf set, silently
        // dropping the leaf inserted in between. Every later insert builds on
        // the corrupted cache, permanently desynchronising the on-chain root
        // from any correctly-computed off-chain root.
        //
        // No malice required: an ordinary registration racing an ordinary key
        // rotation, both honest, inside the 1-hour default window.
        //
        // This restores EVM's semantics. `Keystore.updateAuthPolicy` never
        // calls `isKnownRoot`; it delegates to LeanIMT `_update`, which requires
        // `oldRoot == _root(self)` exactly and only rewrites a side node when
        // `sideNodes[level] == oldRoot`.
        //
        // Regression test: `test_update_auth_policy_rejects_stale_proof_after_growth`.
        let current_root: U256 = env
            .storage()
            .instance()
            .get(&DataKey::CurrentRoot)
            .unwrap_or_else(|| U256::from_u32(&env, 0));
        if computed_root != current_root {
            return Err(Error::UnknownRoot);
        }

        // Compute new leaf
        let new_leaf =
            poseidon_hash_three(&env, &address_hash, &nullifying_key_hash, &new_auth_digest);

        // Update the tree
        let set_side_node = |level: u32, value: &U256| {
            let sn_key = DataKey::SideNode(level);
            env.storage().persistent().set(&sn_key, value);
            env.storage()
                .persistent()
                .extend_ttl(&sn_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        };

        // `get_side_node` is required so the update can refresh a cached side
        // node that still holds the intermediate being replaced — without it the
        // cache goes stale and the NEXT insert derives a wrong root.
        let get_side_node = |level: u32| -> Option<U256> {
            env.storage().persistent().get(&DataKey::SideNode(level))
        };

        let new_root = lean_imt_update(
            &env,
            leaf_index,
            &old_leaf,
            &new_leaf,
            &sibling_vec,
            &get_side_node,
            &set_side_node,
            tree_size,
        );

        // Update the time-based root history (supersede the old current root).
        update_root(&env, &new_root);

        // Emit events
        LeafUpdated {
            leaf: new_leaf,
            root: new_root,
            index: leaf_index,
        }
        .publish(&env);

        AuthPolicyUpdated {
            account: owner,
            old_auth_digest,
            new_auth_digest,
        }
        .publish(&env);

        Ok(())
    }

    /// Set viewing key for the caller.
    pub fn set_viewing_key(
        env: Env,
        owner: Address,
        viewing_key: BytesN<32>,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        owner.require_auth();

        let vk_key = DataKey::ViewingKey(owner.clone());
        let old_viewing_key: BytesN<32> = env
            .storage()
            .persistent()
            .get(&vk_key)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]));
        env.storage().persistent().set(&vk_key, &viewing_key);
        env.storage()
            .persistent()
            .extend_ttl(&vk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        ViewingKeySet {
            account: owner,
            old_viewing_key,
            viewing_key,
        }
        .publish(&env);

        Ok(())
    }

    /// Check if a root is known: the current root, or a superseded root still
    /// within its liveness window. Mirrors EVM Keystore.isKnownRoot.
    pub fn is_known_root(env: Env, root: U256) -> Result<bool, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(root_is_known(&env, &root))
    }

    /// The current (latest) keystore root (zero if none recorded yet).
    pub fn current_root(env: Env) -> Result<U256, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(env
            .storage()
            .instance()
            .get(&DataKey::CurrentRoot)
            .unwrap_or_else(|| U256::from_u32(&env, 0)))
    }

    /// Alias for [`current_root`] (backward-compatible name).
    pub fn latest_root(env: Env) -> Result<U256, Error> {
        Self::current_root(env)
    }

    /// The `valid_until` ledger timestamp for a superseded root (0 if absent).
    pub fn previous_root_valid_until(env: Env, root: U256) -> Result<u64, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(env
            .storage()
            .persistent()
            .get::<_, u64>(&DataKey::PreviousRoot(root))
            .unwrap_or(0))
    }

    /// The configured root liveness window (seconds).
    pub fn keystore_root_liveness(env: Env) -> Result<u64, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::KeystoreRootLiveness)
            .ok_or(Error::NotInitialized)
    }

    /// The configured max keystore-tree size (= 2^keystoreMaxDepth).
    pub fn max_keystore_tree_size(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::MaxKeystoreTreeSize)
            .ok_or(Error::NotInitialized)
    }

    /// Update the root liveness window (upgrader role only).
    /// Mirrors EVM `setKeystoreRootLiveness`.
    pub fn set_keystore_root_liveness(
        env: Env,
        caller: Address,
        new_liveness: u64,
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
        // Reject 0 (a 0 window would defeat the validUntil guard post-init).
        if new_liveness == 0 {
            return Err(Error::InvalidRootLiveness);
        }
        let previous: u64 = env
            .storage()
            .instance()
            .get(&DataKey::KeystoreRootLiveness)
            .ok_or(Error::NotInitialized)?;
        env.storage()
            .instance()
            .set(&DataKey::KeystoreRootLiveness, &new_liveness);
        KeystoreRootLivenessUpdated {
            previous,
            new_liveness,
        }
        .publish(&env);
        Ok(())
    }

    /// Update the max keystore-tree size (upgrader role only).
    /// Mirrors EVM `setMaxKeystoreTreeSize`: new cap must exceed current size.
    pub fn set_max_keystore_tree_size(
        env: Env,
        caller: Address,
        new_max: u32,
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
            .get(&DataKey::MaxKeystoreTreeSize)
            .ok_or(Error::NotInitialized)?;
        env.storage()
            .instance()
            .set(&DataKey::MaxKeystoreTreeSize, &new_max);
        MaxKeystoreTreeSizeUpdated { previous, new_max }.publish(&env);
        Ok(())
    }

    /// Get the current tree size (number of registered users).
    pub fn tree_size(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::TreeSize)
            .ok_or(Error::NotInitialized)
    }

    /// Get the nullifying key hash for an address.
    pub fn get_nullifying_key(env: Env, account: Address) -> Result<U256, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let nk_key = DataKey::NullifyingKey(account);
        let val: U256 = env
            .storage()
            .persistent()
            .get(&nk_key)
            .ok_or(Error::NotRegistered)?;
        env.storage()
            .persistent()
            .extend_ttl(&nk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(val)
    }

    /// Get the nullifying key hash for an address, or `0` if unregistered.
    ///
    /// Mirrors the EVM read `Keystore.nullifyingKeys(account)`, which is a
    /// public mapping and returns 0 for an unset entry. `get_nullifying_key`
    /// above instead returns `NotRegistered`, which makes it unusable as a
    /// *probe* from another contract: a cross-contract caller that just wants
    /// to know "is this account already registered?" would have to recover an
    /// error across the call boundary for the ordinary cold-start case.
    ///
    /// `0` is an unambiguous sentinel here, unlike a zero address: registration
    /// explicitly rejects a zero nullifying key hash
    /// (`Error::InvalidNullifyingKeyHash`), so 0 can never be a stored value.
    ///
    /// Added for `relay.register_and_relay` (INTL-23).
    pub fn get_nullifying_key_or_zero(env: Env, account: Address) -> U256 {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let nk_key = DataKey::NullifyingKey(account);
        match env.storage().persistent().get(&nk_key) {
            Some(v) => {
                // Extend the PERSISTENT entry's TTL, matching
                // `get_nullifying_key` and `update_auth_policy` (STOR-01).
                // Without this, an account registered once and thereafter only
                // ever probed through `register_and_relay` — its intended
                // cold-start use — would have no code path refreshing its
                // registration entry, making this the one reader that can let
                // that record age out.
                env.storage()
                    .persistent()
                    .extend_ttl(&nk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
                v
            }
            None => U256::from_u32(&env, 0),
        }
    }

    /// Get the viewing key for an address.
    pub fn get_viewing_key(env: Env, account: Address) -> Result<BytesN<32>, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let vk_key = DataKey::ViewingKey(account);
        let val: BytesN<32> = env
            .storage()
            .persistent()
            .get(&vk_key)
            .ok_or(Error::NotRegistered)?;
        env.storage()
            .persistent()
            .extend_ttl(&vk_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        Ok(val)
    }
}

#[cfg(test)]
mod test;
