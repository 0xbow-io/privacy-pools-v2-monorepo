import { BadRequestException, Inject, Injectable, Scope, ServiceUnavailableException } from "@nestjs/common";
import { Address, Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
    KeypairWalletInteractor,
    SorobanRPCInteractor,
    StellarAddressFieldConverter,
    StellarPayoutRoutingCodec,
    addressScVal,
    boolScVal,
    bytesScVal,
    groth16ProofScVal,
    i128ScVal,
    noteDataScVal,
    structScVal,
    u128ScVal,
    u256ScVal,
    u32ScVal,
    vecScVal,
} from "@privacy-pools-v2/stellar-sdk";
import type { NoteData, StellarAddress } from "@privacy-pools-v2/stellar-sdk";
import { StellarConfigService } from "../config/stellar/stellar-config.service";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import type { ChainContext } from "../core/chain-context.token";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { stellarErrorMessage } from "@privacy-pools-v2/stellar-sdk";
// The commitment shapes are zod-derived in quote/stellar/types.ts (the wire source of truth,
// same as EVM's quote/evm/types.ts) — imported here as types only, not redeclared, so the
// service that signs/verifies them and the schema that validates them never drift apart.
import type {
    StellarBatchFeeCommitment,
    StellarSignedBatchFeeCommitment,
    StellarSignedTransferFeeCommitment,
    StellarSignedWithdrawalFeeCommitment,
    StellarTransferFeeCommitment,
    StellarWithdrawalFeeCommitment,
} from "../quote/stellar/types";

export type Hex = `0x${string}`;

export interface StellarAssetConfig {
    enabled: boolean;
    minDepositAmount: bigint;
    vettingFeeBps: number;
    maxRelayFee: bigint;
}

export interface SubmitRelayParams {
    n: number;
    m: number;
    // Only the Groth16 curve points are needed on-chain — groth16ProofScVal only reads
    // a/b/c, never pubSignals (those are passed as separate individually-typed call args).
    proof: { a: Hex; b: Hex; c: Hex };
    stateRoot: bigint;
    keystoreRoot: bigint;
    aspRoot: bigint;
    amountOut: bigint;
    tokenIdOut: bigint;
    nullifierHashes: bigint[];
    outputCommitments: bigint[];
    asset: StellarAddress;
    noteData: NoteData[];
    routing: { recipient: StellarAddress; feeRecipient: StellarAddress; feeAmount: bigint };
}

/** A relayed yield withdrawal: the same transact, routed through the share's `yield-router`. */
export type SubmitYieldWithdrawalParams = Omit<SubmitRelayParams, "asset"> & {
    router: StellarAddress;
    /** The recipient's slippage floor, in the underlying. */
    minUnderlyingOut: bigint;
};

/** One item of a `relay_batch`: a transact whose routing is the batch commitment's routing[i]. */
export type SubmitRelayBatchItem = Omit<SubmitRelayParams, "asset">;

const routingCodec = new StellarPayoutRoutingCodec();
const fieldConverter = new StellarAddressFieldConverter();

function u64LEBytes(value: bigint): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    return buf;
}

function u128LEBytes(value: bigint): Buffer {
    const buf = Buffer.alloc(16);
    let remaining = value;
    for (let i = 0; i < 16; i++) {
        buf[i] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    return buf;
}

// Serializes build → submit → confirmation per network + signer within this process. A Stellar
// transaction carries the source account's next sequence number, read from ledger state, which only
// advances once a ledger applies it: two relays built before the first one lands would claim the
// same number, and the second would be rejected (txBAD_SEQ). Only in-process, like EVM's
// `withSignerLock`: separate instances sharing a signer key can still collide.
const stellarSignerLocks = new Map<string, Promise<void>>();

export async function withStellarSignerLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = stellarSignerLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    stellarSignerLocks.set(key, tail);
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (stellarSignerLocks.get(key) === tail) stellarSignerLocks.delete(key);
    }
}

/** How often a relay waits on its own transaction before releasing the signer lock (ledgers: ~5 s public, ~1 s local). */
const RELAY_CONFIRMATION_POLL_MS = 500;

@Injectable({ scope: Scope.REQUEST })
export class StellarChainService {
    private readonly chainId: number;

    constructor(
        @Inject(CHAIN_CONTEXT) context: ChainContext,
        private readonly config: StellarConfigService,
        private readonly logger: FATLoggerService
    ) {
        this.chainId = context.chainId;
    }

