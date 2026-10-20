import type { Address, Hex, PreparedTransaction } from "@privacy-pools-v2/evm-sdk";

/**
 * Structural mirror of the SDK's `StealthRecipientIdentifier`
 * (`packages/sdk/src/types/PoolSessionReshieldCrosschain.ts`), which is itself
 * a structural mirror of the stealth sub-package's `RecipientIdentifier`. This
 * module casts across the boundary once, in `proveDustRescueDeposit.ts` — see
 * the comment there — rather than importing either type directly, keeping
 * this package's public surface independent of the SDK's internal type graph.
 */
export type StealthRecipientIdentifier =
    | { readonly kind: "raw"; readonly spendingPubKey: Hex }
    | { readonly kind: "canonical"; readonly spendingPubKey: Hex; readonly viewingPubKey: Hex };

/**
 * A dust-rescue job dispatched by the relayer's orchestrator once it has
 * confirmed the actual destination-chain leftover for a cross-chain reshield
 * request that opted into rescue. The amount is only known at this point —
 * never earlier, and never supplied by the client (see the package
 * description for why).
 */
export interface ProveDustRescueDepositJob {
    /** Chain the leftover was observed on and will be deposited into. */
    destinationChainId: number;
    /** Token the leftover is denominated in. */
    tokenId: Address;
    /** The actual swept amount to rescue, in the token's smallest unit (hex-encoded). */
    sweptAmount: Hex;
    /** Stealth recipient identifier echoed from the client's original opt-in. */
    recipientIdentifier: StealthRecipientIdentifier;
}

/**
 * Configuration for running the prover against a specific destination chain.
 * Deliberately carries no chain-signing key — this module never submits a
 * transaction itself; it only computes calldata for the orchestrator (which
 * already holds the relayer's signer) to submit.
 */
export interface DustRescueProverConfig {
    /** JSON-RPC endpoint for `destinationChainId`. */
    rpcUrl: string;
    /** ASP HTTP endpoint for `destinationChainId` (deposits require ASP compliance ciphertext). */
    aspUrl: string;
    /** Local filesystem path to the deposit circuit's artifacts (wasm/zkey). */
    circuitArtifactsDir: string;
    /** Optional explicit deployment override; otherwise resolved from the SDK's `DEPLOYMENTS[destinationChainId]`. */
    deployment?: {
        poolAddress: Address;
        entrypointAddress: Address;
        keystoreAddress: Address;
        aspRegistryAddress: Address;
    };
}

/**
 * Everything the orchestrator needs to submit the rescue: a single, ordinary
 * `Entrypoint.deposit(proof, noteData, aspCiphertext)` call on the destination chain
 * — the exact same call shape any third-party `depositFor` caller already uses, no
 * distinct selector or event (see "Camouflaged dust-rescue delivery",
 * `cross_chain_reshield_plan.org`). The encrypted note payload is packed into
 * `noteData.data` itself (`@privacy-pools-v2/evm-sdk/stealth`'s
 * `encodeStealthDepositPayload`), decryptable by the recipient using the same ECDH
 * shared secret they already compute to recognize `stealthAddress` as their own —
 * see `deriveStealthSharedSecret`/`recoverStealthSharedSecret` in that same module.
 */
export interface ProveDustRescueDepositResult {
    /** The stealth address the rescue deposit's note is owned by. */
    stealthAddress: Address;
    /** The note's actual value, in the token's smallest unit — `sweptAmount` netted
     * of the destination Entrypoint's live vetting fee (finding #8), i.e. what the
     * recipient's note is really worth. Distinct from the job's own `sweptAmount`,
     * which stays "what was delivered" for USD-worth pricing elsewhere. */
    noteValue: Hex;
    /** ABI-encoded `Entrypoint.deposit(proof, noteData, aspCiphertext)` calldata. */
    depositCallData: Hex;
    /** Destination-chain Entrypoint address (transaction target). */
    depositTarget: Address;
    /** ETH value to send with the deposit transaction (value + vetting fee for native, 0x0 for ERC-20). */
    depositMsgValue: Hex;
    /** ERC20 approval to submit before the deposit, or null if not needed (always null for native ETH). The last of `approvalTxs`. */
    approvalTx: PreparedTransaction | null;
    /** Every ERC20 approval to submit, in order, before the deposit: two when the shared wallet holds a
     * residual allowance on a token that requires a zero reset (mainnet USDT), else one or none (minr #28). */
    approvalTxs: PreparedTransaction[];
}
