# PROPERTIES

## Property list

### PP2-0: setup

Reserved for sanity checks on the setup of protocol contracts

### PP2-1: normal wind-down

Precondition:

- Contracts are not paused
- Every unspent commitment is fully withdrawn via `transact`
- Funds in the Entrypoint are swept

Check(for every token):
`token.balanceOf(Entrypoint) == token.balanceOf(PoolVault) == token.balanceOf(PrivacyPoolRelay) == 0`

### PP2-2: paused wind-down

Precondition:

- Contracts are paused
- Every unspent commitment is fully withdrawn via `ragequit`
- Funds in the Entrypoint are swept

Check(for every token):
same as PP2-1

### PP2-3: total token balance: PoolVault

Precondition: None

Check:
For every token supported by the protocol:
`token.balanceOf(PoolVault) == sumOfAll(deposit.amount) - sumOfAll(transact.amountOut) - sumOfAll(ragequit.amount)`

### PP2-4: total token balance: Entrypoint

Precondition: None

Check:
For every token supported by the protocol:
`token.balanceOf(Entrypoint) == sumOfAll(deposit.vettingfee) - sumOfAll(feeSwept)`

### PP2-5: total token balance: PrivacyPoolRelay

Precondition: None

Check:
`token.balanceOf(PrivacyPoolRelay) == 0`

### PP2-6: label value conservation (global)

Check:
For every label on every token:
`sumOfAll(commitment.value * !commitment.spent) == sumOfAll(deposit.value) - sumOfAll(transact.amountOut) - sumOfAll(ragequit.value)`

Consideration:
We will assert on this via ghost variables tracking the label's balance, as there's no such thing as an on-chain `balanceOf(label)`

### PP2-7: label value conservation (at the transaction level)

Check:
On successful transactions, for every label:
`sumOfAll(inputNote.amount) == sumOfAll(outputNote.amount) + transact.amountOut`

Consideration:
It would be worth it to have a dedicated handler/checker for this, which attempts to transact with varying amounts, with an otherwise valid setup, and ensures all reverts are caused by the amounts not matching

### PP2-8: value of commitments for a label should match contract balance

Check:
For every unspent commitment on every token:
`sumOfAll(commitment.value) == token.balanceOf(PoolVault)`

Consideration:
We will assert on this via ghost variables tracking the commitment's balance, as there's no such thing as an on-chain `balanceOf(commitment)`

### PP2-9: transact always inserts exactly N+M leaves

Check:
Ensure the difference in state tree size before and after a transact call is exactly the amount of spent notes + the amount of newly created notes

### PP2-10: a given nullifier can only be spent once

On handler: when a transact succeeds, all used nullifiers were previously marked as non-spent

### PP2-11: no free withdrawal

Check: A given actor can only withdraw up to `sumOfAll(deposits[actor]) + sumOfAll(transferredInto[actor]) - sumOfAll(transferredOut[actor]) - sumOfAll(withdrawals[actor])`

Consideration: this will be asserted through ghost variable tracking, due to internal balances in the protocol being of course private

### PP2-12: ragequit always inserts exactly one leaf

Check: Ensure the difference in state tree size before and after a successful ragequit call is exactly one

### PP2-13: only a note's owner can ragequit it

On-handler:
After a successful ragequit, ensure the note owner was the current actor

Consideration:
Make sure to include an unguided handler where msg.sender can be fuzzed freely

### PP2-14: current root matches the Merkle tree

After every deposit, transact, or ragequit, the root stored in the circular buffer must equal the actual Merkle tree root.

Check: `roots[currentRootIndex] == stateTree.root`

### PP2-15: commitment existence implies a leaf in the state tree

Check: For every commitment C where `commitments[C] != 0`, the leaf `hash(C, commitments[C])` must exist in the state tree.

### PP2-16: spent nullifier implies a leaf in the state tree

Mirror of the above, but for nullifiers

Check: for every N where `spentNullifiers[N] != 0`, leaf `hash(N, spentNullifiers[N])` must be in the tree.

### PP2-17: relay fee conservation

Precondition: a successful `PrivacyPoolRelay.relay()`

Check: `recipient.received + feeRecipient.received == proof.amountOut`

### PP2-18: state tree size equation

Check: `stateTree.size == len(deposits) + sumOfAll(transact.n + transact.m) + len(ragequits)`

### PP2-19: Transact processor

The designated processor must always equal the caller.

Precondition: a successful `PoolVault.transact()`

Check: `_transactParams.processor == msg.sender`.

Consideration: to be implemented as part of the unguided transact handler

### PP2-20: ASP root
Precondition: a successful `PoolVault.transact()`

Check:  `_proof.associationSetRoot() == ASP_REGISTRY.latestASPRoot()`

Consideration: to be implemented as part of the unguided transact handler

### PP2-21: Only users registered in the keystore are able to transact
Precondition: a valid deposit on the actor's name

Check: to be implemented as part of the transact handler, using an invalid/empty inclusion proof in the case where the actor is not registered in the keystore

Consideration: We'd need to include a keystore registration handler

## Considerations

- Unguided handlers may withdraw to/pay fees to the protocol contract's addresses, we should probably account for it, since disallowing it may prevent other useful state transitions. Applies to PP2-{1,2,3,4,5,6,8}
- Similar to the above, when withdrawing through `PrivacyPoolRelay`, we should track the balance as going to `PayoutRouting.recipient` even though the `PoolVault` sends the funds to `PrivacyPoolRelay`
- Since having arbitrary note values is going to make the _possible_ calls grow significantly faster than the _valid_ calls, we should consider implementing a handler that's more guided by deliberately choosing a valid set of inputs and outputs
