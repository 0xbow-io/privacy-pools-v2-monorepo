import { BadRequestException, Injectable, Scope } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { EvmConfigService } from "../../config/evm/evm-config.service";
import {
    EvmWithdrawalFeeCommitment,
    EvmSwapFeeCommitment,
    EvmSignedTransferFeeCommitment,
    EvmTransferFeeCommitment,
    EvmSignedWithdrawalFeeCommitment,
    EvmSignedSwapFeeCommitment,
    EvmDustRescue,
} from "./types";
import { toRoutingDustRescue } from "../../relay/evm/dust_rescue_routing";
import { BPS, Gas, Wei } from "./unit.types";
import { RELAY_GAS_BUDGET, relayGasBudget, relaySwapGasBudget } from "./relay_gas_budget";
import { EvmAddress, NATIVE_ASSET_ADDRESS } from "../../config/evm/evm.types";
import { getAddress, parseAbi } from "viem";
import { resolveFeeReceiver } from "./utils";
import { EVMChainService } from "../../chain.service/evm.chain.service";
import { FATLoggerService } from "../../logger/fat.logger.provider";
import { zEvmQuoteRequest, zEvmShieldedQuoteRequest, zEvmBatchQuoteRequest, zEvmSwapQuoteRequest } from "./evm.schemas";
import { ChainedQuoteService } from "../quote.interface";
import { ChainType } from "../../config/enums";
import { RateProviderService } from "../../rate_provider/rate_provider.service";
import { RateProvider, TokenDescription } from "../../rate_provider/rate_types";
import { calculateBpsFee, calculateExactBpsFee, calculateExactFlatFee, calculateExtraGas, calculateFlatFee, nativeToToken } from "./fee.calculations";
import { EvmContractService } from "../../sdk/evm.contract.service";
import { EvmAssetConfig } from "../../config/types";
import {
    EvmTransferQuoteRequestDto,
    EvmTransferQuoteResponseDto,
    EvmWithdrawalQuoteRequestDto,
    EvmWithdrawalQuoteResponseDto,
    EvmBatchWithdrawalQuoteRequestDto,
    EvmSwapQuoteRequestDto,
    EvmSwapQuoteResponseDto,
} from "../../dto/evm.quote.dto";
import { EvmBatchWithdrawalQuoteResponse } from "./types";
import { encodeTransferFeeSplit, encodeWithdrawalFeeSplit, encodeBatchFeeSplit } from "../../relay/evm/fee_abi";
import { FeeSplit } from "../../relay/evm/types";
import { computeBatchFees } from "@privacy-pools-v2/core-sdk/batch-fee";
import { encodeRelaySwapRouting } from "../../relay/evm/swap_routing_abi";
import { YieldZapRegistry } from "../../rate_provider/yield_zap_registry";

// ERC-4626 view used to price share tokens off their underlying (quoteViaUnderlying).
// Same read PPRouter.quoteWithdraw() makes, so relayer fee and router floor agree.
const ERC4626_PREVIEW_REDEEM_ABI = parseAbi(["function previewRedeem(uint256 shares) view returns (uint256 assets)"]);

interface TransactionCostValues {
    extraGasDetail: object | undefined;
    transactionPrice: Wei;
}

@Injectable({ scope: Scope.REQUEST })
export class EvmQuoteService implements ChainedQuoteService<ChainType.EVM> {
    schema = zEvmQuoteRequest;
    transferSchema = zEvmShieldedQuoteRequest;
    batchSchema = zEvmBatchQuoteRequest;
    swapSchema = zEvmSwapQuoteRequest;

    get ExpirationTime() {
        return this.configService.quoteExpirationMs();
    }

    // Gas budgets are shared with EVMChainService's broadcast cap (relay_gas_budget.ts) so the
    // priced gas and the refused gas can never drift apart.
    readonly relayTxCost = RELAY_GAS_BUDGET.relay;
    readonly shieldedTransferTxCost = RELAY_GAS_BUDGET.shieldedTransfer;
    readonly extraGasTxCost = RELAY_GAS_BUDGET.extraGasTx;
    readonly extraGasFundAmount = RELAY_GAS_BUDGET.extraGasFund;

