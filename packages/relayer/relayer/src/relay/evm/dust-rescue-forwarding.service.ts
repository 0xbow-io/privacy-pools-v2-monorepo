import { Injectable, Scope } from "@nestjs/common";
import { decodeEventLog, encodeFunctionData, getAddress, parseAbi, type Address, type Hex, type TransactionReceipt } from "viem";
import {
    isLiFiExecutor,
    isLiFiExecutorCall,
    LIFI_EXECUTOR_SCREENING_ABI,
    LiFiSwapQuoteProvider,
    type SwapQuoteResult,
} from "@privacy-pools-v2/evm-sdk";
import { FATLoggerService } from "../../logger/fat.logger.provider";
import { EVMChainService } from "../../chain.service/evm.chain.service";
import { RelayerConfig } from "../../config/relayer-config";
import { EvmChainConfigWrapper } from "../../config/evm/evm-chain-config";
import { ChainType } from "../../config/enums";

/** Minimal ABI fragment — same "no need for the full ERC-20 ABI" pattern as
 * dust-rescue-service's own chain-write module. */
const ERC20_TRANSFER_EVENT_ABI = [
    {
        type: "event",
        name: "Transfer",
        inputs: [
            { name: "from", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
        ],
    },
] as const;

const ERC20_ALLOWANCE_ABI = [
    {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
    },
] as const;

const ERC20_APPROVE_ABI = [
    {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
] as const;

/** Minimum swept amount (source-chain token units) worth bridging via LiFi.
 * Below this we log and skip — bridge cost would exceed dust value. Set low (0.05 USDC)
 * so real dust is forwarded and LiFi either routes it or 404s it (test handles both). */
const MIN_FORWARD_AMOUNT = 50_000n;

/** `RelaySwaps.approvedRouters(address)` — the owner-managed allowlist every user swap is
 * held to (the contract enforces it in `execute()`, the SDK re-checks it before proving).
 * The forward below executes third-party calldata with the relayer's own hot key, so it is
 * held to exactly the same list (minr #12). */
const RELAY_SWAPS_APPROVED_ROUTERS_ABI = parseAbi(["function approvedRouters(address) view returns (bool)"]);

export interface ForwardDustParams {
    /** The main relaySwap tx whose receipt carries dust #1's Transfer log. */
    sourceTxHash: Hex;
    /** Dust #1's asset — the ZK proof's asset, i.e. this relaySwap's swap-input token. */
    proofAsset: Address;
    /** Where RelaySwaps.sol's `_sweepDust` sent dust #1 on this (source) chain — decoded
     * from the commitment as `routing.dustRecipient`. */
    dustRecipient: Address;
    destinationChainId: number;
    /** Destination-chain dust-rescue asset — same as the job's `tokenId`. */
    tokenId: Address;
    /** The committed relay fee (signedSwapCommitment.feeAmount). Subtracted from
     * totalTransfers only when feeRecipient == dustRecipient (both land at the same
     * address as Transfer events); when they differ the fee was routed elsewhere and
     * totalTransfers already contains only the actual swept dust. */
    relayFeeAmount: bigint;
    /** Address that received the relay fee (routing.feeRecipient). Compared against
     * dustRecipient to decide whether the fee is included in parseSweptAmount(). */
    feeRecipient: Address;
}

/**
 * Forwards cross-chain reshield's source-chain swap-input dust ("dust #1", RelaySwaps.sol's
 * `_sweepDust`) into the same rescue as the destination-chain leftover ("dust #2",
 * dust-rescue-service) — issue #222, see dust_unification_feasibility_and_plan.org.
 *
 * A plain LiFi swap+transfer, not a stealth address and not balance-based: moves dust #1
 * straight to the unified dust-rescue wallet address on the destination chain (the same
 * address dust #2 already lands at post-unification — see derive-keys.ts). Triggered
 * synchronously from evm.relay.service.ts, awaited before responding to the caller — the
 * relayer's Cloud Run deploy sets no --min-instances/--no-cpu-throttling, so a detached
 * background task after the HTTP response has no CPU-allocation guarantee and would
 * routinely (not just on crash) fail to complete. Only affects dustRescue-opted-in
 * cross-chain-reshield calls, already understood to be a slower operation.
 *
 * Strictly additive: any failure at any step is logged and swallowed — dust #1 simply
 * stays at `dustRecipient`, exactly as it does today with no forwarding at all. Never
 * throws into the caller's request path.
 *
 * v1 scope: ERC-20 dust #1 only (needs a Transfer log to size the swept amount) — native
 * ETH dust #1 has no such log and is silently skipped, same precedent as dust #2's
 * original ERC-20-only boundary before it moved to LiFi's self-reported amount.
 *
 * Security (RC-03): `params.dustRecipient` is caller-supplied (it travels inside the
 * proof-bound routing tuple, which the *prover* — not this service — controls) and is
 * used here only for logging. Sizing what to bridge is done by matching the source
 * receipt's Transfer logs against this relayer's own signer address, never against
 * `dustRecipient` — a caller cannot inflate `sweptAmount` by naming an address (e.g.
 * `RelaySwaps` itself, so the pool's own withdrawal payout counts as "dust") that this
 * service never spends from. What gets bridged is exactly what this relay's own
 * `_sweepDust` call deposited into *this* wallet, nothing more.
 */
@Injectable({ scope: Scope.REQUEST })
export class DustRescueForwardingService {
    private readonly lifi = new LiFiSwapQuoteProvider({ apiKey: process.env.LIFI_API_KEY });

    constructor(
        private readonly logger: FATLoggerService,
        private readonly chainService: EVMChainService,
        private readonly relayerConfig: RelayerConfig,
    ) {}

    /** Returns the forward's own broadcast tx hash, or undefined if there was nothing to
     * forward or forwarding failed at any step. Never throws. */
    async forward(fromChainId: number, params: ForwardDustParams): Promise<Hex | undefined> {
        this.logger.log(`Dust #1 forward() entered: sourceTx=${params.sourceTxHash} asset=${params.proofAsset} dustRecipient=${params.dustRecipient} destChain=${params.destinationChainId}`);
        try {
            // Fetched up front: this is the only address `sweptAmount` is ever measured
            // against (see the class doc's Security note) and the wallet the forward swap
            // is later sent from — both must agree, so there is exactly one source of truth.
            const fromAddress = await this.chainService.signerAddress();
            const receipt = await this.chainService.waitForTransactionReceipt(params.sourceTxHash);
            this.logger.log(`Dust #1 forward(): receipt obtained, ${receipt.logs.length} logs`);
            const totalTransfers = this.parseSweptAmount(receipt, params.proofAsset, fromAddress);
            this.logger.log(`Dust #1 forward(): totalTransfers=${totalTransfers?.toString() ?? "undefined"} relayFee=${params.relayFeeAmount} feeRecipient=${params.feeRecipient} signerAddress=${fromAddress}`);
            // Subtract the relay fee only when it actually lands in the same wallet the
            // sweep is measured against — otherwise it was routed to feeRecipient
            // elsewhere and totalTransfers already contains only the actual swept dust,
            // so subtracting here would make it negative.
            const feeIncluded =
                params.feeRecipient.toLowerCase() === fromAddress.toLowerCase();
            const sweptAmount = totalTransfers !== undefined
                ? totalTransfers - (feeIncluded ? params.relayFeeAmount : 0n)
                : undefined;
            this.logger.log(`Dust #1 forward(): actualSweptAmount=${sweptAmount?.toString() ?? "undefined"}`);
            if (sweptAmount === undefined || sweptAmount <= 0n) {
                this.logger.warn(`Dust #1 forwarding skipped: actual swept dust is ${sweptAmount?.toString() ?? "undefined"} after subtracting relay fee for asset=${params.proofAsset} dustRecipient=${params.dustRecipient}`);
                return undefined;
            }
            if (sweptAmount < MIN_FORWARD_AMOUNT) {
                this.logger.warn(`Dust #1 forwarding skipped: swept amount ${sweptAmount} is below minimum ${MIN_FORWARD_AMOUNT} — dust stays at ${params.dustRecipient}`);
                return undefined;
            }

            const toAddress = new EvmChainConfigWrapper(
                this.relayerConfig.chain(ChainType.EVM).config(params.destinationChainId)
            ).dustRescueRecipientAddress();
            this.logger.log(`Dust #1 forward(): toAddress=${toAddress}`);
            if (!toAddress) {
                this.logger.warn(
                    `Dust #1 forwarding skipped: chain ${params.destinationChainId} has no dust_rescue_recipient_address configured.`,
                );
                return undefined;
            }

            this.logger.log(`Dust #1 forward(): fromAddress=${fromAddress} sweptAmount=${sweptAmount} calling LiFi...`);
            const quote = await this.lifi.getSwapQuote({
                fromChainId,
                toChainId: params.destinationChainId,
                fromToken: params.proofAsset,
                toToken: params.tokenId,
                fromAddress,
                toAddress,
                amount: sweptAmount.toString(),
                amountType: "from",
            });

            this.logger.log(`Dust #1 forward(): LiFi quote received approvalAddress=${quote.approvalAddress} txTo=${quote.transactionTo}`);

            // Never execute a quote the relayer's own key cannot vouch for: the response is
            // third-party data and `transactionTo`/`transactionData` run as the signer, which
            // holds every user's swept dust between forwards (minr #12).
            const relaySwaps = new EvmChainConfigWrapper(
                this.relayerConfig.chain(ChainType.EVM).config(fromChainId)
            ).relaySwapsContractAddress();
            if (!relaySwaps) {
                this.logger.warn(
                    `Dust #1 forwarding skipped: chain ${fromChainId} has no relay_swaps_contract to validate the LiFi quote against.`,
                );
                return undefined;
            }
            const refusal = await this.quoteRefusalReason(quote, relaySwaps, fromChainId, params);
            if (refusal) {
                this.logger.error(`Dust #1 forwarding REFUSED, leaving dust at ${fromAddress}: ${refusal}`);
                return undefined;
            }

            await this.maybeApprove(fromAddress, params.proofAsset, quote.approvalAddress, sweptAmount);
            this.logger.log(`Dust #1 forward(): approve step done, sending forward tx...`);

            // ERC-20-only in v1 (see class doc) — the swap never carries native value.
            const forwardTxHash = await this.chainService.sendRawTransaction({
                to: quote.transactionTo,
                data: quote.transactionData,
                value: 0n,
            });
            this.logger.log(
                `Forwarded dust #1 (${sweptAmount} of ${params.proofAsset}) via tx ${forwardTxHash} -> chain ${params.destinationChainId}`,
            );
            return forwardTxHash;
        } catch (error) {
            this.logger.error(
                `Dust #1 forwarding failed, leaving dust at ${params.dustRecipient}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return undefined;
        }
    }

    /** Everything the relayer checks before letting its signer act on a LiFi quote. Returns a
     * reason to refuse, or undefined when the quote is executable: the echoed tokens/chains
     * must match what was asked (same check the SDK's `assertSwapQuoteMatchesRequest` does
     * for users), the target may not be the token contract itself (a `transfer(...)` payload
     * would drain the signer's whole balance), and both `transactionTo` and
     * `approvalAddress` must be on `RelaySwaps.approvedRouters` — the one allowlist users,
     * the contract and now the relayer all share — and neither may be LiFi's Executor. That
     * allowlist includes the Executor, which runs arbitrary calls for anyone: as the target it
     * can send the signer's dust anywhere, and as the spender anyone can drain the approval
     * whenever the forward reverts or is skipped (the approve and the forward are separate txs). */
    private async quoteRefusalReason(
        quote: SwapQuoteResult,
        relaySwaps: Address,
        fromChainId: number,
        params: ForwardDustParams,
    ): Promise<string | undefined> {
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        if (!same(quote.fromTokenAddress, params.proofAsset)) {
            return `quote fromToken ${quote.fromTokenAddress} != swept asset ${params.proofAsset}`;
        }
        if (!same(quote.toTokenAddress, params.tokenId)) {
            return `quote toToken ${quote.toTokenAddress} != destination asset ${params.tokenId}`;
        }
        if (quote.fromChainId !== fromChainId || quote.toChainId !== params.destinationChainId) {
            return `quote chains ${quote.fromChainId}->${quote.toChainId} != ${fromChainId}->${params.destinationChainId}`;
        }
        if (same(quote.transactionTo, params.proofAsset)) {
            return `quote transactionTo is the token contract ${quote.transactionTo} itself`;
        }
        const isExecutor = (address: Address): Promise<boolean> =>
            isLiFiExecutor(address, (target) =>
                this.chainService.readContract({
                    address: target,
                    abi: LIFI_EXECUTOR_SCREENING_ABI,
                    functionName: "erc20Proxy",
                }),
            );
        if (await isExecutor(quote.approvalAddress)) {
            return `approvalAddress ${quote.approvalAddress} is LiFi's Executor; anyone could spend an allowance granted to it`;
        }
        if (isLiFiExecutorCall(quote.transactionData) || (await isExecutor(quote.transactionTo))) {
            return `transactionTo ${quote.transactionTo} calls LiFi's Executor, which runs arbitrary calls`;
        }
        const isApproved = async (router: Address): Promise<boolean> =>
            (await this.chainService.readContract({
                address: relaySwaps,
                abi: RELAY_SWAPS_APPROVED_ROUTERS_ABI,
                functionName: "approvedRouters",
                args: [router],
            })) === true;
        const [toOk, approvalOk] = await Promise.all([isApproved(quote.transactionTo), isApproved(quote.approvalAddress)]);
        if (!toOk) return `transactionTo ${quote.transactionTo} is not on RelaySwaps(${relaySwaps}).approvedRouters`;
        if (!approvalOk) return `approvalAddress ${quote.approvalAddress} is not on RelaySwaps(${relaySwaps}).approvedRouters`;
        return undefined;
    }

    /** Sums the source receipt's Transfer logs of `asset` landing at `relayerWallet` —
     * this relayer's own signer address, never the caller-supplied `dustRecipient` (see
     * the class doc's Security note). */
    private parseSweptAmount(receipt: TransactionReceipt, asset: Address, relayerWallet: Address): bigint | undefined {
        const wantAddress = getAddress(asset);
        const wantRecipient = getAddress(relayerWallet);
        let total = 0n;
        let found = false;
        for (const log of receipt.logs) {
            if (getAddress(log.address) !== wantAddress) continue;
            try {
                const decoded = decodeEventLog({
                    abi: ERC20_TRANSFER_EVENT_ABI,
                    data: log.data,
                    topics: log.topics,
                });
                if (getAddress(decoded.args.to) === wantRecipient) {
                    total += decoded.args.value;
                    found = true;
                }
            } catch {
                // Not a Transfer log (or a differently-shaped one) — ignore.
            }
        }
        return found ? total : undefined;
    }

    private async maybeApprove(walletAddress: Address, token: Address, spender: Address, amount: bigint): Promise<void> {
        const currentAllowance = await this.chainService.readContract({
            address: token,
            abi: ERC20_ALLOWANCE_ABI,
            functionName: "allowance",
            args: [walletAddress, spender],
        });
        if (currentAllowance >= amount) return;
        const approve = (value: bigint) =>
            this.chainService.sendRawTransaction({
                to: token,
                data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [spender, value] }),
                value: 0n,
            });
        // Tether-style tokens (mainnet USDT) revert a non-zero approve over a non-zero
        // allowance — a forward that failed after its approval leaves exactly that behind, and
        // every later forward of that token would be refused for good. Reset first (minr #28).
        if (currentAllowance > 0n) {
            const resetHash = await approve(0n);
            await this.chainService.waitForTransactionReceipt(resetHash);
        }
        await approve(amount);
    }
}
