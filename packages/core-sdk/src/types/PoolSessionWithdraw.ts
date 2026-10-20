import type { ZodType } from "zod";

import type {
    Address,
    EVMProof,
    Hash,
    Hex,
    ILogger,
    IPayoutRoutingCodec,
    IPoolSessionKeystore,
    IPreparedTxVerifier,
    IRelayerInteractor,
    ITransactOrchestrator,
    ITxReceiptWaiter,
    Note,
    PendingNote,
    PreparedTransaction,
    PrepareTransactBase,
    RegisterAndWithdrawalRelayParams,
    RelayerInfo,
    TxLog,
    WithdrawalRelayerQuote,
} from "../internal.js";

/** Parameters for prepareWithdraw, generic over the chain's address type `TAddress`. */
export type WithdrawParams<TAddress = Address> = PrepareTransactBase<TAddress> & {
    /** Recipient address for the net amount after fee (PayoutRouting.recipient / Bob). */
    recipientAddress: TAddress;
    /**
     * Ask the relayer to fund the recipient with a little native gas alongside the
     * withdrawn token (the "gas top-up"), so an address holding only an ERC-20 can
     * move it afterwards. The relayer prices the top-up into `feeAmount` and encodes
     * the exact amount as `PayoutRouting.nativeGas`; `relayWithdraw` then requires
     * that slot to be non-zero. Default `false`: the routing must carry `0`.
     */
    extraGas?: boolean;
};

/**
 * Result of prepareWithdraw (returns an unsigned transaction for on-chain submission), generic
 * over the chain's prepared-transaction type `TTx` and address type `TAddress`.
 */
export interface PrepareWithdrawResult<TTx = PreparedTransaction, TAddress = Address> {
    /** Pending notes of the sender's change (remainder after withdrawal). */
    changePendingNotes: PendingNote<TAddress>[];
    /** The prepared withdraw transaction. */
    transactTx: TTx;
    /** Notes to mark as SPENT on execution. */
    spentNotes: Note<TAddress>[];
    /**
     * Nullifier hashes the proof spends (parallel to `spentNotes`), threaded to
     * `persistNoteUpdates` so it can verify the confirmed receipt's `Transacted` logs
     * consumed them before marking the notes SPENT (AW-L-02 / #1070).
     */
    spentNullifiers: Hex[];
    /** Relayer quotes to later call relayer. */
    relayerOptions: ExecuteWithdrawRelayerParams<TAddress>[];
}

/**
 * Configuration for PoolSessionWithdraw construction, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and
 * raw receipt-log type `TLog`.
 */
export interface PoolSessionWithdrawConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** Shared transact infrastructure (notes, keys, witness, proof, vault). */
    core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    /** Relayer interactor for withdraw-specific quote/submit endpoints. */
    relayerInteractor: IRelayerInteractor<TAddress>;
    /** RPC interactor for wait for relayer submisions */
    rpcInteractor: ITxReceiptWaiter<TLog>;
    /**
     * Keystore session — checks registration state and builds the `SetAuthPolicy`
     * payload for {@link IPoolSessionWithdraw.registerAndWithdraw}. Optional so plain
     * withdrawal callers need not wire it; the factory always injects it.
     */
    keystore?: IPoolSessionKeystore;
    /** Verifies prepared transactions target the expected contract/operation before signing. */
    preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    /** Decodes the relayer's signed `PayoutRouting` fee commitment for the theft guard. */
    payoutRoutingCodec: IPayoutRoutingCodec<TAddress>;
    /** Validates the `TAddress`-typed fields carried by this session's per-call params. */
    addressSchema: ZodType<TAddress>;
    /**
     * The chain's "no address" sentinel, used as the default `processorAddress`/`relayAddress`
     * for a relayed-path call that hasn't picked a relayer yet (see `PrepareTransactBase
     * .processorAddress`'s doc comment — this default is deliberately syntactically-invalid on
     * EVM, so an accidental self-submit reverts with `PoolVault_InvalidProcessor` rather than
     * silently succeeding under the wrong processor). EVM: `EMPTY_ADDRESS`. Stellar: has no
     * natural zero address (a StrKey encodes a real key), so uses `STELLAR_EMPTY_ADDRESS`
     * instead — a syntactically valid but unheld placeholder, needed because `addressScVal`
     * rejects `EMPTY_ADDRESS`'s literal `0x00...0` outright, before any on-chain call.
     */
    emptyAddress: TAddress;
}

