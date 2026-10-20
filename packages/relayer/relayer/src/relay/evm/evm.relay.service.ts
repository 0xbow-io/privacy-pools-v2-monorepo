import { RateProvider } from "../../rate_provider/rate_types";
import type { EvmAddress } from "../../config/evm/evm.types";
import { BadRequestException, Injectable, Scope } from "@nestjs/common";
import { FATLoggerService } from "../../logger/fat.logger.provider";
import { clientSafeErrorMessage } from "../../errors/redact";
import { ChainedRelayService } from "../relay.interface";
import { ChainType } from "../../config/enums";
import {
    EvmRelayWithdrawalResponse,
    EvmRelayTransferRequest,
    EvmRelayTransferResponse,
    EvmRelaySwapRequest,
    EvmRelayWithdrawalRequest,
    EvmRelaySDKPayload,
    EvmRelayRegisterAndWithdrawalRequest,
    EvmRelayRegisterAndWithdrawalResponse,
    EvmRelayRegisterSDKPayload,
    EvmRelayAndAnnounceRequest,
    EvmRelayAndAnnounceResponse,
    EvmRelayAndAnnounceSDKPayload,
    EvmRelayBatchRequest,
    EvmRelayBatchResponse,
    EvmRelayBatchSDKPayload,
    EvmRelaySwapPayload,
    EvmRelayResponse,
    Bytes,
    FeeSplit,
    TransactParams,
    ReshapedProof,
    NoteData,
    ParsedPubSignals,
} from "./types";
import { EvmContractService } from "../../sdk/evm.contract.service";
import { getAddress, toHex } from "viem";
import { getAddressFromBigInt, resolveFeeReceiver } from "../../quote/evm/utils";
import { EVMChainService } from "../../chain.service/evm.chain.service";
import { EvmConfigService } from "../../config/evm/evm-config.service";
import { computeContext } from "./context";
import { decodeFeeSplit, decodeBatchFeeSplit, encodeWithdrawalFeeSplit } from "./fee_abi";
import { decodeRelaySwapRouting } from "./swap_routing_abi";
import { fromRoutingDustRescue } from "./dust_rescue_routing";
import { DustRescueOrchestratorService, dustRescueCeiling } from "./dust-rescue-orchestrator.service";
import { DustRescuePricingService } from "./dust-rescue-pricing.service";
import { DustRescueForwardingService } from "./dust-rescue-forwarding.service";
import { YieldZapRegistry } from "../../rate_provider/yield_zap_registry";
import {
    zEvmRelayWithdrawalRequest,
    zEvmRelayTransferRequest,
    zEvmRelayBatchRequest,
    zEvmRelaySwapRequest,
    zEvmRelayRegisterAndWithdrawalRequest,
    zEvmRelayAndAnnounceRequest,
} from "./schemas";

@Injectable({ scope: Scope.REQUEST })
export class EvmRelayService implements ChainedRelayService<ChainType.EVM> {
    withdrawalSchema = zEvmRelayWithdrawalRequest;
    transferSchema = zEvmRelayTransferRequest;
    batchSchema = zEvmRelayBatchRequest;
    relaySwapSchema = zEvmRelaySwapRequest;
    registerAndWithdrawalSchema = zEvmRelayRegisterAndWithdrawalRequest;
    relayAndAnnounceSchema = zEvmRelayAndAnnounceRequest;

    constructor(
        private readonly logger: FATLoggerService,
        private readonly contractService: EvmContractService,
        private readonly chainService: EVMChainService,
        private readonly configService: EvmConfigService,
        private readonly dustRescueOrchestrator: DustRescueOrchestratorService,
        private readonly dustRescuePricing: DustRescuePricingService,
        private readonly dustRescueForwarding: DustRescueForwardingService,
        private readonly yieldZapRegistry: YieldZapRegistry,
    ) {}

