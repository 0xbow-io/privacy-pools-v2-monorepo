import { createServer, type Server } from "node:http";

import { CryptoService } from "@privacy-pools-v2/evm-sdk";
import type { Hex } from "@privacy-pools-v2/evm-sdk";

/**
 * Real local HTTP server standing in for a live ASP endpoint, for integration-testing
 * `dust-rescue-service`/`dust-rescue-prover` end-to-end (issue #222 — see
 * dust_unification_feasibility_and_plan.org and docs/tech-design/relayer/dust-rescue-service.md
 * "Status / known gaps": no real ASP HTTP endpoint exists for the it-002 stack).
 *
 * Deliberately real transport, fake data — the opposite split from `local-asp-tree.ts`
 * (which is a real in-process `IASPDataProvider`, no HTTP at all, for SDK-level tests that
 * use `.withAspDataProvider()`). `dust-rescue-prover` always configures `aspUrl` and goes
 * through the real `HttpASPDataProvider` HTTP client
 * (packages/sdk/src/services/aspDataProviders/HttpASPDataProvider.ts) — that's exactly the
 * wiring this integration test needs to exercise, since unit tests already mock the ASP
 * client entirely and can't catch a real request/response/parsing bug in that path.
 *
 * Deposit-only scope, on purpose: `PoolSessionDeposit.prepareDepositFor()` — everything
 * `proveDustRescueDeposit` calls — only ever calls `getASPPublicKey()`
 * (packages/sdk/src/services/poolSessions/PoolSessionDeposit.ts:512), never
 * root/leaves/labels/event-snapshot/note-events (those are withdrawal/discovery
 * concerns). So `GET /public-key` is the only route implemented; anything else 501s
 * loudly rather than silently returning plausible-looking fake data for a call path
 * this mock was never meant to support.
 */
export interface LocalAspServer {
  /** Base URL to pass as `aspUrl` in dust-rescue-service's config. */
  url: string;
  /** The X25519 public key served at GET /public-key — real key material (via
   * CryptoService, the same primitive the SDK itself uses), just never persisted
   * or reused anywhere; nothing in a deposit-only flow needs to decrypt with it. */
  publicKey: Hex;
  close(): Promise<void>;
}

export async function startLocalAspServer(): Promise<LocalAspServer> {
  const { publicKey } = new CryptoService().generateEphemeralKeyPair();

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/public-key") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ publicKey }));
      return;
    }
    res.writeHead(501, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: `LocalAspServer: ${req.method} ${path} not implemented — deposit-only mock, see local-asp-server.ts`,
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("LocalAspServer: failed to bind to a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    publicKey,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