    constructor(
        private readonly configService: EvmConfigService,
        private readonly logger: FATLoggerService,
        private readonly chainService: EVMChainService,
        private readonly discoveryService: DiscoveryService,
        private readonly contractService: EvmContractService,
        private readonly yieldZapRegistry: YieldZapRegistry
    ) {}

    async quoteTransfer(params: EvmTransferQuoteRequestDto): Promise<EvmTransferQuoteResponseDto> {
        const { asset, commit } = params;
        // shielded transfer: flat fee only, no extraGas
        // Gas price, asset config, and the rate quote are independent — run them
        // concurrently (the batched transport coalesces same-tick RPC calls).
        const [gasPrice, { maxRelayFee }, nativeQuote] = await Promise.all([
            this.chainService.getGasPrice(),
            this.contractService.getAssetConfig(asset),
            this.quoteInNativeToken(asset),
        ]);
        const flatFeeAmount = this.configService.flatFeeAmount();
        const { transactionPrice } = this.calculateTransactionCost(false, gasPrice, true);
        const transactionPriceInToken = nativeToToken(transactionPrice, nativeQuote, this.configService.asset(asset).decimals);
        const feeAmount = calculateFlatFee(transactionPriceInToken, flatFeeAmount, maxRelayFee);

        const quoteResponse: EvmTransferQuoteResponseDto = {
            feeAmount,
            gasPrice,
            txCost: this.shieldedTransferTxCost,
            processor: this.configService.processorAddress("transfer"),
        };

        if (commit === true) {
            const feeCommitment = await this.createTransferFeeCommitment({ feeAmount, asset });
            return { ...quoteResponse, feeCommitment };
        }

        return quoteResponse;
    }

    async quote(params: EvmWithdrawalQuoteRequestDto, exact: boolean): Promise<EvmWithdrawalQuoteResponseDto> {
        const { asset, amount, extraGas, recipient, commit } = params;

        // Privacy: no recipient/amount in logs (audit R-H4); no bigint in meta
        // (fatFormat JSON.stringify throws on bigint).
        this.logger.info("EVM quote fee calculation", { asset, extraGas, exact });

        const [gasPrice, { maxRelayFee }, nativeQuote] = await Promise.all([
            this.chainService.getGasPrice(),
            this.contractService.getAssetConfig(asset),
            this.quoteInNativeToken(asset),
        ]);
        const flatFeeAmount = this.configService.flatFeeAmount();
        this.logger.info(`maxRelayFee: ${maxRelayFee}`);
        // A yield share leaves through its PPRouter (redeem + unwrap), which costs more gas.
        const withdrawTxCost = relayGasBudget(this.isYieldShare(asset));
        const { transactionPrice: relayPrice, extraGasDetail } = this.calculateTransactionCost(extraGas, gasPrice, false, withdrawTxCost);

        let feeAmount: Wei;
        let responseAmount: Wei;

        const assetConfig = this.configService.asset(asset);

        // Convert relay price from wei to token units using the native quote rate.
        const relayPriceInToken = nativeToToken(relayPrice, nativeQuote, assetConfig.decimals);

        if (exact) {
            if (assetConfig.fee_bps) {
                const result = calculateExactBpsFee(amount, assetConfig.fee_bps, nativeQuote, relayPrice, maxRelayFee, assetConfig.decimals);
                feeAmount = result.feeAmount;
                responseAmount = result.requiredInput;
            } else {
                feeAmount = calculateFlatFee(relayPriceInToken, flatFeeAmount, maxRelayFee);
                responseAmount = calculateExactFlatFee(amount, feeAmount);
            }
        } else {
            if (assetConfig.fee_bps) {
                feeAmount = calculateBpsFee(amount, assetConfig.fee_bps, nativeQuote, relayPrice, maxRelayFee, assetConfig.decimals);
            } else {
                feeAmount = calculateFlatFee(relayPriceInToken, flatFeeAmount, maxRelayFee);
            }
            responseAmount = amount;
        }

        const amountSent = responseAmount;
        if (amountSent < feeAmount) {
            throw new BadRequestException(
                `Relay fee (${feeAmount}) exceeds withdrawal amount (${amount}). Increase the withdrawal amount.`
            );
        }
        const amountReceived = Wei(amountSent - feeAmount);

        let nativeGas = Wei(0n);
        if (extraGas) {
            const extraGasResult = calculateExtraGas(this.extraGasFundAmount, nativeQuote, gasPrice, assetConfig.decimals);
            nativeGas = extraGasResult.nativeGas;
            if (extraGasResult.nativeGasInToken > amountReceived) {
                throw new BadRequestException(
                    `Native gas cost (${extraGasResult.nativeGasInToken} token units) exceeds amount received (${amountReceived}). Increase the withdrawal amount.`
                );
            }
        }

        const quoteResponse: EvmWithdrawalQuoteResponseDto = {
            feeAmount,
            gasPrice,
            txCost: withdrawTxCost,
            processor: this.configService.processorAddress("withdrawal"),
            amountSent,
            amountReceived,
            ...extraGasDetail,
        };

        if (commit === true && recipient === undefined) {
            throw new BadRequestException("Recipient value missing: cannot commit to a fee without a recipient");
        } else if (commit === true && recipient !== undefined) {
            const feeCommitment = await this.createWithdrawalFeeCommitment({
                feeAmount,
                asset,
                recipient,
                amountSent,
                amountReceived,
            }, nativeGas);
            return { ...quoteResponse, feeCommitment };
        }

        return quoteResponse;
    }

