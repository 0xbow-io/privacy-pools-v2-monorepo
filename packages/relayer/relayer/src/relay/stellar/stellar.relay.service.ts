import { BadRequestException, Injectable, NotImplementedException, Scope } from "@nestjs/common";
import { ChainedRelayService } from "../relay.interface";
import { ChainType } from "../../config/enums";
import { FATLoggerService } from "../../logger/fat.logger.provider";
import { StellarChainService } from "../../chain.service/stellar.chain.service";
import { StellarConfigService } from "../../config/stellar/stellar-config.service";
import {
    zStellarRelayBatchRequest,
    zStellarRelayRegisterAndWithdrawalRequest,
    zStellarRelayTransferRequest,
    zStellarRelayWithdrawalRequest,
    zStellarRelayNotImplemented,
} from "./schemas";
import {
    StellarRelayBatchRequest,
    StellarRelayRegisterAndWithdrawalRequest,
    StellarRelaySendRequest,
    StellarRelaySendResponse,
    StellarRelayWithdrawalRequest,
    StellarRelayWithdrawalResponse,
} from "./types";

@Injectable({ scope: Scope.REQUEST })
export class StellarRelayService implements ChainedRelayService<ChainType.STELLAR> {
    withdrawalSchema = zStellarRelayWithdrawalRequest;
    transferSchema = zStellarRelayTransferRequest;
    batchSchema = zStellarRelayBatchRequest;
    registerAndWithdrawalSchema = zStellarRelayRegisterAndWithdrawalRequest;
    relayAndAnnounceSchema = zStellarRelayNotImplemented;

    constructor(
        private readonly logger: FATLoggerService,
        private readonly chainService: StellarChainService,
        private readonly configService: StellarConfigService
    ) {}

