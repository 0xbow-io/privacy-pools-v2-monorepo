# Cross-Chain Destination Verifier

The current cross-chain withdraw-and-swap flow delegates output verification to LiFi's destination executor: the source-chain `RelaySwaps` contract sets `SwapRouting.recipient = address(0)` and `minOutputAmount = 0`, and the destination-side `minAmountOut` lives only inside the proof-bound LiFi calldata. This is proof-bound and therefore relayer-tamper-proof, but the actual enforcement of slippage on the destination chain is performed by LiFi's executor infrastructure — a trusted third party — rather than by protocol-owned code.

Once the protocol is deployed on multiple chains, this trust assumption can be removed by deploying our own **destination verifier** contract on each supported destination chain:

1. **Protocol-owned receiver:** A small, stateless contract deployed on every destination chain the protocol supports. Instead of LiFi delivering the output token directly to the user, the LiFi `contractCalls` in the proof-bound calldata target this verifier.
2. **Trustless minOutput check:** The verifier receives the swap output, checks `amountReceived >= minOutput` against parameters encoded in the (proof-bound) call, and reverts otherwise. Since the calldata — including the verifier address, the minimum amount, and the final recipient — is hash-committed in the ZK proof context on the source chain, neither the relayer nor LiFi can weaken the check.
3. **Forward to user:** On success, the verifier forwards the full output to the user's destination-chain address. On failure, LiFi's standard fallback path applies (bridged token to `toFallbackAddress`), so no funds are ever held by the verifier.

This restores the same trustless slippage guarantee that same-chain swaps get from the `RelaySwaps` recipient balance-delta check, and that reshield gets from the `Entrypoint.deposit()` revert — closing the one mode where enforcement currently relies on LiFi's destination executor.

## Related Work: Admin Rescue/Sweep for Stuck Bridge Refunds

A known limitation of the current cross-chain flow is the bridge-refund leg: some bridges, on failure while funds are in flight, refund on the **source** chain to the depositor — which is the `RelaySwaps` contract itself. The contract's dust sweep is delta-only (scoped to a single execution's balance deltas), so such refunds are currently stuck with no rescue path. An admin rescue/sweep function on `RelaySwaps` is planned in a separate PR to recover these funds; it is complementary to the destination verifier, which reduces (but does not eliminate) the failure surface on the destination side.