    async withdrawal(request: EvmRelayWithdrawalRequest): Promise<EvmRelayWithdrawalResponse> {
        this.logger.info("EVM relay withdrawal.");

        const { proof, noteData } = request;
        const {
            parsedPubSignals: { amountOut },
        } = proof;

        if (amountOut === 0n) {
            const error = "Bobbing for apples error: proof.pubSignals.amountOut should be more than 0";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const { encodedData: data, data: feeSplit } = await this.extractWithdrawalQuote(request);

        // Resolve and validate the (optional) alternate processor. When present
        // and allowlisted, the withdrawal is routed via PPRouter.withdrawToUnderlying
        // instead of the default PrivacyPoolRelay.relay. Reject anything not in
        // allowed_processors to prevent relaying to arbitrary contracts.
        const processorAddress = request.processorAddress;
        if (processorAddress !== undefined && !this.configService.isAllowedProcessor(processorAddress)) {
            const error = `processorAddress ${processorAddress} is not in the allowed_processors allowlist`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        // The processor the chain service will bind: the allowlisted alternate
        // (PPRouter) when given, else the default relay contract.
        const processor = processorAddress ?? this.configService.processorAddress("withdrawal");
        this.validateProofContext("withdrawal", processor, data, request);

        // minUnderlyingOut is the slippage floor for the PPRouter redeem leg,
        // denominated in the UNDERLYING token (e.g. USDC), not the pp-share
        // (ppUSDC) that is withdrawn from the pool. The fee commitment only
        // commits to pp-share amounts (amountSent / amountReceived), and the
        // relayer has no redeem-rate quote here, so it cannot safely derive an
        // underlying-denominated floor itself. The client therefore supplies its
        // own floor on the relay request; when omitted we default to 0n (no
        // on-relayer slippage protection). A too-high floor simply reverts in the
        // simulate step below, costing the relayer no gas (code-review R1 SEC-2).
        const minUnderlyingOut = request.minUnderlyingOut ?? 0n;

        // Build the payload that the SDK expects.
        const sdkPayload: EvmRelaySDKPayload = {
            proof,
            noteData,
            data,
            processorAddress,
            minUnderlyingOut,
        };

        const nativeGas = feeSplit.nativeGas;
        if (nativeGas > 0n) {
            this.logger.info(`Attaching nativeGas to relay call, amount is ${nativeGas}`);
        }

        const { txHash } = await this.contractService.sdkWithdraw(sdkPayload, nativeGas > 0n ? nativeGas : undefined);

        return { txHash };
    }

    async registerAndWithdrawal(
        request: EvmRelayRegisterAndWithdrawalRequest
    ): Promise<EvmRelayRegisterAndWithdrawalResponse> {
        this.logger.info("EVM relay registerAndWithdrawal.");

        const { proof, noteData, registration } = request;
        const {
            parsedPubSignals: { amountOut },
        } = proof;

        if (amountOut === 0n) {
            const error = "Bobbing for apples error: proof.pubSignals.amountOut should be more than 0";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        // Fee handling is identical to a plain withdrawal: the signed withdrawal commitment is reused as-is
        // and the relayer absorbs the extra keystore-registration gas. The registration transfers no value.
        // TODO: extend the quote to price registration gas into the fee commitment.
        const { encodedData: data, data: feeSplit } = await this.extractWithdrawalQuote(request);

        const sdkPayload: EvmRelayRegisterSDKPayload = {
            proof,
            noteData,
            data,
            registration,
        };

        const nativeGas = feeSplit.nativeGas;
        if (nativeGas > 0n) {
            this.logger.info("Attaching nativeGas to register-and-withdrawal call, amount is ", nativeGas);
        }

        const { txHash } = await this.contractService.sdkRegisterAndWithdraw(
            sdkPayload,
            nativeGas > 0n ? nativeGas : undefined
        );

        return { txHash };
    }

    async relayAndAnnounce(request: EvmRelayAndAnnounceRequest): Promise<EvmRelayAndAnnounceResponse> {
        this.logger.info("EVM relay relay-and-announce.");

        const { proof, noteData, announcement } = request;
        const {
            parsedPubSignals: { amountOut },
        } = proof;

        if (amountOut === 0n) {
            const error = "Bobbing for apples error: proof.pubSignals.amountOut should be more than 0";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        // The announcement transfers no value; the withdrawal fee quote is reused
        // for the relay leg exactly as `withdrawal()` / `registerAndWithdrawal()` do.
        const { encodedData: data, data: feeSplit } = await this.extractWithdrawalQuote(request);

        // No processorAddress on this endpoint: stealth×yield is unsupported, so
        // relay-and-announce is standard-relay only (no PPRouter branch, no
        // processor allowlist check).
        const sdkPayload: EvmRelayAndAnnounceSDKPayload = {
            proof,
            noteData,
            data,
            announcement,
        };

        const nativeGas = feeSplit.nativeGas;
        if (nativeGas > 0n) {
            this.logger.info("Attaching nativeGas to relay-and-announce call, amount is ", nativeGas);
        }

        const { txHash } = await this.contractService.sdkRelayAndAnnounce(
            sdkPayload,
            nativeGas > 0n ? nativeGas : undefined
        );

        return { txHash };
    }

    async transfer(request: EvmRelayTransferRequest): Promise<EvmRelayTransferResponse> {
        this.logger.info("EVM relay transfer");

        const { proof, noteData } = request;

        const { encodedData: data } = await this.extractTransferQuote(request);

        this.validateProofContext("transfer", this.configService.processorAddress("transfer"), data, request);

        const sdkPayload: EvmRelaySDKPayload = {
            proof,
            noteData,
            data,
        };

        return this.contractService.sdkTransfer(sdkPayload);
    }

    async batchWithdrawal(request: EvmRelayBatchRequest): Promise<EvmRelayBatchResponse> {
        this.logger.info("EVM relay batch withdrawal.", { itemCount: request.items.length });

        const { items, signedBatchFeeCommitment: commitment } = request;

        // Decode the relayer-signed PayoutRouting[] that the batch fee commitment
        // carries. It must line up one-to-one with the submitted items.
        const routings = decodeBatchFeeSplit(commitment.data);
        if (routings.length !== items.length) {
            const error = `Batch commitment encodes ${routings.length} routings but ${items.length} items were submitted`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const refRecipient = routings[0].recipient.toLowerCase();
        const refFeeRecipient = routings[0].feeRecipient.toLowerCase();

        const proofs: ReshapedProof[] = [];
        const transactParams: TransactParams[] = [];
        const noteData: NoteData[][] = [];
        let totalAmountSent = 0n;
        let totalFee = 0n;
        let totalNativeGas = 0n;
        const processor = this.configService.relayContractAddress();

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const routing = routings[i];
            const { amountOut, tokenIdOut } = item.proof.parsedPubSignals;
            const proofAsset = getAddressFromBigInt(tokenIdOut);

            if (amountOut === 0n) {
                const error = `Item ${i}: proof.amountOut must be greater than 0`;
                this.logger.error(error);
                throw new BadRequestException(error);
            }
            if (proofAsset !== commitment.asset) {
                const error = `Item ${i}: proof asset (${proofAsset}) does not match commitment asset (${commitment.asset})`;
                this.logger.error(error);
                throw new BadRequestException(error);
            }
            // All items must share the same recipient / feeRecipient (relayBatch enforces this too).
            if (
                routing.recipient.toLowerCase() !== refRecipient ||
                routing.feeRecipient.toLowerCase() !== refFeeRecipient
            ) {
                const error = `Item ${i}: inconsistent recipient/feeRecipient across batch`;
                this.logger.error(error);
                throw new BadRequestException(error);
            }
            if (routing.feeAmount > BigInt(commitment.maxRelayFee)) {
                const error = `Item ${i}: feeAmount (${routing.feeAmount}) exceeds maxRelayFee (${commitment.maxRelayFee})`;
                this.logger.error(error);
                throw new BadRequestException(error);
            }
            if (routing.feeAmount > amountOut) {
                const error = `Item ${i}: feeAmount (${routing.feeAmount}) exceeds proof amountOut (${amountOut})`;
                this.logger.error(error);
                throw new BadRequestException(error);
            }

            // Re-encode this item's routing into its own TransactParams.data, bound
            // to the relay contract processor. This is what relayBatch decodes.
            transactParams.push({
                processor,
                data: encodeWithdrawalFeeSplit(
                    routing.recipient,
                    routing.feeRecipient,
                    routing.feeAmount,
                    routing.nativeGas
                ),
            });
            proofs.push(item.proof);
            noteData.push(item.noteData);

            totalAmountSent += amountOut;
            totalFee += routing.feeAmount;
            totalNativeGas += routing.nativeGas;
        }

        if (totalFee !== BigInt(commitment.totalFee)) {
            const error = `Sum of item fees (${totalFee}) does not match committed totalFee (${commitment.totalFee})`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        // Aggregate fee bound (audit L-1): each item is already capped at
        // maxRelayFee, but assert the explicit whole-batch ceiling too so the
        // total can never exceed maxRelayFee * itemCount, not just per item.
        const aggregateFeeCap = BigInt(commitment.maxRelayFee) * BigInt(items.length);
        if (totalFee > aggregateFeeCap) {
            const error = `Aggregate fee (${totalFee}) exceeds the batch cap maxRelayFee * itemCount (${aggregateFeeCap})`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const totalAmountReceived = totalAmountSent - totalFee;

        // Verify the relayer's own signature over (data, asset, expiration,
        // totalAmountSent, totalAmountReceived). The last two are recomputed from
        // the proofs, so tampering with any item's amountOut breaks verification.
        const verified = await this.chainService.verifyRelayBatchWithdrawalCommitment(
            commitment,
            totalAmountSent,
            totalAmountReceived
        );
        if (!verified) {
            const error = "The provided batch fee commitment couldn't be verified";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const payload: EvmRelayBatchSDKPayload = { proofs, transactParams, noteData };
        const txHash = await this.chainService.simulateAndWriteRelayBatch(
            payload,
            totalNativeGas > 0n ? totalNativeGas : undefined
        );

        return { txHash };
    }

    async relaySwap(request: EvmRelaySwapRequest): Promise<EvmRelayResponse> {
        if (!this.configService.relaySwapsContractAddress()) {
            throw new BadRequestException(`Swaps not supported for chain ${this.configService.chainId()}`);
        }

        this.logger.info("EVM relaySwap (RelaySwaps contract).");

        const { proof, noteData } = request;
        const { parsedPubSignals: { amountOut, tokenIdOut } } = proof;

        if (amountOut === 0n) {
            throw new BadRequestException("Proof amountOut must be > 0");
        }

        const { signedSwapCommitment: c } = request;
        const proofAsset = getAddressFromBigInt(tokenIdOut);

        const commitmentValid = await this.chainService.verifyRelaySwapCommitment(c);
        if (!commitmentValid) {
            throw new BadRequestException("Swap fee commitment could not be verified");
        }

        if (c.asset !== proofAsset) {
            throw new BadRequestException("Swap commitment asset does not match proof asset");
        }

        if (amountOut !== BigInt(c.amountSent)) {
            throw new BadRequestException(
                `Proof amountOut (${amountOut}) does not match commitment amountSent (${c.amountSent})`
            );
        }

        if (amountOut < BigInt(c.feeAmount)) {
            throw new BadRequestException(
                `Proof amountOut (${amountOut}) is less than committed fee (${c.feeAmount})`
            );
        }

        const routing = decodeRelaySwapRouting(c.data);
        // RC-10: dustRescue rides inside the proof-bound routing itself now, not a
        // separate request field — see dust_rescue_routing.ts.
        const dustRescue = fromRoutingDustRescue(routing.dustRescue);

        if (routing.feeAmount > 0n && routing.feeRecipient === "0x0000000000000000000000000000000000000000") {
            throw new BadRequestException("feeRecipient must be set when feeAmount > 0");
        }

        // Mirror the quote-time selection (evm.quote.service.ts): when the commitment
        // carries nativeGas > 0 and the fee receiver isn't the signer, the quote path
        // routes the fee to the signer instead of the configured receiver so the ETH
        // msg.value it funded is offset in-kind. Re-derive the same expected value here
        // rather than always comparing against feeReceiverAddress(), or a legitimately
        // signer-routed commitment is rejected as a mismatch (F-242 follow-up).
        const expectedFeeRecipient = getAddress(resolveFeeReceiver(this.configService, routing.nativeGas));
        if (routing.feeAmount > 0n && getAddress(routing.feeRecipient) !== expectedFeeRecipient) {
            throw new BadRequestException(
                `feeRecipient (${routing.feeRecipient}) does not match relayer's fee address (${expectedFeeRecipient})`
            );
        }

        if (routing.dustRecipient === "0x0000000000000000000000000000000000000000") {
            throw new BadRequestException("dustRecipient must not be zero");
        }

        // RC-03 defense-in-depth: DustRescueForwardingService only ever bridges what
        // lands in this relayer's own signer wallet (see its class doc), so a
        // dustRecipient pointed elsewhere already forwards nothing — but silently
        // forwarding nothing on a request that explicitly opted into dustRescue is a
        // confusing way to fail. Reject it loudly instead, before the on-chain tx is
        // even broadcast, since it almost certainly means a stale or misconfigured
        // caller rather than an attack (an attacker gains nothing from a dustRecipient
        // this service never spends from).
        if (dustRescue) {
            const signerAddress = await this.chainService.signerAddress();
            if (getAddress(routing.dustRecipient) !== getAddress(signerAddress)) {
                throw new BadRequestException(
                    `dustRecipient (${routing.dustRecipient}) must equal the relayer's own signer address ` +
                        `(${signerAddress}) when dustRescue is requested.`
                );
            }

            // RC-10 defense-in-depth: mirror RelaySwaps.sol's own zero-recipient invariant
            // here so a stale commitment (signed by an older relayer version that didn't
            // enforce this at quote time) fails fast instead of registering a rescue job
            // for an ordinary same-chain swap-to-self.
            if (routing.recipient !== "0x0000000000000000000000000000000000000000") {
                throw new BadRequestException(
                    "dustRescue may only be requested when recipient is the zero address (reshield or cross-chain swap)."
                );
            }
        }

        // recipient == address(0) means no source-chain recipient (reshield or cross-chain
        // swap). Mirror RelaySwaps.sol invariants here so stale commitments (e.g. signed by
        // an older relayer version) fail fast instead of reverting at simulation.
        if (routing.recipient === "0x0000000000000000000000000000000000000000") {
            if (routing.nativeGas > 0n) {
                throw new BadRequestException("nativeGas must be 0 when recipient is the zero address");
            }
            if (routing.minOutputAmount > 0n) {
                throw new BadRequestException("minOutputAmount must be 0 when recipient is the zero address");
            }
        }

        // B2 defense-in-depth: re-cap the committed swapValue (the native LZ fee RelaySwaps
        // mints in-contract and forwards as msg.value) against the per-chain ceiling, and
        // make sure the bounded gas-swap approval cannot exceed the post-fee principal.
        // Mirrors the quoteSwap-time checks; guards a stale / over-signed commitment.
        if (routing.swapValue > 0n) {
            const maxSwapValue = this.configService.maxSwapValueWei();
            if (routing.swapValue > maxSwapValue) {
                throw new BadRequestException(
                    `swapValue (${routing.swapValue}) exceeds the maximum allowed (${maxSwapValue}).`
                );
            }
            if (routing.gasSwapMaxInput > amountOut - routing.feeAmount) {
                throw new BadRequestException(
                    `gasSwapMaxInput (${routing.gasSwapMaxInput}) exceeds the post-fee amount (${amountOut - routing.feeAmount}).`
                );
            }
        }

        // Defense-in-depth (audit L-4): re-check the committed fee against the asset's
        // on-chain maxRelayFee ceiling before dispatch, mirroring quoteSwap's ceiling and
        // the batch relay path's per-item maxRelayFee guard. The Entrypoint enforces this
        // too, so this is relayer-gas-waste defense — it rejects a stale/over-max commitment
        // here instead of paying gas to simulate/dispatch a call the contract would revert.
        // maxRelayFee === 0n means "uncapped" on the swap path (matches quoteSwap).
        const { maxRelayFee } = await this.contractService.getAssetConfig(proofAsset);
        if (maxRelayFee !== 0n && routing.feeAmount > maxRelayFee) {
            throw new BadRequestException(
                `feeAmount (${routing.feeAmount}) exceeds maxRelayFee (${maxRelayFee}).`
            );
        }

        // Yield share input: RelaySwaps must redeem the shares through the wrapper's zap before
        // the swap (executeUnwrapped). The zap is the one derived at boot from
        // RelaySwaps.approvedZapList() (never the request, never a hand-copied config field);
        // the contract re-checks it against its allowlist and the proof-bound share.
        const assetConfig = this.configService.asset(proofAsset);
        let zap: EvmAddress | undefined;
        if (assetConfig.quoter === RateProvider.UNDERLYING) {
            zap = this.yieldZapRegistry.zapForShare(this.configService.chainId(), proofAsset);
            if (!zap) {
                throw new BadRequestException(
                    `Asset ${assetConfig.ticker} is a yield share but no approved zap was derived for it ` +
                        `from RelaySwaps at boot — cannot swap it.`
                );
            }
        }

        const payload: EvmRelaySwapPayload = {
            proof,
            noteData,
            data: c.data,
            nativeGas: routing.nativeGas,
            zap,
            b2GasSwap: routing.swapValue > 0n,
        };

        const { txHash } = await this.contractService.sdkRelaySwap(payload);

        // The tx above already succeeded on-chain — nothing past this point can undo it,
        // so a failure anywhere in this block (pricing, forwarding, registration) must
        // never turn into an HTTP error: a caller reading a 500 here has no way to know
        // their withdrawal already went through, and might reasonably (but wrongly) retry
        // against an already-spent note. Caught once, at this level, rather than the
        // previous per-call catches, since every step here shares the same "degrade, don't
        // fail the response" handling. Logged at error level AND surfaced via
        // dustRescueWarning — logging alone isn't enough: this exact failure mode (native-
        // ETH dust pricing) went undetected in production until manually investigated (see
        // dust-rescue-service.md's version history, 2026-08-27); a warning only the caller
        // sees is a second, independent chance for someone to notice. See
        // dust_Collector_deploy_handoff.md for the manual-replay recipe if this fires.
        let dustRescueWarning: string | undefined;
        if (dustRescue) {
            try {
                const usdRate = await this.dustRescuePricing.priceForRescue(
                    dustRescue.destinationChainId,
                    dustRescue.tokenId,
                );
                // Synchronous, awaited before responding — see dust-rescue-forwarding.service.ts's
                // class doc for why this can't be a fire-and-forget background task on Cloud Run.
                const dust1ForwardTxHash = await this.dustRescueForwarding.forward(this.configService.chainId(), {
                    sourceTxHash: txHash,
                    proofAsset,
                    dustRecipient: routing.dustRecipient,
                    destinationChainId: dustRescue.destinationChainId,
                    tokenId: dustRescue.tokenId,
                    relayFeeAmount: routing.feeAmount,
                    feeRecipient: routing.feeRecipient,
                });
                await this.dustRescueOrchestrator.registerPending({
                    sourceTxHash: txHash,
                    fromChainId: this.configService.chainId(),
                    destinationChainId: dustRescue.destinationChainId,
                    tokenId: dustRescue.tokenId,
                    recipientIdentifier: dustRescue.recipientIdentifier,
                    usdRate,
                    dust1ForwardTxHash,
                    maxDustAmount: toHex(dustRescueCeiling(amountOut)),
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.error(
                    `Dust rescue pricing/registration failed for ${txHash} — relay-swap succeeded on-chain; ` +
                    `job needs manual replay: ${message}`,
                    // Opt-in alert marker (see logger/alert-transport.ts): pages the operators at severity
                    // "warn". Deliberately not `turbo` — this fault doesn't stop the relayer from operating.
                    // The transport redacts the message before it leaves the process.
                    { alert: true, dedupKey: `dustRescue.${this.configService.chainId()}` },
                );
                // The warning travels in a SUCCESS response, past the exception
                // filter: it must be the key-free form (a pricing RPC failure
                // carries the provider URL in its message).
                dustRescueWarning = clientSafeErrorMessage(err);
            }
        }

        return { txHash, ...(dustRescueWarning !== undefined ? { dustRescueWarning } : {}) };
    }

    /**
     * Recompute the proof context off-chain and reject mismatches before any
     * simulation. Mirrors PoolVault's check:
     * context == keccak256(abi.encode({processor, data}, noteData)) % SNARK_SCALAR_FIELD
     * where processor is the one the relayer will submit and data is the signed fee
     * commitment's payload — the exact values that go on-chain.
     */
    private validateProofContext(
        op: "transfer" | "withdrawal",
        processor: EvmAddress,
        encodedData: Bytes,
        request: { noteData: NoteData[]; proof: { parsedPubSignals: ParsedPubSignals } }
    ): void {
        const { noteData, proof } = request;

        // viem's bytes32 encoding rejects anything but exactly 32 bytes, in the
        // validator and in the submit path alike — turn that into a 400 here.
        // Note: noteData count is intentionally NOT checked against the output
        // count — PoolVault emits note discovery events independently of the
        // commitment count, so any length is valid as long as the context binds it.
        const badHint = noteData.findIndex((n) => n.hint.length !== 66);
        if (badHint !== -1) {
            const error = `noteData[${badHint}].hint must be exactly 32 bytes`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const expected = computeContext(processor, encodedData, noteData);
        const actual = BigInt(proof.parsedPubSignals.context);

        if (actual !== expected) {
            const error =
                `Proof context mismatch: expected ${expected} but proof binds ${actual}. ` +
                `The relayer computes context = keccak256(abi.encode({processor, data}, noteData)) % SNARK_SCALAR_FIELD ` +
                `with processor=${processor} (the ${op} processor, also returned by the quote endpoint unless an ` +
                `alternate processorAddress was requested), data set to the fee commitment payload from your signed ` +
                `quote, and the ${noteData.length} noteData entries from this request. Re-generate the proof binding these exact values.`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }
    }

    private async extractWithdrawalQuote(request: EvmRelayWithdrawalRequest): Promise<{
        data: FeeSplit;
        encodedData: Bytes;
    }> {
        const {
            signedFeeCommitment: c,
            proof: { parsedPubSignals: p },
        } = request;

        const proofAsset = getAddressFromBigInt(p.tokenIdOut);
        const proofAmountOut = p.amountOut;
        const { amountSent, feeAmount, asset, data: encodedData } = c;

        const commitmentVerification = await this.chainService.verifyRelayWithdrawalCommitment(c);
        if (!commitmentVerification) {
            const error = "The provided fee commitment couldn't be verified";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        if (asset !== proofAsset) {
            const error = "Fee commitment asset does not match proof asset";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        if (proofAmountOut !== BigInt(amountSent)) {
            const error = `Proof amountOut (${proofAmountOut}) does not match commitment amountSent (${amountSent})`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }
        if (proofAmountOut < BigInt(feeAmount)) {
            const error = `Proof amountOut (${proofAmountOut}) is less than committed fee (${feeAmount})`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const data = decodeFeeSplit(encodedData);
        return {
            encodedData,
            data,
        };
    }

    private async extractTransferQuote(request: EvmRelayTransferRequest): Promise<{
        data: FeeSplit;
        encodedData: Bytes;
    }> {
        if (request.signedFeeCommitment === undefined) {
            const error = "Fee Commitment is required for private transfer";
            this.logger.error(error);
            throw new BadRequestException(error);
        }
        const { signedFeeCommitment: c } = request;
        const { feeAmount, asset, data: encodedData } = c;

        const commitmentVerification = await this.chainService.verifyRelayTransferCommitment(c);
        if (!commitmentVerification) {
            const error = "The provided transfer fee commitment couldn't be verified";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const {
            proof: { parsedPubSignals: p },
        } = request;

        const proofAsset = getAddressFromBigInt(p.tokenIdOut);
        const proofAmountOut = p.amountOut;

        if (asset !== proofAsset) {
            const error = "Fee commitment asset does not match proof asset";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const data = decodeFeeSplit(encodedData);

        if (proofAmountOut === 0n || proofAmountOut !== feeAmount) {
            const error = "To relay private transfers, proof.pubSignals.amountOut should be set to the relayer's feeAmount, provided in the quote's FeeCommitment";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        return {
            encodedData,
            data,
        };
    }
}
