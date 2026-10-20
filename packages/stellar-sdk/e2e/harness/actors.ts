import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { Account, Asset, BASE_FEE, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import type { SignatureDerivation } from "@privacy-pools-v2/e2e-suite";

import type { Hex, ProtocolKeys, PublicKey, Secret, StellarAddress } from "../../src/internal.js";
import { StellarCryptoService } from "../../src/internal.js";
import type { E2EContext } from "./context.js";
import { fundViaFriendbot } from "../network.js";

/**
 * Stellar's standard base reserve (0.5 XLM/subentry) — a fresh account with no subentries needs
 * exactly 2x this to exist at all. Funding a "not funded" actor with precisely this amount (via
 * `Operation.createAccount`, not friendbot's large fixed grant) makes it exist on-chain — so a
 * read-only simulation (`prepareDeposit`) succeeds — while leaving no room to actually pay for a
 * deposit + network fee on top of the reserve it can't spend below, matching what
 * `suites/deposit.ts`'s "cannot pay for it" rung expects. Unlike EVM, a Stellar account cannot
 * exist with a balance of exactly zero, so "unfunded" means "reserve-only", not "empty."
 *
 * `Operation.createAccount`'s `startingBalance` is decimal XLM, not stroops (unlike every other
 * amount in this SDK) — "1", not "10000000".
 */
const RESERVE_ONLY_BALANCE = "1"; // 1 XLM = 10_000_000 stroops

/** A test participant: a fresh Stellar keypair plus fresh protocol keys. Nothing is registered on-chain. */
export interface Actor {
    name: string;
    keypair: Keypair;
    address: StellarAddress;
    keys: ProtocolKeys;
    /** Set only for `signed` actors. Revocable-key rotation and index discovery re-derive keys
     * from this signature, so they only work for such actors. */
    signature?: Hex;
    /** Ready-made argument for `rotateRevocableKey` / `discoverRevocableKeyIndex` (signature-derived actors only). */
    derivation?: SignatureDerivation;
}

export interface CreateActorOptions {
    /** Give the actor funds via friendbot. Defaults to `true`; pass `false` for an unfunded account. */
    funded?: boolean;
    /** Derive protocol keys from a wallet signature (needed for key rotation / index discovery). */
    signed?: boolean;
}

/**
 * Deterministic-shape (but random-valued) test-only key derivation — mirrors
 * `packages/stellar-sdk/scripts/e2e-stellar/stellar-e2e.test.ts`'s `deriveTestKeys`. Stellar's
 * viewing key is X25519 (same curve as EVM) — see `StellarPublicKeySchema`'s doc comment.
 */
export function deriveTestKeys(): ProtocolKeys {
    const randomSecret = (): Secret => ("0x" + bytesToHex(randomBytes(32))) as Secret;
    const viewingPrivateKey = randomSecret();
    const bytes = hexToBytes(viewingPrivateKey.slice(2));
    const pubBytes = x25519.getPublicKey(bytes);
    return {
        privateNullifyingKey: randomSecret(),
        privateRevocableKey: randomSecret(),
        viewingPrivateKey,
        viewingPublicKey: ("0x" + bytesToHex(pubBytes)) as PublicKey,
        revocableKeyIndex: "0x0" as Hex,
    };
}

/**
 * Domain separator for signature-derived e2e actors — Stellar's counterpart to EVM harness's
 * `DERIVATION_MESSAGE`/`APP_IDENTIFIER`. `StellarSignatureSchema` only checks length (64 raw
 * bytes) and `StellarCryptoService.deriveRootSecret` has no signer-binding check (see
 * `StellarDeriveFromSignatureConfig`'s own doc), so unlike EVM's EIP-712 message this string's
 * content is arbitrary — any ed25519 signature by the account is a valid root secret.
 */
const APP_IDENTIFIER = "privacy-pools-v2-e2e";

/** Protocol keys for `signature`/`appIdentifier` at a given revocable-key rotation index. */
export function keysAtIndex(signature: Hex, appIdentifier: string, revocableKeyIndex: Hex): ProtocolKeys {
    const derived = new StellarCryptoService().deriveKeysFromSignature({
        signature,
        appIdentifier,
        revocableKeyIndex,
    });
    return { ...derived, revocableKeyIndex };
}

/** Creates an actor with random keys; independent of every other actor and every other file. */
export async function createActor(
    ctx: E2EContext,
    name: string,
    options: CreateActorOptions = {},
): Promise<Actor> {
    return options.signed ? createSignedActor(ctx, name, options) : createUnsignedActor(ctx, name, options);
}

async function createUnsignedActor(
    ctx: E2EContext,
    name: string,
    options: CreateActorOptions,
): Promise<Actor> {
    const keypair = Keypair.random();
    const actor: Actor = {
        name,
        keypair,
        address: keypair.publicKey() as StellarAddress,
        keys: deriveTestKeys(),
    };
    await fundActor(ctx, actor.address, options);
    return actor;
}

/**
 * An actor whose protocol keys are derived from a wallet signature, like a real integrator's — the
 * only kind for which revocable-key rotation and index discovery work (they re-derive from the
 * signature). Any 64-byte ed25519 signature by the account is a valid root secret.
 */
async function createSignedActor(
    ctx: E2EContext,
    name: string,
    options: CreateActorOptions,
): Promise<Actor> {
    const keypair = Keypair.random();
    const address = keypair.publicKey() as StellarAddress;
    const signature = ("0x" + bytesToHex(keypair.sign(Buffer.from(APP_IDENTIFIER, "utf8")))) as Hex;
    const actor: Actor = {
        name,
        keypair,
        address,
        signature,
        derivation: { signature, appIdentifier: APP_IDENTIFIER },
        keys: keysAtIndex(signature, APP_IDENTIFIER, "0x0" as Hex),
    };
    await fundActor(ctx, actor.address, options);
    return actor;
}

async function fundActor(ctx: E2EContext, address: string, options: CreateActorOptions): Promise<void> {
    if (options.funded ?? true) {
        await fundViaFriendbot(address);
    } else {
        await createReserveOnlyAccount(ctx, address);
    }
}

/**
 * This worker process's own transaction source for the harness's setup transactions. A Stellar
 * transaction claims its source account's next sequence number, so sourcing them from the deploy
 * admin — which the mock ASP, in the globalSetup process, also signs root updates with — lets the two
 * processes reject each other's transactions (txBadSeq). The admin still signs the operations only it
 * can authorize (minting its classic assets), which uses none of its sequence. Within the process,
 * {@link withPayer} runs one transaction at a time.
 */
let payer: Promise<Keypair> | undefined;
let payerQueue: Promise<unknown> = Promise.resolve();

function workerPayer(): Promise<Keypair> {
    payer ??= (async () => {
        const keypair = Keypair.random();
        await fundViaFriendbot(keypair.publicKey());
        return keypair;
    })();
    return payer;
}

/** Builds (`build` adds the operations), signs with the payer plus `signers`, submits and confirms one payer-sourced transaction. */
function withPayer(
    ctx: E2EContext,
    build: (builder: TransactionBuilder) => TransactionBuilder,
    signers: Keypair[],
): Promise<void> {
    const run = payerQueue.then(async () => {
        const source = await workerPayer();
        const accountInfo = await ctx.rpcInteractor.getAccount(source.publicKey());
        const tx = build(
            new TransactionBuilder(new Account(accountInfo.publicKey, accountInfo.sequence), {
                fee: BASE_FEE,
                networkPassphrase: ctx.network.networkPassphrase,
            }),
        )
            .setTimeout(30)
            .build();
        tx.sign(source, ...signers);
        const hash = await ctx.rpcInteractor.submitTransaction(tx.toXDR());
        await ctx.rpcInteractor.waitForTransactionReceipt(hash);
    });
    payerQueue = run.catch(() => undefined);
    return run;
}

/** Brings `address` into existence with only the minimum reserve — see {@link RESERVE_ONLY_BALANCE}. */
async function createReserveOnlyAccount(ctx: E2EContext, address: string): Promise<void> {
    await withPayer(
        ctx,
        (builder) =>
            builder.addOperation(Operation.createAccount({ destination: address, startingBalance: RESERVE_ONLY_BALANCE })),
        [],
    );
}

/**
 * Classic Stellar assets are always exactly 7 decimal places (protocol-fixed) — same scale as
 * XLM's stroops. `Operation.payment`/`changeTrust` take a decimal string, not the raw integer
 * amount every Soroban contract call in this SDK otherwise uses, so mint's `bigint` (in the same
 * raw base units `balanceOf`'s SAC `balance()` read returns) needs converting.
 */
function rawToDecimalString(raw: bigint): string {
    const whole = raw / 10_000_000n;
    const frac = raw % 10_000_000n;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(7, "0").replace(/0+$/, "")}`;
}

/**
 * Mints `amount` of the local "MOCK" classic asset (issued by the deploy admin, see
 * `configure-assets.mts`'s `LOCAL_MOCK_TOKEN`) to `to`. Establishing the recipient's trustline —
 * unlike an ERC-20 `mint`, a classic/SAC asset can only be held by a Stellar account that has
 * itself authorized holding it — and the issuer's payment are two operations in one transaction,
 * fee-paid and sequenced by this worker's payer (see {@link workerPayer}), each carrying its own
 * `source` so the issuer's and `toKeypair`'s signatures are required and sufficient.
 */
export async function mintMockToken(
    ctx: E2EContext,
    toKeypair: Keypair,
    amount: bigint,
): Promise<void> {
    const admin = Keypair.fromSecret(ctx.network.adminSecret);
    await mintClassicAsset(ctx, `MOCK:${admin.publicKey()}`, toKeypair, amount);
}

/**
 * Opens `toKeypair`'s trustline to the admin-issued classic asset `CODE:ISSUER` and pays it `amount`
 * (the issuer paying its own asset mints it). Both signatures are needed: the trustline is the
 * holder's to open. With `amount` 0 only the trustline is opened — Stellar refuses a zero payment —
 * which is what a recipient needs to be able to RECEIVE the asset.
 */
export async function mintClassicAsset(
    ctx: E2EContext,
    classicAsset: string,
    toKeypair: Keypair,
    amount: bigint,
): Promise<void> {
    const admin = Keypair.fromSecret(ctx.network.adminSecret);
    const [code, issuer] = classicAsset.split(":") as [string, string];
    if (issuer !== admin.publicKey()) {
        throw new Error(`mintClassicAsset(): ${classicAsset} is not issued by the e2e admin ${admin.publicKey()}`);
    }
    const asset = new Asset(code, issuer);
    await withPayer(
        ctx,
        (builder) => {
            builder.addOperation(Operation.changeTrust({ asset, source: toKeypair.publicKey() }));
            if (amount > 0n) {
                builder.addOperation(
                    Operation.payment({
                        destination: toKeypair.publicKey(),
                        asset,
                        amount: rawToDecimalString(amount),
                        source: admin.publicKey(),
                    }),
                );
            }
            return builder;
        },
        // An unneeded signature fails the whole transaction (txBadAuthExtra): no payment, no admin.
        amount > 0n ? [admin, toKeypair] : [toKeypair],
    );
}
