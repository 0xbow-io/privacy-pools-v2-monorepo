pragma solidity ^0.8.25;

interface IEntrypoint {
    struct AssetConfig {
        address _pool;
        uint256 minimumDepositAmount;
        uint256 vettingFeeBPS;
        uint256 maxRelayFeeBPS;
    }

    function assetConfig(address _asset)
        external
        view
        returns (address _pool, uint256 _minimumDepositAmount, uint256 _vettingFeeBPS, uint256 _maxRelayFeeBPS);

}