    async quoteBatch(params: EvmBatchWithdrawalQuoteRequestDto): Promise<EvmBatchWithdrawalQuoteResponse> {
        const { asset, recipient, amounts, commit } = params;

        this.logger.info("EVM batch quote fee calculation", { asset, itemCount: amounts.length });

        const [gasPrice, { maxRelayFee }, nativeQuote] = await Promise.all([
            this.chainService.getGasPrice(),
            this.contractService.getAssetConfig(asset),
            this.quoteInNativeToken(asset),
        ]);
        const flatFeeAmount = this.configService.flatFeeAmount();
        const assetConfig = this.configService.asset(asset);

        const count = BigInt(amounts.length);
        const summed = amounts.reduce((sum, a) => Wei(sum + a), Wei(0n));

        // NORMAL single-tx fee per item, SDK-verified. Each batch item pays exactly
        // what that transact would cost as a STANDALONE withdrawal, so a greedy
        // relayer that cherry-picks one proof and submits it via the single relay()
        // earns only the fair per-item fee — it cannot pocket the whole batch fee.
        //
        // relayCost is the per-item relay gas cost in token units (NOT whole-batch gas). feeBps XOR flatFee:
        // a bps asset charges relayCost + amountOut*feeBps/10000 per item; a flat
        // asset charges relayCost + flatFee per item (N flat fees total).
        // Priced at the batch PER-ITEM budget: N transacts share one call's overhead
        // (measured ~611k/item on a 4-item relayBatch vs ~740k for a standalone relay).
        const { transactionPrice: relayPrice } = this.calculateTransactionCost(false, gasPrice, false, RELAY_GAS_BUDGET.relayBatchItem);
        const relayCost = nativeToToken(relayPrice, nativeQuote, assetConfig.decimals);
        const feeBps = assetConfig.fee_bps ?? BPS(0n);
        const flatFee = feeBps > 0n ? Wei(0n) : Wei(flatFeeAmount);

        // Per-item fees via the SDK (dogfooded, single source of truth). Throws if
        // any item's own fee exceeds its withdrawn amount (InfeasibleBatchFee).
        let feeSplit: bigint[];
        try {
            feeSplit = computeBatchFees({
                relayCost: BigInt(relayCost),
                feeBps: BigInt(feeBps),
                flatFee: BigInt(flatFee),
                amountOuts: amounts.map((a) => BigInt(a)),
                maxRelayFee: BigInt(maxRelayFee),
            });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new BadRequestException(`Cannot compute batch fees: ${msg}`);
        }

        const totalFee = Wei(feeSplit.reduce((sum, fee) => sum + fee, 0n));

        // txCost reports the whole-batch gas estimate (N transacts) for display; it
        // no longer drives the fee, which is per-item single-tx cost.
        const batchGas = Gas(RELAY_GAS_BUDGET.relayBatchItem * BigInt(count));

        // Gate EIP-712 signing on `commit === true`, mirroring the single-withdraw
        // `quote()` path. A non-committing caller gets the fee estimate only; we do
        // NOT sign a commitment. This stops an unauthenticated caller from forcing
        // unbounded signer work via POST /v1/quote/.../batch (code-review R1 SEC-1).
        if (commit !== true) {
            return {
                txCost: batchGas,
                gasPrice,
                totalFee,
                maxRelayFee,
            };
        }

        const feeCommitment = await this.createBatchWithdrawalFeeCommitment({
            asset,
            recipient,
            feeSplit,
            maxRelayFee,
            relayCost,
            feeBps,
            flatFee,
            totalFee,
            totalAmountSent: summed,
            totalAmountReceived: Wei(summed - totalFee),
        });

        return {
            txCost: batchGas,
            gasPrice,
            totalFee,
            maxRelayFee,
            feeCommitment,
        };
    }

