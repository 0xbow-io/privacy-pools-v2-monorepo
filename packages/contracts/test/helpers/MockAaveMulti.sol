// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

/// @title MockAaveAToken
/// @notice Minimal non-rebasing (1:1) Aave-style aToken, mintable only by its pool, exposing the
/// `IAToken` getters (`POOL`, `UNDERLYING_ASSET_ADDRESS`) the factory validates against. No interest
/// (yield mechanics are covered by the rebasing mock elsewhere); this exists for factory/decimals tests.
contract MockAaveAToken is ERC20 {
  address public immutable POOL;
  address public immutable UNDERLYING_ASSET_ADDRESS;
  uint8 private immutable _DEC;

  error AToken_NotPool();

  constructor(string memory _name, string memory _symbol, uint8 _decimals, address _underlying) ERC20(_name, _symbol) {
    POOL = msg.sender;
    UNDERLYING_ASSET_ADDRESS = _underlying;
    _DEC = _decimals;
  }

  function decimals() public view override returns (uint8) {
    return _DEC;
  }

  function poolMint(address _to, uint256 _amount) external {
    require(msg.sender == POOL, AToken_NotPool());
    _mint(_to, _amount);
  }

  function poolBurn(address _from, uint256 _amount) external {
    require(msg.sender == POOL, AToken_NotPool());
    _burn(_from, _amount);
  }
}

/// @title MockAaveMultiPool
/// @notice Minimal multi-reserve Aave v3 pool mock (1:1 supply/withdraw, no interest). Satisfies the
/// `IAavePool` subset the factory and zap use, and lets one pool back several aTokens of differing
/// decimals so a single factory can deploy multiple wrappers.
contract MockAaveMultiPool {
  mapping(address _underlying => MockAaveAToken _aToken) public aTokenOf;

  error Pool_NoReserve();

  /// @notice Register a reserve, deploying its aToken (decimals mirror the underlying)
  function addReserve(
    IERC20Metadata _underlying,
    string memory _aName,
    string memory _aSymbol
  ) external returns (MockAaveAToken _aToken) {
    _aToken = new MockAaveAToken(_aName, _aSymbol, _underlying.decimals(), address(_underlying));
    aTokenOf[address(_underlying)] = _aToken;
  }

  function supply(address _asset, uint256 _amount, address _onBehalfOf, uint16) external {
    MockAaveAToken _aToken = aTokenOf[_asset];
    require(address(_aToken) != address(0), Pool_NoReserve());
    IERC20(_asset).transferFrom(msg.sender, address(this), _amount);
    _aToken.poolMint(_onBehalfOf, _amount);
  }

  function withdraw(address _asset, uint256 _amount, address _to) external returns (uint256) {
    MockAaveAToken _aToken = aTokenOf[_asset];
    require(address(_aToken) != address(0), Pool_NoReserve());
    if (_amount == type(uint256).max) _amount = _aToken.balanceOf(msg.sender);
    _aToken.poolBurn(msg.sender, _amount);
    IERC20(_asset).transfer(_to, _amount);
    return _amount;
  }
}