    async withdrawal(request: StellarRelayWithdrawalRequest): Promise<StellarRelayWithdrawalResponse> {
        this.logger.info("Stellar relay withdrawal.");

        const {
            proof,
            proof: { parsedPubSignals },
            noteData,
        } = request;
        const { amountOut, tokenIdOut } = parsedPubSignals;
        // Unlike EVM (asset == getAddressFromBigInt(tokenIdOut), a direct address decode), Stellar's
        // tokenIdOut is an opaque numeric encoding of the asset address (encode_token_id) that only
        // the relay contract itself can invert — the contract's own AssetMismatch check on-chain is
        // the enforcement point, mirroring how EVM's on-chain check is the backstop behind this
        // service's cross-check, not a replacement for a client-side one that isn't derivable here.

        if (amountOut === 0n) {
            const error = "proof.pubSignals.amountOut should be more than 0";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const { signedFeeCommitment: c } = request;

        const commitmentVerification = await this.chainService.verifyRelayWithdrawalCommitment(c);
        if (!commitmentVerification) {
            const error = "The provided fee commitment couldn't be verified";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        if (BigInt(c.amountSent) !== amountOut) {
            const error = `Proof amountOut (${amountOut}) does not match commitment amountSent (${c.amountSent})`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }
        if (amountOut < BigInt(c.feeAmount)) {
            const error = `Proof amountOut (${amountOut}) is less than committed fee (${c.feeAmount})`;
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const routing = this.chainService.decodeRouting(c.data);

        // A yield withdrawal: the share's router is the processor the proof committed to, so it must
        // be exactly the router configured for the committed asset — never an arbitrary contract.
        if (request.processorAddress !== undefined) {
            const router = this.configService.yieldRouterFor(c.asset);
            if (router === undefined || router !== request.processorAddress) {
                const error = `processorAddress ${request.processorAddress} is not the yield router configured for ${c.asset}`;
                this.logger.error(error);
                throw new BadRequestException(error);
            }
            const { txHash } = await this.chainService.submitYieldWithdrawal({
                router,
                n: request.inputNullifierNumber,
                m: request.outputCommitmentNumber,
                proof: { a: proof.a, b: proof.b, c: proof.c },
                stateRoot: parsedPubSignals.stateRoot,
                keystoreRoot: parsedPubSignals.keystoreRoot,
                aspRoot: parsedPubSignals.aspRoot,
                amountOut,
                tokenIdOut,
                nullifierHashes: parsedPubSignals.nullifierHashes,
                outputCommitments: parsedPubSignals.outputCommitments,
                noteData,
                routing,
                // 0 = no floor, as on EVM; a too-high floor just fails the simulation, costing nothing.
                minUnderlyingOut: request.minUnderlyingOut ?? 0n,
            });
            return { txHash };
        }

        const { txHash } = await this.chainService.submitRelay({
            n: request.inputNullifierNumber,
            m: request.outputCommitmentNumber,
            proof: { a: proof.a, b: proof.b, c: proof.c },
            stateRoot: parsedPubSignals.stateRoot,
            keystoreRoot: parsedPubSignals.keystoreRoot,
            aspRoot: parsedPubSignals.aspRoot,
            amountOut,
            tokenIdOut,
            nullifierHashes: parsedPubSignals.nullifierHashes,
            outputCommitments: parsedPubSignals.outputCommitments,
            asset: c.asset,
            noteData,
            routing,
        });

        return { txHash };
    }

    /**
     * Relays a cold-start withdrawal: `relay.register_and_relay` registers the owner in the keystore
     * and relays the withdrawal in one transaction, so a fresh account with no gas can exit. The
     * withdrawal is checked exactly as a plain one; the registration is the owner's signed auth
     * entry, checked against what it must authorize before anything is submitted.
     */
    async registerAndWithdrawal(request: StellarRelayRegisterAndWithdrawalRequest): Promise<StellarRelayWithdrawalResponse> {
        this.logger.info("Stellar relay register-and-withdrawal.");
        const { proof, noteData, signedFeeCommitment: c, registration } = request;
        const { amountOut, tokenIdOut } = proof.parsedPubSignals;
        const fail = (error: string): never => {
            this.logger.error(error);
            throw new BadRequestException(error);
        };

        if (amountOut === 0n) fail("proof.pubSignals.amountOut should be more than 0");
        if (!(await this.chainService.verifyRelayWithdrawalCommitment(c))) {
            fail("The provided fee commitment couldn't be verified");
        }
        if (BigInt(c.amountSent) !== amountOut) {
            fail(`Proof amountOut (${amountOut}) does not match commitment amountSent (${c.amountSent})`);
        }
        if (amountOut < BigInt(c.feeAmount)) {
            fail(`Proof amountOut (${amountOut}) is less than committed fee (${c.feeAmount})`);
        }
        const ownerAuth = await this.chainService.parseRegistrationEntry(registration);

        return this.chainService.submitRegisterAndRelay({
            n: request.inputNullifierNumber,
            m: request.outputCommitmentNumber,
            proof: { a: proof.a, b: proof.b, c: proof.c },
            stateRoot: proof.parsedPubSignals.stateRoot,
            keystoreRoot: proof.parsedPubSignals.keystoreRoot,
            aspRoot: proof.parsedPubSignals.aspRoot,
            amountOut,
            tokenIdOut,
            nullifierHashes: proof.parsedPubSignals.nullifierHashes,
            outputCommitments: proof.parsedPubSignals.outputCommitments,
            asset: c.asset,
            noteData,
            routing: this.chainService.decodeRouting(c.data),
            owner: registration.account,
            nullifyingKeyHash: BigInt(registration.nullifyingKeyHash),
            authDigest: BigInt(registration.authDigest),
            ownerAuth,
        });
    }

    async relayAndAnnounce(): Promise<never> {
        throw new NotImplementedException(
            "Stellar relay-and-announce is not supported: ERC-5564 stealth announcements have no Soroban counterpart"
        );
    }

    /**
     * Relays a private transfer: the pool's own `transact`, with this relayer as the gated
     * processor. The proof must release exactly the committed fee (`amountOut == feeAmount`) —
     * anything more would be paid out in the clear, a withdrawal wearing a transfer's name — for the
     * committed asset, and must commit to the committed `data` (the pool rejects any other context).
     */
    async transfer(request: StellarRelaySendRequest): Promise<StellarRelaySendResponse> {
        this.logger.info("Stellar relay transfer.");
        const { proof, noteData, signedFeeCommitment: c } = request;
        const { amountOut, tokenIdOut } = proof.parsedPubSignals;
        const fail = (error: string): never => {
            this.logger.error(error);
            throw new BadRequestException(error);
        };

        if (!(await this.chainService.verifyTransferCommitment(c))) {
            fail("The provided transfer fee commitment couldn't be verified");
        }
        if (c.feeAmount === 0n || amountOut !== c.feeAmount) {
            fail(`A relayed transfer must release exactly the committed fee (${c.feeAmount}), got amountOut ${amountOut}`);
        }
        if (tokenIdOut !== this.chainService.tokenIdOf(c.asset)) {
            fail(`Proof asset does not match commitment asset ${c.asset}`);
        }

        return this.chainService.submitTransfer({
            n: request.inputNullifierNumber,
            m: request.outputCommitmentNumber,
            proof: { a: proof.a, b: proof.b, c: proof.c },
            stateRoot: proof.parsedPubSignals.stateRoot,
            keystoreRoot: proof.parsedPubSignals.keystoreRoot,
            aspRoot: proof.parsedPubSignals.aspRoot,
            amountOut,
            tokenIdOut,
            nullifierHashes: proof.parsedPubSignals.nullifierHashes,
            outputCommitments: proof.parsedPubSignals.outputCommitments,
            asset: c.asset,
            noteData,
            routing: this.chainService.decodeRouting(c.data),
            processorData: c.data,
        });
    }

    /**
     * Relays a batch via the relay contract's `relay_batch`. The signed commitment carries one
     * routing per item; every item is checked against it here before anything is submitted — the
     * same per-item checks the contract makes, plus the asset binding the relay contract cannot see
     * in a `tokenIdOut` alone.
     */
    async batchWithdrawal(request: StellarRelayBatchRequest): Promise<StellarRelayWithdrawalResponse> {
        const { items, signedBatchFeeCommitment: commitment } = request;
        this.logger.info("Stellar relay batch withdrawal.", { itemCount: items.length });

        if (!(await this.chainService.verifyBatchCommitment(commitment))) {
            const error = "The provided batch fee commitment couldn't be verified";
            this.logger.error(error);
            throw new BadRequestException(error);
        }

        const routings = this.chainService.decodeRoutings(commitment.data);
        const fail = (error: string): never => {
            this.logger.error(error);
            throw new BadRequestException(error);
        };
        if (routings.length !== items.length) {
            fail(`Batch commitment encodes ${routings.length} routings but ${items.length} items were submitted`);
        }

        const assetTokenId = this.chainService.tokenIdOf(commitment.asset);
        let totalFee = 0n;
        const batch = items.map((item, i) => {
            const routing = routings[i];
            const { amountOut, tokenIdOut } = item.proof.parsedPubSignals;
            if (amountOut === 0n) fail(`Item ${i}: proof.amountOut must be greater than 0`);
            if (tokenIdOut !== assetTokenId) fail(`Item ${i}: proof asset does not match commitment asset ${commitment.asset}`);
            if (routing.recipient !== routings[0].recipient || routing.feeRecipient !== routings[0].feeRecipient) {
                fail(`Item ${i}: inconsistent recipient/feeRecipient across batch`);
            }
            if (commitment.maxRelayFee > 0n && routing.feeAmount > commitment.maxRelayFee) {
                fail(`Item ${i}: feeAmount (${routing.feeAmount}) exceeds maxRelayFee (${commitment.maxRelayFee})`);
            }
            if (routing.feeAmount > amountOut) {
                fail(`Item ${i}: feeAmount (${routing.feeAmount}) exceeds proof amountOut (${amountOut})`);
            }
            totalFee += routing.feeAmount;
            const { parsedPubSignals } = item.proof;
            return {
                n: item.inputNullifierNumber,
                m: item.outputCommitmentNumber,
                proof: { a: item.proof.a, b: item.proof.b, c: item.proof.c },
                stateRoot: parsedPubSignals.stateRoot,
                keystoreRoot: parsedPubSignals.keystoreRoot,
                aspRoot: parsedPubSignals.aspRoot,
                amountOut,
                tokenIdOut,
                nullifierHashes: parsedPubSignals.nullifierHashes,
                outputCommitments: parsedPubSignals.outputCommitments,
                noteData: item.noteData,
                routing,
            };
        });

        if (totalFee !== commitment.totalFee) {
            fail(`Sum of item fees (${totalFee}) does not match committed totalFee (${commitment.totalFee})`);
        }

        return this.chainService.submitRelayBatch(commitment.asset, batch);
    }
}
