# Privacy Pools V2 - Circuits

Zero-knowledge circuits for Privacy Pools v2 protocol, built with Circom and Circomkit. The committed Groth16 proving and verification keys come from a multi-party phase-2 trusted-setup ceremony; see [CEREMONY.md](CEREMONY.md) for provenance and verification.

## Overview

This package contains the core ZK circuits for Privacy Pools v2:

### Helper Templates
- **NoteCommitment**: Computes the cryptographic commitment for a note in the Privacy Pools v2 system. This commitment scheme binds ownership, value, and lineage information into a single hash that can be stored in the commitment tree.
- **KeystoreLeaf**: Computes a user's keystore leaf from their public address and private keys. This leaf is stored in the keystore tree and verified during transactions to prove user registration.
- **ValueConservation**: Enforces per-label and global value conservation across transaction inputs and outputs. This is critical for maintaining lineage separation (taint containment) while ensuring economic correctness.

### Main Circuits
- **Deposit**: it proves a commitment was correctly constructed from a set of public and private inputs according to the protocol's commitment scheme.
- **Transact**: spends input notes and creates output notes while enforcing three critical purposes (ASP compliance verification, value conservation (per-label and global), and authorization through keystore membership).
- **Ragequit**: it provides an emergency withdrawal mechanism that allows users to recover funds even when compliance has failed or the ASP has censored their label.

## Circuit Structure

```
circuits/
├── templates/
│   ├── helpers/         # Reusable helper templates
│   │   ├── NoteCommitment.circom
│   │   ├── KeystoreLeaf.circom
│   │   └── ValueConservation.circom
│   ├── Deposit.circom   # Main circuit template
│   ├── Transact.circom  # Main circuit template
│   └── Ragequit.circom  # Main circuit template
├── deposit.circom
├── transact.circom
└── ragequit.circom
```

**Structure explanation:**
- `templates/helpers/` - Reusable components used by main circuits
- `templates/` - Main circuit template definitions
- Root level - Wrapper files that include templates and declare `component main` for compilation

## Testing Approach

Tests use **Mocha + Chai** with TypeScript support via `ts-node`.

### Test Structure

```
test/
├── common/
│   └── index.ts
├── deposit.test.ts
├── transact.test.ts
└── ragequit.test.ts
```

### Running Tests

```bash
# Run all tests
pnpm test

# Compile a specific circuit (circuit development only: can invalidate the committed ceremony keys)
pnpm compile deposit

# Dev-only proving/verification keys: overwrites the ceremony keys, never commit them
ALLOW_DEV_KEYS=1 pnpm run setup deposit
```

**Note:** Circuit compilation can take 1-5 minutes. Mocha is configured with a 300s (5 minute) timeout.

## Static Analysis

Circuits are analyzed with **circomspect** to catch security issues.

### Installation

```bash
cargo install circomspect
```

### Running Analysis

```bash
# Analyze all circuits
pnpm lint

# Verbose output with warnings
circomspect circuits/ --verbose --include-warnings --allow P1000
```

The `--allow P1000` flag is standard practice for certain non-critical warnings.

## CI/CD Integration

Circuits are validated in CI pipeline:
1. **Lint Job**: Checks code style (runs first)
2. **Circomspect Job**: Static analysis (runs after lint)
3. **Build Circuits Job**: Compiles circuits and runs tests

Circomspect failures will **block the CI pipeline**.

## Required Tools

- **Circom**: Circuit compiler (v2.1.9)
- **Circomkit**: Circuit development framework
- **Node.js**: >=18.0.0
- **pnpm**: Package manager
- **Rust/Cargo**: For circomspect installation

## Build Artifacts

Compiled circuits and their ceremony keys are committed in `build/`, the large files via Git LFS (`git lfs pull --include='packages/circuits/build/**'`):
```
build/
├── deposit/
│   ├── groth16_pkey.zkey      # ceremony proving key
│   ├── groth16_vkey.json      # ceremony verification key
│   ├── groth16_verifier.sol   # exported from the keys by `pnpm build`
│   └── deposit.r1cs
└── ...
```

The keys are bound to the committed `.r1cs`/`.wasm`. Any circuit change needs a new ceremony (see [CEREMONY.md](CEREMONY.md)).

## Reference Documentation

- [Circom Documentation](https://docs.circom.io/)
- [Circomkit GitHub](https://github.com/erhant/circomkit)
- [Circomspect GitHub](https://github.com/trailofbits/circomspect)

## Scripts Reference

| Script | Description |
|--------|-------------|
| `pnpm test` | Run all tests with Mocha |
| `pnpm lint` | Run circomspect static analysis |
| `pnpm build` | Re-export the Solidity verifiers from the committed keys (no compile, no setup) |
| `pnpm compile <circuit>` | Compile specific circuit (can invalidate the ceremony keys) |
| `pnpm compile:all` | Compile all circuits (after adding to circuits.json; can invalidate the ceremony keys) |
| `ALLOW_DEV_KEYS=1 pnpm run setup <circuit>` | Generate single-contributor dev keys, overwriting the ceremony keys (dev only; `setup:all` for all circuits) |
| `pnpm prove <circuit>` | Generate proof |
| `pnpm verify <circuit>` | Verify proof |
| `pnpm clean` | Remove build artifacts |
