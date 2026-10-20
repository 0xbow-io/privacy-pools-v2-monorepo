import { randomBytes } from "@noble/ciphers/utils.js";
import {
    Account,
    Asset,
    BASE_FEE,
    Contract,
    hash,
    Keypair,
    Operation,
    scValToNative,
    StrKey,
    Transaction,
    TransactionBuilder,
    xdr,
} from "@stellar/stellar-sdk";
import type {
    AssetInfo,
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
import { AspAdminClient } from "@privacy-pools-v2/mock-asp";

import type {
    Hex,
    IASPDataProvider,
    StellarAddress,
    StellarPoolSession,
    WithdrawalRelayerQuote,
    WithdrawalRelayParams,
} from "../../src/internal.js";
import {
    addressScVal,
    bufferToHex,
    STELLAR_EMPTY_ADDRESS,
    HTTPClient,
    HttpASPDataProvider,
    StellarPayoutRoutingCodec,
} from "../../src/internal.js";
import type { Actor } from "../harness/actors.js";
import { createActor, keysAtIndex, mintClassicAsset, mintMockToken } from "../harness/actors.js";
import { balanceOf, captureFromBlock, FEE_CEILING, settleFinality } from "../harness/chain.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext } from "../harness/context.js";
import { relayedSession, relayerClient, selfSubmitSession } from "../harness/sessions.js";
import { fundViaFriendbot } from "../network.js";

/** Stroops as the decimal XLM string classic operations take. */
function stroopsToXlm(stroops: bigint): string {
    const whole = stroops / 10_000_000n;
    const frac = (stroops % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole.toString();
}

/** A well-formed but never-configured contract id, for negative-path tests. */
function unlistedContractId(): string {
    return StrKey.encodeContract(Buffer.from(randomBytes(32)));
}

/**
 * The Stellar chain driver for `@privacy-pools-v2/e2e-suite`. A thin adapter over the e2e harness
 * (actors / sessions / chain helpers) and the infrastructure `globalSetup` started once (local
 * Soroban network + deployed contracts, a real spawned relayer, a real mock ASP). Actors are the
 * harness's `Actor` (they carry the Stellar `Keypair`); the suite treats them as opaque and this
 * driver casts them back. Patterned directly on `packages/evm-sdk/e2e/driver/EvmDriver.ts`.
 */
export class StellarDriver implements ChainE2EDriver {
    readonly chainName = "stellar";
    readonly emptyAddress: string = STELLAR_EMPTY_ADDRESS;
    /** A reserve-only account: 2 × 0.5 XLM base reserve, which it can never spend (no fee headroom). */
    readonly drainedNativeBalance = 10_000_000n;
    /** Keypairs of the actors this driver created — `drainNative(address)` has to sign as them. */
    private readonly keypairs = new Map<string, Keypair>();
    // 1 unit = 1 XLM (the yield underlying); the share is 18dp (7 + the wrapper's 11-digit offset).
    private readonly yieldAssets: { native?: E2EYieldAsset; token?: E2EYieldAsset };
    // 1 unit = 0.1 XLM, so the suite's "20 units" is 2 XLM (matches the retired ad-hoc test's AMOUNT_A).
    readonly assets: { native: AssetInfo };
    // 1 unit = 0.1 MOCK — same scale as native (classic assets are always 7-decimal, matching XLM).
    readonly tokenAsset: AssetInfo;
    readonly feeCeiling = FEE_CEILING;
    readonly asp: AspAdminClient;
    readonly sessions: SessionFactory;
    readonly relayContract: string;
    readonly poolAddress: string;
    readonly relayerUrl: string;
    readonly revertReasons = {
        // pool.ragequit requires `owner.require_auth()` — a non-owner submission fails Soroban's
        // own transaction-level authorization check (surfaces as `submitTransaction`'s
        // StellarTransactionSendFailed, never reaching the contract's Result<_, Error> surface at
        // all), confirmed live against a real local "wrong owner" run: "Transaction send failed:
        // txBadAuth".
        ragequitNotOwner: /txBadAuth/,
    };
    readonly tamper = {
        // Aim the prepared transaction at the ASP registry — a contract the SDK has no business
        // calling for a deposit/ragequit/keystore operation. Rebuilds the InvokeHostFunction
        // operation with the same function/args against a different contract id, preserving the
        // original source account and sequence number so the transaction otherwise still parses.
        retarget: (preparedTx: unknown): string => {
            const tx = TransactionBuilder.fromXDR(preparedTx as string, this.ctx.network.networkPassphrase);
            if (!(tx instanceof Transaction) || tx.operations.length !== 1) {
                throw new Error("expected exactly one operation in the prepared transaction");
            }
            const [operation] = tx.operations;
            if (operation.type !== "invokeHostFunction") {
                throw new Error(`expected an InvokeHostFunction operation, got "${operation.type}"`);
            }
            const invoke = operation.func.invokeContract();
            const functionName = invoke.functionName().toString();
            const account = new Account(tx.source, (BigInt(tx.sequence) - 1n).toString());
            const retargeted = new TransactionBuilder(account, {
                fee: tx.fee,
                networkPassphrase: this.ctx.network.networkPassphrase,
            })
                .addOperation(new Contract(this.ctx.network.aspRegistryId).call(functionName, ...invoke.args()))
                .setTimeout(30)
                .build();
            return retargeted.toXDR();
        },
    };

    constructor(private readonly ctx: E2EContext) {
        this.asp = new AspAdminClient(ctx.aspUrl);
        this.relayContract = ctx.network.relayId;
        this.poolAddress = ctx.network.poolId;
        this.relayerUrl = ctx.relayer.url;
        this.assets = {
            native: {
                id: ctx.network.nativeAssetAddress,
                symbol: "XLM",
                unit: 1_000_000n,
                // Matches scripts/config/assets.json's local-deploy minDepositAmount — kept far
                // below every suite's hardcoded unit count (smallest is batchWithdraw's 6 units)
                // instead of a production-realistic value, mirroring EVM's e2e config's own
                // effectively-trivial minDeposit.
                minDeposit: 100_000n,
                // Above minDeposit (so the deposit itself succeeds) but below relayer.ts's
                // FLAT_FEE_AMOUNT (so a relayed withdrawal of just this amount is infeasible) —
                // see batchWithdraw.ts's "refuse a batch whose notes cannot cover the relayer's fee".
                dust: 150_000n,
            },
        };
        this.tokenAsset = {
            id: ctx.network.mockTokenAddress,
            symbol: "MOCK",
            unit: 1_000_000n,
            minDeposit: 100_000n,
            dust: 150_000n,
        };
        const native = ctx.network.yields.find((y) => !y.classicAsset);
        const token = ctx.network.yields.find((y) => y.classicAsset);
        this.yieldAssets = {
            native: native && this.yieldAsset(native),
            token: token && this.yieldAsset(token),
        };
        this.sessions = {
            selfSubmit: (actor) => selfSubmitSession(ctx, actor as Actor),
            selfSubmitWithUnreachableRpc: (actor) =>
                selfSubmitSession({ ...ctx, network: { ...ctx.network, rpcUrl: "http://127.0.0.1:1" } }, actor as Actor),
        };
    }

    /** Builds the driver from the handle `globalSetup` provided; call from `beforeAll`. */
    static fromInjected(): StellarDriver {
        return new StellarDriver(e2eContext());
    }

    relayedSession(actor: E2EActor, options?: RelayedSessionOptions): Promise<ConformanceSession> {
        return relayedSession(this.ctx, actor as Actor, options);
    }

    async createActor(name: string, options: { funded?: boolean; signed?: boolean } = {}): Promise<Actor> {
        const actor = await createActor(this.ctx, name, options);
        this.keypairs.set(actor.address, actor.keypair);
        return actor;
    }

    /**
     * Mints `amount` of the "MOCK" classic asset to `to` (default: `actor`). Unlike an ERC-20
     * `mint`, holding a classic/SAC asset requires the RECIPIENT's own signature (to establish
     * its trustline) — this driver only has a signing `Keypair` for actors it created itself, so
     * `to` must name one of those (the shared suites never mint to anyone else today).
     */
    mint(actor: E2EActor, asset: AssetInfo, amount: bigint, to?: string): Promise<void> {
        const recipient = actor as Actor;
        if (to !== undefined && to !== recipient.address) {
            throw new Error(
                `mint(): recipient "${to}" is not the acting actor "${recipient.address}" — Stellar` +
                    " minting needs the recipient's own signature to establish a trustline, and this" +
                    " driver only holds keypairs for actors it created itself.",
            );
        }
        if (asset.id !== this.tokenAsset.id) {
            throw new Error(`mint(): unsupported asset "${asset.id}" — only tokenAsset ("MOCK") can be minted.`);
        }
        return mintMockToken(this.ctx, recipient.keypair, amount);
    }

    keysAtIndex(actor: E2EActor, revocableKeyIndex: Hex): ProtocolKeys {
        const signed = actor as Actor;
        if (!signed.signature || !signed.derivation) {
            throw new Error(`actor ${actor.name} is not signature-derived (create it with { signed: true })`);
        }
        return keysAtIndex(signed.signature, signed.derivation.appIdentifier ?? "", revocableKeyIndex);
    }

    aspProvider(options: { scope?: "own" | "other" } = {}): IASPDataProvider {
        return new HttpASPDataProvider({
            aspUrl: this.ctx.aspUrl,
            chainId: 1,
            entrypointAddress: options.scope === "other" ? unlistedContractId() : this.ctx.network.poolId,
            httpClient: new HTTPClient({ retryAttempts: 0, timeout: 3000 }),
        });
    }

    unlistedAssetId(): string {
        return unlistedContractId();
    }

    async fund(address: string): Promise<void> {
        await fundViaFriendbot(address);
    }

    /**
     * The shared suites' only call site (`withdraw.ts`'s gasless-registration setup) sits behind
     * the `registerAndWithdraw` capability, which `chain.ts` lists as unsupported on Stellar, so
     * this is never actually reached. Left as a loud failure rather than a silent no-op: Stellar
     * has no `anvil_setBalance`-style cheat code, and an account cannot go below its minimum
     * reserve while it exists, so sweeping for real would need that account's own signature — a
     * real implementation belongs here if `registerAndWithdraw` is ever picked up for Stellar.
     */
    /**
     * Pays everything above the base reserve (and the one fee this payment costs) back to the deploy
     * admin, leaving {@link drainedNativeBalance}: the account still exists — a Stellar account
     * cannot go below its reserve — but can no longer pay for a transaction of its own.
     */
    async drainNative(address: string): Promise<void> {
        const keypair = this.keypairs.get(address);
        if (!keypair) throw new Error(`drainNative(${address}): not an actor this driver created`);
        const balance = await this.balanceOf(address, this.assets.native);
        const fee = BigInt(BASE_FEE);
        const spendable = balance - this.drainedNativeBalance - fee;
        if (spendable <= 0n) return;
        const info = await this.ctx.rpcInteractor.getAccount(address);
        const tx = new TransactionBuilder(new Account(info.publicKey, info.sequence), {
            fee: BASE_FEE,
            networkPassphrase: this.ctx.network.networkPassphrase,
        })
            .addOperation(
                Operation.payment({
                    destination: Keypair.fromSecret(this.ctx.network.adminSecret).publicKey(),
                    asset: Asset.native(),
                    amount: stroopsToXlm(spendable),
                }),
            )
            .setTimeout(30)
            .build();
        tx.sign(keypair);
        await this.ctx.rpcInteractor.waitForTransactionReceipt(await this.ctx.rpcInteractor.submitTransaction(tx.toXDR()));
    }

    /**
     * Whether the prepared relayed registration's `signature` — the SIGNED Soroban auth entry — is
     * `actor`'s ed25519 signature over the entry's own authorization preimage (network id, nonce,
     * expiry ledger and invocation), as the host verifies it.
     */
    async verifyRelayedRegistration(prepared: unknown, actor: E2EActor): Promise<boolean> {
        const { signature } = prepared as { signature: Hex | null };
        if (!signature) return false;
        const entry = xdr.SorobanAuthorizationEntry.fromXDR(Buffer.from(signature.slice(2), "hex"));
        const credentials = entry.credentials().address();
        const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
            new xdr.HashIdPreimageSorobanAuthorization({
                networkId: hash(Buffer.from(this.ctx.network.networkPassphrase)),
                nonce: credentials.nonce(),
                signatureExpirationLedger: credentials.signatureExpirationLedger(),
                invocation: entry.rootInvocation(),
            }),
        );
        const [sig] = scValToNative(credentials.signature()) as { public_key: Buffer; signature: Buffer }[];
        if (!sig) return false;
        const signer = Keypair.fromPublicKey(actor.address);
        return (
            Buffer.from(sig.public_key).equals(signer.rawPublicKey()) &&
            signer.verify(hash(preimage.toXDR()), Buffer.from(sig.signature))
        );
    }

    balanceOf(address: string, asset: AssetInfo): Promise<bigint> {
        return balanceOf(this.ctx, address, asset.id);
    }

    /** The yield module over native XLM; `chain.ts` opts out of `yieldNative` when there is none. */
    get nativeYield(): E2EYieldAsset {
        if (!this.yieldAssets.native) throw new Error("no yield module over native XLM on this network");
        return this.yieldAssets.native;
    }

    /** The yield module over a classic asset; `chain.ts` opts out of `yieldToken` when there is none. */
    get tokenYield(): E2EYieldAsset {
        if (!this.yieldAssets.token) throw new Error("no yield module over a classic asset on this network");
        return this.yieldAssets.token;
    }

    sessionWithoutYield(actor: E2EActor): Promise<ConformanceSession> {
        return selfSubmitSession(this.ctx, actor as Actor, { withYield: false });
    }

    async withdrawalQuote(
        params: { asset: AssetInfo; recipient: string; amount: bigint },
        options: RelayedSessionOptions = {},
    ): Promise<SelectedQuote> {
        const { interactor, info } = relayerClient(this.ctx, { url: options.relayerUrl, httpClient: options.httpClient });
        const quote = await interactor.getWithdrawalQuote(info, {
            asset: params.asset.id as StellarAddress,
            commit: true,
            recipient: params.recipient as StellarAddress,
            extraGas: false,
            amount: params.amount.toString(),
        });
        return { relayerInfo: info, quote };
    }

    rerouteFeeCommitment(data: Hex, recipient: string): Hex {
        const codec = new StellarPayoutRoutingCodec();
        return codec.encode({ ...codec.decode(data), recipient: recipient as StellarAddress });
    }

    /** A `bumpSequence` to a lower value: a real, successful no-op transaction that touches no contract. */
    async sendUnrelatedTransaction(actor: E2EActor): Promise<Hex> {
        const { keypair } = actor as Actor;
        const accountInfo = await this.ctx.rpcInteractor.getAccount(keypair.publicKey());
        const tx = new TransactionBuilder(new Account(accountInfo.publicKey, accountInfo.sequence), {
            fee: BASE_FEE,
            networkPassphrase: this.ctx.network.networkPassphrase,
        })
            .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
            .setTimeout(30)
            .build();
        tx.sign(keypair);
        const hash = await this.ctx.rpcInteractor.submitTransaction(tx.toXDR());
        await this.ctx.rpcInteractor.waitForTransactionReceipt(hash);
        return hash;
    }

    currentBlock(): Promise<Hex> {
        return captureFromBlock(this.ctx);
    }

    settleFinality(): Promise<void> {
        return settleFinality(this.ctx);
    }

    async publishedAspRoot(): Promise<bigint> {
        const adminAddress = Keypair.fromSecret(this.ctx.network.adminSecret).publicKey();
        const root = await this.ctx.rpcInteractor.simulateRead(
            this.ctx.network.aspRegistryId,
            "latest_asp_root",
            [],
            adminAddress,
        );
        return root as bigint;
    }

    async registeredViewingKey(address: string): Promise<Hex> {
        try {
            const key = await this.ctx.rpcInteractor.simulateRead(
                this.ctx.network.keystoreId,
                "get_viewing_key",
                [addressScVal(address)],
                address,
            );
            return bufferToHex(key);
        } catch (error) {
            // The keystore contract's get_viewing_key errors with Error::NotRegistered (code 10)
            // for an address with no viewing key set — unlike a Solidity mapping's zero default.
            // Mirror EVM's zero-bytes32 read for the same "unset" case.
            if (/Error\(Contract,\s*#10\)/.test(error instanceof Error ? error.message : String(error))) {
                return `0x${"00".repeat(32)}` as Hex;
            }
            throw error;
        }
    }

    async submitPreparedTx(actor: E2EActor, preparedTx: unknown): Promise<void> {
        const signed = actor as Actor;
        const tx = TransactionBuilder.fromXDR(preparedTx as string, this.ctx.network.networkPassphrase);
        tx.sign(signed.keypair);
        // Wait for the result: the driver contract is "rejects if the chain reverts it", and a
        // submitted-but-failed Soroban transaction is only visible once it lands.
        const hash = await this.ctx.rpcInteractor.submitTransaction(tx.toXDR());
        await this.ctx.rpcInteractor.waitForTransactionReceipt(hash);
    }

    /** One yield module as the shared suite drives it. */
    private yieldAsset(y: E2EContext["network"]["yields"][number]): E2EYieldAsset {
        const ctx = this.ctx;
        const classicAsset = y.classicAsset;
        // The router, not the relay contract, processes a share's withdrawal.
        const routerRelayer = () => {
            const { interactor, info } = relayerClient(ctx);
            return { interactor, info: { ...info, processorAddress: y.router } };
        };
        return {
            share: { id: y.shareToken, symbol: `pp${y.underlyingSymbol}`, unit: 10n ** BigInt(y.shareDecimals), minDeposit: 1n, dust: 1n },
            underlying: { id: y.underlying, symbol: y.underlyingSymbol, unit: 10_000_000n, minDeposit: 1n, dust: 1n },
            yieldOf(session: ConformanceSession): E2EYieldSessions {
                const found = (session as unknown as StellarPoolSession).yieldFor(y.shareToken);
                if (!found) throw new Error(`session was built without the pp${y.underlyingSymbol} yield deployment`);
                return found;
            },
            fundUnderlying: async (actor: E2EActor, amount: bigint): Promise<void> => {
                if (classicAsset) {
                    // A classic asset needs the holder's own trustline before it can be paid (or
                    // receive a withdrawal): opened here, with a mint of `amount` when non-zero.
                    await mintClassicAsset(ctx, classicAsset, (actor as Actor).keypair, amount);
                    return;
                }
                // Native XLM: friendbot tops the account up far beyond any budget.
                await fundViaFriendbot(actor.address);
                const held = await balanceOf(ctx, actor.address, y.underlying);
                if (held < amount) throw new Error(`${actor.name} holds ${held} XLM, needs ${amount}`);
            },
            async withdrawalQuote(params: { recipient: string; amount: bigint }): Promise<WithdrawalRelayerQuote<string>> {
                const { interactor, info } = routerRelayer();
                return interactor.getWithdrawalQuote(info, {
                    asset: y.shareToken,
                    commit: true,
                    recipient: params.recipient,
                    extraGas: false,
                    amount: params.amount.toString(),
                });
            },
            async relayWithdrawal(params: WithdrawalRelayParams<string>): Promise<void> {
                const { interactor, info } = routerRelayer();
                const hash = await interactor.relayWithdrawal(info, params);
                await ctx.rpcInteractor.waitForTransactionReceipt(hash);
            },
            // A classic asset cannot be sent to an account without a trustline to it. Native XLM has
            // no such recipient: a SAC transfer of at least the base reserve to an address with no
            // account CREATES the account (measured on the local network), so it always lands.
            ...(classicAsset
                ? { unreceivableRecipient: async () => (await this.createActor(`no-trustline-${y.underlyingSymbol}`)).address }
                : {}),
        };
    }
}
