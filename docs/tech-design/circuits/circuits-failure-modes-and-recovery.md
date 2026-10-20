# Circuits -  Failure Modes and Recovery Path Analysis

| Author | *@Lumi 0x*  |
| --- | --- |
| Created at | 2026-22-01 |
| Initial Reviewers | *@moebius, @parti, @Titi 0x*  |
| Need Approval From | *@ng, @Simon Something*  |
| Status | *Draft* |

## Introduction

This document covers the Failure Mode Analysis (FMA) for Privacy Pools V2 ZK circuits. Privacy Pools V2 is a privacy-preserving protocol that enables compliant shielded transactions on Ethereum using Association Set Providers (ASPs) for regulatory compliance while maintaining user privacy.

The circuit system consists of three main circuits:

- **`Deposit`**: Entry point for funds into the shielded pool
- **`Transact`**: Private transfers and public withdrawals with ASP compliance
- **`Ragequit`**: Emergency withdrawal bypassing ASP compliance (failsafe mechanism)

For reference, see [Circuits - Tech Design](circuits-tech-design.md). 

<aside>
📌

Note that we use the word **under-constrained** to reference a circuit that is missing constraints necessary to verify inputs or intermediate values properly. An **over-constrained** circuit contains contradictory constraints, making it impossible to generate a valid witness even for legitimate inputs.

</aside>

## Failure Modes and Recovery Paths

### FM1: Under-Constrained Circuit - Value Overflow

- **Description:** If value inputs are not properly range-checked with `Num2Bits(128)`, an attacker could provide values that overflow the BN128 field (~254 bits), allowing them to create or destroy value. For example, providing a negative value that wraps around to a large positive value could bypass conservation checks.
- **Risk Assessment:** High impact / Low likelihood (range checks are implemented where needed)
- **Mitigations:**
    1. Deposit circuit: `Num2Bits(128)` on value ✅
    2. Transact circuit: `Num2Bits(128)` on input and output values ✅
    3. Ragequit circuit: No range check by design - relies on Deposit having enforced range check at commitment creation time. Security depends on contract verifying output commitment exists in state tree (see FM14).
    4. ValueConservation helper uses `LessEqThan(128)` for conservation comparisons
    5. Static analysis with circomspect catches missing range checks
- **Detection:**
    - Circomspect static analysis in CI
    - zkFuzz mutation testing (local)
    - Manual audit of constraint count vs expected
- **Recovery Path(s):** If discovered pre-deployment, fix circuit and regenerate proving keys (new trusted setup ceremony). If discovered post-deployment, pause contract, migrate, deploy fixed circuit.

### FM2: Under-Constrained Circuit - Merkle Proof Verification

- **Description:** If Merkle proof verification is under-constrained, an attacker could prove membership of non-existent notes in the state tree, ASP association set, or keystore. This would enable spending non-existent funds or bypassing ASP compliance.
- **Risk Assessment:** High impact / Low likelihood (using audited zk-kit library)
- **Mitigations:**
    1. Using audited `BinaryMerkleRoot` from zk-kit (not custom implementation)
    2. Depth validation: circuits check `treeDepth ≤ maxDepth`
    3. Root outputs are constrained against public inputs
- **Detection:**
    - Library version pinning and audit trail
    - Integration tests with invalid Merkle proofs
    - Formal verification (CIVER) when compatible
- **Recovery Path(s):** Same as FM1 - requires circuit fix and new trusted setup if vulnerability exists.

### FM3: Nullifier Collision / Double-Spend

- **Description:** If two different notes produce the same nullifier, an attacker could spend both notes but only have one nullifier marked as spent on-chain. The nullifier scheme is `Poseidon(privateNullifyingKey, commitment)`.
- **Risk Assessment:** High impact / Very low likelihood
- **Mitigations:**
    1. Commitments include unique components: `ownerAddress`, `noteSecret`, `tokenId`, `value`, `label`
    2. Each deposit generates unique `label` via random `depositSecret`
    3. Contract enforces nullifier uniqueness via `mapping(bytes32 => bool)`
    4. Poseidon hash is collision-resistant
