## Spec Guardian

The tech design documents in `docs/` are the **source of truth** for this project.

All code changes MUST stay aligned with these documents.

### 0. Documentation Structure & Package Pairing

Each package has a dedicated spec section. When working on a package, read its paired spec first.

| Package | Spec (source of truth) | Package-level docs |
|---|---|---|
| `packages/circuits` | `docs/tech-design/circuits/` | `packages/circuits/docs/` |
| `packages/contracts` | `docs/tech-design/contracts/` | — |
| `packages/core-sdk` | `docs/tech-design/core-sdk/` | — |
| `packages/evm-sdk` | `docs/tech-design/evm-sdk/` | — |
| `packages/stellar-sdk` | `docs/tech-design/stellar-sdk/` | — |
| `packages/relayer` | `docs/tech-design/relayer/` | `packages/relayer/CLAUDE.md` (coding conventions) |
| `packages/mock-asp` | `docs/tech-design/mock-asp/` | — (dev/test tool, not shipped) |

```
docs/tech-design/
│
│  Shared (read for any package)
├── key-architectural-concepts.md
├── user-flows.md
│
│  packages/circuits
├── circuits/
│   ├── circuits-tech-design.md
│   ├── circuits-benchmark.md
│   ├── circuits-failure-modes-and-recovery.md
│   └── cryptography-glossary.md
│
│  packages/contracts
├── contracts/
│   ├── contracts-tech-design.md
│   └── timestamp-implementation.md
│
│  packages/core-sdk
├── core-sdk/
│   ├── core-sdk-tech-design.md
│   └── (individual service docs: asp-client.md, batch-withdraw.md,
│       contract-interactor.md, crypto-service.md, data-service.md,
│       hash-service.md, keystore-manager.md, merkle-service.md,
│       note-computation-service.md, note-discovery-service.md,
│       note-manager.md, pool-session.md, proof-service.md,
│       relayer-interactor.md, withdraw-and-swap.md,
│       witness-preparation-service.md)
│
│  packages/evm-sdk
├── evm-sdk/
│   ├── evm-sdk-tech-design.md
│   └── (individual service docs: crypto-service.md,
│       lifi-swap-quote-provider.md, relayer-interactor.md,
│       stealth.md, yield-sessions.md)
│
│  packages/stellar-sdk
├── stellar-sdk/
│   ├── stellar-sdk-tech-design.md
│   └── (individual service docs: crypto-service.md,
│       stellar-crypto-service.md, yield-sessions.md)
│
│  packages/relayer
├── relayer/
│   ├── alert-dispatcher.md
│   ├── dust-rescue-service.md
│   └── stellar-relayer.md
│
│  packages/mock-asp
├── mock-asp/
│   └── mock-asp-tech-design.md
│
│  Not spec — planned extensions only
└── future-ideas/
```

`packages/circuits/docs/` contains implementation-level circuit documentation:
```
packages/circuits/docs/circuits/
├── README.md
├── Deposit.md
├── Transact.md
├── Ragequit.md
└── helpers/
    ├── KeystoreLeaf.md
    ├── NoteCommitment.md
    └── ValueConservation.md
```

### 1. Pre-Change Validation (BLOCKING)

Before implementing any user-requested code change, launch a read-only
subagent that reads the docs and classifies the proposed change as:

- **ALIGNED** — explicitly described or directly implied by the spec
- **CONTRADICTION** — conflicts with a specific requirement (must quote the section)
- **EXTENSION** — adds behavior not covered by any doc

If ALIGNED: proceed.
If CONTRADICTION or EXTENSION: ask the user before implementing.

Skip for: refactors with no behavior change, tests, formatting, dependency bumps.

### 2. Post-Change Doc Sync (AUTOMATIC)

After any code change that affects behavior, launch a subagent that:

1. Identifies sections made outdated by the change
2. Edits only affected sections
3. Bumps the version in the Version History table
4. Returns a summary of all doc edits