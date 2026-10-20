import type { TypedDataDomain } from "viem";
import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type {
    ChainE2EDriver,
    ConformanceSession,
    E2EActor,
    E2EYieldAsset,
    E2EYieldSessions,
    ProtocolKeys,
    RelayedSessionOptions,
    SelectedQuote,
    SessionFactory,
} from "@privacy-pools-v2/e2e-suite";
import type { AssetInfo } from "@privacy-pools-v2/e2e-suite";

import type {
    Address,
    EvmPoolSession,
    Hex,
    IASPDataProvider,
    WithdrawalRelayerQuote,
    WithdrawalRelayParams,
    YieldDeployment,
} from "../../src/internal.js";
import { EvmPayoutRoutingCodec, HTTPClient, HttpASPDataProvider, PoolSessionBuilder } from "../../src/internal.js";
import type { Actor } from "../harness/actors.js";
import type { Session } from "../harness/sessions.js";
import { createActor, createSignedActor, keysAtIndex, mintErc20, walletFor } from "../harness/actors.js";
import { AspAdminClient } from "../harness/asp.js";
import {
    captureFromBlock,
    erc20Balance,
    FEE_CEILING,
    nativeBalance,
    NATIVE_ASSET,
    setBalance,
    settleFinality,
} from "../harness/chain.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext } from "../harness/context.js";
import {
    e2eNativeYieldDeployment,
    e2eYieldDeployment,
    relayedSession,
    relayerClient,
    selfSubmitSession,
    sessionConfig,
} from "../harness/sessions.js";
import { fundAddress } from "../network.js";
import { createNoRelayerInteractor } from "../noRelayerInteractor.js";

/**
 * An EVM session as the shared suites' `string`-addressed {@link ConformanceSession}. The cast is
 * needed because the deposit-for params (`DepositForParams`, `YieldDepositForParams`) are invariant
 * in the address type — `NoteDataBuilder` takes it as a callback parameter — so a session typed
 * with `0x${string}` addresses is not assignable to one typed with `string`, in either direction.
 * At runtime every address the suites pass this driver is a `0x` string.
 */
async function conformance(session: Promise<Session>): Promise<ConformanceSession> {
    return (await session) as unknown as ConformanceSession;
}

const REGISTRY_ABI = [
    {
        name: "latestASPRoot",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
] as const;

const VIEWING_KEYS_ABI = [
    {
        name: "viewingKeys",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "bytes32" }],
    },
] as const;

/**
 * The EVM chain driver for `@privacy-pools-v2/e2e-suite`. A thin adapter over the existing e2e harness
 * (actors / sessions / chain helpers) and the infrastructure `globalSetup` started once (anvil fork +
 * deployed contracts, relayer, mock ASP). Actors are the harness's `Actor` (they carry the viem
 * account); the suite treats them as opaque and this driver casts them back.
 */
export class EvmDriver implements ChainE2EDriver {
    readonly chainName = "evm";
    // 1 unit = 0.001 ETH, so the suite's "20 units" is the original 0.02 ETH note.
    readonly assets: { native: AssetInfo };
    readonly tokenAsset: AssetInfo;
    readonly feeCeiling = FEE_CEILING;
    readonly asp: AspAdminClient;
    readonly sessions: SessionFactory;
    readonly relayContract: string;
    readonly poolAddress: string;
    readonly relayerUrl: string;
    readonly tokenYield: E2EYieldAsset;
    readonly nativeYield: E2EYieldAsset;
    readonly emptyAddress = "0x0000000000000000000000000000000000000000";
    readonly drainedNativeBalance = 0n;
    readonly revertReasons = {
        // The proof binds the note's owner address; the vault requires msg.sender to be it.
        ragequitNotOwner: /PoolVault_InvalidOwnerAddress|0x7db3fe30/,
    };
    readonly tamper = {
        // Aim the prepared transaction at the MockRouter — a contract the SDK has no business calling.
        retarget: (preparedTx: unknown) => ({
            ...(preparedTx as Record<string, unknown>),
            to: this.ctx.network.mockRouterAddress,
        }),
    };

