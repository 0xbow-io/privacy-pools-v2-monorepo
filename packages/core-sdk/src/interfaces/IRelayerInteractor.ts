import type {
    Address,
    BatchWithdrawalQuoteParams,
    BatchWithdrawalRelayerQuote,
    BatchWithdrawalRelayParams,
    Hex,
    RegisterAndWithdrawalRelayParams,
    RegisterKeystoreRelayParams,
    RelayAndAnnounceRelayParams,
    RelayerChainDetails,
    RelayerEndpoint,
    RelayerInfo,
    SwapQuoteParams,
    SwapRelayerQuote,
    SwapRelayParams,
    TransferQuoteParams,
    TransferRelayerQuote,
    TransferRelayParams,
    UncommittedQuote,
    WithdrawalQuoteParams,
    WithdrawalRelayerQuote,
    WithdrawalRelayParams,
} from "../internal.js";

/**
 * Interface for the RelayerInteractor, generic over the chain's address type `TAddress`
 * (defaults to EVM's {@link Address}).
 * Manages the relayer interaction lifecycle: accessing configured relayers,
 * requesting fee quotes, and submitting transactions.
 */
export interface IRelayerInteractor<TAddress = Address> {
    /**
     * Returns the list of relayers provided at construction time.
     * @returns An array of relayer information objects.
     */
    getRelayers(): Promise<RelayerInfo<TAddress>[]>;

    /**
     * Fetches the relayer's own statement of the addresses it relays through on one chain
     * (`GET {url}/v1/details/{chainType}/{chainId}`): the relay / RelaySwaps / PPRouter
     * processors, its signer address and the yield wrappers. Feed the result to
     * `PoolSessionBuilder.withRelayerDetails()` (and `relayerInfoFromDetails()`) so no
     * processor address is ever hand-copied.
     * @param relayer - Where to ask (url, chainType, chainId).
     * @returns The validated chain details.
     * @throws {RelayerRequestFailed} If the request fails or the response is malformed.
     */
    getChainDetails(relayer: RelayerEndpoint): Promise<RelayerChainDetails<TAddress>>;

    /**
     * Requests a fee quote from a relayer for a transfer operation.
     * @param relayer - The relayer to request a quote from.
     * @param params - Parameters describing the transfer to quote.
     * @returns A fee quote for the transfer.
     * @throws {RelayerInteractorBaseError}
     */
    getTransferQuote(
        relayer: RelayerInfo<TAddress>,
        params: TransferQuoteParams<TAddress>,
    ): Promise<TransferRelayerQuote<TAddress>>;

    /**
     * Requests a fee quote from a relayer for a withdrawal operation.
     * @param relayer - The relayer to request a quote from.
     * @param params - Parameters describing the withdrawal to quote.
     * @returns A fee quote for the withdrawal.
     * @throws {RelayerInteractorBaseError}
     */
    getWithdrawalQuote(
        relayer: RelayerInfo<TAddress>,
        params: WithdrawalQuoteParams<TAddress>,
    ): Promise<WithdrawalRelayerQuote<TAddress>>;

    /**
     * Requests a single aggregate fee quote from a relayer for a batch withdrawal.
     * @param relayer - The relayer to request a quote from.
     * @param params - Parameters describing the batch withdrawal to quote.
     * @returns An aggregate fee quote covering the whole batch.
     * @throws {RelayerInteractorBaseError}
     */
    getBatchWithdrawalQuote(
        relayer: RelayerInfo<TAddress>,
        params: BatchWithdrawalQuoteParams<TAddress>,
    ): Promise<BatchWithdrawalRelayerQuote>;

    /**
     * Submits a batch withdrawal (multiple proofs, one signed fee commitment) to a
     * relayer for on-chain execution.
     * @param relayer - The relayer to submit the batch to.
     * @param params - The per-item proofs/payloads and the signed batch fee commitment.
     * @returns The transaction hash of the submitted batch.
     * @throws {RelayerInteractorBaseError}
     */
    relayBatchWithdrawal(
        relayer: RelayerInfo<TAddress>,
        params: BatchWithdrawalRelayParams,
    ): Promise<Hex>;

    /**
     * Submits a transfer transaction to a relayer for on-chain execution.
     * @param relayer - The relayer to submit the transaction to.
     * @param params - The relay parameters including proof, encrypted payload, and fee commitment.
     * @returns The transaction hash of the submitted transaction.
     * @throws {RelayerInteractorBaseError}
     */
    relayTransfer(relayer: RelayerInfo<TAddress>, params: TransferRelayParams<TAddress>): Promise<Hex>;

