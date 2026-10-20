import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DustRescueConfigService } from "./dust-rescue-config.service";

const VALID_CONFIG = {
    chains: [
        {
            chainId: 42161,
            rpcUrl: "https://arb1.arbitrum.io/rpc",
            aspUrl: "https://asp.example.com",
            circuitArtifactsDir: "/artifacts",
            minWorthUsdMicros: "2000000",
        },
    ],
};

describe("DustRescueConfigService", () => {
    let dir: string;
    let configPath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "dust-rescue-config-"));
        configPath = join(dir, "config.json");
        process.env.CONFIG_PATH = configPath;
        process.env.DUST_RESCUE_SIGNER_PRIVATE_KEY =
            "0x0000000000000000000000000000000000000000000000000000000000000001";
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        delete process.env.CONFIG_PATH;
        delete process.env.DUST_RESCUE_SIGNER_PRIVATE_KEY;
    });

    it("parses a valid config file and exposes per-chain accessors.", () => {
        writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

        const service = new DustRescueConfigService();

        expect(service.chain(42161).rpcUrl).toBe("https://arb1.arbitrum.io/rpc");
        expect(service.pubsubTopic()).toBe("dust-rescue.pending"); // default
        expect(service.firestoreCollection()).toBe("dustRescueJobs"); // default
        expect(service.sweepMaxAttempts()).toBe(5); // default
    });

    it("throws when looking up an unconfigured chain.", () => {
        writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

        const service = new DustRescueConfigService();

        expect(() => service.chain(8453)).toThrow(/not configured/);
    });

    it("reads the signer key from the env var, never from the config file.", () => {
        writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

        const service = new DustRescueConfigService();

        expect(service.signerPrivateKey()).toBe(process.env.DUST_RESCUE_SIGNER_PRIVATE_KEY);
    });

    it("throws at construction when DUST_RESCUE_SIGNER_PRIVATE_KEY is unset.", () => {
        writeFileSync(configPath, JSON.stringify(VALID_CONFIG));
        delete process.env.DUST_RESCUE_SIGNER_PRIVATE_KEY;

        expect(() => new DustRescueConfigService()).toThrow(/DUST_RESCUE_SIGNER_PRIVATE_KEY/);
    });

    it("returns the configured per-chain USD floor.", () => {
        writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

        const service = new DustRescueConfigService();

        expect(service.minWorthUsdMicros(42161)).toBe(2000000n);
    });

    it("defaults sweepBatchSize when omitted.", () => {
        writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

        const service = new DustRescueConfigService();

        expect(service.sweepBatchSize()).toBe(30);
    });

    it("honors a configured sweepBatchSize.", () => {
        writeFileSync(configPath, JSON.stringify({ ...VALID_CONFIG, sweepBatchSize: 5 }));

        const service = new DustRescueConfigService();

        expect(service.sweepBatchSize()).toBe(5);
    });

    it("defaults notFoundAgeOutMs to 6 hours when omitted.", () => {
        writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

        const service = new DustRescueConfigService();

        expect(service.notFoundAgeOutMs()).toBe(6 * 60 * 60 * 1000);
    });

    it("converts a configured notFoundAgeOutHours to milliseconds.", () => {
        writeFileSync(configPath, JSON.stringify({ ...VALID_CONFIG, notFoundAgeOutHours: 2 }));

        const service = new DustRescueConfigService();

        expect(service.notFoundAgeOutMs()).toBe(2 * 60 * 60 * 1000);
    });
});
