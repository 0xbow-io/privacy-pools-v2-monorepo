import { Injectable, BadRequestException, HttpException, ServiceUnavailableException, Scope, Inject } from "@nestjs/common";
import {
    BaseError,
    ContractFunctionRevertedError,
    InsufficientFundsError,
    createPublicClient,
    createWalletClient,
    formatEther,
    http,
    verifyTypedData,
    WalletClient,
    PublicClient,
} from "viem";
import type { Chain } from "viem";
import type {
    Abi,
    Account,
    Address,
    Hash,
    Hex,
    Transport,
    ContractFunctionName,
    ContractFunctionArgs,
    ReadContractParameters,
    ReadContractReturnType,
    SimulateContractParameters,
    SimulateContractReturnType,
    TransactionReceipt,
    WriteContractParameters,
    WriteContractReturnType,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAX_BATCH } from "@privacy-pools-v2/core-sdk/batch-fee";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { clientSafeErrorMessage } from "../errors/redact";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { EvmChainId } from "../config/evm/evm.types";
import { chainKey, type ChainKey } from "../config/chain-key";
import { ChainType } from "../config/enums";
import {
    ISignedBatchWithdrawalFeeCommitment,
    ISignedTransferFeeCommitment,
    ISignedWithdrawalFeeCommitment,
    ISignedSwapFeeCommitment,
    ITransferFeeCommitment,
    IWithdrawalFeeCommitment,
    ISwapFeeCommitment,
} from "../relayer.types";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import type { ChainContext } from "../core/chain-context.token";
import { Gas, Wei } from "../quote/evm/unit.types";
import {
    RELAY_GAS_BUDGET,
    relayBatchGasBudget,
    relaySwapGasBudget,
    relayGasCap,
    relayGasLimit,
} from "../quote/evm/relay_gas_budget";
import { PP_RELAY_ABI } from "../sdk/relayer_abi";
import type {
    EvmRelayBatchSDKPayload,
    EvmRelayRegisterSDKPayload,
    EvmRelayAndAnnounceSDKPayload,
} from "../relay/evm/types";
import { PP_ROUTER_WITHDRAW_ABI } from "../sdk/pprouter.abi";
import { POOL_VAULT_ABI } from "../sdk/pool_vault.abi";
import { RELAY_SWAPS_ABI } from "../sdk/withdraw_and_swap.abi";
import { ALL_CONTRACT_ERRORS } from "./contract_errors";
import type { EvmRelaySDKPayload, EvmRelaySwapPayload } from "../relay/evm/types";
import {
    checkAndFixStuckNonce,
    resolveBroadcastFees,
    sendWithAssignedNonce,
    withSignerLock,
    type BroadcastFees,
} from "./stuck-nonce";

export { CANCEL_GAS_BUMP_MULTIPLIER } from "./stuck-nonce";

// `verifyingContract` binds every relayer commitment to a specific relay
// deployment (audit I-1). Sign and verify both call this with the same relay
// address, and the SDK never verifies these signatures, so adding it is safe and
// prevents two relay deployments sharing a signer key on one chain from
// producing interchangeable commitments.
const domain = (chainId: EvmChainId, verifyingContract: `0x${string}`) =>
    ({
        name: "Privacy Pools Relayer",
        version: "1",
        chainId,
        verifyingContract,
    }) as const;

const RelayerCommitmentTypes = {
    RelayWithdrawalCommitment: [
        { name: "data", type: "bytes" },
        { name: "asset", type: "address" },
        { name: "expiration", type: "uint256" },
        { name: "amountSent", type: "uint256" },
        { name: "amountReceived", type: "uint256" },
    ],
    RelayTransferCommitment: [
        { name: "data", type: "bytes" },
        { name: "asset", type: "address" },
        { name: "expiration", type: "uint256" },
        { name: "amountReceived", type: "uint256" },
    ],
    RelayBatchWithdrawalCommitment: [
        { name: "data", type: "bytes" },
        { name: "asset", type: "address" },
        { name: "expiration", type: "uint256" },
        { name: "totalAmountSent", type: "uint256" },
        { name: "totalAmountReceived", type: "uint256" },
        { name: "relayCost", type: "uint256" },
        { name: "feeBps", type: "uint256" },
        { name: "flatFee", type: "uint256" },
    ],
} as const;

const SwapCommitmentTypes = {
    RelaySwapCommitment: [
        { name: "data", type: "bytes" },
        { name: "asset", type: "address" },
        { name: "expiration", type: "uint256" },
        { name: "amountSent", type: "uint256" },
    ],
} as const;
export type ConnectedWalletClient = WalletClient<Transport, Chain, Account>;

// Caches POOL.rootHistorySize() per pool address so the batch fail-fast check
// (audit L-2) reads chain state at most once per process. Module-level because
// EVMChainService is request-scoped and cannot hold cross-request state.
const rootHistorySizeCache = new Map<string, number>();

// Caches the relay contract's on-chain MAX_BATCH() per relay address for the
// SDK/contract drift cross-check (review QUALITY-1); same request-scoped rationale.
const relayMaxBatchCache = new Map<string, number>();

// Caches gas price per chainId for 15 s — gas moves on the order of seconds-to-minutes,
// so a short TTL eliminates per-request RPC calls without meaningfully degrading fee accuracy.
// Keyed by chainKey(), not a bare chainId — EvmChainId's brand is compile-time only, so an
// EVM chain and a Stellar (or future Starknet) chain sharing a numeric id would otherwise
// silently read/write each other's cached gas price.
const GAS_PRICE_TTL_MS = 15_000;
const gasPriceCache = new Map<ChainKey, { value: Wei; expiresAt: number }>();

