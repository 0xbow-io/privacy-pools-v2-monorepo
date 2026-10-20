// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {IERC165} from '@openzeppelin/contracts/utils/introspection/IERC165.sol';
import {Test} from 'forge-std/Test.sol';

import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';

contract TestUtils is Test {
  bytes internal constant LATEST_ASP_ROOT_SELECTOR = abi.encodeWithSelector(IASPRegistry.latestASPRoot.selector);

  address public mockAccessRouter = makeAddr('mockAccessRouter');
  address public mockAspRegistry = makeAddr('mockAspRegistry');
  address public mockEntrypoint = makeAddr('mockEntrypoint');
  address public mockKeystore = makeAddr('mockKeystore');
  address public mockPoolVault = makeAddr('mockPoolVault');

  constructor() {
    _mockAccessRouterERC165(address(mockAccessRouter));
  }

  address public mockErc20 = makeAddr('mockErc20');

  function _mockAccessRouter(address _router) internal {
    assumeNotPrecompile(_router);
    assumeNotForgeAddress(_router);
    _mockAccessRouterERC165(_router);
  }

  function _mockAccessRouterERC165(address _router) internal {
    // ERC165Checker.supportsERC165 checks: supportsInterface(0x01ffc9a7) == true
    vm.mockCall(_router, abi.encodeCall(IERC165.supportsInterface, (type(IERC165).interfaceId)), abi.encode(true));
    // ERC165Checker.supportsERC165 checks: supportsInterface(0xffffffff) == false
    vm.mockCall(_router, abi.encodeCall(IERC165.supportsInterface, (bytes4(0xffffffff))), abi.encode(false));
    // ERC165Checker.supportsInterface checks: supportsInterface(IAccessControl) == true
    vm.mockCall(
      _router, abi.encodeCall(IERC165.supportsInterface, (type(IAccessControl).interfaceId)), abi.encode(true)
    );
  }

  function _mockExpectHasRole(bytes32 role, address who, bool hasRole) internal {
    _mockAndExpect(mockAccessRouter, abi.encodeCall(IAccessControl.hasRole, (role, who)), abi.encode(hasRole));
  }

  function _mockAndExpect(address target, bytes memory data, bytes memory response) internal {
    vm.mockCall(target, data, response);
    vm.expectCall(target, data);
  }

  function _mockAndExpect(address target, uint256 value, bytes memory data, bytes memory response) internal {
    // Register a generic (any-value) behavior mock so a codeless `makeAddr` target is callable: a
    // value-keyed `vm.mockCall` alone does NOT make a no-code address callable in foundry 1.4.1
    // (the forwarded call reverts `call to non-contract address` before the mock resolves). The
    // value-keyed `vm.expectCall` below still asserts the exact `msg.value` was forwarded, so the
    // value assertion is preserved and the test remains version-robust.
    vm.mockCall(target, data, response);
    vm.expectCall(target, value, data);
  }

  function _mockAndExpectRevert(address target, bytes memory data, bytes memory revertData) internal {
    vm.mockCallRevert(target, data, revertData);
    vm.expectCall(target, data);
  }

  /// @dev it's important that we don't allow the setting array to set the same
  /// key twice, since we also use the config array to assert, and the first
  /// assertion will fail, given that being able to override verifiers is a
  /// feature of the TransactVerifierRouter
  function _boundVerifierConfig(ITransactVerifierRouter.VerifierConfig[] memory _configs) internal pure {
    for (uint256 i = 0; i < _configs.length; i++) {
      _configs[i].n = uint8(bound(_configs[i].n, 1, type(uint8).max));
      _configs[i].m = uint8(bound(_configs[i].m, 1, type(uint8).max));
      for (uint256 j = 0; j < i; j++) {
        // don't allow the same key twice in the array
        vm.assume(_configs[i].n != _configs[j].n || _configs[i].m != _configs[j].m);
      }
    }
  }
}
