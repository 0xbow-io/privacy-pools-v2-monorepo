import type {
    Hex,
    IASPDataProvider,
    IHTTPClient,
    IPoolSession,
    IPoolSessionYieldDeposit,
    IPoolSessionYieldWithdraw,
    IYieldRouterInteractor,
    IYieldTokenInteractor,
    PublicKey,
    Secret,
    WithdrawalRelayerQuote,
    WithdrawalRelayParams,
} from "@privacy-pools-v2/core-sdk";
import type { AspAdminClient } from "@privacy-pools-v2/mock-asp";

/**
 * The session type the suites drive. It is the chain-agnostic {@link IPoolSession} facade; the
 * prepared-transaction, proof, log, and signature-derivation-config types are chain-specific and
 * deliberately erased here — suites pass prepared transactions (or a {@link SignatureDerivation})
 * straight back to the session (or through {@link ChainE2EDriver.tamper}).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConformanceSession = IPoolSession<any, string, any, any, any>;

/**
 * Pre-derived key material a session is built from. Structurally identical to the `ProtocolKeys` each
 * chain SDK declares for its own builder (core-sdk does not export one), so a value of this type is
 * accepted by every chain's builder.
 */
export interface ProtocolKeys {
    privateNullifyingKey: Secret;
    privateRevocableKey: Secret;
    /** Rotation index of `privateRevocableKey`; `"0x0"` for a fresh account. */
    revocableKeyIndex: Hex;
    viewingPrivateKey: Secret;
    viewingPublicKey: PublicKey;
}

/**
 * The signature-derivation inputs the session's rotation / discovery APIs take. Every chain
 * shares `signature`; the rest is chain-specific (EVM: `signerAddress`/`addressHash`; Stellar:
 * `appIdentifier`, no signer-binding field — see `StellarDeriveFromSignatureConfig`'s own doc for
 * why) — `ConformanceSession`'s `TDeriveConfig` is `any`, so each driver's `createActor({signed:
 * true})` only needs to populate the fields ITS chain's `deriveKeysFromSignature` actually reads.
 */
export interface SignatureDerivation {
    signature: Hex;
    /** EVM only — the signer's address, used as the HKDF salt. */
    signerAddress?: Hex;
    /** EVM only — `keccak256(signerAddress)`; the SDK verifies it to catch payloads built for another signer. */
    addressHash?: Hex;
    /** Stellar only — domain separator for the app/deployment (HKDF salt for the shared appSecret stage). */
    appIdentifier?: string;
}

/**
 * A test participant. The wallet/signer is opaque: the chain's driver stores whatever it needs on its
 * own subtype and reads it back (via a cast) when it builds sessions or moves funds.
 */
export interface E2EActor {
    readonly name: string;
    readonly address: string;
    readonly keys: ProtocolKeys;
    /** Set only for `signed` actors. */
    readonly derivation?: SignatureDerivation;
}

export interface CreateActorOptions {
    /** Give the actor gas money. Defaults to `true`; `false` makes an unfunded (0 balance) account. */
    funded?: boolean;
    /** Derive protocol keys from a wallet signature (needed for key rotation / index discovery). */
    signed?: boolean;
}

/** An asset the suites move. Amounts are expressed in multiples of `unit`. */
export interface AssetInfo {
    /** The `tokenId` the session takes. */
    id: string;
    symbol: string;
    /** One "suite unit" in base units (e.g. 0.001 ETH on EVM, 0.1 XLM on Stellar). */
    unit: bigint;
    /** The Entrypoint's minimum deposit for this asset, in base units. */
    minDeposit: bigint;
    /** A deposit the chain accepts whose value is far below any relayer fee (a "dust" note). */
    dust: bigint;
}

/** What `relayWithdraw` / `registerAndWithdraw` take as `selectedQuote` (the relayer's committed quote). */
export type SelectedQuote = Parameters<ConformanceSession["relayWithdraw"]>[0]["selectedQuote"];

export interface RelayedSessionOptions {
    /** Point the session's relayer at another URL, e.g. a fault-injecting proxy. */
    relayerUrl?: string;
    /** Replace the HTTP client (fast timeouts, no retries) used for the relayer and the ASP. */
    httpClient?: IHTTPClient;
}

export interface SessionFactory {
    /** A session that submits its own transactions (no relayer). */
    selfSubmit(actor: E2EActor): Promise<ConformanceSession>;
    /** A self-submit session whose chain RPC is unreachable — for "the environment misbehaves" rungs. */
    selfSubmitWithUnreachableRpc(actor: E2EActor): Promise<ConformanceSession>;
}

