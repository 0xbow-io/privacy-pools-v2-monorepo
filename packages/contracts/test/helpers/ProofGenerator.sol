// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Vm} from 'forge-std/Vm.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';

/// @notice Helper library to generate ZK proofs via FFI
/// @dev Calls the generators in packages/contracts/test/helper/*.mjs
library ProofGenerator {
  Vm private constant VM = Vm(address(uint160(uint256(keccak256('hevm cheat code')))));

  /// @dev Circuit tree depth limits (from circuits.json compilation output).
  ///      These determine sibling array padding for Merkle proofs.
  uint256 internal constant STATE_MAX_DEPTH = 22;
  uint256 internal constant KEYSTORE_MAX_DEPTH = 18;
  uint256 internal constant ASP_MAX_DEPTH = 18;

  /*///////////////////////////////////////////////////////////////
                              DEPOSIT
  ///////////////////////////////////////////////////////////////*/

  /// @notice Generate a deposit proof with the given inputs via FFI
  /// @param _token The token address
  /// @param _value The deposit amount
  /// @param _noteAddressHash Poseidon(ownerAddress, noteSecret)
  /// @param _depositSecret Random secret for label computation
  /// @param _context context field binding the proof to the parameters
  /// @return proof_ The generated deposit proof
  function generateDepositProof(
    address _token,
    uint256 _value,
    uint256 _noteAddressHash,
    uint256 _depositSecret,
    uint256 _context
  ) internal returns (ProofLibV2.DepositProof memory proof_) {
    string memory json = string.concat(
      '{"tokenId":"',
      VM.toString(uint256(uint160(_token))),
      '","value":"',
      VM.toString(_value),
      '","noteAddressHash":"',
      VM.toString(_noteAddressHash),
      '","depositSecret":"',
      VM.toString(_depositSecret),
      '","context":"',
      VM.toString(_context),
      '"}'
    );

    string[] memory inputs = new string[](3);
    inputs[0] = 'node';
    inputs[1] = 'test/helper/DepositProofGenerator.mjs';
    inputs[2] = json;

    bytes memory result = VM.ffi(inputs);
    (proof_) = abi.decode(result, (ProofLibV2.DepositProof));

    // Sanity check: verify public signals match the inputs
    require(proof_.pubSignals[1] == uint256(uint160(_token)), 'ProofGenerator: tokenId mismatch');
    require(proof_.pubSignals[2] == _value, 'ProofGenerator: value mismatch');
  }

  /// @notice Generate a deposit proof accepting a raw uint256 tokenId (allows non-canonical values for testing)
  function generateDepositProof(
    uint256 _tokenId,
    uint256 _value,
    uint256 _noteAddressHash,
    uint256 _depositSecret,
    uint256 _context
  ) internal returns (ProofLibV2.DepositProof memory proof_) {
    string memory json = string.concat(
      '{"tokenId":"',
      VM.toString(_tokenId),
      '","value":"',
      VM.toString(_value),
      '","noteAddressHash":"',
      VM.toString(_noteAddressHash),
      '","depositSecret":"',
      VM.toString(_depositSecret),
      '","context":"',
      VM.toString(_context),
      '"}'
    );

    string[] memory inputs = new string[](3);
    inputs[0] = 'node';
    inputs[1] = 'test/helper/DepositProofGenerator.mjs';
    inputs[2] = json;

    bytes memory result = VM.ffi(inputs);
    (proof_) = abi.decode(result, (ProofLibV2.DepositProof));

    require(proof_.pubSignals[1] == _tokenId, 'ProofGenerator: tokenId mismatch');
    require(proof_.pubSignals[2] == _value, 'ProofGenerator: value mismatch');
  }

  /*///////////////////////////////////////////////////////////////
                              TRANSACT
  ///////////////////////////////////////////////////////////////*/

  /// @dev Mirrors the JSON input expected by TransactProofGenerator.mjs
  struct TransactInputs {
    uint256 nInputs;
    uint256 mOutputs;
    // Public inputs
    uint256 stateRoot;
    uint256 keystoreRoot;
    uint256 associationSetRoot;
    uint256 amountOut;
    uint256 tokenIdOut;
    uint256 context;
    // Authorization
    uint256 ownerAddress;
    uint256 privateNullifyingKey;
    uint256 privateRevocableKey;
    uint256 keystoreLeafIndex;
    uint256[] keystoreSiblings;
    uint256 keystoreTreeDepth;
    // Input notes
    uint256[] noteSecret;
    uint256[] value;
    uint256[] label;
    uint256 tokenId;
    uint256[] stateLeafIndex;
    uint256[][] stateSiblings;
    uint256[] stateTreeDepth;
    uint256[] associationSetLeafIndex;
    uint256[][] associationSetSiblings;
    uint256[] associationSetTreeDepth;
    uint256[] timestamp;
    // Output notes
    uint256[] outputNoteAddressHash;
    uint256[] outputValue;
    uint256[] outputLabel;
  }

  /// @notice Generate a transact proof via FFI using the existing TransactProofGenerator.mjs
  /// @param _inputs All circuit inputs (public + private + Merkle data)
  /// @return proof_ The generated transact proof
  function generateTransactProof(TransactInputs memory _inputs)
    internal
    returns (ProofLibV2.TransactProof memory proof_)
  {
    string memory json = _buildTransactJson(_inputs);
    string memory circuitName =
      string.concat('transact_', VM.toString(_inputs.nInputs), 'x', VM.toString(_inputs.mOutputs));

    string[] memory cmd = new string[](4);
    cmd[0] = 'node';
    cmd[1] = 'test/helper/TransactProofGenerator.mjs';
    cmd[2] = circuitName;
    cmd[3] = json;

    bytes memory result = VM.ffi(cmd);
    (proof_) = abi.decode(result, (ProofLibV2.TransactProof));

    // 2 (nullifierHashes + outputCommitments) + 6 fixed public inputs = always 8 rows
    require(proof_.pubSignals.length == 8, 'ProofGenerator: wrong pubSignals length');
    require(proof_.pubSignals[0].length == _inputs.nInputs, 'ProofGenerator: nullifierHashes mismatch');
    require(proof_.pubSignals[1].length == _inputs.mOutputs, 'ProofGenerator: outputCommitments mismatch');
  }

  /*///////////////////////////////////////////////////////////////
                              RAGEQUIT
  ///////////////////////////////////////////////////////////////*/

  /// @dev Mirrors the JSON input expected by RagequitProofGenerator.mjs
  struct RagequitInputs {
    uint256 keystoreRoot;
    uint256 ownerAddress;
    uint256 value;
    uint256 tokenId;
    uint256 label;
    uint256 noteSecret;
    uint256 metadata;
    uint256 privateNullifyingKey;
    uint256 privateRevocableKey;
    uint256 keystoreLeafIndex;
    uint256[] keystoreSiblings;
    uint256 keystoreTreeDepth;
  }

  /// @notice Generate a ragequit proof via FFI using the existing RagequitProofGenerator.mjs
  /// @param _inputs All circuit inputs (public + private + Merkle data)
  /// @return proof_ The generated ragequit proof
  function generateRagequitProof(RagequitInputs memory _inputs)
    internal
    returns (ProofLibV2.RagequitProof memory proof_)
  {
    string memory json = _buildRagequitJson(_inputs);

    string[] memory cmd = new string[](3);
    cmd[0] = 'node';
    cmd[1] = 'test/helper/RagequitProofGenerator.mjs';
    cmd[2] = json;

    bytes memory result = VM.ffi(cmd);
    (proof_) = abi.decode(result, (ProofLibV2.RagequitProof));

    // Sanity check: verify key public signals match the inputs
    require(proof_.pubSignals[3] == _inputs.ownerAddress, 'ProofGenerator: ownerAddress mismatch');
    require(proof_.pubSignals[4] == _inputs.value, 'ProofGenerator: value mismatch');
  }

  /*///////////////////////////////////////////////////////////////
                        JSON SERIALIZATION
  ///////////////////////////////////////////////////////////////*/

  function _buildTransactJson(TransactInputs memory _i) private returns (string memory s) {
    s = string.concat('{', _buildTransactJsonPublic(_i), ',', _buildTransactJsonNotes(_i), '}');
  }

  function _buildTransactJsonPublic(TransactInputs memory _i) private returns (string memory s) {
    // Public inputs
    s = string.concat('"stateRoot":"', VM.toString(_i.stateRoot), '",');
    s = string.concat(s, '"keystoreRoot":"', VM.toString(_i.keystoreRoot), '",');
    s = string.concat(s, '"associationSetRoot":"', VM.toString(_i.associationSetRoot), '",');
    s = string.concat(s, '"amountOut":"', VM.toString(_i.amountOut), '",');
    s = string.concat(s, '"tokenIdOut":"', VM.toString(_i.tokenIdOut), '",');
    s = string.concat(s, '"context":"', VM.toString(_i.context), '",');

    // Authorization
    s = string.concat(s, '"ownerAddress":"', VM.toString(_i.ownerAddress), '",');
    s = string.concat(s, '"privateNullifyingKey":"', VM.toString(_i.privateNullifyingKey), '",');
    s = string.concat(s, '"privateRevocableKey":"', VM.toString(_i.privateRevocableKey), '",');
    s = string.concat(s, '"keystoreLeafIndex":"', VM.toString(_i.keystoreLeafIndex), '",');
    s = string.concat(s, '"keystoreSiblings":', _toJsonArray(_i.keystoreSiblings), ',');
    s = string.concat(s, '"keystoreTreeDepth":"', VM.toString(_i.keystoreTreeDepth), '"');
  }

  function _buildTransactJsonNotes(TransactInputs memory _i) private returns (string memory s) {
    // Input notes
    s = string.concat('"noteSecret":', _toJsonArray(_i.noteSecret), ',');
    s = string.concat(s, '"value":', _toJsonArray(_i.value), ',');
    s = string.concat(s, '"label":', _toJsonArray(_i.label), ',');
    s = string.concat(s, '"tokenId":"', VM.toString(_i.tokenId), '",');
    s = string.concat(s, '"stateLeafIndex":', _toJsonArray(_i.stateLeafIndex), ',');
    s = string.concat(s, '"stateSiblings":', _toJsonArray(_i.stateSiblings), ',');
    s = string.concat(s, '"stateTreeDepth":', _toJsonArray(_i.stateTreeDepth), ',');
    s = string.concat(s, '"associationSetLeafIndex":', _toJsonArray(_i.associationSetLeafIndex), ',');
    s = string.concat(s, '"associationSetSiblings":', _toJsonArray(_i.associationSetSiblings), ',');
    s = string.concat(s, '"associationSetTreeDepth":', _toJsonArray(_i.associationSetTreeDepth), ',');
    s = string.concat(s, '"timestamp":', _toJsonArray(_i.timestamp), ',');

    // Output notes
    s = string.concat(s, '"outputNoteAddressHash":', _toJsonArray(_i.outputNoteAddressHash), ',');
    s = string.concat(s, '"outputValue":', _toJsonArray(_i.outputValue), ',');
    s = string.concat(s, '"outputLabel":', _toJsonArray(_i.outputLabel));
  }

  /// @dev Serialize uint256[] to JSON array of strings: ["1","2","3"]
  function _toJsonArray(uint256[] memory _arr) private pure returns (string memory result) {
    result = '[';
    for (uint256 i; i < _arr.length; ++i) {
      if (i > 0) result = string.concat(result, ',');
      result = string.concat(result, '"', VM.toString(_arr[i]), '"');
    }
    result = string.concat(result, ']');
  }

  /// @dev Serialize uint256[][] to JSON 2D array: [["1","2"],["3","4"]]
  function _toJsonArray(uint256[][] memory _arr) private pure returns (string memory result) {
    result = '[';
    for (uint256 i; i < _arr.length; ++i) {
      if (i > 0) result = string.concat(result, ',');
      result = string.concat(result, _toJsonArray(_arr[i]));
    }
    result = string.concat(result, ']');
  }

  function _buildRagequitJson(RagequitInputs memory _i) private returns (string memory s) {
    s = '{';
    s = string.concat(s, '"keystoreRoot":"', VM.toString(_i.keystoreRoot), '",');
    s = string.concat(s, '"ownerAddress":"', VM.toString(_i.ownerAddress), '",');
    s = string.concat(s, '"value":"', VM.toString(_i.value), '",');
    s = string.concat(s, '"tokenId":"', VM.toString(_i.tokenId), '",');
    s = string.concat(s, '"label":"', VM.toString(_i.label), '",');
    s = string.concat(s, '"noteSecret":"', VM.toString(_i.noteSecret), '",');
    s = string.concat(s, '"metadata":"', VM.toString(_i.metadata), '",');
    s = string.concat(s, '"privateNullifyingKey":"', VM.toString(_i.privateNullifyingKey), '",');
    s = string.concat(s, '"privateRevocableKey":"', VM.toString(_i.privateRevocableKey), '",');
    s = string.concat(s, '"keystoreLeafIndex":"', VM.toString(_i.keystoreLeafIndex), '",');
    s = string.concat(s, '"keystoreSiblings":', _toJsonArray(_i.keystoreSiblings), ',');
    s = string.concat(s, '"keystoreTreeDepth":"', VM.toString(_i.keystoreTreeDepth), '"');
    s = string.concat(s, '}');
  }
}
