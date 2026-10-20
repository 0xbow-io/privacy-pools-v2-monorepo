# Audit Output Index

Running list of reports produced by the `v2.0` feature audit. Newest at top of each section.
Every report header records the commit hash it was run against.

## Migrated (pre-existing, produced during feature development)
| Report | Stage | Feature | Verdict |
|---|---|---|---|
| [audit/AUDIT_batch_full.md](audit/AUDIT_batch_full.md) | feature-standards | batch | DONE-WITH-GAPS |
| [audit/AUDIT_batch_standards.md](audit/AUDIT_batch_standards.md) | feature-standards | batch | — |
| [audit/AUDIT_batch_withdrawal.md](audit/AUDIT_batch_withdrawal.md) | security | batch | — |
| [audit/AUDIT_yield.md](audit/AUDIT_yield.md) | feature-standards | yield | DONE-WITH-GAPS |
| [code-review/REVIEW_batch_withdrawal.md](code-review/REVIEW_batch_withdrawal.md) | code-review | batch | superseded snapshot |
| [test-gap/TEST_GAP_yield_reapply.md](test-gap/TEST_GAP_yield_reapply.md) | test-gap | yield | — |

## v2.0 audit (this run)
| Report | Stage | Scope | Verdict |
|---|---|---|---|
| [HANDOFF.md](HANDOFF.md) | handoff | auditor entry point | complete |
| [RETROSPECTIVE.md](RETROSPECTIVE.md) | retrospective | recurring-defect harvest → 4 agent-doc rules | complete |
| [security/SECURITY_FINDINGS.md](security/SECURITY_FINDINGS.md) | consolidated | all — severity-ranked register | — |
| [security/CROSS_FEATURE_THREAT_MODEL.md](security/CROSS_FEATURE_THREAT_MODEL.md) | security | 11 cross-feature scenarios | — |
| [security/STEALTH_REVIEW_AND_DIFF.md](security/STEALTH_REVIEW_AND_DIFF.md) | security | stealth diff + review | fix verified |
| [audit/contracts_r1.md](audit/contracts_r1.md) | audit | contracts (yield/keystore/relay) | DONE-WITH-GAPS |
| [audit/PHASE0_build_and_selection.md](audit/PHASE0_build_and_selection.md) | audit | build + CI selection | fixed |
| [code-review/sdk_r1.md](code-review/sdk_r1.md) | code-review | SDK | DONE-WITH-GAPS |
| [code-review/relayer_r1.md](code-review/relayer_r1.md) | code-review | relayer | PASS+fixes |
| [feature-check/USER_FLOW_MATRIX.md](feature-check/USER_FLOW_MATRIX.md) | test-gap | flow×permutation coverage | — |
| [feature-check/AIRDROP_DESIGN_REVIEW.md](feature-check/AIRDROP_DESIGN_REVIEW.md) | plan-review | airdrop (design) | not build-ready |

New docs authored during the audit: `docs/tech-design/sdk/stealth.md`,
`docs/tech-design/contracts/yield.md`, `docs/TESTING_GUIDE.md`, `packages/relayer/CLAUDE.md`,
`docs/tech-design/user-flows.md` §1.7–1.9/§3.4.
