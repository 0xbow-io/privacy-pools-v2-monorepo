// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;
import {Vm} from 'forge-std/Vm.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {PoseidonT2} from 'poseidon-solidity/PoseidonT2.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';
import {Constants} from 'src/utils/Constants.sol';
import {NoteCreationParams} from 'test/handlers/HandlerBase.sol';

library UserIdentityLib {
  Vm private constant VM = Vm(address(uint160(uint256(keccak256('hevm cheat code')))));

  /// @dev Bundles raw keys and Poseidon-derived identity data for a test user
  struct UserIdentity {
    address addr;
    uint8 usedSecrets;
    uint256 privNullifyingKey;
    uint256 privRevocableKey;
    uint256 ownerAddress;
    uint256 nullifyingKeyHash;
    uint256 authDigest;
    uint256 keystoreIndex;
    uint256 signingKey;
    uint256[200] noteSecrets;
    uint256[200] depositSecrets;
  }

  function newSecrets(UserIdentity storage self) internal returns (uint256 noteSecret, uint256 depositSecret) {
    noteSecret = self.noteSecrets[self.usedSecrets];
    depositSecret = self.depositSecrets[self.usedSecrets];
    self.usedSecrets += 1;
  }

  /// @dev Build a full UserIdentity from a name label (deterministic, Poseidon-derived)
  function createIdentity(string memory _name) internal returns (UserIdentityLib.UserIdentity memory _id) {
    // can't use makeAddr in a library because that'd mean extending a contract
    _id.addr = address(uint160(uint256(keccak256(abi.encodePacked(_name)))));
    VM.label(_id.addr, _name);
    _id.privNullifyingKey = _deriveSecret(_name, '_nullifying_key');
    _id.privRevocableKey = _deriveSecret(_name, '_revocable_key');
    _id.ownerAddress = uint256(uint160(_id.addr));
    _id.nullifyingKeyHash = PoseidonT2.hash([_id.privNullifyingKey]);
    _id.authDigest = PoseidonT3.hash([Constants.AUTH_TYPE_DIRECT_KEY, _id.privRevocableKey]);
    for (uint256 i; i < _id.noteSecrets.length; ++i) {
      _id.noteSecrets[i] = _deriveSecret(_name, string.concat('_note_secret_', VM.toString(i)));
      _id.depositSecrets[i] = _deriveSecret(_name, string.concat('_deposit_secret_', VM.toString(i)));
    }
  }

  /// @dev Like `createIdentity` but with a real secp256k1 signing key, so the address can produce EOA
  ///      signatures (e.g. the EIP-712 authorization consumed by `Keystore.setAuthPolicyWithSig`). The
  ///      address is derived from the key (`vm.addr`) and `ownerAddress` is updated to match.
  function createSignableIdentity(string memory _name) internal returns (UserIdentity memory _id) {
    _id = createIdentity(_name);
    uint256 _signingKey = _deriveSecret(_name, '_signing_key');
    _id.signingKey = _signingKey;
    _id.addr = VM.addr(_signingKey);
    VM.label(_id.addr, _name);
    _id.ownerAddress = uint256(uint160(_id.addr));
  }

  /// @dev Like `createIdentity` but bound to an existing contract-wallet address. The wallet validates
  ///      signatures via EIP-1271, so the caller sets `signingKey` to the wallet OWNER's key (the EOA the
  ///      wallet recovers and authorizes). `addr`/`ownerAddress` are the wallet, so the keystore leaf binds it.
  function createContractWalletIdentity(
    string memory _name,
    address _wallet
  ) internal returns (UserIdentity memory _id) {
    _id = createIdentity(_name);
    _id.addr = _wallet;
    VM.label(_wallet, _name);
    _id.ownerAddress = uint256(uint160(_wallet));
  }

  /// @dev Derives a deterministic secret from a name and suffix, reduced to the SNARK scalar field
  function _deriveSecret(string memory _name, string memory _suffix) private pure returns (uint256) {
    return uint256(keccak256(abi.encodePacked(_name, _suffix))) % SNARK_SCALAR_FIELD;
  }

  function receiveNote(
    UserIdentity storage _self,
    uint256 _value,
    uint256 _label
  ) internal returns (NoteCreationParams memory params) {
    (uint256 _noteSecret, uint256 _depositSecret) = newSecrets(_self);
    params.noteSecret = _noteSecret;
    params.depositSecret = _depositSecret;
    params.noteAddressHash = PoseidonT3.hash([_self.ownerAddress, _noteSecret]);
    params.value = _value;
    params.label = _label;
  }
}

