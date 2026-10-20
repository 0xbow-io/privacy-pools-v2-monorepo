//! EVM chain entries of the relayer config (`chains.evm[]`, `evm-chain-config.ts`), plus the
//! relayer's `<NAME>_EVM_<id>` env overrides.

use std::str::FromStr;

use alloy::primitives::Address;
use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::config::{Env, RelayerConfig, num_or_str};

#[derive(Debug, Deserialize)]
pub struct EvmChainConfig {
    #[serde(deserialize_with = "num_or_str")]
    pub id: u64,
    pub name: String,
    pub rpc_url: String,
    pub fee_receiver_address: Address,
    #[serde(default)]
    pub native_currency: NativeCurrency,
    pub supported_assets: Vec<AssetConfig>,
}

#[derive(Debug, Deserialize)]
pub struct NativeCurrency {
    #[serde(default = "default_symbol")]
    pub symbol: String,
}

impl Default for NativeCurrency {
    fn default() -> Self {
        Self { symbol: default_symbol() }
    }
}

fn default_symbol() -> String {
    "ETH".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetConfig {
    pub address: Address,
    pub ticker: String,
    pub quoter: Quoter,
    /// Only with `quoter: "Underlying"`: the asset the ERC-4626 share redeems into.
    #[serde(default)]
    pub underlying: Option<Address>,
    #[serde(deserialize_with = "num_or_str")]
    pub decimals: u8,
}

/// `RateProvider` in `rate_types.ts`. Unknown future providers parse as `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Quoter {
    Native,
    Underlying,
    Uniswap,
    Cowswap,
    Curve,
    Test,
    Mock,
    #[serde(other)]
    Other,
}

impl RelayerConfig {
    pub fn evm_chain(&self, id: u64) -> Result<&EvmChainConfig> {
        match self.chains.evm.iter().find(|c| c.id == id) {
            Some(c) => Ok(c),
            None => {
                let ids: Vec<u64> = self.chains.evm.iter().map(|c| c.id).collect();
                bail!("chain {id} is not in the relayer config (evm chains: {ids:?})")
            }
        }
    }
}

/// Alchemy subdomains (`https://<host>.g.alchemy.com/v2/<key>`) for `ALCHEMY_RPC_KEY`; each answered
/// `eth_chainId` with its id on 2026-10-14. A chain must also be enabled on the Alchemy app.
const ALCHEMY_HOSTS: &[(u64, &str)] = &[
    (1, "eth-mainnet"),
    (56, "bnb-mainnet"),
    (10, "opt-mainnet"),
    (42161, "arb-mainnet"),
    (8453, "base-mainnet"),
    (4663, "robinhood-mainnet"),
    (4114, "citrea-mainnet"),
];

fn alchemy_host(id: u64) -> Option<&'static str> {
    ALCHEMY_HOSTS.iter().find(|(c, _)| *c == id).map(|(_, h)| *h)
}

impl EvmChainConfig {
    fn env_override(&self, env: &impl Env, name: &str) -> Option<String> {
        env.chain_override(name, "EVM", self.id)
    }

    /// `RPC_URL_EVM_<id>`, else Alchemy's endpoint for this chain when `ALCHEMY_RPC_KEY` is set and
    /// the chain is in [`ALCHEMY_HOSTS`], else the file's `rpc_url`.
    pub fn rpc_url(&self, env: &impl Env) -> String {
        if let Some(url) = self.env_override(env, "RPC_URL") {
            return url;
        }
        let key = env.get("ALCHEMY_RPC_KEY").map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        match (key, alchemy_host(self.id)) {
            (Some(key), Some(host)) => format!("https://{host}.g.alchemy.com/v2/{key}"),
            _ => self.rpc_url.clone(),
        }
    }

    /// `FEE_RECEIVER_ADDRESS_EVM_<id>` or the file's `fee_receiver_address`.
    pub fn fee_receiver(&self, env: &impl Env) -> Result<Address> {
        match self.env_override(env, "FEE_RECEIVER_ADDRESS") {
            Some(v) => Address::from_str(&v).with_context(|| format!("FEE_RECEIVER_ADDRESS_EVM_{} is not an address", self.id)),
            None => Ok(self.fee_receiver_address),
        }
    }
}

#[cfg(test)]
mod tests {
    use alloy::primitives::address;

    use super::*;
    use crate::config::tests::{EXAMPLE, FIXTURE, MapEnv};

    #[test]
    fn parses_prod_shaped_fixture() {
        let cfg = RelayerConfig::parse(FIXTURE).unwrap();
        let main = cfg.evm_chain(1).unwrap();
        assert_eq!(main.name, "mainnet");
        assert_eq!(main.native_currency.symbol, "ETH");
        assert_eq!(main.supported_assets.len(), 7);
        let usdt = main.supported_assets.iter().find(|a| a.ticker == "USDT").unwrap();
        assert_eq!(usdt.decimals, 6); // "6" as a string
        assert_eq!(usdt.address, address!("0xdAC17F958D2ee523a2206206994597C13D831ec7")); // lowercase in file
        let pp = main.supported_assets.iter().find(|a| a.ticker == "ppUSDC").unwrap();
        assert_eq!(pp.quoter, Quoter::Underlying);
        assert_eq!(cfg.evm_chain(56).unwrap().native_currency.symbol, "BNB"); // id "56" as a string
    }