- **Detection:**
    - On-chain monitoring for nullifier reuse attempts
- **Recovery Path(s):** If collision found, investigate root cause. If due to compromised `privateNullifyingKey`, user must ragequit remaining funds and create new keystore entry.

### FM4: Second Nullifier Computation for Spent Commitment

- **Description:** A more likely variant of nullifier attacks: computing a second valid nullifier for a commitment that has already been spent. If an attacker can find an alternative `privateNullifyingKey'` such that `Poseidon(privateNullifyingKey', commitment) = nullifier'` (a different nullifier for the same commitment), they could spend the same note twice.
- **Risk Assessment:** High impact / Very low likelihood (requires breaking Poseidon preimage resistance)
- **Mitigations:**
    1. Poseidon preimage resistance: finding a different key that produces a valid nullifier for the same commitment is computationally infeasible
    2. The `privateNullifyingKey` must also match the `nullifyingKeyHash` in keystore (not just any key that hashes to a different nullifier)
    3. Circuit enforces: `nullifyingKeyHash === Poseidon(privateNullifyingKey)` must match keystore entry
- **Detection:**
    - Same commitment being spent with different nullifiers would indicate break
    - On-chain monitoring for commitments appearing in multiple spend attempts
- **Recovery Path(s):** If Poseidon is broken, this is a catastrophic cryptographic failure requiring full protocol migration.

### FM5: Key Compromise. Nullifying and Revocable Keys

- **Description:** To spend funds via Transact, an attacker needs BOTH the `privateNullifyingKey` (to compute valid nullifiers) AND the `privateRevocableKey` (to prove keystore authorization). Compromise only one key is insufficient to steal funds. However, if both keys are compromised, the attacker can spend user's funds. The nullifying key is immutable by design (cannot be rotated without losing funds).
- **Risk Assessment:** High impact / Variable likelihood (depends on user key management)
- **Mitigations:**
    1. Two keys: attacker must compromise both keys to spend
    2. Ragequit allows emergency withdrawal to `ownerAddress`, so an attacker cannot redirect it even with both keys compromised.
    3. Revocable key can be rotated to revoke Transact access.
- **Detection:**
    - User monitoring of their notes/nullifiers
- **Recovery Path(s):** User immediately ragequits all remaining notes to recover funds (works even if revocable key is compromised, since ragequit uses `ownerAddress`). Create new keystore entry with fresh keys. Funds in compromised notes already spent are lost.

### FM6: Value Conservation Bypass - Global

- **Description:** If global value conservation (`Σ inputs = Σ outputs + amountOut`) is not properly enforced, an attacker could create value from nothing or destroy value to grief other users.
- **Risk Assessment:** High impact / Low likelihood
- **Mitigations:**
    1. `ValueConservation` helper explicitly enforces `totalIn === totalOut`
    2. `amountOut` participates in the sum as public output
    3. All values are range-checked to prevent overflow
- **Detection:**
    - Unit tests with conservation violations
    - Fuzz testing with random value combinations
    - On-chain monitoring: total deposits vs total withdrawals over time
- **Recovery Path(s):** If exploited, pause contract, analyze exploit, deploy fixed circuit with new ceremony.

### FM7: Value Conservation Bypass - Per-Label

- **Description:** Per-label conservation ensures taint isolation (funds from one label cannot mix with another). If bypassed, an attacker could launder tainted funds by mixing labels.
- **Risk Assessment:** Medium impact (privacy/compliance) / Low likelihood
- **Mitigations:**
    1. `ValueConservation` enforces per-label: `Σ inputValues[L] ≥ Σ outputValues[L]` for each label
    2. `IsEqual` from `circomlib` is audited and outputs boolean
    3. Inequality allows "burning" within a label but not cross-label mixing
- **Detection:**
    - Unit tests attempting cross-label transfers
    - Formal verification of conservation properties
