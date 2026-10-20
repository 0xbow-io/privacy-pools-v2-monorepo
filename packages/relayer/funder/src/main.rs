//! funder: sweep a relayer fee-receiver wallet into native gas and send it to a recipient, on
//! every chain in one run. Rust port of `v2-monorepo/packages/relayer/relayer/scripts/sweep-fees.sh`.
//!
//! `pipeline` is chain-neutral; each chain family (`evm`, later `stellar`) implements its
//! `Family` trait behind a cargo feature. `main` picks the chains from `CHAINS`, sweeps them
//! concurrently (independent RPCs and nonces), and fails the run if any chain failed.

// A build with no family enabled only parses config and CLI.
#![cfg_attr(not(feature = "evm"), allow(dead_code, unused))]

mod config;
#[cfg(feature = "evm")]
mod evm;
mod pipeline;
mod redact;

use std::{path::PathBuf, process::ExitCode, time::Duration};

use anyhow::{Result, bail};
use clap::{ArgAction, Parser, ValueEnum, builder::BoolishValueParser};
use futures_util::future::join_all;
use tracing::{Instrument, debug, error, info, info_span, warn};
use tracing_subscriber::{EnvFilter, prelude::*};

use crate::config::{ChainRef, ChainSelection, RelayerConfig};

/// Sweep fee-receiver wallets: redeem PP shares, swap fee assets to native, and send native to
/// the recipient, on every selected chain. Dry run unless DRY_RUN=false.
// No `Debug`: the flattened EVM args hold the private key.
#[derive(Parser)]
#[command(version)]
struct Args {
    /// The relayer's config JSON (same file and schema the relayer reads). Chains, assets, RPC and
    /// fee receiver come from here, with the relayer's `<NAME>_<FAMILY>_<id>` env overrides applied
    /// (`RPC_URL_EVM_1`, `FEE_RECEIVER_ADDRESS_EVM_1`, ...).
    #[arg(long, env = "CONFIG_PATH")]
    config: PathBuf,

    /// `all` (every chain in the config funder can sweep) or a comma list like `evm:1,evm:56`.
    #[arg(long, env = "CHAINS", default_value = "all")]
    chains: ChainSelection,

    /// Where the native proceeds go, in each chain's address format; override per chain with
    /// RECIPIENT_<FAMILY>_<id> (e.g. RECIPIENT_EVM_56). Pass the fee wallet to keep them there.
    #[arg(long, env = "RECIPIENT")]
    recipient: Option<String>,

    /// Read and print the plan only, broadcast nothing (the default). `false` executes: redeems,
    /// swaps, unwraps and the send. Accepts true/false, 1/0, yes/no.
    #[arg(long, env = "DRY_RUN", default_value = "true", action = ArgAction::Set, value_parser = BoolishValueParser::new())]
    dry_run: bool,

    /// Comma list of share tickers to redeem, e.g. ppUSDC,ppUSDT (default: all).
    #[arg(long, env = "ONLY", value_delimiter = ',')]
    only: Option<Vec<String>>,

    /// `text` for terminals, `json` for Cloud Logging (severity + chain on every line).
    #[arg(long, env = "LOG_FORMAT", value_enum, default_value_t = LogFormat::Text)]
    log_format: LogFormat,

    /// A chain still running after this many seconds is reported failed (so one hung RPC can't
    /// eat the job's whole timeout and lose every chain's summary).
    #[arg(long, env = "CHAIN_TIMEOUT_SECS", default_value_t = 45 * 60)]
    chain_timeout_secs: u64,