    constructor(private readonly ctx: E2EContext) {
        this.asp = new AspAdminClient(ctx.aspUrl);
        this.relayContract = ctx.network.privacyPoolRelayAddress;
        this.poolAddress = ctx.network.poolAddress;
        this.relayerUrl = ctx.relayer.url;
        this.assets = {
            native: { id: NATIVE_ASSET, symbol: "ETH", unit: 1_000_000_000_000_000n, minDeposit: 1n, dust: 1_000n },
        };
        this.tokenAsset = {
            id: ctx.network.mockErc20Address,
            symbol: "mUSD",
            unit: 100_000_000_000_000_000n,
            minDeposit: 1n,
            dust: 1_000n,
        };
        const tokenDeployment = e2eYieldDeployment(ctx);
        const nativeDeployment = e2eNativeYieldDeployment(ctx);
        const share = (deployment: YieldDeployment, symbol: string): AssetInfo => ({
            id: deployment.ppUSDC,
            symbol,
            unit: 1_000_000_000_000_000_000n,
            minDeposit: 1n,
            dust: 1_000n,
        });
        // 1 unit = 1 yUSDC (6dp); the share is 18dp.
        this.tokenYield = this.yieldAsset(tokenDeployment, share(tokenDeployment, "ppyUSDC"), {
            id: tokenDeployment.underlying,
            symbol: "yUSDC",
            unit: 1_000_000n,
            minDeposit: 1n,
            dust: 1n,
        });
        // The user spends and receives bare ETH: the router wraps `msg.value` into WETH on the way in and
        // unwraps on the way out, so the underlying the suite measures is the native coin, not WETH.
        // 1 unit = 0.01 ETH, ten times the plain native unit: the gas a deposit pays comes out of the
        // same balance and the relayer's fee covers gas, and against a 0.005 ETH budget both are too
        // large a fraction (measured: ~0.001 ETH of gas per deposit, and a relayed fee that pushed the
        // gross past the note's value).
        const nativeUnderlying: AssetInfo = { ...this.assets.native, unit: 10_000_000_000_000_000n };
        this.nativeYield = this.yieldAsset(nativeDeployment, share(nativeDeployment, "ppWETH"), nativeUnderlying, {
            // Any contract without a payable receive/fallback cannot take the ETH payout; the yUSDC
            // MockERC20 has neither.
            unreceivableRecipient: async () => ctx.network.yieldUnderlyingAddress,
        });
        this.sessions = {
            // Every self-submit session carries both of the fork's yield deployments (the `yield` suite
            // picks one through each asset's `yieldOf`); they only add namespaces, so the other suites
            // are unaffected.
            selfSubmit: (actor) =>
                conformance(
                    selfSubmitSession(ctx, actor as Actor, { yieldDeployments: [tokenDeployment, nativeDeployment] }),
                ),
            selfSubmitWithUnreachableRpc: (actor) =>
                conformance(
                    PoolSessionBuilder.fromConfig({ ...sessionConfig(ctx, actor as Actor), rpcUrl: "http://127.0.0.1:1" })
                        .withRelayerInteractor(createNoRelayerInteractor())
                        .create(),
                ),
        };
    }

    /** Builds the driver from the handle `globalSetup` provided; call from `beforeAll`. */
    static fromInjected(): EvmDriver {
        return new EvmDriver(e2eContext());
    }

    relayedSession(actor: E2EActor, options?: RelayedSessionOptions): Promise<ConformanceSession> {
        return conformance(relayedSession(this.ctx, actor as Actor, options));
    }

    createActor(name: string, options: { funded?: boolean; signed?: boolean } = {}): Promise<Actor> {
        return options.signed
            ? createSignedActor(name, { funded: options.funded })
            : createActor(name, { funded: options.funded });
    }

