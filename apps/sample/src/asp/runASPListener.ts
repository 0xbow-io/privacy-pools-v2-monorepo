import { createPublicClient, http, parseAbiItem } from "viem";
import { sepolia } from "viem/chains";

import type { Hex, ICryptoService, Secret } from "@privacy-pools-v2/evm-sdk";
import {
    CryptoService,
    PoolVaultInteractor,
    PoseidonHashService,
    ViemRPCInteractor,
    decodeASPCipherText,
} from "@privacy-pools-v2/evm-sdk";

import { config } from "../util/config.js";

const LABEL_REGISTERED_EVENT = parseAbiItem("event LabelRegistered(bytes _ciphertext)");

/**
 * Sample ASP listener.
 *
 * Subscribes to `LabelRegistered` events on the ASPRegistry contract, decodes
 * the ASP-encrypted ciphertext with `ASP_PRIVATE_KEY`, reconstructs the
 * commitment, and verifies it exists on-chain. A real ASP would then evaluate
 * compliance rules and call `updateASPRoot` to admit the label.
 *
 * Long-running — does not exit. No script-level pre/post assertions; logs only.
 */
async function main(): Promise<void> {
    console.log("=== Sample: runASPListener ===\n");

    if (!config.aspPrivateKey) {
        throw new Error("ASP_PRIVATE_KEY is required for the ASP listener.");
    }
    const aspPrivateKey = config.aspPrivateKey as Secret;
    const cryptoService = new CryptoService();
    const hashService = await PoseidonHashService.create();
    const rpcInteractor = ViemRPCInteractor.create({ rpcUrl: config.rpcUrl, chain: sepolia });
    const poolVaultInteractor = new PoolVaultInteractor({
        rpcInteractor,
        contractAddress: config.poolAddress,
    });

    const publicClient = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });

    console.log(`Watching LabelRegistered on ${config.aspRegistryAddress}\n`);

    publicClient.watchContractEvent({
        address: config.aspRegistryAddress as `0x${string}`,
        abi: [LABEL_REGISTERED_EVENT],
        eventName: "LabelRegistered",
        onLogs: async (logs) => {
            for (const log of logs) {
                try {
                    await processLabelRegistered({
                        tx: log.transactionHash as Hex,
                        ciphertext: log.args._ciphertext as Hex,
                        aspPrivateKey,
                        cryptoService,
                        hashService,
                        poolVaultInteractor,
                    });
                } catch (error) {
                    console.error("Failed to process event:", error);
                }
            }
        },
    });
}

async function processLabelRegistered({
    tx,
    ciphertext,
    aspPrivateKey,
    hashService,
    poolVaultInteractor,
}: {
    tx: Hex;
    ciphertext: Hex;
    aspPrivateKey: Secret;
    cryptoService: ICryptoService;
    hashService: { hash(inputs: Hex[]): Hex };
    poolVaultInteractor: PoolVaultInteractor;
}): Promise<void> {
    console.log(`--- LabelRegistered ${tx} ---`);
    const payload = decodeASPCipherText(ciphertext, { aspPrivateKey });
    console.log(`  noteAddressHash: ${payload.noteAddressHash}`);
    console.log(`  tokenId:         ${payload.tokenId}`);
    console.log(`  value:           ${payload.value}`);
    // depositSecret is the lineage's deposit-side secret — redacted from logs
    // even though the ASP is authorized to know it. Don't normalize logging
    // cryptographic material; CI logs and terminal scrollback persist.
    console.log(`  depositSecret:   <redacted>`);

    const precommitment = hashService.hash([
        payload.noteAddressHash,
        payload.tokenId,
        payload.value,
        payload.metadata,
    ]);
    const label = hashService.hash([precommitment, payload.depositSecret]);
    const commitment = hashService.hash([precommitment, label]);
    console.log(`  commitment:      ${commitment}`);

    const ts = await poolVaultInteractor.getCommitmentTimestamp(commitment);
    if (BigInt(ts) !== 0n) {
        const labelHash = hashService.hash([label]);
        console.log(`  ✓ on-chain (ts=${ts})`);
        console.log(`  labelHash:       ${labelHash}  → would add to association set`);
    } else {
        console.log("  ✗ commitment NOT in state tree");
    }
    console.log("");
}

main().catch((error: unknown) => {
    console.error("ASP listener failed:", error);
    process.exit(1);
});
