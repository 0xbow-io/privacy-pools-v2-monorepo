import type { Hex } from "../internal.js";

// NOTE (core-sdk split): extracted from packages/sdk/src/types/PoolSessionReshieldCrosschain.ts
// (a cross-chain-reshield type file otherwise excluded from core-sdk — see the migration report).
// `StealthRecipientIdentifier` itself has no dependency on anything reshield/swap-specific and is
// needed by the chain-agnostic types/RelayerInteractor.ts (RelaySwapDustRescue/SwapRelayParams,
// referenced by IRelayerInteractor.getSwapQuote/relaySwap — a relayer contract PoolSessionWithdraw
// and PoolSessionTransfer depend on even though core-sdk doesn't ship a swap session class), so it
// was carved out on its own rather than dragging in the rest of that file.

/**
 * Structural mirror of the stealth sub-package's `RecipientIdentifier`
 * (`packages/sdk/src/stealth/resolve.ts`), redeclared here with the SDK's own
 * `Hex` type rather than importing the stealth module's branded types —
 * matches the containment pattern `stealth/relayBridge.ts` already uses in
 * the opposite direction (INTL-01: the stealth sub-package stays isolated
 * from the main SDK barrel). A consumer that needs the real `RecipientIdentifier`
 * (the relayer's dust-rescue prover, which imports `@privacy-pools-v2/evm-sdk/stealth`
 * directly) casts at its own boundary; the two shapes are structurally identical.
 */
export type StealthRecipientIdentifier =
    | { readonly kind: "raw"; readonly spendingPubKey: Hex }
    | { readonly kind: "canonical"; readonly spendingPubKey: Hex; readonly viewingPubKey: Hex };