// Tracks individual nullifier hashes currently being broadcast, keyed as
// "${chainKey}:${nullifierHash}" — chainKey(), not a bare chainId, for the same
// cross-chain-type collision reason as gasPriceCache above. Prevents duplicate or
// overlapping-nullifier requests from redundant simulations and on-chain reverts.
const inFlightNullifiers = new Set<string>();

// Bounds worst-case RPC latency instead of inheriting viem's silent defaults
// (10s timeout x 4 attempts ~= 40s per call — the source of 30-60s quote hangs
// whenever the provider degrades). 2.5s x 2 attempts caps a logical read at
// ~5s, inside the quote deadline (QUOTE_DEADLINE_MS, quote-deadline.interceptor.ts).
export const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 2_500);
export const RPC_RETRY_COUNT = Number(process.env.RPC_RETRY_COUNT ?? 1);
// Writes keep a longer ceiling: aborting a broadcast on a short timeout risks
// "timed out but landed" ambiguity, and write volume is too low to hang quotes.
export const RPC_WRITE_TIMEOUT_MS = Number(process.env.RPC_WRITE_TIMEOUT_MS ?? 10_000);

// Public clients cached per chainKey() + resolved RPC URL (the URL is
// env-overridable per chain, so it belongs in the key; chainKey() rather than a bare
// chainId for the same cross-chain-type collision reason as gasPriceCache above).
// Reuse keeps upstream HTTP connections warm and lets `batch: true` coalesce concurrent
// calls into one JSON-RPC batch request. Wallet clients are deliberately NOT cached:
// signer() builds a fresh account each time, and nonces are assigned by
// broadcast() (stuck-nonce.ts), never by viem's nonceManager cache.
const publicClientCache = new Map<string, PublicClient>();

// Signer balance below which a broadcast pages operators, in wei; unset = no check. Per chain
// only (no global fallback): one native amount means very different things on mainnet and BSC.
// The funder job (packages/relayer/funder) refills the signer on its own schedule; this alert is
// the operator-visible side, e.g. for a fee wallet with nothing left to sweep.
export function lowBalanceAlertWei(chainId: EvmChainId): bigint | undefined {
    const raw = process.env[`LOW_BALANCE_ALERT_WEI_${chainKey(ChainType.EVM, chainId)}`];
    return raw ? BigInt(raw) : undefined;
}

// Stuck-nonce detection/auto-fix state and logic now lives in stuck-nonce.ts
// (shared with the periodic reconciler — see StuckNonceReconcilerService).

@Injectable({ scope: Scope.REQUEST })
export class EVMChainService {
    private readonly chainId: EvmChainId;
    private readonly chain: Chain;

    constructor(
        @Inject(CHAIN_CONTEXT) context: ChainContext,
        private readonly logger: FATLoggerService,
        private readonly config: EvmConfigService
    ) {
        this.chainId = context.chainId as EvmChainId;
        this.chain = {
            id: Number(this.chainId),
            name: this.config.chainConfig().name,
            nativeCurrency: this.config.nativeCurrency(),
            rpcUrls: {
                default: { http: [this.config.rpcUrl()] },
            },
        } as Chain;
    }

    private async client(): Promise<PublicClient> {
        const rpcUrl = this.config.rpcUrl();
        const cacheKey = `${chainKey(ChainType.EVM, this.chainId)}:${rpcUrl}`;
        const cached = publicClientCache.get(cacheKey);
        if (cached) return cached;
        const client = createPublicClient({
            chain: this.chain,
            transport: http(rpcUrl, {
                timeout: RPC_TIMEOUT_MS,
                retryCount: RPC_RETRY_COUNT,
                batch: true,
            }),
        });
        publicClientCache.set(cacheKey, client);
        return client;
    }

    private async signer(): Promise<ConnectedWalletClient> {
        const rpcUrl = this.config.rpcUrl();
        const pkey = this.config.signerPrivateKey();

        // No viem nonceManager: its cache trusts itself over the RPC forever, so
        // one evicted broadcast left every later nonce queued behind a gap
        // (mainnet 98-100, 2026-09-30). broadcast() assigns nonces explicitly.
        const account = privateKeyToAccount(pkey);
        return createWalletClient({
            account,
            chain: this.chain,
            transport: http(rpcUrl, { timeout: RPC_WRITE_TIMEOUT_MS }),
        });
    }

    async getGasPrice(): Promise<Wei> {
        const now = Date.now();
        const key = chainKey(ChainType.EVM, this.chainId);
        const cached = gasPriceCache.get(key);
        if (cached && now < cached.expiresAt) return cached.value;
        const client = await this.client();
        const value = Wei(await client.getGasPrice());
        gasPriceCache.set(key, { value, expiresAt: now + GAS_PRICE_TTL_MS });
        return value;
    }

    async signRelayWithdrawalCommitment(commitment: IWithdrawalFeeCommitment) {
        const pkey = this.config.signerPrivateKey();
        const signer = privateKeyToAccount(pkey);
        const { data, expiration, asset } = commitment;

        return signer.signTypedData({
            domain: domain(this.chainId, this.config.relayContractAddress()),
            types: RelayerCommitmentTypes,
            primaryType: "RelayWithdrawalCommitment",
            message: {
                data,
                asset,
                expiration: BigInt(expiration),
                amountSent: commitment.amountSent,
                amountReceived: commitment.amountReceived,
            },
        });
    }

    async verifyRelayWithdrawalCommitment(commitment: ISignedWithdrawalFeeCommitment): Promise<boolean> {
        const pkey = this.config.signerPrivateKey();
        const signer = privateKeyToAccount(pkey);
        const { data, asset, expiration, signedRelayerCommitment } = commitment;

        if (Date.now() > expiration) {
            throw new BadRequestException("Fee commitment has expired");
        }

        this.logger.log("verifying address signature.");
        this.logger.log(`Signer is ${signer.address}`);

        try {
            return await verifyTypedData({
                address: signer.address,
                domain: domain(this.chainId, this.config.relayContractAddress()),
                types: RelayerCommitmentTypes,
                primaryType: "RelayWithdrawalCommitment",
                message: {
                    data,
                    asset,
                    expiration: BigInt(expiration),
                    amountSent: commitment.amountSent,
                    amountReceived: commitment.amountReceived,
                },
                signature: signedRelayerCommitment,
            });
        } catch (e: unknown) {
            this.logger.error(this.safeErrorMessage(e));
            return false;
        }
    }