    // RelaySwaps gas cost (withdraw + DEX aggregator call) and the B2 gas-swap surcharge —
    // see relay_gas_budget.ts for the rationale of each number.
    readonly relaySwapTxCost = RELAY_GAS_BUDGET.relaySwap;
    readonly b2GasSwapTxCostSurcharge = RELAY_GAS_BUDGET.b2GasSwapSurcharge;

    async quoteSwap(params: EvmSwapQuoteRequestDto): Promise<EvmSwapQuoteResponseDto> {
        if (!this.configService.relaySwapsContractAddress()) {
            throw new BadRequestException(`Swaps not supported for chain ${this.configService.chainId()}`);
        }

        // Yield share input: reject before signing anything if RelaySwaps has no approved zap
        // for the share (derived on-chain at boot). Without it relaySwap would revert with
        // RelaySwaps_InvalidZap only after the caller spent a proof against the commitment.
        const swapAssetConfig = this.configService.asset(params.asset);
        if (
            swapAssetConfig.quoter === RateProvider.UNDERLYING &&
            !this.yieldZapRegistry.zapForShare(this.configService.chainId(), params.asset)
        ) {
            throw new BadRequestException(
                `Yield share ${swapAssetConfig.ticker} has no approved zap on this relayer's RelaySwaps — ` +
                    `cannot quote a swap for it.`
            );
        }

        const {
          asset,
          amount,
          outputToken,
          recipient,
          fallbackAddress,
          minOutputAmount,
          extraGas,
          swapCalldata,
          swapTarget,
          approvalAddress,
          swapValue,
          gasSwapMaxInput,
          gasSwapCalldata,
          dustRecipient,
          dustRescue,
          commit
        } = params;

        this.logger.info("EVM swap quote fee calculation", { asset, outputToken });

        // B2: a Mainnet-destination reshield carries swapValue > 0. The schema refinement
        // already guarantees gasSwapCalldata + gasSwapMaxInput are present alongside it on
        // a committed request; the extra relayer gas is surcharged onto txCost below.
        const b2Active = swapValue !== undefined && swapValue > 0n;
        // A yield-share input is redeemed first (executeUnwrapped): surcharge that gas too.
        const txCost = relaySwapGasBudget(b2Active, this.isYieldShare(asset));
        const [gasPrice, { maxRelayFee }, nativeQuote] = await Promise.all([
            this.chainService.getGasPrice(),
            this.contractService.getAssetConfig(asset),
            this.quoteInNativeToken(asset),
        ]);
        const flatFeeAmount = this.configService.flatFeeAmount();
        const assetConfig = this.configService.asset(asset);
        const transactionPrice = Wei(gasPrice * txCost);
        const relayPriceInToken = nativeToToken(transactionPrice, nativeQuote, assetConfig.decimals);

        let feeAmount: Wei;
        if (assetConfig.fee_bps) {
            feeAmount = calculateBpsFee(amount, assetConfig.fee_bps, nativeQuote, transactionPrice, maxRelayFee, assetConfig.decimals);
        } else {
            feeAmount = calculateFlatFee(relayPriceInToken, flatFeeAmount, maxRelayFee);
        }

        // ETH gas top-up, mirroring the withdrawal path's `extraGas` flag: the client
        // only opts in; the RELAYER computes the funded amount (the fixed
        // extraGasFundAmount × gasPrice — never client-chosen, so no separate ceiling),
        // converts it to token units, and folds the cost into feeAmount so the user
        // pre-pays it (the `amount < feeAmount` guard below then also enforces
        // affordability, and the maxRelayFee ceiling bounds it).
        let nativeGas = Wei(0n);
        if (extraGas) {
            const extraGasResult = calculateExtraGas(this.extraGasFundAmount, nativeQuote, gasPrice, assetConfig.decimals);
            nativeGas = extraGasResult.nativeGas;
            feeAmount = Wei(feeAmount + extraGasResult.nativeGasInToken);
        }
        if (maxRelayFee !== 0n && feeAmount > maxRelayFee) {
            throw new BadRequestException(`Relay fee (${feeAmount}) exceeds maxRelayFee (${maxRelayFee}).`);
        }

        if (amount < feeAmount) {
            throw new BadRequestException(
                `Relay fee (${feeAmount}) exceeds withdrawal amount (${amount}). Increase the withdrawal amount.`
            );
        }

        const quoteResponse: EvmSwapQuoteResponseDto = {
            feeAmount,
            gasPrice,
            txCost,
        };

        if (commit) {

          if (swapCalldata === undefined || swapTarget === undefined)
            throw new BadRequestException(`If commited swapCalldata and swapTarget must be defined`);

            // B2: re-cap the client-supplied swapValue against the per-chain ceiling and
            // make sure the bounded gas-swap approval cannot exceed the post-fee principal
            // (the relay path re-checks both, so an unclamped commitment would be rejected
            // there). gasSwapCalldata / gasSwapMaxInput presence is enforced by the schema.
            let b2:
                | { swapValue: Wei; gasSwapMaxInput: Wei; gasSwapCalldata: `0x${string}` }
                | undefined;
            // `b2Active` already implies swapValue !== undefined; the extra check here is
            // only for TypeScript's narrowing (it cannot see through the boolean).
            if (b2Active && swapValue !== undefined) {
                const maxSwapValue = this.configService.maxSwapValueWei();
                if (swapValue > maxSwapValue) {
                    throw new BadRequestException(
                        `swapValue (${swapValue}) exceeds max_swap_value_wei (${maxSwapValue}).`,
                    );
                }
                if (gasSwapMaxInput === undefined || gasSwapCalldata === undefined) {
                    throw new BadRequestException(
                        `gasSwapMaxInput and gasSwapCalldata are required when swapValue > 0.`,
                    );
                }
                if (gasSwapMaxInput > Wei(amount - feeAmount)) {
                    throw new BadRequestException(
                        `gasSwapMaxInput (${gasSwapMaxInput}) exceeds the post-fee amount (${amount - feeAmount}).`,
                    );
                }
                b2 = { swapValue, gasSwapMaxInput, gasSwapCalldata };
            }

            const commitParams = { feeAmount, asset, recipient, amountSent: amount };
            const feeCommitment = await this.createRelaySwapFeeCommitment(
                commitParams,
                outputToken,
                minOutputAmount,
                nativeGas,
                fallbackAddress ?? recipient,
                swapCalldata,
                swapTarget,
                approvalAddress ?? swapTarget,
                dustRecipient,
                dustRescue,
                b2,
            );
            return { ...quoteResponse, feeCommitment };
        }

        return quoteResponse;
    }

