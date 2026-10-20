import {
    BaseError,
    ContractFunctionRevertedError,
    NonceTooLowError,
    createWalletClient,
    http,
    type Address,
    type Chain,
    type Hash,
    type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { FATLoggerService } from "../logger/fat.logger.provider";
import type { EvmChainId, EvmPrivateKey } from "../config/evm/evm.types";
import { chainKey, type ChainKey } from "../config/chain-key";
import { ChainType } from "../config/enums";

// Extracted from evm.chain.service.ts (originally PR #441, hardened against
// the mempool-eviction watermark bug on 2026-09-30, then generalized here so
// the reactive check and the periodic reconciler share one implementation of
// the safety-critical cancel-ordering guarantee (see fixStuckNonce below)
// instead of two independently-maintained copies. See
// Ejemplos/stuck_nonce_reconciliation_plan.org for the full design trail.

// Branded, not raw `number`, for the same reason `Wei`/`Gas`/`BPS` are
// branded in quote/evm/unit.types.ts and `EvmChainId` is branded in
// evm.types.ts: a nonce and a millisecond timestamp share a runtime
// representation but must never be silently swapped for one another.
export type Nonce = number & { readonly __brand: "Nonce" };
export const Nonce = (value: number) => value as Nonce;
export type BroadcastTimeMs = number & { readonly __brand: "BroadcastTimeMs" };
export const BroadcastTimeMs = (value: number) => value as BroadcastTimeMs;

// Every module-level map/set below is keyed through the shared chainKey()
// helper (src/config/chain-key.ts), not a bare chainId — see that file for
// why (PR #459 / #456).
const evmChainKey = (chainId: EvmChainId): ChainKey => chainKey(ChainType.EVM, chainId);

// chainKey -> nonce -> the time it was broadcast (or, for a nonce discovered
// already-outstanding at boot, the time it was first observed — see the
// reconciler's onApplicationBootstrap). Shared, module-level, mutated by
// both the reactive path (evm.chain.service.ts) and the periodic reconciler
// (stuck-nonce-reconciler.service.ts) — the single source of truth either
// one reads to decide whether a nonce looks stuck.
export type OutstandingNonces = Map<ChainKey, Map<Nonce, BroadcastTimeMs>>;
export const outstandingNonces: OutstandingNonces = new Map();

// Guards against two concurrent callers (a live request and a periodic tick,
// or two live requests) on the same chain both attempting a stuck-nonce fix
// at once — mirrors evm.chain.service.ts's own inFlightNullifiers intent.
export const stuckNonceFixInFlight = new Set<ChainKey>();

// A floor nonce absent from the live pending-block view for this long is
// treated as evicted (fast path); still present but unmined this long is
// treated as stuck anyway, just with more patience since it's visibly
// circulating (slow path). Per-chain overridable (code review, PR #441 — a
// ~12s-block chain and a sub-second-block chain don't warrant the same
// patience), namespaced via chainKey() the same way PR #459 namespaced
// ChainConfigWrapper's per-chain env overrides, for the same reason: an EVM
// chain and some other chain type can share a numeric id.
export function stuckAbsentTimeoutMs(chainId: EvmChainId): number {
    return Number(
        process.env[`STUCK_ABSENT_TIMEOUT_MS_${chainKey(ChainType.EVM, chainId)}`] ??
            process.env.STUCK_ABSENT_TIMEOUT_MS ??
            120_000
    );
}
export function stuckPresentTimeoutMs(chainId: EvmChainId): number {
    return Number(
        process.env[`STUCK_PRESENT_TIMEOUT_MS_${chainKey(ChainType.EVM, chainId)}`] ??
            process.env.STUCK_PRESENT_TIMEOUT_MS ??
            600_000
    );
}
// Fee multiplier applied to a stuck-nonce cancel broadcast, on top of current
// network gas price — a safety margin against any stale copy of the original
// tx still floating on some node that never saw the eviction.
export const CANCEL_GAS_BUMP_MULTIPLIER = Number(process.env.CANCEL_GAS_BUMP_MULTIPLIER ?? 2);

// How often the periodic reconciler re-checks each chain, independent of
// request traffic. No need to be faster than STUCK_ABSENT_TIMEOUT_MS itself.
export function stuckNonceReconcileIntervalMs(chainId: EvmChainId): number {
    return Number(
        process.env[`STUCK_NONCE_RECONCILE_INTERVAL_MS_${chainKey(ChainType.EVM, chainId)}`] ??
            process.env.STUCK_NONCE_RECONCILE_INTERVAL_MS ??
            60_000
    );
}

// Minimum EIP-1559 tip every relayer broadcast pays, in wei. Some RPCs
// (Alchemy mainnet, observed 2026-09-30) answer eth_maxPriorityFeePerGas with
// 0x0; a zero-tip tx gives builders no reason to include it, sits until the
// mempool evicts it, and strands every later nonce behind it. 0 (the default)
// leaves fee selection to viem, exactly as before this knob existed.
export function minPriorityFeeWei(chainId: EvmChainId): bigint {
    return BigInt(
        process.env[`MIN_PRIORITY_FEE_WEI_${chainKey(ChainType.EVM, chainId)}`] ?? process.env.MIN_PRIORITY_FEE_WEI ?? 0
    );
}

// How long an in-process nonce assignment outranks the RPC's `pending` count.
// Covers the window where a load-balanced RPC has not yet reflected our own
// just-sent tx (reusing its nonce would replace it). Past this, the chain is
// trusted again, so a tx that was accepted but later evicted gets its nonce
// refilled by the next write instead of leaving a permanent gap — the failure
// viem's nonceManager cache produced (it trusts its cache forever).
export function nonceLocalTrustMs(chainId: EvmChainId): number {
    return Number(
        process.env[`NONCE_LOCAL_TRUST_MS_${chainKey(ChainType.EVM, chainId)}`] ?? process.env.NONCE_LOCAL_TRUST_MS ?? 30_000
    );
}

// The empty branch is `{ maxFeePerGas?: never; maxPriorityFeePerGas?: never }`, not
// `Record<string, never>`: an index signature of `never` rejects ANY additional
// property (e.g. the `nonce` spread onto this in sendWithAssignedNonce below),
// which made every call site fail to typecheck (TS2345) once `{ nonce, ...fees }`
// needed to satisfy both union branches at once.
export type BroadcastFees =
    | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
    | { maxFeePerGas?: never; maxPriorityFeePerGas?: never };

// Serializes nonce assignment + broadcast (and stuck-nonce cancels) per
// chain+signer within this process, so two writes never read the same
// `pending` count and a cancel never races a live write for the same nonce.
// Only in-process: separate instances sharing a signer key can still collide.
const signerLocks = new Map<string, Promise<void>>();

// chainKey:signer -> the latest nonce this process broadcast (write or cancel).
const lastAssigned = new Map<string, { nonce: number; at: number }>();

function signerKey(chainId: EvmChainId, address: Address): string {
    return `${evmChainKey(chainId)}:${address.toLowerCase()}`;
}

export async function withSignerLock<T>(chainId: EvmChainId, address: Address, fn: () => Promise<T>): Promise<T> {
    const key = signerKey(chainId, address);
    const previous = signerLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    signerLocks.set(key, tail);
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (signerLocks.get(key) === tail) signerLocks.delete(key);
    }
}