- **Recovery Path(s):** If exploited for compliance evasion, ASP can revoke affected labels. Users of those labels must ragequit. For recovery, users may need to present proofs of their labels to demonstrate compliance, this would leak some privacy but could be implemented as a dedicated "compliance proof" circuit that reveals label ownership without revealing full note details.

### FM8: ASP Compliance Bypass in Transact

- **Description:** If ASP tree verification is bypassed, users could spend notes with unregistered or revoked labels, defeating the compliance mechanism.
- **Risk Assessment:** Medium impact (compliance) / Low likelihood
- **Mitigations:**
    1. Each input note's `Poseidon(label)` must exist in ASP association set tree
    2. `associationSetRoot` is a public input verified by contract
    3. ASP publishes root updates; contract validates via trusted mechanism
- **Detection:**
    - Contract verification of `associationSetRoot` against ASP
    - Monitoring ASP tree for unauthorized label additions
- **Recovery Path(s):** If bypass discovered, pause contract, investigate. ASP can publish corrected root. Users with invalid proofs will fail verification.

### FM8: Trusted Setup Compromise (Groth16 Toxic Waste)

- **Description:** Groth16 requires a trusted setup ceremony. If the "toxic waste" (randomness used in ceremony) is not properly destroyed, an attacker could forge proofs for any statement.
- **Risk Assessment:** Critical impact / Very low likelihood (with proper ceremony)
- **Mitigations:**
    1. Use established powers of tau ceremony (Hermez, Zcash, KZG Ceremony from Ethereum Foundation, etc.)
    2. Circuit-specific Phase 2 ceremony with multiple participants
    3. At least one honest participant guarantees security
    4. Publish ceremony transcripts for verification
- **Status:** The committed keys of all 27 circuits come from the `ppv2-ceremony` phase-2 ceremony (2026-07-08 → 2026-07-14): 500 contributions per circuit from 597 distinct participants, followed by a beacon contribution (RANDAO reveal of Ethereum beacon slot 14767039, 2^10 iterations). Phase 1 is the PSE perpetual powers of tau (`ppot_0080_18.ptau`). Provenance, transcript and verification steps: [`packages/circuits/CEREMONY.md`](../../../packages/circuits/CEREMONY.md).
- **Detection:**
    - Cannot detect if toxic waste was retained
    - Forged proofs would pass verification but create invalid state
    - On-chain anomaly detection (impossible state transitions)
- **Recovery Path(s):** If compromise suspected, pause contract, conduct new ceremony with fresh randomness, migrate funds, redeploy.

### FM9: Public Input Manipulation

- **Description:** If public inputs don't participate in non-linear constraints, a malicious prover could modify them without invalidating the proof. This could allow proof reuse across different transactions.
- **Risk Assessment:** High impact / Low likelihood
- **Mitigations:**
    1. `context` binding: `context * context` provides weak non-linear constraint
    2. Contract must independently verify `context = Poseidon(amountOut, tokenIdOut, recipientAddress, fee)`
    3. Roots (`stateRoot`, `keystoreRoot`, `associationSetRoot`) participate in Merkle verification (non-linear)
    4. Nullifiers and commitments are deterministic from private inputs
- **Detection:**
    - Contract tests for context verification
    - Audit public input participation in constraints
- **Recovery Path(s):** Contract-level fix if context verification missing. Circuit fix if constraint missing.

### FM10: Groth16 Proof Malleability (Negative Proof Values)

- **Description:** Groth16 proofs can be malleable, specifically, negating certain proof elements can produce a different valid proof for the same statement. If the Solidity verifier doesn't properly handle this, an attacker could potentially reuse or modify proofs.
- **Risk Assessment:** High impact / Low likelihood (depends on verifier implementation)
- **Mitigations:**
    1. Use standard snarkjs-generated verifier which includes malleability checks
    2. Verify the Solidity Groth16 implementation checks proof elements are in the correct subgroup
    3. Contract should reject proofs with negated values (check A, B, C point validity)
    4. Consider using proof-of-knowledge variants if stronger guarantees needed
