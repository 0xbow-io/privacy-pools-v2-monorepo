# Trusted setup

The Groth16 proving keys (`build/<circuit>/groth16_pkey.zkey`) and verification keys
(`build/<circuit>/groth16_vkey.json`) of all 27 circuits come from a multi-party phase-2 trusted-setup
ceremony. The Solidity verifiers (`build/<circuit>/groth16_verifier.sol`) are exported from those keys.
The keys are only secure if at least one contributor discarded their randomness.

| | |
|---|---|
| Ceremony | `ppv2-ceremony` ([0xbow-io/v2-ceremony](https://github.com/0xbow-io/v2-ceremony)), 2026-07-08 → 2026-07-14 |
| Phase 1 | PSE Perpetual Powers of Tau, [`ppot_0080_18.ptau`](https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_18.ptau) (sha256 `9693220206afab749e3d88d4ab5fdf5d36120ea102e7e587ccea0e7a5208e711`) |
| Phase 2 | 500 contributions per circuit from 597 distinct participants, then one beacon contribution |
| Beacon | RANDAO reveal of Ethereum beacon-chain slot 14767039, 2^10 iterations: `0x95b053a17c6a25a1d23cc11949c61a16de9a1b1d320fc7c68bf640f66aeedc1f4e29c1067bb0a412eadcc44e2bf27c9a154a4bc9f6a96a3c9a28ff805c7cfc0377f2518ec91e988f284e58aa1815b9f34e776975e88efbd2fd3b79454fccc198` |
| Transcript | `transcript.json`, attached to the GitHub release (sha256 `9f8b09b42d9acaa05ccbb4662c3611d26c4725c9d4adfa91c686326ac58cb339`) |

The transcript lists every contribution receipt (contribution hashes and the chain hash) and the final
verification key of each circuit. Participant identities are replaced by pseudonyms (`participant-NNNN`,
numbered by first contribution). The chain hash is `sha256(previousChainHash ‖ serverContributionHash)`,
starting from 32 zero bytes, so it does not depend on the participant field.

## Verifying the keys

Each key must verify against the committed circuit (`build/<circuit>/<circuit>.r1cs`) and the phase-1 file.
`snarkjs zkey verify` recomputes the initial key from the r1cs and the ptau, then checks every contribution
and the beacon:

```bash
curl -O https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_18.ptau
npx snarkjs zkey verify build/deposit/deposit.r1cs ppot_0080_18.ptau build/deposit/groth16_pkey.zkey
# ... ZKey Ok!
```

To check the transcript against the keys:

- Contributions 1–500 printed by `zkey verify` equal the transcript's `serverContributionHash` values in
  `contributionIndex` order.
- Contribution 501 (the beacon) equals the circuit's `finalContributionHash`.
- The beacon value equals the `randao_reveal` of slot 14767039 (`/eth/v2/beacon/blocks/14767039` on any
  beacon node).
- The sha256 of each `groth16_pkey.zkey` equals its `finalZkeyHash`:

| Circuit | `groth16_pkey.zkey` sha256 |
|---|---|
| `deposit` | `e6fb5283c7b7511b0422a773d9f054925969e47e8ddf55a6b38b590c951a73a4` |
| `ragequit` | `044abe871b1b79fecb6b4ca6128d08a142d7ce8665f439032953bae92f6ab076` |
| `transact_1x1` | `e92ad88f417c034f073580658839b64fdd1ad3c89a86a9faa926728f80351121` |
| `transact_1x2` | `996b738388d50b8e85fa1c84b0733ac70ad3c2f320e226037d91ad8c8bf1335f` |
| `transact_1x3` | `6e6e697f672a35770d2d9f49588bc841b943ff7c10a6afed07b6627d5f62fd3f` |
| `transact_1x4` | `5ddee0a56c6ffc09c3f1f4ac4be78fe54b5c2b626a922eaec14e848558f91542` |
| `transact_1x5` | `eeb45b1fd355d87a4975341b70982f993215370efec45c8b13bb065c6d9145c1` |
| `transact_2x1` | `3afe537fd4762cb6957f1c8532049879a4f29ed7c54ef893a8299dabf68d9ea5` |
| `transact_2x2` | `2083cba8cbeba5eb56756331fc01ce1849ebbec7bc64aaeb7a58a7417264f391` |
| `transact_2x3` | `b22cc9171ce8c86b00aa95d095c4ed9eb9d5a97df1e2c2d5ee3257b37946b28f` |
| `transact_2x4` | `b816f6391e06595e714840d66f59a8757541f7eb3160fc92e78275ffad544ccd` |
| `transact_2x5` | `259a99de8620a1020680a3eb501b9f2c489cd2a6a0abff0d68967eb76ce937f0` |
| `transact_3x1` | `cb03d64333509767bf1a7cff131e2d790f15afe9dfd74e942398e451d24f754e` |
| `transact_3x2` | `e342328a03523b693462d75e96de5da6ddf8094940007a09ab38ca394540e707` |
| `transact_3x3` | `e1d7ce07915fad1d8d6562ef166a2fce981bdf211827a81f2ba3e029f7b01268` |
| `transact_3x4` | `83475261ec0e8125651e3672491d27318cec1db42cadce4cb2db7ab6b907fdc3` |
| `transact_3x5` | `f1816f47842fa384592241e962a46f3938ff8fb931c42b6c5a1021d4ff1481ab` |
| `transact_4x1` | `6c9a5eaea3f44de8a16de1436839721c3c1a3f92c5746719a6e1d0bf27b7fed8` |
| `transact_4x2` | `211675e1dd535fd03e4ae923a13b186c28c2ba60fb1a1b502203979fc863e1cd` |
| `transact_4x3` | `a9427d68a67b55a9d81c071fea3ffc52bafe4d2eadda0250c20708ab9db405d2` |
| `transact_4x4` | `3a8cdb10ede535c64303b198e2db9a4c8c9c5a49bb340c487a220dd64ee47c95` |
| `transact_4x5` | `239041de4d4d28356afd61cffbd2b2e8909c7e843b923aed8d79c7364bda5345` |
| `transact_5x1` | `895add3547d0d33eaae16287148a1596fc9ca6d61a7a5cdfc3461c1633e8736f` |
| `transact_5x2` | `e2f5f69e7365e63329fc840974b4a6b0c13553b9829dc4c95f45fd71fbc86baa` |
| `transact_5x3` | `c9b2d185fea95ad798a6f8be531d7d4454aa5c4a6285a8c5ec1d9d4709487020` |
| `transact_5x4` | `3f974b64a084bfa5bcf2b1f700e643ea6b7bc37e35f30e588ef6b80e21d0ef5b` |
| `transact_5x5` | `7c70692fc7e41e7dec43159d18ca8aef73891f945e09019e4ebe5d7ea0673ed5` |

## Keeping the keys

The keys are bound to the exact constraint system in the committed `.r1cs` files, and the committed `.wasm`
witness generators produce witnesses for that constraint system. Recompiling the circuits (`compile:all`),
even with a different circom version and no source change, can renumber the wires, after which proofs no
longer verify. Any circuit change needs a new ceremony.

`pnpm build` therefore only re-exports the Solidity verifiers from the committed keys (CI checks they are in
sync). `pnpm run setup <circuit>` and `pnpm run setup:all` run circomkit's single-contributor dev setup,
which overwrites the ceremony keys. They refuse to run unless `ALLOW_DEV_KEYS=1` is set, and dev keys must
never be committed or deployed.
