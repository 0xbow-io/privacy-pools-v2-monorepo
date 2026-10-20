import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { createHash, timingSafeEqual } from "crypto";
import type { Request } from "express";

const RECONCILE_TRIGGER_HEADER = "x-reconcile-token";

/// Guards the Cloud Scheduler-triggered reconciliation endpoint
/// (reconcile.controller.ts). No existing auth/guard infrastructure exists
/// anywhere else in this codebase (only the app-wide ThrottlerGuard, which is
/// rate-limiting, not authentication) — this is deliberately a minimal
/// shared-secret check rather than an OIDC-token/IAM model, so it can be
/// deployed without any GCP IAM policy changes. See
/// Ejemplos/stuck_nonce_reconciliation_plan.org, Part B.3, for the full
/// rationale.
///
/// Fails closed: an unconfigured RECONCILE_TRIGGER_SECRET refuses every
/// request rather than accidentally leaving the endpoint open.
@Injectable()
export class ReconcileAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const expected = process.env.RECONCILE_TRIGGER_SECRET;
        if (!expected) return false;

        const request = context.switchToHttp().getRequest<Request>();
        const provided = request.headers[RECONCILE_TRIGGER_HEADER];
        return typeof provided === "string" && safeEqual(provided, expected);
    }
}

/// Constant-time comparison via fixed-length digests — avoids both a naive
/// `===` (short-circuits on the first mismatched byte, leaking timing
/// information about the secret) and the awkwardness of padding two
/// different-length strings for `crypto.timingSafeEqual`, which requires
/// equal-length buffers.
function safeEqual(a: string, b: string): boolean {
    const hashA = createHash("sha256").update(a).digest();
    const hashB = createHash("sha256").update(b).digest();
    return timingSafeEqual(hashA, hashB);
}