- **Detection:**
    - Audit Solidity verifier for malleability handling
    - Test with negated proof values to confirm rejection
    - Formal verification of verifier contract
- **Recovery Path(s):** Contract-level fix to add proper malleability checks. No circuit change needed.

### FM11: Ragequit Privacy Leak Exploitation

- **Description:** Ragequit intentionally reveals the note's `label` publicly. An attacker monitoring ragequits could build a linkability graph between deposits and withdrawals.
- **Risk Assessment:** Low impact (privacy degradation, not fund loss) / Medium likelihood
- **Mitigations:**
    1. Ragequit is designed as emergency failsafe, not normal operation
    2. Users are warned that ragequit sacrifices privacy
    3. Normal withdrawals via Transact preserve privacy
- **Detection:**
    - On-chain monitoring of ragequit frequency
    - User education on privacy implications
- **Recovery Path(s):** No technical recovery needed. Users who ragequit accept privacy trade-off.

### FM12: Contract Integration Mismatch

- **Description:** The verifier contract must correctly validate all public inputs and enforce additional checks not in the circuit. Mismatches could allow invalid state transitions.
- **Risk Assessment:** High impact / Low likelihood
- **Mitigations:**
    1. Contract must verify context matches transaction parameters
    2. Contract must check nullifiers not already spent
    3. Contract must verify output commitments don't already exist
    4. Contract must validate `amountOut` range (not done in circuit)
    5. Generated verifier from `snarkjs/circom` (not hand-written)
- **Detection:**
    - Integration tests with edge cases
    - Contract audit
    - Formal verification of contract logic
- **Recovery Path(s):** Contract upgrade via proxy pattern or governance. No ceremony needed for contract-only fixes.

### FM13: Keystore Merkle Tree Manipulation

- **Description:** If the keystore tree root can be manipulated, an attacker could add unauthorized keystore entries and spend others' funds. A compromised keystore could also enable double-spending by allowing an attacker to create multiple valid keystore entries for different `privateNullifyingKey` values that produce different nullifiers. for the same commitment.
- **Risk Assessment:** High impact / Low likelihood
- **Mitigations:**
    1. Keystore updates require preimage from existing `privateRevocableKey`
    2. `keystoreRoot` is a public input, contract validates against on-chain state
    3. Key rotation preserves `nullifyingKeyHash` (prevents nullifier takeover)
    4.  Nullifier scheme binds to `privateNullifyingKey` which is immutable per keystore entry
- **Detection:**
    - On-chain monitoring of keystore updates
    - Alerting on unauthorized root changes
- **Recovery Path(s):** If unauthorized entry added, revert keystore state via governance. Affected users ragequit and re-register.

### FM14: Ragequit Commitment Tree Verification (Contract Dependency)

- **Description:** The Ragequit circuit does NOT verify commitment existence in the state tree. It only reconstructs the commitment from private inputs and outputs it. The contract MUST verify this commitment exists in the tree, otherwise an attacker could forge ragequit proofs for non-existent notes and withdraw arbitrary amounts.
- **Risk Assessment:** Critical impact / Medium likelihood (depends on contract implementation)
- **Mitigations:**
    1. Contract must verify `output.commitment` exists in the commitment tree before processing withdrawal
    2. Contract must also verify the commitment hasn't already been nullified
    3. **This verification also ensures value range safety** - since all commitments in the tree came from `Deposit` (which enforces `value < 2^128`), verifying commitment existence transitively enforces the range check
- **Detection:**
    - Contract integration tests with non-existent commitments
    - Contract integration tests with forged commitments containing overflow values
    - Audit contract ragequit handler specifically
- **Recovery Path(s):** Contract-level fix. The circuit could be upgraded to include an state merkle proof.

> ACTION REQUIRED: Verify contract checks that `Ragequit` output commitment exists in the state tree before allowing withdrawal. This is critical for both preventing fake withdrawals AND ensuring value overflow protection.
> 

### FM15: Over-Constrained Circuit - Legitimate Transactions Fail

