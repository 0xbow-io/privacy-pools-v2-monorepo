import type { ZodType } from "zod";

import type {
    Address,
    Hex,
    IHTTPClient,
    ILogger,
    NoteData,
    ProofResult,
    StealthRecipientIdentifier,
} from "../internal.js";

/**
 * Configuration for the RelayerInteractor, generic over the chain's address type `TAddress`.
 */
export interface RelayerInteractorConfig<TAddress = Address> {
    /** Known relayers to use for transaction submission. */
    relayers: RelayerInfo<TAddress>[];
    /** HTTP client for making requests to relayer APIs. */
    httpClient: IHTTPClient;
    /** Validates the `TAddress`-typed fields carried by relayer requests/config. */
    addressSchema: ZodType<TAddress>;
}

/**
 * Optional dependencies for the RelayerInteractor.
 */
export interface RelayerInteractorDependencies {
    logger?: ILogger;
}

/**
 * Information about an available relayer.
 */
export interface RelayerInfo<TAddress = Address> {
    /** The relayer's API endpoint URL. */
    url: string;
    /** Human-readable name of the relayer. */
    name: string;
    /** The chain ID the relayer operates on. */
    chainId: number;
    /** The chain type (e.g., "evm"). */
    chainType: string;
    /** Whether the relayer is currently active or inactive. */
    status: "active" | "inactive";
    /** Address of the relayer. */
    address: TAddress;
    /** Address of the relayer's fee processor contract. */
    processorAddress: TAddress;
}

/** The subset of {@link RelayerInfo} needed to address a relayer's HTTP API. */
export type RelayerEndpoint = Pick<RelayerInfo, "url" | "chainType" | "chainId">;

/**
 * One yield wrapper the relayer can relay, as published on `/v1/details` (`yield[]`) — an
 * EVM-only concept (no yield subsystem exists on other chains). Generic over `TAddress` for
 * consistency with every other type in this file; a non-EVM `RelayerChainDetails<TAddress>`
 * simply never populates `yield`.
 */
export interface RelayerYieldWrapper<TAddress = Address> {
    /** Yield share token (the shielded asset). */
    ppToken: TAddress;
    /** Underlying ERC-20 the user deposits and receives. */
    underlying: TAddress;
    /** PPRouter — the `transact` processor to bind into a relayed yield withdrawal proof. */
    router: TAddress;
    /** PPYieldTokenZap — stateless share<->underlying helper. */
    zap: TAddress;
    ppDecimals: number;
    underlyingDecimals: number;
    underlyingSymbol: string;
}

/**
 * What a relayer says about one chain (`GET {url}/v1/details/{chainType}/{chainId}`), generic
 * over the chain's address type `TAddress`. Use it instead of hand-copying addresses:
 * `contracts.relay` is the processor for plain relayed withdrawals/transfers, `contracts.relaySwaps`
 * for swaps/reshields, `yield[].router` for yield-share notes, `relayerAddress` is the relayer's
 * signer. A wrong processor bound into a proof fails every relay of that note with
 * `PoolVault_ProofContextMismatch`.
 *
 * `contracts`/`swapsSupported`/`processors`/`yield` are EVM-shaped (separate entrypoint/poolVault,
 * RelaySwaps, PPRouters, yield wrappers) — a chain with a different topology (e.g. Stellar, which
 * collapses entrypoint+poolVault into one contract and has no swap/yield subsystem) maps its own
 * richer `/v1/details` response down into this narrower shape (`entrypoint === poolVault`,
 * `relaySwaps`/`yield`/`processors` left undefined) rather than this type growing a field per chain's
 * topology; a chain-specific field a caller needs beyond this (e.g. Stellar's keystore/ASP-registry
 * contract ids) comes from that chain's own deployment config, not relayer discovery.
 */
export interface RelayerChainDetails<TAddress = Address> {
    id: number;
    name: string;
    type: string;
    contracts: {
        entrypoint: TAddress;
        poolVault: TAddress;
        relay: TAddress;
        relaySwaps?: TAddress;
    };
    swapsSupported: boolean;
    /**
     * Whether a cross-chain reshield may END on this chain: a bridge can run the destination
     * deposit call here (LI.FI receivers deployed). `false` makes the cross-chain reshield refuse
     * this chain as its destination before quoting. Absent on relayers predating it (treated as
     * allowed).
     */
    destinationCallsSupported?: boolean;
    assets: {
        address: TAddress;
        ticker: string;
        fixedFeeAmount?: string | number;
        feeBPS?: string | number;
    }[];
    /** Absent on relayers predating discovery. */
    relayerAddress?: TAddress;
    /** `allowed_processors` verbatim (the PPRouters). Absent on relayers predating discovery. */
    processors?: TAddress[];
    /** Absent on relayers predating discovery. */
    yield?: RelayerYieldWrapper<TAddress>[];
    /**
     * `max_swap_value_wei` (decimal string, this chain's native wei): B2 ceiling on a swap
     * quote's `swapValue`, the LayerZero fee RelaySwaps mints in-contract on a
     * Mainnet-destination reshield. Absent on relayers predating cap publication.
     */
    maxSwapValueWei?: string;
}

