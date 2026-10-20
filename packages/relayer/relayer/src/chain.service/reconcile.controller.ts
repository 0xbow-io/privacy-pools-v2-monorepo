import { Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { StuckNonceReconcilerService } from "./stuck-nonce-reconciler.service";
import { ReconcileAuthGuard } from "./reconcile-auth.guard";

/// Stage 2 of the stuck-nonce reconciliation design (see
/// Ejemplos/stuck_nonce_reconciliation_plan.org, Part B): a Cloud
/// Scheduler-triggered backstop for StuckNonceReconcilerService's own
/// in-process timer, which Cloud Run's default CPU throttling between
/// requests doesn't guarantee will tick during a genuinely idle stretch. A
/// real incoming HTTP request always gets CPU allocated regardless of
/// throttling settings, so an externally-triggered hit is the reliable path.
/// Calls the exact same `reconcileAllChains()` the in-process timer calls —
/// a second trigger, not a second implementation.
@Controller("internal")
export class ReconcileController {
    constructor(private readonly reconciler: StuckNonceReconcilerService) {}

    @Post("reconcile-nonces")
    @HttpCode(HttpStatus.NO_CONTENT)
    @UseGuards(ReconcileAuthGuard)
    async reconcileNonces(): Promise<void> {
        await this.reconciler.reconcileAllChains();
    }
}
