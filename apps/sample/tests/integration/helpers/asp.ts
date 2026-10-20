import { encodeFunctionData } from "viem";
import type { Hash, Hex } from "@privacy-pools-v2/evm-sdk";

import type { TestContext } from "./types.js";
import { sendAndConfirm } from "./tx.js";

/** Minimal ABI for ASPRegistry.updateASPRoot(uint256, bytes). */
const ASP_REGISTRY_ABI = [
    {
        name: "updateASPRoot",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "_aspRoot", type: "uint256" },
            { name: "_ipfsCID", type: "bytes" },
        ],
        outputs: [],
    },
] as const;

/**
 * Computes a new ASP root after adding a label hash, then submits it on-chain
 * via the postman wallet. Updates `ctx.aspLeaves` and `ctx.aspRoot` in place.
 */
export async function addLeafAndUpdateRoot(
    label: Hash,
    ctx: TestContext,
): Promise<void> {
    // Compute label hash (same as get-new-tree-root.ts)
    const labelHash = ctx.hashService.hash([label as Hex]);

    // Deduplicate
    if (!ctx.aspLeaves.includes(labelHash as Hash)) {
        ctx.aspLeaves.push(labelHash as Hash);
    }

    // Build merkle tree and get new root
    const proof = await ctx.merkleService.generateMerkleProof(
        ctx.aspLeaves,
        labelHash as Hash,
    );
    ctx.aspRoot = proof.root;

    console.log(
        `  [ASP] New leaf added. Total leaves: ${ctx.aspLeaves.length}, root: ${ctx.aspRoot}`,
    );

    // Submit on-chain via postman
    const callData = encodeFunctionData({
        abi: ASP_REGISTRY_ABI,
        functionName: "updateASPRoot",
        args: [BigInt(ctx.aspRoot), "0x00" as Hex], // dummy IPFS CID for testing
    });

    await sendAndConfirm(
        ctx.postmanWallet,
        {
            to: ctx.config.aspRegistryAddress,
            data: callData as Hex,
        },
        ctx.rpcInteractor,
    );

    console.log(`  [ASP] Root updated on-chain: ${ctx.aspRoot}`);
}