/** The per-chain native-wei ceilings a relayer publishes and enforces at quote and relay time. */
export interface RelayerCaps {
    /** B2 `swapValue` ceiling; undefined when not published. */
    maxSwapValueWei?: bigint;
}

/**
 * Parameters for requesting a transfer fee quote from a relayer, generic over the chain's
 * address type `TAddress`.
 */
export interface TransferQuoteParams<TAddress = Address> {
    /** The asset to transfer. */
    asset: TAddress;
    /** Whether to commit to the quote. */
    commit: boolean;
}

/**
 * Parameters for requesting a withdrawal fee quote from a relayer, generic over the chain's
 * address type `TAddress`. Extends TransferQuoteParams with withdrawal-specific fields.
 */
export type WithdrawalQuoteParams<TAddress = Address> = TransferQuoteParams<TAddress> & {
    /** The recipient address for the withdrawal. */
    recipient: TAddress;
    /** Whether to include extra gas for the recipient. */
    extraGas: boolean;
    /** The withdrawal amount. */
    amount: string;
};

/**
 * A fee commitment returned by a relayer as part of a quote, generic over the chain's address
 * type `TAddress`.
 */
export interface FeeCommitment<TAddress = Address> {
    /** Commitment data (hex-encoded). */
    data: Hex;
    /** The asset address. */
    asset: TAddress;
    /** Unix timestamp after which this commitment expires. */
    expiration: number;
    /** The fee amount. */
    feeAmount: string;
    /** The relayer's signed commitment (hex-encoded). */
    signedRelayerCommitment: Hex;
}

/**
 * A fee commitment for withdrawal operations.
 * Extends FeeCommitment with withdrawal-specific fields.
 */
export type WithdrawalFeeCommitment<TAddress = Address> = FeeCommitment<TAddress> & {
    /** The recipient address. */
    recipient: TAddress;
    /** The amount sent. */
    amountSent: string;
    /** The amount received by the recipient. */
    amountReceived: string;
    /** Whether the relayer offered extra gas buffer for the withdrawal. */
    extraGas: boolean;
};

/**
 * A relayer quote before any commitment is attached (`commit: false`): a fee
 * estimate only. Neutral base composed into the committed quote types below.
 */
export interface UncommittedQuote {
    /** The transaction cost. */
    txCost: string;
    /** The gas price. */
    gasPrice: string;
    /** The fee amount. */
    feeAmount: string;
}

/**
 * A fee quote returned by a relayer for a transfer operation.
 */
export type TransferRelayerQuote<TAddress = Address> = UncommittedQuote & {
    /** The fee commitment from the relayer. */
    feeCommitment: FeeCommitment<TAddress>;
};

/**
 * A fee quote returned by a relayer for a withdrawal operation.
 * Extends TransferRelayerQuote with withdrawal-specific fields.
 */
export type WithdrawalRelayerQuote<TAddress = Address> = Omit<
    TransferRelayerQuote<TAddress>,
    "feeCommitment"
> & {
    /** The amount sent. */
    amountSent: string;
    /** The amount received by the recipient. */
    amountReceived: string;
    /** The withdrawal fee commitment from the relayer. */
    feeCommitment: WithdrawalFeeCommitment<TAddress>;
};

/**
 * Parameters for requesting an aggregate fee quote for a batch withdrawal, generic over the
 * chain's address type `TAddress`. One quote covers every item; `amounts` carries the per-item
 * withdrawal values.
 */
export interface BatchWithdrawalQuoteParams<TAddress = Address> {
    /** The asset withdrawn by every item in the batch. */
    asset: TAddress;
    /** Whether to commit to the quote. */
    commit: boolean;
    /** The recipient address shared by every batch item. */
    recipient: TAddress;
    /** Whether to include extra gas for the recipient. */
    extraGas: boolean;
    /** Per-item withdrawal amounts, in batch order. */
    amounts: string[];
}

