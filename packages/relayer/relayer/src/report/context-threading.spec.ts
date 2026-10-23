import { Inject, Injectable, Module, Scope } from "@nestjs/common";
import { ContextIdFactory, ModuleRef, REQUEST } from "@nestjs/core";
import { Test } from "@nestjs/testing";

/**
 * `ReportsService` synthesizes a "request" for a chain that was never driven by a real HTTP call,
 * then relies on two levels of request-scoped resolution to recover it: `REPORT_SERVICE`'s
 * token-level factory (report.module.ts) reads `request.contextId` and resolves a concrete chain
 * service under it, and THAT service's own dependencies (e.g. `CHAIN_CONTEXT`) resolve under the
 * same id again. This file proves that two-level chain works and stays isolated across concurrent
 * chains, independent of the real module graph (CoreModule/EvmConfigService/...), which would pull
 * in unrelated config/env requirements a unit test shouldn't need.
 *
 * Why `request.contextId` and not `ContextIdFactory.getByRequest(request)` (what
 * RELAY_SERVICE/QUOTE_SERVICE's factories use): `getByRequest` only recovers a cached id from a
 * request Nest's own router already tagged via a private, unexported symbol
 * (`REQUEST_CONTEXT_ID`) on the way in. A synthesized request was never tagged, so `getByRequest`
 * would silently mint a brand-new id instead of the one the outer `moduleRef.resolve(...)` call
 * used — see report.module.ts's `FakeChainRequest` doc for the full reasoning.
 */
const CHAIN_ID = Symbol("CHAIN_ID_FIXTURE");
const CHAIN_SERVICE = Symbol("CHAIN_SERVICE_FIXTURE");

interface FixtureRequest {
    chainId: number;
    contextId: ReturnType<typeof ContextIdFactory.create>;
}

@Injectable({ scope: Scope.REQUEST })
class ChainBoundService {
    constructor(@Inject(CHAIN_ID) public readonly chainId: number) {}
}

@Module({
    providers: [
        {
            provide: CHAIN_ID,
            scope: Scope.REQUEST,
            useFactory: (request: FixtureRequest) => request.chainId,
            inject: [REQUEST],
        },
        ChainBoundService,
        {
            // Mirrors REPORT_SERVICE's factory shape: reads the contextId off the synthesized
            // request, then resolves a concrete class under that SAME id.
            provide: CHAIN_SERVICE,
            scope: Scope.REQUEST,
            useFactory: (request: FixtureRequest, moduleRef: ModuleRef) => moduleRef.resolve(ChainBoundService, request.contextId, { strict: false }),
            inject: [REQUEST, ModuleRef],
        },
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FixtureModule {}

describe("contextId threading (the mechanism ReportsService/report.module.ts rely on)", () => {
    it("resolves a two-level request-scoped chain to the value registered for its own contextId", async () => {
        const moduleFixture = await Test.createTestingModule({ imports: [FixtureModule] }).compile();
        const moduleRef = moduleFixture.get(ModuleRef);

        const contextId = ContextIdFactory.create();
        const fakeRequest: FixtureRequest = { chainId: 8453, contextId };
        moduleRef.registerRequestByContextId(fakeRequest, contextId);

        const service = await moduleRef.resolve<ChainBoundService>(CHAIN_SERVICE, contextId, { strict: false });

        expect(service.chainId).toBe(8453);
    });

    it("keeps two concurrently-resolved chains isolated from each other", async () => {
        const moduleFixture = await Test.createTestingModule({ imports: [FixtureModule] }).compile();
        const moduleRef = moduleFixture.get(ModuleRef);

        const contextIdA = ContextIdFactory.create();
        moduleRef.registerRequestByContextId({ chainId: 1, contextId: contextIdA } satisfies FixtureRequest, contextIdA);
        const contextIdB = ContextIdFactory.create();
        moduleRef.registerRequestByContextId({ chainId: 56, contextId: contextIdB } satisfies FixtureRequest, contextIdB);

        const [a, b] = await Promise.all([
            moduleRef.resolve<ChainBoundService>(CHAIN_SERVICE, contextIdA, { strict: false }),
            moduleRef.resolve<ChainBoundService>(CHAIN_SERVICE, contextIdB, { strict: false }),
        ]);

        expect(a.chainId).toBe(1);
        expect(b.chainId).toBe(56);
    });
});
