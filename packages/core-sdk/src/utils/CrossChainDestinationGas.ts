/**
 * Gas budget the aggregator (LiFi `toContractGasLimit`) gives the destination call of a
 * cross-chain swap-and-deposit. One flat figure for every destination call (Entrypoint or yield
 * router, with or without a destination swap), not estimated: the call is proof-bound, and an
 * `eth_estimateGas` of the real calldata would hand the deposit proof to the destination RPC
 * before the bridge lands it.
 *
 * Evidence (prod, Ethereum to BNB Chain reshields, 2026-10-07..13), all with the old flat 800k:
 * - 0xf0827010...b593f: yield router depositExactShares (Aave supply + mint + Entrypoint deposit)
 *   burned 710k, the pairing precompile got 128k and failed, PoolVault_InvalidDepositProof.
 * - 0x41381cfd...c260: pool deposit ran out of gas at the reentrancy sentry. A fork replay of its
 *   depositExactShares call needs ~1.1M.
 * - 0x69bae2c7...4e88: router given 1.03M, Entrypoint deposit alone took 545k, out of gas.
 * - A cross-chain swap-deposit used up to 1.5M gas on the destination (reported 2026-10-13).
 *
 * 2M leaves ~33% over the heaviest seen, for tree growth and lending-market state drift.
 *
 * Bridges that carry the budget to the destination (StargateV2 / LayerZero executor options) give
 * the call exactly this much gas. Across does not: its filler picks the fill's gas limit itself and
 * LiFi's ReceiverAcrossV3 forwards whatever is left, and LiFi's Across quote does not move with this
 * figure (measured 2026-10-15); evm-sdk's LiFiAcrossHeadroom.ts pays that filler instead.
 *
 * Cost: on a Mainnet destination the LayerZero native fee scales with this budget (B2 funds it
 * with 1.2x headroom), so it also moves how soon `max_swap_value_wei` trips during a gas spike.
 */
export const CROSS_CHAIN_DESTINATION_GAS_LIMIT = "2000000";
