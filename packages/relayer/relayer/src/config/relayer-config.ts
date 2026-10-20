import { Injectable } from "@nestjs/common";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Chain } from "./chain";
import { zConfig } from "./schemas";
import { Chains, Config, CorsConfig } from "./types";

const DEFAULT_CONFIG_PATH = resolve(__dirname, "../../relayer.config.json");

export type CorsOrigins = "*" | (string | RegExp)[];

/**
 * Resolves the browser-origin allowlist handed to enableCors({ origin }).
 * Env wins over the config file (same convention as EvmChainConfigWrapper):
 * CORS_ORIGIN (comma-separated exact origins) overrides cors.origins, and
 * CORS_ORIGIN_PATTERN (a single regex — no comma-splitting, regexes may
 * contain commas) overrides cors.origin_patterns. Strings and compiled
 * RegExps are combined into one array: the cors package matches strings
 * exactly and RegExps via .test(), and a non-matching origin gets a plain
 * no-allow-origin denial instead of an error. With nothing configured
 * anywhere the API stays open ("*").
 */
export function resolveCorsOrigins(
    cors: CorsConfig | undefined,
    env: Record<string, string | undefined> = process.env
): CorsOrigins {
    const origins = env.CORS_ORIGIN
        ? env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
        : (cors?.origins ?? []);
    const patternSources = env.CORS_ORIGIN_PATTERN ? [env.CORS_ORIGIN_PATTERN] : (cors?.origin_patterns ?? []);
    const patterns = patternSources.map((source) => {
        try {
            return new RegExp(source);
        } catch (e) {
            throw new Error(`CORS_ORIGIN_PATTERN is not a valid regular expression: ${source} (${e})`);
        }
    });

    const combined = [...origins, ...patterns];
    return combined.length > 0 ? combined : "*";
}

@Injectable()
export class RelayerConfig {
    private config: Config;

    constructor() {
        const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        this.config = zConfig.parse(raw);
    }

    chain<T extends keyof Chains>(chainType: T): Chain<T> {
        const chains = this.config.chains as Chains;
        return new Chain(chainType, chains[chainType]);
    }

    fullConfig(): Config {
        return this.config;
    }

    corsOrigins(): CorsOrigins {
        return resolveCorsOrigins(this.config.cors);
    }
}