    private rpcInteractor(): SorobanRPCInteractor {
        return new SorobanRPCInteractor({
            rpcUrl: this.config.rpcUrl(),
            networkPassphrase: this.config.networkPassphrase(),
            receiptPollIntervalMs: RELAY_CONFIRMATION_POLL_MS,
        });
    }

    /**
     * Runs `submit` (which builds, signs and submits one transaction from `keypair`) under the
     * signer lock, and holds the lock until that transaction is on-chain so the next one is built
     * from the advanced sequence number. The outcome is not this method's to judge: a FAILED or
     * unconfirmed transaction still returns its hash, as before, and the caller's receipt wait
     * reports it.
     */
    private async submitSerialized(
        keypair: Keypair,
        rpc: SorobanRPCInteractor,
        submit: () => Promise<Hex>
    ): Promise<{ txHash: Hex }> {
        const key = `${this.config.networkPassphrase()}:${keypair.publicKey()}`;
        return withStellarSignerLock(key, async () => {
            const txHash = await submit();
            try {
                await rpc.waitForTransactionReceipt(txHash);
            } catch (error) {
                this.logger.warn(`Stellar relay ${txHash} not confirmed before releasing the signer: ${stellarErrorMessage(error)}`);
            }
            return { txHash };
        });
    }

    private keypair(): Keypair {
        return Keypair.fromSecret(this.config.signerSecretKey());
    }

    /**
     * Reads the pool's per-asset config, including `max_relay_fee` — enforced on-chain by the
     * relay contract itself (`relay()` rejects `fee_amount > max_relay_fee`), so the relayer must
     * cap its own quotes against it too or every over-cap quote would fail at relay time.
     */
    async getAssetConfig(asset: StellarAddress): Promise<StellarAssetConfig> {
        const rpc = this.rpcInteractor();
        let result: unknown;
        try {
            result = await rpc.simulateRead(
                this.config.poolContractId(),
                "get_asset_config",
                [addressScVal(asset)],
                this.keypair().publicKey()
            );
        } catch (error) {
            throw new ServiceUnavailableException(stellarErrorMessage(error));
        }

        const config = result as {
            enabled: boolean;
            min_deposit_amount: bigint;
            vetting_fee_bps: number;
            max_relay_fee: bigint;
        };
        if (typeof config?.enabled !== "boolean") {
            throw new ServiceUnavailableException("Expected an AssetConfig struct from get_asset_config");
        }
        return {
            enabled: config.enabled,
            minDepositAmount: config.min_deposit_amount,
            vettingFeeBps: config.vetting_fee_bps,
            maxRelayFee: config.max_relay_fee,
        };
    }

    /**
     * Shares of a yield `shareToken` worth `underlying` at its current rate (`preview_withdraw`,
     * rounded up) — how a flat stroop fee is expressed on a share-denominated withdrawal.
     */
    async sharesForUnderlying(shareToken: StellarAddress, underlying: bigint): Promise<bigint> {
        let result: unknown;
        try {
            result = await this.rpcInteractor().simulateRead(
                shareToken,
                "preview_withdraw",
                [i128ScVal(underlying)],
                this.keypair().publicKey()
            );
        } catch (error) {
            throw new ServiceUnavailableException(stellarErrorMessage(error));
        }
        if (typeof result !== "bigint") {
            throw new ServiceUnavailableException("Expected an integer from preview_withdraw");
        }
        return result;
    }

    /**
     * Submits a relayed yield withdrawal via the router's `withdraw_to_underlying(...)`. The router is
     * the transact processor (the proof's context commits to it) and takes the `PayoutRouting` itself,
     * paying the fee leg to the fee recipient in the underlying. It requires no relayer auth.
     */
    async submitYieldWithdrawal(params: SubmitYieldWithdrawalParams): Promise<{ txHash: Hex }> {
        const args = [
            u32ScVal(params.n),
            u32ScVal(params.m),
            groth16ProofScVal(params.proof as Parameters<typeof groth16ProofScVal>[0]),
            u256ScVal(params.stateRoot),
            u256ScVal(params.keystoreRoot),
            u256ScVal(params.aspRoot),
            u128ScVal(params.amountOut),
            u256ScVal(params.tokenIdOut),
            vecScVal(params.nullifierHashes.map((h) => u256ScVal(h))),
            vecScVal(params.outputCommitments.map((c) => u256ScVal(c))),
            vecScVal(params.noteData.map((nd) => noteDataScVal(nd))),
            structScVal({
                recipient: addressScVal(params.routing.recipient),
                fee_recipient: addressScVal(params.routing.feeRecipient),
                fee_amount: u128ScVal(params.routing.feeAmount),
            }),
            i128ScVal(params.minUnderlyingOut),
        ];
        return this.buildAndSend(params.router, "withdraw_to_underlying", args, "yield withdrawal");
    }

