// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @title MockERC20
/// @notice Minimal ERC20 for swap e2e/test fixtures. `mint` is deliberately permissionless — this
///   contract is never deployed anywhere but a throwaway local fork (see
///   packages/evm-sdk/e2e/network.ts), so an unrestricted mint is a safe, intentional
///   simplification, not an oversight.
/// @dev Mirrors the inline `MockERC20` already used by test/RelaySwaps.t.sol, moved to src/ so it
///   can be deployed by a forge script (same "Mock*.sol lives in src/" pattern as MockPool.sol).
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address _to, uint256 _amount) external {
        balanceOf[_to] += _amount;
    }

    function approve(address _spender, uint256 _amount) external returns (bool) {
        allowance[msg.sender][_spender] = _amount;
        return true;
    }

    function transfer(address _to, uint256 _amount) external returns (bool) {
        balanceOf[msg.sender] -= _amount;
        balanceOf[_to] += _amount;
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _amount) external returns (bool) {
        allowance[_from][msg.sender] -= _amount;
        balanceOf[_from] -= _amount;
        balanceOf[_to] += _amount;
        return true;
    }
}