/**
 * A signed aggregate fee commitment covering a whole batch withdrawal.
 * Mirrors {@link FeeCommitment} but binds the batch-level `totalFee` and the
 * per-item `maxRelayFee` cap the relay contract enforces.
 *
 * `relayCost`, `feeBps` and `flatFee` are the SIGNED fee-model parameters the SDK
 * recomputes each item's fee from (`computeBatchItemFee`) to verify the relayer's
 * `PayoutRouting[]` split — this is what stops a greedy relayer re-concentrating
 * the whole batch fee onto one cherry-picked item.
 */
export interface BatchFeeCommitment {
    /** Commitment data (hex-encoded). */
    data: Hex;
    /** The asset address (hex-encoded). */
    asset: Hex;
    /** Unix timestamp after which this commitment expires. */
    expiration: number;
    /** The total fee for the whole batch. */
    totalFee: string;
    /** The per-item maximum relay fee cap. */
    maxRelayFee: string;
    /** The single-tx relay gas cost in token units, shared by every item. */
    relayCost: string;
    /** The proportional fee rate in basis points; `"0"` selects the flat-fee model. */
    feeBps: string;
    /** The flat fee in token units; used only when `feeBps` is `"0"`. */
    flatFee: string;
    /** The relayer's signed commitment (hex-encoded). */
    signedRelayerCommitment: Hex;
}

/**
 * An aggregate fee quote returned by a relayer for a batch withdrawal.
 * Mirrors {@link WithdrawalRelayerQuote} but reports batch-level totals.
 */
export interface BatchWithdrawalRelayerQuote {
    /** The transaction cost. */
    txCost: string;
    /** The gas price. */
    gasPrice: string;
    /** The total fee for the whole batch. */
    totalFee: string;
    /** The per-item maximum relay fee cap. */
    maxRelayFee: string;
    /** The signed aggregate batch fee commitment. */
    feeCommitment: BatchFeeCommitment;
}

/**
 * One item submitted as part of a batch withdrawal relay request.
 * Mirrors the per-item fields of {@link WithdrawalRelayParams}.
 */
export interface BatchWithdrawalRelayItem {
    /** The ZK proof for this item. */
    proof: ProofResult;
    /** Note data (hex-encoded) for this item. */
    noteData: NoteData[];
    /** Number of input nullifiers in this item. */
    inputNullifierNumber: number;
    /** Number of output commitments in this item. */
    outputCommitmentNumber: number;
}

/**
 * Parameters for submitting a batch withdrawal to a relayer.
 */
export interface BatchWithdrawalRelayParams {
    /** The per-item proofs and encrypted payloads, in batch order. */
    items: BatchWithdrawalRelayItem[];
    /** The signed aggregate batch fee commitment from the quote. */
    signedBatchFeeCommitment: BatchFeeCommitment;
}

/**
 * Parameters for submitting a transfer to a relayer.
 */
export interface TransferRelayParams<TAddress = Address> {
    /** The ZK proof. */
    proof: ProofResult;
    /** Note data (hex-encoded). */
    noteData: NoteData[];
    /** The signed fee commitment from the quote. */
    signedFeeCommitment: FeeCommitment<TAddress>;
    /** Number of inputs in the transaction. */
    inputNullifierNumber: number;
    /** Number of outputs in the transaction. */
    outputCommitmentNumber: number;
}

/**
 * Parameters for submitting a withdrawal to a relayer.
 * Extends TransferRelayParams with withdrawal-specific fields.
 */
export type WithdrawalRelayParams<TAddress = Address> = Omit<
    TransferRelayParams<TAddress>,
    "signedFeeCommitment"
> & {
    /** The signed withdrawal fee commitment from the quote. */
    signedFeeCommitment: WithdrawalFeeCommitment<TAddress>;
    /**
     * Optional alternate transact processor for a relayed YIELD withdrawal. When set to the
     * `PPRouter` address, the relayer routes the transaction to `PPRouter.withdrawToUnderlying`
     * (unshield ppUSDC shares + unwrap to the underlying) instead of the default
     * `PrivacyPoolRelay`. Must be allowlisted by the relayer. Omit for a plain (non-yield)
     * withdrawal.
     */
    processorAddress?: TAddress;
    /**
     * Optional slippage floor (in the UNDERLYING token, as `0x`-hex) for the
     * `PPRouter.withdrawToUnderlying` redeem leg of a relayed yield withdrawal. Only applies when
     * `processorAddress` is set; the relayer ignores it otherwise and defaults it to `0` when absent.
     * The relayer cannot derive this itself (the fee commitment binds only pp-share amounts), so the
     * client supplies its own floor.
     */
    minUnderlyingOut?: Hex;
};