    async createRelaySwapFeeCommitment(
        params: Omit<EvmSwapFeeCommitment, "data" | "expiration">,
        outputToken: EvmAddress,
        minOutputAmount: Wei,
        nativeGas: Wei,
        fallbackAddress: EvmAddress,
        swapCalldata: `0x${string}`,
        swapTarget: EvmAddress,
        approvalAddress: EvmAddress,
        dustRecipient: EvmAddress,
        // RC-10: the caller's opt-in dust-rescue block, encoded into the routing itself
        // (dust_rescue_routing.ts) rather than a separate signed field — SwapRouting.data
        // is already what the commitment signs, so this inherits that binding for free.
        dustRescue: EvmDustRescue | undefined,
        // B2 — self-funded bridge msg.value (Mainnet-destination reshield). Zero / "0x"
        // on every other path, in which case the encoded routing is byte-identical to the
        // pre-B2 shape's semantics (the three trailing tuple fields are all zero).
        b2: { swapValue: Wei; gasSwapMaxInput: Wei; gasSwapCalldata: `0x${string}` } = {
            swapValue: Wei(0n),
            gasSwapMaxInput: Wei(0n),
            gasSwapCalldata: "0x",
        },
    ): Promise<EvmSignedSwapFeeCommitment> {
        const { feeAmount, recipient } = params;
        const feeReceiverAddress = resolveFeeReceiver(this.configService, nativeGas);

        const data = encodeRelaySwapRouting({
            swapTarget: getAddress(swapTarget),
            approvalAddress: getAddress(approvalAddress),
            outputToken: getAddress(outputToken),
            recipient: getAddress(recipient),
            feeRecipient: getAddress(feeReceiverAddress),
            fallbackAddress: getAddress(fallbackAddress),
            dustRecipient: getAddress(dustRecipient),
            feeAmount,
            minOutputAmount,
            nativeGas,
            swapValue: b2.swapValue,
            gasSwapMaxInput: b2.gasSwapMaxInput,
            gasSwapCalldata: b2.gasSwapCalldata,
            swapCalldata,
            dustRescue: toRoutingDustRescue(dustRescue),
        });

        const expiration = Number(new Date()) + this.ExpirationTime;
        const relayerCommitment = { ...params, data, expiration };
        const signedRelayerCommitment = await this.chainService.signRelaySwapCommitment(relayerCommitment);

        return { ...relayerCommitment, signedRelayerCommitment };
    }

