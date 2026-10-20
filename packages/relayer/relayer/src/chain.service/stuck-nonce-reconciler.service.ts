import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { createPublicClient, http, type Chain, type PublicClient } from "viem";
import { RelayerConfig } from "../config/relayer-config";
import { ChainType } from "../config/enums";
import { EvmChainConfigWrapper } from "../config/evm/evm-chain-config";
import { FATLoggerService } from "../logger/fat.logger.provider";
import type { EvmChainId } from "../config/evm/evm.types";
import {
    checkAndFixStuckNonce,
    recordOutstandingNonce,
    Nonce,
    BroadcastTimeMs,
    stuckNonceReconcileIntervalMs,
    withSignerLock,
} from "./stuck-nonce";

type EvmChainConfig = EvmChainConfigWrapper;

const RECONCILE_RPC_TIMEOUT_MS = Number(process.env.STUCK_NONCE_RECONCILE_RPC_TIMEOUT_MS ?? 10_000);

/// Closes the gap left by checkAndFixStuckNonce's purely reactive detection
/// (stuck-nonce.ts, called from EVMChainService's write paths): that only
/// ever runs when a real write request happens to hit the same chain. On
/// 2026-09-30, mainnet nonces 98-100 sat stuck for 8+ hours because zero
/// mainnet write traffic arrived in that window — nothing ever triggered a
/// check. This service re-runs the same logic on a timer, per chain,
/// independent of request traffic (see
/// Ejemplos/stuck_nonce_reconciliation_plan.org, Part A).
///
/// Default-scope singleton, NOT request-scoped — EVMChainService is bound to
/// one chain only inside a real HTTP request via CHAIN_CONTEXT, which cannot
/// be constructed outside one without NestJS's ContextIdFactory machinery
/// (no production precedent in this codebase). Instead this follows the same
/// pattern as the existing OnApplicationBootstrap validators
/// (RoutingLayoutBootValidator, YieldDiscoveryService): loop
/// relayerConfig.chain(ChainType.EVM).allConfigs() and build plain viem
/// clients directly, bypassing the request-scoped EVMChainService/ConfigService
/// entirely.
///
/// `reconcileAllChains()` is also the method the Cloud Scheduler-triggered
/// endpoint calls (ReconcileController, Part B of the same design doc) — a
/// second trigger into the exact same code path, not a second implementation.
/// Cloud Run throttles CPU to near-zero between requests by default, so this
/// service's own timer isn't guaranteed to tick during a genuinely idle
/// stretch (and the instance can scale to zero entirely) — the scheduled
/// endpoint is the reliable backstop for exactly that case.
@Injectable()
export class StuckNonceReconcilerService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly timers = new Map<EvmChainId, NodeJS.Timeout>();

    constructor(
        private readonly relayerConfig: RelayerConfig,
        private readonly logger: FATLoggerService
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        const evmChains = this.relayerConfig.chain(ChainType.EVM).allConfigs().map((c) => new EvmChainConfigWrapper(c));
        for (const chainConfig of evmChains) {
            await this.seedOutstandingFromChain(chainConfig);
            const timer = setInterval(() => {
                void this.reconcileChain(chainConfig);
            }, stuckNonceReconcileIntervalMs(chainConfig.id));
            this.timers.set(chainConfig.id, timer);
        }
    }

    onModuleDestroy(): void {
        for (const timer of this.timers.values()) clearInterval(timer);
        this.timers.clear();
    }

    async reconcileAllChains(): Promise<void> {
        const evmChains = this.relayerConfig.chain(ChainType.EVM).allConfigs().map((c) => new EvmChainConfigWrapper(c));
        for (const chainConfig of evmChains) {
            await this.reconcileChain(chainConfig);
        }
    }

    private buildChain(chainConfig: EvmChainConfig): Chain {
        return {
            id: Number(chainConfig.id),
            name: chainConfig.name,
            nativeCurrency: chainConfig.nativeCurrency(),
            rpcUrls: { default: { http: [chainConfig.rpcUrl()] } },
        } as Chain;
    }

    private client(chainConfig: EvmChainConfig, chain: Chain): PublicClient {
        return createPublicClient({
            chain,
            transport: http(chainConfig.rpcUrl(), { timeout: RECONCILE_RPC_TIMEOUT_MS }),
        });
    }

    /// On boot, outstandingNonces (stuck-nonce.ts) is empty — discover any
    /// nonce already outstanding (broadcast by a prior process instance, now
    /// gone) and seed it at timestamp Date.now() (elapsed zero), NOT epoch
    /// zero: a restart has no way to know how old an outstanding nonce
    /// actually is, so the safe default is the same full timeout window any
    /// newly-observed nonce gets, not an immediate cancel. Seeds every
    /// nonce in the discovered range, not just the floor, so a multi-nonce
    /// pileup (like 98/99/100 on 2026-09-30) is fully covered.
    private async seedOutstandingFromChain(chainConfig: EvmChainConfig): Promise<void> {
        const chainId = chainConfig.id;
        try {
            const chain = this.buildChain(chainConfig);
            const publicClient = this.client(chainConfig, chain);
            const address = chainConfig.signerAddress();
            const [latestConfirmed, pendingCount] = await Promise.all([
                publicClient.getTransactionCount({ address, blockTag: "latest" }),
                publicClient.getTransactionCount({ address, blockTag: "pending" }),
            ]);
            if (pendingCount <= latestConfirmed) return;

            const now = BroadcastTimeMs(Date.now());
            for (let nonce = latestConfirmed; nonce < pendingCount; nonce++) {
                recordOutstandingNonce(chainId, Nonce(nonce), now);
            }
            this.logger.log(
                `StuckNonceReconcilerService: seeded ${pendingCount - latestConfirmed} outstanding nonce(s) on ` +
                    `chain ${chainId} at boot (range [${latestConfirmed}, ${pendingCount})).`
            );
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `StuckNonceReconcilerService: boot-seed skipped for chain ${chainId} (best effort): ${detail}`
            );
        }
    }

    private async reconcileChain(chainConfig: EvmChainConfig): Promise<void> {
        const chainId = chainConfig.id;
        try {
            const chain = this.buildChain(chainConfig);
            const publicClient = this.client(chainConfig, chain);
            const address = chainConfig.signerAddress();
            // Same per-signer lock the write path holds: a cancel from this
            // tick must never race a live write for the same nonce.
            await withSignerLock(chainId, address, () =>
                checkAndFixStuckNonce({
                    chainId,
                    chain,
                    signerPrivateKey: chainConfig.signerPrivateKey(),
                    publicClient,
                    address,
                    logger: this.logger,
                })
            );
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `StuckNonceReconcilerService: reconcile tick failed for chain ${chainId} (best effort): ${detail}`
            );
        }
    }
}
