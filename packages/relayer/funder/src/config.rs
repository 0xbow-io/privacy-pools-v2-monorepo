//! The relayer's own config file (`CONFIG_PATH`, the same JSON the relayer parses with `zConfig`
//! in `packages/relayer/relayer/src/config/`). Only what the sweep needs is modelled; everything
//! else (signer key, fees, CORS, families we don't sweep yet...) is ignored, so the relayer schema
//! can grow without breaking this parser. Each family's chain schema lives in its own module.
//!
//! Per-chain env overrides follow the relayer exactly: `<NAME>_<FAMILY>_<id>` (e.g.
//! `RPC_URL_EVM_1`, `FEE_RECEIVER_ADDRESS_STELLAR_1`) wins over the file when set and non-empty.

use std::{fmt, path::Path, str::FromStr};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Deserializer, de};

#[derive(Debug, Deserialize)]
pub struct RelayerConfig {
    pub chains: Chains,
}

#[derive(Debug, Default, Deserialize)]
pub struct Chains {
    #[cfg(feature = "evm")]
    #[serde(default)]
    pub evm: Vec<crate::evm::config::EvmChainConfig>,
}

impl RelayerConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path).with_context(|| format!("read relayer config {}", path.display()))?;
        Self::parse(&raw).with_context(|| format!("parse relayer config {}", path.display()))
    }

    pub fn parse(json: &str) -> Result<Self> {
        Ok(serde_json::from_str(json)?)
    }
}

/// One chain: `<family>:<id>`, e.g. `evm:1`, `evm:56`, `stellar:1`.
#[derive(Debug, Clone, PartialEq)]
pub enum ChainRef {
    Evm(u64),
    Stellar(String),
}

impl FromStr for ChainRef {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        let Some((family, id)) = s.trim().split_once(':') else {
            if s.trim().parse::<u64>().is_ok() {
                bail!("chain {s:?}: add the family, e.g. evm:{}", s.trim());
            }
            bail!("chain {s:?}: expected evm:<id> or stellar:<id>");
        };
        match family {
            "evm" => Ok(ChainRef::Evm(id.parse().with_context(|| format!("chain {s:?}: EVM chain id must be a number"))?)),
            "stellar" if !id.is_empty() => Ok(ChainRef::Stellar(id.into())),
            _ => bail!("chain {s:?}: expected evm:<id> or stellar:<id>"),
        }
    }
}

impl fmt::Display for ChainRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ChainRef::Evm(id) => write!(f, "evm:{id}"),
            ChainRef::Stellar(id) => write!(f, "stellar:{id}"),
        }
    }
}

/// `CHAINS`: `all` (every chain in the config that funder can sweep) or a comma list of
/// [`ChainRef`]s.
#[derive(Debug, Clone, PartialEq)]
pub enum ChainSelection {
    All,
    List(Vec<ChainRef>),
}

impl FromStr for ChainSelection {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        if s.trim() == "all" {
            return Ok(ChainSelection::All);
        }
        let list = s.split(',').map(str::parse).collect::<Result<Vec<ChainRef>>>()?;
        ensure!(!list.is_empty(), "CHAINS is empty");
        for (i, c) in list.iter().enumerate() {
            ensure!(!list[..i].contains(c), "CHAINS lists {c} twice");
        }
        Ok(ChainSelection::List(list))
    }
}

/// Env lookup, injectable for tests.
pub trait Env {
    fn get(&self, key: &str) -> Option<String>;

    /// The relayer's per-chain override `<name>_<family>_<id>`; unset and empty both mean "use
    /// the file" (the relayer's `env ? env : config`).
    fn chain_override(&self, name: &str, family: &str, id: impl fmt::Display) -> Option<String> {
        self.get(&format!("{name}_{family}_{id}")).filter(|v| !v.is_empty())
    }
}

pub struct ProcessEnv;

impl Env for ProcessEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// zod's `z.union([z.number(), z.string()]).pipe(z.coerce.number())`: accepts `18` or `"18"`.
pub fn num_or_str<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: TryFrom<u64>,
    T::Error: fmt::Display,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrStr {
        Num(u64),
        Str(String),
    }
    let n = match NumOrStr::deserialize(d)? {
        NumOrStr::Num(n) => n,
        NumOrStr::Str(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse().map_err(de::Error::custom)?,
        NumOrStr::Str(s) => {
            return Err(de::Error::custom(format!("expected a non-negative integer, got {s:?}")));
        }
    };
    T::try_from(n).map_err(de::Error::custom)
}

#[cfg(test)]
pub mod tests {
    use std::collections::HashMap;

    use super::*;

    pub const FIXTURE: &str = include_str!("../tests/fixtures/relayer.config.json");
    pub const EXAMPLE: &str = include_str!("../tests/fixtures/relayer.config.example.json");

    pub struct MapEnv(pub HashMap<String, String>);

    impl MapEnv {
        pub fn of(pairs: &[(&str, &str)]) -> Self {
            Self(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
        }
    }

    impl Env for MapEnv {
        fn get(&self, key: &str) -> Option<String> {
            self.0.get(key).cloned()
        }
    }

    #[test]
    fn chain_ref_parsing() {
        assert_eq!("evm:1".parse::<ChainRef>().unwrap(), ChainRef::Evm(1));
        assert_eq!(" evm:56 ".parse::<ChainRef>().unwrap(), ChainRef::Evm(56));
        assert_eq!("stellar:1".parse::<ChainRef>().unwrap(), ChainRef::Stellar("1".into()));
        assert_eq!(ChainRef::Evm(56).to_string(), "evm:56");
        let bare = "1".parse::<ChainRef>().unwrap_err().to_string();
        assert!(bare.contains("evm:1"), "{bare}");
        for bad in ["", "evm:", "evm:x", "stellar:", "solana:1", "x"] {
            assert!(bad.parse::<ChainRef>().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn chain_selection_parsing() {
        assert_eq!("all".parse::<ChainSelection>().unwrap(), ChainSelection::All);
        assert_eq!("evm:1,evm:56".parse::<ChainSelection>().unwrap(), ChainSelection::List(vec![ChainRef::Evm(1), ChainRef::Evm(56)]));
        assert!("evm:1,56".parse::<ChainSelection>().is_err());
        assert!("evm:1,evm:1".parse::<ChainSelection>().unwrap_err().to_string().contains("twice"));
        assert!("evm:1,".parse::<ChainSelection>().is_err());
    }

    #[test]
    fn families_we_dont_sweep_are_ignored() {
        let json = r#"{"chains":{"stellar":[{"id":"x","whatever":1}],"starknet":[{}]},"cors":{}}"#;
        RelayerConfig::parse(json).unwrap();
        RelayerConfig::parse(r#"{"chains":{}}"#).unwrap();
    }

    #[test]
    fn chain_override_naming() {
        let env = MapEnv::of(&[("RPC_URL_EVM_1", "a"), ("RPC_URL_STELLAR_1", "b"), ("RPC_URL_EVM_10", "")]);
        assert_eq!(env.chain_override("RPC_URL", "EVM", 1).as_deref(), Some("a"));
        assert_eq!(env.chain_override("RPC_URL", "STELLAR", 1).as_deref(), Some("b"));
        assert_eq!(env.chain_override("RPC_URL", "EVM", 10), None); // empty = unset
        assert_eq!(env.chain_override("RPC_URL", "EVM", 56), None);
    }
}