    /** Submits a relayed withdrawal via the `relay` contract's `relay(...)` entrypoint. */
    async submitRelay(params: SubmitRelayParams): Promise<{ txHash: Hex }> {
        const relayerPublicKey = this.keypair().publicKey();

        const args = [
            addressScVal(relayerPublicKey),
            u32ScVal(params.n),
            u32ScVal(params.m),
            // groth16ProofScVal's parameter type includes pubSignals (StellarProof's full shape)
            // but only reads a/b/c; SubmitRelayParams.proof deliberately omits it (see above).
            groth16ProofScVal(params.proof as Parameters<typeof groth16ProofScVal>[0]),
            u256ScVal(params.stateRoot),
            u256ScVal(params.keystoreRoot),
            u256ScVal(params.aspRoot),
            u128ScVal(params.amountOut),
            u256ScVal(params.tokenIdOut),
            vecScVal(params.nullifierHashes.map((h) => u256ScVal(h))),
            vecScVal(params.outputCommitments.map((c) => u256ScVal(c))),
            addressScVal(params.asset),
            vecScVal(params.noteData.map((nd) => noteDataScVal(nd))),
            // Field names must exactly match the Rust `PayoutRouting` struct
            // (recipient/fee_recipient/fee_amount) — structScVal sorts by field name
            // internally, so insertion order here doesn't matter, only the names do.
            structScVal({
                recipient: addressScVal(params.routing.recipient),
                fee_recipient: addressScVal(params.routing.feeRecipient),
                fee_amount: u128ScVal(params.routing.feeAmount),
            }),
        ];

        return this.buildAndSend(this.config.relayContractId(), "relay", args, "relay");
    }

    /** Simulates, signs with the relayer key and submits one contract call; the relayer pays the fee. */
    private async buildAndSend(
        contractId: StellarAddress,
        method: string,
        args: Parameters<SorobanRPCInteractor["buildTransaction"]>[2],
        what: string
    ): Promise<{ txHash: Hex }> {
        const keypair = this.keypair();
        const rpc = this.rpcInteractor();
        try {
            return await this.submitSerialized(keypair, rpc, async () => {
                const unsignedXdr = await rpc.buildTransaction(contractId, method, args, keypair.publicKey());
                const walletInteractor = new KeypairWalletInteractor({
                    keypair,
                    networkPassphrase: this.config.networkPassphrase(),
                    rpcInteractor: rpc,
                });
                return (await walletInteractor.sendTransaction(unsignedXdr)) as Hex;
            });
        } catch (error) {
            this.logger.error(`Stellar ${what} submission failed: ${stellarErrorMessage(error)}`);
            throw new ServiceUnavailableException(stellarErrorMessage(error));
        }
    }

    /** The transact circuit's `tokenIdOut` for `asset` — how the SDK and the pool encode it. */
    tokenIdOf(asset: StellarAddress): bigint {
        return BigInt(fieldConverter.toTokenIdField(asset));
    }

    /**
     * Submits a relayed batch via the relay contract's `relay_batch(relayer, asset, items)`: every
     * item is a full `BatchItem` struct and the contract pays each leg once, in aggregate.
     */
    async submitRelayBatch(asset: StellarAddress, items: SubmitRelayBatchItem[]): Promise<{ txHash: Hex }> {
        const batchItems = items.map((item) =>
            structScVal({
                n: u32ScVal(item.n),
                m: u32ScVal(item.m),
                proof: groth16ProofScVal(item.proof as Parameters<typeof groth16ProofScVal>[0]),
                state_root: u256ScVal(item.stateRoot),
                keystore_root: u256ScVal(item.keystoreRoot),
                asp_root: u256ScVal(item.aspRoot),
                amount_out: u128ScVal(item.amountOut),
                token_id_out: u256ScVal(item.tokenIdOut),
                nullifier_hashes: vecScVal(item.nullifierHashes.map((h) => u256ScVal(h))),
                output_commitments: vecScVal(item.outputCommitments.map((c) => u256ScVal(c))),
                note_data: vecScVal(item.noteData.map((nd) => noteDataScVal(nd))),
                routing: structScVal({
                    recipient: addressScVal(item.routing.recipient),
                    fee_recipient: addressScVal(item.routing.feeRecipient),
                    fee_amount: u128ScVal(item.routing.feeAmount),
                }),
            })
        );
        const args = [addressScVal(this.keypair().publicKey()), addressScVal(asset), vecScVal(batchItems)];
        return this.buildAndSend(this.config.relayContractId(), "relay_batch", args, "relay batch");
    }