    calculateTransactionCost(extraGas: boolean, gasPrice: Wei, shielded = false, txCostOverride?: Gas): TransactionCostValues {
        const txCost = txCostOverride ?? Gas(shielded ? this.shieldedTransferTxCost : this.relayTxCost);
        if (extraGas) {
            const extraGasUnits = Gas(this.extraGasTxCost + this.extraGasFundAmount);
            const totalRelayCost = txCost + extraGasUnits;
            const transactionPrice = Wei(gasPrice * totalRelayCost);
            return {
                transactionPrice,
                extraGasDetail: {
                    extraGasTxCost: this.extraGasTxCost,
                    extraGasFundAmount: this.extraGasFundAmount,
                },
            };
        } else {
            return {
                transactionPrice: Wei(gasPrice * txCost),
                extraGasDetail: undefined,
            };
        }
    }

    /** A yield share is a configured asset with an `underlying` (ppUSDC, ppUSDT, ppETH, …). */
    private isYieldShare(asset: EvmAddress): boolean {
        return this.configService.asset(asset).underlying !== undefined;
    }

    async quoteInNativeToken(asset: EvmAddress) {
        const assetConfig = this.configService.asset(asset);
        if (this.isNativeToken(assetConfig)) {
            // Native asset: the fee is already in wei. nativeToToken scales by
            // 10^decimals, so return num = 10^decimals (den = 1) to cancel it exactly
            // and keep the conversion a no-op (uses the asset's own decimals so it
            // cancels the tokenDecimals the caller passes for this same asset).
            return { num: 10n ** BigInt(assetConfig.decimals), den: 1n };
        } else if (assetConfig.quoter === RateProvider.UNDERLYING) {
            return await this.quoteViaUnderlying(assetConfig);
        } else {
            const nativeAssetConfig = this.nativeAssetConfig();
            const chainType = this.configService.chainType();
            const chainId = this.configService.chainId();
            // EvmAssetConfig (the raw supported_assets[] entry) has no chain identity of its
            // own — chainId/chainType live on the enclosing chain config, not per asset — so
            // both tokens are enriched with the current request's chain context here, at the
            // one call site that actually talks to a (chain-scoped) rate provider.
            const inputToken: TokenDescription = { ...assetConfig, chainType, chainId };
            const nativeDescription: TokenDescription = { ...nativeAssetConfig, chainType, chainId };
            const rateProvider = this.discoverRateProvider(inputToken);
            return await rateProvider.quote(inputToken, nativeDescription, chainType, chainId, this.configService.rpcUrl());
        }
    }