- **Description:** If circuits are over-constrained, legitimate users cannot generate valid proofs for valid transactions. This could freeze user funds if no valid witness exists.
- **Risk Assessment:** Medium impact (user funds temporarily frozen) / Low likelihood
- **Mitigations:**
    1. Comprehensive test suite covering edge cases
    2. zkFuzz testing for over-constrained detection
    3. Ragequit as fallback if Transact fails unexpectedly
- **Detection:**
    - User reports of failed proof generation
    - SDK error logging for witness generation failures
    - Monitoring proof generation success rate
- **Recovery Path(s):** If `Transact` is over-constrained, users can ragequit. If `Ragequit` is over-constrained, requires circuit fix and new ceremony.

### FM17: ASP Root Zero Bypass

- **Description**: If the ASP association set root is set to 0 (e.g. as a "nuke" mechanism to freeze spending), an attacker could bypass ASP compliance entirely by providing an all-zeros
Merkle proof. The `BinaryMerkleRoot` template from zk-kit computes `root = 0` when all leaves and siblings are 0. This would allow spending notes with ANY label, defeating the compliance mechanism.
- **Risk Assessment:** High impact / Low likelihood (requires contract misconfiguration or intentional root reset)
- **Mitigations**:
    1. Contract must validate associationSetRoot != 0 before accepting Transact proofs
    2. ASP should never set root to 0; use a known "disabled" root like Poseidon(0) instead if freezing is needed
    3. Document that root = 0 is a forbidden value
- **Detection**:
    - Contract validation rejects root = 0
    - Monitoring for ASP root updates to 0
    - Integration tests with root = 0 and all-zeros proof
- **Recovery Path(s):** Contract-level fix to add `root != 0` check. ASP updates root to valid non-zero value.

### FM18: Compliance Timing Gap - Late Discovery of Illicit Funds

- **Description**: There is an inherent timing window between when funds are deposited and when the ASP can detect and revoke illicit labels. During this window, an attacker with tainted funds could deposit before the ASP flags their label. Once discovered, the ASP can revoke the label.
- **Risk Assessment:** Medium impact / Medium likelihood (depends on ASP detection speed and attacker sophistication)
- **Mitigations:**
    1. Per-label conservation (FM6): Prevents cross-label mixing, so taint cannot spread to other users' labels.
    2. ASP monitoring: Off-chain monitoring of deposits for suspicious patterns.
    3. Label revocation: ASP can revoke labels at any time, forcing future spends to Ragequit (public, traceable)
- Detection:
    - ASP off-chain analysis of deposit origins (chain analysis)
    - Monitoring for rapid deposit→transfer→withdraw patterns
    - Cooperation with chain analysis providers
- Recovery Path(s): ASP revokes the label. Remaining funds with that label can only exit via Ragequit (reveals label, enables tracing). Per-label conservation ensures other users' funds are unaffected.

### Generic items we need to take into account:

- [x]  Check this box to confirm that these items have been considered and updated if necessary.

## Action Items

Below is what needs to be done before launch to reduce the chances of the above failure modes occurring, and to ensure they can be detected and recovered from:

### Circuit Actions

- [ ]  Run `zkFuzz` on all circuits and document results (Assignee: @Lumi 0x )
- [ ]  Run `circomspect` on all circuits with zero errors at ERROR level (Assignee: @Lumi 0x )
- [ ]  Complete circuit audit with external auditor (Assignee: security team)

### Contract Actions

- [ ]  **CRITICAL**: Verify Ragequit handler checks output commitment exists in state tree before withdrawal (Assignee: @Hex) - See FM14. This also ensures value range safety since Deposit enforces `value < 2^128` at commitment creation.
- [ ]  Verify contract enforces `context = Poseidon(amountOut, tokenIdOut, recipientAddress, fee)` (Assignee: @Hex) - See FM9
- [ ]  Verify contract checks `amountOut < 2^128` in Transact (Assignee: @Hex) - See FM1
- [ ]  Verify contract validates `associationSetRoot` updates via trusted oracle/multi-sig (Assignee: @Hex) - See FM7
- [ ]  Verify contract checks nullifier uniqueness before accepting proof (Assignee: @Hex) - See FM3
- [ ]  Verify contract checks output commitment uniqueness (Assignee: @Hex) - See FM11
- [ ]  Complete contract audit with external auditor and internal review (Assignee: security team)

