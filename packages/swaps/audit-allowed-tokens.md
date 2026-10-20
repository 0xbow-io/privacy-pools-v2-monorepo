Audited all three. Answers to your exact questions, then the findings that need action.

Your 3 questions

Q3 — can withdraw+swap be called expecting a non-pool token as input? NO. Solid, 3 independent layers:
- Circuit constrains tokenId === tokenIdOut (Transact.md §7) — prover can't claim arbitrary output token, must match spent notes
- Pool transfers exactly tokenIdOut to processor
- Contract approves only _token scoped to _amount - fee, resets to 0 after; native branch sends no approval. Any fromToken mismatch → LiFi transferFrom/msg.value fails → RelaySwaps_SwapFailed → whole tx reverts, pool funds returned. Delta-based sweep can't drain pre-existing stuck balances.
- Only residual risk is self-harm (caller hand-builds bad calldata, loses own funds, reverts anyway). No pool-theft path.

Q2 — swap output must be a token deposit supports? ENFORCED ON-CHAIN, but only reactively. Entrypoint.deposit requires _config.enabled (Entrypoint.sol:68) → Entrypoint_AssetNotEnabled(), plus minAmount + exact vettingFee. Output token unsupported → deposit reverts. BUT — see Finding A: whether that revert cleanly bubbles up is unverified.

Q1 — swap can't deposit into a non-pp contract? GAP FOUND — Finding B.

Findings ranked

A. HIGH / UNVERIFIED — reshield fund-loss if LiFi swallows the deposit revert. Reshield's on-chain guard is only require(_ok, SwapFailed()) on the top-level LiFi call. If LiFi's same-chain executor catches the inner Entrypoint.deposit revert and forwards swapped output to the receiver (= RelaySwaps) instead of reverting, then: top call returns true, contract doesn't revert, _sweepDust sends the output to the dustRecipient — the relayer (reshield default). User's funds withdrawn+swapped+handed to relayer, note never recreated.

Crux: is LiFi same-chain contractCalls atomic or catch-and-forward? Not determinable from
node_modules (only the client-side quote SDK lives there) — this is the one thing I can't
confirm; needs checking against the actual on-chain LiFi executor contract that
transactionRequest.to points at. If atomic → you're fine. If catch-and-forward → fund-loss
path. This directly gates your Q2.

B. HIGH (defense-in-depth) — reshield never validates depositResult.to is the pool. prepareReshieldQuote takes a caller-supplied depositResult and passes .to → LiFi toContractAddress with zero validation against the session's entrypoint. The happy path (prepareDeposit) hard-wires .to correctly, but nothing enforces that a hand-supplied depositResult is safe (only the happy path builds it internally). Cheap fix: assert depositResult.to === session.entrypointAddress.

C. MEDIUM — reshield doesn't validate the signed routing tuple — dustRecipient / outputToken / swapCalldataHash + amountSent. PoolSessionWithdrawAndSwap validates recipient and fallbackAddress; reshield has no equivalent. A malicious relayer can sign dustRecipient = itself (or any address) and keep the swept funds. Add the same assertions.

D. MEDIUM — maxRelayFee == 0 = no fee cap. RelaySwaps.sol:203-206: unconfigured/disabled asset → _maxFee == 0 short-circuits, fee bounded only by feeAmount <= _amount. Disabling an asset blocks deposits but NOT withdrawals (the transact path has no asset-config checks). So: deposit while the asset is enabled → asset later disabled → notes still withdrawable → relayer can take up to 100% of the withdrawal as fee. The zero-recipient sentinel work doesn't touch this.

E. LOW — no explicit fromToken == _token check. Safe today (LiFi facets are allowance/msg.value-gated), but TODOs at :180, :246 flag it. If the swapTarget set ever broadens to a "swap from contract balance" facet, mismatch-success becomes possible. Recommend explicit check or vetted swapTarget allowlist.

Want me to: (1) verify LiFi executor atomicity for Finding A, (2) fix B + C now (cheap SDK asserts), or both?
