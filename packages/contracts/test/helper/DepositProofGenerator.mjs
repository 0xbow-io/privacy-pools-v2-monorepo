#!/usr/bin/env node
/**
 * FFI-compatible deposit proof generator for Foundry's vm.ffi().
 *
 * Usage: node test/helper/DepositProofGenerator.mjs '<json>'
 *
 * Input JSON: { "tokenId": "1", "value": "1000000", "noteAddressHash": "123", "depositSecret": "456", "context": "789" }
 * All values as decimal or hex strings.
 *
 * On success: writes ABI-encoded DepositProof bytes to stdout (hex with 0x prefix).
 *   Encoding: (uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[4] pubSignals)
 * On failure: exits with code 1, no stdout output.
 */
import { encodeAbiParameters } from "viem";
import {
  withSilentStdout,
  validateStringInputs,
  generateProof,
  exportSolidityCalldata,
} from "./proof-utils.mjs";

async function main() {
  const jsonStr = process.argv[2];
  if (!jsonStr) process.exit(1);

  const raw = JSON.parse(jsonStr);
  validateStringInputs(raw);

  const inputs = {
    tokenId: BigInt(raw.tokenId),
    value: BigInt(raw.value),
    noteAddressHash: BigInt(raw.noteAddressHash),
    depositSecret: BigInt(raw.depositSecret),
    context: BigInt(raw.context),
  };

  const silentGenerateProof = withSilentStdout(generateProof);
  const { proof, publicSignals } = await silentGenerateProof("deposit", inputs);
  const { pA, pB, pC, pubSignals } = await exportSolidityCalldata(proof, publicSignals);

  const encoded = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "_pA", type: "uint256[2]" },
          { name: "_pB", type: "uint256[2][2]" },
          { name: "_pC", type: "uint256[2]" },
          { name: "_pubSignals", type: "uint256[4]" },
        ],
      },
    ],
    [{ _pA: pA, _pB: pB, _pC: pC, _pubSignals: pubSignals }],
  );

  process.stdout.write(encoded);
  process.exit(0);
}

main().catch(() => process.exit(1));