    async signRelayBatchWithdrawalCommitment(commitment: {
        data: `0x${string}`;
        asset: `0x${string}`;
        expiration: number;
        totalAmountSent: bigint;
        totalAmountReceived: bigint;
        relayCost: bigint;
        feeBps: bigint;
        flatFee: bigint;
    }) {
        const pkey = this.config.signerPrivateKey();
        const signer = privateKeyToAccount(pkey);
        const { data, expiration, asset, totalAmountSent, totalAmountReceived, relayCost, feeBps, flatFee } =
            commitment;

        return signer.signTypedData({
            domain: domain(this.chainId, this.config.relayContractAddress()),
            types: RelayerCommitmentTypes,
            primaryType: "RelayBatchWithdrawalCommitment",
            message: {
                data,
                asset,
                expiration: BigInt(expiration),
                totalAmountSent,
                totalAmountReceived,
                relayCost,
                feeBps,
                flatFee,
            },
        });
    }

    /// Verifies the batch fee commitment signature. `totalAmountSent`/
    /// `totalAmountReceived` are NOT carried on the wire — the caller recomputes
    /// them from the batch proofs (ΣamountOut and ΣamountOut − totalFee) so the
    /// signature binds the relayer to the exact aggregate it quoted.
    async verifyRelayBatchWithdrawalCommitment(
        commitment: ISignedBatchWithdrawalFeeCommitment,
        totalAmountSent: bigint,
        totalAmountReceived: bigint
    ): Promise<boolean> {
        const pkey = this.config.signerPrivateKey();
        const signer = privateKeyToAccount(pkey);
        const { data, asset, expiration, signedRelayerCommitment, relayCost, feeBps, flatFee } = commitment;

        if (Date.now() > expiration) {
            throw new BadRequestException("Batch fee commitment has expired");
        }

        try {
            return await verifyTypedData({
                address: signer.address,
                domain: domain(this.chainId, this.config.relayContractAddress()),
                types: RelayerCommitmentTypes,
                primaryType: "RelayBatchWithdrawalCommitment",
                message: {
                    data,
                    asset,
                    expiration: BigInt(expiration),
                    totalAmountSent,
                    totalAmountReceived,
                    relayCost: BigInt(relayCost),
                    feeBps: BigInt(feeBps),
                    flatFee: BigInt(flatFee),
                },
                signature: signedRelayerCommitment,
            });
        } catch (e: unknown) {
            this.logger.error(this.safeErrorMessage(e));
            return false;
        }
    }

    async signRelayTransferCommitment(commitment: ITransferFeeCommitment) {
        const pkey = this.config.signerPrivateKey();
        const signer = privateKeyToAccount(pkey);
        const { data, expiration, asset, feeAmount } = commitment;
        return signer.signTypedData({
            domain: domain(this.chainId, this.config.relayContractAddress()),
            types: RelayerCommitmentTypes,
            primaryType: "RelayTransferCommitment",
            message: {
                data,
                asset,
                expiration: BigInt(expiration),
                amountReceived: feeAmount,
            },
        });
    }

    async verifyRelayTransferCommitment(commitment: ISignedTransferFeeCommitment): Promise<boolean> {
        const pkey = this.config.signerPrivateKey();
        const signer = privateKeyToAccount(pkey);
        const { data, asset, expiration, feeAmount, signedRelayerCommitment } = commitment;

        if (Date.now() > expiration) {
            throw new BadRequestException("Fee commitment has expired");
        }

        try {
            return await verifyTypedData({
                address: signer.address,
                domain: domain(this.chainId, this.config.relayContractAddress()),
                types: RelayerCommitmentTypes,
                primaryType: "RelayTransferCommitment",
                message: {
                    data,
                    asset,
                    expiration: BigInt(expiration),
                    amountReceived: feeAmount,
                },
                signature: signedRelayerCommitment,
            });
        } catch (e: unknown) {
            this.logger.error(this.safeErrorMessage(e));
            return false;
        }
    }

    async signRelaySwapCommitment(commitment: ISwapFeeCommitment) {
        const pkey = this.config.signerPrivateKey();
        const signer = privateKeyToAccount(pkey);
        const { data, expiration, asset, amountSent } = commitment;

        return signer.signTypedData({
            domain: domain(this.chainId, this.config.relayContractAddress()),
            types: SwapCommitmentTypes,
            primaryType: "RelaySwapCommitment",
            message: {
                data,
                asset,
                expiration: BigInt(expiration),
                amountSent,
            },
        });
    }

    async verifyRelaySwapCommitment(commitment: ISignedSwapFeeCommitment): Promise<boolean> {
        const pkey = this.config.signerPrivateKey();
        const signer = privateKeyToAccount(pkey);
        const { data, asset, expiration, amountSent, signedRelayerCommitment } = commitment;

        if (Date.now() > expiration) {
            throw new BadRequestException("Swap fee commitment has expired");
        }

        this.logger.log("Verifying swap commitment signature.");

        try {
            return await verifyTypedData({
                address: signer.address,
                domain: domain(this.chainId, this.config.relayContractAddress()),
                types: SwapCommitmentTypes,
                primaryType: "RelaySwapCommitment",
                message: {
                    data,
                    asset,
                    expiration: BigInt(expiration),
                    amountSent,
                },
                signature: signedRelayerCommitment,
            });
        } catch (e: unknown) {
            this.logger.error(this.safeErrorMessage(e));
            return false;
        }
    }

