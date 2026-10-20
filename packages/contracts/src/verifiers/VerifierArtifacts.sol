// SPDX-License-Identifier: GPL-3.0-or-later
// solhint-disable no-empty-blocks, one-contract-per-file
pragma solidity 0.8.32;

// Uniquely named, compiled handles on the snarkjs-generated Groth16 verifiers.
// The verifiers are GPL-3.0 (snarkjs template), so no BUSL-1.1 file imports their source; the deploy
// scripts deploy them with `vm.deployCode('VerifierArtifacts.sol:<Name>')` (see AllTransactVerifiers and
// Deploy). All 27 generated contracts are named `Groth16Verifier`, and forge resolves deployCode ids
// through an artifact layout that shifts between compilations, so each verifier gets an empty subclass
// with a unique name here. An empty subclass compiles to the generated verifier's runtime code; only the
// metadata hash differs. This file lives in src/ because `forge test` does not compile unimported
// files under script/.
import {Groth16Verifier as DepositGroth16Verifier} from 'verifiers/deposit/groth16_verifier.sol';
import {Groth16Verifier as RagequitGroth16Verifier} from 'verifiers/ragequit/groth16_verifier.sol';
import {Groth16Verifier as Transact1x1Groth16Verifier} from 'verifiers/transact_1x1/groth16_verifier.sol';
import {Groth16Verifier as Transact1x2Groth16Verifier} from 'verifiers/transact_1x2/groth16_verifier.sol';
import {Groth16Verifier as Transact1x3Groth16Verifier} from 'verifiers/transact_1x3/groth16_verifier.sol';
import {Groth16Verifier as Transact1x4Groth16Verifier} from 'verifiers/transact_1x4/groth16_verifier.sol';
import {Groth16Verifier as Transact1x5Groth16Verifier} from 'verifiers/transact_1x5/groth16_verifier.sol';
import {Groth16Verifier as Transact2x1Groth16Verifier} from 'verifiers/transact_2x1/groth16_verifier.sol';
import {Groth16Verifier as Transact2x2Groth16Verifier} from 'verifiers/transact_2x2/groth16_verifier.sol';
import {Groth16Verifier as Transact2x3Groth16Verifier} from 'verifiers/transact_2x3/groth16_verifier.sol';
import {Groth16Verifier as Transact2x4Groth16Verifier} from 'verifiers/transact_2x4/groth16_verifier.sol';
import {Groth16Verifier as Transact2x5Groth16Verifier} from 'verifiers/transact_2x5/groth16_verifier.sol';
import {Groth16Verifier as Transact3x1Groth16Verifier} from 'verifiers/transact_3x1/groth16_verifier.sol';
import {Groth16Verifier as Transact3x2Groth16Verifier} from 'verifiers/transact_3x2/groth16_verifier.sol';
import {Groth16Verifier as Transact3x3Groth16Verifier} from 'verifiers/transact_3x3/groth16_verifier.sol';
import {Groth16Verifier as Transact3x4Groth16Verifier} from 'verifiers/transact_3x4/groth16_verifier.sol';
import {Groth16Verifier as Transact3x5Groth16Verifier} from 'verifiers/transact_3x5/groth16_verifier.sol';
import {Groth16Verifier as Transact4x1Groth16Verifier} from 'verifiers/transact_4x1/groth16_verifier.sol';
import {Groth16Verifier as Transact4x2Groth16Verifier} from 'verifiers/transact_4x2/groth16_verifier.sol';
import {Groth16Verifier as Transact4x3Groth16Verifier} from 'verifiers/transact_4x3/groth16_verifier.sol';
import {Groth16Verifier as Transact4x4Groth16Verifier} from 'verifiers/transact_4x4/groth16_verifier.sol';
import {Groth16Verifier as Transact4x5Groth16Verifier} from 'verifiers/transact_4x5/groth16_verifier.sol';
import {Groth16Verifier as Transact5x1Groth16Verifier} from 'verifiers/transact_5x1/groth16_verifier.sol';
import {Groth16Verifier as Transact5x2Groth16Verifier} from 'verifiers/transact_5x2/groth16_verifier.sol';
import {Groth16Verifier as Transact5x3Groth16Verifier} from 'verifiers/transact_5x3/groth16_verifier.sol';
import {Groth16Verifier as Transact5x4Groth16Verifier} from 'verifiers/transact_5x4/groth16_verifier.sol';
import {Groth16Verifier as Transact5x5Groth16Verifier} from 'verifiers/transact_5x5/groth16_verifier.sol';

contract DepositVerifier is DepositGroth16Verifier {}

contract RagequitVerifier is RagequitGroth16Verifier {}

contract Transact1x1Verifier is Transact1x1Groth16Verifier {}

contract Transact1x2Verifier is Transact1x2Groth16Verifier {}

contract Transact1x3Verifier is Transact1x3Groth16Verifier {}

contract Transact1x4Verifier is Transact1x4Groth16Verifier {}

contract Transact1x5Verifier is Transact1x5Groth16Verifier {}

contract Transact2x1Verifier is Transact2x1Groth16Verifier {}

contract Transact2x2Verifier is Transact2x2Groth16Verifier {}

contract Transact2x3Verifier is Transact2x3Groth16Verifier {}

contract Transact2x4Verifier is Transact2x4Groth16Verifier {}

contract Transact2x5Verifier is Transact2x5Groth16Verifier {}

contract Transact3x1Verifier is Transact3x1Groth16Verifier {}

contract Transact3x2Verifier is Transact3x2Groth16Verifier {}

contract Transact3x3Verifier is Transact3x3Groth16Verifier {}

contract Transact3x4Verifier is Transact3x4Groth16Verifier {}

contract Transact3x5Verifier is Transact3x5Groth16Verifier {}

contract Transact4x1Verifier is Transact4x1Groth16Verifier {}

contract Transact4x2Verifier is Transact4x2Groth16Verifier {}

contract Transact4x3Verifier is Transact4x3Groth16Verifier {}

contract Transact4x4Verifier is Transact4x4Groth16Verifier {}

contract Transact4x5Verifier is Transact4x5Groth16Verifier {}

contract Transact5x1Verifier is Transact5x1Groth16Verifier {}

contract Transact5x2Verifier is Transact5x2Groth16Verifier {}

contract Transact5x3Verifier is Transact5x3Groth16Verifier {}

contract Transact5x4Verifier is Transact5x4Groth16Verifier {}

contract Transact5x5Verifier is Transact5x5Groth16Verifier {}