/**
 * What a chain SDK supplies. Everything chain-specific the suites need lives behind this interface:
 * funding, key/wallet handling, session construction, chain reads, and the few cheat codes.
 *
 * The infrastructure (node, deployed contracts, relayer, mock ASP) is started ONCE by the chain's
 * `globalSetup`; the driver is built per test file from the serializable handle that setup provided.
 *
 * This is the part every chain must implement. Members that only some capabilities need are in
 * {@link CapabilityMembers}.
 */
export interface ChainE2EDriver {
    readonly chainName: string;
    /** The chain's native asset (deposited, withdrawn and used to pay gas). */
    readonly assets: { native: AssetInfo };
    /**
     * Generous upper bound on one transaction's fee in native base units. Self-submitted spends pay it
     * from the account being asserted on, so exact-balance checks would be flaky.
     */
    readonly feeCeiling: bigint;
    /** Admin client for the mock ASP the sessions are pointed at (approve / revoke / faults). */
    readonly asp: AspAdminClient;
    readonly sessions: SessionFactory;
    /** The relay/batch contract a self-submitted batch withdrawal is sent through. */
    readonly relayContract: string;
    /** The account that holds shielded funds (the pool vault) — its balance moves by exactly a deposit. */
    readonly poolAddress: string;
    /** Patterns the chain's refusals surface as, for rungs that pin the reason rather than just "it failed". */
    readonly revertReasons: {
        /** A ragequit submitted by an account other than the note's owner. */
        ragequitNotOwner: RegExp;
    };
    readonly tamper: {
        /**
         * The same prepared transaction aimed at a different contract. The SDK must refuse to sign or
         * submit it (`UnexpectedTransactionTarget`).
         */
        retarget(preparedTx: unknown): unknown;
    };

    /**
     * A real `HttpASPDataProvider` pointed at the mock ASP, scoped the way the chain's sessions scope it
     * (chain id + entrypoint). `scope: "other"` builds one scoped to a different entrypoint, which the ASP
     * must refuse.
     */
    aspProvider(options?: { scope?: "own" | "other" }): IASPDataProvider;
    /** An asset id that is well-formed but that the Entrypoint has not enabled. */
    unlistedAssetId(): string;
    /** A fresh actor with fresh keys; independent of every other actor and every other file. */
    createActor(name: string, options?: CreateActorOptions): Promise<E2EActor>;
    /** Gives `address` gas money (idempotent top-up). */
    fund(address: string): Promise<void>;
    /** Sets `address`'s native balance to 0 — makes a funded account gasless. */
    drainNative(address: string): Promise<void>;
    balanceOf(address: string, asset: AssetInfo): Promise<bigint>;

    /** The current head, as the `fromBlock` for a file's `discoverNotes()` calls. */
    currentBlock(): Promise<Hex>;
    /**
     * Mines / waits past the finality boundary. Note discovery only writes a terminal status (SPENT /
     * EXITED) for a log at or below the node's finalized block.
     */
    settleFinality(): Promise<void>;
    /** The association-set root the chain's ASP registry currently holds (0n when none). */
    publishedAspRoot(): Promise<bigint>;
    /** The viewing key `address` has published on the keystore ("0x" / zero when none). */
    registeredViewingKey(address: string): Promise<Hex>;
    /**
     * Sends a prepared transaction from `actor`'s wallet, bypassing the SDK — for "someone else submits
     * it" rungs. Rejects if the chain reverts it.
     */
    submitPreparedTx(actor: E2EActor, preparedTx: unknown): Promise<void>;
}

/**
 * Driver members that exist only for one capability. The suite is opt-out (see `CAPABILITIES`): a chain
 * must provide the members of every capability it does not list in `unsupported` — enforced at compile
 * time by {@link RequiredMembers} — and suites reach them through `need(driver, capability)`.
 */
