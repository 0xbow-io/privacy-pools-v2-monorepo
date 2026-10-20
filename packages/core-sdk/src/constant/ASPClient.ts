/**
 * TTL for the cached on-chain `latestASPRoot` lookup inside ASPClient.
 *
 * The root is the cheap-but-non-free on-chain anchor used to cross-check
 * every leaves fetch — re-reading it on every call would multiply the RPC
 * pressure under burst. 30s is short enough that a stale root cannot
 * shadow new ASP updates for long, and long enough to absorb back-to-back
 * verification calls without an extra `eth_call` each.
 */
export const ASP_ROOT_CACHE_TTL_MS = 30_000;
