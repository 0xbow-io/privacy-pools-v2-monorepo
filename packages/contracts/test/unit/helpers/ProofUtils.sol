// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';

/*///////////////////////////////////////////////////////////////
                        TRANSACT PROOF
//////////////////////////////////////////////////////////////*/

// Maximum array size for fuzzed arrays (fixed size for performance)
uint256 constant MAX_ARRAY_SIZE = 4;

/// @notice Fuzzed public signals for transact proof
/// @dev We fuzz values that go into pubSignals and affect contract validation:
///      - stateRoot, keyRegistryRoot, aspRoot: tested against mocked external state
///      - amountOut, tokenIdOut: affect transfer logic and token ID matching
///      - outputCommitment, nullifierHash: stored in state and emitted in events
///
///      We dont fuzz:
///      - pA, pB, pC: verifier is mocked, focus on contract logic not cryptographic validity
///      - caller, asset: not part of proof signals, fuzzed separately when needed
///
///      Arrays are fixed-size [4] for performance. Use length parameters to trim them.
struct TransactProofParams {
  uint256 stateRoot;
  uint256 keyRegistryRoot;
  uint256 aspRoot;
  uint256 amountOut;
  uint256 outputCommitmentsLength;
  uint256 nullifierHashesLength;
  uint256 tokenIdOut;
  uint256[MAX_ARRAY_SIZE] outputCommitments;
  uint256[MAX_ARRAY_SIZE] nullifierHashes;
}