/**
 * Signed relayed auth-policy registration fields, produced by
 * {@link IPoolSessionKeystore.prepareRelayedRegistration}. The relayer submits these to
 * `Keystore.setAuthPolicyWithSig` (standalone) or `PrivacyPoolRelay.registerAndRelay` (atomic)
 * on the account's behalf, so the account never needs gas. `signature` is required — for the
 * external-signing path, supply the integrator's signature over the typed-data payload.
 */
export interface RelayedRegistrationFields<TAddress = Address> {
    /** Account being registered (the EIP-712 signer). */
    account: TAddress;
    /** Authorization digest to register. */
    authDigest: Hex;
    /** Poseidon(privateNullifyingKey). */
    nullifyingKeyHash: Hex;
    /** Unix-seconds deadline after which the signature is rejected on-chain. */
    deadline: Hex;
    /** EIP-712 signature over the SetAuthPolicy payload (EOA or EIP-1271). */
    signature: Hex;
}

/**
 * Parameters for a standalone relayed keystore registration — the relayer calls
 * `Keystore.setAuthPolicyWithSig` with these fields. No value moves, so there is no fee commitment.
 */
export type RegisterKeystoreRelayParams<TAddress = Address> = RelayedRegistrationFields<TAddress>;

/**
 * Parameters for an atomic `registerAndRelay`: the signed registration fields plus the withdrawal
 * relay request whose proof is anchored to the PREDICTED post-insertion keystore root (see
 * {@link WithdrawalRelayParams}). The relayer registers then relays in a single transaction, so a
 * fresh, unfunded recipient can withdraw a received note without ever paying gas.
 */
export type RegisterAndWithdrawalRelayParams<TAddress = Address> = WithdrawalRelayParams<TAddress> & {
    /** The signed relayed-registration fields. */
    registration: RelayedRegistrationFields<TAddress>;
};

/**
 * ERC-5564 stealth-payment announcement fields, as produced by the stealth module's
 * `Announcement`. The relay contract's `relayAndAnnounce` forwards these to the canonical
 * Announcer and enforces on-chain that `stealthAddress` equals the withdrawal's payout recipient.
 */
export interface StealthAnnouncementFields<TAddress = Address> {
    /** The ERC-5564 scheme id (e.g. `0x0001` canonical), as 0x-prefixed hex. */
    schemeId: Hex;
    /** The stealth address the withdrawal pays; must equal the PayoutRouting recipient. */
    stealthAddress: TAddress;
    /** The ephemeral public key used to derive the stealth address. */
    ephemeralPubKey: Hex;
    /** View-tag + scheme metadata forwarded verbatim to the Announcer. */
    metadata: Hex;
}

/**
 * Parameters for an atomic `relayAndAnnounce`: a standard withdrawal relay request paying a stealth
 * address, plus the ERC-5564 announcement to publish in the SAME transaction. The relayer submits both
 * atomically, so the announce↔withdraw binding (STLTH-18) is guaranteed on-chain rather than advisory.
 */
export type RelayAndAnnounceRelayParams<TAddress = Address> = WithdrawalRelayParams<TAddress> & {
    /** The ERC-5564 announcement whose stealthAddress must equal the withdrawal recipient. */
    announcement: StealthAnnouncementFields<TAddress>;
};

/**
 * Parameters for requesting a swap fee quote from a relayer, generic over the chain's address
 * type `TAddress`. Extends TransferQuoteParams with swap-specific fields.
 */