    /**
     * Submits a relayed private transfer as the pool's own `transact`, with the relayer's account as
     * the gated processor — the account the proof's context names, and the one `transact` pays
     * `amount_out` (exactly the fee) to. Mirrors EVM, where the relayer calls `PoolVault.transact`
     * with itself as processor; the relay contract is not involved.
     */
    async submitTransfer(params: SubmitRelayParams & { processorData: Hex }): Promise<{ txHash: Hex }> {
        const args = [
            addressScVal(this.keypair().publicKey()),
            // processor_gated: the processor (this relayer) authorizes the call.
            boolScVal(true),
            u32ScVal(params.n),
            u32ScVal(params.m),
            groth16ProofScVal(params.proof as Parameters<typeof groth16ProofScVal>[0]),
            u256ScVal(params.stateRoot),
            u256ScVal(params.keystoreRoot),
            u256ScVal(params.aspRoot),
            u128ScVal(params.amountOut),
            u256ScVal(params.tokenIdOut),
            vecScVal(params.nullifierHashes.map((h) => u256ScVal(h))),
            vecScVal(params.outputCommitments.map((c) => u256ScVal(c))),
            addressScVal(params.asset),
            vecScVal(params.noteData.map((nd) => noteDataScVal(nd))),
            bytesScVal(params.processorData),
        ];
        return this.buildAndSend(this.config.poolContractId(), "transact", args, "transfer");
    }

    async signTransferCommitment(commitment: StellarTransferFeeCommitment): Promise<Hex> {
        const signature = this.keypair().sign(this.transferCommitmentBytes(commitment));
        return `0x${signature.toString("hex")}` as Hex;
    }

    async verifyTransferCommitment(commitment: StellarSignedTransferFeeCommitment): Promise<boolean> {
        if (Date.now() > commitment.expiration) {
            throw new BadRequestException("Transfer fee commitment has expired");
        }
        try {
            const signature = Buffer.from(commitment.signedRelayerCommitment.slice(2), "hex");
            return this.keypair().verify(this.transferCommitmentBytes(commitment), signature);
        } catch (error) {
            this.logger.error(`Stellar transfer commitment verification failed: ${stellarErrorMessage(error)}`);
            return false;
        }
    }