    #[test]
    fn parses_relayer_repo_example_config() {
        // Verbatim copy of packages/relayer/relayer/relayer.config.example.json.
        let cfg = RelayerConfig::parse(EXAMPLE).unwrap();
        assert!(!cfg.chains.evm.is_empty());
    }

    #[test]
    fn unknown_quoter_and_fields_are_tolerated() {
        let json = r#"{"chains":{"evm":[{"id":1,"name":"x","rpc_url":"http://a","fee_receiver_address":"0x0000000000000000000000000000000000000001",
            "brand_new_field":{"a":1},
            "supported_assets":[{"address":"0x0000000000000000000000000000000000000002","ticker":"T","quoter":"SomeFutureDex","decimals":6}]}]}}"#;
        let cfg = RelayerConfig::parse(json).unwrap();
        let c = cfg.evm_chain(1).unwrap();
        assert_eq!(c.supported_assets[0].quoter, Quoter::Other);
        assert_eq!(c.native_currency.symbol, "ETH"); // default
    }

    #[test]
    fn rejects_bad_decimals_and_addresses() {
        let bad_dec = r#"{"chains":{"evm":[{"id":1,"name":"x","rpc_url":"http://a","fee_receiver_address":"0x0000000000000000000000000000000000000001",
            "supported_assets":[{"address":"0x0000000000000000000000000000000000000002","ticker":"T","quoter":"Mock","decimals":""}]}]}}"#;
        assert!(RelayerConfig::parse(bad_dec).is_err(), "empty decimals must not coerce to 0");
        let bad_addr = r#"{"chains":{"evm":[{"id":1,"name":"x","rpc_url":"http://a","fee_receiver_address":"0x01","supported_assets":[]}]}}"#;
        assert!(RelayerConfig::parse(bad_addr).is_err());
    }

    #[test]
    fn missing_chain_lists_available() {
        let cfg = RelayerConfig::parse(FIXTURE).unwrap();
        let err = cfg.evm_chain(10).unwrap_err().to_string();
        assert!(err.contains("[1, 56]"), "{err}");
    }

    #[test]
    fn env_overrides_follow_relayer_naming() {
        let cfg = RelayerConfig::parse(FIXTURE).unwrap();
        let main = cfg.evm_chain(1).unwrap();
        let fee = "0x000000000000000000000000000000000000bEEF";
        let env = MapEnv::of(&[("RPC_URL_EVM_1", "http://override"), ("FEE_RECEIVER_ADDRESS_EVM_1", fee), ("RPC_URL_EVM_56", "http://other")]);
        assert_eq!(main.rpc_url(&env), "http://override");
        assert_eq!(main.fee_receiver(&env).unwrap(), Address::from_str(fee).unwrap());

        // Unset or empty -> file value (the relayer's `env ? env : config`).
        let empty = MapEnv::of(&[("RPC_URL_EVM_1", ""), ("FEE_RECEIVER_ADDRESS_EVM_1", "")]);
        assert_eq!(main.rpc_url(&empty), "http://127.0.0.1:1");
        assert_eq!(main.fee_receiver(&empty).unwrap(), main.fee_receiver_address);

        // Old un-namespaced names (pre-#459) are NOT honoured, same as the relayer.
        let legacy = MapEnv::of(&[("RPC_URL_1", "http://legacy")]);
        assert_eq!(main.rpc_url(&legacy), "http://127.0.0.1:1");

        let bad = MapEnv::of(&[("FEE_RECEIVER_ADDRESS_EVM_1", "nope")]);
        assert!(main.fee_receiver(&bad).is_err());
    }

    #[test]
    fn alchemy_key_fills_in_rpc_urls() {
        let cfg = RelayerConfig::parse(FIXTURE).unwrap();
        let (main, bsc) = (cfg.evm_chain(1).unwrap(), cfg.evm_chain(56).unwrap());
        let env = MapEnv::of(&[("ALCHEMY_RPC_KEY", " k3y\n")]);
        assert_eq!(main.rpc_url(&env), "https://eth-mainnet.g.alchemy.com/v2/k3y");
        assert_eq!(bsc.rpc_url(&env), "https://bnb-mainnet.g.alchemy.com/v2/k3y");
        // A per-chain URL still wins; an empty key is unset.
        let both = MapEnv::of(&[("ALCHEMY_RPC_KEY", "k3y"), ("RPC_URL_EVM_1", "http://override")]);
        assert_eq!(main.rpc_url(&both), "http://override");
        assert_eq!(main.rpc_url(&MapEnv::of(&[("ALCHEMY_RPC_KEY", "")])), "http://127.0.0.1:1");
        // A chain without an Alchemy endpoint keeps the file's URL.
        assert!(alchemy_host(999).is_none());
    }
}