    async readContract<
        const TAbi extends Abi | readonly unknown[],
        TFunctionName extends ContractFunctionName<TAbi, "view" | "pure">,
        TArgs extends ContractFunctionArgs<TAbi, "view" | "pure", TFunctionName>,
    >(
        params: ReadContractParameters<TAbi, TFunctionName, TArgs>
    ): Promise<ReadContractReturnType<TAbi, TFunctionName, TArgs>> {
        const publicClient = await this.client();
        return publicClient.readContract(params);
    }

    async simulateContract<
        const TAbi extends Abi | readonly unknown[],
        TFunctionName extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
        TArgs extends ContractFunctionArgs<TAbi, "nonpayable" | "payable", TFunctionName>,
    >(
        params: SimulateContractParameters<TAbi, TFunctionName, TArgs>
    ): Promise<SimulateContractReturnType<TAbi, TFunctionName, TArgs>> {
        const publicClient = await this.client();
        return publicClient.simulateContract(params);
    }

    async writeContract<
        const TAbi extends Abi | readonly unknown[],
        TFunctionName extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
        TArgs extends ContractFunctionArgs<TAbi, "nonpayable" | "payable", TFunctionName>,
    >(params: WriteContractParameters<TAbi, TFunctionName, TArgs>): Promise<WriteContractReturnType> {
        const [walletClient, publicClient] = await Promise.all([this.signer(), this.client()]);
        return this.broadcast(publicClient, walletClient, "writeContract", (tx) =>
            walletClient.writeContract({ ...params, ...tx } as unknown as Parameters<
                ConnectedWalletClient["writeContract"]
            >[0])
        );
    }

    /// Signs and sends an arbitrary {to, data, value} transaction with this chain's
    /// signer — for calldata that isn't a typed contract call (e.g. LiFi-provided swap
    /// calldata, dust-rescue-forwarding.service.ts). Goes through the same broadcast()
    /// every other write on this service uses (per-signer lock + explicit nonce), so it
    /// safely interleaves with concurrent RelaySwaps/relay writes on the same account.
    async sendRawTransaction(params: { to: Address; data: Hex; value: bigint }): Promise<Hash> {
        const walletClient = await this.signer();
        try {
            const publicClient = await this.client();
            const cap = relayGasCap(RELAY_GAS_BUDGET.relaySwap, this.config.relayGasCapMultiplier());
            const estimate = await publicClient.estimateGas({
                account: walletClient.account,
                to: params.to,
                data: params.data,
                value: params.value,
            });
            if (estimate > cap) {
                const error = `sendRawTransaction rejected: estimated gas ${estimate} exceeds the relayer's cap of ${cap}.`;
                this.logger.error(error);
                throw new BadRequestException(error);
            }
            return await this.broadcast(publicClient, walletClient, "sendRawTransaction", (tx) =>
                walletClient.sendTransaction({
                    account: walletClient.account,
                    chain: walletClient.chain,
                    to: params.to,
                    data: params.data,
                    value: params.value,
                    gas: relayGasLimit(estimate, cap),
                    ...tx,
                })
            );
        } catch (error) {
            this.failWrite(error, "sendRawTransaction");
        }
    }

    /// This chain's own signer address — used by dust-rescue-forwarding.service.ts to
    /// build a LiFi quote request's `fromAddress` and to check its own ERC-20 allowance
    /// before forwarding dust #1.
    async signerAddress(): Promise<Address> {
        const walletClient = await this.signer();
        return walletClient.account.address;
    }

    /// Waits for a transaction's receipt on this chain — used by
    /// dust-rescue-forwarding.service.ts to read the main relaySwap tx's own receipt
    /// before parsing its dust-#1 Transfer log.
    async waitForTransactionReceipt(hash: Hash): Promise<TransactionReceipt> {
        const publicClient = await this.client();
        return publicClient.waitForTransactionReceipt({ hash });
    }

    async simulateAndWriteRelayWithdrawal(
        payload: EvmRelaySDKPayload,
        value?: bigint
    ): Promise<WriteContractReturnType> {
        return this.simulateAndWriteRelay(payload, value);
    }

    /// Short, arg-free error text safe for logs and client responses. viem's
    /// BaseError.message pretty-prints the full call args (proof, noteData,
    /// recipient routing) — leaking those de-anonymizes withdrawals (audit
    /// R-H4). shortMessage carries no args; the decoded custom error name is
    /// appended for supportability.
    private safeErrorMessage(error: unknown): string {
        if (error instanceof BaseError) {
            const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
            const errorName = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
            return errorName ? `${error.shortMessage} (${errorName})` : error.shortMessage;
        }
        return error instanceof Error ? error.message : "Unknown error";
    }

    /// Node-side error text (viem BaseError.details: the JSON-RPC error message / revert
    /// reason), which carries no call args — safe to log, and the only thing that explains a
    /// generic "Missing or invalid parameters" (-32602) or "execution reverted" from the node.
    /// Log-only: never echoed to the client.
    private nodeErrorDetails(error: unknown): string | undefined {
        if (!(error instanceof BaseError)) return undefined;
        const withDetails = error.walk((e) => e instanceof BaseError && !!e.details);
        const details = withDetails instanceof BaseError ? withDetails.details : undefined;
        return details ? details.slice(0, 500) : undefined;
    }

    /// True when the underlying failure is the RELAYER's own signer wallet
    /// lacking native funds for gas — walk() because viem wraps the node's
    /// rejection inside ContractFunctionExecutionError/TransactionExecutionError,
    /// so a top-level instanceof would miss it. The message regex catches nodes
    /// whose rejection text viem does not classify into InsufficientFundsError.
    private isOutOfFundsError(error: unknown): boolean {
        if (error instanceof BaseError && error.walk((e) => e instanceof InsufficientFundsError)) {
            return true;
        }
        const msg = error instanceof Error ? error.message : "";
        return /insufficient funds/i.test(msg);
    }