/// Never lowers a still-trusted assignment: a cancel at floor 160 must not hide
/// a 161 this process sent seconds earlier.
function noteAssigned(chainId: EvmChainId, address: Address, nonce: number): void {
    const key = signerKey(chainId, address);
    const now = Date.now();
    const last = lastAssigned.get(key);
    if (last && now - last.at < nonceLocalTrustMs(chainId) && last.nonce > nonce) return;
    lastAssigned.set(key, { nonce, at: now });
}

/// The nonce the next broadcast should use: the RPC's `pending` count, unless
/// this process itself assigned that nonce (or a later one) within
/// nonceLocalTrustMs — then the one after it.
export function nextNonce(chainId: EvmChainId, address: Address, pendingCount: number): number {
    const last = lastAssigned.get(signerKey(chainId, address));
    if (last && Date.now() - last.at < nonceLocalTrustMs(chainId) && last.nonce >= pendingCount) {
        return last.nonce + 1;
    }
    return pendingCount;
}

/// True when the node refused a broadcast because the nonce is already taken
/// (confirmed, or occupied by another pending tx) — retrying at a higher
/// nonce is safe. Anything else is a real failure for the caller.
function isNonceConflict(error: unknown): boolean {
    if (error instanceof BaseError && error.walk((e) => e instanceof NonceTooLowError)) return true;
    const text = error instanceof BaseError ? `${error.message} ${error.details ?? ""}` : String(error);
    return /nonce too low|nonce has already been used|replacement transaction underpriced/i.test(text);
}

