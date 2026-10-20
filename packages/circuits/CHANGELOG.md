# Changelog

All notable changes to `@privacy-pools-v2/circuits` are documented in this file.

## 1.0.1 — 2026-10-20

- Replace the single-contributor dev keys with the trusted-setup ceremony keys (`groth16_pkey.zkey`, `groth16_vkey.json`, and the regenerated `groth16_verifier.sol` for all 27 circuits). Circuits, r1cs and wasm are unchanged. Provenance and verification steps: `CEREMONY.md`.
- `pnpm build` only re-exports the Solidity verifiers from the committed keys. `setup` and `setup:all` refuse to run unless `ALLOW_DEV_KEYS=1` is set, since they would overwrite the ceremony keys.

## 1.0.0 — 2026-10-19

Initial release.

- Circom/Circomkit zero-knowledge circuits: `Deposit`, `Transact` (one circuit per input × output count, `1x1` to `5x5`) and `Ragequit`, built on the `NoteCommitment`, `KeystoreLeaf` and `ValueConservation` helper templates.
- Compiled artifacts (witness-generator WASM, Groth16 proving and verification keys, Solidity verifiers) are tracked under `build/`, with the large files in Git LFS.
