# Relayer Package — Coding Standards

The NestJS app lives at `packages/relayer/relayer/` (nested); the outer
`packages/relayer/` also holds `e2e/` and `mockedContracts/`. Run all commands
(`pnpm test`, `pnpm lint`, `pnpm build`) from `packages/relayer/relayer/`.

This file resolves the dangling CONV-3 reference in `docs/FEATURE_BEST_PRACTICES.md`.
It documents the conventions **already in force** across the relayer (inferred from
the codebase); it is descriptive, not aspirational.

**One deliberate exception:** §4b (Operator Alerts) is a convention introduced by the
alert-system change (2026-10-16), not yet in long-standing force. Revisit it once the
dispatcher has been live for a release or two.

## Pre-Flight Checklist

Before writing or modifying relayer code, verify against these rules:

- [ ] **Request flow** — A new endpoint follows: validation pipe → zod schema → service → chain service. No business logic in controllers.
- [ ] **Schema naming** — Every zod schema is `zXxx` (e.g. `zEvmRelayWithdrawalRequest`); its inferred type is `Xxx` via `z.infer`.
- [ ] **DTOs** — `XxxDto extends createZodDto(zXxx)` with `@ApiProperty` on each field for Swagger. The zod schema is the single source of truth for shape/validation.
- [ ] **Logger first** — `FATLoggerService` is the first constructor dependency of any service.
- [ ] **Client errors** — Throw `BadRequestException` (bad input) / `NotImplementedException` (unsupported chain); never return ad-hoc error objects.
- [ ] **Request scope** — Services and chain services are `@Injectable({ scope: Scope.REQUEST })` (per-chain context is request-bound).
- [ ] **Specs** — Colocate `*.spec.ts` next to the unit; use `jest` + `jest-mock-extended` (`mock<T>()`).
- [ ] **SDK reuse** — Import shared fee/batch logic from the SDK subpaths, not reimplement it.

---

## 1. Request Pipeline (validation pipe → schema → service → chain service)

**When:** adding or changing any HTTP endpoint.

Every request SHOULD pass through a NestJS `PipeTransform` that calls a zod schema's
`.parse()` (the standard for new endpoints). Note one base-v2 exception: `getTransferQuote`
uses a bare `@Body()` with no pipe — mirror the validated-pipe form for new endpoints rather
than that exception. The controller then delegates to a chain-agnostic service interface
(`IQuoteService` / `IRelayService`), which is resolved per-chain via a DI token
(`QUOTE_SERVICE` / `RELAY_SERVICE`). The service talks to the on-chain layer only
through `EVMChainService` (viem read/simulate/write, EIP-712 signing) and
`EvmContractService`.

```ts
// GOOD — controller only delegates; validation is a pipe
@Post("batch")
async getBatchQuote(@Body(BatchQuoteValidationPipe) body: EvmBatchWithdrawalQuoteRequestDto) {
    return this.quoteService.quoteBatch(body);
}
```

Do NOT put fee math, signing, or chain calls in a controller.

---

## 2. Zod Schema is the Source of Truth (`zXxx` + `createZodDto`)

**When:** defining any request/response shape.

- Name the schema `zXxx`; derive the type as `export type Xxx = z.infer<typeof zXxx>`.
- Wire shapes live in `src/**/schemas.ts` (or `evm.schemas.ts`); inferred types in the sibling `types.ts`.
- DTOs (`src/dto/*.dto.ts`) extend `createZodDto(zXxx)` and add one `@ApiProperty` per field for Swagger. Fields are `declare`d (the value comes from the zod parse).
- Optional wire fields use `.optional()`; the DTO marks them `required: false`.

```ts
// schema
export const zEvmBatchQuoteRequest = zEvmShieldedQuoteRequest.extend({
    recipient: zEvmAddress,
    amounts: z.array(zNonNegativeBigInt.transform((v) => Wei(v))).min(1).max(MAX_BATCH),
});
// DTO
export class EvmBatchWithdrawalQuoteRequestDto extends createZodDto(zEvmBatchQuoteRequest) {
    @ApiProperty({ description: "Token address", type: "string" })
    declare asset: EvmAddress;
}
```

**Bound every unbounded array** at the schema layer (`.max(MAX_BATCH)`) so an
unauthenticated request cannot force O(N) work before signature/verification.

---

## 3. Signing is Gated on `commit === true`

**When:** any quote endpoint that can return a signed fee commitment.