    aspProvider(options: { scope?: "own" | "other" } = {}): IASPDataProvider {
        return new HttpASPDataProvider({
            aspUrl: this.ctx.aspUrl,
            chainId: this.ctx.network.chainId,
            entrypointAddress: (options.scope === "other"
                ? "0x" + "9".repeat(40)
                : this.ctx.network.entrypointAddress) as Address,
            httpClient: new HTTPClient({ retryAttempts: 0, timeout: 3000 }),
        });
    }

    unlistedAssetId(): string {
        return privateKeyToAccount(generatePrivateKey()).address;
    }

    async fund(address: string): Promise<void> {
        await fundAddress(this.ctx.network.rpcUrl, address as Address);
    }

    drainNative(address: string): Promise<void> {
        return setBalance(this.ctx, address as Address, 0n);
    }

    mint(actor: { address: string }, asset: AssetInfo, amount: bigint, to?: string): Promise<void> {
        return mintErc20(this.ctx, actor as Actor, asset.id as Address, amount, to as Address | undefined);
    }

    keysAtIndex(actor: E2EActor, revocableKeyIndex: Hex): ProtocolKeys {
        const signed = actor as Actor;
        if (!signed.signature) throw new Error(`actor ${actor.name} is not signature-derived (create it with { signed: true })`);
        return keysAtIndex(signed.signature, signed.address, revocableKeyIndex);
    }

    async verifyRelayedRegistration(prepared: unknown, actor: E2EActor): Promise<boolean> {
        const relayed = prepared as {
            typedData: {
                domain: TypedDataDomain;
                types: Record<string, { name: string; type: string }[]>;
                primaryType: string;
                message: Record<string, unknown>;
            };
            signature: Hex;
        };
        return verifyTypedData({
            address: actor.address as Address,
            domain: relayed.typedData.domain,
            types: relayed.typedData.types,
            primaryType: relayed.typedData.primaryType,
            message: relayed.typedData.message,
            signature: relayed.signature,
        });
    }

