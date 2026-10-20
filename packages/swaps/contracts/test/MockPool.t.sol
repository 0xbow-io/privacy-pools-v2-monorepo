// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from "forge-std/Test.sol";
import {MockPool} from "../src/MockPool.sol";

/// @notice Minimal ERC20 for testing
contract MockERC20 {
    string public name = "Mock Token";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

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

/// @notice Mock verifier that always returns true (for testing relay flow without real proofs)
contract MockVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[4] calldata
    ) external pure returns (bool) {
        return true;
    }
}

/// @notice Mock verifier that always returns false
contract RejectingVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[4] calldata
    ) external pure returns (bool) {
        return false;
    }
}

contract MockPoolTest is Test {
    MockPool internal pool;
    MockVerifier internal verifier;
    MockERC20 internal token;

    address internal constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address internal owner = address(this);
    address internal relayer = makeAddr("relayer");
    address internal depositor = makeAddr("depositor");
    address internal recipient = makeAddr("recipient");
    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        pool = new MockPool();
        verifier = new MockVerifier();
        token = new MockERC20();

        pool.setDepositVerifier(address(verifier));
        pool.setRelayer(relayer, true);
        pool.setAssetConfig(NATIVE_ASSET, true, 0, 0, 0, 0); // ETH: no limits
        pool.setAssetConfig(address(token), true, 0, 0, 0, 0); // MOCK: no limits
    }

    /*///////////////////////////////////////////////////////////////
                          DEPOSIT TESTS
    ///////////////////////////////////////////////////////////////*/

    function test_DepositNativeETH() public {
        uint256 _depositAmount = 1 ether;

        MockPool.DepositProof memory _proof = _buildDepositProof(NATIVE_ASSET, _depositAmount);

        vm.deal(depositor, _depositAmount);
        vm.prank(depositor);
        pool.deposit{value: _depositAmount}(
            _proof,
            MockPool.NoteData({hint: bytes32(0), data: ""}),
            ""
        );

        assertEq(address(pool).balance, _depositAmount);
    }

    function test_DepositERC20() public {
        uint256 _depositAmount = 100e18;

        MockPool.DepositProof memory _proof = _buildDepositProof(address(token), _depositAmount);

        token.mint(depositor, _depositAmount);
        vm.startPrank(depositor);
        token.approve(address(pool), _depositAmount);
        pool.deposit(
            _proof,
            MockPool.NoteData({hint: bytes32(0), data: ""}),
            ""
        );
        vm.stopPrank();

        assertEq(token.balanceOf(address(pool)), _depositAmount);
        assertEq(token.balanceOf(depositor), 0);
    }

    function test_RevertWhen_DepositWithInvalidProof() public {
        RejectingVerifier _rejectingVerifier = new RejectingVerifier();
        pool.setDepositVerifier(address(_rejectingVerifier));

        MockPool.DepositProof memory _proof = _buildDepositProof(NATIVE_ASSET, 1 ether);

        vm.deal(depositor, 1 ether);
        vm.prank(depositor);
        vm.expectRevert(MockPool.MockPool_InvalidDepositProof.selector);
        pool.deposit{value: 1 ether}(
            _proof,
            MockPool.NoteData({hint: bytes32(0), data: ""}),
            ""
        );
    }

    function test_RevertWhen_DepositWithNoVerifier() public {
        MockPool _freshPool = new MockPool();

        // NOTE: use the local NATIVE_ASSET constant rather than _freshPool.NATIVE_ASSET().
        // solc 0.8.32 has an ICE (TypeChecker MemberAccess) when reading a `public constant`
        // state variable through its external getter. The values are identical.
        MockPool.DepositProof memory _proof = _buildDepositProof(NATIVE_ASSET, 1 ether);

        vm.deal(depositor, 1 ether);
        vm.prank(depositor);
        vm.expectRevert(MockPool.MockPool_NoDepositVerifier.selector);
        _freshPool.deposit{value: 1 ether}(
            _proof,
            MockPool.NoteData({hint: bytes32(0), data: ""}),
            ""
        );
    }

    /*///////////////////////////////////////////////////////////////
                          RELAY TESTS
    ///////////////////////////////////////////////////////////////*/

    function test_RelayNativeETHWithFee() public {
        // Seed pool with ETH
        uint256 _poolBalance = 10 ether;
        vm.deal(address(pool), _poolBalance);

        uint256 _withdrawnValue = 2 ether;
        uint256 _feeAmount = 0.1 ether;
        uint256 _nativeGas = 0;

        MockPool.TransactProof memory _proof = _buildTransactProof(_withdrawnValue, NATIVE_ASSET);
        MockPool.TransactParams memory _params = _buildTransactParams(recipient, feeRecipient, _feeAmount, _nativeGas);

        MockPool.NoteData[] memory _noteData = new MockPool.NoteData[](0);

        vm.deal(relayer, _nativeGas);
        vm.prank(relayer);
        pool.relay{value: _nativeGas}(_proof, _params, _noteData);

        assertEq(recipient.balance, _withdrawnValue - _feeAmount);
        assertEq(feeRecipient.balance, _feeAmount);
    }

    function test_RelayERC20WithFee() public {
        // Seed pool with tokens
        uint256 _poolBalance = 100e18;
        token.mint(address(pool), _poolBalance);

        uint256 _withdrawnValue = 50e18;
        uint256 _feeAmount = 5e18;
        uint256 _nativeGas = 0.01 ether;

        MockPool.TransactProof memory _proof = _buildTransactProof(_withdrawnValue, address(token));
        MockPool.TransactParams memory _params = _buildTransactParams(recipient, feeRecipient, _feeAmount, _nativeGas);

        MockPool.NoteData[] memory _noteData = new MockPool.NoteData[](0);

        vm.deal(relayer, _nativeGas);
        vm.prank(relayer);
        pool.relay{value: _nativeGas}(_proof, _params, _noteData);

        assertEq(token.balanceOf(recipient), _withdrawnValue - _feeAmount);
        assertEq(token.balanceOf(feeRecipient), _feeAmount);
        assertEq(recipient.balance, _nativeGas); // gas funding forwarded
    }

    function test_RevertWhen_RelayByUnauthorized() public {
        vm.deal(address(pool), 10 ether);

        MockPool.TransactProof memory _proof = _buildTransactProof(1 ether, NATIVE_ASSET);
        MockPool.TransactParams memory _params = _buildTransactParams(recipient, feeRecipient, 0, 0);
        MockPool.NoteData[] memory _noteData = new MockPool.NoteData[](0);

        address _unauthorized = makeAddr("unauthorized");
        vm.prank(_unauthorized);
        vm.expectRevert(MockPool.MockPool_NotApprovedRelayer.selector);
        pool.relay(_proof, _params, _noteData);
    }

    function test_RevertWhen_RelayFeeExceedsWithdrawal() public {
        vm.deal(address(pool), 10 ether);

        uint256 _withdrawnValue = 1 ether;
        uint256 _feeAmount = 2 ether; // fee > withdrawal

        MockPool.TransactProof memory _proof = _buildTransactProof(_withdrawnValue, NATIVE_ASSET);
        MockPool.TransactParams memory _params = _buildTransactParams(recipient, feeRecipient, _feeAmount, 0);
        MockPool.NoteData[] memory _noteData = new MockPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(MockPool.MockPool_FeeExceedsWithdrawal.selector);
        pool.relay(_proof, _params, _noteData);
    }

    /*///////////////////////////////////////////////////////////////
                          ADMIN TESTS
    ///////////////////////////////////////////////////////////////*/

    /*///////////////////////////////////////////////////////////////
                          ASSET CONFIG TESTS
    ///////////////////////////////////////////////////////////////*/

    function test_RevertWhen_DepositAssetNotEnabled() public {
        pool.setAssetConfig(NATIVE_ASSET, false, 0, 0, 0, 0);

        MockPool.DepositProof memory _proof = _buildDepositProof(NATIVE_ASSET, 1 ether);

        vm.deal(depositor, 1 ether);
        vm.prank(depositor);
        vm.expectRevert(MockPool.MockPool_AssetNotEnabled.selector);
        pool.deposit{value: 1 ether}(
            _proof,
            MockPool.NoteData({hint: bytes32(0), data: ""}),
            ""
        );
    }

    function test_RevertWhen_DepositBelowMin() public {
        pool.setAssetConfig(NATIVE_ASSET, true, 1 ether, 0, 0, 0);

        MockPool.DepositProof memory _proof = _buildDepositProof(NATIVE_ASSET, 0.5 ether);

        vm.deal(depositor, 0.5 ether);
        vm.prank(depositor);
        vm.expectRevert(MockPool.MockPool_BelowMinAmount.selector);
        pool.deposit{value: 0.5 ether}(
            _proof,
            MockPool.NoteData({hint: bytes32(0), data: ""}),
            ""
        );
    }

    function test_RevertWhen_DepositAboveMax() public {
        pool.setAssetConfig(NATIVE_ASSET, true, 0, 0, 0, 1 ether);

        MockPool.DepositProof memory _proof = _buildDepositProof(NATIVE_ASSET, 2 ether);

        vm.deal(depositor, 2 ether);
        vm.prank(depositor);
        vm.expectRevert(MockPool.MockPool_AboveMaxAmount.selector);
        pool.deposit{value: 2 ether}(
            _proof,
            MockPool.NoteData({hint: bytes32(0), data: ""}),
            ""
        );
    }

    function test_RevertWhen_RelayAssetNotEnabled() public {
        pool.setAssetConfig(NATIVE_ASSET, false, 0, 0, 0, 0);
        vm.deal(address(pool), 10 ether);

        MockPool.TransactProof memory _proof = _buildTransactProof(1 ether, NATIVE_ASSET);
        MockPool.TransactParams memory _params = _buildTransactParams(recipient, feeRecipient, 0, 0);
        MockPool.NoteData[] memory _noteData = new MockPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(MockPool.MockPool_AssetNotEnabled.selector);
        pool.relay(_proof, _params, _noteData);
    }

    function test_RevertWhen_RelayFeeExceedsMaxRelayFee() public {
        pool.setAssetConfig(NATIVE_ASSET, true, 0, 0, 0.05 ether, 0);
        vm.deal(address(pool), 10 ether);

        MockPool.TransactProof memory _proof = _buildTransactProof(1 ether, NATIVE_ASSET);
        MockPool.TransactParams memory _params = _buildTransactParams(recipient, feeRecipient, 0.1 ether, 0);
        MockPool.NoteData[] memory _noteData = new MockPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(MockPool.MockPool_ExceedsMaxRelayFee.selector);
        pool.relay(_proof, _params, _noteData);
    }

    /*///////////////////////////////////////////////////////////////
                          ADMIN TESTS
    ///////////////////////////////////////////////////////////////*/

    function test_RevertWhen_NonOwnerSetsRelayer() public {
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert(MockPool.MockPool_OnlyOwner.selector);
        pool.setRelayer(relayer, true);
    }

    /*///////////////////////////////////////////////////////////////
                          HELPERS
    ///////////////////////////////////////////////////////////////*/

    function _buildDepositProof(
        address _asset,
        uint256 _value
    ) internal pure returns (MockPool.DepositProof memory _proof) {
        _proof.pubSignals[0] = 0; // commitment (unused by mock)
        _proof.pubSignals[1] = uint256(uint160(_asset));
        _proof.pubSignals[2] = _value;
        _proof.pubSignals[3] = 0; // context (unused by mock)
    }

    function _buildTransactProof(
        uint256 _amountOut,
        address _tokenIdOut
    ) internal pure returns (MockPool.TransactProof memory _proof) {
        // pubSignals layout: [0]=nullifiers, [1]=commitments, [2]=[stateRoot],
        //   [3]=[keystoreRoot], [4]=[aspRoot], [5]=[amountOut], [6]=[tokenIdOut], [7]=[context]
        _proof.pubSignals = new uint256[][](8);
        for (uint256 _i = 0; _i < 8; _i++) {
            _proof.pubSignals[_i] = new uint256[](1);
        }
        _proof.pubSignals[5][0] = _amountOut;
        _proof.pubSignals[6][0] = uint256(uint160(_tokenIdOut));
    }

    function _buildTransactParams(
        address _recipient,
        address _feeRecipient,
        uint256 _feeAmount,
        uint256 _nativeGas
    ) internal pure returns (MockPool.TransactParams memory _params) {
        _params.processor = address(0); // not enforced in mock
        _params.data = abi.encode(
            MockPool.PayoutRouting({
                recipient: _recipient,
                feeRecipient: _feeRecipient,
                feeAmount: _feeAmount,
                nativeGas: _nativeGas
            })
        );
    }
}
