import { Controller, Post } from "@nestjs/common";
import { SweepService } from "./sweep.service";

/**
 * Invoked by Cloud Scheduler on a fixed interval (design doc §2, starting point: 5
 * minutes). Auth is Cloud Run's native IAM invoker check via the Scheduler job's OIDC
 * service account — no app-level token verification here.
 */
@Controller()
export class SweepController {
    constructor(private readonly sweep: SweepService) {}

    @Post("sweep")
    async sweepNow(): Promise<{ processed: number }> {
        return this.sweep.run();
    }
}
