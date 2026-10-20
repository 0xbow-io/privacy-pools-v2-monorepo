# Intent Fulfilling Contracts

  In production, this feature adds a contract called `RelaySwaps.sol`.

  Said contract will kickstart withdrawal intents, which are not supported by our current intents provider (LiFi) in a direct fashion.

  We need to deploy one `RelaySwaps.sol` for each supported chain, and it needs to point to the provider's entry contract, which currently is the LiFi diamond ([listed here](https://docs.li.fi/introduction/lifi-architecture/smart-contract-addresses)).

  The contract will also whitelist potential approval addresses and needs to know the PPv2 deployment in its network.


## Deploy

### Environment Variables Required for Deployment


* `PUBLISHER_PRIVATE_KEY` A private key that will be used for deployment by `forge`.
* `ROUTER` Address of a router contract, currently it would be the LiFi diamond for the chain under consideration.
* `ENTRYPOINT_ADDRESS` Address of the privacy pools `Entrypoint` contract for current chain.
* `POOL_ADDRESS` Address of the `PoolVault` contract for the current chain.
* `UPGRADER_ROLE` Public address of an account intended to be the only one allowed to change the list of allowed routers.
* `IS_TEST_DEPLOYMENT` Must be `"true"` if `POOL_ADDRESS` or `ENTRYPOINT_ADDRESS` resolves to a deployed `MockPool` (the deploy script detects this by matching bytecode). `MockPool.relay()`/`transact()` skip ZK proof verification entirely, so deploying `RelaySwaps` against it without explicitly acknowledging that is refused — the script reverts instead of silently shipping something that looks production-ready but has no proof verification behind it.



## Test Deploy


  One limitation introduced by the provider is there is _no sepolia deployment_, therefore we need to test in production networks. Due to deployment costs, we've chosen to test in L2 networks such as ARB (shown in below examples).

  In order to have an acceptable control of the test environment, we've created simplified PPv2 contracts that allow to run adequate and deep enough tests.

  We've simplified all of the mocked PP functionality into a contract called `MockPool`.


### Prepare required accounts

  Choose an adequate testing account and generate three key pairs, to hold three roles.

  For deployment, we only need one of these, but we will use the other two for the ASP mock and as the test user/funded wallet.


```bash
export WORDS=these are the twelve words that you shouldn't reveal ever to anyone
cast wallet derive --insecure -a 3 "$WORDS"
```

* First key will be `PUBLISHER_PRIVATE_KEY` when deploying.
* Second key will be `ASP_POSTMAN_PRIVATE_KEY` in the `.env` file when running the tests.
* Third key will be `SIGNER_PRIVATE_KEY_42161` in the `.env` file when running the tests.


You will use one of these as the ASP and another one as the SIGNER to transform your `env_template` into a valid `.env` file.


### Environment Variables Required for Deployment

* `PUBLISHER_PRIVATE_KEY` A private key that will be used for deployment by `forge`.
* `ROUTER` Address of a router contract, currently it would be the LiFi diamond for the chain under consideration.
* `ENTRYPOINT_ADDRESS` Address of the privacy pools `Entrypoint` contract for current chain.
* `POOL_ADDRESS` Address of the `PoolVault` contract for the current chain.
* `UPGRADER_ROLE` Public address of an account intended to be the only one allowed to change the list of allowed routers.

### Commands

#### First Deploy if testing: MockPool

  You will need to publish the address of this contract as a public variable

* If you are testing, you need to use the address from the MockPool deploy as both ENTRYPOINT and POOL


```bash
forge script script/DeployMockPool.s.sol  --fork-url http://127.0.0.1:8545 \
      --broadcast \
      --private-key $PUBLISHER_PRIVATE_KEY \
      -vv
```

#### Second deploy: actual RelaySwap contract

* If **testing**: Export the address of `MockPool` as `ENTRYPOINT_ADDRESS` and as `POOL_ADDRESS`, and export `IS_TEST_DEPLOYMENT=true` — the script detects a MockPool by bytecode and refuses to deploy against it otherwise (see above).

```bash
export IS_TEST_DEPLOYMENT=true   # only when POOL_ADDRESS/ENTRYPOINT_ADDRESS is MockPool
forge script script/DeployRelaySwaps.s.sol \
      --fork-url http://127.0.0.1:8545 \
      --broadcast \
      --private-key $PUBLISHER_PRIVATE_KEY \
      -vv
```