/// EIP-1559 fees for a relayer broadcast: tip = max(RPC suggestion, floor),
/// maxFee = 2 × latest base fee + tip (survives a few full blocks of base-fee
/// growth). Returns {} — viem picks fees itself, the pre-floor behavior — when
/// no floor is configured, the chain reports no base fee (legacy pricing), or
/// the base-fee read fails (a fee lookup must not fail the relay itself).
export async function resolveBroadcastFees(
    publicClient: PublicClient,
    chainId: EvmChainId,
    logger: FATLoggerService
): Promise<BroadcastFees> {
    const floor = minPriorityFeeWei(chainId);
    if (floor <= 0n) return {};
    let baseFee: bigint | null | undefined;
    try {
        baseFee = (await publicClient.getBlock({ blockTag: "latest" })).baseFeePerGas;
    } catch (error) {
        logger.warn(`Base-fee read failed on chain ${chainId}; tip floor not applied: ${stuckNonceErrorMessage(error)}`);
        return {};
    }
    if (baseFee === null || baseFee === undefined) return {};
    let suggested = 0n;
    try {
        suggested = await publicClient.estimateMaxPriorityFeePerGas();
    } catch {
        // The floor alone still applies.
    }
    const tip = suggested > floor ? suggested : floor;
    return { maxFeePerGas: 2n * baseFee + tip, maxPriorityFeePerGas: tip };
}

/// Assigns a nonce, broadcasts via `send`, and records the nonce as
/// outstanding. Must run inside withSignerLock. `pendingHint` is the
/// `pending` count checkAndFixStuckNonce already read in this same locked
/// section (saves a round-trip); when that read failed, one fresh read is
/// tried, and if that fails too the broadcast goes out with viem choosing the
/// nonce (untracked — best effort, same as before explicit assignment).
/// Retries once, one nonce higher, when the node reports the nonce taken.
export async function sendWithAssignedNonce(params: {
    chainId: EvmChainId;
    address: Address;
    publicClient: PublicClient;
    pendingHint: number | undefined;
    logger: FATLoggerService;
    send: (nonce: number | undefined) => Promise<Hash>;
}): Promise<Hash> {
    const { chainId, address, publicClient, logger, send } = params;
    const readPending = async (): Promise<number | undefined> => {
        try {
            return await publicClient.getTransactionCount({ address, blockTag: "pending" });
        } catch {
            return undefined;
        }
    };
    const pending = params.pendingHint ?? (await readPending());
    if (pending === undefined) {
        logger.warn(`Nonce read failed on chain ${chainId}; broadcasting with an RPC-chosen nonce (untracked).`);
        return send(undefined);
    }

    let nonce = nextNonce(chainId, address, pending);
    let hash: Hash;
    try {
        hash = await send(nonce);
    } catch (error) {
        if (!isNonceConflict(error)) throw error;
        const retryNonce = Math.max(nonce + 1, (await readPending()) ?? 0);
        logger.warn(`Nonce ${nonce} already taken on chain ${chainId}; retrying once at ${retryNonce}.`);
        nonce = retryNonce;
        hash = await send(nonce);
    }
    noteAssigned(chainId, address, nonce);
    // A fresh broadcast at this nonce restarts its clock — including a refill
    // of a previously evicted nonce, which must not inherit the stale time.
    recordOutstandingNonce(chainId, Nonce(nonce), BroadcastTimeMs(Date.now()));
    return hash;
}

function stuckNonceErrorMessage(error: unknown): string {
    if (error instanceof BaseError) {
        const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
        const errorName = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
        return errorName ? `${error.shortMessage} (${errorName})` : error.shortMessage;
    }
    return error instanceof Error ? error.message : "Unknown error";
}

/// Records the nonce a broadcast actually used, at the actual time it was
/// broadcast — the precise signal the old floor-only watermark could only
/// approximate ("first time this floor happened to be observed", which could
/// lag the real broadcast by however long until the next check ran).
export function recordOutstandingNonce(chainId: EvmChainId, nonce: Nonce, time: BroadcastTimeMs): void {
    const key = evmChainKey(chainId);
    let chainMap = outstandingNonces.get(key);
    if (!chainMap) {
        chainMap = new Map();
        outstandingNonces.set(key, chainMap);
    }
    chainMap.set(nonce, time);
}

/// Drops every tracked nonce below `floor` for this chain — they've
/// confirmed (or a previous auto-cancel landed on one of them), so they're
/// no longer outstanding. `floor` itself (the oldest still-unconfirmed
/// nonce) is left untouched here; its own fate is decided by the caller.
function pruneConfirmedNonces(chainId: EvmChainId, floor: number): void {
    const key = evmChainKey(chainId);
    const chainMap = outstandingNonces.get(key);
    if (!chainMap) return;
    for (const nonce of chainMap.keys()) {
        if (nonce < floor) chainMap.delete(nonce);
    }
    if (chainMap.size === 0) outstandingNonces.delete(key);
}