    /// Single exit for every simulate/write catch below. An unfunded relayer
    /// signer is an operator fault, not a client fault (see §4 of the package
    /// CLAUDE.md): it surfaces as a retryable 503 with a static, arg-free
    /// message — never the generic 400 whose wording blames the request — and
    /// pages operators via the `turbo` log level. `logPrefix` preserves a
    /// site's historical log wording where it differs from the client text.
    private failWrite(error: unknown, action: string, logPrefix?: string): never {
        // Our own verdicts (e.g. the gas-cap rejection in writeWithGasCap) are already
        // logged and client-safe — re-throw as-is instead of re-wrapping them.
        if (error instanceof HttpException) throw error;
        const msg = this.safeErrorMessage(error);
        if (this.isOutOfFundsError(error)) {
            const chainId = this.config.chainId();
            this.logger.turbo(
                `RELAYER WALLET OUT OF FUNDS on chain ${chainId}: cannot pay gas for ${action} — top up the signer wallet. ${msg}.`,
                { dedupKey: `relayer.outOfFunds.${chainId}` }
            );
            throw new ServiceUnavailableException(
                `Relayer temporarily unavailable on chain ${chainId}: the relayer's wallet cannot cover gas for ${action}. ` +
                    `This is a relayer-side fault, not a problem with your request — retry after the relayer wallet is topped up.`
            );
        }
        this.logger.error(`${logPrefix ?? `${action} failed`}: ${msg}.`);
        // The client gets the fixed-template form (errors/redact.ts): viem's first
        // line can carry the node's own text, an echoed provider key included.
        throw new BadRequestException(`${action} failed: ${clientSafeErrorMessage(error).replace(/\.$/, "")}.`);
    }

    /// Every relay broadcast goes through here. `budget` is the gas the quote priced the
    /// action at (relay_gas_budget.ts); the ceiling is `budget × relay_gas_cap_multiplier`.
    /// The transaction is estimated first and refused — HTTP 400, nothing signed, no gas
    /// spent — when the estimate exceeds the ceiling; otherwise it is sent with the
    /// estimate plus RELAY_GAS_HEADROOM_BPS (5%), never above the ceiling, as its gas limit
    /// (relayGasLimit; the bare estimate ran 7 mainnet relays out of gas, since inclusion
    /// costs slightly more than the previous block's state). Never send with the ceiling
    /// itself as a matter of course: eth_estimateGas
    /// binary-searches the *minimum* gas that succeeds, so a recipient that simply burns
    /// whatever it is given estimates at ~21k and would then be handed the whole ceiling.
    /// The attack this guards against is the recipient that reverts below a chosen
    /// threshold and burns everything above it: its estimate lands at ~the threshold (up
    /// to the block limit, ~45× the priced gas), which is exactly what the cap refuses.
    /// PrivacyPoolRelay pays native recipients with safeTransferETH (all remaining gas
    /// forwarded), so the contract cannot bound this; the relayer is the party paying.
    private async writeWithGasCap<TRequest extends { gas?: bigint }>(
        publicClient: PublicClient,
        walletClient: ConnectedWalletClient,
        request: TRequest,
        budget: Gas,
        action: string
    ): Promise<WriteContractReturnType> {
        const cap = relayGasCap(budget, this.config.relayGasCapMultiplier());
        const estimate = await publicClient.estimateContractGas(
            request as unknown as Parameters<PublicClient["estimateContractGas"]>[0]
        );
        if (estimate > cap) {
            const error =
                `${action} rejected: estimated gas ${estimate} exceeds the relayer's cap of ${cap} ` +
                `(${budget} priced × ${this.config.relayGasCapMultiplier()}). A recipient or callback that ` +
                `consumes gas on receive cannot be relayed.`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }
        // `request` is exactly what simulateContract handed back (the same object the
        // un-capped path passed straight to writeContract); only `gas` (estimate + headroom),
        // the nonce and the fees are added.
        return this.broadcast(publicClient, walletClient, action, (tx) =>
            walletClient.writeContract({
                ...request,
                gas: relayGasLimit(estimate, cap),
                ...tx,
            } as unknown as Parameters<ConnectedWalletClient["writeContract"]>[0])
        );
    }

    /// The single broadcast path. Under a per-chain+signer lock (stuck-nonce.ts):
    /// runs the stuck-nonce check (which may cancel a stuck floor nonce), resolves
    /// fees (tip floor, when configured), assigns the nonce explicitly, sends, and
    /// records the nonce as outstanding. Gas estimation and the cap check stay
    /// outside, so the lock is held only around nonce assignment and the send.
    private async broadcast(
        publicClient: PublicClient,
        walletClient: ConnectedWalletClient,
        action: string,
        send: (tx: { nonce?: number } & BroadcastFees) => Promise<Hash>
    ): Promise<Hash> {
        const address = walletClient.account.address;
        const hash = await withSignerLock(this.chainId, address, async () => {
            const pendingHint = await checkAndFixStuckNonce({
                chainId: this.chainId,
                chain: this.chain,
                signerPrivateKey: this.config.signerPrivateKey(),
                publicClient,
                address,
                logger: this.logger,
            });
            const fees = await resolveBroadcastFees(publicClient, this.chainId, this.logger);
            return sendWithAssignedNonce({
                chainId: this.chainId,
                address,
                publicClient,
                pendingHint,
                logger: this.logger,
                send: (nonce) => send(nonce === undefined ? { ...fees } : { nonce, ...fees }),
            });
        });
        this.recordBroadcastLog(publicClient, address, hash, action);
        this.checkSignerBalance(publicClient, address);
        return hash;
    }

