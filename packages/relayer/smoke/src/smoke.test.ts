import { describe, expect, it } from "vitest";

// Deliberately not read from packages/relayer/relayer -- this package targets a live,
// already-deployed instance over HTTP only. It must stay standalone: no importing the
// relayer's own source, no shared ephemeral infra (unlike packages/relayer/e2e, which spins
// up its own Anvil fork + relayer and is not safe to point at a real deployment since its
// full suite executes real relays/withdrawals).
const RELAYER_URL = process.env.RELAYER_URL;
if (!RELAYER_URL) {
    throw new Error("RELAYER_URL must be set, e.g.: RELAYER_URL=https://your-deploy.example.com pnpm test");
}
const API_VERSION = process.env.API_VERSION ?? "v1";

// Flat, deliberately large notional so the quote endpoint's fee math clears any
// minimum-fee/dust threshold regardless of a given asset's actual decimals -- /details
// doesn't expose decimals, and a quote is a pure calculation (no real balance/allowance
// needed), so overpaying here is harmless. Matches the "1 ETH" convention already used
// for 18-decimal assets in packages/relayer/e2e.
const SMOKE_AMOUNT = "1000000000000000000";

interface AssetConfig {
    address: string;
    ticker: string;
}
interface ChainConfig {
    id: number;
    name: string;
    type: string;
    assets: AssetConfig[];
}
interface FullConfig {
    chains: ChainConfig[];
}

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
    const res = await fetch(`${RELAYER_URL}${path}`);
    const body = (await res.json()) as T;
    return { status: res.status, body };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// The quote routes are rate-limited (ThrottlerModule: 20/60s in app.module.ts) and shared
// by real traffic on a live deployment -- space requests out rather than bursting them, both
// to avoid tripping that limit ourselves and to not compete with real users' quota.
const QUOTE_REQUEST_SPACING_MS = 1_000;

describe("ping", () => {
    it("responds", async () => {
        const res = await fetch(`${RELAYER_URL}/${API_VERSION}/ping`);
        expect(res.status).toBe(200);
    });
});

describe("details", () => {
    it("returns at least one configured chain", async () => {
        const { status, body } = await getJson<FullConfig>(`/${API_VERSION}/details`);
        expect(status).toBe(200);
        expect(body.chains.length).toBeGreaterThan(0);
    });
});

// Every other asset-level test below is discovered from the live instance's own /details
// response rather than hardcoded, so this suite automatically covers whatever is actually
// configured on the deployment under test -- no manual list to keep in sync. If discovery
// itself fails, report that as one clear test rather than letting the whole file crash at
// collection time.
let config: FullConfig | undefined;
let discoveryError: unknown;
try {
    ({ body: config } = await getJson<FullConfig>(`/${API_VERSION}/details`));
} catch (err) {
    discoveryError = err;
}

if (!config) {
    it("could not discover configured assets via /details", () => {
        throw discoveryError instanceof Error ? discoveryError : new Error(String(discoveryError));
    });
} else {
    for (const chain of config.chains) {
        describe(`quote — ${chain.name} (chainId ${chain.id})`, () => {
            for (const asset of chain.assets) {
                it(`quotes ${asset.ticker} (${asset.address})`, async () => {
                    await sleep(QUOTE_REQUEST_SPACING_MS);

                    const res = await fetch(`${RELAYER_URL}/${API_VERSION}/quote/${chain.type}/${chain.id}/send`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            asset: asset.address,
                            amount: SMOKE_AMOUNT,
                            commit: false,
                            extraGas: false,
                        }),
                    });
                    const body = await res.json();

                    // NestJS defaults POST routes to 201 (no @HttpCode override on /send) --
                    // asserting the framework's actual current contract, not REST convention.
                    expect(res.status, `expected 201, got ${res.status}: ${JSON.stringify(body)}`).toBe(201);
                    expect(BigInt(body.feeAmount)).toBeGreaterThanOrEqual(0n);
                    expect(BigInt(body.amountReceived)).toBeGreaterThan(0n);
                });
            }
        });
    }
}

// Not covered yet, deliberately: verifying the deployed instance's on-chain contract
// addresses (entrypoint/relay/pool_vault) actually match what's expected. /details doesn't
// expose them today. Planned as a later addition once there's a source of truth to check
// against (e.g. a deployments manifest) -- kept out for now per the "start simple" scope.
