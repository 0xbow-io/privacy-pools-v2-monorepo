//! Sends the sweep's transactions one at a time at nonces it assigns itself.
//!
//! The fee wallet is meant to be dedicated (nothing else signs for it), but if it is ever pointed
//! at a shared key — e.g. the relayer signer — a nonce collision is NOT benign: a higher-fee tx
//! from here can replace a pending relay tx. So we refuse to start with in-flight txs and re-check
//! `pending == ours` before every send.
//!
//! RPCs behind load balancers lag: a `pending` count one behind ours right after our own receipt
//! is treated as lag and re-read, never as permission to reuse a nonce; only a count *ahead* of
//! ours means another writer.
//!
//! With a local key the tx is signed here, so its hash is known before the broadcast. A broadcast
//! that errors (e.g. the request timed out after the node took it, and the retried resend came
//! back "already known" / "nonce too low") is then settled by asking the node for that hash, not
//! by the error: a tx the node has is waited on like any other.

use std::time::Duration;

use alloy::{
    eips::{BlockNumberOrTag, eip2718::Encodable2718},
    network::{EthereumWallet, TransactionBuilder},
    primitives::{Address, B256, U256},
    providers::{DynProvider, Provider},
    rpc::types::{TransactionReceipt, TransactionRequest},
};
use anyhow::{Context, Result, bail, ensure};
use tracing::{debug, info, warn};

use crate::evm::{
    fmt_units,
    math::{call_gas_limit, max_fee_per_gas},
};

const RECEIPT_TIMEOUT: Duration = Duration::from_secs(300);
const RECEIPT_POLL: Duration = Duration::from_secs(3);
/// Re-reads of a lagging `pending` count before giving up.
const LAG_RETRIES: u32 = 5;
const LAG_PAUSE: Duration = Duration::from_secs(2);

pub struct Sender {
    pub provider: DynProvider,
    pub from: Address,
    pub tip: u128,
    /// Signs locally (`None`: the node signs, anvil's unlocked accounts in tests).
    wallet: Option<EthereumWallet>,
    chain_id: u64,
    nonce: u64,
}

impl Sender {
    pub async fn new(provider: DynProvider, from: Address, tip: u128, wallet: Option<EthereumWallet>, chain_id: u64) -> Result<Self> {
        let mut last = (0, 0);
        for _ in 0..=LAG_RETRIES {
            let latest = provider.get_transaction_count(from).latest().await?;
            let pending = provider.get_transaction_count(from).pending().await?;
            debug!("nonce for {from}: latest={latest} pending={pending}");
            if latest == pending {
                return Ok(Self { provider, from, tip, wallet, chain_id, nonce: latest });
            }
            last = (latest, pending);
            tokio::time::sleep(LAG_PAUSE).await;
        }
        bail!("fee wallet has in-flight txs (latest={} pending={}); wait for them to land", last.0, last.1)
    }

    pub fn nonce(&self) -> u64 {
        self.nonce
    }

    pub async fn base_fee(&self) -> Result<u128> {
        let block = self.provider.get_block_by_number(BlockNumberOrTag::Latest).await?.context("latest block not found")?;
        Ok(block.header.base_fee_per_gas.context("chain has no base fee (pre-London?)")? as u128)
    }

    /// `pending` must equal our next nonce: behind = RPC lag (re-read), ahead = another writer.
    async fn check_nonce(&self) -> Result<()> {
        for _ in 0..=LAG_RETRIES {
            let pending = self.provider.get_transaction_count(self.from).pending().await?;
            if pending == self.nonce {
                return Ok(());
            }
            debug!("pending nonce {pending} behind ours {}: RPC lag, re-reading", self.nonce);
            ensure!(pending < self.nonce, "nonce moved under us (expected {}, pending={pending}): another writer is active", self.nonce);
            tokio::time::sleep(LAG_PAUSE).await;
        }
        bail!("RPC still reports pending nonce below {} after retries (lagging node?)", self.nonce)
    }

