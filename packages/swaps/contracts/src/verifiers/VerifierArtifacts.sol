// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.32;

// Uniquely named, compiled handle on the snarkjs-generated deposit verifier.
// The verifier is GPL-3.0 (snarkjs template), so no BUSL-1.1 file imports its source:
// DeployMockPool.s.sol deploys it with `vm.deployCode("VerifierArtifacts.sol:DepositVerifier")`.
// The empty subclass gives it a stable, unique artifact name (the generated contract is called
// `Groth16Verifier`); it compiles to the generated verifier's runtime code, only the metadata hash
// differs. This file lives in src/ so that every forge command compiles it.
import {Groth16Verifier as DepositGroth16Verifier} from "verifiers/deposit/groth16_verifier.sol";

contract DepositVerifier is DepositGroth16Verifier {}
