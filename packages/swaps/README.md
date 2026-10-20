# Privacy Pools V2: Intents integration


  This section covers our integration with intent features, abstracted over providers but currently relying on LiFi.


## Involved components


1- A running PPv2 relayer.
2- The SDK.
3- The core PPv2 smart contracts.
4- The `RelaySwaps` ppv2 intent integration contracts.


## What's contained in this section and what isn't

  The relayer has its own `packages` folder.

  The `SDK` is fully contained inside its own packages folder.

  The only production code stored in this folder is the `RelaySwaps.sol` contract. The rest of the code is complex scaffolding required to test it in a realistic enough context to bring certainty about its functionality. We rely on LiFi implementations and its solvers, which **do not exist in testing chains** and therefore we had to develop reasonable ways to test in production chains.


## Deploying the contract


  `RelaySwaps` is a foundry project with a forge deployment script, contained under `./contracts/scripts`. A further `README` file inside the `contracts` folder covers the deployment, both for production and testing.


## Starting a local relayer


  The easiest way to iterate fast over the tests is to use a local relayer.
  Point your relayer to a custom configuration using the `CONFIG_PATH` variable.
  You can obtain a valid relayer configuration for this tests by starting with the example `test/relayer.config.latest.json` (or the older `test/relayer.config.real.json`), which is a template, and adding your actual keys.

  Two real Arbitrum deployments coexist — don't mix them:

  * **Swap-test deployment** (what the relayer + all `*relay-swaps*` tests use): PoolVault `0xFf11...`, entrypoint `0xa845...`, keystore `0x813e...`, ASP `0x75A9...`, relay `0xc0e9...`, RelaySwaps `0xE9D6...`. RelaySwaps is immutably wired to this pool. (The "Wired to MockPool" note in `contracts/deployments-it-001.json` is stale — the address is a real PoolVault; verify with `cast call 0xFf11... "aspRegistry()(address)"`.)
  * **Newer smoke deployment** (`test/contract.config.ts`): PoolVault `0x38B8...`, entrypoint `0xad0b...`, keystore `0xffA6...`, PrivacyPoolRelay `0xae45...` (July 10 broadcast). Used by the deposit/ragequit suites; no RelaySwaps deployed against it.

  The relayer must also be started with `ALLOW_MOCK_RATE_PROVIDER=true` for the `"quoter": "Mock"` assets to resolve — Mock pricing is fail-closed and unregistered by default (issue #961). **Store it as a dotfile** so it gets ignored (this repo's .gititnore ignores all dotfiles) and **your secrets do not leak**. Another option is to store the config with secrets in a non git tracked folder and point to it using the `CONFIG_PATH` variable.


```bash
# Notice this path is relative to the root of the repo.
cd packages/relayer/relayer
# Be careful
CONFIG_PATH=../../swaps/test/.relayer.config.testint_secrets.json pnpm start:dev
```


## Testing


* Contracts need to be deployed (`RelaySwaps` and `MockPool`).
* A `relayer` instance needs to be running and correctly parameterized, pointing to your deployments and addresses.
* You need to populate the `env_template` into a correctly formed `.env` file.


  We've organized the testing using some scripts, as it has many moving pieces.

1- Populate your env using the `env_template` file.
2- Deploy the required contracts if not yet done (documented in `contracts/README.md`).
3- Check you have published all required environment variables using `verificator.sh`.
4- Call the helper `run_a_test` plugin. It will offer a list of available tests and allow you to select one. If you need to repeat a test or automate over it, it accepts an index to sip the test selection prompt and test directly.

