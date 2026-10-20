// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Initializable} from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';
import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
import {stdError} from 'forge-std/StdError.sol';
import {stdError} from 'forge-std/StdError.sol';
import {StdStorage, stdStorage} from 'forge-std/Test.sol';
import {TestUtils} from 'test/unit/helpers/TestUtils.sol';

import {IAccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {IERC165} from '@openzeppelin/contracts/utils/introspection/IERC165.sol';
import {ASPRegistry} from 'contracts/ASPRegistry.sol';
import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {POSTMAN_ROLE, UPGRADER_ROLE} from 'src/utils/RolesConstants.sol';
import {ASPRegistryHarness} from 'test/unit/helpers/ASPRegistryHarness.sol';

contract UnitASPRegistry is TestUtils {
  using stdStorage for StdStorage;

  ASPRegistryHarness internal registry;

  function setUp() external {
    ASPRegistryHarness implementation = new ASPRegistryHarness(IAccessControl(mockAccessRouter));
    ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), '');
    registry = ASPRegistryHarness(address(proxy));
    registry.initialize();
  }

  /*///////////////////////////////////////////////////////////////
                      Constructor
  ///////////////////////////////////////////////////////////////*/
  function test_Constructor_WhenAccessRouterIsInvalid(address _accessRouter) external {
    assumeNotPrecompile(_accessRouter);
    assumeNotForgeAddress(_accessRouter);
    vm.mockCall(
      _accessRouter, abi.encodeCall(IERC165.supportsInterface, (type(IAccessControl).interfaceId)), abi.encode(false)
    );
    vm.expectRevert(IPermissioned.Permissioned_InvalidAccessRouter.selector);
    new ASPRegistry(IAccessControl(_accessRouter));
  }

  function test_Constructor_WhenCalled(address newAccessRouter) external {
    // it sets the access router
    _mockAccessRouter(newAccessRouter);
    ASPRegistry implementation_ = new ASPRegistry(IAccessControl(newAccessRouter));
    assertEq(address(implementation_.ACCESS_ROUTER()), newAccessRouter);
  }

  /*///////////////////////////////////////////////////////////////
                              initialize
  //////////////////////////////////////////////////////////////*/

  /// @dev no need to use the handler since we don't need any of its methods
  function test_Initialize_WhenCalledOnTheImplementation(address _caller) external {
    // It should revert with InvalidInitialization, since the constructor disabled initializers
    ASPRegistry implementation = new ASPRegistry(IAccessControl(mockAccessRouter));
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    vm.prank(_caller);
    implementation.initialize();
  }

  function test_Initialize_WhenCalledASecondTime(address _caller) external {
    // It should revert with InvalidInitialization
    vm.prank(_caller);
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    registry.initialize();
  }

  /// @dev no need to use the handler since we don't need any of its methods
  function test_Initialize_WhenCalledForTheFirstTime(address _caller, IAccessControl _router) external {
    _mockAccessRouter(address(_router));
    ASPRegistry implementation_ = new ASPRegistry(_router);
    ASPRegistry registry_ = ASPRegistry(address(new ERC1967Proxy(address(implementation_), '')));
    vm.prank(_caller);
    registry_.initialize();
    // It should keep the address router from the verifier
    assertEq(address(registry_.ACCESS_ROUTER()), address(_router));
  }

  /*///////////////////////////////////////////////////////////////
                          _authorizeUpgrade
  //////////////////////////////////////////////////////////////*/

  function test__authorizeUpgrade_WhenCallerDoesNotHaveUPGRADER_ROLEInAccessRouter(
    address _caller,
    address _implementation
  ) external {
    // It should query access router for the upgrader role
    _mockExpectHasRole(UPGRADER_ROLE, _caller, false);
    vm.prank(_caller);
    // It should revert with Permissioned_NotAuthorized
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    registry.authorizeUpgrade(_implementation);
  }

  function test__authorizeUpgrade_WhenCallerHasUPGRADER_ROLEInAccessRouter(
    address _caller,
    address _implementation
  ) external {
    // It should query access router for the upgrader role
    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);
    vm.prank(_caller);
    // It should succeed
    registry.authorizeUpgrade(_implementation);
  }

  /*///////////////////////////////////////////////////////////////
                            latestASPRoot
  //////////////////////////////////////////////////////////////*/

  function test_LatestASPRoot_WhenAssociationSetsIsEmpty(address _caller) external {
    // It should revert with ASPRegistry_EmptyAssociationSet
    vm.expectRevert(IASPRegistry.ASPRegistry_EmptyAssociationSet.selector);
    vm.prank(_caller);
    registry.latestASPRoot();
  }

  function test_LatestASPRoot_WhenAssociationSetHasOneElement(
    uint256 _root,
    bytes memory _ipfsCID,
    address _caller
  ) external {
    // Add one element to the association set
    registry.addAssociationSet(_root, _ipfsCID);

    // It should return said element
    vm.prank(_caller);
    uint256 latestRoot = registry.latestASPRoot();
    assertEq(latestRoot, _root);
  }

  function test_LatestASPRoot_WhenAssociationSetHasManyElements(
    uint256[256] memory _roots,
    bytes[256] memory _ipfsCIDs,
    uint8 _limit,
    address _caller
  ) external {
    vm.assume(_limit > 0);
    // Add multiple elements to the association set
    for (uint256 i = 0; i < _limit; i++) {
      registry.addAssociationSet(_roots[i], _ipfsCIDs[i]);
    }

    // It should return the last one
    vm.prank(_caller);
    uint256 latestRoot = registry.latestASPRoot();
    assertEq(latestRoot, _roots[_limit - 1]);
  }

  /*///////////////////////////////////////////////////////////////
                            latestIPFSCID
  //////////////////////////////////////////////////////////////*/

  function test_LatestIPFSCID_WhenAssociationSetsIsEmpty(address _caller) external {
    // It should revert with ASPRegistry_EmptyAssociationSet
    vm.expectRevert(IASPRegistry.ASPRegistry_EmptyAssociationSet.selector);
    vm.prank(_caller);
    registry.latestIPFSCID();
  }

  function test_LatestIPFSCID_WhenAssociationSetHasOneElement(
    uint256 _root,
    bytes memory _ipfsCID,
    address _caller
  ) external {
    // Add one element to the association set
    registry.addAssociationSet(_root, _ipfsCID);

    // It should return said element
    vm.prank(_caller);
    bytes memory _latestCID = registry.latestIPFSCID();
    assertEq(_latestCID, _ipfsCID);
  }

  function test_LatestIPFSCID_WhenAssociationSetHasManyElements(
    uint256[256] memory _roots,
    bytes[256] memory _ipfsCIDs,
    uint8 _limit,
    address _caller
  ) external {
    vm.assume(_limit > 0);
    // Add multiple elements to the association set
    for (uint256 i = 0; i < _limit; i++) {
      registry.addAssociationSet(_roots[i], _ipfsCIDs[i]);
    }

    // It should return the last one
    vm.prank(_caller);
    bytes memory _latestCID = registry.latestIPFSCID();
    assertEq(_latestCID, _ipfsCIDs[_limit - 1]);
  }

  /*///////////////////////////////////////////////////////////////
                            associationSets
  //////////////////////////////////////////////////////////////*/

  /// @dev not bothering with custom error or good fuzzing since it's just a
  /// getter that can't be made automatically, since the one generated by making
  /// it 'public' would return a tuple
  function test_AssociationSets_WhenCalledOnANon_existantIndex(uint256 _index, address _caller) external {
    // It should revert with an out of bounds panic
    vm.prank(_caller);
    vm.expectRevert(stdError.indexOOBError);
    registry.associationSets(_index);
  }

  function test_AssociationSets_WhenCalledOnAValidIndex(
    uint256[5] memory _roots,
    bytes[5] memory _ipfsCIDs,
    uint256 _index,
    address _caller
  ) external {
    _index = bound(_index, 0, _roots.length - 1);
    // It should return the set value
    // Add multiple elements to the association set
    for (uint256 i = 0; i < _roots.length; i++) {
      registry.addAssociationSet(_roots[i], _ipfsCIDs[i]);
    }
    vm.prank(_caller);
    IASPRegistry.AssociationSetData memory data = registry.associationSets(_index);
    assertEq(data.root, _roots[_index]);
    assertEq(data.ipfsCID, _ipfsCIDs[_index]);
  }

  /*///////////////////////////////////////////////////////////////
                            updateASPRoot
  //////////////////////////////////////////////////////////////*/

  function test_UpdateASPRoot_WhenCallerDoesNotHavePOSTMAN_ROLE(
    address _caller,
    uint256 _root,
    bytes memory _ipfsCID
  ) external {
    _root = bound(_root, 1, SNARK_SCALAR_FIELD - 1);
    vm.assume(_ipfsCID.length > 0);
    _mockExpectHasRole(POSTMAN_ROLE, _caller, false);

    // It should revert with Permissioned_NotAuthorized
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    vm.prank(_caller);
    registry.updateASPRoot(_root, _ipfsCID);
  }

  function test_UpdateASPRoot_WhenRootIsZero(bytes memory _ipfsCID, address _caller) external {
    _mockExpectHasRole(POSTMAN_ROLE, _caller, true);
    vm.assume(_ipfsCID.length > 0);

    // It should revert with ASPRegistry_EmptyASPRoot
    vm.expectRevert(IASPRegistry.ASPRegistry_EmptyASPRoot.selector);
    vm.prank(_caller);
    registry.updateASPRoot(0, _ipfsCID);
  }

  function test_UpdateASPRoot_WhenRootIsOutOfField(uint256 _root, bytes memory _ipfsCID, address _caller) external {
    _root = bound(_root, SNARK_SCALAR_FIELD, type(uint256).max);
    vm.assume(_ipfsCID.length > 0);
    _mockExpectHasRole(POSTMAN_ROLE, _caller, true);

    vm.expectRevert(IASPRegistry.ASPRegistry_RootOutOfField.selector);
    vm.prank(_caller);
    registry.updateASPRoot(_root, _ipfsCID);
  }

  function test_UpdateASPRoot_WhenIpfsCIDIsZero(uint256 _root, address _caller) external {
    _mockExpectHasRole(POSTMAN_ROLE, _caller, true);
    _root = bound(_root, 1, SNARK_SCALAR_FIELD - 1);

    // It should revert with ASPRegistry_EmptyIPFSCID
    vm.expectRevert(IASPRegistry.ASPRegistry_EmptyIPFSCID.selector);
    vm.prank(_caller);
    registry.updateASPRoot(_root, '');
  }

  function test_UpdateASPRoot_WhenPreconditionsAreMet(address _caller, uint256 _root, bytes memory _ipfsCID) external {
    _root = bound(_root, 1, SNARK_SCALAR_FIELD - 1);
    vm.assume(_ipfsCID.length > 0);

    // It queries the mockAccessRouter for the role of the caller
    _mockExpectHasRole(POSTMAN_ROLE, _caller, true);

    // It emits an ASPRootUpdated event
    vm.expectEmit();
    emit IASPRegistry.ASPRootUpdated(_root, _ipfsCID);

    vm.prank(_caller);
    registry.updateASPRoot(_root, _ipfsCID);

    // It inserts the root and ipfsCID into the associationSets array
    IASPRegistry.AssociationSetData memory data = registry.associationSets(0);
    assertEq(data.root, _root);
    assertEq(data.ipfsCID, _ipfsCID);
  }

  /*///////////////////////////////////////////////////////////////
                            registerLabel
  //////////////////////////////////////////////////////////////*/

  function test_RegisterLabel_WhenCalled(address _caller, bytes memory _ciphertext) external {
    // It should emit a LabelRegistered event
    vm.expectEmit();
    emit IASPRegistry.LabelRegistered(_ciphertext);

    vm.prank(_caller);
    registry.registerLabel(_ciphertext);
  }
}
