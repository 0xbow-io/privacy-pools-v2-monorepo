# Conditional spending (Intents)

The protocol needs to support conditional spending—actions that execute only when certain conditions are met. 

<aside>
😀

For an deep dive on this topic, refer to this page

[Settlement Notes Idea](settlement-notes-idea.md)

</aside>

There are two families of intents with different privacy properties:

### 1. Public Intents (Hooks)

Public intents are straightforward extensions via the existing hook system. The proof includes a `payloadHash` as a public signal, binding it to the transaction. The contract decodes the payload and performs external calls to arbitrary addresses.

**Use cases:**

- DeFi integrations (swaps, lending deposits)
- Bridge interactions
- NFT purchases
- Any on-chain logic where the action itself isn't sensitive

**Limitation:** The conditions and execution are visible on-chain. This is acceptable when the *action* isn't private—only the *source of funds* needs protection.

### 2. Private Intents (Settlement Notes)

Private intents are harder. You want conditional logic that settles privately—like in-pool swaps where neither the terms nor the parties are revealed. Public hooks can't do this because the conditions would be visible.

**The core problem:** When Alice posts a limit order, she doesn't know who Bob is yet. She can't construct his output commitment—she doesn't know his label. She can't encrypt the note secrets for him—she doesn't know his keys.

**Settlement Notes** solve this using the same commitment structure as standard notes, but with different semantics for the first slot and the metadata field:

```
// Standard note
precommitment = Poseidon(noteAddressHash, tokenId, value, metadata)
    where noteAddressHash = Poseidon(ownerAddress, noteSecret)
    and   metadata = 0

// Settlement note
precommitment = Poseidon(nullifierSecret, tokenId, value, metadata)
    where metadata = Poseidon(SETTLEMENT_TYPE, makerAddressHash, tokenOut, minAmountOut, expiry, ...)

```

**The design:**

1. **First slot is the authorization source.** In standard notes, `noteAddressHash` determines who can spend (whoever owns the address). In settlement notes, `nullifierSecret` determines who can spend (whoever knows the secret). Both answer "what do you need to nullify this note?"
2. **Metadata carries the conditions.** The settlement terms—token pair, minimum amount, maker's address for outputs, expiry—are encoded in metadata. The circuit unpacks and verifies them.
3. **Same structure, different interpretation.** The commitment formula is identical. Circuits route on metadata: `metadata = 0` means standard note (verify keystore ownership), `metadata = Poseidon(SETTLEMENT_TYPE, ...)` means settlement note (verify conditions satisfied).

**The flow:**

1. Alice creates an intent note: `nullifierSecret` in the first slot, settlement conditions in metadata
2. Alice shares the conditions + `nullifierSecret` with potential settlers
3. Bob settles atomically: nullifies the intent (proving knowledge of `nullifierSecret`), nullifies his input notes, creates outputs for both parties
4. Labels cross: Alice receives Bob's label, Bob receives Alice's label (taint follows the asset)

**Why this structure:** The first slot always answers "who can spend this note?" For owned notes, it's the address hash. For settlement notes, it's the nullifier secret. Metadata always answers "under what conditions?" This separation is clean and symmetric.

**Implementation note:** Settlement Notes are an additive extension. Standard notes continue using `noteAddressHash` + `metadata = 0`, and the existing `transact` circuit remains unchanged. Settlement Notes introduce dedicated `createIntent`/`settle` circuits that interpret non-zero metadata. This can be built later without touching the core protocol.

### 3. Open Questions

- **Announcement protocol:** How does Bob discover Alice's intent? Single-stage (public orderbook) vs two-stage (private negotiation) has different privacy tradeoffs.
- **Partial fills:** Can Bob fill only part of Alice's order?
- **Expiry:** Should intents have time bounds?
- **Spy protection:** If Alice shares `nullifierSecret` with a potential settler who never settles, she must cancel and rotate to prevent information leakage.