    /// Fire-and-forget, like recordBroadcastLog: after a broadcast, pages operators (alert-dispatcher,
    /// see §4b of the package CLAUDE.md) when the signer's balance is below
    /// LOW_BALANCE_ALERT_WEI_EVM_<id>. The tx's value has already left the balance; its gas only
    /// once mined, so the reading is at most one tx's gas high. Never awaited, never throws.
    private checkSignerBalance(publicClient: PublicClient, signer: Address): void {
        const chainId = this.chainId;
        void (async () => {
            try {
                const threshold = lowBalanceAlertWei(chainId);
                if (threshold === undefined) return;
                const balance = await publicClient.getBalance({ address: signer });
                if (balance >= threshold) return;
                const symbol = this.config.nativeCurrency().symbol;
                this.logger.warn(
                    `RELAYER WALLET LOW on chain ${chainId}: signer ${signer} holds ${formatEther(balance)} ${symbol}, ` +
                        `below LOW_BALANCE_ALERT_WEI_EVM_${chainId} (${formatEther(threshold)} ${symbol}) — top up the signer.`,
                    {
                        alert: true,
                        dedupKey: `relayer.lowBalance.${chainId}`,
                        chainId,
                        signer,
                        balanceWei: balance.toString(),
                        thresholdWei: threshold.toString(),
                    }
                );
            } catch (error) {
                this.logger.warn(
                    `Could not check the signer balance on chain ${chainId} after a broadcast: ${this.safeErrorMessage(error)}.`
                );
            }
        })();
    }

    /// Fire-and-forget: resolves the nonce a just-broadcast tx used and logs it
    /// alongside its hash/signer/chainId (issue #239) — purely observational,
    /// nothing else in this file reads this log (detection above reads live chain
    /// state only). Never awaited by callers, so it can never add latency to the
    /// client-facing response. A small retry-guarded lookup: the RPC that
    /// accepted the broadcast can occasionally take a few hundred ms to reflect
    /// it on a subsequent read if `http()` load-balances across backend nodes.
    private recordBroadcastLog(publicClient: PublicClient, signer: Address, hash: Hash, action: string): void {
        const chainId = this.chainId;
        void (async () => {
            const retryDelaysMs = [0, 250, 750];
            for (const delayMs of retryDelaysMs) {
                if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
                try {
                    const tx = await publicClient.getTransaction({ hash });
                    this.logger.log(`Broadcast nonce reservation for ${action}`, {
                        nonce: tx.nonce,
                        txHash: hash,
                        signer,
                        chainId,
                    });
                    return;
                } catch {
                    // retry
                }
            }
            this.logger.warn(
                `Could not resolve the nonce used by ${action} txHash ${hash} on chain ${chainId} after broadcast — ` +
                    `nonce not logged for this tx.`
            );
        })();
    }

    /// Guards the simulate+write sequence against duplicate and
    /// overlapping-nullifier requests. Each nullifier
    /// in the request is checked against inFlightNullifiers; if any match, the
    /// request is rejected immediately with an actionable error — no simulation
    /// is triggered and no gas is spent. If no collision, all nullifiers are
    /// locked for the duration of fn() and released when it settles.
    private withNullifierLock(
        nullifiers: string[],
        fn: () => Promise<WriteContractReturnType>
    ): Promise<WriteContractReturnType> {
        const keys = nullifiers.map((n) => `${chainKey(ChainType.EVM, this.chainId)}:${n}`);
        const collision = keys.find((k) => inFlightNullifiers.has(k));
        if (collision) {
            const hash = collision.slice(collision.indexOf(":") + 1);
            throw new BadRequestException(
                `Nullifier ${hash} is already in-flight — ` +
                    `a transaction spending this note is pending confirmation. ` +
                    `Wait for it to settle and retry.`
            );
        }
        keys.forEach((k) => inFlightNullifiers.add(k));
        return fn().finally(() => keys.forEach((k) => inFlightNullifiers.delete(k)));
    }

    async simulateAndWriteRelayTransfer(payload: EvmRelaySDKPayload): Promise<WriteContractReturnType> {
        return this.withNullifierLock(payload.proof.parsedPubSignals.nullifierHashes, async () => {
            const { proof, data, noteData } = payload;
            const { pA, pB, pC, pubSignals } = proof;

            const address = this.config.poolVaultContractAddress();
            const [walletClient, publicClient] = await Promise.all([this.signer(), this.client()]);
            const processor = walletClient.account.address;
            try {
                const { request } = await publicClient.simulateContract({
                    address,
                    abi: [...POOL_VAULT_ABI, ...ALL_CONTRACT_ERRORS],
                    functionName: "transact",
                    args: [{ pA, pB, pC, pubSignals }, { processor, data }, noteData],
                    account: walletClient.account,
                });
                return await this.writeWithGasCap(
                    publicClient,
                    walletClient,
                    request,
                    RELAY_GAS_BUDGET.shieldedTransfer,
                    "PoolVault transact"
                );
            } catch (error) {
                this.failWrite(error, "PoolVault transact");
            }
        });
    }

