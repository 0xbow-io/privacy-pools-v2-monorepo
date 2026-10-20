#!/usr/bin/env node
/**
 * FFI-compatible ragequit proof generator for Foundry's vm.ffi().
 *
 * Usage: node test/helper/RagequitProofGenerator.mjs '<json>'
 *
 * Input JSON keys: keystoreRoot, ownerAddress, value, tokenId, label,
 *   noteSecret, metadata, privateNullifyingKey, privateRevocableKey,
 *   keystoreLeafIndex, keystoreSiblings (array), keystoreTreeDepth
 * All values as decimal or hex strings.
 *
 * On success: writes ABI-encoded proof bytes to stdout (hex with 0x prefix).
 *   Encoding: (uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[7] pubSignals)
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
    keystoreRoot: BigInt(raw.keystoreRoot),
    ownerAddress: BigInt(raw.ownerAddress),
    value: BigInt(raw.value),
    tokenId: BigInt(raw.tokenId),
    label: BigInt(raw.label),
    noteSecret: BigInt(raw.noteSecret),
    metadata: BigInt(raw.metadata),
    privateNullifyingKey: BigInt(raw.privateNullifyingKey),
    privateRevocableKey: BigInt(raw.privateRevocableKey),
    keystoreLeafIndex: BigInt(raw.keystoreLeafIndex),
    keystoreSiblings: raw.keystoreSiblings.map((s) => BigInt(s)),
    keystoreTreeDepth: BigInt(raw.keystoreTreeDepth),
  };

  const silentGenerateProof = withSilentStdout(generateProof);
  const { proof, publicSignals } = await silentGenerateProof("ragequit", inputs);
  const { pA, pB, pC, pubSignals } = await exportSolidityCalldata(proof, publicSignals);

  const encoded = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "_pA", type: "uint256[2]" },
          { name: "_pB", type: "uint256[2][2]" },
          { name: "_pC", type: "uint256[2]" },
          { name: "_pubSignals", type: "uint256[7]" },
        ],
      },
    ],
    [{ _pA: pA, _pB: pB, _pC: pC, _pubSignals: pubSignals }],
  );

  process.stdout.write(encoded);
  process.exit(0);
}

main().catch(() => process.exit(1));
