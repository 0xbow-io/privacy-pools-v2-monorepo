//! What to sweep on one chain, derived from the relayer config's `supported_assets` plus on-chain
//! reads (no registry, no relayer):
//!
//! - wrapped native = the DEX router's `WETH9()`; a config entry with `quoter: "Native"` (other than
//!   the `0xeee…` sentinel) must be that same token
//! - native sentinel and wrapped native: nothing to do before the unwrap
//! - `quoter: "Underlying"`: a PP yield share, i.e. an ERC-4626 vault over an Aave V3 aToken;
//!   `asset()` → aToken → `UNDERLYING_ASSET_ADDRESS()` must equal the config's `underlying`
//! - any other ERC-20: swapped into wrapped native
//!
//! A share that can't be handled (bad config entry, not Aave-backed) is left out and reported as
//! an item failure; the rest of the chain is still swept.

use alloy::{
    primitives::{Address, address},
    providers::DynProvider,
};
use anyhow::{Context, Result, bail, ensure};
use tracing::{debug, error};

use crate::evm::{
    abi::{IAToken, IERC4626, IV3SwapRouter},
    config::{AssetConfig, EvmChainConfig, Quoter},
    dex::Dex,
};

/// How relayer configs mark the native asset (`NATIVE_ASSET_ADDRESS`).
pub const NATIVE_SENTINEL: Address = address!("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");

/// A share as the config describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct ShareSpec {
    pub ticker: String,
    pub share: Address,
    pub underlying: Address,
    pub underlying_decimals: u8,
}

