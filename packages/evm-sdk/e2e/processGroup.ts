/**
 * Tears down a process group started with `spawn(..., { detached: true })` and confirms it is
 * actually gone.
 *
 * A single `process.kill(-pid, "SIGTERM")` is not enough for the relayer: `pnpm exec nest start`
 * is a chain of wrappers (pnpm → nest CLI → `sh -c node dist/main`), and the nest CLI installs its
 * own SIGTERM handler that only forwards the signal to its child. A group member that outlives the
 * signal is reparented to init and keeps running after the suite exits. So: signal the group, poll
 * until no member is left (`kill(-pid, 0)` succeeds while any member exists), then SIGKILL the
 * group if the grace period runs out.
 */
const GRACE_MS = 5_000;
const KILL_CONFIRM_MS = 2_000;
const POLL_MS = 100;

function groupAlive(pgid: number): boolean {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (error) {
        // ESRCH: no such process group. EPERM would mean it exists but is not ours — treat as alive.
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

export async function stopProcessGroup(pgid: number | undefined, graceMs = GRACE_MS): Promise<void> {
    if (!pgid || !groupAlive(pgid)) return;

    process.kill(-pgid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
        if (!groupAlive(pgid)) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    try {
        process.kill(-pgid, "SIGKILL");
    } catch {
        // Already gone between the last poll and the kill.
    }
    // SIGKILL cannot be ignored, but the members are only reaped a moment later.
    const killDeadline = Date.now() + KILL_CONFIRM_MS;
    while (Date.now() < killDeadline && groupAlive(pgid)) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}