/// Whether `nonce` currently appears among `address`'s transactions in the
/// live pending-block view (`eth_getBlockByNumber(["pending", true])`,
/// verified live against Alchemy mainnet during this design's discussion).
/// Only ever meaningful for the floor nonce — a future-nonce tx is expected
/// to sit in a node's "queued" bucket and legitimately not appear here at
/// all until the floor clears.
async function isNonceInPendingBlock(publicClient: PublicClient, address: Address, nonce: number): Promise<boolean> {
    const pendingBlock = await publicClient.getBlock({ blockTag: "pending", includeTransactions: true });
    return pendingBlock.transactions.some(
        (tx) => tx.from.toLowerCase() === address.toLowerCase() && tx.nonce === nonce
    );
}

/// Broadcasts a 0-value self-transfer at the exact stuck `nonce` — cancellation
/// is nonce-based, not hash-based, so no lookup of the original tx is needed.
/// Runs inside withSignerLock (the caller holds it), so no write can pick the
/// same nonce concurrently in this process. Awaits only the cancel's broadcast
/// ACCEPTANCE (a txHash), never its mining, then records the nonce as this
/// process's latest assignment: the triggering write, which proceeds right
/// after under the same lock, takes the next nonce even if the RPC's `pending`
/// count has not caught up yet. Never silent: turbo()-alerts before attempting
/// and after the outcome either way.
///
/// With a tip floor configured, the cancel's gas price is also lifted to at
/// least 2 × base + floor before the multiplier: a floored original was sent
/// with maxFee = 2 × base + tip, and a replacement must beat both of its fee
/// caps by ≥10%, which plain `CANCEL_GAS_BUMP_MULTIPLIER × eth_gasPrice` can miss.
async function fixStuckNonce(params: {
    chainId: EvmChainId;
    chain: Chain;
    signerPrivateKey: EvmPrivateKey;
    publicClient: PublicClient;
    address: Address;
    nonce: number;
    wasPresentInMempool: boolean;
    logger: FATLoggerService;
}): Promise<void> {
    const { chainId, chain, signerPrivateKey, publicClient, address, nonce, wasPresentInMempool, logger } = params;
    // Scoped by chain + signer, matching this module's own lock granularity — a stuck nonce
    // on one chain/signer must not suppress a distinct page for another chain or signer.
    const dedupKey = `relayer.stuckNonce.${chainId}.${address}`;
    logger.turbo(
        `STUCK NONCE ${nonce} on chain ${chainId} (signer ${address}) — ` +
            `${wasPresentInMempool ? "still present in the mempool but unmined" : "absent from the mempool"} ` +
            `past the timeout. Broadcasting a cancel.`,
        { dedupKey }
    );
    try {
        const account = privateKeyToAccount(signerPrivateKey);
        const rpcUrl = chain.rpcUrls.default.http[0];
        const cancelClient = createWalletClient({
            account,
            chain,
            transport: http(rpcUrl),
        });
        let gasPrice = await publicClient.getGasPrice();
        const floor = minPriorityFeeWei(chainId);
        if (floor > 0n) {
            const baseFee = (await publicClient.getBlock({ blockTag: "latest" })).baseFeePerGas;
            if (baseFee !== null && baseFee !== undefined && 2n * baseFee + floor > gasPrice) {
                gasPrice = 2n * baseFee + floor;
            }
        }
        const cancelHash = await cancelClient.sendTransaction({
            account,
            chain,
            to: address,
            value: 0n,
            nonce,
            gasPrice: gasPrice * BigInt(CANCEL_GAS_BUMP_MULTIPLIER),
        });
        noteAssigned(chainId, address, nonce);
        recordOutstandingNonce(chainId, Nonce(nonce), BroadcastTimeMs(Date.now()));
        logger.turbo(`Cancel for stuck nonce ${nonce} on chain ${chainId} broadcast: ${cancelHash}.`, { dedupKey });
    } catch (error) {
        logger.turbo(
            `Auto-cancel for stuck nonce ${nonce} on chain ${chainId} FAILED: ${stuckNonceErrorMessage(error)}. ` +
                `Manual intervention needed — see the cancel-sweep runbook.`,
            { dedupKey }
        );
    }
}

