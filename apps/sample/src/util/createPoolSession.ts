import { join } from "node:path";
import type {
    Hex,
    ICryptoService,
    IHashService,
    PersistentStorageConfig,
    PoolSession,
} from "@privacy-pools-v2/evm-sdk";
import type { Account, Chain, Transport, WalletClient } from "viem";
import {
    CryptoService,
    PinoLogger,
    PoolSessionBuilder,
    PoolVaultInteractor,
    PoseidonHashService,
    ViemRPCInteractor,
} from "@privacy-pools-v2/evm-sdk";
import { sepolia } from "viem/chains";

import { config } from "./config.js";

export type ProtocolKeys = {
    privateNullifyingKey: Hex;
    privateRevocableKey: Hex;
    viewingPrivateKey: Hex;
    viewingPublicKey: Hex;
    /** Rotation index `n` of the supplied `privateRevocableKey` as 0x-prefixed hex. Defaults to `"0x0"` for fresh accounts. */
    revocableKeyIndex?: Hex;
};

export type CreatePoolSessionParams = {
    ownerAddress: Hex;
    protocolKeys: ProtocolKeys;
    walletClient?: WalletClient<Transport, Chain, Account>;
    /**
     * Optional persistent-storage selector forwarded to `PoolSessionBuilder`.
     * When provided, the SDK auto-persists NoteManager + PaymentRequestService
     * state to the chosen backend (file / localStorage / memory).
     */
    persistentStorage?: PersistentStorageConfig;
};

export type CreatePoolSessionResult = {
    poolSession: PoolSession;
    rpcInteractor: ViemRPCInteractor;
    hashService: IHashService;
    cryptoService: ICryptoService;
    poolVaultInteractor: PoolVaultInteractor;
};

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

export async function createPoolSession(
    params: CreatePoolSessionParams,
): Promise<CreatePoolSessionResult> {
    // Operators can flip to "debug" to surface getLogsPaginated chunk
    // progress, rate-limit retries, and ASP/relayer HTTP details.
    const logger = PinoLogger.create({ level: "info" });

    const rpcInteractor = ViemRPCInteractor.create(
        {
            rpcUrl: config.rpcUrl,
            chain: sepolia,
        },
        { logger },
    );
    const hashService = await PoseidonHashService.create();
    const cryptoService = new CryptoService();
    const poolVaultInteractor = new PoolVaultInteractor(
        { rpcInteractor, contractAddress: config.poolAddress },
        { logger },
    );

    const poolSession = await PoolSessionBuilder.fromConfig({
        chainId: config.chainId,
        rpcUrl: config.rpcUrl,
        ownerAddress: params.ownerAddress,
        protocolKeys: {
            ...params.protocolKeys,
            revocableKeyIndex: params.protocolKeys.revocableKeyIndex ?? ("0x0" as Hex),
        },
        aspUrl: config.aspUrl,
        relayers: [
            {
                name: "0xBow Relayer",
                url: config.relayerUrl,
                address: config.relayerAddress,
                processorAddress: config.relayerProcessorAddress,
                chainId: sepolia.id,
                chainType: "evm",
                status: "active",
            },
        ],
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        logger,
        walletInteractor: params.walletClient
            ? { type: "viem", walletClient: params.walletClient }
            : undefined,
        persistentStorage: params.persistentStorage,
    })
        .withRpcInteractor(rpcInteractor)
        .withHashService(hashService)
        .withCryptoService(cryptoService)
        .withVaultInteractor(poolVaultInteractor)
        .create();

    return {
        poolSession,
        rpcInteractor,
        hashService,
        cryptoService,
        poolVaultInteractor,
    };
}