export type SwapQuoteParams<TAddress = Address> = TransferQuoteParams<TAddress> & {
    /** The recipient address for the swap output. */
    recipient: TAddress;
    /** Fallback address for cross-chain bridge failure refunds. Defaults to recipient if omitted. */
    fallbackAddress?: TAddress;
    /** The withdrawal amount in input token units. */
    amount: string;
    /** The desired output token address. */
    outputToken: TAddress;
    /** The minimum acceptable output amount. */
    minOutputAmount: string;
    /**
     * Opt-in ETH gas top-up for the recipient, mirroring the withdrawal path's
     * flag: the relayer computes and caps the funded amount and folds its cost
     * into feeAmount. Not supported when recipient is the zero address.
     */
    extraGas?: boolean;
    /** Full LiFi swap calldata (proof-bound via the RelaySwaps SwapRouting struct). */
    swapCalldata?: Hex;
    /** Address of the swap target contract (for RelaySwaps proof-binding). */
    swapTarget?: TAddress;
    /** Address for token approval (may differ from swapTarget, e.g. LiFi v4 ERC20Proxy). Defaults to swapTarget if omitted. */
    approvalAddress?: TAddress;
    /**
     * B2 — native wei RelaySwaps mints in-contract (from a slice of the withdrawal) and
     * forwards as msg.value to the bridge on a Mainnet-destination reshield. Omitted / "0"
     * on every other path. Requires `gasSwapMaxInput` + `gasSwapCalldata` when > 0.
     */
    swapValue?: string;
    /** B2 — upper bound on input-token units RelaySwaps may approve for the in-contract gas swap. */
    gasSwapMaxInput?: string;
    /** B2 — same-chain input-token->native-ETH LiFi calldata for the in-contract gas swap (proof-bound). */
    gasSwapCalldata?: Hex;
    /** Address to receive any dust left on the processor contract after swap. Must be non-zero. */
    dustRecipient: TAddress;
    /**
     * Opt-in dust rescue for reshield (`PoolSessionReshield` and
     * `PoolSessionReshieldCrosschain`). Only valid when `recipient` is the zero address.
     * Encoded into the relayer's signed `SwapRouting.dustRescue` at quote time (RC-10) — it
     * therefore inherits that struct's existing proof-context binding, the same as every other
     * quote field. `destinationChainId` equals the requesting chain itself for a same-chain
     * reshield (there is no distinct destination to bridge to) — see
     * `RelaySwapDustRescue.destinationChainId`.
     */
    dustRescue?: RelaySwapDustRescue<TAddress>;
};

/**
 * A fee commitment for swap operations.
 * Extends FeeCommitment with swap-specific fields.
 */
export type SwapFeeCommitment<TAddress = Address> = FeeCommitment<TAddress> & {
    /** The recipient address (hex-encoded). */
    recipient: Hex;
    /** The total amount withdrawn (amount + fee). */
    amountSent: string;
};

/**
 * A committed swap quote (`commit: true`), generic over the chain's address type `TAddress`.
 * Extends the uncommitted estimate with the relayer's signed swap fee commitment.
 */
export type SwapRelayerQuote<TAddress = Address> = UncommittedQuote & {
    /** The swap fee commitment from the relayer. */
    feeCommitment: SwapFeeCommitment<TAddress>;
};

/**
 * Dust-rescue opt-in for reshield (`PoolSessionReshield` and
 * `PoolSessionReshieldCrosschain`), requested at quote time
 * (`SwapQuoteParams.dustRescue`) and encoded into the relayer-signed
 * `SwapRouting.dustRescue` — proof-bound like every other routing field, so the relayer
 * cannot attach or alter it after the fact (RC-10).
 */
export interface RelaySwapDustRescue<TAddress = Address> {
    /**
     * Chain the leftover will be observed/rescued on. Equals the requesting chain itself
     * for a same-chain reshield (the leftover is swept synchronously, in the same tx, to
     * `dustRecipient` on this chain — there is no distinct destination to bridge to); a real
     * cross-chain destination for `PoolSessionReshieldCrosschain`.
     */
    destinationChainId: number;
    /**
     * Chain type `destinationChainId` is scoped to (e.g. "evm", "stellar") — a bare numeric
     * chain ID is ambiguous once more than one chain type exists (an EVM chain and a chain of
     * another type can be assigned the same numeric ID), so the relayer needs this to resolve
     * `destinationChainId` unambiguously. Lowercase, matching `RelayerInfo.chainType`.
     */
    destinationChainType: string;
    /** Destination token the leftover is denominated in. */
    tokenId: TAddress;
    /** Stealth recipient identifier the relayer derives the rescue note's owner from. */
    recipientIdentifier: StealthRecipientIdentifier;
}

/**
 * Parameters for submitting a withdraw-and-swap to a relayer.
 */
export interface SwapRelayParams<TAddress = Address> {
    /** The ZK proof. */
    proof: ProofResult;
    /** Note data (hex-encoded). */
    noteData: NoteData[];
    /** The signed swap fee commitment from the quote. */
    signedSwapCommitment: SwapFeeCommitment<TAddress>;
    /** Number of inputs in the transaction. */
    inputNullifierNumber: number;
    /** Number of outputs in the transaction. */
    outputCommitmentNumber: number;
}
