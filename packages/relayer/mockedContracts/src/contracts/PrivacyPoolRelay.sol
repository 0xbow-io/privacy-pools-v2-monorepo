// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/VerifierMock.sol';
import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';

contract PrivacyPoolRelay is IPrivacyPoolRelay  {
    using ProofLibV2 for ProofLibV2.TransactProof;
    using SafeTransferLib for address;

    uint256 public maxRelayFee;

    // NOTE from ./utils/Constants.sol
    address internal constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    constructor(uint256 maxFee) {
        // NOTE mocked out
        /* POOL = _pool; */
        /* ENTRYPOINT = _entrypoint; */
        maxRelayFee = maxFee ;
    }

    /// @notice Allows the contract to receive ETH from the pool vault on withdrawal
    receive() external payable {}

    /*///////////////////////////////////////////////////////////////
      EXTERNAL FUNCTIONS
    ///////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPrivacyPoolRelay
    function relay(
                   // NOTE we need amountOut and tokenIdOut
                   ProofLibV2.TransactProof calldata _proof,
                   // NOTE we need .data.FeeSplit
                   IPoolVault.TransactParams calldata _transactParams,
                   // NOTE previously, signature was:
                   /* bytes[] calldata _encryptedPayload */
                   IPoolVault.NoteData[] calldata _noteData
    ) external payable {
        uint256 _withdrawnValue = _proof.amountOut();
        require(_withdrawnValue > 0, PrivacyPoolRelay_ZeroWithdrawal());

        PayoutRouting memory _payout = abi.decode(_transactParams.data, (PayoutRouting));
        address _asset = _proof.tokenIdOut();

        /* uint256 _maxRelayFee = ENTRYPOINT.assets(_asset).maxRelayFee; */
        require(_payout.feeAmount <= maxRelayFee, PrivacyPoolRelay_FeeExceedsMax());
        require(_withdrawnValue >= _payout.feeAmount, PrivacyPoolRelay_FeeExceedsWithdrawal());

        address _feeRecipient = _payout.feeRecipient != address(0) ? _payout.feeRecipient : msg.sender;
        uint256 _recipientAmount = _withdrawnValue - _payout.feeAmount;

        /* POOL.transact(_proof, _transactParams, _noteData); */

        if (_asset == NATIVE_ASSET) {
        _payout.recipient.safeTransferETH(_recipientAmount + msg.value);
        if (_payout.feeAmount != 0) {
            _feeRecipient.safeTransferETH(_payout.feeAmount);
        }
        } else {
        _asset.safeTransfer(_payout.recipient, _recipientAmount);
        if (_payout.feeAmount != 0) {
            _asset.safeTransfer(_feeRecipient, _payout.feeAmount);
        }
        if (msg.value > 0) {
            _payout.recipient.safeTransferETH(msg.value);
        }
        }

        emit Relayed(_asset, _payout.recipient, _recipientAmount, _feeRecipient, _payout.feeAmount, msg.value);
    }

    // NOTE added for testing purposes
    function ping() pure public returns (string memory) {
        return "pong";
    }
}