### Ceremony Actions

- [x]  Complete trusted setup ceremony with documented participants (Assignee: @Lumi 0x) - See FM8. Done: `ppv2-ceremony`, 2026-07-08 → 2026-07-14.
- [x]  Publish ceremony transcripts and verification instructions (Assignee: @Lumi 0x). The transcript is attached to the GitHub release; verification instructions are in [`packages/circuits/CEREMONY.md`](../../../packages/circuits/CEREMONY.md).

### Operational Actions

- [ ]  Document ragequit privacy implications in user-facing docs (Assignee: @Lumi 0x and UI team from 0xbow) - See FM10

### Documentation Actions

- [ ]  Resolve all comments on this document and incorporate them into the document itself (Assignee: @Lumi 0x)

## Audit Requirements

This project **requires a comprehensive audit** of both circuits and smart contracts for the following reasons:

1. **Financial Risk**: The protocol handles user funds in a shielded pool. Any circuit vulnerability could lead to loss of funds or inflation attacks.
2. **Cryptographic Complexity**: Groth16 proofs, Poseidon hashes, and Merkle tree verification require expert review to ensure correct constraint implementation.
3. **Novel Design**: Per-label value conservation and the ASP compliance mechanism are novel constructions requiring careful analysis.
4. **Trusted Setup**: Groth16 requires a trusted setup ceremony. The ceremony has been run (see FM8); its process and resulting parameters need verification, following [`packages/circuits/CEREMONY.md`](../../../packages/circuits/CEREMONY.md).
5. **Contract Integration**: The verifier contract and pool contract must correctly enforce all public input validations and state transitions.

**Recommended Audit Scope**:

- Circuit constraint analysis (under/over-constrained)
- Nullifier scheme soundness
- Value conservation completeness
- Merkle proof verification correctness
- Contract public input validation
- Trusted setup ceremony verification
- SDK key derivation security

## Appendix

### Appendix A: Circuit Summary

| Circuit | Public Inputs | Private Inputs | Public Outputs | Key Invariants |
| --- | --- | --- | --- | --- |
| Deposit | `tokenId`, `value` | `noteAddressHash`, `depositSecret` | `commitment` | Label privacy, commitment binding, value range check |
| Transact | `stateRoot`, `keystoreRoot`, `associationSetRoot`, `amountOut`, `tokenIdOut`, `context` | ~15 signals per input/output | `nullifiers`[], `commitments`[] | Value conservation, ASP compliance, authorization, value range checks |
| Ragequit | `keystoreRoot`, `ownerAddress`, `value`, `tokenId`, `label` | `noteSecret`, `metadata`, `keys`, `keystore` `proof` | `nullifier`, `commitment` | Authorization, forced recipient (value range enforced via commitment tree verification) |

### Appendix B: Tools Used

| Tool | Version | Purpose |
| --- | --- | --- |
| circom | 2.1.9 | Circuit compiler |
| snarkjs | latest | Proof generation/verification |
| circomspect | latest | Static analysis |
| zkFuzz | 2.2.1 | Mutation-based fuzzing |
| circomlib | 2.0.5 | Standard circuit library |
| zk-kit | 2.0.0 | Merkle tree circuits |

### Appendix C: Security Invariants

1. **Authorization**: Only keystore owner can spend notes
2. **Nullifier Uniqueness**: Each note can only be spent once
3. **Value Conservation (Global)**: Total inputs = Total outputs + Withdrawal
4. **Value Conservation (Per-Label)**: No cross-label value mixing
5. **ASP Compliance**: Transact requires label registration
6. **Commitment Binding**: Commitment uniquely identifies note contents
7. **Label Privacy**: Deposit event doesn't reveal label
8. **Recipient Privacy**: Sender doesn't learn recipient address