/** Optional dependencies for PoolSessionWithdraw. */
export interface PoolSessionWithdrawDependencies {
    logger?: ILogger;
}

export interface PrepareWithdrawRelayerQuotes<TAddress = Address> {
    /** Relayer information (name, URL, etc.) */
    relayerInfo: RelayerInfo<TAddress>;
    /** The fee quote returned by the relayer for this withdrawal. */
    quote: WithdrawalRelayerQuote<TAddress>;
}

/**
 * Result of {@link IPoolSessionWithdraw.prepareRegisterAndWithdrawRelay}: the assembled
 * `registerAndRelay` request for the relayer, plus the note bookkeeping to persist after the
 * relayer confirms the transaction. The withdrawal proof inside `relayParams` is anchored to the
 * PREDICTED post-insertion keystore root (the account's leaf is inserted by the same transaction).
 */
export interface PrepareRegisterAndWithdrawResult<TAddress = Address> {
    /** The relayer selected for this atomic register-and-withdrawal. */
    relayer: RelayerInfo<TAddress>;
    /** The registration fields + withdrawal relay request to POST to the relayer. */
    relayParams: RegisterAndWithdrawalRelayParams<TAddress>;
    /** Notes to mark SPENT after the relayer confirms. */
    spentNotes: Note<TAddress>[];
    /** Change notes to persist after the relayer confirms. */
    changePendingNotes: PendingNote<TAddress>[];
}

/**
 * Parameters for executing a prepared withdrawal via a relayer, generic over the chain's address
 * type `TAddress`.
 */
export interface ExecuteWithdrawRelayerParams<TAddress = Address> {
    /** Commitment hashes of the input notes to spend. */
    inputCommitments: Hash[];
    /** Amount to withdraw. */
    amount: Hex;
    /** Token identifier for the withdrawn asset. */
    tokenId: TAddress;
    /** Recipient address for the net amount after fee. */
    recipientAddress: TAddress;
    /** The selected relayer and its fee quote for this withdrawal. */
    selectedQuote: PrepareWithdrawRelayerQuotes<TAddress>;
    /**
     * Whether the caller asked for the native-gas top-up when the quote was requested
     * (see {@link WithdrawParams.extraGas}). Drives the routing guard: `true` requires
     * `PayoutRouting.nativeGas` to be non-zero (a zeroed top-up would mean the user
     * paid for gas the recipient never receives); `false`/absent requires it to be `0`.
     * `prepareWithdraw` fills this in from its params; callers assembling the quote
     * themselves (e.g. `registerAndWithdraw`) must set it to what they requested.
     */
    extraGas?: boolean;
}

/**
 * Parameters for executing a combined register-and-withdrawal via a relayer.
 * Extends the withdrawal relay params with the EIP-712 `SetAuthPolicy` signature
 * produced by signing {@link IPoolSessionKeystore.buildSetAuthPolicyTypedData}, plus
 * the `deadline` the signature is bound to (C-8): it is threaded to the relayer's
 * `registerAndRelay` as the 4th arg and must equal the signed typed-data deadline.
 */
export type ExecuteRegisterAndWithdrawRelayerParams<TAddress = Address> =
    ExecuteWithdrawRelayerParams<TAddress> & {
        /** EIP-712 `SetAuthPolicy` signature authorizing the relayed registration. */
        signature: Hex;
        /**
         * Unix-seconds deadline the `SetAuthPolicy` signature is bound to, as 0x-prefixed hex.
         * MUST match the deadline passed to `buildSetAuthPolicyTypedData` when signing.
         */
        deadline: Hex;
    };