The relayer signer is a shared, unauthenticated-facing resource. A quote MUST
only produce an EIP-712 signature when the request explicitly sets `commit: true`.
A non-committing quote returns the fee estimate WITHOUT a commitment (the
commitment field is `.optional()` in the response schema). This applies to
`quote()`, `quoteTransfer()`, AND `quoteBatch()`. (Regression origin: SEC-1,
code-review R1 — `quoteBatch` originally signed unconditionally.)

---

## 4. Client Errors via Nest Exceptions

**When:** rejecting bad input or an unsupported operation.

Throw `BadRequestException` for invalid input, expired/unverifiable commitments,
asset/amount mismatches, and disallowed processors; `NotImplementedException` for
unsupported chains; `ServiceUnavailableException` (503) for upstream faults — e.g.
the quote deadline breach in `src/quote/quote-deadline.interceptor.ts`
(`QUOTE_DEADLINE_MS`): an unresponsive RPC provider is an upstream fault, not a
client fault, so it must surface as a retryable 503, never a 4xx. Log the same
message via `this.logger.error(...)` before throwing. Never return `{ error }`
objects from a service for a client fault.

The relayer's own signer wallet running out of gas funds is likewise an
operator fault: `EVMChainService.failWrite` detects it (viem
`InsufficientFundsError` via `walk()`, plus an "insufficient funds" message
fallback) and maps it to a 503 with a static, arg-free message — and logs it at
`turbo`, the top-severity custom level above `error` (GCP `CRITICAL`, see
`src/logger/fat.logger.ts`) reserved for faults that stop the relayer from
operating at all. A `turbo` record also pages the operators through the alert transport
(`src/logger/alert-transport.ts`); any other record can opt in with `{ alert: true }` (see §4b).

A transaction whose gas estimate exceeds the relayer's broadcast cap
(`relay_gas_cap_multiplier` × the priced gas in `src/quote/evm/relay_gas_budget.ts`)
is a client fault too: `EVMChainService.writeWithGasCap` rejects it with a 400
before anything is signed. An accepted transaction is sent with gas limit
`relayGasLimit(estimate, cap)` = estimate + `RELAY_GAS_HEADROOM_BPS` (5%), never above the
cap; the over-cap check still compares the raw estimate. (The bare estimate is the minimum
for the previous block's state; 7 mainnet yield-router / RelaySwaps relays ran out of gas
with it, each ~0.8% short at inclusion.) Every relay/execute broadcast MUST go through that
helper, and every broadcast of any kind (it, `sendRawTransaction`, the generic
`writeContract`) MUST end in the private `EVMChainService.broadcast()` — which, under
the per chain+signer `withSignerLock`, runs the stuck-nonce check, applies the
`MIN_PRIORITY_FEE_WEI` tip floor and sends with an explicitly assigned nonce (viem's
`nonceManager` is not used; see `docs/tech-design/relayer/stuck-nonce-reconciliation.md`).
Never a bare `walletClient.writeContract(request)` / `sendTransaction`. Any new gas
constant belongs in `relay_gas_budget.ts` so the quote and the cap stay in sync.

```ts
if (processorAddress !== undefined && !this.config.isAllowedProcessor(processorAddress)) {
    const error = `processorAddress ${processorAddress} is not in the allowed_processors allowlist`;
    this.logger.error(error);
    throw new BadRequestException(error);
}
```

---

## 4b. Operator Alerts

> **Deliberate exception to this file's "descriptive, not aspirational" rule.** This section
> documents a convention introduced by the alert-system change (2026-10-16), not one already
> in force. Revisit it once `alert-dispatcher` has been live for a release or two.

Log records can page the operators (Pub/Sub `relayer-alerts` -> `alert-dispatcher` -> Telegram;
design in `docs/tech-design/relayer/alert-dispatcher.md`). The wiring is the Winston
`AlertTransport` in `src/logger/alert-transport.ts`, so no call-site plumbing is needed:

- **`turbo` pages.** Every `turbo` record is published at severity `turbo`. Use `turbo` only for
  faults that stop the relayer operating; the path is implicit, so don't log `turbo` casually.
- **Opt-in for anything else.** `logger.error(msg, { alert: true, dedupKey: "..." })` pages at
  severity `warn`. Plain `error`/`warn` never page.
- **`dedupKey` must be stable** per fault class (e.g. `dustRescue.<chainId>`, `relayer.lowBalance.<chainId>`), never derived from
  free text, ids or amounts; it keys the dispatcher's cooldown.
