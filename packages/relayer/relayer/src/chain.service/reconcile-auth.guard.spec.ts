import { ExecutionContext } from "@nestjs/common";
import { ReconcileAuthGuard } from "./reconcile-auth.guard";

function mockContext(headers: Record<string, string | undefined>): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => ({ headers }),
        }),
    } as unknown as ExecutionContext;
}

describe("ReconcileAuthGuard", () => {
    const ORIGINAL_ENV = process.env.RECONCILE_TRIGGER_SECRET;
    let guard: ReconcileAuthGuard;

    beforeEach(() => {
        guard = new ReconcileAuthGuard();
    });

    afterEach(() => {
        if (ORIGINAL_ENV === undefined) delete process.env.RECONCILE_TRIGGER_SECRET;
        else process.env.RECONCILE_TRIGGER_SECRET = ORIGINAL_ENV;
    });

    it("fails closed when RECONCILE_TRIGGER_SECRET is unconfigured, even with a header present", () => {
        delete process.env.RECONCILE_TRIGGER_SECRET;
        const context = mockContext({ "x-reconcile-token": "anything" });
        expect(guard.canActivate(context)).toBe(false);
    });

    it("rejects a request missing the header", () => {
        process.env.RECONCILE_TRIGGER_SECRET = "correct-secret";
        const context = mockContext({});
        expect(guard.canActivate(context)).toBe(false);
    });

    it("rejects a request with the wrong secret", () => {
        process.env.RECONCILE_TRIGGER_SECRET = "correct-secret";
        const context = mockContext({ "x-reconcile-token": "wrong-secret" });
        expect(guard.canActivate(context)).toBe(false);
    });

    it("rejects a secret that only differs in length from the correct one", () => {
        process.env.RECONCILE_TRIGGER_SECRET = "correct-secret";
        const context = mockContext({ "x-reconcile-token": "correct-secret-but-longer" });
        expect(guard.canActivate(context)).toBe(false);
    });

    it("accepts a request with the correct secret", () => {
        process.env.RECONCILE_TRIGGER_SECRET = "correct-secret";
        const context = mockContext({ "x-reconcile-token": "correct-secret" });
        expect(guard.canActivate(context)).toBe(true);
    });
});