    async submitPreparedTx(actor: { address: string }, preparedTx: unknown): Promise<void> {
        const tx = preparedTx as { to: Address; data: Hex; value: string };
        const request = { account: actor.address as Address, to: tx.to, data: tx.data, value: BigInt(tx.value) };
        // A 20% margin over the estimate, as wallets add: the estimate runs in the latest block's
        // context, and gas can depend on it — the mock Aave pool's `_accrue` rewrites `lastUpdate`
        // only when the timestamp has moved, so a deposit estimated in the block that last touched
        // the pool comes out ~3k short, and the nested call that runs out reverts the whole deposit.
        const gas = ((await this.ctx.publicClient.estimateGas(request)) * 6n) / 5n;
        const hash = await walletFor(this.ctx, actor as Actor).sendTransaction({
            to: tx.to,
            data: tx.data,
            value: BigInt(tx.value),
            gas,
            chain: null,
        });
        // The driver contract resolves once included and rejects on a revert, so a caller can read
        // the resulting state straight after.
        const receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
            // Replayed on the parent block, with the block's gas, for a revert reason: a replay that
            // succeeds points at the gas limit or at the block's own context (timestamp, number).
            const reason = await this.ctx.publicClient
                .call({ ...request, blockNumber: receipt.blockNumber - 1n })
                .then(
                    () => "the replay succeeded",
                    (error: unknown) => (error instanceof Error ? error.message.split("\n")[0] : String(error)),
                );
            throw new Error(
                `transaction ${hash} reverted in block ${receipt.blockNumber} (gas used ${receipt.gasUsed} of ${gas}): ${reason}`,
            );
        }
    }

    balanceOf(address: string, asset: AssetInfo): Promise<bigint> {
        return asset.id === NATIVE_ASSET
            ? nativeBalance(this.ctx, address as Address)
            : erc20Balance(this.ctx, asset.id as Address, address as Address);
    }

    async withdrawalQuote(
        params: { asset: AssetInfo; recipient: string; amount: bigint },
        options: RelayedSessionOptions = {},
    ): Promise<SelectedQuote> {
        const { interactor, info } = relayerClient(this.ctx, { url: options.relayerUrl, httpClient: options.httpClient });
        const quote = await interactor.getWithdrawalQuote(info, {
            asset: params.asset.id as Address,
            commit: true,
            recipient: params.recipient as Address,
            extraGas: false,
            amount: params.amount.toString(),
        });
        return { relayerInfo: info, quote };
    }

    sessionWithoutYield(actor: E2EActor): Promise<ConformanceSession> {
        return conformance(selfSubmitSession(this.ctx, actor as Actor));
    }

    rerouteFeeCommitment(data: Hex, recipient: string): Hex {
        const codec = new EvmPayoutRoutingCodec();
        return codec.encode({ ...codec.decode(data), recipient: recipient as Address });
    }

    async sendUnrelatedTransaction(actor: E2EActor): Promise<Hex> {
        const self = actor as Actor;
        const hash = await walletFor(this.ctx, self).sendTransaction({ to: self.address, value: 1n, chain: null });
        await this.ctx.publicClient.waitForTransactionReceipt({ hash });
        return hash;
    }

    currentBlock(): Promise<Hex> {
        return captureFromBlock(this.ctx);
    }

    settleFinality(): Promise<void> {
        return settleFinality(this.ctx);
    }

    async publishedAspRoot(): Promise<bigint> {
        return (await this.ctx.publicClient.readContract({
            address: this.ctx.network.aspRegistryAddress,
            abi: REGISTRY_ABI,
            functionName: "latestASPRoot",
        })) as bigint;
    }

    async registeredViewingKey(address: string): Promise<Hex> {
        return (await this.ctx.publicClient.readContract({
            address: this.ctx.network.keystoreAddress,
            abi: VIEWING_KEYS_ABI,
            functionName: "viewingKeys",
            args: [address as Address],
        })) as Hex;
    }

    /** One yield deployment as the shared suite drives it. */
    private yieldAsset(
        deployment: YieldDeployment,
        share: AssetInfo,
        underlying: AssetInfo,
        extra: Pick<E2EYieldAsset, "unreceivableRecipient"> = {},
    ): E2EYieldAsset {
        const ctx = this.ctx;
        // The router, not the plain relay contract, processes a share's withdrawal.
        const routerRelayer = () => {
            const { interactor, info } = relayerClient(ctx);
            return { interactor, info: { ...info, processorAddress: deployment.ppRouter } };
        };
        return {
            share,
            underlying,
            ...extra,
            yieldOf(session: ConformanceSession): E2EYieldSessions {
                const y = (session as unknown as EvmPoolSession).yieldFor(deployment.ppUSDC);
                if (!y) throw new Error(`session was built without the ${share.symbol} yield deployment`);
                // Same address-type invariance as `conformance` above (`YieldDepositForParams`).
                return y as unknown as E2EYieldSessions;
            },
            async fundUnderlying(actor: E2EActor, amount: bigint): Promise<void> {
                if (deployment.nativeMode) {
                    // Actors are created holding ETH; top up only if a run has drained one.
                    if ((await nativeBalance(ctx, actor.address as Address)) < amount) {
                        await fundAddress(ctx.network.rpcUrl, actor.address as Address);
                    }
                    return;
                }
                await mintErc20(ctx, actor as Actor, deployment.underlying, amount);
            },
            async withdrawalQuote(params: { recipient: string; amount: bigint }): Promise<WithdrawalRelayerQuote<string>> {
                const { interactor, info } = routerRelayer();
                return interactor.getWithdrawalQuote(info, {
                    asset: deployment.ppUSDC,
                    commit: true,
                    recipient: params.recipient as Address,
                    extraGas: false,
                    amount: params.amount.toString(),
                });
            },
            async relayWithdrawal(params: WithdrawalRelayParams<string>): Promise<void> {
                const { interactor, info } = routerRelayer();
                const hash = await interactor.relayWithdrawal(info, params as WithdrawalRelayParams);
                const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
                if (receipt.status !== "success") throw new Error(`relayed ${share.symbol} withdrawal ${hash} reverted`);
            },
        };
    }
}