    /**
     * Submits a withdrawal transaction to a relayer for on-chain execution.
     * @param relayer - The relayer to submit the transaction to.
     * @param params - The relay parameters including proof, encrypted payload, fee commitment, and recipient.
     * @returns The transaction hash of the submitted transaction.
     * @throws {RelayerInteractorBaseError}
     */
    relayWithdrawal(
        relayer: RelayerInfo<TAddress>,
        params: WithdrawalRelayParams<TAddress>,
    ): Promise<Hex>;

    /**
     * Submits a standalone relayed keystore registration (`Keystore.setAuthPolicyWithSig`) on the
     * account's behalf, so a gasless account can register its auth policy.
     *
     * NOT YET SUPPORTED: the relayer exposes no standalone `register` endpoint (INTL-05 defers it
     * pending the fee-commitment economics of a registration that carries no withdrawal). Calling
     * this throws {@link RelayerRequestFailed} up front rather than issuing a doomed request. Use
     * {@link IRelayerInteractor.relayRegisterAndWithdrawal} for the atomic register-and-withdraw path,
     * which folds the registration gas into the withdrawal fee.
     * @param relayer - The relayer to submit the registration to.
     * @param params - The signed relayed-registration fields.
     * @returns The transaction hash of the submitted registration.
     * @throws {RelayerInteractorBaseError}
     */
    submitRelayedRegistration(
        relayer: RelayerInfo<TAddress>,
        params: RegisterKeystoreRelayParams<TAddress>,
    ): Promise<Hex>;

    /**
     * Submits an atomic `register-and-withdrawal` — the relayer registers the account's auth policy
     * then relays the withdrawal in one transaction, letting a fresh, unfunded recipient withdraw a
     * received note without ever paying gas. The withdrawal proof must be anchored to the predicted
     * post-insertion keystore root.
     * @param relayer - The relayer to submit to.
     * @param params - The signed registration fields plus the withdrawal relay request.
     * @returns The transaction hash of the submitted transaction.
     * @throws {RelayerInteractorBaseError}
     */
    relayRegisterAndWithdrawal(
        relayer: RelayerInfo<TAddress>,
        params: RegisterAndWithdrawalRelayParams<TAddress>,
    ): Promise<Hex>;

    /**
     * Submits an atomic `relayAndAnnounce` — the relayer relays a withdrawal to a stealth address then
     * publishes its ERC-5564 announcement in the same transaction, so the announce↔withdraw binding is
     * guaranteed on-chain (the contract enforces the announced stealth address equals the payout
     * recipient). Lets a stealth payment be relayed without the sender revealing themselves as tx.origin.
     * @param relayer - The relayer to submit to.
     * @param params - The withdrawal relay request plus the ERC-5564 announcement to publish.
     * @returns The transaction hash of the submitted transaction.
     * @throws {RelayerInteractorBaseError}
     */
    relayWithAnnounce(
        relayer: RelayerInfo<TAddress>,
        params: RelayAndAnnounceRelayParams<TAddress>,
    ): Promise<Hex>;

    /**
     * Requests a fee quote from a relayer for a withdraw-and-swap operation.
     *
     * A committed request (`commit: true`, carrying swapCalldata/swapTarget)
     * resolves to a {@link SwapRelayerQuote} with a signed `feeCommitment`. A
     * non-committed request (`commit: false`) is a fee estimate only and resolves
     * to an {@link UncommittedQuote} — the relayer returns no commitment.
     *
     * @param relayer - The relayer to request a quote from.
     * @param params - Parameters describing the swap to quote.
     * @returns A committed swap quote or a fee estimate, per `params.commit`.
     * @throws {RelayerInteractorBaseError}
     */
    getSwapQuote(
        relayer: RelayerInfo<TAddress>,
        params: SwapQuoteParams<TAddress> & { commit: true },
    ): Promise<SwapRelayerQuote<TAddress>>;
    getSwapQuote(
        relayer: RelayerInfo<TAddress>,
        params: SwapQuoteParams<TAddress> & { commit: false },
    ): Promise<UncommittedQuote>;
    getSwapQuote(
        relayer: RelayerInfo<TAddress>,
        params: SwapQuoteParams<TAddress>,
    ): Promise<SwapRelayerQuote<TAddress> | UncommittedQuote>;

    /**
     * Submits a unified swap transaction to a relayer via the RelaySwaps contract.
     * Uses proof-bound calldata (the full swapCalldata is committed in the ZK proof).
     * Handles both swap-only and reshield (via LiFi contractCalls).
     * @param relayer - The relayer to submit the transaction to.
     * @param params - The relay parameters including proof and the signed swap commitment.
     * @returns The transaction hash of the submitted transaction.
     * @throws {RelayerInteractorBaseError}
     */
    relaySwap(relayer: RelayerInfo<TAddress>, params: SwapRelayParams<TAddress>): Promise<Hex>;
}
