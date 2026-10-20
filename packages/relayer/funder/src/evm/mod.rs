//! EVM family: PP yield shares redeemed + withdrawn from Aave, V3 swaps into wrapped native,
//! unwrap, native send. Chains need an entry in the relayer config (`chains.evm[]`) and in [`dex`].

pub mod abi;
pub mod config;
pub mod dex;
pub mod lifi;
pub mod math;
pub mod profile;
pub mod sender;
mod steps;

use std::{collections::HashMap, path::PathBuf, str::FromStr};

use alloy::{
    network::EthereumWallet,
    primitives::{
        Address, U256,
        utils::{format_units, parse_units},
    },
    providers::{DynProvider, Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
    signers::local::PrivateKeySigner,
};
use alloy::{
    rpc::client::{ClientBuilder, RpcClient},
    transports::{
        TransportError, TransportErrorKind,
        http::{Http, reqwest},
        layers::{OrRetryPolicyFn, RateLimitRetryPolicy, RetryBackoffLayer},
    },
};
use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use tracing::{debug, info, warn};

use crate::{
    config::{Env, ProcessEnv, RelayerConfig},
    pipeline::{Common, Family, Settings, Step},
};
use math::MAX_SLIPPAGE_BPS;
use profile::ChainProfile;
use sender::Sender;
pub use steps::SwapVenue;

/// EVM-only options. `KEEP_WEI`, `MAX_BASE_FEE_GWEI` and `RECIPIENT` can be overridden per chain
/// with the relayer's naming: `KEEP_WEI_EVM_<id>`, `MAX_BASE_FEE_GWEI_EVM_<id>`,
/// `RECIPIENT_EVM_<id>`.
// No `Debug`: holds the private key and keystore password.
#[derive(Args)]
#[command(next_help_heading = "EVM")]
pub struct EvmArgs {
    /// Foundry keystore name (~/.foundry/keystores/<name>) or path. Password from
    /// KEYSTORE_PASSWORD or an interactive prompt. One fee wallet serves every EVM chain.
    #[arg(long, env = "KEYSTORE_ACCOUNT", group = "signer")]
    keystore_account: Option<String>,

    #[arg(long, env = "KEYSTORE_PASSWORD", hide_env_values = true, hide = true)]
    keystore_password: Option<String>,

    /// Raw fee-wallet private key (prefer the env var to the flag). Kept as text and parsed by
    /// us, so a malformed value is never echoed back in an error.
    #[arg(long, env = "PRIVATE_KEY", hide_env_values = true, group = "signer")]
    private_key: Option<String>,

    /// Impersonated sender: anvil fork testing only.
    #[arg(long, env = "UNLOCKED_FROM", group = "signer")]
    unlocked_from: Option<Address>,

    /// Native left in the fee wallet for the next run's gas, in wei. Must cover one tx's upfront
    /// `gas_limit x maxFee` (~360k gas x (2 x base + tip)) or the wallet stalls when gas rises.
    #[arg(long, env = "KEEP_WEI", default_value = "5000000000000000")]
    keep_wei: U256,

    /// Skip a chain (without failing the run) while its base fee is above this, in gwei, e.g. `2`
    /// or `0.5`; `none` disables. The default keeps a ~360k-gas tx within the default KEEP_WEI.
    #[arg(long, env = "MAX_BASE_FEE_GWEI", default_value = "5")]
    max_base_fee_gwei: String,

    /// Priority fee per tx, in wei.
    #[arg(long, env = "TIP_WEI", default_value_t = 100_000_000)]
    tip_wei: u128,

    /// Swap minOut below the on-chain quote, in bps.
    #[arg(long, env = "SLIPPAGE_BPS", default_value_t = 50)]
    slippage_bps: u64,

    /// Skip a swap whose output is < N x its estimated gas cost.
    #[arg(long, env = "MIN_GAS_MULTIPLE", default_value_t = 5)]
    min_gas_multiple: u64,

    /// Swap venue: `best` (LI.FI vs direct V3, higher guaranteed output after gas), `lifi` (LI.FI
    /// unless its quote fails the checks, prices below V3's floor or reverts), `v3` (no API).
    #[arg(long, env = "SWAP_VENUE", value_enum, default_value_t = SwapVenue::Best)]
    swap_venue: SwapVenue,

    /// LI.FI API base URL (no key needed at this volume).
    #[arg(long, env = "LIFI_API_URL", default_value = "https://li.quest/v1")]
    lifi_api_url: String,

    /// Cap on the final native send, in USD (e.g. `100`), priced on-chain through the chain's USD
    /// stablecoin; the rest stays in the fee wallet for later runs. Swap output paid straight to
    /// the recipient is not capped. Unset or `none`: no cap.
    #[arg(long, env = "MAX_SEND_USD")]
    max_send_usd: Option<String>,

    /// Recipient balance floor, in USD (e.g. `20`), priced like MAX_SEND_USD: at or above it the
    /// chain is done without sweeping, so a frequent schedule only sweeps a recipient that runs
    /// low. Unset or `none`: always sweep.
    #[arg(long, env = "MIN_RECIPIENT_BALANCE_USD")]
    min_recipient_balance_usd: Option<String>,

    /// LI.FI integrator id sent with quotes.
    #[arg(long, env = "LIFI_INTEGRATOR", default_value = "privacy-pools-v2")]
    lifi_integrator: String,
}

struct Opts {
    slippage_bps: u64,
    min_gas_multiple: u64,
    /// `MAX_SEND_USD`, validated decimal string.
    max_send_usd: Option<String>,
    /// `MIN_RECIPIENT_BALANCE_USD`, validated decimal string.
    min_recipient_usd: Option<String>,
    max_base_fee: Option<u128>,
    venue: SwapVenue,
}

pub struct Evm {
    chain_id: u64,
    chain: ChainProfile,
    tx: Sender,
    opts: Opts,
    /// `None` with SWAP_VENUE=v3.
    lifi: Option<lifi::Client>,
    /// Dry run: underlying a redeem would add to a swap token's balance before the swaps.
    redeemed: HashMap<Address, U256>,
    /// Dry run: projected effect of the steps so far on the wallet's native balance.
    dry: Step<U256>,
    /// Per-item failures (one share or token) that didn't stop the rest of the chain's sweep.
    failures: Vec<String>,
}

pub fn fmt_units(v: U256, decimals: u8) -> String {
    format_units(v, decimals).unwrap_or_else(|_| v.to_string())
}

fn load_keystore(account: &str, password: Option<String>) -> Result<PrivateKeySigner> {
    let path = if account.contains('/') {
        PathBuf::from(account)
    } else {
        let home = std::env::var("HOME").context("HOME not set")?;
        PathBuf::from(home).join(".foundry/keystores").join(account)
    };
    let password = match password {
        Some(p) => p,
        None => rpassword::prompt_password(format!("password for {}: ", path.display()))?,
    };
    PrivateKeySigner::decrypt_keystore(&path, password).with_context(|| format!("decrypt {}", path.display()))
}

/// Never includes the input in the error: it may be a real key with a typo or a trailing newline.
fn parse_private_key(raw: &str) -> Result<PrivateKeySigner> {
    PrivateKeySigner::from_str(raw.trim()).map_err(|_| anyhow::anyhow!("PRIVATE_KEY is not a 32-byte hex private key"))
}

/// RPC client: per-request timeout (a half-open connection must not hang the run) and retries
/// with backoff on rate limits and transport errors. A resent broadcast is the same signed tx, but
/// its answer can differ ("already known" after a timed-out first try): `Sender` settles a failed
/// broadcast by the tx hash, not the error.
fn rpc_client(rpc_url: &str) -> Result<RpcClient> {
    let url: reqwest::Url = rpc_url.parse().map_err(|_| anyhow::anyhow!("RPC URL is not a valid URL"))?;
    let http = reqwest::Client::builder().timeout(RPC_TIMEOUT).build()?;
    let policy = OrRetryPolicyFn::new(RateLimitRetryPolicy::default(), |e: &TransportError| {
        matches!(e, TransportError::Transport(TransportErrorKind::Custom(_)))
    });
    let retry = RetryBackoffLayer::new_with_policy(RPC_RETRIES, RPC_BACKOFF_MS, RPC_CU_PER_SECOND, policy);
    Ok(ClientBuilder::default().layer(retry).transport(Http::with_client(http, url), false))
}

const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const RPC_RETRIES: u32 = 5;
const RPC_BACKOFF_MS: u64 = 500;
const RPC_CU_PER_SECOND: u64 = 1_000;

/// A recipient typo must not silently pass: mixed-case input must be a valid EIP-55 checksum.
fn parse_address(s: &str) -> Result<Address> {
    let s = s.trim();
    let hex = s.strip_prefix("0x").unwrap_or(s);
    let mixed = hex.bytes().any(|b| b.is_ascii_lowercase()) && hex.bytes().any(|b| b.is_ascii_uppercase());
    if mixed {
        Address::parse_checksummed(s, None).map_err(|_| anyhow::anyhow!("{s:?} has an invalid EIP-55 checksum (typo?)"))
    } else {
        Address::from_str(s).map_err(|_| anyhow::anyhow!("{s:?} is not an EVM address"))
    }
}

/// The fee-wallet signer: loaded once per run (one keystore prompt) and shared by every EVM chain.
pub enum EvmSigner {
    /// The node signs (anvil --auto-impersonate).
    Unlocked(Address),
    Local(PrivateKeySigner),
}

impl EvmSigner {
    pub fn load(args: &EvmArgs) -> Result<Self> {
        Ok(if let Some(from) = args.unlocked_from {
            EvmSigner::Unlocked(from)
        } else if let Some(account) = &args.keystore_account {
            EvmSigner::Local(load_keystore(account, args.keystore_password.clone())?)
        } else if let Some(key) = &args.private_key {
            EvmSigner::Local(parse_private_key(key)?)
        } else {
            bail!("set KEYSTORE_ACCOUNT, PRIVATE_KEY or UNLOCKED_FROM");
        })
    }

    fn address(&self) -> Address {
        match self {
            EvmSigner::Unlocked(a) => *a,
            EvmSigner::Local(k) => k.address(),
        }
    }

    /// The local key as a wallet for `Sender` to sign with; `None` when the node signs.
    fn wallet(&self) -> Option<EthereumWallet> {
        match self {
            EvmSigner::Unlocked(_) => None,
            EvmSigner::Local(k) => Some(EthereumWallet::from(k.clone())),
        }
    }

    fn provider(&self, rpc_url: &str) -> Result<DynProvider> {
        let client = rpc_client(rpc_url)?;
        Ok(match self {
            EvmSigner::Unlocked(_) => ProviderBuilder::new().connect_client(client).erased(),
            EvmSigner::Local(k) => ProviderBuilder::new().wallet(EthereumWallet::from(k.clone())).connect_client(client).erased(),
        })
    }
}

/// Every chain in the config that has a DEX entry, plus the ones that don't (with the reason).
pub fn sweepable(config: &RelayerConfig) -> (Vec<u64>, Vec<(u64, String)>) {
    let (mut ok, mut skipped) = (Vec::new(), Vec::new());
    for c in &config.chains.evm {
        // A duplicated chain id would run two sweeps on one wallet at the same nonces.
        if ok.contains(&c.id) || skipped.iter().any(|(id, _)| *id == c.id) {
            skipped.push((c.id, "duplicate chain id in the relayer config; swept once".to_string()));
            continue;
        }
        match dex::for_chain(c.id) {
            Some(_) => ok.push(c.id),
            None => skipped.push((c.id, format!("no DEX entry in src/evm/dex.rs (supported: {:?})", dex::supported_chains()))),
        }
    }
    (ok, skipped)
}

/// One chain's values after its `<NAME>_EVM_<id>` overrides.
#[derive(Debug, PartialEq)]
struct ChainOverrides {
    recipient: Address,
    keep: U256,
    max_base_fee: Option<u128>,
    min_gas_multiple: u64,
    max_send_usd: Option<String>,
    min_recipient_usd: Option<String>,
}

fn parse_gwei(v: &str) -> Result<u128> {
    let v = v.trim();
    ensure!(!v.starts_with('-'), "negative");
    let wei: U256 = parse_units(v, "gwei")?.into();
    Ok(u128::try_from(wei)?)
}

fn overrides(env: &impl Env, id: u64, c: &Common<'_>, args: &EvmArgs) -> Result<ChainOverrides> {
    let recipient = env
        .chain_override("RECIPIENT", "EVM", id)
        .or_else(|| c.recipient.map(String::from))
        .with_context(|| format!("no recipient for evm:{id}: set RECIPIENT_EVM_{id} or RECIPIENT"))?;
    let recipient = parse_address(&recipient).with_context(|| format!("recipient for evm:{id}"))?;
    ensure!(!recipient.is_zero(), "recipient for evm:{id} is the zero address");
    let keep = match env.chain_override("KEEP_WEI", "EVM", id) {
        Some(v) => U256::from_str(v.trim()).with_context(|| format!("KEEP_WEI_EVM_{id} {v:?} is not an integer wei amount"))?,
        None => args.keep_wei,
    };
    let (name, value) = match env.chain_override("MAX_BASE_FEE_GWEI", "EVM", id) {
        Some(v) => (format!("MAX_BASE_FEE_GWEI_EVM_{id}"), v),
        None => ("MAX_BASE_FEE_GWEI".to_string(), args.max_base_fee_gwei.clone()),
    };
    let max_base_fee = match value.trim() {
        "none" | "off" => None,
        v => Some(parse_gwei(v).with_context(|| format!("{name} {v:?} is not a gwei amount (or `none`)"))?),
    };
    let min_gas_multiple = match env.chain_override("MIN_GAS_MULTIPLE", "EVM", id) {
        Some(v) => v.trim().parse().with_context(|| format!("MIN_GAS_MULTIPLE_EVM_{id} {v:?} is not a whole number"))?,
        None => args.min_gas_multiple,
    };
    let max_send_usd = usd_override(env, id, "MAX_SEND_USD", args.max_send_usd.as_deref())?;
    let min_recipient_usd = usd_override(env, id, "MIN_RECIPIENT_BALANCE_USD", args.min_recipient_balance_usd.as_deref())?;
    Ok(ChainOverrides { recipient, keep, max_base_fee, min_gas_multiple, max_send_usd, min_recipient_usd })
}

/// A USD amount from `<var>_EVM_<id>` or the global `<var>`; `none`/`off`/unset = `None`.
fn usd_override(env: &impl Env, id: u64, var: &str, global: Option<&str>) -> Result<Option<String>> {
    let (name, value) = match env.chain_override(var, "EVM", id) {
        Some(v) => (format!("{var}_EVM_{id}"), Some(v)),
        None => (var.to_string(), global.filter(|v| !v.trim().is_empty()).map(String::from)),
    };
    Ok(match value.as_deref().map(str::trim) {
        None | Some("none") | Some("off") => None,
        Some(v) => {
            let ok = !v.starts_with('-') && parse_units(v, 6).ok().map(Into::<U256>::into).is_some_and(|u| !u.is_zero());
            ensure!(ok, "{name} {v:?} is not a positive USD amount (e.g. 100 or 2.5), or `none`");
            Some(v.to_string())
        }
    })
}

impl Evm {
    /// Resolves the chain's overrides, connects, checks the signer is the chain's fee receiver and
    /// resolves what to sweep from the config.
    pub async fn connect(chain_id: u64, c: &Common<'_>, args: &EvmArgs, signer: &EvmSigner) -> Result<(Self, Settings<Self>)> {
        ensure!(args.slippage_bps <= MAX_SLIPPAGE_BPS, "SLIPPAGE_BPS {} out of range 0..{MAX_SLIPPAGE_BPS}", args.slippage_bps);
        let o = overrides(&ProcessEnv, chain_id, c, args)?;
        let chain_cfg = c.config.evm_chain(chain_id)?;
        let dex =
            dex::for_chain(chain_id).with_context(|| format!("no DEX configured for chain {chain_id} (supported: {:?})", dex::supported_chains()))?;

        let rpc_url = chain_cfg.rpc_url(&ProcessEnv);
        debug!(
            "connecting: rpc {}, signer {} ({})",
            crate::redact::text(&rpc_url),
            signer.address(),
            match signer {
                EvmSigner::Unlocked(_) => "unlocked on the node",
                EvmSigner::Local(_) => "local key",
            }
        );
        let provider = signer.provider(&rpc_url)?;
        let from = signer.address();
        let rpc_chain = provider.get_chain_id().await.context("RPC unreachable")?;
        ensure!(rpc_chain == chain_id, "RPC is chain {rpc_chain}, not {chain_id}");

        // Only ever sweep the wallet the relayer actually pays fees to.
        let fee_receiver = chain_cfg.fee_receiver(&ProcessEnv)?;
        debug!("rpc chain id {rpc_chain} ok; fee receiver {fee_receiver}");
        ensure!(
            from == fee_receiver,
            "signer {from} is not chain {chain_id}'s fee receiver {fee_receiver} (FEE_RECEIVER_ADDRESS_EVM_{chain_id} or config)"
        );

        let mut chain = profile::resolve(chain_cfg, dex, &provider).await?;
        // Shares that can't be swept fail the chain at the end, not before the rest is swept.
        let failures = std::mem::take(&mut chain.unsupported);
        info!(
            "config {}: redeem [{}], swap [{}] via {}",
            c.config_path.display(),
            chain.shares.iter().map(|s| s.ticker.as_str()).collect::<Vec<_>>().join(","),
            chain.swap_tokens.iter().map(|t| t.ticker.as_str()).collect::<Vec<_>>().join(","),
            dex.name
        );

        let tx = Sender::new(provider, from, args.tip_wei, signer.wallet(), chain_id).await?;
        info!(
            "chain={chain_id} ({}) from={from} recipient={} keep={} max_base_fee={} nonce={} tip={}wei venue={:?} mode={}",
            chain_cfg.name,
            o.recipient,
            fmt_units(o.keep, 18),
            o.max_base_fee.map_or("none".into(), |m| format!("{}gwei", fmt_units(U256::from(m), 9))),
            tx.nonce(),
            args.tip_wei,
            args.swap_venue,
            if c.send { "LIVE" } else { "DRY-RUN" }
        );
        let opts = Opts {
            slippage_bps: args.slippage_bps,
            min_gas_multiple: o.min_gas_multiple,
            max_send_usd: o.max_send_usd.clone(),
            min_recipient_usd: o.min_recipient_usd.clone(),
            max_base_fee: o.max_base_fee,
            venue: args.swap_venue,
        };
        let lifi = match args.swap_venue {
            SwapVenue::V3 => None,
            _ if !dex.lifi => {
                debug!("no LI.FI on chain {chain_id}: direct {} only", dex.name);
                None
            }
            _ => Some(lifi::Client::new(&args.lifi_api_url, &args.lifi_integrator)?),
        };
        let settings = Settings { recipient: o.recipient, keep: o.keep, send: c.send, only: c.only.map(<[String]>::to_vec) };
        let worst_tx = U256::from(math::GAS_REDEEM) * U256::from(math::max_fee_per_gas(tx.base_fee().await?, args.tip_wei));
        if o.keep < worst_tx {
            warn!(
                "KEEP_WEI {} is below one ~{}k-gas tx's upfront cost at current fees ({}): the wallet can stall once it runs down to it",
                fmt_units(o.keep, 18),
                math::GAS_REDEEM / 1000,
                fmt_units(worst_tx, 18)
            );
        }
        let evm = Evm { chain_id, chain, tx, opts, lifi, redeemed: HashMap::new(), dry: Step::default(), failures };
        Ok((evm, settings))
    }
}

impl Family for Evm {
    type Address = Address;
    type Amount = U256;
    /// Gas limit for the native send.
    type Transfer = u64;

    fn native_symbol(&self) -> &str {
        &self.chain.native_symbol
    }

    fn fmt_native(&self, v: U256) -> String {
        fmt_units(v, 18)
    }

    fn fee_wallet(&self) -> Address {
        self.tx.from
    }

    async fn recipient_funded(&self, to: Address) -> Result<Option<String>> {
        let Some(usd) = &self.opts.min_recipient_usd else { return Ok(None) };
        let (have, floor) = (self.native_balance(to).await?, self.usd_in_native(usd, "MIN_RECIPIENT_BALANCE_USD").await?);
        let sym = &self.chain.native_symbol;
        let line =
            format!("recipient {to} holds {} {sym}, floor MIN_RECIPIENT_BALANCE_USD {usd} = {} {sym}", fmt_units(have, 18), fmt_units(floor, 18));
        if have >= floor {
            return Ok(Some(line));
        }
        info!("{line}: below it, sweeping");
        Ok(None)
    }

    async fn skip_reason(&self) -> Result<Option<String>> {
        let Some(max) = self.opts.max_base_fee else {
            return Ok(None);
        };
        let base = self.tx.base_fee().await?;
        let gwei = |v: u128| fmt_units(U256::from(v), 9);
        Ok((base > max).then(|| format!("base fee {} gwei > max {} gwei", gwei(base), gwei(max))))
    }

    async fn native_balance(&self, who: Address) -> Result<U256> {
        Ok(self.tx.provider.get_balance(who).await?)
    }

    async fn collect(&mut self, s: &Settings<Self>) -> Result<Step<U256>> {
        let step = self.redeem_shares(s).await?;
        self.dry = self.dry + step;
        Ok(step)
    }

    async fn convert(&mut self, s: &Settings<Self>) -> Result<Step<U256>> {
        let swapped = self.swap_tokens(s).await?;
        // An item like the rest: a failed unwrap must not hold back the send of what the swaps
        // already brought in.
        let unwrapped = match self.unwrap_native(s).await {
            Ok(step) => step,
            Err(e) => {
                self.fail("unwrap", &e);
                Step::default()
            }
        };
        Ok(swapped + unwrapped)
    }

    async fn prepare_transfer(&self, to: Address) -> Result<(u64, U256)> {
        // The recipient may be a 7702-delegated EOA or a contract: estimate, don't assume 21000.
        // 1 wei, or 0 while the wallet is still empty (a dry run projecting swap proceeds): the node
        // rejects a value the sender can't cover even in a simulation.
        let funded = !self.tx.provider.get_balance(self.tx.from).await?.is_zero();
        let probe = TransactionRequest::default().from(self.tx.from).to(to).value(U256::from(u8::from(funded)));
        let estimate = self.tx.provider.estimate_gas(probe).await.with_context(|| format!("estimate send to {to} failed"))?;
        let gas_limit = math::send_gas_limit(estimate);
        debug!("send to {to}: gas estimate {estimate} -> limit {gas_limit}");
        let max_fee = math::max_fee_per_gas(self.tx.base_fee().await?, self.tx.tip);
        Ok((gas_limit, math::transfer_reserve(gas_limit, max_fee)))
    }

    async fn transfer_cap(&self) -> Result<Option<(U256, String)>> {
        let Some(usd) = &self.opts.max_send_usd else { return Ok(None) };
        Ok(Some((self.usd_in_native(usd, "MAX_SEND_USD").await?, format!("MAX_SEND_USD {usd}"))))
    }

    async fn transfer_skip_reason(&self, gas_limit: &u64, amount: U256) -> Result<Option<String>> {
        let cost = math::expected_cost(*gas_limit, self.tx.base_fee().await?, self.tx.tip);
        let m = self.opts.min_gas_multiple;
        Ok((!math::worth_swapping(amount, cost, m))
            .then(|| format!("{} {} < {m}x send gas ~{}", fmt_units(amount, 18), self.chain.native_symbol, fmt_units(cost, 18))))
    }

    async fn transfer(&mut self, gas_limit: u64, to: Address, amount: U256) -> Result<()> {
        let send = TransactionRequest::default().to(to).value(amount).gas_limit(gas_limit);
        self.tx.send(send, "native send").await?;
        Ok(())
    }

    fn take_failures(&mut self) -> Vec<String> {
        std::mem::take(&mut self.failures)
    }

    async fn summary(&self) -> Result<String> {
        let (p, from) = (&self.tx.provider, self.tx.from);
        let latest = p.get_transaction_count(from).latest().await?;
        let pending = p.get_transaction_count(from).pending().await?;
        Ok(format!("fee wallet nonce latest={latest} pending={pending}"))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use clap::Parser;

    use super::*;
    use crate::config::tests::MapEnv;

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        evm: EvmArgs,
    }

    fn args(extra: &[&str]) -> EvmArgs {
        Cli::parse_from([&["funder"], extra].concat()).evm
    }

    fn common<'a>(cfg: &'a RelayerConfig, recipient: Option<&'a str>) -> Common<'a> {
        Common { config: cfg, config_path: Path::new("x"), recipient, send: false, only: None }
    }

    const A: &str = "0x000000000000000000000000000000000000000A";
    const B: &str = "0x000000000000000000000000000000000000000b";

    #[test]
    fn per_chain_overrides_beat_globals() {
        let cfg = RelayerConfig::parse(r#"{"chains":{}}"#).unwrap();
        let a = args(&["--keep-wei", "5", "--max-base-fee-gwei", "2"]);
        let env =
            MapEnv::of(&[("RECIPIENT_EVM_56", B), ("KEEP_WEI_EVM_56", "7"), ("MAX_BASE_FEE_GWEI_EVM_56", "0.5"), ("MIN_GAS_MULTIPLE_EVM_56", "10")]);

        let main = overrides(&env, 1, &common(&cfg, Some(A)), &a).unwrap();
        assert_eq!(
            main,
            ChainOverrides {
                recipient: A.parse().unwrap(),
                keep: U256::from(5),
                max_base_fee: Some(2_000_000_000),
                min_gas_multiple: 5,
                max_send_usd: None,
                min_recipient_usd: None
            }
        );
        let bsc = overrides(&env, 56, &common(&cfg, Some(A)), &a).unwrap();
        assert_eq!(
            bsc,
            ChainOverrides {
                recipient: B.parse().unwrap(),
                keep: U256::from(7),
                max_base_fee: Some(500_000_000),
                min_gas_multiple: 10,
                max_send_usd: None,
                min_recipient_usd: None
            }
        );
        let bad = MapEnv::of(&[("MIN_GAS_MULTIPLE_EVM_1", "5x")]);
        assert!(overrides(&bad, 1, &common(&cfg, Some(A)), &a).is_err());
        // Default ceiling is 5 gwei; `none` disables it.
        assert_eq!(overrides(&env, 1, &common(&cfg, Some(A)), &args(&[])).unwrap().max_base_fee, Some(5_000_000_000));
        assert_eq!(overrides(&env, 1, &common(&cfg, Some(A)), &args(&["--max-base-fee-gwei", "none"])).unwrap().max_base_fee, None);
    }

    #[test]
    fn max_send_usd_global_per_chain_and_validation() {
        let cfg = RelayerConfig::parse(r#"{"chains":{}}"#).unwrap();
        let usd =
            |env: &[(&str, &str)], extra: &[&str]| overrides(&MapEnv::of(env), 56, &common(&cfg, Some(A)), &args(extra)).map(|o| o.max_send_usd);
        assert_eq!(usd(&[], &[]).unwrap(), None); // no default cap
        assert_eq!(usd(&[], &["--max-send-usd", "100"]).unwrap().as_deref(), Some("100"));
        assert_eq!(usd(&[("MAX_SEND_USD_EVM_56", "2.5")], &["--max-send-usd", "100"]).unwrap().as_deref(), Some("2.5"));
        // `none` per chain lifts a global cap.
        assert_eq!(usd(&[("MAX_SEND_USD_EVM_56", "none")], &["--max-send-usd", "100"]).unwrap(), None);
        for bad in ["0", "-5", "abc", "1e3"] {
            let e = format!("{:#}", usd(&[("MAX_SEND_USD_EVM_56", bad)], &[]).unwrap_err());
            assert!(e.contains("MAX_SEND_USD_EVM_56"), "{bad}: {e}");
        }
    }

    #[test]
    fn min_recipient_balance_usd_global_per_chain_and_validation() {
        let cfg = RelayerConfig::parse(r#"{"chains":{}}"#).unwrap();
        let usd =
            |env: &[(&str, &str)], extra: &[&str]| overrides(&MapEnv::of(env), 56, &common(&cfg, Some(A)), &args(extra)).map(|o| o.min_recipient_usd);
        assert_eq!(usd(&[], &[]).unwrap(), None); // no floor: always sweep
        assert_eq!(usd(&[], &["--min-recipient-balance-usd", "20"]).unwrap().as_deref(), Some("20"));
        assert_eq!(usd(&[("MIN_RECIPIENT_BALANCE_USD_EVM_56", "5")], &["--min-recipient-balance-usd", "20"]).unwrap().as_deref(), Some("5"));
        assert_eq!(usd(&[("MIN_RECIPIENT_BALANCE_USD_EVM_56", "none")], &["--min-recipient-balance-usd", "20"]).unwrap(), None);
        let e = format!("{:#}", usd(&[("MIN_RECIPIENT_BALANCE_USD_EVM_56", "-1")], &[]).unwrap_err());
        assert!(e.contains("MIN_RECIPIENT_BALANCE_USD_EVM_56"), "{e}");
    }

    #[test]
    fn override_errors_name_the_variable() {
        let cfg = RelayerConfig::parse(r#"{"chains":{}}"#).unwrap();
        let err = |env: MapEnv, recipient: Option<&str>| format!("{:#}", overrides(&env, 1, &common(&cfg, recipient), &args(&[])).unwrap_err());
        assert!(err(MapEnv::of(&[]), None).contains("RECIPIENT_EVM_1 or RECIPIENT"));
        assert!(err(MapEnv::of(&[]), Some("GABC")).contains("not an EVM address"));
        assert!(err(MapEnv::of(&[("RECIPIENT_EVM_1", "0x0000000000000000000000000000000000000000")]), Some(A)).contains("zero address"));
        assert!(err(MapEnv::of(&[("KEEP_WEI_EVM_1", "0.01")]), Some(A)).contains("KEEP_WEI_EVM_1"));
        assert!(err(MapEnv::of(&[("MAX_BASE_FEE_GWEI_EVM_1", "-1")]), Some(A)).contains("MAX_BASE_FEE_GWEI_EVM_1"));
        assert!(err(MapEnv::of(&[("MAX_BASE_FEE_GWEI_EVM_1", "abc")]), Some(A)).contains("MAX_BASE_FEE_GWEI_EVM_1"));
        // One wrong character in a checksummed address is caught (…cafE -> …cAfE).
        let typo = "0x000000000000000000000000000000000000cAfE";
        assert!(err(MapEnv::of(&[]), Some(typo)).contains("checksum"));
        // All-lowercase / all-uppercase carry no checksum and are accepted.
        overrides(&MapEnv::of(&[]), 1, &common(&cfg, Some("0x000000000000000000000000000000000000cafe")), &args(&[])).unwrap();
    }

    #[test]
    fn private_key_errors_never_echo_the_key() {
        let bad = "0xabababababababababababababababababababababababababababababababZZ";
        let e = format!("{:#}", parse_private_key(bad).unwrap_err());
        assert!(!e.contains("abab") && e.contains("PRIVATE_KEY"), "{e}");
        // A trailing newline (echo | gcloud secrets) is tolerated.
        let k = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80\n";
        assert_eq!(parse_private_key(k).unwrap().address(), alloy::primitives::address!("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));
    }

    #[test]
    fn sweepable_splits_by_dex_entry() {
        let cfg = RelayerConfig::parse(crate::config::tests::FIXTURE).unwrap();
        assert_eq!(sweepable(&cfg), (vec![1, 56], vec![]));
        let json = crate::config::tests::FIXTURE.replacen(r#""id": 1,"#, r#""id": 4114,"#, 1);
        let (ok, skipped) = sweepable(&RelayerConfig::parse(&json).unwrap());
        assert_eq!(ok, vec![56]);
        assert_eq!(skipped[0].0, 4114);
    }
}