    #[cfg(feature = "evm")]
    #[command(flatten)]
    evm: evm::EvmArgs,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum LogFormat {
    Text,
    Json,
}

/// `RUST_LOG` (default: funder at `debug`, everything else at `info`), with HTTP/RPC client crates
/// capped at `warn` whatever it says: their debug spans and events carry the full RPC URL, i.e. the
/// provider API key. funder's own debug lines never carry secrets (URLs go through `redact`).
fn log_filter() -> EnvFilter {
    let mut f = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,funder=debug"));
    for noisy in ["alloy", "alloy_transport_http", "alloy_rpc_client", "alloy_provider", "hyper", "hyper_util", "reqwest", "rustls", "h2", "tower"] {
        if let Ok(d) = format!("{noisy}=warn").parse() {
            f = f.add_directive(d);
        }
    }
    f
}

fn init_logging(format: LogFormat) {
    match format {
        LogFormat::Text => tracing_subscriber::fmt().with_env_filter(log_filter()).without_time().with_target(false).with_level(false).init(),
        LogFormat::Json => tracing_subscriber::registry().with(log_filter()).with(tracing_stackdriver::layer()).init(),
    }
}

/// One chain's result for the closing summary.
enum ChainResult {
    Done(String),
    Skipped(String),
    Failed(anyhow::Error),
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();
    init_logging(args.log_format);
    // Every error leaves through the logger (JSON severity, redacted), never as a raw stderr dump.
    match run(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("{}", redact::error(&e));
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Args) -> Result<()> {
    // SEND was replaced by DRY_RUN; a leftover SEND=1 must not quietly become a daily dry run.
    if std::env::var_os("SEND").is_some() {
        bail!("SEND was replaced by DRY_RUN: remove SEND and set DRY_RUN=false to execute (DRY_RUN=true or unset = dry run)");
    }
    debug!("funder {} loading config {}", env!("CARGO_PKG_VERSION"), args.config.display());
    let config = RelayerConfig::load(&args.config)?;
    #[cfg(feature = "evm")]
    debug!("config has {} EVM chain(s): {:?}", config.chains.evm.len(), config.chains.evm.iter().map(|c| c.id).collect::<Vec<_>>());

    // Resolve the selection; `all` skips chains no family can sweep instead of failing on them.
    let mut results: Vec<(ChainRef, ChainResult)> = Vec::new();
    let targets: Vec<ChainRef> = match &args.chains {
        ChainSelection::List(list) => list.clone(),
        ChainSelection::All => {
            #[cfg(feature = "evm")]
            {
                let (ok, skipped) = evm::sweepable(&config);
                for (id, why) in skipped {
                    warn!("evm:{id}: skipped: {why}");
                    results.push((ChainRef::Evm(id), ChainResult::Skipped(why)));
                }
                ok.into_iter().map(ChainRef::Evm).collect()
            }
            #[cfg(not(feature = "evm"))]
            Vec::new()
        }
    };
    if targets.is_empty() {
        bail!("no chain to sweep (CHAINS={:?})", args.chains);
    }

    // Load the EVM signer once (one keystore prompt), only if an EVM chain is selected.
    #[cfg(feature = "evm")]
    let evm_signer = match targets.iter().any(|c| matches!(c, ChainRef::Evm(_))) {
        true => Some(evm::EvmSigner::load(&args.evm)?),
        false => None,
    };

    let common = pipeline::Common {
        config: &config,
        config_path: &args.config,
        recipient: args.recipient.as_deref(),
        send: !args.dry_run,
        only: args.only.as_deref(),
    };
    let chains = targets.iter().map(ToString::to_string).collect::<Vec<_>>().join(",");
    if !args.dry_run {
        info!("sweeping {chains} for real (DRY_RUN=false)");
    } else {
        // Loud on purpose: a job left in dry-run mode would otherwise "succeed" every day doing nothing.
        warn!("sweeping {chains} in DRY-RUN mode: nothing will be broadcast (set DRY_RUN=false to execute)");
    }
    let chain_timeout = Duration::from_secs(args.chain_timeout_secs);

    let runs = targets.iter().map(|chain| {
        let common = &common;
        #[cfg(feature = "evm")]
        let (evm_args, evm_signer) = (&args.evm, evm_signer.as_ref());
        let span = info_span!("chain", chain = %chain);
        async move {
            let started = std::time::Instant::now();
            let sweep = async {
                match chain {
                    #[cfg(feature = "evm")]
                    ChainRef::Evm(id) => {
                        let signer = evm_signer.ok_or_else(|| anyhow::anyhow!("EVM signer not loaded"))?;
                        let (family, settings) = evm::Evm::connect(*id, common, evm_args, signer).await?;
                        pipeline::run(family, settings).await
                    }
                    #[cfg(not(feature = "evm"))]
                    ChainRef::Evm(_) => Err(anyhow::anyhow!("built without the `evm` feature")),
                    ChainRef::Stellar(_) => Err(anyhow::anyhow!("the Stellar family is not implemented yet")),
                }
            };
            let res: Result<pipeline::Report> = match tokio::time::timeout(chain_timeout, sweep).await {
                Ok(r) => r,
                Err(_) => Err(anyhow::anyhow!("timed out after {}s (CHAIN_TIMEOUT_SECS); the next run resumes", chain_timeout.as_secs())),
            };
            debug!("chain finished in {}s", started.elapsed().as_secs());
            let res = match res {
                Ok(pipeline::Report::Done(line)) => ChainResult::Done(line),
                Ok(pipeline::Report::Skipped(why)) => ChainResult::Skipped(why),
                Err(e) => {
                    error!("FAILED: {}", redact::error(&e));
                    ChainResult::Failed(e)
                }
            };
            (chain.clone(), res)
        }
        .instrument(span)
    });
    results.extend(join_all(runs).await);

    let mut failed = 0;
    for (chain, res) in &results {
        match res {
            ChainResult::Done(line) => info!("summary {chain}: ok, {line}"),
            // WARN, so a chain that is skipped every day (gas ceiling, no DEX entry) stays visible.
            ChainResult::Skipped(why) => warn!("summary {chain}: skipped, {why}"),
            ChainResult::Failed(e) => {
                failed += 1;
                error!("summary {chain}: FAILED, {}", redact::error(e));
            }
        }
    }
    if failed > 0 {
        bail!("{failed} of {} chains failed", results.len());
    }
    Ok(())
}