- **Never log secrets.** Alert text is redacted before leaving the process, but don't rely on it.
- **Never call the Winston logger (`FATLogger`) from inside the alert path**
  (`alert-publisher.ts`, `alert-transport.ts`): it would re-enter the transport and can loop if
  Pub/Sub itself is failing. Those files report their own failures with plain `console.error`.
- **Kill switch:** `RELAYER_ALERTS_DISABLED=true` (and `NODE_ENV=test`) disables publishing.

## 5. Constructor Dependency Order (Logger First)

**When:** writing a service/chain-service constructor.

`FATLoggerService` (aliased `logger`) is conventionally an early injected dependency
(logger-first in most services). This is a soft convention, not universal — base-v2
`EvmQuoteService` injects `ConfigService` first and `EVMChainService` injects
`@Inject(CHAIN_CONTEXT)` first, with the logger second; NestJS constructor order has no
behavioral effect. Services and chain services are `@Injectable({ scope: Scope.REQUEST })`.

---

## 6. EIP-712 Commitments

**When:** signing or verifying a relayer fee commitment.

- The domain is `{ name: "Privacy Pools Relayer", version: "1", chainId, verifyingContract }` where `verifyingContract` is the relay contract address (binds a commitment to one relay deployment).
- Types live in `RelayerCommitmentTypes` in `evm.chain.service.ts`. Aggregate amounts (`totalAmountSent/Received`) are NOT carried on the wire — the relay path recomputes them from the submitted proofs and verifies the signature against the recomputation, so tampering with any item's `amountOut` breaks verification.
- Every commitment carries an `expiration`; verification rejects expired commitments before checking the signature.

---

## 7. Dogfood the SDK, Don't Reimplement

**When:** you need batch-fee math, the PayoutRouting ABI, or `MAX_BATCH`.

Import from the SDK, not a local copy:

- `computeBatchFees`, `computeBatchItemFee`, `MAX_BATCH` — from `@privacy-pools-v2/sdk/batch-fee` (a dependency-light, CommonJS-friendly subpath; safe for ts-jest).
- `PAYOUT_ROUTING_ABI`, `PAYOUT_ROUTING_ARRAY_ABI`, `BatchWithdrawOrchestrator`, `selectNotesForFullWithdraw` — value-exported from `@privacy-pools-v2/sdk`.

Reimplementing this logic in the relayer (or the e2e harness) creates drift that
golden/drift tests then have to police. If a needed symbol appears missing at
runtime, verify the SDK `dist` is built (`pnpm build` in `packages/sdk`) before
concluding it is unexported.

---

## 8. Testing

**When:** adding any unit.

- Colocate `*.spec.ts` beside the unit under test.
- Use `jest` + `jest-mock-extended` (`mock<Service>()`); mock the logger via `createMockLoggerProvider()` from `src/test/mocks.ts`.
- Services and controllers are request-scoped → resolve them with `await module.resolve<T>(T)`, NOT `module.get<T>(T)`.
- To exercise a chain-service branch that hits viem, `jest.spyOn(service as unknown as { client }, "client")` / `"signer"` to inject stub public/wallet clients (see `evm.chain.service.roothistory.spec.ts` and `evm.chain.service.processor.spec.ts`).
- Module-level caches are NOT reset between tests — this covers `evm.chain.service.ts` (root-history / MAX_BATCH / gas-price caches AND the cached public viem clients, keyed `chainId:rpcUrl`) and the asset-config cache in `evm.contract.service.ts` (keyed `chainId:entrypoint:asset`, 60s TTL). Use distinct pool/relay/entrypoint/asset addresses (or RPC URLs) per case for isolation.
- Module-level nonce state in `chain.service/stuck-nonce.ts` is NOT reset between tests either: the per chain+signer locks, the last-assigned nonce per signer (`lastAssigned`, `NONCE_LOCAL_TRUST_MS` window) and `outstandingNonces`. Use a distinct `chainId` per case so one test's assignments/outstanding nonces don't leak into the next.
- Every new service branch needs: happy path, each error/`throw`, and (for guarded calls) the reject path. Controllers need a delegation test per route.

Run: `npx jest <path>` for a single spec (fast), full `npx jest` before finishing.
The SDK `dist` must be built first, or `@privacy-pools-v2/sdk/*` imports fail to resolve.