    /**
     * Parses and checks an owner's signed registration entry against what it must authorize: this
     * relayer's keystore's `set_auth_policy(account, nullifyingKeyHash, authDigest)`, signed by
     * `account`, not yet expired. Anything else would at best fail on chain after the relayer paid
     * for it, or authorize something the owner never asked for.
     */
    async parseRegistrationEntry(registration: {
        account: StellarAddress;
        nullifyingKeyHash: Hex;
        authDigest: Hex;
        signature: Hex;
    }): Promise<xdr.SorobanAuthorizationEntry> {
        let entry: xdr.SorobanAuthorizationEntry;
        try {
            entry = xdr.SorobanAuthorizationEntry.fromXDR(Buffer.from(registration.signature.slice(2), "hex"));
        } catch {
            throw new BadRequestException("registration.signature is not a Soroban authorization entry");
        }
        const credentials = entry.credentials();
        if (credentials.switch().name !== "sorobanCredentialsAddress") {
            throw new BadRequestException("registration entry must carry address credentials");
        }
        const signer = Address.fromScAddress(credentials.address().address()).toString();
        if (signer !== registration.account) {
            throw new BadRequestException("registration entry is not signed by registration.account");
        }
        const fn = entry.rootInvocation().function();
        if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") {
            throw new BadRequestException("registration entry must authorize a contract call");
        }
        const call = fn.contractFn();
        const target = Address.fromScAddress(call.contractAddress()).toString();
        const [account, nullifyingKeyHash, authDigest, ...rest] = call.args().map((a) => scValToNative(a) as unknown);
        if (
            target !== this.config.keystoreContractId() ||
            call.functionName().toString() !== "set_auth_policy" ||
            rest.length !== 0 ||
            account !== registration.account ||
            nullifyingKeyHash !== BigInt(registration.nullifyingKeyHash) ||
            authDigest !== BigInt(registration.authDigest)
        ) {
            throw new BadRequestException(
                "registration entry must authorize exactly this keystore's set_auth_policy(account, nullifyingKeyHash, authDigest)"
            );
        }
        const latest = Number(BigInt(await this.rpcInteractor().getLatestLedger()));
        if (credentials.address().signatureExpirationLedger() <= latest) {
            throw new BadRequestException("registration entry has expired");
        }
        return entry;
    }

    /**
     * Submits `relay.register_and_relay`: the owner's keystore registration, then the withdrawal, in
     * one invocation. The owner's signed entry is attached to the operation and the call simulated
     * in ENFORCING mode, so a bad signature fails before this relayer pays anything.
     */
    async submitRegisterAndRelay(
        params: SubmitRelayParams & {
            owner: StellarAddress;
            nullifyingKeyHash: bigint;
            authDigest: bigint;
            ownerAuth: xdr.SorobanAuthorizationEntry;
        }
    ): Promise<{ txHash: Hex }> {
        const keypair = this.keypair();
        const args = [
            addressScVal(keypair.publicKey()),
            addressScVal(params.owner),
            u256ScVal(params.nullifyingKeyHash),
            u256ScVal(params.authDigest),
            u32ScVal(params.n),
            u32ScVal(params.m),
            groth16ProofScVal(params.proof as Parameters<typeof groth16ProofScVal>[0]),
            u256ScVal(params.stateRoot),
            u256ScVal(params.keystoreRoot),
            u256ScVal(params.aspRoot),
            u128ScVal(params.amountOut),
            u256ScVal(params.tokenIdOut),
            vecScVal(params.nullifierHashes.map((h) => u256ScVal(h))),
            vecScVal(params.outputCommitments.map((c) => u256ScVal(c))),
            addressScVal(params.asset),
            vecScVal(params.noteData.map((nd) => noteDataScVal(nd))),
            structScVal({
                recipient: addressScVal(params.routing.recipient),
                fee_recipient: addressScVal(params.routing.feeRecipient),
                fee_amount: u128ScVal(params.routing.feeAmount),
            }),
        ];
        const rpc = this.rpcInteractor();
        try {
            return await this.submitSerialized(keypair, rpc, async () => {
                const unsignedXdr = await rpc.buildTransactionWithAuth(
                    this.config.relayContractId(),
                    "register_and_relay",
                    args,
                    keypair.publicKey(),
                    [params.ownerAuth]
                );
                const walletInteractor = new KeypairWalletInteractor({
                    keypair,
                    networkPassphrase: this.config.networkPassphrase(),
                    rpcInteractor: rpc,
                });
                return (await walletInteractor.sendTransaction(unsignedXdr)) as Hex;
            });
        } catch (error) {
            this.logger.error(`Stellar register-and-relay submission failed: ${stellarErrorMessage(error)}`);
            throw new ServiceUnavailableException(stellarErrorMessage(error));
        }
    }

    async signBatchCommitment(commitment: StellarBatchFeeCommitment): Promise<Hex> {
        const signature = this.keypair().sign(this.batchCommitmentBytes(commitment));
        return `0x${signature.toString("hex")}` as Hex;
    }

    async verifyBatchCommitment(commitment: StellarSignedBatchFeeCommitment): Promise<boolean> {
        if (Date.now() > commitment.expiration) {
            throw new BadRequestException("Batch fee commitment has expired");
        }
        try {
            const signature = Buffer.from(commitment.signedRelayerCommitment.slice(2), "hex");
            return this.keypair().verify(this.batchCommitmentBytes(commitment), signature);
        } catch (error) {
            this.logger.error(`Stellar batch commitment verification failed: ${stellarErrorMessage(error)}`);
            return false;
        }
    }

    encodeRoutings(routings: { recipient: StellarAddress; feeRecipient: StellarAddress; feeAmount: bigint }[]): Hex {
        return routingCodec.encodeArray(routings.map((r) => ({ ...r, nativeGas: 0n }))) as Hex;
    }

    decodeRoutings(data: Hex): { recipient: StellarAddress; feeRecipient: StellarAddress; feeAmount: bigint }[] {
        return routingCodec.decodeArray(data).map(({ recipient, feeRecipient, feeAmount }) => ({
            recipient,
            feeRecipient,
            feeAmount,
        }));
    }

    /** The transfer analogue of {@link commitmentBytes}, under its own domain tag. */
    private transferCommitmentBytes(commitment: StellarTransferFeeCommitment): Buffer {
        return Buffer.concat([
            Buffer.from("ppv2-stellar-transfer-v1", "ascii"),
            Buffer.from(commitment.data.slice(2), "hex"),
            Buffer.from(commitment.asset, "ascii"),
            u64LEBytes(BigInt(commitment.expiration)),
            u128LEBytes(commitment.feeAmount),
            Buffer.from(this.config.poolContractId(), "ascii"),
            Buffer.from(this.config.networkPassphrase(), "utf-8"),
        ]);
    }

    /**
     * The batch analogue of {@link commitmentBytes}: a distinct leading tag so a batch signature can
     * never verify as a single-withdrawal one (or vice versa), then the routings, the asset, the
     * expiry, the whole fee model and the same relay-deployment/network domain.
     */
    private batchCommitmentBytes(commitment: StellarBatchFeeCommitment): Buffer {
        return Buffer.concat([
            Buffer.from("ppv2-stellar-batch-v1", "ascii"),
            Buffer.from(commitment.data.slice(2), "hex"),
            Buffer.from(commitment.asset, "ascii"),
            u64LEBytes(BigInt(commitment.expiration)),
            u128LEBytes(commitment.totalFee),
            u128LEBytes(commitment.maxRelayFee),
            u128LEBytes(commitment.relayCost),
            u128LEBytes(commitment.feeBps),
            u128LEBytes(commitment.flatFee),
            Buffer.from(this.config.relayContractId(), "ascii"),
            Buffer.from(this.config.networkPassphrase(), "utf-8"),
        ]);
    }

    /**
     * Canonical fixed-width byte encoding this service signs/verifies over — Stellar's analogue
     * of EVM's EIP-712 typed-data commitment, without EIP-712 itself (no such standard exists on
     * Stellar; `@stellar/stellar-sdk`'s `Keypair` only exposes raw ed25519 sign/verify over
     * bytes). Layout: the 128-byte PayoutRouting encoding (reused from StellarPayoutRoutingCodec,
     * not reimplemented) ‖ asset StrKey ‖ expiration (u64 LE) ‖ amountSent (u128 LE) ‖
     * amountReceived (u128 LE) ‖ relay_contract StrKey ‖ network_passphrase — the last two fields
     * are the domain-separation analogue of EIP-712's verifyingContract+chainId, binding a
     * commitment to one relay deployment/network so it can't replay across others sharing a
     * signer key.
     */
    private commitmentBytes(commitment: StellarWithdrawalFeeCommitment): Buffer {
        return Buffer.concat([
            Buffer.from(commitment.data.slice(2), "hex"),
            Buffer.from(commitment.asset, "ascii"),
            u64LEBytes(BigInt(commitment.expiration)),
            u128LEBytes(commitment.amountSent),
            u128LEBytes(commitment.amountReceived),
            Buffer.from(this.config.relayContractId(), "ascii"),
            Buffer.from(this.config.networkPassphrase(), "utf-8"),
        ]);
    }

    async signRelayWithdrawalCommitment(commitment: StellarWithdrawalFeeCommitment): Promise<Hex> {
        const signature = this.keypair().sign(this.commitmentBytes(commitment));
        return `0x${signature.toString("hex")}` as Hex;
    }

    async verifyRelayWithdrawalCommitment(commitment: StellarSignedWithdrawalFeeCommitment): Promise<boolean> {
        if (Date.now() > commitment.expiration) {
            throw new BadRequestException("Fee commitment has expired");
        }

        try {
            const bytes = this.commitmentBytes(commitment);
            const signature = Buffer.from(commitment.signedRelayerCommitment.slice(2), "hex");
            return this.keypair().verify(bytes, signature);
        } catch (error) {
            this.logger.error(`Stellar commitment verification failed: ${stellarErrorMessage(error)}`);
            return false;
        }
    }

    /** Reuse of the off-chain PayoutRouting byte codec — the on-chain relay() call encodes the
     * same struct differently (as ScVal args, see submitRelay), so don't conflate the two. */
    encodeRouting(recipient: StellarAddress, feeRecipient: StellarAddress, feeAmount: bigint): Hex {
        return routingCodec.encode({ recipient, feeRecipient, feeAmount, nativeGas: 0n }) as Hex;
    }

    decodeRouting(data: Hex): { recipient: StellarAddress; feeRecipient: StellarAddress; feeAmount: bigint } {
        const decoded = routingCodec.decode(data);
        return { recipient: decoded.recipient, feeRecipient: decoded.feeRecipient, feeAmount: decoded.feeAmount };
    }
}
