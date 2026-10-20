// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

/// @notice Minimal EIP-1271 smart-contract wallet that validates the owner's ECDSA signature
contract MockSmartWallet {
  address public immutable OWNER;

  constructor(address _owner) {
    OWNER = _owner;
  }

  /// @dev Returns the ERC-1271 magic value when `_signature` is a valid owner signature over `_hash`
  function isValidSignature(bytes32 _hash, bytes calldata _signature) external view returns (bytes4) {
    (address _recovered, ECDSA.RecoverError _err,) = ECDSA.tryRecover(_hash, _signature);
    if (_err == ECDSA.RecoverError.NoError && _recovered == OWNER) {
      return 0x1626ba7e;
    }
    return 0xffffffff;
  }
}
