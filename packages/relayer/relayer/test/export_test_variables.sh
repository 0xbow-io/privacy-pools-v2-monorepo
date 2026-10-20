# Only for local testing, github workflow handles all of this.
export FEE_RECEIVER_11155111=$(cast wallet new | grep Private | sed 's/Private key: //g')
export SIGNER_PRIVATE_KEY_EVM_11155111=$FEE_RECEIVER_11155111
export FEE_RECEIVER_ADDRESS_EVM_11155111=$(cast wallet address $FEE_RECEIVER_11155111)
export RELAY_CONTRACT_11155111=$(jq -r '.transactions[] | select(.contractName == "PrivacyPoolRelay") | .contractAddress' ../mockedContracts/broadcast/PrivacyPoolRelay.s.sol/11155111/run-latest.json)
export ENTRYPOINT_CONTRACT_11155111=$(jq -r '.transactions[] | select(.contractName == "Entrypoint") | .contractAddress' ../mockedContracts/broadcast/PrivacyPoolRelay.s.sol/11155111/run-latest.json)
export ETHEREUM_CHAIN_ID=11155111
export RPC_URL_EVM_11155111=http://localhost:8545
export ANVIL_FIRST_PKEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
cast send $FEE_RECEIVER_ADDRESS_EVM_11155111 --value 2ether --private-key $ANVIL_FIRST_PKEY --rpc-url $RPC_URL_EVM_11155111
cast send $RELAY_CONTRACT_11155111 --value 10ether --private-key $ANVIL_FIRST_PKEY  --rpc-url $RPC_URL_EVM_11155111