    async simulateAndWriteRelaySwap(payload: EvmRelaySwapPayload): Promise<WriteContractReturnType> {
        const address = this.config.relaySwapsContractAddress();
        if (!address) {
            throw new BadRequestException(`Swaps not supported for chain ${this.config.chainId()}`);
        }
        return this.withNullifierLock(payload.proof.parsedPubSignals.nullifierHashes, async () => {
            const { proof, data, noteData, nativeGas, zap, b2GasSwap } = payload;
            const { pA, pB, pC, pubSignals } = proof;
            // B2 (swapValue > 0) runs an extra in-contract gas swap, and executeUnwrapped (a zap is
            // set) redeems a yield share first; the quote surcharged both, so the cap allows them.
            const swapBudget = relaySwapGasBudget(b2GasSwap === true, zap !== undefined);

            const [walletClient, publicClient] = await Promise.all([this.signer(), this.client()]);
            try {
                const abi = [...RELAY_SWAPS_ABI, ...ALL_CONTRACT_ERRORS];
                // Yield share: executeUnwrapped(…, zap) redeems the shares through the allowlisted
                // zap before the swap; plain assets take execute(). Same proof/params either way.
                if (zap) {
                    const { request } = await publicClient.simulateContract({
                        address,
                        abi,
                        functionName: "executeUnwrapped",
                        args: [{ pA, pB, pC, pubSignals }, { processor: address, data }, noteData, zap],
                        account: walletClient.account,
                        value: nativeGas,
                    });
                    return await this.writeWithGasCap(
                        publicClient,
                        walletClient,
                        request,
                        swapBudget,
                        "RelaySwaps executeUnwrapped"
                    );
                }
                const { request } = await publicClient.simulateContract({
                    address,
                    abi,
                    functionName: "execute",
                    args: [{ pA, pB, pC, pubSignals }, { processor: address, data }, noteData],
                    account: walletClient.account,
                    value: nativeGas,
                });
                return await this.writeWithGasCap(publicClient, walletClient, request, swapBudget, "RelaySwaps execute");
            } catch (error) {
                this.failWrite(error, "RelaySwaps");
            }
        });
    }

    async simulateAndWriteRelay(payload: EvmRelaySDKPayload, value?: bigint): Promise<WriteContractReturnType> {
        return this.withNullifierLock(payload.proof.parsedPubSignals.nullifierHashes, async () => {
            const { proof, data, noteData, processorAddress, minUnderlyingOut } = payload;
            const { pA, pB, pC, pubSignals } = proof;

            // When the request specifies a (validated, allowlisted) alternate
            // processor, route the withdrawal through PPRouter.withdrawToUnderlying
            // instead of the default PrivacyPoolRelay.relay. The processor address
            // carried inside TransactParams MUST be the router itself: PPRouter
            // enforces `_transactParams.processor == address(this)` (so the vault
            // pays the withdrawn pp-shares to the router, which it then redeems for
            // the underlying). This processor is bound into the proof `context`, so
            // the relayer cannot substitute a different one. The call target is the
            // router and a trailing minUnderlyingOut slippage floor is appended.
            if (processorAddress !== undefined) {
                const processor = processorAddress;
                const walletClient = await this.signer();
                const publicClient = await this.client();
                try {
                    const { request } = await publicClient.simulateContract({
                        address: processorAddress,
                        abi: [...PP_ROUTER_WITHDRAW_ABI, ...ALL_CONTRACT_ERRORS],
                        functionName: "withdrawToUnderlying",
                        args: [
                            { pA, pB, pC, pubSignals },
                            { processor, data },
                            noteData,
                            minUnderlyingOut ?? 0n,
                        ],
                        account: walletClient.account,
                        value: value ?? 0n,
                    });
                    return await this.writeWithGasCap(
                        publicClient,
                        walletClient,
                        request,
                        RELAY_GAS_BUDGET.yieldRelay,
                        "PPRouter withdrawToUnderlying"
                    );
                } catch (error) {
                    this.failWrite(
                        error,
                        "PPRouter withdrawToUnderlying",
                        "PPRouter withdrawToUnderlying simulation reverted"
                    );
                }
            }

            const processor = this.config.relayContractAddress();
            const address = this.config.relayContractAddress();
            const walletClient = await this.signer();
            const publicClient = await this.client();
            try {
                const { request } = await publicClient.simulateContract({
                    address,
                    abi: [...PP_RELAY_ABI, ...ALL_CONTRACT_ERRORS],
                    functionName: "relay",
                    args: [{ pA, pB, pC, pubSignals }, { data, processor }, noteData],
                    account: walletClient.account,
                    value: value ?? 0n,
                });
                return await this.writeWithGasCap(publicClient, walletClient, request, RELAY_GAS_BUDGET.relay, "Relay");
            } catch (error) {
                this.failWrite(error, "Relay");
            }
        });
    }

    /// Submits ONE `registerAndRelay` transaction: registers the account's
    /// keystore auth policy (via the account's own EIP-712 signature) and relays
    /// its withdrawal atomically. Targets the relay contract, which resolves the
    /// keystore off the pool internally (no extra config address). Mirrors
    /// `simulateAndWriteRelay`'s default (non-router) viem simulate-then-write
    /// path — the registration transfers no value, so no PPRouter branch applies.
    /// The three uint256 registration fields arrive as hex on the wire and are
    /// converted to bigint here; the signature is passed through as bytes.
    async simulateAndWriteRegisterAndRelay(
        payload: EvmRelayRegisterSDKPayload,
        value?: bigint
    ): Promise<WriteContractReturnType> {
        return this.withNullifierLock(payload.proof.parsedPubSignals.nullifierHashes, async () => {
            const { proof, data, noteData, registration } = payload;
            const { pA, pB, pC, pubSignals } = proof;
            const { account, authDigest, nullifyingKeyHash, deadline, signature } = registration;

            const processor = this.config.relayContractAddress();
            const address = this.config.relayContractAddress();
            const walletClient = await this.signer();
            const publicClient = await this.client();
            try {
                const { request } = await publicClient.simulateContract({
                    address,
                    abi: [...PP_RELAY_ABI, ...ALL_CONTRACT_ERRORS],
                    functionName: "registerAndRelay",
                    args: [
                        account,
                        BigInt(authDigest),
                        BigInt(nullifyingKeyHash),
                        BigInt(deadline),
                        signature,
                        { pA, pB, pC, pubSignals },
                        { data, processor },
                        noteData,
                    ],
                    account: walletClient.account,
                    value: value ?? 0n,
                });
                return await this.writeWithGasCap(
                    publicClient,
                    walletClient,
                    request,
                    RELAY_GAS_BUDGET.relay,
                    "RegisterAndRelay"
                );
            } catch (error) {
                this.failWrite(error, "RegisterAndRelay", "RegisterAndRelay simulation reverted");
            }
        });
    }

