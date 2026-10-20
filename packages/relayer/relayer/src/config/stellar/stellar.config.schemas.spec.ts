import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { zStellarAddress, zStellarAssetConfig, zStellarChainConfig, zStellarSecretKey } from "./stellar.config.schemas";

const VALID_ADDRESS = Keypair.random().publicKey();
const VALID_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 5));
const VALID_SECRET = Keypair.random().secret();

describe("zStellarAddress", () => {
    it("accepts a valid account (G...) StrKey", () => {
        expect(zStellarAddress.parse(VALID_ADDRESS)).toBe(VALID_ADDRESS);
    });

    it("accepts a valid contract (C...) StrKey", () => {
        expect(zStellarAddress.parse(VALID_CONTRACT)).toBe(VALID_CONTRACT);
    });

    it("rejects a malformed StrKey", () => {
        expect(() => zStellarAddress.parse("not-a-strkey")).toThrow();
    });

    it("rejects an EVM-shaped address", () => {
        expect(() => zStellarAddress.parse("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toThrow();
    });
});

describe("zStellarSecretKey", () => {
    it("accepts a valid Keypair secret", () => {
        expect(zStellarSecretKey.parse(VALID_SECRET)).toBe(VALID_SECRET);
    });

    it("rejects a public key in place of a secret", () => {
        expect(() => zStellarSecretKey.parse(Keypair.random().publicKey())).toThrow();
    });

    it("rejects a malformed secret", () => {
        expect(() => zStellarSecretKey.parse("Snotvalid")).toThrow();
    });
});

describe("zStellarAssetConfig — required token decimals", () => {
    const base = { address: VALID_CONTRACT, ticker: "USDC" };

    it("fails loudly when decimals is missing (no silent default)", () => {
        expect(() => zStellarAssetConfig.parse(base)).toThrow();
    });

    it("coerces a string decimals to a number", () => {
        expect(zStellarAssetConfig.parse({ ...base, decimals: "7" }).decimals).toBe(7);
    });

    it("rejects an empty string instead of coercing it to 0", () => {
        expect(() => zStellarAssetConfig.parse({ ...base, decimals: "" })).toThrow();
    });
});

describe("zStellarChainConfig", () => {
    const validConfig = {
        id: 1,
        name: "testnet",
        network_passphrase: "Test SDF Network ; September 2015",
        rpc_url: "https://soroban-testnet.stellar.org",
        pool_contract: VALID_CONTRACT,
        relay_contract: VALID_CONTRACT,
        keystore_contract: VALID_CONTRACT,
        asp_registry_contract: VALID_CONTRACT,
        supported_assets: [{ address: VALID_CONTRACT, ticker: "USDC", decimals: 7 }],
        fee_receiver_address: VALID_ADDRESS,
        signer_secret_key: VALID_SECRET,
    };

    it("parses a complete valid config", () => {
        const parsed = zStellarChainConfig.parse(validConfig);
        expect(parsed.id).toBe(1);
        expect(parsed.flat_fee_amount).toBe(100n); // default
    });

    it("rejects a config missing the signer secret key", () => {
        const { signer_secret_key: _drop, ...withoutSecret } = validConfig;
        expect(() => zStellarChainConfig.parse(withoutSecret)).toThrow();
    });

    it("rejects a config with an EVM-shaped contract address", () => {
        expect(() =>
            zStellarChainConfig.parse({ ...validConfig, relay_contract: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" })
        ).toThrow();
    });
});
