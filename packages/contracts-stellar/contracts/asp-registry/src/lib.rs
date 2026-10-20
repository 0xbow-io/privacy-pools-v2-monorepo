//! ASP Registry contract — Association Set Provider root management.
//!
//! Maintains an append-only history of ASP roots with IPFS CIDs.
//! Supports label registration (permissionless).
//! Pool contract reads the latest root via cross-contract call.

#![no_std]

use contract_types::SNARK_SCALAR_FIELD_BYTES;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, Env, U256,
};

/// TTL management: extend persistent entries to prevent expiration.
const LIFETIME_THRESHOLD: u32 = 17_280; // ~1 day in ledgers
const BUMP_AMOUNT: u32 = 518_400; // ~30 days in ledgers

/// Storage keys for ASP Registry.
#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    /// Contract admin address.
    Admin,
    /// Upgrader role address (mirrors EVM UPGRADER_ROLE). Freezing =
    /// admin rotates to a burned address (EVM `renounceRole` model).
    Upgrader,
    /// Postman role address (authorized to update roots).
    Postman,
    /// ASP root at index.
    AspRoot(u32),
    /// IPFS CID for root at index.
    AspCid(u32),
    /// Number of roots stored.
    RootCount,
}

/// ASP Registry errors.
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
    /// No roots have been submitted yet.
    NoRoots = 4,
    /// Root value is zero (empty).
    EmptyRoot = 5,
    /// IPFS CID is empty.
    EmptyCid = 6,
    /// Index out of range.
    IndexOutOfRange = 7,
    /// Arithmetic overflow.
    ArithmeticOverflow = 8,
    /// `new_wasm_hash` is zero or otherwise invalid.
    InvalidWasmHash = 10,
    /// ASP root is not a valid BN254 scalar field element (>= SNARK_SCALAR_FIELD).
    RootOutOfField = 11,
}

/// Emitted when a new ASP root is submitted.
#[contractevent]
#[derive(Clone)]
pub struct ASPRootUpdated {
    /// The new ASP Merkle root.
    #[topic]
    pub root: U256,
    /// Index in the root history.
    pub index: u32,
    /// IPFS CID pointing to label set metadata.
    pub ipfs_cid: Bytes,
}

/// Emitted when a label is registered.
#[contractevent]
#[derive(Clone)]
pub struct LabelRegistered {
    /// Encrypted label ciphertext.
    pub ciphertext: Bytes,
}

/// Emitted when the postman address is updated.
#[contractevent]
#[derive(Clone)]
pub struct PostmanUpdated {
    /// New postman address.
    pub new_postman: Address,
}

/// ASP Registry contract.
#[contract]
pub struct AspRegistryContract;

#[contractimpl]
impl AspRegistryContract {
    /// Initialize the ASP Registry.
    pub fn initialize(env: Env, admin: Address, postman: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Postman, &postman);
        env.storage().instance().set(&DataKey::RootCount, &0u32);
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
    pub fn upgrade(
        env: Env,
        caller: Address,
        new_wasm_hash: soroban_sdk::BytesN<32>,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        if new_wasm_hash == soroban_sdk::BytesN::from_array(&env, &[0u8; 32]) {
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

    /// Update the postman address (admin only).
    pub fn set_postman(env: Env, admin: Address, new_postman: Address) -> Result<(), Error> {
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
            .set(&DataKey::Postman, &new_postman.clone());

        PostmanUpdated { new_postman }.publish(&env);

        Ok(())
    }

    /// Submit a new ASP root (postman only).
    pub fn update_asp_root(
        env: Env,
        postman: Address,
        root: U256,
        ipfs_cid: Bytes,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let stored_postman: Address = env
            .storage()
            .instance()
            .get(&DataKey::Postman)
            .ok_or(Error::NotInitialized)?;
        if postman != stored_postman {
            return Err(Error::NotAuthorized);
        }
        postman.require_auth();

        // Validate inputs
        let zero = U256::from_u32(&env, 0);
        if root == zero {
            return Err(Error::EmptyRoot);
        }
        // Root must be a valid BN254 scalar field element. Mirrors EVM
        // ASPRegistry.updateASPRoot: require(_aspRoot < SNARK_SCALAR_FIELD).
        let field = U256::from_be_bytes(&env, &Bytes::from_slice(&env, &SNARK_SCALAR_FIELD_BYTES));
        if root >= field {
            return Err(Error::RootOutOfField);
        }
        if ipfs_cid.is_empty() {
            return Err(Error::EmptyCid);
        }

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RootCount)
            .ok_or(Error::NotInitialized)?;

        let root_key = DataKey::AspRoot(count);
        env.storage().persistent().set(&root_key, &root);
        env.storage()
            .persistent()
            .extend_ttl(&root_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let cid_key = DataKey::AspCid(count);
        env.storage().persistent().set(&cid_key, &ipfs_cid);
        env.storage()
            .persistent()
            .extend_ttl(&cid_key, LIFETIME_THRESHOLD, BUMP_AMOUNT);

        let new_count = count.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::RootCount, &new_count);

        ASPRootUpdated {
            root,
            index: count,
            ipfs_cid,
        }
        .publish(&env);

        Ok(())
    }

    /// Register a label (permissionless). Emits LabelRegistered event.
    pub fn register_label(env: Env, ciphertext: Bytes) {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        LabelRegistered { ciphertext }.publish(&env);
    }

    /// Get the latest ASP root.
    pub fn latest_asp_root(env: Env) -> Result<U256, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RootCount)
            .ok_or(Error::NotInitialized)?;
        if count == 0 {
            return Err(Error::NoRoots);
        }
        let last_index = count.checked_sub(1).ok_or(Error::ArithmeticOverflow)?;
        let key = DataKey::AspRoot(last_index);
        env.storage()
            .persistent()
            .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)
    }

    /// Get root at a specific index.
    pub fn get_root_at(env: Env, index: u32) -> Result<U256, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RootCount)
            .ok_or(Error::NotInitialized)?;
        if index >= count {
            return Err(Error::IndexOutOfRange);
        }
        let key = DataKey::AspRoot(index);
        env.storage()
            .persistent()
            .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)
    }

    /// Get IPFS CID at a specific index.
    pub fn get_cid_at(env: Env, index: u32) -> Result<Bytes, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RootCount)
            .ok_or(Error::NotInitialized)?;
        if index >= count {
            return Err(Error::IndexOutOfRange);
        }
        let key = DataKey::AspCid(index);
        env.storage()
            .persistent()
            .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)
    }

    /// Get the number of roots stored.
    pub fn root_count(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::RootCount)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
