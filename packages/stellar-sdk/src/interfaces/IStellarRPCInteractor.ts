import type { xdr } from "@stellar/stellar-sdk";

import type {
    FinalizedBlockResult,
    Hex,
    ITxReceiptWaiter,
    StellarAccountInfo,
    StellarGetEventsParams,
    StellarGetEventsResult,
    StellarLog,
} from "../internal.js";

/**
 * Read-only Soroban RPC access + the chain-native transaction lifecycle up to (but not
 * including) signing — build, simulate, and assemble a contract call into unsigned XDR; submit
 * an already-signed XDR; wait for confirmation; fetch events. Holds no private key, matching
 * EVM's `IRPCInteractor` role exactly (reads + `waitForTransactionReceipt`, never submission —
 * see {@link IStellarWalletInteractor} for why signing+submission is bundled there instead,
 * mirroring `IWalletInteractor.sendTransaction`'s shape rather than this milestone's earlier
 * "wallet signs only, RPC submits" sketch).
 *
 * `TTx` for a Stellar chain adapter is this interface's `buildTransaction` output: an unsigned
 * transaction XDR string, opaque to `PoolVaultInteractor`/`EntrypointInteractor`/
 * `KeystoreInteractor` themselves — same "TTx flows opaquely from encodeX straight into submit"
 * design already used for EVM's `PreparedTransaction`.
 */
export interface IStellarRPCInteractor extends ITxReceiptWaiter<StellarLog> {
    /** Current ledger sequence — Stellar's analog of EVM's block number. */
    getLatestLedger(): Promise<Hex>;

    /**
     * Reports the latest closed ledger as final — Stellar's SCP consensus closes a ledger only
     * once a supermajority quorum has voted to externalize it, so unlike a probabilistic PoW/PoS
     * chain there is no "N confirmations" reorg window to wait out afterward: a closed ledger
     * does not un-close. `PoolSessionNoteDiscovery` structurally detects this method (duck-typed,
     * not a chain-specific branch) and uses it in place of its EVM-tuned 64-block confirmation
     * fallback wherever a `finalized`-tag read would otherwise be assumed unsupported.
     *
     * @returns Always `{status: "finalized", ...}` — never `"unsupported"`/`"unavailable"`, since
     *   the read is just {@link getLatestLedger}, which already has its own retry/timeout handling.
     */
    getFinalizedBlockNumber(): Promise<FinalizedBlockResult>;

    /** Fetches an account's current sequence number, needed to build a new transaction. */
    getAccount(publicKey: string): Promise<StellarAccountInfo>;

    /**
     * Current native (XLM) balance of an account, in stroops (1 XLM = 10,000,000 stroops) —
     * read directly off the account's ledger entry, not a trustline (native balance is intrinsic
     * to `AccountEntry` itself, unlike an issued asset).
     *
     * @throws {StellarRPCInteractorBaseError}
     */
    getNativeBalance(publicKey: string): Promise<bigint>;

    /**
     * Builds and simulates a read-only contract call — never submitted, no signature needed.
     * Soroban has no separate "storage read" path distinct from a simulated call; even a pure
     * read needs a valid (any) source account to build a well-formed transaction envelope.
     *
     * @param contractId - The contract to call.
     * @param method - The contract method name.
     * @param args - The ScVal-encoded arguments, in the method's declared order.
     * @param sourcePublicKey - Any valid, existing account to serve as the simulated tx's source.
     * @returns The decoded return value.
     * @throws {StellarRPCInteractorBaseError}
     */
    simulateRead(
        contractId: string,
        method: string,
        args: xdr.ScVal[],
        sourcePublicKey: string,
    ): Promise<unknown>;

    /**
     * Builds, simulates, and assembles a contract call into unsigned transaction XDR — resource
     * footprint and fee are already correct (via `rpc.assembleTransaction`); the result is ready
     * to hand to a wallet for signing.
     *
     * @param contractId - The contract to call.
     * @param method - The contract method name.
     * @param args - The ScVal-encoded arguments, in the method's declared order.
     * @param sourcePublicKey - The account that will sign and submit this transaction.
     * @param sequenceOffset - How many sequence numbers past the account's current on-chain
     *   value to target (default `1`, i.e. the very next valid sequence). Soroban rejects a
     *   transaction whose sequence isn't exactly `currentSequence + 1` at submission time — no
     *   mempool tolerance for out-of-order-but-pending transactions the way EVM has. A caller
     *   building more than one transaction from the same source account *before* submitting and
     *   confirming the first one (e.g. two keystore registration calls back to back) must pass
     *   `2`, `3`, etc. for each subsequent one, matching the order they'll actually be submitted
     *   in, or the later ones will fail with `txBadSeq`.
     * @returns The unsigned transaction, XDR-encoded.
     * @throws {StellarRPCInteractorBaseError}
     * @throws {WalletInteractorBaseError} When `simulateTransaction` itself reports the call
     *   would fail. By this point every check the SDK can do locally has already passed, so a
     *   simulation failure here is Soroban's live-chain-state verdict on whether submitting this
     *   transaction would succeed — the same thing a "send failed" error reports on a chain
     *   whose RPC only learns this at actual broadcast time.
     */
    buildTransaction(
        contractId: string,
        method: string,
        args: xdr.ScVal[],
        sourcePublicKey: string,
        sequenceOffset?: number,
    ): Promise<string>;

    /**
     * Builds a contract call WITHOUT simulating it — no footprint, no resource fee, sequence 0 —
     * for a call that cannot be simulated yet and will not be submitted as built (a
     * register-and-withdraw transact, whose keystore root only exists once the relayer's bundled
     * registration lands).
     *
     * @returns The unsimulated transaction XDR.
     */
    buildUnsimulatedTransaction(
        contractId: string,
        method: string,
        args: xdr.ScVal[],
        sourcePublicKey: string,
    ): Promise<string>;

    /**
     * Builds a contract call that carries explicit authorization entries — someone other than
     * the source authorizing a nested call (a relayed `register_and_relay`'s owner entry) — and
     * simulates it in ENFORCING mode, so an invalid signature or a mismatched invocation fails here,
     * before the source pays for it. The source's own credential for the root call is added.
     *
     * @param contractId - The contract to call.
     * @param method - The function to invoke.
     * @param args - The call arguments.
     * @param sourcePublicKey - The submitting account.
     * @param auth - The third-party authorization entries, already signed.
     * @returns The assembled, unsigned transaction XDR.
     * @throws {WalletInteractorBaseError}
     */
    buildTransactionWithAuth(
        contractId: string,
        method: string,
        args: xdr.ScVal[],
        sourcePublicKey: string,
        auth: xdr.SorobanAuthorizationEntry[],
    ): Promise<string>;

    /**
     * Submits an already-signed transaction XDR.
     *
     * @param signedXdr - The signed transaction, XDR-encoded.
     * @returns The transaction hash.
     * @throws {StellarRPCInteractorBaseError}
     */
    submitTransaction(signedXdr: string): Promise<Hex>;

    /**
     * Fetches every contract event in the requested range, paginating internally to exhaustion.
     *
     * @param params - The contract/range/cursor to fetch.
     * @returns Every matching event, in chronological order.
     * @throws {StellarRPCInteractorBaseError}
     */
    getEvents(params: StellarGetEventsParams): Promise<StellarGetEventsResult>;
}
