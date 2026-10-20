import { join } from "node:path";

import type { Hex, ICryptoService, IHashService, PoolSession } from "@privacy-pools-v2/evm-sdk";
import {
    CryptoService,
    DEPLOYMENTS,
    PinoLogger,
    PoolSessionBuilder,
    PoolVaultInteractor,
    PoseidonHashService,
    ViemRPCInteractor,
} from "@privacy-pools-v2/evm-sdk";
import type { Account, Chain, Transport, WalletClient } from "viem";
import { sepolia } from "viem/chains";

import type { ProtocolKeys } from "../util/createPoolSession.js";

const CIRCUIT_ARTIFACTS_DIR = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "circuits",
    "build",
);

export type BuilderInputs = {
    chainId: number;
    rpcUrl: string;
    ownerAddress: Hex;
    protocolKeys: ProtocolKeys;
    aspUrl: string;
    relayer: {
        url: string;
        address: Hex;
        processorAddress: Hex;
    };
    walletClient?: WalletClient<Transport, Chain, Account>;
};

/**
 * Option A — `PoolSessionBuilder.create(config)`, the one-call path.
 *
 * Every dependency is constructed internally from the config. Contract
 * addresses come from the SDK-shipped `DEPLOYMENTS[chainId]` map; ASP, relayer,
 * circuits, hash service, crypto, RPC interactor, NoteManager, KeystoreManager
 * — all defaults.
 *
 * Use this when:
 *   - You don't need to share a pre-built service instance with the host app.
 *   - You're happy with the SDK's default circuit-artifact source (local dir
 *     or IPFS, depending on which field you pass).
 *
 * Trade-off: you cannot inject a custom logger sink, an existing RPC client,
 * a custom proof service, or a pre-warmed Poseidon instance. If you need any
 * of those, see `createOverridePoolSession` below.
 *
 * @param inputs   Connection + key material + relayer + optional wallet client.
 * @returns        A fully-wired PoolSession ready for prepare/execute calls.
 */
export async function createSimplePoolSession(inputs: BuilderInputs): Promise<PoolSession> {
    return PoolSessionBuilder.create({
        chainId: inputs.chainId,
        rpcUrl: inputs.rpcUrl,
        ownerAddress: inputs.ownerAddress,
        protocolKeys: {
            ...inputs.protocolKeys,
            revocableKeyIndex: inputs.protocolKeys.revocableKeyIndex ?? ("0x0" as Hex),
        },
        aspUrl: inputs.aspUrl,
        relayers: [
            {
                name: "0xBow Relayer",
                url: inputs.relayer.url,
                address: inputs.relayer.address,
                processorAddress: inputs.relayer.processorAddress,
                chainId: inputs.chainId,
                chainType: "evm",
                status: "active",
            },
        ],
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        walletInteractor: inputs.walletClient
            ? { type: "viem", walletClient: inputs.walletClient }
            : undefined,
    });
}

/**
 * Option B — `PoolSessionBuilder.fromConfig(config).withX(...).create()`.
 *
 * Same end result as `createSimplePoolSession` but with explicit service
 * injection via the fluent `.withX()` overrides. Use this when you need to
 * SHARE service instances between the SDK and the host app:
 *
 *   - `.withRpcInteractor(...)` — share a single ViemRPCInteractor across
 *     SDK + your own contract calls (one provider, one connection).
 *   - `.withHashService(...)` — pass a pre-warmed PoseidonHashService so the
 *     first proof doesn't pay the WASM-init latency.
 *   - `.withCryptoService(...)` — supply your own randomness source.
 *   - `.withVaultInteractor(...)` — same PoolVault instance that your UI
 *     reads block timestamps from, so reads are cache-coherent.
 *
 * Other available overrides (not used here, but worth knowing):
 *   `.withProofService`, `.withNoteManager`, `.withKeystoreManager`,
 *   `.withStorageService`, `.withNoteStorageAdapter`, `.withWalletInteractor`,
 *   `.withCircuitArtifacts`, `.withRelayerInteractor`, `.withASPDataProvider`.
 *
 * Conflict rules: some overrides are mutually exclusive with the corresponding
 * config fields. e.g. passing `protocolKeys` AND calling `.withKeystoreManager()`
 * is a type error. Same for `persistentStorage` vs `.withStorageService()` /
 * `.withNoteStorageAdapter()`, and `walletInteractor` vs `.withWalletInteractor()`.
 *
 * @returns The PoolSession AND the externally-constructed services so the
 *          host app can keep using them.
 */
export async function createOverridePoolSession(inputs: BuilderInputs): Promise<{
    poolSession: PoolSession;
    rpcInteractor: ViemRPCInteractor;
    hashService: IHashService;
    cryptoService: ICryptoService;
    poolVaultInteractor: PoolVaultInteractor;
}> {
    const logger = PinoLogger.create({ level: "info" });
    const rpcInteractor = ViemRPCInteractor.create({
        rpcUrl: inputs.rpcUrl,
        chain: sepolia,
    });
    const hashService = await PoseidonHashService.create();
    const cryptoService = new CryptoService();
    // Override path needs the pool address explicitly — the host app would
    // typically pull this from its own config. Here we read the same map
    // that `PoolSessionBuilder.create()` falls back to when no `deployment`
    // field is passed, so the two paths are equivalent at the address level.
    const deployment = DEPLOYMENTS[inputs.chainId];
    if (!deployment) throw new Error(`No DEPLOYMENTS entry for chainId ${inputs.chainId}`);
    const poolVaultInteractor = new PoolVaultInteractor(
        { rpcInteractor, contractAddress: deployment.poolAddress },
        { logger },
    );

    const poolSession = await PoolSessionBuilder.fromConfig({
        chainId: inputs.chainId,
        rpcUrl: inputs.rpcUrl,
        ownerAddress: inputs.ownerAddress,
        protocolKeys: {
            ...inputs.protocolKeys,
            revocableKeyIndex: inputs.protocolKeys.revocableKeyIndex ?? ("0x0" as Hex),
        },
        aspUrl: inputs.aspUrl,
        relayers: [
            {
                name: "0xBow Relayer",
                url: inputs.relayer.url,
                address: inputs.relayer.address,
                processorAddress: inputs.relayer.processorAddress,
                chainId: inputs.chainId,
                chainType: "evm",
                status: "active",
            },
        ],
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        logger,
        walletInteractor: inputs.walletClient
            ? { type: "viem", walletClient: inputs.walletClient }
            : undefined,
    })
        .withRpcInteractor(rpcInteractor)
        .withHashService(hashService)
        .withCryptoService(cryptoService)
        .withVaultInteractor(poolVaultInteractor)
        .create();

    return { poolSession, rpcInteractor, hashService, cryptoService, poolVaultInteractor };
}
