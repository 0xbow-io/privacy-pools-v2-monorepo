// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

// VENDORED: synced verbatim from the `yield/` module (PPYieldToken yield wrapper + Aave zap).
// Do not edit here; update the `yield/` source of truth and re-vendor. See PPRouter.sol header.

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

/// @title RayMath
/// @notice Minimal Aave-style ray (1e27) fixed-point math with half-up rounding.
library RayMath {
  uint256 internal constant RAY = 1e27;

  /// @notice `a * b` in ray, half-up rounded
  function rayMul(uint256 _a, uint256 _b) internal pure returns (uint256) {
    return (_a * _b + RAY / 2) / RAY;
  }

  /// @notice `a / b` in ray, half-up rounded
  function rayDiv(uint256 _a, uint256 _b) internal pure returns (uint256) {
    return (_a * RAY + _b / 2) / _b;
  }
}

/// @title MockRebasingAToken
/// @notice Faithful-enough Aave aToken: balances are stored scaled and `balanceOf` rebases with the
/// pool's live normalized income (`scaledBalance.rayMul(index)`). Transfers move scaled amounts so
/// yield follows the tokens. Mint/burn are pool-only. Decimals mirror the underlying (6 for USDC).
contract MockRebasingAToken is IERC20, IERC20Metadata {
  using RayMath for uint256;

  string public name;
  string public symbol;
  uint8 public decimals;

  MockAavePool public immutable POOL;

  mapping(address account => uint256 balance) public scaledBalanceOf;
  uint256 public scaledTotalSupply;
  mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

  error AToken_NotPool();
  error AToken_InsufficientAllowance();

  modifier onlyPool() {
    require(msg.sender == address(POOL), AToken_NotPool());
    _;
  }

  constructor(string memory _name, string memory _symbol, uint8 _decimals) {
    name = _name;
    symbol = _symbol;
    decimals = _decimals;
    POOL = MockAavePool(msg.sender);
  }

  function totalSupply() external view returns (uint256) {
    return scaledTotalSupply.rayMul(POOL.getNormalizedIncome());
  }

  /// @notice The underlying asset this aToken represents (Aave v3 `IAToken` surface)
  function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
    return address(POOL.UNDERLYING());
  }

  function balanceOf(address _account) public view returns (uint256) {
    return scaledBalanceOf[_account].rayMul(POOL.getNormalizedIncome());
  }

  function approve(address _spender, uint256 _amount) external returns (bool) {
    allowance[msg.sender][_spender] = _amount;
    emit Approval(msg.sender, _spender, _amount);
    return true;
  }

  function transfer(address _to, uint256 _amount) external returns (bool) {
    _transfer(msg.sender, _to, _amount);
    return true;
  }

  function transferFrom(address _from, address _to, uint256 _amount) external returns (bool) {
    uint256 _allowed = allowance[_from][msg.sender];
    if (_allowed != type(uint256).max) {
      require(_allowed >= _amount, AToken_InsufficientAllowance());
      allowance[_from][msg.sender] = _allowed - _amount;
    }
    _transfer(_from, _to, _amount);
    return true;
  }

  function mint(address _to, uint256 _amount) external onlyPool {
    uint256 _scaled = _amount.rayDiv(POOL.getNormalizedIncome());
    scaledBalanceOf[_to] += _scaled;
    scaledTotalSupply += _scaled;
    emit Transfer(address(0), _to, _amount);
  }

  function burn(address _from, uint256 _amount) external onlyPool {
    uint256 _scaled = _amount.rayDiv(POOL.getNormalizedIncome());
    scaledBalanceOf[_from] -= _scaled;
    scaledTotalSupply -= _scaled;
    emit Transfer(_from, address(0), _amount);
  }

  function _transfer(address _from, address _to, uint256 _amount) internal {
    uint256 _scaled = _amount.rayDiv(POOL.getNormalizedIncome());
    scaledBalanceOf[_from] -= _scaled;
    scaledBalanceOf[_to] += _scaled;
    emit Transfer(_from, _to, _amount);
  }
}