    /// Polls for the receipt by hash until the deadline; RPC errors along the way are retried
    /// (a single failed poll must not turn a mined tx into a failed run).
    async fn wait_receipt(&self, hash: B256, what: &str) -> Result<TransactionReceipt> {
        let deadline = tokio::time::Instant::now() + RECEIPT_TIMEOUT;
        let mut polls = 0u32;
        loop {
            polls += 1;
            match self.provider.get_transaction_receipt(hash).await {
                Ok(Some(r)) => return Ok(r),
                // Every ~30s, so a slow inclusion is visible without a line per poll.
                Ok(None) if polls.is_multiple_of(10) => {
                    debug!("    {what}: {hash} still pending after {polls} polls")
                }
                Ok(None) => {}
                Err(e) => warn!("    receipt poll for {hash} failed, retrying: {}", crate::redact::error(&e.into())),
            }
            if tokio::time::Instant::now() >= deadline {
                bail!("no receipt for {hash} after {}s: {what} (still pending; the next run waits for it)", RECEIPT_TIMEOUT.as_secs());
            }
            tokio::time::sleep(RECEIPT_POLL).await;
        }
    }

    /// Signs (or, for an unlocked anvil account, asks the node to send) `tx` at our next nonce and
    /// waits for the receipt. Errors on a moved nonce, a balance that can't cover
    /// `gas_limit × maxFee + value` (the node's own upfront check), a send failure, or a mined
    /// revert.
    pub async fn send(&mut self, tx: TransactionRequest, what: &str) -> Result<TransactionReceipt> {
        self.check_nonce().await?;
        let base = self.base_fee().await?;
        let max_fee = max_fee_per_gas(base, self.tip);
        debug!(
            "    {what}: nonce={} base_fee={}gwei max_fee={}gwei tip={}wei",
            self.nonce,
            fmt_units(U256::from(base), 9),
            fmt_units(U256::from(max_fee), 9),
            self.tip
        );
        let mut tx = tx.from(self.from).nonce(self.nonce);
        // Our own headroom instead of the provider's bare estimate (see `call_gas_limit`).
        // Estimated before the fee fields are set: with them, a short balance makes the node fail
        // the estimate itself instead of reaching the clear check below.
        if tx.gas.is_none() {
            let estimate = self.provider.estimate_gas(tx.clone()).await.with_context(|| format!("estimate gas: {what}"))?;
            tx = tx.gas_limit(call_gas_limit(estimate));
            debug!("    {what}: gas estimate {estimate} -> limit {}", call_gas_limit(estimate));
        }
        let tx = tx.max_priority_fee_per_gas(self.tip).max_fee_per_gas(max_fee);
        let gas_limit = tx.gas.unwrap_or_default();
        let upfront = U256::from(gas_limit) * U256::from(max_fee) + tx.value.unwrap_or_default();
        let balance = self.provider.get_balance(self.from).await?;
        debug!(
            "    {what}: upfront {} (to={:?} value={}) wallet {}",
            fmt_units(upfront, 18),
            tx.to.and_then(|k| k.to().copied()),
            tx.value.unwrap_or_default(),
            fmt_units(balance, 18)
        );
        ensure!(
            balance >= upfront,
            "fee wallet can't cover {what}: needs {} (gas limit {gas_limit} x max fee {} gwei) but holds {} (raise KEEP_WEI or set MAX_BASE_FEE_GWEI)",
            fmt_units(upfront, 18),
            fmt_units(U256::from(max_fee), 9),
            fmt_units(balance, 18)
        );
        let hash = self.broadcast(tx, what).await?;
        debug!("    {what}: submitted {hash} at nonce {}", self.nonce);
        let receipt = self.wait_receipt(hash, what).await?;
        // Mined, reverted or not: the nonce is used either way (a fallback tx must take the next).
        self.nonce += 1;
        info!(
            "    tx {} status={} gas={}/{}",
            receipt.transaction_hash,
            if receipt.status() { "ok" } else { "REVERTED" },
            receipt.gas_used,
            gas_limit
        );
        ensure!(receipt.status(), "tx reverted: {what}");
        Ok(receipt)
    }

