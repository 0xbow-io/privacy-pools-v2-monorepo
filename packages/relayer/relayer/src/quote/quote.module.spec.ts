import { DynamicModule } from "@nestjs/common";
import { RateProvider } from "../rate_provider/rate_types";

// `QuoteModule` reads `process.env.ALLOW_MOCK_RATE_PROVIDER` once at module load time, so each
// case needs a fresh module instance (via jest.resetModules() + require) rather than the
// statically-imported module, otherwise every test would observe whatever value was read first.
describe("QuoteModule.forRoot", () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...ORIGINAL_ENV };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    function registeredTokens(dynamicModule: DynamicModule): unknown[] {
        return (dynamicModule.imports ?? [])
            .filter((imp): imp is DynamicModule => typeof imp === "object" && imp !== null && "exports" in imp)
            .flatMap((imp) => imp.exports ?? []);
    }

    function freshQuoteModule(): typeof import("./quote.module") {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("./quote.module") as typeof import("./quote.module");
    }

    it("always registers Curve and Cowswap regardless of ALLOW_MOCK_RATE_PROVIDER", () => {
        process.env.ALLOW_MOCK_RATE_PROVIDER = "false";
        const tokens = registeredTokens(freshQuoteModule().QuoteModule.forRoot());

        expect(tokens).toContain(RateProvider.CURVE);
        expect(tokens).toContain(RateProvider.COWSWAP);
    });

    it("does not register Mock when ALLOW_MOCK_RATE_PROVIDER is unset", () => {
        process.env.ALLOW_MOCK_RATE_PROVIDER = "";
        const tokens = registeredTokens(freshQuoteModule().QuoteModule.forRoot());

        expect(tokens).not.toContain(RateProvider.MOCK);
    });

    it("does not register Mock for any value other than the literal string 'true'", () => {
        process.env.ALLOW_MOCK_RATE_PROVIDER = "1";
        const tokens = registeredTokens(freshQuoteModule().QuoteModule.forRoot());

        expect(tokens).not.toContain(RateProvider.MOCK);
    });

    it("registers Mock when ALLOW_MOCK_RATE_PROVIDER=true", () => {
        process.env.ALLOW_MOCK_RATE_PROVIDER = "true";
        const tokens = registeredTokens(freshQuoteModule().QuoteModule.forRoot());

        expect(tokens).toContain(RateProvider.MOCK);
        expect(tokens).toContain(RateProvider.CURVE);
        expect(tokens).toContain(RateProvider.COWSWAP);
    });
});
