import type { Hex } from "@privacy-pools-v2/core-sdk";

/** The fault modes / endpoints the mock ASP understands (see {@link FaultSpec}). */
export interface AspFault {
    endpoint?: string;
    mode: string;
    count?: number;
}

export type AspLabelStatus = "pending" | "approved" | "rejected" | "poi_required" | "unknown";

/**
 * Thin `fetch` client over the mock ASP's `/admin` API. Chain-agnostic: it only speaks HTTP to a
 * running {@link MockAspHttpServer}, so any chain's e2e suite can drive the ASP with it — the SDK under
 * test talks to the same server over HTTP too.
 */
export class AspAdminClient {
    constructor(readonly url: string) {}

    /** Approves a deposit's label and (by default) publishes the new root on-chain. */
    approveLabel(label: Hex, options?: { pushRoot?: boolean }): Promise<{ leaf: Hex; root: Hex; published: boolean }> {
        return this.send("POST", "/admin/approve-label", { label, ...options });
    }

    /** Removes the label's leaf, publishes the shrunken root, and marks the label `rejected`. */
    revokeLabel(label: Hex): Promise<{ leaf: Hex; root: Hex }> {
        return this.send("POST", "/admin/revoke-label", { label });
    }

    setLabelStatus(label: Hex, status: AspLabelStatus): Promise<void> {
        return this.send("POST", "/admin/label-status", { label, status });
    }

    setFault(fault: AspFault): Promise<void> {
        return this.send("POST", "/admin/faults", fault);
    }

    /** Call in `afterEach` so a failed test can never poison the next file. */
    clearFaults(): Promise<void> {
        return this.send("DELETE", "/admin/faults");
    }

    state(): Promise<{ leaves: string[]; publishedRoot: string; faults: unknown[]; requestCount: number }> {
        return this.send("GET", "/admin/state");
    }

    private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
        const res = await fetch(`${this.url}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`mock ASP ${method} ${path} -> ${res.status}: ${text}`);
        return (text ? JSON.parse(text) : undefined) as T;
    }
}
