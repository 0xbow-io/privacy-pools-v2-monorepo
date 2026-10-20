import { Test, TestingModule } from "@nestjs/testing";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StellarDetailsService } from "./stellar.details.service";
import { RelayerConfig } from "../config/relayer-config";
import { Chain } from "../config/chain";
import { ChainType } from "../config/enums";
import { createMockLoggerProvider } from "../test/mocks";
import { version as packageVersion } from "../../package.json";

const POOL = StrKey.encodeContract(Buffer.alloc(32, 1));
const RELAY = StrKey.encodeContract(Buffer.alloc(32, 2));
const KEYSTORE = StrKey.encodeContract(Buffer.alloc(32, 3));
const ASP_REGISTRY = StrKey.encodeContract(Buffer.alloc(32, 4));
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 5));
const SIGNER = Keypair.random();

function fakeChain(id: number, name: string) {
    return {
        id,
        name,
        network_passphrase: "Test SDF Network ; September 2015",
        rpc_url: "https://soroban-testnet.stellar.org",
        pool_contract: POOL,
        relay_contract: RELAY,
        keystore_contract: KEYSTORE,
        asp_registry_contract: ASP_REGISTRY,
        fee_receiver_address: Keypair.random().publicKey(),
        signer_secret_key: SIGNER.secret(),
        flat_fee_amount: 100n,
        quote_expiration_ms: 60_000,
        supported_assets: [{ address: ASSET, ticker: "USDC", decimals: 7, fee_bps: 50n }],
    };
}

async function buildService(chains: ReturnType<typeof fakeChain>[]): Promise<StellarDetailsService> {
    const relayerConfig = {
        chain: (chainType: ChainType.STELLAR) => new Chain(chainType, chains as never),
        fullConfig: () => ({ chains: { stellar: chains } }),
    };

    const module: TestingModule = await Test.createTestingModule({
        providers: [
            StellarDetailsService,
            createMockLoggerProvider(),
            { provide: RelayerConfig, useValue: relayerConfig },
        ],
    }).compile();

    return module.get<StellarDetailsService>(StellarDetailsService);
}

describe("StellarDetailsService", () => {
    describe("chainDetails", () => {
        it("returns the contracts block and the signer address as relayerAddress", async () => {
            const service = await buildService([fakeChain(1, "stellar-testnet")]);

            const details = await service.chainDetails(1);

            expect(details.contracts).toEqual({ pool: POOL, relay: RELAY, keystore: KEYSTORE, aspRegistry: ASP_REGISTRY });
            expect(details.relayerAddress).toBe(SIGNER.publicKey());
            expect(details.type).toBe(ChainType.STELLAR);
        });

        it("maps assets with their fee_bps", async () => {
            const service = await buildService([fakeChain(1, "stellar-testnet")]);

            const details = await service.chainDetails(1);

            expect(details.assets).toEqual([
                { address: ASSET, ticker: "USDC", fixedFeeAmount: 100n, feeBPS: 50 },
            ]);
        });
    });

    describe("assetDetails", () => {
        it("returns a specific asset's details", async () => {
            const service = await buildService([fakeChain(1, "stellar-testnet")]);

            const asset = await service.assetDetails(1, ASSET);

            expect(asset.ticker).toBe("USDC");
            expect(asset.fixedFeeAmount).toBe(100n);
        });

        it("throw for an asset not configured on the chain", async () => {
            const service = await buildService([fakeChain(1, "stellar-testnet")]);
            const unknownAsset = StrKey.encodeContract(Buffer.alloc(32, 9));

            await expect(service.assetDetails(1, unknownAsset)).rejects.toThrow();
        });
    });

    describe("allDetails", () => {
        it("carries the package.json version and every configured Stellar chain", async () => {
            const service = await buildService([fakeChain(1, "stellar-testnet"), fakeChain(2, "stellar-mainnet")]);

            const all = await service.allDetails();

            expect(all.version).toBe(packageVersion);
            expect(all.chains.map((c) => c.id)).toEqual([1, 2]);
        });

        it("returns an empty chains array when no Stellar chain is configured", async () => {
            const service = await buildService([]);

            const all = await service.allDetails();

            expect(all.chains).toEqual([]);
        });
    });
});