/// A share with its Aave leg resolved on-chain.
#[derive(Debug, Clone, PartialEq)]
pub struct YieldShare {
    pub ticker: String,
    pub share: Address,
    pub a_token: Address,
    pub pool: Address,
    pub underlying: Address,
    pub underlying_decimals: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SwapToken {
    pub ticker: String,
    pub token: Address,
    pub decimals: u8,
}

#[derive(Debug, PartialEq)]
pub struct Classified {
    pub shares: Vec<ShareSpec>,
    pub swap_tokens: Vec<SwapToken>,
    /// Shares left out, one error each (prefixed with the ticker).
    pub rejected: Vec<String>,
}

#[derive(Debug)]
pub struct ChainProfile {
    pub native_symbol: String,
    pub wrapped_native: Address,
    pub dex: &'static Dex,
    pub shares: Vec<YieldShare>,
    pub swap_tokens: Vec<SwapToken>,
    /// Shares left out of the sweep, one error each: reported as item failures.
    pub unsupported: Vec<String>,
}

/// Pure part: the config's own wrapped-native entry (if any) must be the router's WETH9.
pub fn check_wrapped_native(cfg: &EvmChainConfig, weth9: Address) -> Result<()> {
    for a in cfg.supported_assets.iter().filter(|a| a.quoter == Quoter::Native && a.address != NATIVE_SENTINEL) {
        ensure!(a.address == weth9, "{} ({}) has quoter Native but the router's WETH9 is {weth9}", a.ticker, a.address);
    }
    Ok(())
}

/// Pure part: sort `supported_assets` into shares to redeem and tokens to swap. A share entry
/// that can't be swept goes to `rejected` instead of failing the chain.
pub fn classify(cfg: &EvmChainConfig, wrapped_native: Address) -> Classified {
    let is_native = |a: Address| a == NATIVE_SENTINEL || a == wrapped_native;
    let mut swap_tokens = Vec::new();
    for a in &cfg.supported_assets {
        if !is_native(a.address) && a.quoter != Quoter::Underlying {
            swap_tokens.push(SwapToken { ticker: a.ticker.clone(), token: a.address, decimals: a.decimals });
        }
    }

    let mut shares = Vec::new();
    let mut rejected = Vec::new();
    for a in cfg.supported_assets.iter().filter(|a| a.quoter == Quoter::Underlying) {
        match share_spec(cfg, a, &swap_tokens, is_native) {
            Ok(spec) => shares.push(spec),
            Err(e) => rejected.push(format!("{e:#}")),
        }
    }
    Classified { shares, swap_tokens, rejected }
}

/// One `quoter: "Underlying"` entry as a share to redeem; errors are prefixed with its ticker.
fn share_spec(cfg: &EvmChainConfig, a: &AssetConfig, swap_tokens: &[SwapToken], is_native: impl Fn(Address) -> bool) -> Result<ShareSpec> {
    let underlying = a.underlying.with_context(|| format!("{}: quoter Underlying without `underlying`", a.ticker))?;
    let entry = cfg
        .supported_assets
        .iter()
        .find(|u| u.address == underlying)
        .with_context(|| format!("{}: underlying {underlying} is not in supported_assets", a.ticker))?;
    // Redeemed proceeds must be swept by the swap or the unwrap, or they'd sit in the wallet forever.
    if !is_native(underlying) && !swap_tokens.iter().any(|t| t.token == underlying) {
        bail!("{}: underlying {} ({underlying}) is neither wrapped native nor swappable", a.ticker, entry.ticker);
    }
    if underlying == NATIVE_SENTINEL {
        bail!("{}: native-sentinel underlying is not supported (Aave pays out the wrapped token)", a.ticker);
    }
    Ok(ShareSpec { ticker: a.ticker.clone(), share: a.address, underlying, underlying_decimals: entry.decimals })
}

/// share → `asset()` (aToken) → `UNDERLYING_ASSET_ADDRESS()` / `POOL()`.
async fn resolve_share(spec: ShareSpec, provider: &DynProvider) -> Result<YieldShare> {
    let a_token = IERC4626::new(spec.share, provider.clone())
        .asset()
        .call()
        .await
        .with_context(|| format!("{}: {} is not an ERC-4626 vault", spec.ticker, spec.share))?;
    let at = IAToken::new(a_token, provider.clone());
    let (underlying, pool) = match (at.UNDERLYING_ASSET_ADDRESS().call().await, at.POOL().call().await) {
        (Ok(u), Ok(p)) => (u, p),
        _ => bail!("{}: vault asset {a_token} is not an Aave V3 aToken (only Aave-backed shares are supported)", spec.ticker),
    };
    debug!("{}: vault {} -> aToken {a_token} (underlying {underlying}, Aave pool {pool})", spec.ticker, spec.share);
    ensure!(underlying == spec.underlying, "{}: aToken {a_token} underlying {underlying} != config underlying {}", spec.ticker, spec.underlying);
    Ok(YieldShare { ticker: spec.ticker, share: spec.share, a_token, pool, underlying, underlying_decimals: spec.underlying_decimals })
}

pub async fn resolve(cfg: &EvmChainConfig, dex: &'static Dex, provider: &DynProvider) -> Result<ChainProfile> {
    let wrapped_native = IV3SwapRouter::new(dex.router, provider.clone())
        .WETH9()
        .call()
        .await
        .with_context(|| format!("{} router {}.WETH9()", dex.name, dex.router))?;
    debug!("{} router {} WETH9 = {wrapped_native}", dex.name, dex.router);
    check_wrapped_native(cfg, wrapped_native)?;
    let Classified { shares, swap_tokens, rejected: mut unsupported } = classify(cfg, wrapped_native);
    let mut resolved = Vec::with_capacity(shares.len());
    for spec in shares {
        match resolve_share(spec, provider).await {
            Ok(share) => resolved.push(share),
            Err(e) => unsupported.push(crate::redact::error(&e)),
        }
    }
    for msg in &unsupported {
        error!("share left out of the sweep: {msg}");
    }
    Ok(ChainProfile { native_symbol: cfg.native_currency.symbol.clone(), wrapped_native, dex, shares: resolved, swap_tokens, unsupported })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{RelayerConfig, tests::FIXTURE};

    const WETH: Address = address!("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    const WBNB: Address = address!("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");

    fn chain(id: u64) -> EvmChainConfig {
        let mut cfg = RelayerConfig::parse(FIXTURE).unwrap();
        let i = cfg.chains.evm.iter().position(|c| c.id == id).unwrap();
        cfg.chains.evm.swap_remove(i)
    }

    fn tickers<T>(v: &[T], f: impl Fn(&T) -> &str) -> Vec<String> {
        v.iter().map(|x| f(x).to_string()).collect()
    }

    #[test]
    fn classifies_mainnet_fixture() {
        let c = classify(&chain(1), WETH);
        assert!(c.rejected.is_empty(), "{:?}", c.rejected);
        // ETH sentinel and WETH skipped; stables swapped; three shares redeemed.
        assert_eq!(tickers(&c.swap_tokens, |t| &t.ticker), ["USDC", "USDT"]);
        assert_eq!(tickers(&c.shares, |s| &s.ticker), ["ppETH", "ppUSDC", "ppUSDT"]);
        assert_eq!(c.shares[0].underlying, WETH);
        assert_eq!(c.shares[1].underlying_decimals, 6); // from the USDC entry, not the share's 18
    }

    #[test]
    fn classifies_bsc_fixture() {
        let c = classify(&chain(56), WBNB);
        assert!(c.rejected.is_empty(), "{:?}", c.rejected);
        assert_eq!(tickers(&c.swap_tokens, |t| &t.ticker), ["USDT"]);
        assert_eq!(c.shares[0].underlying_decimals, 18);
    }

    #[test]
    fn wrapped_native_must_match_config_native_entry() {
        check_wrapped_native(&chain(1), WETH).unwrap();
        let err = check_wrapped_native(&chain(1), WBNB).unwrap_err().to_string();
        assert!(err.contains("WETH") && err.contains("quoter Native"), "{err}");
        // No non-sentinel Native entry (BSC fixture): nothing to cross-check.
        check_wrapped_native(&chain(56), WBNB).unwrap();
    }

    #[test]
    fn rejects_share_without_underlying_entry_or_field() {
        let mut cfg = chain(1);
        cfg.supported_assets.retain(|a| a.ticker != "USDC");
        let c = classify(&cfg, WETH);
        assert_eq!(c.rejected.len(), 1, "{:?}", c.rejected);
        assert!(c.rejected[0].contains("ppUSDC") && c.rejected[0].contains("not in supported_assets"), "{:?}", c.rejected);

        let mut cfg = chain(1);
        cfg.supported_assets.iter_mut().find(|a| a.ticker == "ppUSDT").unwrap().underlying = None;
        let c = classify(&cfg, WETH);
        assert!(c.rejected.len() == 1 && c.rejected[0].contains("ppUSDT"), "{:?}", c.rejected);
    }

    #[test]
    fn bad_share_is_left_out_and_the_rest_still_swept() {
        let mut cfg = chain(1);
        cfg.supported_assets.iter_mut().find(|a| a.ticker == "ppUSDT").unwrap().underlying = None;
        let c = classify(&cfg, WETH);
        assert_eq!(tickers(&c.shares, |s| &s.ticker), ["ppETH", "ppUSDC"]);
        assert_eq!(tickers(&c.swap_tokens, |t| &t.ticker), ["USDC", "USDT"]);
    }

    #[test]
    fn rejects_underlying_that_would_be_stranded() {
        // Underlying is another share: never swapped, never unwrapped.
        let mut cfg = chain(1);
        let pp_eth = cfg.supported_assets.iter().find(|a| a.ticker == "ppETH").unwrap().address;
        cfg.supported_assets.iter_mut().find(|a| a.ticker == "ppUSDC").unwrap().underlying = Some(pp_eth);
        let c = classify(&cfg, WETH);
        assert!(c.rejected.len() == 1 && c.rejected[0].contains("neither wrapped native nor swappable"), "{:?}", c.rejected);
        assert_eq!(tickers(&c.shares, |s| &s.ticker), ["ppETH", "ppUSDT"]);
    }
}
