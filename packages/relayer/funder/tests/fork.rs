//! Black-box fork tests: each spawns its own anvil fork and runs the real `funder` binary against
//! it, impersonating the fee wallet. Ignored by default (need an archive-capable RPC):
//!
//!   FORK_RPC_URL_1=... FORK_RPC_URL_56=... cargo test --test fork -- --ignored
//!
//! With `FUNDER_IMAGE=<docker image>` every funder run goes through `docker run` instead (same
//! tests against the shipped container).
//!
//! Each `Fork::run` selects its own chain (`CHAINS=evm:<id>`); the multichain tests set `CHAINS`
//! themselves.
//!
//! Config comes from `tests/fixtures/relayer.config.json` (prod-shaped, incl. `zap` /
//! `relay_swaps_contract` fields funder ignores: shares are redeemed directly and their aTokens
//! withdrawn from Aave). RPC and fee receiver are set through the relayer's own
//! `RPC_URL_EVM_<id>` / `FEE_RECEIVER_ADDRESS_EVM_<id>`.
//!
//! The fee wallet is a plain address (`FEE`) that each test seeds on its own fork with the fee assets
//! it needs: real pp shares (underlying supplied to the share's Aave pool, aTokens deposited into the
//! vault, exactly what the zap does), loose stables from whales and WETH. Nothing depends on what any
//! live wallet happens to hold. The prod relayer signer is only used as a RECIPIENT, because it is a
//! 7702-delegated EOA.

use std::process::{Command, Output};

