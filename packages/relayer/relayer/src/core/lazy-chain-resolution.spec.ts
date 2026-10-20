import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types";
import { ClsModule } from "nestjs-cls";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { CoreModule } from "./core.module";
import { QuoteModule } from "../quote/quote.module";
import { RelayModule } from "../relay/relay.module";
import { RelayerConfig } from "../config/relayer-config";
import { Chain } from "../config/chain";
import type { Config } from "../config/types";

// Regression coverage for a real production bug: QUOTE_SERVICE's (and, identically,
// RELAY_SERVICE's) factory used to `inject` all three chain services (Evm/Starknet/Stellar) by
// class, and NestJS eagerly constructs every injected param of a factory before invoking it —
// so EVERY request constructed EvmQuoteService (and its EvmConfigService) too, regardless of
// the request's own chainType. EvmConfigService's constructor throws when its chain has no
// config entry for the requested chainId, so a relayer config that only configures Stellar
// broke every Stellar request with "Config for chainId X not found on chain evm" before the
// switch on chainType in quote.module.ts was ever reached. That module now resolves only the
// requested chain's service lazily via ModuleRef; this drives a real HTTP request through the
// actual QuoteModule (not a reimplementation of Nest's request-scoped DI plumbing) to prove it.

const VALID_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 5));

function stellarOnlyConfig(): Config {
    return {
        chains: {
            // No `evm` key at all — the exact shape that used to break every Stellar request.
            stellar: [
                {
                    id: 1,
                    name: "testnet",
                    network_passphrase: "Test SDF Network ; September 2015",
                    rpc_url: "https://soroban-testnet.stellar.org",
                    pool_contract: VALID_CONTRACT,
                    relay_contract: VALID_CONTRACT,
                    keystore_contract: VALID_CONTRACT,
                    asp_registry_contract: VALID_CONTRACT,
                    supported_assets: [{ address: VALID_CONTRACT, ticker: "USDC", decimals: 7 }],
                    fee_receiver_address: Keypair.random().publicKey(),
                    signer_secret_key: Keypair.random().secret(),
                    flat_fee_amount: 100n,
                    quote_expiration_ms: 60_000,
                },
            ],
        },
    } as Config;
}

function fakeRelayerConfig(config: Config): RelayerConfig {
    // Delegates to the real `Chain` class (config/chain.ts) so `.config(chainId)`'s throw
    // behavior — the actual bug — is exercised for real, not reimplemented.
    return {
        chain: (chainType: keyof Config["chains"]) => new Chain(chainType, config.chains[chainType]),
        fullConfig: () => config,
        corsOrigins: () => "*" as const,
    } as unknown as RelayerConfig;
}

describe("lazy per-chain service resolution (QUOTE_SERVICE)", () => {
    let app: INestApplication;
    const ORIGINAL_ALLOW_MOCK_RATE_PROVIDER = process.env.ALLOW_MOCK_RATE_PROVIDER;

    beforeAll(async () => {
        process.env.ALLOW_MOCK_RATE_PROVIDER = "false";
        const moduleRef = await Test.createTestingModule({
            imports: [ClsModule.forRoot({ global: true }), CoreModule, QuoteModule.forRoot()],
        })
            .overrideProvider(RelayerConfig)
            .useValue(fakeRelayerConfig(stellarOnlyConfig()))
            .compile();

        app = moduleRef.createNestApplication();
        await app.init();
    });

    afterAll(async () => {
        await app.close();
        process.env.ALLOW_MOCK_RATE_PROVIDER = ORIGINAL_ALLOW_MOCK_RATE_PROVIDER;
    });

    it("does not leak EVM's missing config into a Stellar-typed request", async () => {
        // An empty body is invalid regardless — the point is which validation it fails.
        // Before the fix, this never reached validation: EvmConfigService's constructor threw
        // "Config for chainId 1 not found on chain evm" during QUOTE_SERVICE resolution, for a
        // request that named chainType=stellar and never should have touched EVM's config.
        const response = await request(app.getHttpServer() as App).post("/quote/stellar/1/send").send({});

        expect(response.status).toBe(400);
        expect(JSON.stringify(response.body)).not.toMatch(/not found on chain evm/);
    });

    it("still surfaces the real per-chain config error for the chain actually requested", async () => {
        // chainId 2 isn't in the fixture's single-entry `stellar` array — this must still throw
        // the real "Config for chainId 2 not found on chain stellar" error; the fix only stops
        // OTHER chains' missing config from leaking into a request, not per-chain validation.
        const response = await request(app.getHttpServer() as App).post("/quote/stellar/2/send").send({});

        expect(response.status).toBe(400);
        expect(JSON.stringify(response.body)).toMatch(/Config for chainId 2 not found on chain stellar/);
    });
});

describe("lazy per-chain service resolution (RELAY_SERVICE)", () => {
    let app: INestApplication;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [ClsModule.forRoot({ global: true }), CoreModule, RelayModule.forRoot()],
        })
            .overrideProvider(RelayerConfig)
            .useValue(fakeRelayerConfig(stellarOnlyConfig()))
            .compile();

        app = moduleRef.createNestApplication();
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    it("does not leak EVM's missing config into a Stellar-typed relay request", async () => {
        const response = await request(app.getHttpServer() as App).post("/relay/stellar/1/withdrawal").send({});

        expect(response.status).toBe(400);
        expect(JSON.stringify(response.body)).not.toMatch(/not found on chain evm/);
    });
});
