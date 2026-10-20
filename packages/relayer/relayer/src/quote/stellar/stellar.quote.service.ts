import { BadRequestException, Injectable, Scope } from "@nestjs/common";
import { ChainedQuoteService } from "../quote.interface";
import { ChainType } from "../../config/enums";
import { FATLoggerService } from "../../logger/fat.logger.provider";
import { StellarConfigService } from "../../config/stellar/stellar-config.service";
import { StellarChainService } from "../../chain.service/stellar.chain.service";
import { computeBatchFees } from "@privacy-pools-v2/core-sdk/batch-fee";
import { zStellarBatchQuoteRequest, zStellarQuoteRequest, zStellarTransferQuoteRequest } from "./schemas";
import {
    StellarBatchQuoteRequest,
    StellarBatchQuoteResponse,
    StellarQuoteRequest,
    StellarQuoteResponse,
    StellarTransferQuoteRequest,
    StellarTransferQuoteResponse,
} from "./types";

@Injectable({ scope: Scope.REQUEST })
export class StellarQuoteService implements ChainedQuoteService<ChainType.STELLAR> {
    schema = zStellarQuoteRequest;
    transferSchema = zStellarTransferQuoteRequest;
    batchSchema = zStellarBatchQuoteRequest;

    get ExpirationTime() {
        return this.configService.quoteExpirationMs();
    }

    constructor(
        private readonly logger: FATLoggerService,
        private readonly configService: StellarConfigService,
        private readonly chainService: StellarChainService
    ) {}

    /**
     * `exact` mirrors EVM's send/receive split (`quote/evm/evm.quote.service.ts`,
     * `calculateExactBpsFee`/`calculateExactFlatFee`): `false` ("send") means `amount` is what
     * leaves the pool and the fee comes out of it; `true` ("receive") means `amount` is what the
     * recipient should end up with and the fee is added on top (`amountSent = amount + feeAmount`).
     * The fee itself is computed identically either way — only which side absorbs it differs.
     */
    async quote(params: StellarQuoteRequest, exact: boolean): Promise<StellarQuoteResponse> {
        const { asset, amount, recipient, commit } = params;
        this.logger.info("Stellar quote fee calculation", { asset, commit, exact });

        const { maxRelayFee } = await this.chainService.getAssetConfig(asset);
        const assetConfig = this.configService.asset(asset);

        // No gas-price oracle equivalent exists — Soroban resource fees are computed
        // deterministically at simulate time, not a market price to read ahead of quoting.
        // Fee is a flat configured amount (stroops) plus an optional per-asset bps, capped
        // against the on-chain max_relay_fee (a real safety check enforced on-chain too).
        // In "receive" (exact) mode the bps fee is computed on the desired OUTPUT, mirroring
        // EVM's calculateExactBpsFee — not solved algebraically for the input.
        const flatFee = await this.flatFee(asset);
        let feeAmount = assetConfig.fee_bps
            ? (amount * BigInt(assetConfig.fee_bps)) / 10_000n
            : flatFee;
        if (maxRelayFee > 0n && feeAmount > maxRelayFee) {
            feeAmount = maxRelayFee;
        }

        let amountSent: bigint;
        let amountReceived: bigint;
        if (exact) {
            amountReceived = amount;
            amountSent = amount + feeAmount;
        } else {
            if (amount < feeAmount) {
                throw new BadRequestException(
                    `Relay fee (${feeAmount}) exceeds withdrawal amount (${amount}). Increase the withdrawal amount.`
                );
            }
            amountSent = amount;
            amountReceived = amount - feeAmount;
        }

        const quoteResponse: StellarQuoteResponse = {
            feeAmount,
            amountSent,
            amountReceived,
        };

        if (commit === true && recipient === undefined) {
            throw new BadRequestException("Recipient value missing: cannot commit to a fee without a recipient");
        } else if (commit === true && recipient !== undefined) {
            const feeCommitment = await this.createWithdrawalFeeCommitment({
                asset,
                recipient,
                feeAmount,
                amountSent,
                amountReceived,
            });
            return { ...quoteResponse, feeCommitment };
        }

        return quoteResponse;
    }

