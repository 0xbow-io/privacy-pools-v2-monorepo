# Proof Generation & Integration Guide

Generate ZK proofs for Solidity contract tests. Two modes are available:

- **Fixture mode** (`generate:proof`): generates JSON fixture files with random sample inputs
- **FFI mode** (`prove:*`): accepts external inputs, outputs only ABI-encoded proof bytes to stdout for Foundry `ffi()` integration

## Table of Contents

- [How It All Fits Together](#how-it-all-fits-together)
- [Cryptographic Primitives](#cryptographic-primitives)
- [What Each Circuit Proves](#what-each-circuit-proves)
- [Proof Structs in Solidity](#proof-structs-in-solidity)
- [How Proofs Reach Contract Tests](#how-proofs-reach-contract-tests)
- [Example: Deposit-to-Spend Flow](#example-deposit-to-spend-flow)
- [Build Pipeline](#build-pipeline)
- [Fixture Mode](#fixture-mode)
- [FFI Mode (Foundry Integration)](#ffi-mode-foundry-integration)
- [Supported Circuits](#supported-circuits)
- [Troubleshooting](#troubleshooting)

---

## How It All Fits Together

```
┌─────────────────────────────────────────────────────────────────┐
│  1. BUILD                                                       │
│  packages/circuits/                                             │
│  git lfs pull  →  WASM + ceremony pkey + vkey per circuit       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌─────────────────────┐         ┌─────────────────────────┐
│  2a. FIXTURE MODE   │         │  2b. FFI MODE           │
│  generate:proof     │         │  prove:* scripts        │
│  → JSON files       │         │  → ABI-encoded stdout   │
└────────┬────────────┘         └────────────┬────────────┘
         │                                   │
         ▼                                   ▼
┌─────────────────────┐         ┌─────────────────────────┐
│  3a. UNIT TESTS     │         │  3b. INTEGRATION TESTS  │
│  vm.readFile()      │         │  vm.ffi()               │
│  mocked verifiers   │         │  real verifiers         │
└─────────────────────┘         └─────────────────────────┘
```

**When each layer runs:**

| Layer | When | Who runs it |
|-------|------|-------------|
| Build | Artifacts and ceremony keys are committed; a circuit change needs a new ceremony | Circuit developer |
| Fixture generation | After circuit logic or tree depth changes | Circuit developer, then committed |
| FFI proof generation | At test runtime | Foundry (via `vm.ffi()`) |
| Unit tests | `forge test`, fast, no circuit artifacts needed | Contract developer |
| Integration tests | `forge test` with `ffi = true` — requires the circuit artifacts | CI or contract developer |

## Cryptographic Primitives

> For full details, see [`docs/tech-design/circuits/circuits-tech-design.md`](../../../docs/tech-design/circuits/circuits-tech-design.md).

### Key Hierarchy

Users hold 5 secrets. As a contract developer, you never see these directly, they're private circuit inputs, but understanding them explains where proof fields come from.

| # | Secret | Scope | Purpose |
|---|--------|-------|---------|
| 1 | `ownerAddress` | Per user | Ethereum address, cast to `uint256` |
| 2 | `privateNullifyingKey` | Per user (immutable) | Derives nullifiers, cannot be rotated |
| 3 | `privateRevocableKey` | Per user (rotatable) | Authorization, can be revoked/rotated |
| 4 | `noteSecret` | Per note | Randomness binding a note to its owner |
| 5 | `depositSecret` | Per deposit | Randomness for private label computation |

### Note Commitment (3 Nested Poseidon Hashes)

Every note in the system is represented by a single field element, its **commitment**. The commitment is built in stages so that different parts of the note can be revealed selectively:

```
noteAddressHash = Poseidon(ownerAddress, noteSecret)           ← binds note to owner
precommitment   = Poseidon(noteAddressHash, tokenId, value, metadata)  ← binds to asset + amount
commitment      = Poseidon(precommitment, label)               ← binds to lineage
```

- `metadata` is hardcoded to `0` in v2.0 (reserved for future note types)
- The 2-stage split (precommitment vs commitment) separates core note properties from lineage tracking

### Keystore Leaf (User Registration)

Before spending, a user must be registered in the **keystore tree**. Their leaf binds their EVM address to their cryptographic keys:

```
nullifyingKeyHash = Poseidon(privateNullifyingKey)
authDigest        = Poseidon(0, privateRevocableKey)           ← authType=0 for v2.0
keystoreLeaf      = Poseidon(ownerAddress, nullifyingKeyHash, authDigest)
```

The contract stores the keystore tree root. Circuits prove Merkle inclusion of the user's leaf against this root.

### Nullifier (Double-Spend Prevention)

When a note is spent, the circuit outputs a **nullifier hash** derived from the user's immutable key and the note's commitment:

```
nullifierHash = Poseidon(privateNullifyingKey, commitment)
```

The contract stores spent nullifiers. If a nullifier has been seen before, the transaction reverts.

### Label (Lineage / Taint Tracking)

Labels enable ASP (Association Set Provider) compliance. At deposit time, the label is computed privately:

```
label = Poseidon(precommitment, depositSecret)
```

During a transact, the circuit proves each input note's label exists in the ASP's association set tree (via `Poseidon(label)` as the leaf). This is how the system enforces compliance without revealing which specific deposit a note originated from.

## What Each Circuit Proves

### Deposit

**Entry point for funds.** The user deposits tokens and receives a note commitment inserted into the state tree.

| Public Inputs | Public Outputs |
|---------------|----------------|
| `tokenId`, `value` | `outputCommitment` |

**What the circuit enforces:**
1. Correct commitment construction (3-stage hash chain above)
2. Value range: `value < 2^128`
3. Private label derivation from `depositSecret`

**What the contract enforces:**
- Token transfer actually happened (`transferFrom`)
- `tokenId` matches the actual token address
- `outputCommitment` is inserted into the state tree

### Transact

**Primary spending mechanism** for both private transfers and public withdrawals.

| Public Inputs | Public Outputs |
|---------------|----------------|
| `stateRoot`, `keystoreRoot`, `associationSetRoot`, `amountOut`, `tokenIdOut`, `context` | `nullifierHashes[N]`, `outputCommitments[M]` |

**What the circuit enforces:**
1. **Authorization**: user's keystore leaf exists in keystore tree
2. **Note existence**: all input notes exist in state tree (as `Poseidon(commitment, timestamp)` leaves)
3. **ASP compliance**: all input labels exist in association set tree
4. **Nullifier correctness**: each nullifier is correctly derived
5. **Output commitment correctness**: each output is a valid commitment
6. **Value conservation**: `sum(inputs) == sum(outputs) + amountOut`, and per-label: inputs with label L >= outputs with label L
7. **Token consistency**: if `amountOut > 0`, withdrawal token matches note token
8. **Context binding**: `context` is constrained (binds transaction params + encrypted payload)

**What the contract enforces:**
- `stateRoot`, `keystoreRoot`, `associationSetRoot` match on-chain roots
- Nullifiers haven't been spent before
- Output commitments are inserted into the state tree
- Actual token transfer for `amountOut`

### Ragequit

**Emergency withdrawal** that bypasses ASP compliance. The user proves note ownership and forces withdrawal to their `ownerAddress`.

| Public Inputs | Public Outputs |
|---------------|----------------|
| `keystoreRoot`, `ownerAddress`, `value`, `tokenId`, `label` | `nullifierHash`, `commitment` |

**What the circuit enforces:**
1. **Authorization**: user's keystore leaf exists in keystore tree
2. **Commitment reconstruction**: proves knowledge of note secrets
3. **Nullifier correctness**: prevents double-spending

**What the contract enforces:**
- `keystoreRoot` matches on-chain root
- `commitment` exists in the state tree (Merkle inclusion checked on-chain, not in-circuit)
- `msg.sender == ownerAddress`
- Nullifier hasn't been spent before
- Token transfer to `ownerAddress`

> Note: `label` and `value` are **publicly revealed** in ragequit, this is the privacy tradeoff for bypassing ASP compliance.

### Circuit vs Contract Responsibility

| Check | Deposit | Transact | Ragequit |
|-------|---------|----------|----------|
| Commitment construction | Circuit | Circuit | Circuit |
| Value range (`< 2^128`) | Circuit | Circuit | Circuit (implicit) |
| State tree inclusion | — | Circuit | **Contract** |
| Keystore tree inclusion | — | Circuit | Circuit |
| ASP compliance | — | Circuit | **Bypassed** |
| Nullifier derivation | — | Circuit | Circuit |
| Value conservation | — | Circuit | — |
| Token transfer | Contract | Contract | Contract |
| Nullifier uniqueness | — | Contract | Contract |
| Root freshness | — | Contract | Contract |

## Proof Structs in Solidity

All proof structs live in [`ProofLibV2.sol`](../../contracts/src/libraries/ProofLibV2.sol). Each struct bundles Groth16 proof points (`pA`, `pB`, `pC`) with circuit-specific public signals.

### DepositProof

```solidity
struct DepositProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[3] pubSignals;   // [outputCommitment, tokenId, value]
}
```

Accessor functions: `outputCommitment()`, `tokenId()`, `value()`

### TransactProof

```solidity
struct TransactProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[][] pubSignals;  // 2D: variable-size rows per signal group
}
```

The 2D layout accommodates variable input/output counts (1x1 through 5x5):

| Index | Signal | Size |
|-------|--------|------|
| `[0]` | `nullifierHashes` | N |
| `[1]` | `outputCommitments` | M |
| `[2]` | `stateRoot` | 1 |
| `[3]` | `keyRegistryRoot` | 1 |
| `[4]` | `associationSetRoot` | 1 |
| `[5]` | `amountOut` | 1 |
| `[6]` | `tokenIdOut` | 1 |
| `[7]` | `context` | 1 |

Accessor functions: `nullifierHashes()`, `outputCommitments()`, `stateRoot()`, `keyRegistryRoot()`, `associationSetRoot()`, `amountOut()`, `tokenIdOut()`, `context()`

### RagequitProof

```solidity
struct RagequitProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[7] pubSignals;   // [nullifierHash, commitment, keystoreRoot, ownerAddress, value, tokenId, label]
}
```

Accessor functions: `nullifierHash()`, `commitment()`, `keystoreRoot()`, `ownerAddress()`, `value()`, `tokenId()`, `label()`

### Verifier Contracts

| Circuit | Verifier | Generated by |
|---------|----------|-------------|
| Deposit | `DepositGroth16Verifier` | snarkjs (single circuit) |
| Ragequit | `RagequitGroth16Verifier` | snarkjs (single circuit) |
| Transact | `TransactVerifier` | Combined verifier for all NxM variants |

All verifiers implement `IGroth16Verifier`. Source: [`packages/contracts/src/contracts/verifiers/`](../../contracts/src/contracts/verifiers/).

## How Proofs Reach Contract Tests

```
                    ┌──────────────────────┐
                    │   Contract Tests     │
                    └──────┬───────┬───────┘
                           │       │
              ┌────────────┘       └────────────┐
              ▼                                  ▼
   ┌──────────────────┐              ┌──────────────────────┐
   │  UNIT TESTS      │              │  INTEGRATION TESTS   │
   │                  │              │                      │
   │  buildMock*()    │              │  vm.ffi("node ...")  │
   │  + mocked        │              │  + real verifiers    │
   │    verifiers     │              │                      │
   └──────────────────┘              └──────────────────────┘
   Fast, no artifacts                Slow, needs circuit build
   Tests contract logic              Tests full proof pipeline
```

### Unit Tests: Mock Proofs + Mocked Verifiers

Unit tests use helper functions from [`ProofUtils.sol`](../../contracts/test/unit/helpers/ProofUtils.sol) to build proof structs with dummy cryptographic values (`pA = [1,2]`, `pB = [[3,4],[5,6]]`, `pC = [7,8]`) and fuzzed public signals. The verifier is mocked to always return `true`, so tests focus purely on contract logic.

```solidity
// Build a mock proof with fuzzed public signals
ProofLibV2.DepositProof memory proof = buildMockDepositProof(
    DepositProofParams({value: 1000, outputCommitment: 0x123, tokenId: uint256(uint160(token))})
);

// Mock the verifier to accept any proof
vm.mockCall(address(verifier), abi.encodeWithSelector(...), abi.encode(true));
```

Available builders: `buildMockDepositProof()`, `buildMockTransactProof()`, `buildMockRagequitProof()`

### Integration Tests: Real Proofs via `vm.ffi()`

Integration tests call Node.js scripts that run snarkjs to generate real Groth16 proofs. The scripts ABI-encode the proof struct and write it to stdout, which Foundry reads via `vm.ffi()` and decodes directly into a `ProofLibV2.*Proof` struct.

```solidity
bytes memory result = vm.ffi(cmds);  // calls Node.js proof generator
ProofLibV2.DepositProof memory proof = abi.decode(result, (ProofLibV2.DepositProof));
```

This path requires compiled circuit artifacts (WASM + proving key). See [Build Pipeline](#build-pipeline).

## Example: Deposit-to-Spend Flow

A concrete walkthrough with Alice depositing and Bob spending.

### 1. Alice Deposits 100 USDC

Alice holds secrets: `ownerAddress_A`, `privateNullifyingKey_A`, `noteSecret_A`, `depositSecret_A`.

```
noteAddressHash_A = Poseidon(ownerAddress_A, noteSecret_A)
precommitment_A   = Poseidon(noteAddressHash_A, USDC_address, 100, 0)
label_A           = Poseidon(precommitment_A, depositSecret_A)
commitment_A      = Poseidon(precommitment_A, label_A)
```

The Deposit circuit outputs `commitment_A` as a public signal. The contract:
1. Transfers 100 USDC from Alice
2. Inserts `commitment_A` into the state tree
3. ASP indexes `Poseidon(label_A)` into the association set

### 2. Alice Transfers to Bob (Transact 1x1)

Alice creates a transact proof spending her note and creating a new note for Bob.

**Inputs (private):** Alice's note secrets, Bob's `noteAddressHash_B`, a new `label_B`

**The circuit verifies:**
- Alice's keystore leaf is in the keystore tree
- `commitment_A` is in the state tree
- `label_A` is in the ASP association set
- `nullifier_A = Poseidon(privateNullifyingKey_A, commitment_A)` (output)
- `commitment_B = NoteCommitment(noteAddressHash_B, USDC, 100, 0, label_B)` (output)
- Value conservation: 100 == 100 + 0 (no withdrawal)

**The contract:**
- Checks roots match on-chain state
- Records `nullifier_A` (Alice's note is now spent)
- Inserts `commitment_B` into the state tree

### 3. Bob Withdraws (Transact 1x0 with amountOut)

Bob creates a transact proof with `amountOut = 100`, `tokenIdOut = USDC_address`, and 0 output notes.

The contract transfers 100 USDC to Bob's address.

## Build Pipeline

Before generating any proofs, the circuit artifacts must be checked out. They are committed via Git LFS, including the proving and verification keys from the trusted-setup ceremony (see [CEREMONY.md](../CEREMONY.md)):

```bash
git lfs pull --include='packages/circuits/build/**'
cd packages/circuits
pnpm install
```

`pnpm build` only re-exports the Solidity verifiers from the committed keys; it does not compile circuits or run setup. `pnpm run setup <circuit>` / `pnpm run setup:all` generate single-contributor dev keys that overwrite the ceremony keys, so they refuse to run unless `ALLOW_DEV_KEYS=1` is set.

Proof generation uses three artifacts per circuit:

| Artifact | File | Purpose |
|----------|------|---------|
| **WASM** | `build/*/circuit.wasm` | Witness generator, computes all intermediate signals from inputs |
| **Proving key** | `build/*/groth16_pkey.zkey` | Groth16 prover, generates the cryptographic proof |
| **Verification key** | `build/*/groth16_vkey.json` | Verifier reference, used to generate Solidity verifier contracts |

**Why each is needed:**
- **WASM** runs the circuit logic to produce a "witness" (all signal values)
- **Proving key** uses the witness to create a succinct proof (~256 bytes) that the witness satisfies all constraints
- **Verification key** is baked into the on-chain verifier contract, enabling constant-time proof verification

## Fixture Mode

### Quick Start

```bash
# From packages/circuits/
pnpm generate:proof deposit                  # single circuit
pnpm generate:proof --all                    # default set (deposit, transact_1x1, transact_2x2, ragequit)
pnpm generate:fixtures                       # all defaults → ../contracts/test/fixtures/proofs/
```

### CLI Reference

```
pnpm generate:proof <circuit...> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `deposit` | Deposit circuit proof |
| `transact_NxM` | Transact circuit proof (e.g., `transact_2x2`, `transact_1x1`) |
| `ragequit` | Ragequit circuit proof |

**Options:**

| Flag | Description |
|------|-------------|
| `--all` | Generate default set: deposit, transact_1x1, transact_2x2, ragequit |
| `--out <dir>` | Output directory (default: `./proofs/`) |
| `--help` | Show help |

**Examples:**

```bash
pnpm generate:proof deposit ragequit
pnpm generate:proof transact_2x2 --out ../contracts/test/fixtures/proofs/
pnpm generate:proof --all --out ./my-fixtures/
```

### Output Format

> **Note:** This section describes **fixture mode** output only. Fixture mode writes JSON files
> that Foundry unit tests load via `vm.readFile()`. FFI mode (`packages/contracts/test/helper/*.mjs`)
> does not write or read any files, it ABI-encodes the entire proof struct directly to stdout,
> which Foundry reads via `vm.ffi()` in a single call.

Each circuit produces a JSON file (e.g., `deposit.json`):

```json
{
  "circuit": "deposit",
  "proof": {
    "pi_a": ["0x...", "0x...", "0x1"],
    "pi_b": [["0x...", "0x..."], ["0x...", "0x..."], ["0x1", "0x0"]],
    "pi_c": ["0x...", "0x...", "0x1"]
  },
  "publicSignals": ["0x...", ...],
  "solidityCalldata": {
    "pA": ["0x...", "0x..."],
    "pB": [["0x...", "0x..."], ["0x...", "0x..."]],
    "pC": ["0x...", "0x..."],
    "pubSignals": ["0x...", ...]
  },
  "publicInputs": {
    "tokenId": "0x...",
    "value": "0x..."
  }
}
```

**Field descriptions:**

| Field | Description |
|-------|-------------|
| `proof` | Raw Groth16 proof points (pi_a, pi_b, pi_c) |
| `publicSignals` | Ordered public signals array (inputs + outputs) |
| `solidityCalldata` | Proof formatted for Solidity's `verifyProof(uint[2], uint[2][2], uint[2], uint[N])` where N is circuit-specific: `uint256[3]` for deposit, `uint256[7]` for ragequit. Transact uses `uint256[][]` (2D dynamic). |
| `publicInputs` | Named mapping of public signals for readability |

### Using Fixtures in Foundry Tests

#### Loading a fixture

```solidity
import {Test} from 'forge-std/Test.sol';

contract DepositVerifierTest is Test {
    function test_verifyDepositProof() public {
        // Load the fixture
        string memory json = vm.readFile('test/fixtures/proofs/deposit.json');

        // Parse proof components
        uint256[2] memory pA = abi.decode(vm.parseJson(json, '.solidityCalldata.pA'), (uint256[2]));
        uint256[2][2] memory pB = abi.decode(vm.parseJson(json, '.solidityCalldata.pB'), (uint256[2][2]));
        uint256[2] memory pC = abi.decode(vm.parseJson(json, '.solidityCalldata.pC'), (uint256[2]));
        uint256[] memory pubSignals = abi.decode(vm.parseJson(json, '.solidityCalldata.pubSignals'), (uint256[]));

        // Verify
        bool result = verifier.verifyProof(pA, pB, pC, pubSignals);
        assertTrue(result);
    }
}
```

#### Reading specific public inputs

```solidity
// Parse named inputs
uint256 tokenId = abi.decode(vm.parseJson(json, '.publicInputs.tokenId'), (uint256));
uint256 value = abi.decode(vm.parseJson(json, '.publicInputs.value'), (uint256));
```

### Regenerating Fixtures

Re-run whenever:
- Circuit logic changes (templates modified)
- Tree depths change in `circuits.json`
- You need fresh random test data

```bash
cd packages/circuits
pnpm generate:fixtures
```

## FFI Mode (Foundry Integration)

The FFI proof generator scripts live in `packages/contracts/test/helper/` and are designed for Foundry's `vm.ffi()`. They:
- Accept circuit inputs as a JSON string via CLI argument
- Suppress all stdout/stderr during proof generation
- Output **only** ABI-encoded proof bytes (hex with `0x` prefix) on success
- Exit with code 1 and no output on failure
- Use `viem`'s `encodeAbiParameters` for ABI encoding

### Available Scripts

| Script | ABI Encoding |
|--------|-------------|
| `DepositProofGenerator.mjs` | `(uint256[2], uint256[2][2], uint256[2], uint256[3])` |
| `RagequitProofGenerator.mjs` | `(uint256[2], uint256[2][2], uint256[2], uint256[7])` |
| `TransactProofGenerator.mjs` | `(uint256[2], uint256[2][2], uint256[2], uint256[][])` |

### Usage

```bash
# From packages/contracts/

# Deposit
node test/helper/DepositProofGenerator.mjs '{"tokenId":"1","value":"1000000","noteAddressHash":"123","depositSecret":"456"}'

# Ragequit
node test/helper/RagequitProofGenerator.mjs '{"keystoreRoot":"...","ownerAddress":"...","value":"...","tokenId":"...","label":"...","noteSecret":"...","metadata":"0","privateNullifyingKey":"...","privateRevocableKey":"...","keystoreLeafIndex":"0","keystoreSiblings":["0","0",...], "keystoreTreeDepth":"14"}'

# Transact (first arg is circuit name, second is JSON)
node test/helper/TransactProofGenerator.mjs transact_2x2 '{"stateRoot":"...","keystoreRoot":"...", ...}'
```

### Foundry Integration Example

```solidity
function _generateDepositProof(
    uint256 _tokenId,
    uint256 _value,
    uint256 _noteAddressHash,
    uint256 _depositSecret
) internal returns (ProofLibV2.DepositProof memory) {
    string memory json = string.concat(
        '{"tokenId":"', vm.toString(_tokenId),
        '","value":"', vm.toString(_value),
        '","noteAddressHash":"', vm.toString(_noteAddressHash),
        '","depositSecret":"', vm.toString(_depositSecret), '"}'
    );

    string[] memory cmds = new string[](3);
    cmds[0] = "node";
    cmds[1] = "test/helper/DepositProofGenerator.mjs";
    cmds[2] = json;

    bytes memory result = vm.ffi(cmds);
    return abi.decode(result, (ProofLibV2.DepositProof));
}
```

### Input Format

All values in the input JSON must be **strings** (decimal or hex). This prevents JavaScript number precision loss for large field elements. Arrays use JSON array syntax:

```json
{
  "keystoreSiblings": ["123456", "789012", "0", "0"],
  "stateSiblings": [["1", "2", "3"], ["4", "5", "6"]]
}
```

### TransactProof pubSignals Layout

The transact FFI script reshapes flat snarkjs public signals into the 2D `uint256[][]` layout expected by `ProofLibV2.TransactProof`:

| Index | Content | Size |
|-------|---------|------|
| `[0]` | stateRoot | 1 |
| `[1]` | keystoreRoot | 1 |
| `[2]` | associationSetRoot | 1 |
| `[3]` | amountOut | 1 |
| `[4]` | tokenIdOut | 1 |
| `[5]` | context | 1 |
| `[6]` | outputCommitments | M |
| `[7]` | nullifierHashes | N |

## Supported Circuits

| Circuit | Public Inputs | Outputs |
|---------|--------------|---------|
| `deposit` | tokenId, value | outputCommitment |
| `transact_NxM` | stateRoot, keystoreRoot, associationSetRoot, amountOut, tokenIdOut, context | nullifierHashes[N], outputCommitments[M] |
| `ragequit` | keystoreRoot, ownerAddress, value, tokenId, label | nullifierHash, commitment |

All 25 transact variants (1x1 through 5x5) are supported. Pass any valid `transact_NxM` name.

Tree depths (from `circuits.json`):

| Tree | Max Depth | Capacity |
|------|-----------|----------|
| State (commitments) | 18 | ~262k leaves |
| Keystore (user registration) | 14 | ~16k entries |
| Association set (ASP labels) | 14 | ~16k labels |

## Troubleshooting

**"Missing build artifacts"**
- The artifacts are committed via Git LFS. Run `git lfs pull --include='packages/circuits/build/**'` from the repo root.

**Slow generation**
- Deposit: ~100ms, Transact 2x2: ~1-2s, Transact 5x5: ~3-4s. This is normal for Groth16 proof generation.
- The `--all` flag only generates common variants (not all 25 transact configs).

**JSON parsing issues in Foundry**
- All large numbers are hex strings. Use `abi.decode(vm.parseJson(...), (uint256))` to parse.
- Proof coordinates in `solidityCalldata` match the verifier's `verifyProof` signature directly.
