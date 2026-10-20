import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hex } from "viem";
import { zDustRescueConfig, type DustRescueChainConfig, type DustRescueConfig } from "./config.schemas";

const DEFAULT_CONFIG_PATH = resolve(__dirname, "../../dust-rescue-service.config.json");

/**
 * Loads and validates this service's own config (per dust_collection_service_detailed_design.org §2)
 * — independent of the relayer's RelayerConfig/ChainConfigWrapper, since this is a separately
 * deployed service. The Child 1 signer key is never part of the JSON file; it's read once from
 * DUST_RESCUE_SIGNER_PRIVATE_KEY (Secret Manager-mounted at deploy time), mirroring the relayer's
 * "public shape in file, secret via env" split without the per-chain suffix, since there's exactly
 * one signer for every destination chain.
 */
@Injectable()
export class DustRescueConfigService {
    private readonly config: DustRescueConfig;
    private readonly signerKey: Hex;

    constructor() {
        const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        this.config = zDustRescueConfig.parse(raw);

        const envKey = process.env.DUST_RESCUE_SIGNER_PRIVATE_KEY;
        if (!envKey) {
            throw new InternalServerErrorException(
                "DUST_RESCUE_SIGNER_PRIVATE_KEY is not set — this service cannot sign rescue deposits without it."
            );
        }
        this.signerKey = envKey as Hex;
    }

    chain(chainId: number): DustRescueChainConfig {
        const found = this.config.chains.find((c) => c.chainId === chainId);
        if (!found) {
            throw new InternalServerErrorException(`Chain ${chainId} is not configured as a dust-rescue destination`);
        }
        return found;
    }

    signerPrivateKey(): Hex {
        return this.signerKey;
    }

    pubsubTopic(): string {
        return this.config.pubsubTopic;
    }

    firestoreCollection(): string {
        return this.config.firestoreCollection;
    }

    sweepMaxAttempts(): number {
        return this.config.sweepMaxAttempts;
    }

    sweepBatchSize(): number {
        return this.config.sweepBatchSize;
    }

    notFoundAgeOutMs(): number {
        return this.config.notFoundAgeOutHours * 60 * 60 * 1000;
    }

    minWorthUsdMicros(chainId: number): bigint {
        return this.chain(chainId).minWorthUsdMicros;
    }
}
