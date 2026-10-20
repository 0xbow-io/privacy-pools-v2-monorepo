# @privacy-pools-v2/dust-rescue-prover

Isolated proving module for `PoolSessionReshieldCrosschain`'s stealth dust rescue. See
`docs/tech-design/core-sdk/pool-session.md` §Stealth Dust Rescue and
`docs/tech-design/core-sdk/withdraw-and-swap.md` §Cross-Chain Reshield for the full design and
accepted trust extension; `agents/deviations.md` INTL-09 tracks this package's history.

## Why a separate package

Every other action in `packages/relayer/relayer` is client-request-triggered and thin
(validate → sign/submit). This module is the opposite: relayer-initiated, CPU/memory-heavy
(Groth16 proving over the deposit circuit), and keyless (it never holds a chain-signing key —
only the caller, `DustRescueOrchestratorService`, submits transactions). Keeping it a separate
package with a narrow job contract (`{ destinationChainId, tokenId, sweptAmount,
recipientIdentifier } -> { stealthAddress, noteValue, depositCallData, depositTarget,
depositMsgValue, approvalTx }`) is what lets it be split into its own deployed process later
without touching the main relayer app — v1 calls it in-process.

## What it does

`proveDustRescueDeposit(job, config)`:

1. Derives a fresh ERC-5564 stealth address for `job.recipientIdentifier` (reuses
   `@privacy-pools-v2/evm-sdk/stealth`'s `resolveRecipient` / `generateEphemeralKeyPair` /
   `deriveStealthAddress` — same functions the SDK already uses client-side for withdrawal
   payouts, now invoked server-side for the first time) — and its ECDH shared secret via the
   `deriveStealthSharedSecret` export.
2. Builds a throwaway `PoolSession` (via `PoolSessionBuilder`) scoped to `job.destinationChainId`,
   with fresh, random protocol keys — irrelevant to the resulting note's ownership, since it's
   bound entirely to the stealth address, not this session's own identity.
3. Nets the destination Entrypoint's live vetting fee out of `job.sweptAmount` to get the
   actual note value (`computeRescueNoteValue`, a throwaway `EntrypointInteractor.getAssetConfig`
   read): the rescue wallet only ever holds `sweptAmount`, but `Entrypoint.deposit` pulls
   `value + value*vettingFeeBPS/10000` from the sender, so sizing the note at the raw swept
   amount left every fee-bearing deposit short by exactly the fee. Throws if the netted value
   falls below the Entrypoint's `minAmount`. This netted `noteValue` — not `job.sweptAmount` —
   is what's actually used from here on, and is echoed back in the result.
4. Calls `prepareDepositFor()`'s "blind cold-start" path (`noteAddressHash` pre-computed, no
   note announcement) for that netted `noteValue`, generating a fresh `noteSecret`.
5. Encodes the full note payload (`noteSecret`, `value`, `tokenId`, `label` — the same four
   fields any ordinary `NoteData` payload carries) and encrypts it under the stealth shared
   secret (`CryptoService.encrypt`, the same XChaCha20-Poly1305 primitive that already
   encrypts ordinary `NoteData` payloads).
6. Packs the ephemeral pubkey, view tag, and encrypted payload into a single opaque blob
   (`encodeStealthDepositPayload`, `@privacy-pools-v2/evm-sdk/stealth`) and swaps it in for
   `prepareDepositFor()`'s own `noteData.data` — the resulting calldata is still an ordinary
   `Entrypoint.deposit(proof, noteData, aspCiphertext)` call, no new Solidity, no distinct
   selector or event.

## Secret delivery (resolved — "Camouflaged dust-rescue delivery")

`noteSecret` has no channel via the SDK's normal NoteData/viewing-key discovery — a stealth
address never registers a viewing key. The ERC-5564 `metadata` field is fixed at 1 byte, too
small to carry a secret either. An earlier design (`RelaySwaps.rescueDust`/`DustRescued`)
delivered the encrypted secret via a distinctly-named event — publicly tagging every rescue
deposit and shrinking its anonymity set, contradicting the feature's anonymity requirement.
Resolved instead by reusing the ECDH shared secret the stealth derivation already computes
internally (step 1 above) and packing the encrypted payload straight into the deposit's own
`noteData.data` (arbitrary-length, unlike ERC-5564's `metadata`): the recipient, after a
positive `scanDepositNoteData` match (`@privacy-pools-v2/evm-sdk/stealth`'s sibling to
`scanAnnouncement`, wired into `NoteDiscoveryService.scanStealthDeposits`), decrypts the
payload with the shared secret it already recovered as part of that match.

## Submission

`proveDustRescueDeposit()` only computes the deposit call — it never holds a chain-signing
key and never submits anything itself (see "Why a separate package" above). The caller
that does submit it is `packages/relayer/dust-rescue-service`'s `SweepService`, a
standalone GCP Cloud Run service (see `docs/tech-design/relayer/dust-rescue-service.md`)
that also owns detection (is a rescue actually ready?) and the Firestore-backed job state
machine. The relayer's own `DustRescueOrchestratorService` no longer calls this function
at all — it's a thin `Scope.REQUEST` Pub/Sub publisher that only registers a pending job
for the other service to pick up.

## Config

`DustRescueProverConfig` (`rpcUrl`, `aspUrl`, `circuitArtifactsDir`, optional `deployment`
override) is resolved per destination chain by the caller — `dust-rescue-service`'s own
config (`chains[].aspUrl` / `chains[].circuitArtifactsDir` in its
`dust-rescue-service.config.json`, see that package's README), not the relayer's. The
relayer no longer carries these fields at all (they moved here when submission moved out
of the relayer).