    /**
     * Private-transfer quote. A relayed transfer's only public outflow is the fee itself
     * (`amountOut == feeAmount`, paid to this relayer as the pool's processor), so there is no
     * amount to quote on: the fee is the flat stroop fee (in shares for a yield share), capped at
     * the asset's `max_relay_fee`.
     */
    async quoteTransfer(params: StellarTransferQuoteRequest): Promise<StellarTransferQuoteResponse> {
        const { asset, commit } = params;
        this.logger.info("Stellar transfer quote", { asset, commit });
        const { maxRelayFee } = await this.chainService.getAssetConfig(asset);
        let feeAmount = await this.flatFee(asset);
        if (maxRelayFee > 0n && feeAmount > maxRelayFee) {
            feeAmount = maxRelayFee;
        }
        const quote = { feeAmount, txCost: 0n, gasPrice: 0n };
        if (commit !== true) return quote;

        const feeReceiver = this.configService.feeReceiverAddress();
        const commitment = {
            data: this.chainService.encodeRouting(feeReceiver, feeReceiver, feeAmount),
            asset,
            expiration: Number(new Date()) + this.ExpirationTime,
            feeAmount,
        };
        const signedRelayerCommitment = await this.chainService.signTransferCommitment(commitment);
        return { ...quote, feeCommitment: { ...commitment, signedRelayerCommitment } };
    }

    /**
     * Batch quote: each item pays exactly what the same withdrawal would cost relayed alone (the
     * SDK's `computeBatchFees`, dogfooded as on EVM), so cherry-picking one proof out of a batch and
     * relaying it singly earns nothing extra. There is no gas oracle on Soroban, so `relayCost` is
     * 0 and the fee is the flat stroop fee (or the asset's bps) per item, capped at `max_relay_fee`.
     */
    async quoteBatch(params: StellarBatchQuoteRequest): Promise<StellarBatchQuoteResponse> {
        const { asset, recipient, amounts, commit } = params;
        this.logger.info("Stellar batch quote fee calculation", { asset, itemCount: amounts.length });

        if (params.extraGas) {
            throw new BadRequestException("extraGas is not supported on Stellar: PayoutRouting has no native-gas leg");
        }
        const { maxRelayFee } = await this.chainService.getAssetConfig(asset);
        const assetConfig = this.configService.asset(asset);
        const feeBps = BigInt(assetConfig.fee_bps ?? 0);
        const flatFee = feeBps > 0n ? 0n : await this.flatFee(asset);
        const relayCost = 0n;

        let feeSplit: bigint[];
        try {
            feeSplit = computeBatchFees({ relayCost, feeBps, flatFee, amountOuts: amounts, maxRelayFee });
        } catch (e: unknown) {
            throw new BadRequestException(`Cannot compute batch fees: ${e instanceof Error ? e.message : String(e)}`);
        }
        const totalFee = feeSplit.reduce((sum, fee) => sum + fee, 0n);

        // Signing only on an explicit commit (CLAUDE.md §3 / SEC-1).
        if (commit !== true) {
            return { txCost: 0n, gasPrice: 0n, totalFee, maxRelayFee };
        }

        const feeReceiver = this.configService.feeReceiverAddress();
        const commitment = {
            data: this.chainService.encodeRoutings(
                feeSplit.map((feeAmount) => ({ recipient, feeRecipient: feeReceiver, feeAmount }))
            ),
            asset,
            expiration: Number(new Date()) + this.ExpirationTime,
            totalFee,
            maxRelayFee,
            relayCost,
            feeBps,
            flatFee,
        };
        const signedRelayerCommitment = await this.chainService.signBatchCommitment(commitment);
        return {
            txCost: 0n,
            gasPrice: 0n,
            totalFee,
            maxRelayFee,
            feeCommitment: { ...commitment, signedRelayerCommitment },
        };
    }

    /**
     * The flat fee for `asset`, in that asset's base units: its own `flat_fee_amount` or the chain
     * default. A yield share's fee is configured in its UNDERLYING and priced in shares, converted at
     * the share's own rate.
     */
    private async flatFee(asset: string): Promise<bigint> {
        const amount = this.configService.flatFeeAmount(asset);
        return this.configService.asset(asset).yield_router
            ? this.chainService.sharesForUnderlying(asset, amount)
            : amount;
    }

    private async createWithdrawalFeeCommitment(params: {
        asset: string;
        recipient: string;
        feeAmount: bigint;
        amountSent: bigint;
        amountReceived: bigint;
    }) {
        const feeReceiverAddress = this.configService.feeReceiverAddress();
        const data = this.chainService.encodeRouting(params.recipient, feeReceiverAddress, params.feeAmount);
        const expiration = Number(new Date()) + this.ExpirationTime;

        const relayerCommitment = {
            asset: params.asset,
            recipient: params.recipient,
            feeAmount: params.feeAmount,
            amountSent: params.amountSent,
            amountReceived: params.amountReceived,
            data,
            expiration,
        };

        const signedRelayerCommitment = await this.chainService.signRelayWithdrawalCommitment(relayerCommitment);

        return {
            ...relayerCommitment,
            signedRelayerCommitment,
        };
    }
}