    // ERC-4626 share tokens (ppUSDC over USDC, ppUSDT over USDT): nothing trades the
    // share, so its native rate is derived from the underlying's own quote, scaled by
    // the wrapper's live redeem rate. With the shared num/den convention (whole-native
    // per whole-input, decimals-invariant):
    //   share -> native = (previewRedeem(1 share) / 10^underlyingDecimals) * (underlying -> native)
    // Kept as an exact fraction. previewRedeem is what PPRouter.quoteWithdraw() reads
    // for the recipient floor, so fee and floor come from the same on-chain number.
    // The rate is Aave accounting (monotonic, not a pool price), so no historic check.
    private async quoteViaUnderlying(assetConfig: EvmAssetConfig): Promise<{ num: bigint; den: bigint }> {
        if (assetConfig.underlying === undefined) {
            throw new BadRequestException(`Asset ${assetConfig.ticker} uses quoter "Underlying" but has no underlying configured`);
        }
        const underlying = this.configService.asset(assetConfig.underlying);
        // A Native-treated underlying (WETH / native sentinel) quotes 1:1 to gas via
        // quoteInNativeToken's native branch, so a native-mode wrapper (ppETH over WETH)
        // prices as previewRedeem(1 share) worth of native. Only a chained share is refused.
        if (underlying.quoter === RateProvider.UNDERLYING) {
            throw new BadRequestException(
                `Asset ${assetConfig.ticker}: underlying ${underlying.ticker} is itself a share token — chained wrappers are not supported`
            );
        }
        const underlyingQuote = await this.quoteInNativeToken(underlying.address);
        const oneShare = 10n ** BigInt(assetConfig.decimals);
        const redeem = await this.chainService.readContract({
            address: assetConfig.address,
            abi: ERC4626_PREVIEW_REDEEM_ABI,
            functionName: "previewRedeem",
            args: [oneShare],
        });
        if (redeem === 0n) {
            throw new BadRequestException(`Asset ${assetConfig.ticker}: previewRedeem(1 share) returned 0 — cannot price shares`);
        }
        return {
            num: underlyingQuote.num * redeem,
            den: underlyingQuote.den * 10n ** BigInt(underlying.decimals),
        };
    }

    // The asset ERC20 quotes convert into. WETH is preferred (rate providers pool
    // against the wrapped form); otherwise the sentinel-addressed native asset —
    // which on chains like Citrea is not ETH-named (cBTC), so ticker lookups alone
    // cannot find it.
    private nativeAssetConfig(): EvmAssetConfig {
        const assets = this.configService.allAssets();
        const native =
            assets.find((a) => a.ticker.toLowerCase() === "weth") ??
            assets.find((a) => a.address.toLowerCase() === NATIVE_ASSET_ADDRESS);
        if (native === undefined) {
            const error = `No native asset configured for chain ${this.configService.chainId()}: cannot convert an ERC20 fee quote into the native asset`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }
        return native;
    }

    async createTransferFeeCommitment(
        params: Omit<EvmTransferFeeCommitment, "data" | "expiration">
    ): Promise<EvmSignedTransferFeeCommitment> {
        const feeReceiverAddress = this.configService.feeReceiverAddress();
        const data = encodeTransferFeeSplit(getAddress(feeReceiverAddress));

        const expiration = Number(new Date()) + this.ExpirationTime;
        const relayerCommitment = {
            ...params,
            data,
            expiration,
        };
        const signedRelayerCommitment = await this.chainService.signRelayTransferCommitment(relayerCommitment);

        return {
            ...relayerCommitment,
            signedRelayerCommitment,
        };
    }

