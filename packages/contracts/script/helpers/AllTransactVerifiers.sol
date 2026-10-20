// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {CommonBase} from 'forge-std/Base.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';

/// @notice Deploys the 25 snarkjs transact verifiers (1x1..5x5) and builds their router configs
/// @dev The verifiers are GPL-3.0, so they are deployed from the artifacts compiled by
///      `src/verifiers/VerifierArtifacts.sol` instead of importing their source here.
///      Exactly one CREATE per verifier, in 1x1..5x5 order, so CREATE-nonce predictions are unchanged.
abstract contract AllTransactVerifiers is CommonBase {
  function _allTransactVerifiers() internal returns (ITransactVerifierRouter.VerifierConfig[] memory _allVerifiers) {
    _allVerifiers = new ITransactVerifierRouter.VerifierConfig[](25);
    uint256 _index;
    for (uint8 _n = 1; _n <= 5; _n++) {
      for (uint8 _m = 1; _m <= 5; _m++) {
        _allVerifiers[_index++] = ITransactVerifierRouter.VerifierConfig({
          n: _n, m: _m, verifier: ITransactVerifierRouter.Verifier(vm.deployCode(_artifact(_n, _m)), _selector(_n, _m))
        });
      }
    }
  }

  /// @dev Artifact id of the NxM verifier handle, e.g. `VerifierArtifacts.sol:Transact2x3Verifier`
  function _artifact(uint8 _n, uint8 _m) private pure returns (string memory) {
    // solhint-disable-next-line named-parameters-function
    return string.concat('VerifierArtifacts.sol:Transact', vm.toString(_n), 'x', vm.toString(_m), 'Verifier');
  }

  /// @dev `verifyProof` selector of the NxM verifier: N nullifiers + M commitments + 6 fixed public signals
  function _selector(uint8 _n, uint8 _m) private pure returns (bytes4) {
    string memory _signals = vm.toString(uint256(_n) + _m + 6);
    return
      bytes4(
        keccak256(bytes(string.concat('verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[', _signals, '])')))
      );
  }
}
