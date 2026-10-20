import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import type { Hex, ProtocolKeys, PublicKey, Secret } from "../../../src/internal.js";
import { InvalidBuilderConfig, StellarPoolSessionBuilder } from "../../../src/internal.js";
import { cidFor } from "../helpers/ipfsContent.js";

const DEPOSIT_WASM_CID = cidFor(new Uint8Array([0xa1]));
const DEPOSIT_PKEY_CID = cidFor(new Uint8Array([0xa2]));
const DEPOSIT_VKEY_CID = cidFor(new Uint8Array([0xa3]));

function randomSecret(): Secret {
    return ("0x" + bytesToHex(randomBytes(32))) as Secret;
}

// Stellar's viewing key is X25519 (same curve as EVM) — see StellarPublicKeySchema's doc
// comment for why the earlier secp256k1 choice was reverted.
function derivePublicKey(privateKey: Secret): PublicKey {
    const bytes = hexToBytes(privateKey.slice(2));
    const pubBytes = x25519.getPublicKey(bytes);
    return ("0x" + bytesToHex(pubBytes)) as PublicKey;
}

function validKeys(): ProtocolKeys {
    const viewingPrivateKey = randomSecret();
    return {
        privateNullifyingKey: randomSecret(),
        privateRevocableKey: randomSecret(),
        viewingPrivateKey,
        viewingPublicKey: derivePublicKey(viewingPrivateKey),
        revocableKeyIndex: "0x0" as Hex,
    };
}

const OWNER = Keypair.random().publicKey();
const POOL_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const KEYSTORE_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 2));
const ASP_REGISTRY_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 3));

function minimalConfig(overrides: Partial<Parameters<typeof StellarPoolSessionBuilder.create>[0]> = {}) {
    return {
        chainId: 1,
        ownerAddress: OWNER,
        rpcUrl: "https://soroban-testnet.example.com",
        networkPassphrase: "Test SDF Network ; September 2015",
        poolContractId: POOL_CONTRACT_ID,
        keystoreContractId: KEYSTORE_CONTRACT_ID,
        aspRegistryContractId: ASP_REGISTRY_CONTRACT_ID,
        protocolKeys: validKeys(),
        ipfsGatewayUrl: "https://ipfs.example.com",
        circuitArtifactsDir: "/tmp/circuits",
        ...overrides,
    };
}

describe("StellarPoolSessionBuilder", () => {
    describe("create", () => {
        it("build a PoolSession from minimal config", async () => {
            const session = await StellarPoolSessionBuilder.create(minimalConfig());

            expect(session).toBeDefined();
            expect(session.prepareDeposit).toBeTypeOf("function");
            expect(session.prepareTransfer).toBeTypeOf("function");
            expect(session.prepareRageQuit).toBeTypeOf("function");
            expect(session.discoverNotes).toBeTypeOf("function");
            expect(session.exportAccount).toBeTypeOf("function");
        });

        it("build a working session with a keypair wallet interactor configured", async () => {
            const signer = Keypair.random();
            const session = await StellarPoolSessionBuilder.create(
                minimalConfig({
                    walletInteractor: { type: "keypair", secretKey: signer.secret() },
                }),
            );

            expect(session).toBeDefined();
        });

        it("build a session with a freighter wallet interactor defaulting to createFreighterProvider", async () => {
            // No `provider` override — proves the builder wires createFreighterProvider() as the
            // default rather than requiring every caller to build their own adapter.
            const session = await StellarPoolSessionBuilder.create(
                minimalConfig({
                    walletInteractor: { type: "freighter" },
                }),
            );

            expect(session).toBeDefined();
        });

        it("build a session using the IPFS circuit path when circuitGatewayUrls/circuitManifest are supplied", async () => {
            const session = await StellarPoolSessionBuilder.create(
                minimalConfig({
                    circuitArtifactsDir: undefined,
                    circuitGatewayUrls: ["https://ipfs.example.com"],
                    circuitManifest: {
                        deposit: {
                            wasm: DEPOSIT_WASM_CID,
                            provingKey: DEPOSIT_PKEY_CID,
                            verificationKey: DEPOSIT_VKEY_CID,
                        },
                    } as never,
                }),
            );

            expect(session).toBeDefined();
        });

        it("throw InvalidBuilderConfig when protocolKeys is missing and no keystoreManager override", async () => {
            await expect(
                StellarPoolSessionBuilder.create(
                    minimalConfig({ protocolKeys: undefined }),
                ),
            ).rejects.toThrow(InvalidBuilderConfig);
        });

        it("throw InvalidBuilderConfig when no circuit path is configured", async () => {
            await expect(
                StellarPoolSessionBuilder.create(
                    minimalConfig({ circuitArtifactsDir: undefined }),
                ),
            ).rejects.toThrow(InvalidBuilderConfig);
        });

        it("build a session wired to a real StellarRelayerInteractor when relayers is supplied", async () => {
            const relayer = {
                url: "https://relayer1.example.com",
                name: "Test Stellar Relayer",
                chainId: 1,
                chainType: "stellar",
                status: "active" as const,
                address: Keypair.random().publicKey(),
                processorAddress: Keypair.random().publicKey(),
            };

            // Regression coverage for wiring StellarRelayerInteractor (not the EVM-shaped
            // RelayerInteractor) into the builder: its constructor needs the internally-built
            // `proofService`, a config field the generic class's constructor doesn't take, so a
            // wiring mistake that dropped it would surface here as a missing-dependency error.
            const session = await StellarPoolSessionBuilder.create(
                minimalConfig({ relayers: [relayer] }),
            );

            expect(session).toBeDefined();
        });
    });
});
