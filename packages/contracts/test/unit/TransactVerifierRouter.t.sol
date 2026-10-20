// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Initializable} from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';

import {IGroth16Verifier} from 'interfaces/IGroth16Verifier.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';
import {ITransact2x3Verifier} from 'test/unit/helpers/ITransact2x3Verifier.sol';
import {TestUtils} from 'test/unit/helpers/TestUtils.sol';
import {TransactVerifierRouterHarness} from 'test/unit/helpers/TransactVerifierRouterHarness.sol';
import {UPGRADER_ROLE} from 'utils/RolesConstants.sol';

contract UnitTransactVerifierRouter is TestUtils {
  struct TransactVerifierRouterFuzzParams {
    IGroth16Verifier.Proof proof;
    uint256[6] fixedPubSignals; // stateRoot; keystoreRoot; aspRoot; amountOut; tokenId; context;
    uint8 n;
    uint8 m;
    address verifierAddr;
    bytes4 selector;
    address caller;
    bool verifierResult;
    uint256[512] randomSeed;
  }

  TransactVerifierRouterHarness internal router;
  TransactVerifierRouterHarness internal implementation;

  function setUp() external {
    implementation = new TransactVerifierRouterHarness(IAccessControl(mockAccessRouter));
    ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), '');
    router = TransactVerifierRouterHarness(address(proxy));
    router.initialize(new ITransactVerifierRouter.VerifierConfig[](0));
  }

  /*///////////////////////////////////////////////////////////////
                  initializeTransactVerifierRouter
  ///////////////////////////////////////////////////////////////*/

  function test_InitializeTransactVerifierRouter_WhenCalledOnTheImplementation() external {
    ITransactVerifierRouter.VerifierConfig[] memory _configs = new ITransactVerifierRouter.VerifierConfig[](0);
    // It should revert with InvalidInitialization
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    implementation.initialize(_configs);
  }

  function test_InitializeTransactVerifierRouter_GivenAlreadyInitialized() external {
    ITransactVerifierRouter.VerifierConfig[] memory _configs = new ITransactVerifierRouter.VerifierConfig[](0);
    // It should revert with InvalidInitialization
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    router.initialize(_configs);
  }

  modifier givenNotInitialized(TransactVerifierRouterHarness _router) {
    _;
  }

  /// @dev this also covers the case where there are zero verifiers
  function test_InitializeTransactVerifierRouter_WhenCalledWithValidVerifierConfigs(
    ITransactVerifierRouter.VerifierConfig[] memory _verifiers,
    address _caller
  ) external {
    _boundVerifierConfig(_verifiers);
    ERC1967Proxy _proxy = new ERC1967Proxy(address(implementation), '');
    TransactVerifierRouterHarness _newRouter = TransactVerifierRouterHarness(address(_proxy));

    // It should emit VerifierConfigured for each
    for (uint256 i = 0; i < _verifiers.length; i++) {
      vm.expectEmit(address(_newRouter));
      emit ITransactVerifierRouter.VerifierConfigured(
        _verifiers[i].n, _verifiers[i].m, _verifiers[i].verifier.addr, _verifiers[i].verifier.selector
      );
    }

    // ensure the access control is not used in initialize
    vm.prank(_caller);
    _newRouter.initialize(_verifiers);

    // It should configure all verifiers
    for (uint256 i = 0; i < _verifiers.length; i++) {
      bytes32 _key = keccak256(abi.encode(uint256(_verifiers[i].n), uint256(_verifiers[i].m)));
      ITransactVerifierRouter.Verifier memory _stored = _newRouter.verifiers(_key);
      assertEq(_stored.addr, _verifiers[i].verifier.addr);
      assertEq(_stored.selector, _verifiers[i].verifier.selector);
    }
  }

  /*///////////////////////////////////////////////////////////////
                          setVerifier
  ///////////////////////////////////////////////////////////////*/

  function test_SetVerifier_GivenCallerDoesNotHaveUPGRADERRole(
    address _caller,
    uint8 _n,
    uint8 _m,
    address _verifier,
    bytes4 _selector
  ) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, false);

    // It should revert with Permissioned_NotAuthorized
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    vm.prank(_caller);
    router.setVerifier(_n, _m, ITransactVerifierRouter.Verifier(_verifier, _selector));
  }

  modifier givenCallerHasUPGRADERRole(address _caller) {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);
    _;
  }

  function test_SetVerifier_WhenSpentNullifierCountIsZero(
    address _caller,
    uint8 _m,
    address _verifier,
    bytes4 _selector
  ) external givenCallerHasUPGRADERRole(_caller) {
    _m = uint8(bound(_m, 1, type(uint8).max));
    // it should revert with TransactVerifierRouter_InvalidZeroParameter
    vm.expectRevert(ITransactVerifierRouter.TransactVerifierRouter_InvalidZeroParameter.selector);
    vm.prank(_caller);
    router.setVerifier(0, _m, ITransactVerifierRouter.Verifier(_verifier, _selector));
  }

  function test_SetVerifier_WhenNewCommitmentCountIsZero(
    address _caller,
    uint8 _n,
    address _verifier,
    bytes4 _selector
  ) external givenCallerHasUPGRADERRole(_caller) {
    _n = uint8(bound(_n, 1, type(uint8).max));
    // it should revert with TransactVerifierRouter_InvalidZeroParameter
    vm.expectRevert(ITransactVerifierRouter.TransactVerifierRouter_InvalidZeroParameter.selector);
    vm.prank(_caller);
    router.setVerifier(_n, 0, ITransactVerifierRouter.Verifier(_verifier, _selector));
  }

  function test_SetVerifier_WhenSelectorValueIsCorrect(
    address _caller,
    uint8 _n,
    uint8 _m,
    address _verifier
  ) external givenCallerHasUPGRADERRole(_caller) {
    _n = uint8(bound(_n, 1, type(uint8).max));
    _m = uint8(bound(_m, 1, type(uint8).max));

    bytes4 _selector = bytes4(
      keccak256(
        bytes(
          string.concat(
            'verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[', vm.toString(uint256(_n) + _m + 6), '])'
          )
        )
      )
    );
    // it should emit the VerifierConfigured event
    vm.expectEmit(address(router));
    emit ITransactVerifierRouter.VerifierConfigured(_n, _m, _verifier, _selector);

    vm.prank(_caller);
    router.setVerifier(_n, _m, ITransactVerifierRouter.Verifier(_verifier, _selector));

    // it should populate the keccak(N,M) key
    bytes32 _key = keccak256(abi.encode(_n, _m));
    ITransactVerifierRouter.Verifier memory _stored = router.verifiers(_key);

    // it should save the contract address
    assertEq(_stored.addr, _verifier);

    // it should save the selector to be called
    assertEq(_stored.selector, _selector);

    // it should NOT populate the keccak(M,N) key
    // this does not apply when M==N, obviously
    if (_n == _m) return;

    bytes32 _reverseKey = keccak256(abi.encode(_m, _n));
    ITransactVerifierRouter.Verifier memory _reverse = router.verifiers(_reverseKey);
    assertEq(_reverse.addr, address(0));
    assertEq(_reverse.selector, bytes4(0));
  }

  /*///////////////////////////////////////////////////////////////
                          verifyProof
  ///////////////////////////////////////////////////////////////*/

  function test_VerifyProof_WhenCalledWithANon_existingVerifier(TransactVerifierRouterFuzzParams memory _params)
    external
  {
    (uint256[] memory _nullifiers, uint256[] memory _commitments) =
      _fillArrays(_params.randomSeed, _params.n, _params.m);

    // it should revert with TransactVerifierRouter_UnsupportedCircuitConfiguration
    vm.expectRevert(
      abi.encodeWithSelector(
        ITransactVerifierRouter.TransactVerifierRouter_UnsupportedCircuitConfiguration.selector, _params.n, _params.m
      )
    );
    router.exposed_verifyProof(
      TransactVerifierRouterHarness.VerifyProofParams(_params.proof, _params.fixedPubSignals, _nullifiers, _commitments)
    );
  }

  modifier whenCalledWithAnExistingVerifier(uint256 _n, uint256 _m, address _verifierAddr, bytes4 _selector) {
    assumeNotPrecompile(_verifierAddr);
    assumeNotForgeAddress(_verifierAddr);
    assumeNotZeroAddress(_verifierAddr);
    _setVerifier(_n, _m, _verifierAddr, _selector);
    _;
  }

  function test_VerifyProof_WhenVerifierReverts(
    TransactVerifierRouterFuzzParams memory _params,
    bytes memory _revertData
  ) external whenCalledWithAnExistingVerifier(_params.n, _params.m, _params.verifierAddr, _params.selector) {
    (uint256[] memory _nullifiers, uint256[] memory _commitments) =
      _fillArrays(_params.randomSeed, _params.n, _params.m);

    bytes memory _expectedCalldata = _buildExpectedCalldata(_params, _nullifiers, _commitments);

    vm.mockCallRevert(_params.verifierAddr, _expectedCalldata, _revertData);
    // it should revert with TransactVerifierRouter_VerifierCallReverted
    vm.expectRevert(
      abi.encodeWithSelector(ITransactVerifierRouter.TransactVerifierRouter_VerifierCallReverted.selector, _revertData)
    );
    vm.prank(_params.caller);
    router.exposed_verifyProof(
      TransactVerifierRouterHarness.VerifyProofParams(_params.proof, _params.fixedPubSignals, _nullifiers, _commitments)
    );
  }

  function test_VerifyProof_WhenVerifierReturnsAnythingOtherThanABoolean(
    TransactVerifierRouterFuzzParams memory _params,
    bytes memory _returnData
  ) external whenCalledWithAnExistingVerifier(_params.n, _params.m, _params.verifierAddr, _params.selector) {
    // any full word can potentially be decoded into a bool (afaict it's not
    // specified), so let's make sure it fails the size check
    vm.assume(_returnData.length != 32);

    (uint256[] memory _nullifiers, uint256[] memory _commitments) =
      _fillArrays(_params.randomSeed, _params.n, _params.m);
    bytes memory _expectedCalldata = _buildExpectedCalldata(_params, _nullifiers, _commitments);

    _mockAndExpect(_params.verifierAddr, _expectedCalldata, _returnData);
    // it should revert with a Panic in abi.decode
    vm.expectRevert();
    vm.prank(_params.caller);
    router.exposed_verifyProof(
      TransactVerifierRouterHarness.VerifyProofParams(_params.proof, _params.fixedPubSignals, _nullifiers, _commitments)
    );
  }

  function test_VerifyProof_WhenVerifierReturnsABoolean(TransactVerifierRouterFuzzParams memory _params)
    external
    whenCalledWithAnExistingVerifier(_params.n, _params.m, _params.verifierAddr, _params.selector)
  {
    (uint256[] memory _nullifiers, uint256[] memory _commitments) =
      _fillArrays(_params.randomSeed, _params.n, _params.m);

    bytes memory _expectedCalldata = _buildExpectedCalldata(_params, _nullifiers, _commitments);

    // it should call the verifier contract
    _mockAndExpect(_params.verifierAddr, _expectedCalldata, abi.encode(_params.verifierResult));

    vm.prank(_params.caller);
    bool _result = router.exposed_verifyProof(
      TransactVerifierRouterHarness.VerifyProofParams(_params.proof, _params.fixedPubSignals, _nullifiers, _commitments)
    );

    // it should forward the result
    assertEq(_result, _params.verifierResult);
  }

  function test_sanity_check_abi_encoding(
    address _verifier,
    uint256[2] memory _nullifiers,
    uint256[3] memory _commitments,
    IGroth16Verifier.Proof memory _proof,
    uint256[6] memory _fixedPublicSignals,
    bool _success
  ) external whenCalledWithAnExistingVerifier(2, 3, _verifier, ITransact2x3Verifier.verifyProof.selector) {
    uint256[11] memory _pubSignals;
    for (uint256 i = 0; i < 2; i++) {
      _pubSignals[i] = _nullifiers[i];
    }
    for (uint256 i = 0; i < 3; i++) {
      _pubSignals[i + 2] = _commitments[i];
    }
    for (uint256 i = 0; i < 6; i++) {
      _pubSignals[i + 5] = _fixedPublicSignals[i];
    }
    uint256[] memory _nullifiersDynamic = new uint256[](2);
    for (uint256 i = 0; i < 2; i++) {
      _nullifiersDynamic[i] = _nullifiers[i];
    }

    uint256[] memory _commitmentsDynamic = new uint256[](3);
    for (uint256 i = 0; i < 3; i++) {
      _commitmentsDynamic[i] = _commitments[i];
    }

    bytes memory _expectedData =
      abi.encodeCall(ITransact2x3Verifier.verifyProof, (_proof.pA, _proof.pB, _proof.pC, _pubSignals));
    _mockAndExpect(_verifier, _expectedData, abi.encode(_success));
    router.exposed_verifyProof(
      TransactVerifierRouterHarness.VerifyProofParams(
        _proof, _fixedPublicSignals, _nullifiersDynamic, _commitmentsDynamic
      )
    );
  }

  /// @dev it's the same as the test above but calling the actual verifier, in
  /// order to test key computation is consistent between registering a verifier
  /// and using it
  function test_sanity_check_consistent_key_computation(
    address _verifier,
    uint256[2] memory _nullifiers,
    uint256[3] memory _commitments,
    IGroth16Verifier.Proof memory _proof,
    uint256[6] memory _fixedPublicSignals,
    bool _success
  ) external givenCallerHasUPGRADERRole(address(this)) {
    assumeNotPrecompile(_verifier);
    assumeNotForgeAddress(_verifier);
    assumeNotZeroAddress(_verifier);
    router.setVerifier(2, 3, ITransactVerifierRouter.Verifier(_verifier, ITransact2x3Verifier.verifyProof.selector));
    uint256[11] memory _pubSignals;
    for (uint256 i = 0; i < 2; i++) {
      _pubSignals[i] = _nullifiers[i];
    }
    for (uint256 i = 0; i < 3; i++) {
      _pubSignals[i + 2] = _commitments[i];
    }
    for (uint256 i = 0; i < 6; i++) {
      _pubSignals[i + 5] = _fixedPublicSignals[i];
    }
    uint256[] memory _nullifiersDynamic = new uint256[](2);
    for (uint256 i = 0; i < 2; i++) {
      _nullifiersDynamic[i] = _nullifiers[i];
    }

    uint256[] memory _commitmentsDynamic = new uint256[](3);
    for (uint256 i = 0; i < 3; i++) {
      _commitmentsDynamic[i] = _commitments[i];
    }

    bytes memory _expectedData =
      abi.encodeCall(ITransact2x3Verifier.verifyProof, (_proof.pA, _proof.pB, _proof.pC, _pubSignals));
    _mockAndExpect(_verifier, _expectedData, abi.encode(_success));
    router.exposed_verifyProof(
      TransactVerifierRouterHarness.VerifyProofParams(
        _proof, _fixedPublicSignals, _nullifiersDynamic, _commitmentsDynamic
      )
    );
  }

  /*///////////////////////////////////////////////////////////////
                      INTERNAL HELPERS
  ///////////////////////////////////////////////////////////////*/

  function _fillArrays(
    uint256[512] memory _seed,
    uint256 _n,
    uint256 _m
  ) internal pure returns (uint256[] memory nullifiers_, uint256[] memory commitments_) {
    nullifiers_ = new uint256[](_n);
    for (uint256 i = 0; i < _n; i++) {
      nullifiers_[i] = _seed[i];
    }
    commitments_ = new uint256[](_m);
    for (uint256 i = 0; i < _m; i++) {
      commitments_[i] = _seed[i + _n];
    }
  }

  function _setVerifier(uint256 _n, uint256 _m, address _verifierAddr, bytes4 _selector) internal {
    bytes32 _key = keccak256(abi.encode(_n, _m));
    router.exposed_verifiersStorage(_key, ITransactVerifierRouter.Verifier(_verifierAddr, _selector));
  }

  /// @dev Replicates the abi.encodePacked calldata construction from TransactVerifierRouter.verifyProof
  function _buildExpectedCalldata(
    TransactVerifierRouterFuzzParams memory _params,
    uint256[] memory _nullifiers,
    uint256[] memory _commitments
  ) internal pure returns (bytes memory calldata_) {
    calldata_ = abi.encodePacked(
      _params.selector,
      _params.proof.pA,
      _params.proof.pB,
      _params.proof.pC,
      _nullifiers,
      _commitments,
      _params.fixedPubSignals
    );
  }
}
