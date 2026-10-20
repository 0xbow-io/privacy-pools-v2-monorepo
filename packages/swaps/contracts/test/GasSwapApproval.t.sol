// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {RelaySwapsTest, MockERC20, MockSwapper} from "./RelaySwaps.t.sol";
import {RelaySwaps, IPool} from "../src/RelaySwaps.sol";
import {SwapRoutingBuilder} from "./helpers/SwapRoutingBuilder.sol";
import {ProofLibV2} from "main_contracts_libs/ProofLibV2.sol";

/// @notice Stress-tests of the gas-swap approval claim (finding #1 / second_vuln_mining).
contract GasSwapApprovalPoC is RelaySwapsTest {
    address internal attacker = makeAddr("attackerX");

    function _routing(
        uint256 _swapValue,
        uint256 _gasPull,
        uint256 _gasMaxInput,
        uint256 _gasEthOut,
        uint256 _mainPull,
        uint256 _mainEthRefund,
        address _dust
    ) internal view returns (RelaySwaps.SwapRouting memory _r) {
        _r = SwapRoutingBuilder.defaultRouting();
        _r.swapTarget = address(swapper);
        _r.approvalAddress = address(swapper);
        _r.outputToken = address(usdc);
        _r.recipient = address(0);
        _r.feeRecipient = address(0);
        _r.fallbackAddress = address(0);
        _r.dustRecipient = _dust;
        _r.feeAmount = 0;
        _r.minOutputAmount = 0;
        _r.nativeGas = 0;
        _r.swapValue = _swapValue;
        _r.gasSwapMaxInput = _gasMaxInput;
        _r.gasSwapCalldata = abi.encodeCall(MockSwapper.gasSwapToSender, (address(usdc), _gasPull, _gasEthOut));
        _r.swapCalldata = abi.encodeCall(MockSwapper.reshieldBridge, (address(usdc), _mainPull, _mainEthRefund));
    }

    /// Was the "realistic attack shape" pre-fix: gas swap eats only the residual, main leg
    /// still pulls the full entitlement, attacker walks away with the residual's ETH value.
    /// Post-fix: the floor invariant catches the resulting balance dip and reverts.
    function test_RevertWhen_GasSwapDrainsResidual() public {
        uint256 _residual = 500_000; // 0.5 USDC stranded (e.g. a failed bridge refund)
        usdc.mint(address(relaySwaps), _residual);

        uint256 _withdraw = 1_000_000; // attacker's own note, 1 USDC
        usdc.mint(address(pool), _withdraw);

        uint256 _lzFee = 0.001 ether;

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: _lzFee,
            _gasPull: _residual, // pull EXACTLY the stranded balance
            _gasMaxInput: _residual,
            _gasEthOut: 0.0015 ether,
            _mainPull: _withdraw, // main leg still tries to pull the FULL entitlement
            _mainEthRefund: 0,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        vm.expectRevert(RelaySwaps.RelaySwaps_InputBalanceDeficit.selector);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));

        // Residual is untouched — the whole tx reverted.
        assertEq(usdc.balanceOf(address(relaySwaps)), _residual, "residual must survive the reverted attack");
    }

    /// SDK-realistic fixture ratio (gasSwapMaxInput = 3_697_477 on a 24_800_000 net) still
    /// gets caught, because the fix does not depend on the size of gasSwapMaxInput at all.
    function test_RevertWhen_SDKSizedBoundStillDrainsResidual() public {
        uint256 _residual = 10_000_000; // 10 USDC stranded
        usdc.mint(address(relaySwaps), _residual);
        uint256 _withdraw = 24_800_000; // real fixture net
        usdc.mint(address(pool), _withdraw);
        uint256 _slice = 3_697_477; // real fixture gasSwapMaxInput

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 1_413_630_639_549_204,
            _gasPull: _slice,
            _gasMaxInput: _slice,
            _gasEthOut: 2 ether,
            _mainPull: _withdraw,
            _mainEthRefund: 0,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        vm.expectRevert(RelaySwaps.RelaySwaps_InputBalanceDeficit.selector);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));
    }

    /// Control: with NO residual, the honest-shaped call (gas swap consumes exactly what the
    /// withdrawal covers, main leg pulls the rest) still succeeds — the fix must not regress
    /// legitimate B2 usage where the SDK correctly sizes both legs against the same withdrawal.
    function test_HonestFlow_GasSwapAndMainLegShareTheSameWithdrawal_StillSucceeds() public {
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        uint256 _gasSlice = 150_000; // funded out of the withdrawal itself, not a residual
        uint256 _mainPull = _withdraw - _gasSlice; // SDK correctly reduces the main leg

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 0.001 ether,
            _gasPull: _gasSlice,
            _gasMaxInput: _gasSlice,
            _gasEthOut: 0.001 ether,
            _mainPull: _mainPull,
            _mainEthRefund: 0,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));

        assertEq(usdc.balanceOf(address(relaySwaps)), 0, "no leftover, no deficit");
    }

    /// Defense-in-depth: gasSwapMaxInput requested one unit above this withdrawal's own net
    /// proceeds must revert on the new bound, before the gas swap ever runs.
    function test_RevertWhen_GasSwapMaxInputExceedsWithdrawal() public {
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 0.001 ether,
            _gasPull: 1, // irrelevant — the require reverts before this ever runs
            _gasMaxInput: _withdraw + 1, // one unit over _amount - feeAmount (feeAmount == 0)
            _gasEthOut: 0.001 ether,
            _mainPull: 0,
            _mainEthRefund: 0,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        vm.expectRevert(RelaySwaps.RelaySwaps_GasSwapMaxInputExceedsWithdrawal.selector);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));
    }

    /// Boundary: gasSwapMaxInput == _amount - feeAmount exactly must still pass — the bound
    /// is inclusive (<=), matching an honest SDK sizing the gas leg at up to the full net.
    function test_GasSwapMaxInputEqualsWithdrawal_StillSucceeds() public {
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 0.001 ether,
            _gasPull: _withdraw, // gas swap consumes the whole net; nothing left for step 10
            _gasMaxInput: _withdraw,
            _gasEthOut: 0.001 ether,
            _mainPull: 0,
            _mainEthRefund: 0,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));

        assertEq(usdc.balanceOf(address(relaySwaps)), 0, "no leftover, no deficit");
    }
}