    /// Broadcasts `tx` and returns its hash. Signed locally when we hold the key; then a failed
    /// broadcast whose tx the node nonetheless has (`eth_getTransactionByHash`) counts as sent.
    async fn broadcast(&self, tx: TransactionRequest, what: &str) -> Result<B256> {
        let Some(wallet) = &self.wallet else {
            return Ok(*self.provider.send_transaction(tx).await.with_context(|| format!("send failed: {what}"))?.tx_hash());
        };
        let signed = tx.with_chain_id(self.chain_id).build(wallet).await.with_context(|| format!("sign: {what}"))?;
        let hash = *signed.tx_hash();
        let err = match self.provider.send_raw_transaction(&signed.encoded_2718()).await {
            Ok(_) => return Ok(hash),
            Err(e) => anyhow::Error::from(e),
        };
        let reason = crate::redact::error(&err);
        if self.node_has(hash).await {
            warn!("    {what}: broadcast reported an error ({reason}) but the node has {hash}; waiting on it");
            return Ok(hash);
        }
        Err(err.context(format!("send failed: {what} ({hash} not known to the node)")))
    }

    /// Whether the node knows `hash`, pending or mined. Re-read a few times: a load-balanced RPC
    /// can answer from a backend that hasn't seen the tx yet.
    async fn node_has(&self, hash: B256) -> bool {
        for _ in 0..=LAG_RETRIES {
            if matches!(self.provider.get_transaction_by_hash(hash).await, Ok(Some(_))) {
                return true;
            }
            if matches!(self.provider.get_transaction_receipt(hash).await, Ok(Some(_))) {
                return true;
            }
            tokio::time::sleep(LAG_PAUSE).await;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use alloy::{node_bindings::Anvil, providers::ProviderBuilder, signers::local::PrivateKeySigner};

    use super::*;

    /// The node took the tx but our request errored (timeout): the retried resend is refused,
    /// yet the sender must wait on the tx and advance its nonce, not fail the step.
    #[tokio::test]
    #[ignore = "needs anvil on PATH"]
    async fn broadcast_the_node_already_has_counts_as_sent() {
        let anvil = Anvil::new().try_spawn().expect("spawn anvil");
        let key: PrivateKeySigner = anvil.keys()[0].clone().into();
        let from = key.address();
        let wallet = EthereumWallet::from(key);
        let provider = ProviderBuilder::new().connect_http(anvil.endpoint_url()).erased();
        let mut sender = Sender::new(provider.clone(), from, 1, Some(wallet.clone()), anvil.chain_id()).await.unwrap();

        let tx = TransactionRequest::default().to(anvil.addresses()[1]).value(U256::from(7));
        // What the first, timed-out attempt delivered: the very tx `send` will sign (same fields,
        // deterministic signature), already mined by the time we "resend".
        let base = sender.base_fee().await.unwrap();
        let landed = tx
            .clone()
            .from(from)
            .nonce(0)
            .gas_limit(call_gas_limit(21_000))
            .max_priority_fee_per_gas(1)
            .max_fee_per_gas(max_fee_per_gas(base, 1))
            .with_chain_id(anvil.chain_id())
            .build(&wallet)
            .await
            .unwrap();
        provider.send_raw_transaction(&landed.encoded_2718()).await.unwrap().get_receipt().await.unwrap();

        let hash = sender.broadcast(
            tx.from(from).nonce(0).gas_limit(call_gas_limit(21_000)).max_priority_fee_per_gas(1).max_fee_per_gas(max_fee_per_gas(base, 1)),
            "resend",
        );
        assert_eq!(hash.await.unwrap(), *landed.tx_hash());

        // A tx the node never saw still fails: a wrong-nonce one is refused and unknown.
        sender.nonce = 1;
        let stale = TransactionRequest::default()
            .to(anvil.addresses()[1])
            .from(from)
            .nonce(0)
            .gas_limit(call_gas_limit(21_000))
            .max_priority_fee_per_gas(2)
            .max_fee_per_gas(max_fee_per_gas(base, 2));
        let err = sender.broadcast(stale, "stale").await.unwrap_err().to_string();
        assert!(err.contains("not known to the node"), "{err}");

        // And the normal path signs locally and lands.
        let receipt = sender.send(TransactionRequest::default().to(anvil.addresses()[1]).value(U256::from(1)), "plain").await.unwrap();
        assert!(receipt.status());
        assert_eq!(sender.nonce(), 2);
    }
}
