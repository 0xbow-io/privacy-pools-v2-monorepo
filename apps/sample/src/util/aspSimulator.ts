import { encodeFunctionData } from "viem";

import type { Hash, Hex, IHashService, ViemRPCInteractor } from "@privacy-pools-v2/evm-sdk";
import { MerkleService } from "@privacy-pools-v2/evm-sdk";

import { config } from "./config.js";
import { createSepoliaWalletClient } from "./createWalletClient.js";

const UPDATE_ASP_ROOT_ABI = [
    {
        type: "function",
        name: "updateASPRoot",
        inputs: [
            { name: "_aspRoot", type: "uint256" },
            { name: "_ipfsCID", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

export type ComputeNewASPRootResult = {
    newRoot: Hash;
    leaves: Hash[];
    isNewLeaf: boolean;
};

/**
 * Adds `Poseidon(label)` to `existingLeaves` (deduplicated), rebuilds the
 * Merkle tree and returns the new root. Inverse of `MerkleService.generateMerkleProof`.
 */
export async function computeNewASPRoot(
    label: Hex,
    existingLeaves: Hash[],
    hashService: IHashService,
): Promise<ComputeNewASPRootResult> {
    const merkleService = new MerkleService({ hashService });
    const labelHash = hashService.hash([label]) as Hash;
    // Check membership directly. `allLeaves.length > existingLeaves.length`
    // is wrong when existingLeaves contains duplicates: deduping wouldn't
    // grow the set even if labelHash is genuinely new.
    const isNewLeaf = !existingLeaves
        .map((l) => l.toLowerCase())
        .includes(labelHash.toLowerCase());
    const allLeaves = [...new Set([...existingLeaves, labelHash])] as Hash[];
    const proof = await merkleService.generateMerkleProof(allLeaves, labelHash);
    return { newRoot: proof.root as Hash, leaves: allLeaves, isNewLeaf };
}

/**
 * Sends `updateASPRoot(_root, _ipfsCID)` from the postman key to the configured
 * ASPRegistry contract. The ASP would otherwise own this — we expose it so
 * cold-start examples can simulate ASP approval without a running listener.
 */
export async function updateASPRootOnChain({
    root,
    rpcInteractor,
}: {
    root: Hash;
    rpcInteractor: ViemRPCInteractor;
}): Promise<{ txHash: Hex }> {
    if (!config.postmanRolePrivateKey) {
        throw new Error(
            "POSTMAN_PK is required to simulate ASP approval. Add a key with POSTMAN_ROLE on AccessRouter to your .env.",
        );
    }
    const wallet = createSepoliaWalletClient(config.postmanRolePrivateKey);
    const callData = encodeFunctionData({
        abi: UPDATE_ASP_ROOT_ABI,
        functionName: "updateASPRoot",
        args: [BigInt(root), "0x1234" as Hex],
    });
    const txHash = await wallet.sendTransaction({
        to: config.aspRegistryAddress as `0x${string}`,
        data: callData as `0x${string}`,
    });
    await rpcInteractor.waitForTransactionReceipt(txHash as Hex);
    return { txHash: txHash as Hex };
}
