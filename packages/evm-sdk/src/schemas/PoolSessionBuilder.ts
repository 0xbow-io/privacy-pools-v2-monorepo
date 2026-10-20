import { z } from "zod";

import {
    AddressSchema,
    HexSchema,
    parseCID,
    RelayerInfoSchema,
    SAFE_STORAGE_FILENAME_PATTERN,
} from "../internal.js";
import { RpcUrlSchema } from "./RPCInteractor.js";

/**
 * 32-byte 0x-prefixed hex (66 chars). Length is enforced here because all
 * five protocol-key fields are written into Poseidon / X25519 primitives that
 * silently produce nonsense for mis-sized inputs.
 */
const Hex32Schema = HexSchema.refine((val) => val.length === 66, {
    message: "Must be a 32-byte 0x-prefixed hex value (66 chars)",
});

const ProtocolKeysSchema = z.object({
    privateNullifyingKey: Hex32Schema,
    privateRevocableKey: Hex32Schema,
    revocableKeyIndex: HexSchema,
    viewingPrivateKey: Hex32Schema,
    viewingPublicKey: Hex32Schema,
});

const HttpUrlSchema = z
    .url("Must be a valid URL")
    .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
        message: "URL must use http or https protocol",
    });

/**
 * Validates {@link PoolSessionBuilderConfig} structurally.
 *
 * Deep validation of key material and leaf-service config fields is delegated
 * to the underlying services (e.g. `KeystoreManagerConfigSchema`) at
 * construction time — we only enforce surface shape + URL format here.
 */
const DeploymentAddressesSchema = z.object({
    poolAddress: AddressSchema,
    entrypointAddress: AddressSchema,
    keystoreAddress: AddressSchema,
    aspRegistryAddress: AddressSchema,
});

const PersistentStorageConfigSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("file"),
        dirPath: z.string().min(1, "dirPath must not be empty"),
        // Same rule as the FileStorageService constructor (see SAFE_STORAGE_FILENAME_PATTERN);
        // checked here too so a bad filename surfaces as InvalidBuilderConfig like any other field.
        filename: z
            .string()
            .regex(
                SAFE_STORAGE_FILENAME_PATTERN,
                "filename must contain only [A-Za-z0-9._-] and not be dots-only",
            )
            .optional(),
    }),
    z.object({
        type: z.literal("local"),
        prefix: z.string().min(1, "prefix must not be empty").optional(),
    }),
    z.object({ type: z.literal("memory") }),
]);

// A circuit-artifact CID is either "" — meaning "not pinned" — or a string parseCID accepts
// (CIDv0/v1 with a SHA-256 multihash). Checking it here makes a malformed pin fail at config
// parse, with the offending field named in the Zod path, instead of reaching a runtime
// gateway fetch.
const CircuitCidSchema = z.string().refine(
    (cid) => {
        if (cid === "") return true;
        try {
            parseCID(cid);
            return true;
        } catch {
            return false;
        }
    },
    { message: "Must be empty or a valid SHA-256 IPFS CID" },
);

const CircuitArtifactCIDsSchema = z.object({
    wasm: CircuitCidSchema,
    wasmSha256: HexSchema.optional(),
    provingKey: CircuitCidSchema,
    provingKeySha256: HexSchema.optional(),
    verificationKey: CircuitCidSchema,
    verificationKeySha256: HexSchema.optional(),
});

const CircuitManifestSchema = z.record(z.string(), CircuitArtifactCIDsSchema);

// Validates the discriminator and that the matching client/provider is present. The discriminator
// check matters most: buildWalletInteractor's switch has no default, so an unknown `type` would
// silently build a session without a wallet. The client/provider objects are opaque externals —
// a wrong-typed one fails with a clear TypeError at first use.
const WalletInteractorConfigSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("viem"),
        walletClient: z.unknown().refine((v) => v != null, "walletClient is required"),
    }),
    z.object({
        type: z.literal("EIP1193"),
        provider: z.unknown().refine((v) => v != null, "provider is required"),
    }),
]);

export const PoolSessionBuilderConfigSchema = z
    .object({
        chainId: z.number().int().positive("Chain ID must be a positive integer"),
        deployment: DeploymentAddressesSchema.optional(),
        rpcUrl: RpcUrlSchema,
        ownerAddress: AddressSchema,
        protocolKeys: ProtocolKeysSchema.optional(),
        aspUrl: HttpUrlSchema.optional(),
        relayers: z.array(RelayerInfoSchema).min(1, "At least one relayer is required").optional(),
        circuitArtifactsDir: z.string().min(1, "circuitArtifactsDir must not be empty").optional(),
        circuitGatewayUrls: z
            .array(HttpUrlSchema)
            .min(1, "circuitGatewayUrls must contain at least one URL")
            .optional(),
        circuitManifest: CircuitManifestSchema.optional(),
        ipfsGatewayUrl: HttpUrlSchema.optional(),
        aspPublicKey: HexSchema.optional(),
        logger: z.any().optional(),
        httpClientConfig: z.any().optional(),
        persistentStorage: PersistentStorageConfigSchema.optional(),
        walletInteractor: WalletInteractorConfigSchema.optional(),
        deploymentBlock: HexSchema.optional(),
        destinationChainId: z.number().int().positive().optional(),
        destinationRpcUrl: RpcUrlSchema.optional(),
        destinationDeployment: DeploymentAddressesSchema.optional(),
        sourceChain: z
            .object({
                chainId: z.number().int().positive(),
                rpcUrl: RpcUrlSchema,
                walletInteractor: WalletInteractorConfigSchema,
                relaySwapsAddress: AddressSchema,
            })
            .optional(),
    })
    .superRefine((cfg, ctx) => {
        if (cfg.sourceChain !== undefined && cfg.sourceChain.chainId === cfg.chainId) {
            ctx.addIssue({
                code: "custom",
                path: ["sourceChain", "chainId"],
                message:
                    "sourceChain.chainId must differ from chainId — omit sourceChain for same-chain swap-and-deposit",
            });
        }
        if (cfg.destinationChainId !== undefined && cfg.destinationRpcUrl === undefined) {
            ctx.addIssue({
                code: "custom",
                path: ["destinationRpcUrl"],
                message: "destinationRpcUrl is required when destinationChainId is supplied",
            });
        }
        if (cfg.destinationChainId === cfg.chainId) {
            ctx.addIssue({
                code: "custom",
                path: ["destinationChainId"],
                message:
                    "destinationChainId must differ from chainId — use PoolSessionReshield for same-chain reshield",
            });
        }
        if (cfg.relayers) {
            for (const [i, relayer] of cfg.relayers.entries()) {
                if (relayer.chainId !== cfg.chainId) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["relayers", i, "chainId"],
                        message: `Relayer chainId ${relayer.chainId} does not match session chainId ${cfg.chainId}`,
                    });
                }
            }
        }
        if (cfg.circuitArtifactsDir !== undefined && cfg.circuitGatewayUrls !== undefined) {
            ctx.addIssue({
                code: "custom",
                path: ["circuitGatewayUrls"],
                message: "Supply either `circuitArtifactsDir` or `circuitGatewayUrls`, not both",
            });
        }
    });
