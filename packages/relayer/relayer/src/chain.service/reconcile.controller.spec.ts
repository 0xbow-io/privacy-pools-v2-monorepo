import { ReconcileController } from "./reconcile.controller";
import { StuckNonceReconcilerService } from "./stuck-nonce-reconciler.service";

// The `@UseGuards(ReconcileAuthGuard)` on the route (visible directly in
// reconcile.controller.ts) is what actually protects this endpoint; the
// guard's own pass/reject behavior is covered exhaustively in
// reconcile-auth.guard.spec.ts. This file only covers the controller's own
// job: delegating to the shared reconciliation logic.
describe("ReconcileController", () => {
    it("delegates to StuckNonceReconcilerService.reconcileAllChains()", async () => {
        const reconcileAllChains = jest.fn().mockResolvedValue(undefined);
        const controller = new ReconcileController({ reconcileAllChains } as unknown as StuckNonceReconcilerService);

        await controller.reconcileNonces();

        expect(reconcileAllChains).toHaveBeenCalledTimes(1);
    });
});