/// @notice Builds a mock transact proof with provided public signals and context
/// @dev Uses fixed-size arrays that are trimmed to specified lengths for performance.
///      This allows fuzzing different array sizes without the runtime overhead of dynamic arrays.
/// @param _fuzz Fixed-size arrays and other fuzzed parameters
/// @param _params Transaction parameters for context calculation
function buildMockTransactProof(
  TransactProofParams memory _fuzz,
  IPoolVault.TransactParams memory _params,
  IPoolVault.NoteData[] memory _noteData
) pure returns (ProofLibV2.TransactProof memory proof_) {
  // Bound lengths to valid range [0, MAX_ARRAY_SIZE] (bound is not available in free functions)
  _fuzz.outputCommitmentsLength = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
  _fuzz.nullifierHashesLength = _fuzz.nullifierHashesLength % (MAX_ARRAY_SIZE + 1);
  _fuzz.tokenIdOut = _fuzz.tokenIdOut % (uint256(type(uint160).max) + 1);

  // Trim arrays to specified lengths
  uint256[] memory outputCommitments = new uint256[](_fuzz.outputCommitmentsLength);
  for (uint256 i; i < _fuzz.outputCommitmentsLength; ++i) {
    outputCommitments[i] = _fuzz.outputCommitments[i];
  }
  uint256[] memory nullifierHashes = new uint256[](_fuzz.nullifierHashesLength);
  for (uint256 i; i < _fuzz.nullifierHashesLength; ++i) {
    nullifierHashes[i] = _fuzz.nullifierHashes[i];
  }

  uint256 context = uint256(keccak256(abi.encode(_params, _noteData))) % SNARK_SCALAR_FIELD;

  // Dummy proof components - not fuzzed since verifier is mocked
  proof_.pA = [uint256(1), uint256(2)];
  proof_.pB = [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
  proof_.pC = [uint256(7), uint256(8)];

  // Public signals - fuzzed values that affect contract logic
  // Circom order: outputs first (nullifierHashes, outputCommitments), then inputs (scalars)
  proof_.pubSignals = new uint256[][](8);
  proof_.pubSignals[0] = nullifierHashes;
  proof_.pubSignals[1] = outputCommitments;
  proof_.pubSignals[2] = new uint256[](1);
  proof_.pubSignals[2][0] = _fuzz.stateRoot;
  proof_.pubSignals[3] = new uint256[](1);
  proof_.pubSignals[3][0] = _fuzz.keyRegistryRoot;
  proof_.pubSignals[4] = new uint256[](1);
  proof_.pubSignals[4][0] = _fuzz.aspRoot;
  proof_.pubSignals[5] = new uint256[](1);
  proof_.pubSignals[5][0] = _fuzz.amountOut;
  proof_.pubSignals[6] = new uint256[](1);
  proof_.pubSignals[6][0] = _fuzz.tokenIdOut;
  proof_.pubSignals[7] = new uint256[](1);
  proof_.pubSignals[7][0] = context;
}

/// @notice Builds a mock transact proof with dynamic-size commitment and nullifier arrays
/// @dev Used to test asymmetric sizes (e.g., 1 commitment + 2 nullifiers) to catch
///      mutations like `_numCommitments + _numNullifiers` → `_numCommitments * _numNullifiers`
function buildMockTransactProofDynamic(
  uint256[] memory _outputCommitments,
  uint256[] memory _nullifierHashes,
  uint256 _stateRoot,
  uint256 _keyRegistryRoot,
  uint256 _aspRoot,
  uint256 _amountOut,
  uint256 _tokenIdOut,
  IPoolVault.TransactParams memory _params,
  IPoolVault.NoteData[] memory _noteData
) pure returns (ProofLibV2.TransactProof memory proof_) {
  _tokenIdOut = _tokenIdOut % (uint256(type(uint160).max) + 1);

  uint256 context = uint256(keccak256(abi.encode(_params, _noteData))) % SNARK_SCALAR_FIELD;

  proof_.pA = [uint256(1), uint256(2)];
  proof_.pB = [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
  proof_.pC = [uint256(7), uint256(8)];

  proof_.pubSignals = new uint256[][](8);
  proof_.pubSignals[0] = _nullifierHashes;
  proof_.pubSignals[1] = _outputCommitments;
  proof_.pubSignals[2] = new uint256[](1);
  proof_.pubSignals[2][0] = _stateRoot;
  proof_.pubSignals[3] = new uint256[](1);
  proof_.pubSignals[3][0] = _keyRegistryRoot;
  proof_.pubSignals[4] = new uint256[](1);
  proof_.pubSignals[4][0] = _aspRoot;
  proof_.pubSignals[5] = new uint256[](1);
  proof_.pubSignals[5][0] = _amountOut;
  proof_.pubSignals[6] = new uint256[](1);
  proof_.pubSignals[6][0] = _tokenIdOut;
  proof_.pubSignals[7] = new uint256[](1);
  proof_.pubSignals[7][0] = context;
}

/*///////////////////////////////////////////////////////////////
                        DEPOSIT PROOF
//////////////////////////////////////////////////////////////*/

/// @notice Fuzzed public signals for deposit proof
/// @dev We fuzz values that go into pubSignals and affect contract validation:
///      - tokenId: determines which asset is being deposited
///      - value: the deposit amount
///      - outputCommitment: stored in state and emitted in events
///
///      We dont fuzz:
///      - pA, pB, pC: verifier is mocked, focus on contract logic not cryptographic validity
struct DepositProofParams {
  uint256 value;
  uint256 outputCommitment;
  uint256 tokenId;
}

/// @notice Builds a mock deposit proof with specified values
/// @dev Dummy proof components (pA, pB, pC) since verifier is mocked
function buildMockDepositProof(DepositProofParams memory _fuzz) pure returns (ProofLibV2.DepositProof memory proof_) {
  _fuzz.tokenId = _fuzz.tokenId % (uint256(type(uint160).max) + 1);

  // Dummy proof components - not fuzzed since verifier is mocked
  proof_.pA = [uint256(1), uint256(2)];
  proof_.pB = [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
  proof_.pC = [uint256(7), uint256(8)];

  // Public signals: [outputCommitment, tokenId, value] (Circom order: outputs first, then inputs)
  proof_.pubSignals[0] = _fuzz.outputCommitment;
  proof_.pubSignals[1] = _fuzz.tokenId;
  proof_.pubSignals[2] = _fuzz.value;
}

/*///////////////////////////////////////////////////////////////
                        RAGEQUIT PROOF
//////////////////////////////////////////////////////////////*/

/// @notice Fuzzed public signals for ragequit proof
/// @dev We fuzz values that go into pubSignals and affect contract validation:
///      - keystoreRoot: tested against mocked external state
///      - ownerAddress: must match msg.sender for ragequit to succeed
///      - value, tokenId: affect transfer logic and token ID matching
///      - label: exposed for ASP tracking, emitted in events
///      - nullifierHash: stored in state to prevent double-spending
///      - commitment: checked against state tree for existence
///
///      We dont fuzz:
///      - pA, pB, pC: verifier is mocked, focus on contract logic not cryptographic validity
struct RagequitProofParams {
  uint256 keystoreRoot;
  address ownerAddress;
  uint256 value;
  uint256 tokenId;
  uint256 label;
  uint256 nullifierHash;
  uint256 commitment;
}

/// @notice Builds a mock ragequit proof with provided public signals
/// @dev Verifier is mocked in tests, so proof components (pA, pB, pC) use dummy values
function buildMockRagequitProof(RagequitProofParams memory _fuzz)
  pure
  returns (ProofLibV2.RagequitProof memory proof_)
{
  _fuzz.tokenId = _fuzz.tokenId % (uint256(type(uint160).max) + 1);
  // Ragequit rejects zero-value notes;
  // Tests that need value == 0 should override `proof_.pubSignals[4]` directly.
  if (_fuzz.value == 0) _fuzz.value = 1;

  // Dummy proof components - not fuzzed since verifier is mocked
  proof_.pA = [uint256(1), uint256(2)];
  proof_.pB = [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
  proof_.pC = [uint256(7), uint256(8)];

  // Public signals - fuzzed values that affect contract logic
  // Circom order: outputs first (nullifierHash, commitment), then inputs
  proof_.pubSignals[0] = _fuzz.nullifierHash;
  proof_.pubSignals[1] = _fuzz.commitment;
  proof_.pubSignals[2] = _fuzz.keystoreRoot;
  proof_.pubSignals[3] = uint256(uint160(_fuzz.ownerAddress));
  proof_.pubSignals[4] = _fuzz.value;
  proof_.pubSignals[5] = _fuzz.tokenId;
  proof_.pubSignals[6] = _fuzz.label;
}