/// @title MockAavePool
/// @notice Minimal Aave v3 pool for integration tests: USDC in -> aUSDC out (1:1 scaled), and the
/// supply index grows over time with utilization. A borrower creates utilization, `vm.warp`
/// realizes the yield. Linear interest (supply rate = borrow rate * utilization). No collateral
/// checks - tests are trusted. Faithful to the mechanics the wrapper depends on, not a full market.
contract MockAavePool {
  using RayMath for uint256;

  uint256 internal constant RAY = 1e27;
  uint256 internal constant SECONDS_PER_YEAR = 365 days;

  IERC20 public immutable UNDERLYING;
  MockRebasingAToken public immutable A_TOKEN;

  uint256 public liquidityIndex = RAY;
  uint256 public borrowIndex = RAY;
  uint256 public lastUpdate;

  uint256 public borrowRatePerYear; // ray (e.g. 0.1e27 == 10% APR)
  uint256 public scaledBorrowTotal;
  mapping(address account => uint256 amount) public scaledBorrowOf;

  error Pool_WrongAsset();

  constructor(IERC20 _underlying, string memory _aName, string memory _aSymbol, uint8 _decimals) {
    UNDERLYING = _underlying;
    A_TOKEN = new MockRebasingAToken(_aName, _aSymbol, _decimals);
    lastUpdate = block.timestamp;
  }

  /// @notice Test helper: set the (annual, ray) variable borrow rate
  function setBorrowRate(uint256 _ratePerYearRay) external {
    _accrue();
    borrowRatePerYear = _ratePerYearRay;
  }

  /// @notice Current outstanding debt, at the live borrow index
  function totalDebt() public view returns (uint256) {
    return scaledBorrowTotal.rayMul(getNormalizedDebt());
  }

  /// @notice Live supply index including interest accrued since the last checkpoint (Aave's
  /// getReserveNormalizedIncome analogue) - this is what makes aToken.balanceOf rebase continuously.
  function getNormalizedIncome() public view returns (uint256) {
    uint256 _elapsed = block.timestamp - lastUpdate;
    if (_elapsed == 0 || borrowRatePerYear == 0) return liquidityIndex;

    uint256 _supplied = A_TOKEN.scaledTotalSupply().rayMul(liquidityIndex);
    if (_supplied == 0) return liquidityIndex;

    uint256 _debt = scaledBorrowTotal.rayMul(borrowIndex);
    uint256 _utilization = _debt.rayDiv(_supplied);
    uint256 _supplyRate = borrowRatePerYear.rayMul(_utilization);
    uint256 _linearInterest = (_supplyRate * _elapsed) / SECONDS_PER_YEAR;
    return liquidityIndex.rayMul(RAY + _linearInterest);
  }

  /// @notice Live borrow index including interest accrued since the last checkpoint
  function getNormalizedDebt() public view returns (uint256) {
    uint256 _elapsed = block.timestamp - lastUpdate;
    if (_elapsed == 0 || borrowRatePerYear == 0) return borrowIndex;
    uint256 _linearInterest = (borrowRatePerYear * _elapsed) / SECONDS_PER_YEAR;
    return borrowIndex.rayMul(RAY + _linearInterest);
  }

  function supply(address _asset, uint256 _amount, address _onBehalfOf, uint16) external {
    require(_asset == address(UNDERLYING), Pool_WrongAsset());
    _accrue();
    UNDERLYING.transferFrom(msg.sender, address(this), _amount);
    A_TOKEN.mint(_onBehalfOf, _amount);
  }

  function withdraw(address _asset, uint256 _amount, address _to) external returns (uint256) {
    require(_asset == address(UNDERLYING), Pool_WrongAsset());
    _accrue();
    if (_amount == type(uint256).max) _amount = A_TOKEN.balanceOf(msg.sender);
    A_TOKEN.burn(msg.sender, _amount);
    UNDERLYING.transfer(_to, _amount);
    return _amount;
  }

  function borrow(address _asset, uint256 _amount, address _onBehalfOf) external {
    require(_asset == address(UNDERLYING), Pool_WrongAsset());
    _accrue();
    uint256 _scaled = _amount.rayDiv(borrowIndex);
    scaledBorrowOf[_onBehalfOf] += _scaled;
    scaledBorrowTotal += _scaled;
    UNDERLYING.transfer(msg.sender, _amount);
  }

  function repay(address _asset, uint256 _amount, address _onBehalfOf) external {
    require(_asset == address(UNDERLYING), Pool_WrongAsset());
    _accrue();
    UNDERLYING.transferFrom(msg.sender, address(this), _amount);
    uint256 _scaled = _amount.rayDiv(borrowIndex);
    scaledBorrowOf[_onBehalfOf] -= _scaled;
    scaledBorrowTotal -= _scaled;
  }

  /// @notice Checkpoint both indices to the current time
  function _accrue() internal {
    liquidityIndex = getNormalizedIncome();
    borrowIndex = getNormalizedDebt();
    lastUpdate = block.timestamp;
  }
}