use alloy::{
    node_bindings::{Anvil, AnvilInstance},
    primitives::{Address, U256, address},
    providers::{DynProvider, Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
    sol,
};

sol! {
    #[sol(rpc)]
    interface IERC20 {
        function balanceOf(address owner) external view returns (uint256);
        function transfer(address to, uint256 amount) external returns (bool);
        function approve(address spender, uint256 amount) external returns (bool);
    }
    #[sol(rpc)]
    interface IAllowance {
        function allowance(address owner, address spender) external view returns (uint256);
    }
    #[sol(rpc)]
    interface IVault {
        function asset() external view returns (address);
        function deposit(uint256 assets, address receiver) external returns (uint256);
        function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
    }
    #[sol(rpc)]
    interface IAToken {
        function POOL() external view returns (address);
        function UNDERLYING_ASSET_ADDRESS() external view returns (address);
    }
    #[sol(rpc)]
    interface IAavePool {
        function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    }
    #[sol(rpc)]
    interface IWETH {
        function deposit() external payable;
    }
    #[sol(rpc)]
    interface IZap {
        function depositUnderlying(uint256 amount, address receiver) external returns (uint256);
    }
}

/// Prod relayer signer: a 7702-delegated EOA, used only as a realistic recipient.
const RELAYER_SIGNER: Address = address!("0x9e2f1B234953F46c6091636290E9035618EA3C07");
/// The fee wallet most tests sweep; seeded per test (`seed_mainnet_fees` / `seed_bsc_fees`).
const FEE: Address = address!("0x000000000000000000000000000000000000Fee5");
const BEEF: Address = address!("0x000000000000000000000000000000000000bEEF");
const CAFE: Address = address!("0x000000000000000000000000000000000000cafE");
const KEEP: u128 = 5_000_000_000_000_000; // funder's KEEP_WEI default

// mainnet
const USDC: Address = address!("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const USDT: Address = address!("0xdAC17F958D2ee523a2206206994597C13D831ec7");
const WETH: Address = address!("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
const PPETH: Address = address!("0x66051920D25af4E3596A8a46309F4D045F9D83B7");
const PPUSDC: Address = address!("0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6");
const PPUSDT: Address = address!("0xA4cF419558Ef36CC6FfB666195684dC963910426");
const A_ETH_WETH: Address = address!("0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8");
const A_ETH_USDC: Address = address!("0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c");
const A_ETH_USDT: Address = address!("0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a");
const LIFI_DIAMOND: Address = address!("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");
const ZAP_USDC: Address = address!("0x9Ea986BcDF6784D85B518b15bEEE1E65b585817B");
const UNI_ROUTER: Address = address!("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45");
const USDC_WHALE: Address = address!("0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341");
const USDT_WHALE: Address = address!("0xF977814e90dA44bFA03b6295A0616a897441aceC");
// bsc
const BSC_USDT: Address = address!("0x55d398326f99059fF775485246999027B3197955");
const WBNB: Address = address!("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const BSC_PPUSDT: Address = address!("0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2");
const A_BNB_USDT: Address = address!("0xa9251ca9DE909CB71783723713B21E4233fbf1B1");

// aTokens included: withdraw(max) must leave no dust, even though they accrue every block.
const MAINNET_FEE_ASSETS: [Address; 9] = [PPETH, PPUSDC, PPUSDT, A_ETH_WETH, A_ETH_USDC, A_ETH_USDT, USDC, USDT, WETH];
const BSC_FEE_ASSETS: [Address; 4] = [BSC_PPUSDT, A_BNB_USDT, BSC_USDT, WBNB];

struct Fork {
    _anvil: AnvilInstance,
    url: String,
    chain: u64,
    p: DynProvider,
}

async fn fork(chain: u64) -> Fork {
    let var = format!("FORK_RPC_URL_{chain}");
    let upstream = std::env::var(&var).unwrap_or_else(|_| panic!("set {var}"));
    let anvil = Anvil::new().fork(upstream).arg("--auto-impersonate").timeout(120_000).try_spawn().expect("spawn anvil");
    let url = anvil.endpoint();
    let p = ProviderBuilder::new().connect_http(url.parse().unwrap()).erased();
    let f = Fork { _anvil: anvil, url, chain, p };
    f.set_balance(BEEF, U256::from(10u128.pow(19))).await;
    f.set_balance(FEE, U256::from(10u128.pow(18))).await;
    f
}

impl Fork {
    /// Runs `funder` with `from` impersonated and configured as the fee receiver; `extra` are
    /// additional env vars (later entries win).
    fn run(&self, from: Address, extra: &[(&str, String)]) -> Output {
        let env = [self.base_env(from), vec![("UNLOCKED_FROM".into(), from.to_string())]].concat();
        exec_funder(env, extra, "funder")
    }

    /// Like `run`, but signing locally with a real private key (`PRIVATE_KEY`), as in production.
    fn run_signed(&self, key: &str, extra: &[(&str, String)]) -> Output {
        let from = key.parse::<alloy::signers::local::PrivateKeySigner>().unwrap().address();
        // Trailing newline, as `echo | gcloud secrets versions add` stores it.
        let env = [self.base_env(from), vec![("PRIVATE_KEY".into(), format!("{key}\n"))]].concat();
        exec_funder(env, extra, "funder (signed)")
    }

    fn base_env(&self, from: Address) -> Vec<(String, String)> {
        vec![
            ("CONFIG_PATH".into(), CONFIG.into()),
            ("CHAINS".into(), format!("evm:{}", self.chain)),
            (format!("RPC_URL_EVM_{}", self.chain), self.url.clone()),
            (format!("FEE_RECEIVER_ADDRESS_EVM_{}", self.chain), from.to_string()),
        ]
    }

    async fn set_balance(&self, who: Address, wei: U256) {
        let _: () = self.p.raw_request("anvil_setBalance".into(), (who, wei)).await.unwrap();
    }

    async fn eth(&self, who: Address) -> U256 {
        self.p.get_balance(who).await.unwrap()
    }

    async fn bal(&self, token: Address, who: Address) -> U256 {
        IERC20::new(token, self.p.clone()).balanceOf(who).call().await.unwrap()
    }

    async fn nonce(&self, who: Address) -> u64 {
        self.p.get_transaction_count(who).await.unwrap()
    }

    /// Sends `tx` from an impersonated account and waits for it. Gas is the estimate + 30%, like
    /// funder's own calls: a PP vault's fee-checkpoint write only happens once time has passed, so a
    /// bare estimate runs a deposit out of gas.
    async fn exec(&self, from: Address, tx: TransactionRequest) {
        self.set_balance(from, U256::from(10u128.pow(19))).await;
        let tx = tx.from(from);
        let gas = self.p.estimate_gas(tx.clone()).await.unwrap();
        let r = self.p.send_transaction(tx.gas_limit(gas * 13 / 10)).await.unwrap().get_receipt().await.unwrap();
        assert!(r.status(), "setup tx reverted");
    }

    /// `amount` of `underlying` turned into pp shares for `who`, the way the zap does it: supply to
    /// the share's Aave pool (found on-chain through its aToken), deposit the aTokens into the vault.
    /// `who` must already hold the underlying.
    async fn deposit_shares(&self, who: Address, vault: Address, amount: U256) {
        let a_token = IVault::new(vault, self.p.clone()).asset().call().await.unwrap();
        let at = IAToken::new(a_token, self.p.clone());
        let (pool, underlying) = (at.POOL().call().await.unwrap(), at.UNDERLYING_ASSET_ADDRESS().call().await.unwrap());
        self.exec(who, IERC20::new(underlying, self.p.clone()).approve(pool, amount).into_transaction_request()).await;
        let supply = IAavePool::new(pool, self.p.clone()).supply(underlying, amount, who, 0).into_transaction_request();
        self.exec(who, supply).await;
        let got = self.bal(a_token, who).await;
        self.exec(who, IERC20::new(a_token, self.p.clone()).approve(vault, got).into_transaction_request()).await;
        self.exec(who, IVault::new(vault, self.p.clone()).deposit(got, who).into_transaction_request()).await;
        assert!(!self.bal(vault, who).await.is_zero(), "no shares minted for {vault}");
    }

    /// A mainnet fee wallet like prod's: every pp share (ppETH, ppUSDC, ppUSDT), loose USDC/USDT and
    /// WETH, each well above the default dust gate, and 1 ETH for gas.
    async fn seed_mainnet_fees(&self, who: Address) {
        let (usdc, usdt) = (IERC20::new(USDC, self.p.clone()), IERC20::new(USDT, self.p.clone()));
        self.exec(USDC_WHALE, usdc.transfer(who, U256::from(300_000_000u64)).into_transaction_request()).await;
        self.exec(USDT_WHALE, usdt.transfer(who, U256::from(300_000_000u64)).into_transaction_request()).await;
        let weth = IWETH::new(WETH, self.p.clone()).deposit().value(U256::from(150_000_000_000_000_000u128)).into_transaction_request();
        self.exec(who, weth).await;
        self.deposit_shares(who, PPUSDC, U256::from(200_000_000u64)).await;
        self.deposit_shares(who, PPUSDT, U256::from(200_000_000u64)).await;
        self.deposit_shares(who, PPETH, U256::from(100_000_000_000_000_000u128)).await;
        self.set_balance(who, U256::from(10u128.pow(18))).await;
    }

    /// A BSC fee wallet: ppUSDT and loose USDT, 1 BNB for gas.
    async fn seed_bsc_fees(&self, who: Address) {
        let usdt = IERC20::new(BSC_USDT, self.p.clone());
        self.exec(USDT_WHALE, usdt.transfer(who, U256::from(200u128 * 10u128.pow(18))).into_transaction_request()).await;
        self.deposit_shares(who, BSC_PPUSDT, U256::from(100u128 * 10u128.pow(18))).await;
        self.set_balance(who, U256::from(10u128.pow(18))).await;
    }

    async fn drained(&self, who: Address, assets: &[Address]) -> bool {
        for &a in assets {
            if !self.bal(a, who).await.is_zero() {
                return false;
            }
        }
        true
    }
}

/// The fixture config, as the binary sees it (host path, or the read-only mount in the container).
const CONFIG: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/relayer.config.json");
const CONTAINER_CONFIG: &str = "/secrets/relayer.config.json";

/// Runs funder with exactly `env` + `extra` (later entries win). With `FUNDER_IMAGE` set, runs that
/// Docker image instead of the freshly built binary, the way the job will: `--network host` (anvil
/// listens on the host's loopback), config mounted read-only, text logs unless a test asks for JSON.
fn exec_funder(mut env: Vec<(String, String)>, extra: &[(&str, String)], label: &str) -> Output {
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.clone())));
    let out = match std::env::var("FUNDER_IMAGE").ok().filter(|i| !i.is_empty()) {
        None => Command::new(env!("CARGO_BIN_EXE_funder"))
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .envs(env)
            .output()
            .expect("run funder"),
        Some(image) => {
            let mut cmd = Command::new("docker");
            cmd.args(["run", "--rm", "--network", "host", "-v"]).arg(format!("{CONFIG}:{CONTAINER_CONFIG}:ro")).args(["-e", "LOG_FORMAT=text"]);
            for (k, v) in env {
                let v = if k == "CONFIG_PATH" && v == CONFIG { CONTAINER_CONFIG.to_string() } else { v };
                cmd.arg("-e").arg(format!("{k}={v}"));
            }
            cmd.arg(image).output().expect("docker run funder")
        }
    };
    eprintln!("--- {label} {:?}\n{}{}", extra, String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    out
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

/// The total ">=~X" the dry run projects for the recipient (swaps delivered + final send), in wei.
fn projected_wei(o: &Output) -> U256 {
    let s = stdout(o);
    let x = s.split("done; would send >=~ ").nth(1).expect("no projection line").split_whitespace().next().unwrap();
    alloy::primitives::utils::parse_ether(x).unwrap()
}

fn ok(o: &Output) {
    assert!(o.status.success(), "funder failed:\n{}{}", stdout(o), String::from_utf8_lossy(&o.stderr));
}

fn fails_with(o: &Output, needle: &str) {
    let all = format!("{}{}", stdout(o), String::from_utf8_lossy(&o.stderr));
    assert!(!o.status.success(), "expected failure containing {needle:?}");
    assert!(all.contains(needle), "expected {needle:?} in:\n{all}");
}

fn recipient(a: Address) -> (&'static str, String) {
    ("RECIPIENT", a.to_string())
}

fn send() -> (&'static str, String) {
    ("DRY_RUN", "false".into())
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_dry_run_then_sweep_then_noop() {
    let f = fork(1).await;
    f.seed_mainnet_fees(FEE).await;

    // Dry run: nothing changes, projection printed.
    let n0 = f.nonce(FEE).await;
    let dry = f.run(FEE, &[recipient(CAFE)]);
    ok(&dry);
    assert!(stdout(&dry).contains("redeem [ppETH,ppUSDC,ppUSDT], swap [USDC,USDT] via Uniswap V3"), "profile from config");
    assert_eq!(f.nonce(FEE).await, n0, "dry run sent txs");
    let projected = projected_wei(&dry);

    // Send: every fee asset drained, recipient gets >= projection (it is a lower bound).
    let c0 = f.eth(CAFE).await;
    let sent = f.run(FEE, &[recipient(CAFE), send()]);
    ok(&sent);
    assert!(stdout(&sent).contains("delivered"), "swaps should pay the recipient directly");
    assert!(f.drained(FEE, &MAINNET_FEE_ASSETS).await, "fee assets left");
    let got = f.eth(CAFE).await - c0;
    assert!(got >= projected && got <= projected * U256::from(110) / U256::from(100), "got {got}, projected {projected}");
    let left = f.eth(FEE).await;
    assert!(left >= U256::from(KEEP) && left < U256::from(KEEP + 10u128.pow(15)), "fee wallet left {left}");

    // Re-run: nothing to do, no txs.
    let n1 = f.nonce(FEE).await;
    let again = f.run(FEE, &[recipient(CAFE), send()]);
    ok(&again);
    assert_eq!(f.nonce(FEE).await, n1);
    assert!(stdout(&again).contains("nothing above keep"));
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_fresh_fee_wallet_to_7702_relayer_signer() {
    let f = fork(1).await;
    // Fee wallet with 1000 USDC (600 of it deposited into ppUSDC) + 250 USDT, and a stale
    // nonzero USDT router allowance (exercises the approve(0) reset).
    let usdc = IERC20::new(USDC, f.p.clone());
    let usdt = IERC20::new(USDT, f.p.clone());
    f.exec(USDC_WHALE, usdc.transfer(BEEF, U256::from(1_000_000_000u64)).into_transaction_request()).await;
    f.exec(USDT_WHALE, usdt.transfer(BEEF, U256::from(250_000_000u64)).into_transaction_request()).await;
    f.exec(BEEF, usdc.approve(ZAP_USDC, U256::from(600_000_000u64)).into_transaction_request()).await;
    let zap = IZap::new(ZAP_USDC, f.p.clone());
    f.exec(BEEF, zap.depositUnderlying(U256::from(600_000_000u64), BEEF).into_transaction_request()).await;
    f.exec(BEEF, usdt.approve(UNI_ROUTER, U256::from(7)).into_transaction_request()).await;
    assert!(!f.bal(PPUSDC, BEEF).await.is_zero());
    let code = f.p.get_code_at(RELAYER_SIGNER).await.unwrap();
    assert!(code.starts_with(&[0xef, 0x01, 0x00]), "relayer signer is no longer 7702-delegated");

    let r0 = f.eth(RELAYER_SIGNER).await;
    ok(&f.run(BEEF, &[recipient(RELAYER_SIGNER), send()]));
    assert!(f.drained(BEEF, &MAINNET_FEE_ASSETS).await);
    let got = f.eth(RELAYER_SIGNER).await - r0;
    // 10 ETH seed + ~0.3-0.5 ETH from 400 USDC + 250 USDT + 600 USDC of ppUSDC.
    assert!(got > U256::from(10_200_000_000_000_000_000u128), "signer topped up only {got}");
    assert!(f.eth(BEEF).await >= U256::from(KEEP));
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_resumes_from_parked_atokens() {
    let f = fork(1).await;
    f.seed_mainnet_fees(FEE).await;
    // A previous run redeemed ppUSDC and died before the Aave withdraw: shares gone, aTokens held.
    let shares = f.bal(PPUSDC, FEE).await;
    assert!(!shares.is_zero());
    let vault = IVault::new(PPUSDC, f.p.clone());
    f.exec(FEE, vault.redeem(shares, FEE, FEE).into_transaction_request()).await;
    assert!(f.bal(PPUSDC, FEE).await.is_zero() && !f.bal(A_ETH_USDC, FEE).await.is_zero());

    let dry = f.run(FEE, &[recipient(CAFE)]);
    ok(&dry);
    assert!(stdout(&dry).contains("aTokens already held"), "dry run must count parked aTokens");
    ok(&f.run(FEE, &[recipient(CAFE), send()]));
    assert!(f.drained(FEE, &MAINNET_FEE_ASSETS).await, "parked aTokens not withdrawn");
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_keep_mode_and_custom_keep() {
    let f = fork(1).await;
    f.seed_mainnet_fees(FEE).await;
    // RECIPIENT == fee wallet: convert everything, send nothing.
    let n0 = f.nonce(FEE).await;
    let keep = f.run(FEE, &[recipient(FEE), send()]);
    ok(&keep);
    assert!(stdout(&keep).contains("recipient is the fee wallet"));
    assert!(f.drained(FEE, &MAINNET_FEE_ASSETS).await);
    assert!(f.nonce(FEE).await > n0);

    // Then forward with a custom 0.01 ETH reserve.
    let k = 10u128.pow(16);
    ok(&f.run(FEE, &[recipient(CAFE), send(), ("KEEP_WEI", k.to_string())]));
    let left = f.eth(FEE).await;
    assert!(left >= U256::from(k) && left < U256::from(k + 10u128.pow(15)), "left {left}");
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_dust_gate_leaves_positions_worth_less_than_gas() {
    // Redeems and swaps share the gate: nothing worth < MIN_GAS_MULTIPLE x its gas is touched.
    let f = fork(1).await;
    f.seed_mainnet_fees(FEE).await;
    let pp0 = f.bal(PPUSDC, FEE).await;
    let n0 = f.nonce(FEE).await;
    let out = f.run(FEE, &[recipient(FEE), send(), ("MIN_GAS_MULTIPLE", "100000000".into())]);
    ok(&out);
    assert!(stdout(&out).contains("ppUSDC: skipped, worth"), "{}", stdout(&out));
    assert_eq!(f.bal(PPUSDC, FEE).await, pp0, "ppUSDC should be left alone");
    assert_eq!(f.nonce(FEE).await, n0, "nothing worth its gas: no txs");
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_guards() {
    let f = fork(1).await;
    let cafe = recipient(CAFE);
    fails_with(&f.run(FEE, &[]), "RECIPIENT_EVM_1 or RECIPIENT");
    fails_with(&f.run(FEE, &[recipient(Address::ZERO)]), "zero address");
    fails_with(&f.run(FEE, &[("RECIPIENT", "GABC".into())]), "not an EVM address");
    fails_with(&f.run(FEE, &[cafe.clone(), ("SLIPPAGE_BPS", "500".into())]), "out of range");
    fails_with(&f.run(FEE, &[cafe.clone(), ("KEEP_WEI", "0.01".into())]), "KEEP_WEI");
    fails_with(&f.run(FEE, &[cafe.clone(), ("KEEP_WEI_EVM_1", "0.01".into())]), "KEEP_WEI_EVM_1");
    // RPC_URL_EVM_56 pointed at the mainnet fork.
    fails_with(&f.run(FEE, &[cafe.clone(), ("CHAINS", "evm:56".into()), ("RPC_URL_EVM_56", f.url.clone())]), "not 56");
    // Signer must be the configured fee receiver.
    fails_with(&f.run(FEE, &[cafe.clone(), ("FEE_RECEIVER_ADDRESS_EVM_1", BEEF.to_string())]), "is not chain 1's fee receiver");
    // Explicitly selected chain not in the relayer config.
    fails_with(&f.run(FEE, &[cafe.clone(), ("CHAINS", "evm:10".into())]), "not in the relayer config");
    // CHAINS entries need their family; other families are parsed but not built yet.
    fails_with(&f.run(FEE, &[cafe.clone(), ("CHAINS", "1".into())]), "add the family, e.g. evm:1");
    fails_with(&f.run(FEE, &[cafe.clone(), ("CHAINS", "solana:1".into())]), "expected evm:<id> or stellar:<id>");
    fails_with(&f.run(FEE, &[cafe.clone(), ("CHAINS", "evm:1,stellar:1".into())]), "not implemented yet");

    // In-flight tx from the fee wallet blocks the run.
    let _: () = f.p.raw_request("evm_setAutomine".into(), (false,)).await.unwrap();
    let tx = TransactionRequest::default().from(FEE).to(FEE).value(U256::from(1));
    let _pending = f.p.send_transaction(tx).await.unwrap();
    fails_with(&f.run(FEE, &[cafe, send()]), "in-flight txs");
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_56"]
async fn bsc_sweep_then_noop() {
    let f = fork(56).await;
    f.seed_bsc_fees(FEE).await;
    let c0 = f.eth(CAFE).await;
    ok(&f.run(FEE, &[recipient(CAFE), send()]));
    assert!(f.drained(FEE, &BSC_FEE_ASSETS).await);
    assert!(f.eth(CAFE).await > c0);
    let n = f.nonce(FEE).await;
    ok(&f.run(FEE, &[recipient(CAFE), send()]));
    assert_eq!(f.nonce(FEE).await, n);
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_gas_ceiling_skips_without_failing() {
    let f = fork(1).await;
    f.seed_mainnet_fees(FEE).await;
    let n0 = f.nonce(FEE).await;
    // Ceiling below the fork's base fee: chain skipped, run still succeeds, nothing sent.
    let low = f.run(FEE, &[recipient(CAFE), send(), ("MAX_BASE_FEE_GWEI", "1000".into()), ("MAX_BASE_FEE_GWEI_EVM_1", "0.000000001".into())]);
    ok(&low);
    assert!(stdout(&low).contains("summary evm:1: skipped, base fee"), "per-chain ceiling must win");
    assert_eq!(f.nonce(FEE).await, n0);
    // Generous ceiling: sweeps.
    ok(&f.run(FEE, &[recipient(CAFE), send(), ("MAX_BASE_FEE_GWEI", "1000".into())]));
    assert!(f.drained(FEE, &MAINNET_FEE_ASSETS).await);
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_recipient_floor_sweeps_only_a_low_recipient() {
    let f = fork(1).await;
    f.seed_mainnet_fees(FEE).await;
    let floor = ("MIN_RECIPIENT_BALANCE_USD", "20".to_string());
    // Recipient holds 1 ETH (>> $20): done with nothing swept, reported ok (not a skip).
    f.set_balance(CAFE, U256::from(10u128.pow(18))).await;
    let n0 = f.nonce(FEE).await;
    let funded = f.run(FEE, &[recipient(CAFE), send(), floor.clone()]);
    ok(&funded);
    assert!(stdout(&funded).contains("summary evm:1: ok, recipient 0x000000000000000000000000000000000000cafE holds 1.0"), "funded recipient");
    assert_eq!(f.nonce(FEE).await, n0, "funded recipient must not trigger a sweep");
    // Recipient empty: below the floor, the normal sweep runs.
    f.set_balance(CAFE, U256::ZERO).await;
    let low = f.run(FEE, &[recipient(CAFE), send(), floor]);
    ok(&low);
    assert!(stdout(&low).contains("below it, sweeping"));
    assert!(f.drained(FEE, &MAINNET_FEE_ASSETS).await);
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn all_chains_isolate_failures_and_log_json() {
    let f = fork(1).await;
    f.seed_mainnet_fees(FEE).await;
    // CHAINS=all: mainnet works; BSC's RPC is the fixture's dead 127.0.0.1:1. Mainnet must still
    // sweep, the run must fail, and the summary must say which chain failed.
    let out = f.run(FEE, &[recipient(CAFE), send(), ("CHAINS", "all".into()), ("LOG_FORMAT", "json".into())]);
    assert!(!out.status.success(), "a failed chain must fail the run");
    assert!(f.drained(FEE, &MAINNET_FEE_ASSETS).await, "mainnet must not be blocked by BSC");

    let lines: Vec<serde_json::Value> =
        stdout(&out).lines().map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("not JSON ({e}): {l}"))).collect();
    let msg = |v: &serde_json::Value| v["message"].as_str().unwrap_or_default().to_string();
    assert!(lines.iter().all(|v| v["severity"].is_string()), "every line needs a severity");
    // Per-chain lines carry their chain.
    let sent = lines.iter().find(|v| msg(v).starts_with("send: ")).expect("send line");
    assert_eq!(sent["span"]["chain"], "evm:1", "{sent}");
    let summary = |c: &str| lines.iter().find(|v| msg(v).starts_with(&format!("summary {c}:"))).cloned().expect(c);
    assert!(msg(&summary("evm:1")).contains("ok, sent"));
    assert!(msg(&summary("evm:56")).contains("FAILED"));
    assert_eq!(summary("evm:56")["severity"], "ERROR");
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1 and FORK_RPC_URL_56"]
async fn mainnet_and_bsc_in_one_run() {
    let (main, bsc) = (fork(1).await, fork(56).await);
    main.seed_mainnet_fees(FEE).await;
    bsc.seed_bsc_fees(FEE).await;
    let c0 = (main.eth(CAFE).await, bsc.eth(CAFE).await);
    let out = main.run(
        FEE,
        &[
            recipient(CAFE),
            send(),
            ("CHAINS", "evm:1,evm:56".into()),
            ("RPC_URL_EVM_56", bsc.url.clone()),
            ("FEE_RECEIVER_ADDRESS_EVM_56", FEE.to_string()),
        ],
    );
    ok(&out);
    assert!(main.drained(FEE, &MAINNET_FEE_ASSETS).await && bsc.drained(FEE, &BSC_FEE_ASSETS).await);
    assert!(main.eth(CAFE).await > c0.0 && bsc.eth(CAFE).await > c0.1);
    let s = stdout(&out);
    assert!(s.contains("summary evm:1: ok, sent") && s.contains("summary evm:56: ok, sent"), "{s}");
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_large_swap_best_venue_always_delivers() {
    // 2M USDC: LI.FI is quoted live and must beat V3's raw quote to be taken (unit-tested in
    // `pick_venue`); which venue wins depends on the market, and LI.FI's RFQ legs often go stale on
    // a fork anyway. Whatever runs, the recipient must get at least the guaranteed floor, paid
    // straight to it and proven from the receipt.
    let f = fork(1).await;
    let usdc = IERC20::new(USDC, f.p.clone());
    f.exec(USDC_WHALE, usdc.transfer(BEEF, U256::from(2_000_000_000_000u64)).into_transaction_request()).await;
    let c0 = f.eth(CAFE).await;
    let out = f.run(BEEF, &[recipient(CAFE), send()]);
    ok(&out);
    let s = stdout(&out);
    assert!(s.contains("via LI.FI") || s.contains("via Uniswap V3"), "{s}");
    assert!(s.contains("delivered"), "swap output should go straight to the recipient");
    assert!(f.bal(USDC, BEEF).await.is_zero());
    // A single Uniswap pool floors at ~790 ETH for 2M USDC today; anything far below is a bug.
    assert!(f.eth(CAFE).await - c0 > U256::from(760u128 * 10u128.pow(18)), "recipient got too little");
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_lifi_down_falls_back_to_v3() {
    let f = fork(1).await;
    f.seed_mainnet_fees(FEE).await;
    let out = f.run(FEE, &[recipient(CAFE), send(), ("SWAP_VENUE", "lifi".into()), ("LIFI_API_URL", "http://127.0.0.1:1".into())]);
    ok(&out);
    let s = stdout(&out);
    assert!(s.contains("LI.FI unusable") && s.contains("via Uniswap V3"), "{s}");
    assert!(f.drained(FEE, &MAINNET_FEE_ASSETS).await);
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_low_fee_wallet_refills_before_delivering() {
    // Fee wallet below KEEP: swap output must refill it instead of going to the recipient.
    let f = fork(1).await;
    let usdc = IERC20::new(USDC, f.p.clone());
    f.exec(USDC_WHALE, usdc.transfer(BEEF, U256::from(1_000_000_000u64)).into_transaction_request()).await;
    f.set_balance(BEEF, U256::from(KEEP / 2)).await;
    let out = f.run(BEEF, &[recipient(CAFE), send()]);
    ok(&out);
    assert!(stdout(&out).contains("to fee wallet"), "{}", stdout(&out));
    assert!(f.bal(USDC, BEEF).await.is_zero());
    let left = f.eth(BEEF).await;
    assert!(left >= U256::from(KEEP) && left < U256::from(KEEP + 10u128.pow(15)), "fee wallet left {left}");
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_dust_shares_cannot_block_the_sweep() {
    // Anyone can send the public fee wallet a pp-share amount that redeems to 0 aTokens; the vault
    // would revert (ZeroAssets) every run. It must be left alone and the rest swept.
    let f = fork(1).await;
    f.seed_mainnet_fees(FEE).await;
    let usdc = IERC20::new(USDC, f.p.clone());
    f.exec(USDC_WHALE, usdc.transfer(BEEF, U256::from(500_000_000u64)).into_transaction_request()).await;
    let pp = IERC20::new(PPUSDC, f.p.clone());
    f.exec(FEE, pp.transfer(BEEF, U256::from(1_000_000u64)).into_transaction_request()).await;
    let out = f.run(BEEF, &[recipient(CAFE), send()]);
    ok(&out);
    assert!(stdout(&out).contains("(dust), left alone"), "{}", stdout(&out));
    assert!(f.bal(USDC, BEEF).await.is_zero(), "USDC must still be swapped");
    assert_eq!(f.bal(PPUSDC, BEEF).await, U256::from(1_000_000u64));
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_stale_lifi_allowance_is_revoked() {
    // A failed or killed earlier LI.FI attempt left an approval to the Diamond: revoke it even
    // when this run doesn't use LI.FI.
    let f = fork(1).await;
    let usdc = IERC20::new(USDC, f.p.clone());
    f.exec(USDC_WHALE, usdc.transfer(BEEF, U256::from(500_000_000u64)).into_transaction_request()).await;
    f.exec(BEEF, usdc.approve(LIFI_DIAMOND, U256::from(123u64)).into_transaction_request()).await;
    let out = f.run(BEEF, &[recipient(CAFE), send(), ("SWAP_VENUE", "v3".into())]);
    ok(&out);
    assert!(stdout(&out).contains("revoking stale LI.FI Diamond allowance"));
    let left = IAllowance::new(USDC, f.p.clone()).allowance(BEEF, LIFI_DIAMOND).call().await.unwrap();
    assert!(left.is_zero(), "Diamond allowance left: {left}");
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_private_key_signing_path() {
    // Every other test impersonates; production signs locally. Fresh key, funded on the fork.
    let f = fork(1).await;
    let key = "0x5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed";
    let me = key.parse::<alloy::signers::local::PrivateKeySigner>().unwrap().address();
    f.set_balance(me, U256::from(10u128.pow(17))).await;
    let usdc = IERC20::new(USDC, f.p.clone());
    f.exec(USDC_WHALE, usdc.transfer(me, U256::from(1_000_000_000u64)).into_transaction_request()).await;
    let c0 = f.eth(CAFE).await;
    let out = f.run_signed(key, &[recipient(CAFE), send()]);
    ok(&out);
    assert!(!stdout(&out).contains("5eed5eed"), "key leaked into the output");
    assert!(f.bal(USDC, me).await.is_zero());
    assert!(f.eth(CAFE).await - c0 > U256::from(10u128.pow(17)), "recipient got too little");
    // A malformed key fails without being echoed.
    let bad = f.run_signed(key, &[recipient(CAFE), ("PRIVATE_KEY", "0x5eed5eedZZ".into())]);
    fails_with(&bad, "PRIVATE_KEY is not a 32-byte hex private key");
    assert!(!format!("{}{}", stdout(&bad), String::from_utf8_lossy(&bad.stderr)).contains("5eed5eedZZ"));
}

#[tokio::test]
#[ignore = "needs FORK_RPC_URL_1"]
async fn mainnet_gas_spike_skips_by_default_and_fails_cleanly_without_ceiling() {
    let f = fork(1).await;
    let usdc = IERC20::new(USDC, f.p.clone());
    f.exec(USDC_WHALE, usdc.transfer(BEEF, U256::from(500_000_000u64)).into_transaction_request()).await;
    f.set_balance(BEEF, U256::from(KEEP)).await;
    // 40 gwei base fee on the latest block.
    let _: serde_json::Value = f.p.raw_request("anvil_setNextBlockBaseFeePerGas".into(), (U256::from(40_000_000_000u64),)).await.unwrap();
    let _: serde_json::Value = f.p.raw_request("evm_mine".into(), ()).await.unwrap();

    // Default ceiling (5 gwei): skipped, run succeeds, nothing sent.
    let n0 = f.nonce(BEEF).await;
    let skip = f.run(BEEF, &[recipient(CAFE), send()]);
    ok(&skip);
    assert!(stdout(&skip).contains("skipped, base fee"));
    assert_eq!(f.nonce(BEEF).await, n0);

    // No ceiling + a wallet at KEEP: the first tx can't be covered at gas_limit x maxFee. Must fail
    // with a clear message (not a node error), leaving the USDC for a later run.
    let _: serde_json::Value = f.p.raw_request("anvil_setNextBlockBaseFeePerGas".into(), (U256::from(40_000_000_000u64),)).await.unwrap();
    let _: serde_json::Value = f.p.raw_request("evm_mine".into(), ()).await.unwrap();
    let fail = f.run(BEEF, &[recipient(CAFE), send(), ("MAX_BASE_FEE_GWEI", "none".into())]);
    fails_with(&fail, "fee wallet can't cover");
    assert!(!f.bal(USDC, BEEF).await.is_zero());
}