    /// Submits ONE `relayAndAnnounce` transaction: relays the withdrawal to a
    /// stealth address then calls the pinned ERC-5564 Announcer atomically. Targets
    /// the relay contract, which enforces that the announcement's stealthAddress
    /// equals the PayoutRouting recipient. Mirrors `simulateAndWriteRelay`'s default
    /// (non-router) viem simulate-then-write path — the announcement carries no
    /// value, so no PPRouter branch applies. `schemeId` arrives as hex on the wire
    /// and is converted to bigint here; stealthAddress/ephemeralPubKey/metadata pass
    /// through unchanged.
    async simulateAndWriteRelayAndAnnounce(
        payload: EvmRelayAndAnnounceSDKPayload,
        value?: bigint
    ): Promise<WriteContractReturnType> {
        return this.withNullifierLock(payload.proof.parsedPubSignals.nullifierHashes, async () => {
            const { proof, data, noteData, announcement } = payload;
            const { pA, pB, pC, pubSignals } = proof;
            const { schemeId, stealthAddress, ephemeralPubKey, metadata } = announcement;

            const processor = this.config.relayContractAddress();
            const address = this.config.relayContractAddress();
            const walletClient = await this.signer();
            const publicClient = await this.client();
            try {
                const { request } = await publicClient.simulateContract({
                    address,
                    abi: [...PP_RELAY_ABI, ...ALL_CONTRACT_ERRORS],
                    functionName: "relayAndAnnounce",
                    args: [
                        { pA, pB, pC, pubSignals },
                        { data, processor },
                        noteData,
                        { schemeId: BigInt(schemeId), stealthAddress, ephemeralPubKey, metadata },
                    ],
                    account: walletClient.account,
                    value: value ?? 0n,
                });
                return await this.writeWithGasCap(
                    publicClient,
                    walletClient,
                    request,
                    RELAY_GAS_BUDGET.relay,
                    "RelayAndAnnounce"
                );
            } catch (error) {
                this.failWrite(error, "RelayAndAnnounce", "RelayAndAnnounce simulation reverted");
            }
        });
    }

    /// Submits ONE `relayBatch` transaction spending N transacts in a single
    /// call. `value` is the summed `PayoutRouting.nativeGas` across items (0 for
    /// v1). Mirrors `simulateAndWriteRelay`'s viem simulate-then-write pattern.
    async simulateAndWriteRelayBatch(
        payload: EvmRelayBatchSDKPayload,
        value?: bigint
    ): Promise<WriteContractReturnType> {
        const nullifiers = payload.proofs.flatMap((p) => p.parsedPubSignals.nullifierHashes);
        return this.withNullifierLock(nullifiers, async () => {
            const { proofs, transactParams, noteData } = payload;

            // Fail fast (audit L-2): MAX_BATCH must stay strictly below the pool's
            // rootHistorySize, else a near-max batch's early item root is evicted
            // before the batch lands and reverts with PoolVault_UnknownStateRoot.
            await this.assertBatchFitsRootHistory();

            const address = this.config.relayContractAddress();
            const walletClient = await this.signer();
            const publicClient = await this.client();

            const proofArgs = proofs.map(({ pA, pB, pC, pubSignals }) => ({ pA, pB, pC, pubSignals }));

            try {
                const { request } = await publicClient.simulateContract({
                    address,
                    abi: [...PP_RELAY_ABI, ...ALL_CONTRACT_ERRORS],
                    functionName: "relayBatch",
                    args: [proofArgs, transactParams, noteData],
                    account: walletClient.account,
                    value: value ?? 0n,
                });
                return await this.writeWithGasCap(
                    publicClient,
                    walletClient,
                    request,
                    relayBatchGasBudget(proofs.length),
                    "RelayBatch"
                );
            } catch (error) {
                this.failWrite(error, "RelayBatch", "RelayBatch simulation reverted");
            }
        });
    }

    /// Reads the pool's `rootHistorySize` (cached per pool) and rejects the batch
    /// path if the compile-time `MAX_BATCH` is not strictly below it. Cheap: the
    /// on-chain read happens at most once per pool per process (audit L-2).
    /// Also cross-checks the relay contract's own `MAX_BATCH()` against this
    /// process's `MAX_BATCH` so a contract/SDK drift fails fast (review QUALITY-1).
    private async assertBatchFitsRootHistory(): Promise<void> {
        const pool = this.config.poolVaultContractAddress();
        let historySize = rootHistorySizeCache.get(pool);
        if (historySize === undefined) {
            const publicClient = await this.client();
            const size = await publicClient.readContract({
                address: pool,
                abi: POOL_VAULT_ABI,
                functionName: "rootHistorySize",
            });
            historySize = Number(size);
            rootHistorySizeCache.set(pool, historySize);
        }
        if (MAX_BATCH >= historySize) {
            const error = `Batch disabled: MAX_BATCH (${MAX_BATCH}) must be strictly below pool rootHistorySize (${historySize})`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const relay = this.config.relayContractAddress();
        let contractMaxBatch = relayMaxBatchCache.get(relay);
        if (contractMaxBatch === undefined) {
            const publicClient = await this.client();
            const onchain = await publicClient.readContract({
                address: relay,
                abi: PP_RELAY_ABI,
                functionName: "MAX_BATCH",
            });
            contractMaxBatch = Number(onchain);
            relayMaxBatchCache.set(relay, contractMaxBatch);
        }
        if (contractMaxBatch !== MAX_BATCH) {
            const error = `Batch disabled: SDK MAX_BATCH (${MAX_BATCH}) does not match relay contract MAX_BATCH (${contractMaxBatch})`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }
    }
}
