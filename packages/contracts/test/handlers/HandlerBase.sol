// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {Test} from 'forge-std/Test.sol';
import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';
import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';

import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

/*///////////////////////////////////////////////////////////////
                        TEST DATA TYPES
///////////////////////////////////////////////////////////////*/

/// @notice Groups all parameters that are required for creating a note
/// @dev Meant to reduce stack depth requirements, and keep the tests runnable without via-ir
struct NoteCreationParams {
  uint256 noteSecret;
  uint256 depositSecret;
  uint256 noteAddressHash;
  uint256 value;
  uint256 label;
}

/// @dev Per-note data needed to build a transact proof.
struct Note {
  uint256 value;
  uint256 noteSecret;
  uint256 depositSecret;
  uint256 noteAddressHash;
  uint256 inputLabel;
  uint256 timestamp;
  uint256 tokenId;
  uint256 depositLeaf;
  uint256 outputCommitment;
  uint256 stateLeafIndex;
  uint256 aspLeafIndex;
}

/// @dev Vetting fee: 1% (100 basis points)
uint256 constant VETTING_FEE_BPS = 100;

/// @dev Calculate fee for a given deposit value (1% = 100 BPS)
function _calcFee(uint256 _value) pure returns (uint256) {
  return (_value * VETTING_FEE_BPS) / 10_000;
}

contract HandlerBase is Test {
  using ProofLibV2 for ProofLibV2.DepositProof;
  using TransactProofMemory for ProofLibV2.TransactProof;
  using MerkleTree for MerkleTree.Tree;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  /*///////////////////////////////////////////////////////////////
                        STATE VARIABLES
  ///////////////////////////////////////////////////////////////*/

  /// @dev Default note data (empty discovery data)
  IPoolVault.NoteData internal _defaultNoteData;
  /// @dev Default note metadata. Not changed between tests.
  uint256 internal constant DEFAULT_NOTE_METADATA = 0;

  mapping(uint256 _label => uint256 _index) internal _aspLeafIndexForLabel;

  IAccessControl internal _accessRouter;
  IASPRegistry internal _aspRegistry;
  IEntrypoint internal _entrypoint;
  IKeystore internal _keystore;
  IPoolVault internal _poolVault;
  IPrivacyPoolRelay internal _privacyPoolRelay;
  address internal _postman;

  /// @dev Local mirror trees for Merkle proof generation
  MerkleTree.Tree internal _stateTreeMirror;
  MerkleTree.Tree internal _keystoreTreeMirror;
  MerkleTree.Tree internal _aspTreeMirror;

  /// @dev Nullifiers inserted into `_stateTreeMirror` (for PP2-16 audits in invariant handlers)
  uint256[] internal _trackedNullifierHashes;
  uint256[] internal _trackedNullifierLeafIndices;

  /*///////////////////////////////////////////////////////////////
                      KEYSTORE HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Register a user in the keystore and mirror the leaf into _keystoreTreeMirror
  function _registerInKeystore(
    UserIdentityLib.UserIdentity memory _user
  ) internal returns (UserIdentityLib.UserIdentity memory) {
    vm.prank(_user.addr);
    _keystore.setAuthPolicy(_user.authDigest, _user.nullifyingKeyHash);

    uint256 _keystoreLeaf = PoseidonT4.hash([_user.ownerAddress, _user.nullifyingKeyHash, _user.authDigest]);
    _keystoreTreeMirror.insert(_keystoreLeaf);
    _user.keystoreIndex = _keystoreTreeMirror.size - 1;
    return _user;
  }

  /*///////////////////////////////////////////////////////////////
                      ERC20/ETH COMMON INTERFACE
  ///////////////////////////////////////////////////////////////*/

  /// @dev Asset-agnostic balance check (ETH or ERC20)
  function _balanceOf(address _tokenAddr, address _account) internal view returns (uint256) {
    return _tokenAddr == Constants.NATIVE_ASSET ? _account.balance : SafeTransferLib.balanceOf(_tokenAddr, _account);
  }

  /// @dev Member overload of the file-level `_calcFee` — needed once a token-aware overload
  ///      is also declared on this contract, since contract members shadow free functions
  ///      of the same name during name lookup in derived contracts.
  function _calcFee(uint256 _value) internal pure returns (uint256) {
    return (_value * VETTING_FEE_BPS) / 10_000;
  }

  /// @dev Token-aware fee. Default uses the constant `VETTING_FEE_BPS`; IntegrationBase overrides
  ///      to read the per-chain configured BPS for fork tests.
  function _calcFee(address, uint256 _value) internal view virtual returns (uint256) {
    return (_value * VETTING_FEE_BPS) / 10_000;
  }

  /*///////////////////////////////////////////////////////////////
                      TREE LEAVES HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Compute domain-tagged commitment leaf: Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)
  function _commitmentLeaf(uint256 _commitment) internal view returns (uint256) {
    return PoseidonT4.hash([Constants.COMMITMENT_LEAF_TAG, _commitment, vm.getBlockTimestamp()]);
  }

  /// @dev Compute domain-tagged nullifier leaf: Poseidon(NULLIFIER_LEAF_TAG, nullifierHash, timestamp)
  function _nullifierLeaf(uint256 _nullifierHash) internal view returns (uint256) {
    return PoseidonT4.hash([Constants.NULLIFIER_LEAF_TAG, _nullifierHash, vm.getBlockTimestamp()]);
  }

  function _trackNullifierLeaf(uint256 _nullifierHash, uint256 _leafIndex) internal {
    _trackedNullifierHashes.push(_nullifierHash);
    _trackedNullifierLeafIndices.push(_leafIndex);
  }
}