    async createWithdrawalFeeCommitment(
        params: Omit<EvmWithdrawalFeeCommitment, "data" | "expiration">,
        nativeGas: Wei
    ): Promise<EvmSignedWithdrawalFeeCommitment> {
        const { feeAmount, recipient } = params;
        const feeReceiverAddress = resolveFeeReceiver(this.configService, nativeGas);

        const data = encodeWithdrawalFeeSplit(recipient, getAddress(feeReceiverAddress), feeAmount, nativeGas);

        const expiration = Number(new Date()) + this.ExpirationTime;

        const relayerCommitment = {
            ...params,
            data,
            expiration,
        };

        const signedRelayerCommitment = await this.chainService.signRelayWithdrawalCommitment(relayerCommitment);

        return {
            ...relayerCommitment,
            signedRelayerCommitment,
        };
    }

    async createBatchWithdrawalFeeCommitment(params: {
        asset: EvmAddress;
        recipient: EvmAddress;
        feeSplit: bigint[];
        maxRelayFee: Wei;
        relayCost: Wei;
        feeBps: BPS;
        flatFee: Wei;
        totalFee: Wei;
        totalAmountSent: Wei;
        totalAmountReceived: Wei;
    }): Promise<EvmBatchWithdrawalQuoteResponse["feeCommitment"]> {
        const {
            asset,
            recipient,
            feeSplit,
            maxRelayFee,
            relayCost,
            feeBps,
            flatFee,
            totalFee,
            totalAmountSent,
            totalAmountReceived,
        } = params;

        const feeReceiverAddress = getAddress(this.configService.feeReceiverAddress());

        // Build the per-item PayoutRouting[] and ABI-encode the WHOLE array into
        // `data`. All items share recipient + feeRecipient; only feeAmount varies.
        const routings: FeeSplit[] = feeSplit.map((feeAmount) => ({
            recipient: getAddress(recipient),
            feeRecipient: feeReceiverAddress,
            feeAmount,
            nativeGas: 0n,
        }));
        const data = encodeBatchFeeSplit(routings);

        const expiration = Number(new Date()) + this.ExpirationTime;

        // Sign the fee model (relayCost/feeBps/flatFee) alongside the totals so the
        // SDK can recompute + verify each item's fee against the signed parameters.
        const signedRelayerCommitment = await this.chainService.signRelayBatchWithdrawalCommitment({
            data,
            asset,
            expiration,
            totalAmountSent: BigInt(totalAmountSent),
            totalAmountReceived: BigInt(totalAmountReceived),
            relayCost: BigInt(relayCost),
            feeBps: BigInt(feeBps),
            flatFee: BigInt(flatFee),
        });

        return {
            data,
            asset,
            expiration,
            totalFee,
            maxRelayFee,
            relayCost,
            feeBps,
            flatFee,
            signedRelayerCommitment,
        };
    }

    discoverRateProvider(asset: TokenDescription): RateProviderService {
        const providers = this.discoveryService.getProviders();
        const maybeQuoter = providers.find((prov) => prov.token === asset.quoter);
        let quoter: RateProviderService;

        if (maybeQuoter && maybeQuoter.instance) {
            quoter = maybeQuoter.instance;
        } else {
            throw new Error(
                `Asset ${asset.ticker} expects a quoter with name ${asset.quoter}, which is not available.`
            );
        }
        return quoter;
    }

    isNativeToken(asset: EvmAssetConfig): boolean {
        // The sentinel address is how configs mark the native asset regardless of
        // its ticker (ETH on mainnet, cBTC on Citrea). WETH keeps its native
        // treatment: it quotes 1:1 against the native asset.
        return asset.address.toLowerCase() === NATIVE_ASSET_ADDRESS || asset.ticker.toLowerCase() === "weth";
    }
}
