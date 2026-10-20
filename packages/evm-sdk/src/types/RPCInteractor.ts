import type { Chain, PublicClient } from "viem";

import type { ILogger } from "@privacy-pools-v2/core-sdk";

// NOTE (evm-sdk split): core-sdk's types/RPCInteractor.ts kept only the library-agnostic
// ReadContractParams / GetLogsParams / DecodedEventLog / TxReceipt / TxLog shapes and dropped
// the viem-specific config types below (see its own NOTE) — they live here instead, alongside
// ViemRPCInteractor, which is the only consumer.

/** Configuration for ViemRPCInteractor. */
export interface ViemRPCInteractorConfig {
    publicClient: PublicClient;
    /**
     * Block-range size for each `eth_getLogs` chunk inside
     * `getLogsPaginated`. Must be strictly positive. Defaults to
     * `DEFAULT_LOGS_CHUNK_BLOCKS` when omitted. Sized per-instance because
     * RPC providers cap the range differently (Alchemy/Infura free tier:
     * 10k blocks; some private nodes go higher or lower).
     */
    chunkSize?: bigint;
    /**
     * Floor for `eth_getLogs` scans: every log query starts no earlier than this block. Set it to
     * the contracts' deployment block so historical scans (state-tree/note reconstruction) don't
     * sweep the whole chain from 0 — essential on a fork or L2, where blocks before the deployment
     * are either archive-gated (403 on free RPCs) or simply irrelevant. Omitted = scan from 0.
     */
    minFromBlock?: bigint;
}

/** Configuration for creating a ViemRPCInteractor with an internally-managed PublicClient. */
export interface CreateViemRPCInteractorConfig {
    /** The RPC endpoint URL (e.g. "https://eth.llamarpc.com"). */
    rpcUrl: string;
    /** Optional chain definition for chain-aware features. */
    chain?: Chain;
    /** {@link ViemRPCInteractorConfig.minFromBlock} — floor for `eth_getLogs` scans. */
    minFromBlock?: bigint;
}

/** Optional dependencies for ViemRPCInteractor (logger). */
export interface ViemRPCInteractorDependencies {
    /** Logger used for per-chunk debug output in `getLogsPaginated`, rate-limit retries, and bisection events. */
    logger?: ILogger;
}
