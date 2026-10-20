import { resolveCorsOrigins } from "./relayer-config";
import { zConfig } from "./schemas";

// Real coverage for the CORS origin resolution handed to enableCors({ origin }).
// Exercises the pure helper directly (no filesystem / process.env), the same way
// evm-chain-config.spec.ts tests EvmChainConfigWrapper without a full RelayerConfig.

const VERCEL_PATTERN = "^https://privacy-pools-website-v2-git-[a-z0-9-]+-0xbow\\.vercel\\.app$";
const PREVIEW_ORIGIN = "https://privacy-pools-website-v2-git-feat-demo-ux-ideas-0xbow.vercel.app";

describe("resolveCorsOrigins", () => {
    it('returns "*" when nothing is configured anywhere', () => {
        expect(resolveCorsOrigins(undefined, {})).toBe("*");
        expect(resolveCorsOrigins({}, {})).toBe("*");
        expect(resolveCorsOrigins({ origins: [], origin_patterns: [] }, {})).toBe("*");
    });

    it("uses exact origins from the config file", () => {
        const resolved = resolveCorsOrigins({ origins: ["https://v2.privacypools.com"] }, {});
        expect(resolved).toEqual(["https://v2.privacypools.com"]);
    });

    it("CORS_ORIGIN env overrides config origins (comma-separated, trimmed)", () => {
        const resolved = resolveCorsOrigins(
            { origins: ["https://from-config.example"] },
            { CORS_ORIGIN: "https://a.example, https://b.example ," }
        );
        expect(resolved).toEqual(["https://a.example", "https://b.example"]);
    });

    it("compiles config origin_patterns to RegExps that match preview origins", () => {
        const resolved = resolveCorsOrigins({ origin_patterns: [VERCEL_PATTERN] }, {});
        expect(Array.isArray(resolved)).toBe(true);
        const [pattern] = resolved as RegExp[];
        expect(pattern).toBeInstanceOf(RegExp);
        expect(pattern.test(PREVIEW_ORIGIN)).toBe(true);
        expect(pattern.test("https://evil.example")).toBe(false);
    });

    it("CORS_ORIGIN_PATTERN env overrides config patterns and is never comma-split", () => {
        const withCommas = "^https://(a|b)\\.example$|^https://c{1,2}\\.example$";
        const resolved = resolveCorsOrigins(
            { origin_patterns: [VERCEL_PATTERN] },
            { CORS_ORIGIN_PATTERN: withCommas }
        ) as RegExp[];
        expect(resolved).toHaveLength(1);
        expect(resolved[0].test("https://a.example")).toBe(true);
        expect(resolved[0].test("https://cc.example")).toBe(true);
        expect(resolved[0].test(PREVIEW_ORIGIN)).toBe(false);
    });

    it("combines exact origins and patterns into one array", () => {
        const resolved = resolveCorsOrigins(
            { origins: ["https://v2.privacypools.com"], origin_patterns: [VERCEL_PATTERN] },
            {}
        ) as (string | RegExp)[];
        expect(resolved).toHaveLength(2);
        expect(resolved[0]).toBe("https://v2.privacypools.com");
        expect(resolved[1]).toBeInstanceOf(RegExp);
    });

    it("env list combines with config patterns (env only replaces its own dimension)", () => {
        const resolved = resolveCorsOrigins(
            { origins: ["https://from-config.example"], origin_patterns: [VERCEL_PATTERN] },
            { CORS_ORIGIN: "https://from-env.example" }
        ) as (string | RegExp)[];
        expect(resolved[0]).toBe("https://from-env.example");
        expect(resolved[1]).toBeInstanceOf(RegExp);
    });

    it("throws on an invalid CORS_ORIGIN_PATTERN instead of silently allowing nothing", () => {
        expect(() => resolveCorsOrigins(undefined, { CORS_ORIGIN_PATTERN: "([" })).toThrow(
            /not a valid regular expression/
        );
    });

    it('treats empty-string env vars as unset (falls back to config, then "*")', () => {
        expect(resolveCorsOrigins(undefined, { CORS_ORIGIN: "", CORS_ORIGIN_PATTERN: "" })).toBe("*");
        const resolved = resolveCorsOrigins(
            { origins: ["https://from-config.example"] },
            { CORS_ORIGIN: "" }
        );
        expect(resolved).toEqual(["https://from-config.example"]);
    });
});

describe("zConfig cors section", () => {
    const chains = { evm: [] };

    it("accepts a config without a cors section (backwards compatible)", () => {
        expect(() => zConfig.parse({ chains })).not.toThrow();
    });

    it("accepts origins plus valid origin_patterns", () => {
        const parsed = zConfig.parse({
            chains,
            cors: { origins: ["https://v2.privacypools.com"], origin_patterns: [VERCEL_PATTERN] },
        });
        expect(parsed.cors?.origin_patterns).toEqual([VERCEL_PATTERN]);
    });

    it("rejects an origin_pattern that does not compile as a regex", () => {
        expect(() => zConfig.parse({ chains, cors: { origin_patterns: ["(["] } })).toThrow(
            /valid regular expression/
        );
    });

    it("rejects unknown keys in the cors section (strict)", () => {
        expect(() => zConfig.parse({ chains, cors: { allow_all: true } })).toThrow();
    });
});