/// Checks this chain's live floor (confirmed) nonce for divergence before
/// every broadcast — or, from the periodic reconciler, on a timer
/// independent of any broadcast — and heals it if stuck. Best-effort: any
/// failure in here is logged and swallowed, never rethrown — the reactive
/// caller's own write must never fail just because this side-check hit an
/// RPC hiccup (code review, PR #441).
///
/// Must run inside withSignerLock for this chain+signer (every caller holds
/// it), so a cancel it broadcasts can never race a write for the same nonce.
///
/// Returns the RPC's `pending` count, which the reactive caller passes to
/// sendWithAssignedNonce as its nonce hint — a count, not necessarily the
/// nonce that write ends up using (see nextNonce). Returns `undefined` only
/// if the check itself failed (best-effort — no reliable count either).
export async function checkAndFixStuckNonce(params: {
    chainId: EvmChainId;
    chain: Chain;
    signerPrivateKey: EvmPrivateKey;
    publicClient: PublicClient;
    address: Address;
    logger: FATLoggerService;
}): Promise<Nonce | undefined> {
    const { chainId, chain, signerPrivateKey, publicClient, address, logger } = params;
    try {
        const now = Date.now();
        // `pending` counts a transaction still sitting in the mempool as
        // already "sent" — it's the NEXT free nonce, not the stuck one, and
        // only happens to equal the stuck nonce once that tx is fully evicted
        // (code review, PR #441). `latest` (confirmed-only) is the actual
        // oldest-unconfirmed nonce whenever the two diverge, so that — not
        // `pending` — is the nonce to watch and, if needed, cancel. The two
        // reads are one round-trip in practice when `publicClient` batches.
        const [latestConfirmed, pendingCount] = await Promise.all([
            publicClient.getTransactionCount({ address, blockTag: "latest" }),
            publicClient.getTransactionCount({ address, blockTag: "pending" }),
        ]);
        const floor = latestConfirmed;

        pruneConfirmedNonces(chainId, floor);

        const chainMap = outstandingNonces.get(evmChainKey(chainId));
        const trackedSince = chainMap?.get(Nonce(floor));

        if (pendingCount <= floor && trackedSince === undefined) {
            // No gap visible in the mempool, and nothing already being
            // tracked at this floor — genuinely nothing outstanding.
            return Nonce(pendingCount);
        }

        if (trackedSince === undefined) {
            // A gap exists (pendingCount > floor) but nothing recorded this
            // nonce's real broadcast time — e.g. a process restart before the
            // reconciler's boot-seed ran, or this floor was broadcast by code
            // that predates this tracking. Seed it now: same conservative
            // "assume fresh, not already stale" default as boot-seeding uses,
            // for the same reason (we don't actually know how old it is).
            recordOutstandingNonce(chainId, Nonce(floor), BroadcastTimeMs(now));
            return Nonce(pendingCount);
        }

        // Same floor as last observed. Once the stuck tx evicts from the
        // mempool, `pending` collapses back down to equal `latest` even
        // though the gap is still real — any later-queued nonces sit behind
        // it as non-contiguous "queued" and aren't counted — so `pending`
        // can no longer be trusted to mean "resolved" here; only the
        // recorded broadcast time can (bug fix, 2026-09-30: mainnet nonces
        // 98-100 sat stuck 8+ hours because the previous floor-only
        // watermark unconditionally cleared itself the instant `pending`
        // caught back up to `latest`, discarding exactly this signal).
        const elapsed = now - trackedSince;
        if (elapsed < stuckAbsentTimeoutMs(chainId)) return Nonce(pendingCount);

        const presentInMempool = await isNonceInPendingBlock(publicClient, address, floor);
        const stale = presentInMempool ? elapsed >= stuckPresentTimeoutMs(chainId) : true;
        if (!stale) return Nonce(pendingCount);

        const fixKey = evmChainKey(chainId);
        if (stuckNonceFixInFlight.has(fixKey)) return Nonce(pendingCount);
        stuckNonceFixInFlight.add(fixKey);
        try {
            await fixStuckNonce({
                chainId,
                chain,
                signerPrivateKey,
                publicClient,
                address,
                nonce: floor,
                wasPresentInMempool: presentInMempool,
                logger,
            });
        } finally {
            stuckNonceFixInFlight.delete(fixKey);
        }
        return Nonce(pendingCount);
    } catch (error) {
        logger.warn(`Stuck-nonce check skipped on chain ${chainId} (best effort): ${stuckNonceErrorMessage(error)}`);
        return undefined;
    }
}
