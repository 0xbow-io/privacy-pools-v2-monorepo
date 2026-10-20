# Timestamp implementation guide

## Contracts

The PoolVault stores both commitments and nullifiers as domain-tagged, timestamped leaves in the state tree. Each leaf is hashed with a domain tag and `block.timestamp` so that the on-chain state tree and the circuit’s Merkle proof use the same leaf format.

The mappings (`commitments`, `spentNullifiers`) record the timestamp rather than a boolean, enabling time-based queries.

```solidity
// Both mappings live inside PoolVaultStorage (ERC-7201 namespaced)
mapping(uint256 _commitment => uint256 _createdAt) commitments;
mapping(uint256 _nullifierHash => uint256 _spentAt) spentNullifiers;

// Pseudocode showing the state update flow (not actual method signatures).
function addCommitmentToState(uint256 _commitmentHash) {
	require(commitments[_commitmentHash] == 0, "Already exists");
	commitments[_commitmentHash] = block.timestamp;

	uint256 _stateLeaf = PoseidonT4.hash([Constants.COMMITMENT_LEAF_TAG, _commitmentHash, block.timestamp]);
	state.append(_stateLeaf);
}

function spendCommitment(uint256 _nullifierHash) {
	require(spentNullifiers[_nullifierHash] == 0, "Already spent");
	spentNullifiers[_nullifierHash] = block.timestamp;

	uint256 _stateLeaf = PoseidonT4.hash([Constants.NULLIFIER_LEAF_TAG, _nullifierHash, block.timestamp]);
	state.append(_stateLeaf);
}
```

## Circuits

For inclusion proofs, the circuit hashes the commitment with its domain tag and creation timestamp to reconstruct the leaf that is actually in the state tree.

```diff
template Transact() {

	// Private signals ...
	signal input noteSecret[nInputs];
	signal input value[nInputs];
	signal input label[nInputs];
+ signal input timestamp[nInputs];
	signal input tokenId;
	// ... Private signals

  // 3. Reconstruct input commitment using NoteCommitment
  inputNoteCommitments[i] = NoteCommitment();
  inputNoteCommitments[i].noteAddressHash <== noteAddrHashers[i].out;
  inputNoteCommitments[i].tokenId <== tokenId;
  inputNoteCommitments[i].value <== value[i];
  inputNoteCommitments[i].metadata <== 0;  // EMPTY_METADATA
  inputNoteCommitments[i].label <== label[i];
  inputCommitments[i] <== inputNoteCommitments[i].commitment;
  
+ component timestampedLeafHasher = Poseidon(3);
+ timestampedLeafHasher.inputs[0] <== COMMITMENT_LEAF_TAG;
+ timestampedLeafHasher.inputs[1] <== inputCommitments[i];
+ timestampedLeafHasher.inputs[2] <== timestamp[i];

  // 4. Verify commitment exists in commitment tree
  inputMerkleProofs[i] = BinaryMerkleRoot(maxDepth);
- inputMerkleProofs[i].leaf <== inputCommitments[i];
+ inputMerkleProofs[i].leaf <== timestampedLeafHasher.out;
  inputMerkleProofs[i].index <== commitmentLeafIndex[i];
  inputMerkleProofs[i].depth <== commitmentTreeDepth;
  for (var j = 0; j < maxDepth; j++) {
      inputMerkleProofs[i].siblings[j] <== commitmentSiblings[i][j];
  }
  inputMerkleProofs[i].out === stateRoot;

}
```