import type { Hex, ILogger } from "../internal.js";

/**
 * Invokes an optional caller `onBroadcast` hook with the relayed tx hash. Runs once, after the
 * relayer accepts the tx and before the receipt wait. A throwing hook (or a rejected promise from
 * an async one, which is never awaited) is logged and swallowed: it must never fail the relay,
 * whose tx is already on its way.
 */
export function notifyBroadcast(
  onBroadcast: ((txHash: Hex) => void) | undefined,
  txHash: Hex,
  logger?: ILogger,
): void {
  if (!onBroadcast) return;
  try {
    const result: unknown = onBroadcast(txHash);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      (result as PromiseLike<unknown>).then(undefined, (error: unknown) => warn(error, logger));
    }
  } catch (error) {
    warn(error, logger);
  }
}

function warn(error: unknown, logger?: ILogger): void {
  try {
    logger?.warn("onBroadcast callback threw; ignoring", {
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // A failing logger must not fail the relay either.
  }
}
