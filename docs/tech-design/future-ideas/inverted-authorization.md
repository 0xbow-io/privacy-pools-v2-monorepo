# Inverted Authorization

The standard authorization model places ultimate authority with the `ownerAddress`: the owner registers keys, can update the `authorizerDigest`, and can revoke or change the designated authorizer. The authorizer is a *delegated* entity with limited powers (creating intents). This section explores an **inverted model** where the authorizer becomes the principal with ultimate control.

### 1. Motivation

Consider a user who wants to:

1. Approve a payment (or series of payments) in advance
2. Outsource the actual execution to a third party (hot wallet, payment service, automated agent)
3. Retain the ability to revoke the third party's spending power at any time

The standard model does not cleanly support this. While the intent mechanism allows per-transaction delegation, it requires the authorizer to create a new intent for every transaction. The inverted model provides **standing authorization** with revocability.

### 2. Conceptual Model

In the inverted model:

- The **Principal** (authorizer) has ultimate authority over the key registry entry
- The **Agent** (spender) holds keys that authorize spending but cannot modify the registry

| Aspect | Standard Model | Inverted Model |
| --- | --- | --- |
| Ultimate authority | `ownerAddress` | `authorizerAddress` |
| Can update keys | Owner | Authorizer |
| Can revoke | Owner revokes authorizer | Authorizer revokes spender |
| Spending method | Direct keys or intent | Direct keys (standing authorization) |

### 3. Implementation Sketch

The core idea is to extend the `keyRegistry` leaf with a boolean flag (`isInverted`) that determines:

1. Which address (`ownerAddress` or `authorizerAddress`) the contract checks `msg.sender` against for registry updates
2. The semantic meaning of the `authorizerDigest` field

In the standard model, `authorizerDigest` commits to the authorizer (hidden). In the inverted model, the roles swap: the authorizer becomes the public admin, and the digest would instead commit to the spender's keys.

| Mode | Admin (for registry updates) | Hidden in digest |
| --- | --- | --- |
| Standard (`isInverted = 0`) | `ownerAddress` | `authorizerAddress` |
| Inverted (`isInverted = 1`) | `authorizerAddress` | spender keys |

The exact leaf structure and circuit modifications require further design work, but the boolean flag provides a clean mechanism to support both models within the same registry without introducing separate data structures.

### 4. Security Considerations

1. **Trust Inversion:** The spender has no recourse against revocation. This is intentional for the delegation use case but represents a different trust model than standard accounts.
2. **Ragequit Implications:** The `ragequit` mechanism withdraws to the `ownerAddress` baked into the note. In the inverted model, should this be the principal or the spender? If the principal, the spender cannot recover funds if revoked. If the spender, the principal loses their failsafe. This requires careful design.
3. **Key Compromise:** If the principal's admin key is compromised, an attacker can revoke legitimate spenders and install their own. Unlike the standard model where key rotation protects the user, here the principal must maintain strict key security.

### 5. Use Cases

1. **Institutional Custody:** A treasury committee (principal) authorizes an operations team (spender) to execute pre-approved payments.
2. **Subscription Services:** A user (principal) authorizes a service (spender) to pull payments, revocable at any time.
3. **Parental Controls:** A parent (principal) gives a child (spender) limited spending ability with full oversight.
4. **Cold/Hot Wallet Separation:** A cold wallet (principal) authorizes a hot wallet (spender) for day-to-day transactions.