# ASP Detachment

The protocol version described in this specification relies on a single, direct compliance path where the user provides a cryptographic link to their deposit directly to the ASP. This design choice prioritizes simplicity, auditability, and a clear model for surgical risk management.

However, it introduces a significant trust assumption and a potential centralization risk: the ASP has the unilateral power to censor new deposits by refusing to include them in its `compliantCommitmentTree`. A user whose deposit is ignored by the ASP cannot generate a valid `registerLabel` proof and is therefore barred from entering the privacy set.

A potential future evolution of the protocol could mitigate this risk by re-introducing an "Unlinked" or "Independent Registration" path. Such a path would work as follows:

1. **On-Chain Deposit Oracle:** Instead of relying on the ASP's off-chain `compliantCommitmentTree`, the protocol could maintain a fully on-chain Merkle tree of all deposits.
2. **Independent Proof of Compliance:** A user could generate a `registerLabel` proof that proves their note's commitment exists in this on-chain deposit tree, without revealing *which* specific deposit it is.
3. **Modified `labelCommitment`:** The public commitment would be constructed to hide the link from the ASP, for example: `labelCommitment = Poseidon(label, Poseidon(noteSecret))`.
4. **ASP's Role:** The ASP would verify these registrations without learning the deposit link, adding the `label`s to a separate cohort in its `associationSet`.

This would create a trust-minimized path for users to enter the pool without requiring direct, individualized approval from the ASP. However, it comes at the cost of increased complexity in the protocol and a different risk model (e.g., cohort-based risk instead of surgical risk), representing a significant design trade-off that should be carefully considered in future versions.

Furthermore, the `Unlinked` path introduces a significant user experience challenge in the event of a late discovery. If a deposit is later found to be non-compliant, the ASP cannot surgically invalidate the associated `label`. Instead, all users within that deposit's anonymity cohort would be required to proactively **re-prove** the validity of their notes. This re-proving would involve generating a new ZK proof to demonstrate that their specific deposit is not the newly identified tainted one. This recurring, reactive user burden was a primary reason for deferring this approach in favor of the simpler, more predictable UX of the direct-link model.