export interface CapabilityMembers {
    relayer: {
        /** Base URL of the live relayer — what a fault-injecting {@link RelayerProxy} forwards to. */
        readonly relayerUrl: string;
        /** A session wired to the live relayer (genuine relayed spends). */
        relayedSession(actor: E2EActor, options?: RelayedSessionOptions): Promise<ConformanceSession>;
        /**
         * Asks the live relayer for a committed withdrawal quote — how an account that cannot build a
         * session-level proof yet (an unregistered one) obtains the quote it hands to `registerAndWithdraw`.
         * `options.relayerUrl` routes the request through a proxy, so its faults apply to the quote.
         */
        withdrawalQuote(
            params: { asset: AssetInfo; recipient: string; amount: bigint },
            options?: RelayedSessionOptions,
        ): Promise<SelectedQuote>;
        /**
         * A quote's signed `feeCommitment.data` (the chain's encoded PayoutRouting) with its recipient
         * swapped for `recipient` — a relayer that signs routing paying someone else.
         */
        rerouteFeeCommitment(data: Hex, recipient: string): Hex;
        /**
         * Sends a real, successful transaction from `actor` that never touches the pool and returns its
         * hash as the relayer would report it — for "the relayer lies about having submitted" rungs.
         */
        sendUnrelatedTransaction(actor: E2EActor): Promise<Hex>;
    };
    registerAndWithdraw: {
        /**
         * Whether a prepared relayed-registration message really carries `actor`'s own signature over the
         * chain's registration payload (EIP-712 on EVM).
         */
        verifyRelayedRegistration(prepared: unknown, actor: E2EActor): Promise<boolean>;
        /**
         * The native balance of an account that can no longer pay a fee — what `drainNative` leaves
         * and an unfunded actor starts with: 0 on EVM, the base reserve on Stellar (an account there
         * cannot exist with less).
         */
        readonly drainedNativeBalance: bigint;
    };
    keyRotation: {
        /** Protocol keys of a `signed` actor at a given revocable-key rotation index. */
        keysAtIndex(actor: E2EActor, revocableKeyIndex: Hex): ProtocolKeys;
    };
    token: {
        /** A second, non-native asset the driver can mint (an ERC-20 / SAC token). */
        tokenAsset: AssetInfo;
        /** Mints `amount` of `tokenAsset` to `to` (default: the actor). Sequential per actor. */
        mint(actor: E2EActor, asset: AssetInfo, amount: bigint, to?: string): Promise<void>;
    };
    paymentRequests: Record<never, never>;
    /** Multiple withdrawals batched into one transaction — self-submitted or relayed alike. */
    batchRelay: Record<never, never>;
    yield: {
        /** A self-submitting session built WITHOUT any yield deployment. */
        sessionWithoutYield(actor: E2EActor): Promise<ConformanceSession>;
        /** The chain's empty address (EVM zero address, Stellar all-zero StrKey) — never a valid recipient. */
        readonly emptyAddress: string;
    };
    /** A yield deployment whose underlying is the chain's native coin (ETH via WETH, XLM). */
    yieldNative: {
        readonly nativeYield: E2EYieldAsset;
    };
    /** A yield deployment whose underlying is a non-native token (an ERC-20, a classic asset's SAC). */
    yieldToken: {
        readonly tokenYield: E2EYieldAsset;
    };
}

/**
 * One yield deployment as the yield suite drives it. A chain provides one per underlying kind
 * (`yieldNative`, `yieldToken`); every driver session is configured with all of them, and
 * {@link E2EYieldAsset.yieldOf} picks this deployment's namespace out of a session.
 */
export interface E2EYieldAsset {
    /** The shielded share token (a pool asset). */
    readonly share: AssetInfo;
    /** The underlying the share wraps — what the user spends and receives. */
    readonly underlying: AssetInfo;
    /** This deployment's yield namespace in a session the driver built. */
    yieldOf(session: ConformanceSession): E2EYieldSessions;
    /**
     * Gives `actor` at least `amount` of the underlying, and whatever it needs to hold it (a Stellar
     * trustline). With `amount` 0 it only does the latter — what a withdrawal's recipient needs.
     */
    fundUnderlying(actor: E2EActor, amount: bigint): Promise<void>;
    /** Asks the live relayer for a committed withdrawal quote of `amount` shares, processed by this router. */
    withdrawalQuote(params: { recipient: string; amount: bigint }): Promise<WithdrawalRelayerQuote<string>>;
    /** Hands prepared relayer params to the live relayer (this router as processor); resolves once included. */
    relayWithdrawal(params: WithdrawalRelayParams<string>): Promise<void>;
    /**
     * A well-formed address that nevertheless cannot RECEIVE the underlying — a contract with no way
     * to accept ETH, a Stellar account without a trustline, an account that does not exist. Absent
     * when the chain has no such address for this asset (any EVM address can hold an ERC-20).
     */
    unreceivableRecipient?(): Promise<string>;
}

/** What the yield suite drives, with the chain's prepared-transaction type erased. */
export interface E2EYieldSessions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deposit: IPoolSessionYieldDeposit<any, string>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withdraw: IPoolSessionYieldWithdraw<any, string>;
    token: IYieldTokenInteractor<string>;
    router: IYieldRouterInteractor<string>;
}
