# ProofService

### ProofService

ProofService generates and verifies zero-knowledge proofs. It takes a fully prepared witness from WitnessPreparationService and feeds it into the circuit's prover to produce a proof. It also provides verification for local validation before submitting proofs on-chain.

ProofService has no protocol knowledge. It does not know what a commitment, nullifier, or label is. It receives a witness (an opaque bag of field elements) and a circuit name, loads the corresponding WASM and proving key via ICircuitArtifacts, and runs the prover. This makes ProofService reusable across protocol versions—only the witness structure changes, and that is WitnessPreparationService's concern.

# Dependencies

| Dependency | Why |
| --- | --- |
| **ICircuitArtifacts** | Injected interface that provides circuit WASM files, proving keys, and verification keys by circuit name. The abstraction allows artifacts to be loaded from any source: bundled files, CDN, IPFS, or local filesystem. ProofService calls getWasm() and getProvingKey() for proof generation, and getVerificationKey() for local verification. |

# Default Implementations

The SDK ships two default implementations of `ICircuitArtifacts`. Integrators are free to provide their own.

### LocalCircuitArtifacts

Filesystem-backed implementation. Loads WASM / proving key / verification key from a local base directory. Intended for Node.js runtimes (tests, CLI tooling, servers with bundled artifacts).

### IpfsCircuitArtifacts

IPFS-backed implementation. Drop-in replacement for `LocalCircuitArtifacts` in browser and serverless runtimes. Fetches artifacts from one or more IPFS gateways by CID, honoring the `IPFS Fallback` goal ("Circuit artifacts are also hosted on IPFS to guarantee availability regardless of any centralized infrastructure.").

**Config:**

| Field | Type | Description |
| --- | --- | --- |
| `ipfsGatewayUrls` | `string[]` | Ordered list of IPFS gateway base URLs (e.g., `["https://ipfs.io/ipfs", "https://cloudflare-ipfs.com/ipfs"]`). At least one URL is required; each is validated via `z.url()` at construction. Trailing slashes are tolerated. Gateways are tried in order on fetch failure (multi-gateway fallback). |
| `circuitManifest` | `Readonly<CircuitManifest>` | Map of circuit name → `Readonly<{ wasm, provingKey, verificationKey }>` CIDs. See `DEFAULT_CIRCUIT_MANIFEST`. The constructor deep-clones the manifest so post-construction mutation by the caller cannot affect captured state. |
| `httpClient` | `IHTTPClient` | HTTP client used to fetch artifacts via `getBinary()`. |

**Dependencies:** `{ logger?: ILogger, cacheStore?: ICacheStore }`. `cacheStore` defaults to a new `InMemoryCacheStore` when omitted.

**Caching:** Two layers. An always-on in-memory `Map<cid, bytes>` is consulted first; the injected `cacheStore` is consulted next and populated on miss. Successful gateway fetches populate both layers. Cache writes are best-effort: `cacheStore.set` failures are logged via `logger?.warn` and swallowed, so the fetched bytes still return successfully even when the persistent cache (e.g. IndexedDB) errors out.

**Concurrent fetch coalescing:** The class maintains an internal `Map<string, Promise<Uint8Array>>` keyed by CID. Concurrent calls for the same CID share a single in-flight network request; the inflight entry is cleaned up in `finally` so failed fetches do not memoize errors.

**Integrity:** Every fetched (or cached) artifact is verified before reaching snarkjs. Which digest anchors the check depends on the CID codec. For **raw CIDs**, the CID's embedded SHA-256 multihash is the digest of the file bytes, so bytes are verified against the CID itself; the optional `wasmSha256` / `provingKeySha256` / `verificationKeySha256` fields act as a second independent pin when supplied. For **dag-pb CIDs** (what standard folder pinning produces), the CID digest covers a UnixFS block — not the file bytes — so the CID cannot verify gateway-served content; the manifest `*Sha256` digest is the integrity anchor instead, and construction rejects any dag-pb entry that lacks one (fail closed). CIDs are also structurally parsed at construction (`multiformats`) so malformed pins, unsupported codecs, and missing digests fail immediately rather than at first fetch. Construction also rejects any manifest digest equal to the SHA-256 of empty input (`e3b0c4...`): that value means the digest pipeline hashed a missing or empty file, so no fetched artifact could ever match it — failing at startup names the broken manifest entry instead of surfacing later as a misleading tampering error. A verification failure on a single gateway is treated as a fetch failure and the loop falls through to the next gateway; if every gateway returns tampered bytes, the loop reports `CircuitArtifactLoadFailed` with the underlying mismatch in the message. The cache-hit path throws `CircuitArtifactMultihashMismatch` (subclass of `CircuitArtifactLoadFailed`) for raw-CID mismatches so poisoned caches are surfaced precisely.

**Failure modes:** Throws `CircuitArtifactLoadFailed` on unknown circuit name, unpinned CID (empty string), malformed CID in the manifest, exhaustion of all gateways (HTTP error, timeout, or multihash mismatch on each), or empty response. A 200 response with 0 bytes is treated as a gateway failure and fallback continues to the next gateway, preventing silent corruption of downstream snarkjs. Empty-CID guards run before any network call, so unpinned entries in the manifest fail fast.

### DEFAULT_CIRCUIT_MANIFEST

Exported constant listing all 27 circuit entries the SDK knows about: `deposit`, `ragequit`, and `transact_NxM` for `N, M ∈ [1, 5]` (25 transact variants). Every entry carries the real IPFS CIDs from the pinned bundle `circuit-artifacts-ceremony` (root directory CID `QmWPCQmvkJMtFEyQ94MU2CFniH6u1sbq1AQYDjj4HFpWDX`), which holds the trusted-setup ceremony keys (see `packages/circuits/CEREMONY.md`), plus the `wasmSha256` / `provingKeySha256` / `verificationKeySha256` digest of each artifact. The CIDs are dag-pb (folder pin), so the digests — not the CIDs — are the integrity anchor for fetched content (see the Integrity section). `PoolSessionBuilder` never falls back to it silently (audit M-11): integrators on the IPFS path pass `circuitManifest: DEFAULT_CIRCUIT_MANIFEST` explicitly, making the coupling between proof correctness and the SDK package version a visible decision. `IpfsCircuitArtifacts` still rejects empty CIDs at fetch time, so any user-supplied manifest with unpinned entries fails fast. The manifest values are generated, not hand-edited: `pnpm generate:circuit-manifest` (`packages/core-sdk/scripts/generate-circuit-manifest.mjs`) downloads every artifact from the pinned bundle and derives the CID and sha256 digest from the same response bytes, cross-checking against a second independent gateway. A unit test (`test/unit/constant/CircuitArtifacts.test.ts`) hashes the artifacts committed in `packages/circuits/build` against the manifest digests, so the pinned bundle drifting from the repo's circuits fails CI immediately.

### PoolSessionBuilder Integration

`PoolSessionBuilder` resolves an `ICircuitArtifacts` from config without integrators having to instantiate `LocalCircuitArtifacts` / `IpfsCircuitArtifacts` themselves. Both default implementations are first-class config paths.

**Config fields (`PoolSessionBuilderConfig`):**

| Field | Type | Description |
| --- | --- | --- |
| `circuitArtifactsDir` | `string?` | Filesystem path for `LocalCircuitArtifacts`. Mutually exclusive with `circuitGatewayUrls`. Not required when a `CircuitArtifacts` override is supplied via `.withCircuitArtifacts()`. |
| `circuitGatewayUrls` | `string[]?` | Ordered IPFS gateway URLs for `IpfsCircuitArtifacts`. Mutually exclusive with `circuitArtifactsDir`. Each URL validated via `HttpUrlSchema` (`z.url()`); the array is `z.array(HttpUrlSchema).min(1)`. |
| `circuitManifest` | `CircuitManifest?` | Optional override of `DEFAULT_CIRCUIT_MANIFEST` when `circuitGatewayUrls` is set. Ignored on the local path. |

XOR between `circuitArtifactsDir` and `circuitGatewayUrls` is enforced in the schema via `superRefine`.

**`PoolSessionSimpleConfig` (one-call `PoolSessionBuilder.create(config)`):** narrows the above to a type-level XOR — exactly one of `{ circuitArtifactsDir }` or `{ circuitGatewayUrls, circuitManifest? }` must be present. Both paths are supported in the simple form; no fluent overrides are available.

**Builder methods:**

| Method | Behavior |
| --- | --- |
| `.withCircuitArtifacts(impl)` | Replaces the resolved `ICircuitArtifacts` entirely. Type-level conflict rejects when *either* `circuitArtifactsDir` or `circuitGatewayUrls` is present in `Cfg`. Runtime guard rejects pairing with either field or with a circuit cache store override. |
| `.withCircuitCacheStore(cacheStore)` | Injects an `ICacheStore` into the IPFS path's `IpfsCircuitArtifactsDependencies`. Only valid when `circuitGatewayUrls` is set; runtime conflict throws if used together with `circuitArtifactsDir` or with `.withCircuitArtifacts()`. The cache store is IPFS-only by design — `LocalCircuitArtifacts` does not consult it. |

**`resolveCircuitArtifacts` precedence:**

1. `.withCircuitArtifacts()` override (highest).
2. `circuitArtifactsDir` → `LocalCircuitArtifacts(circuitArtifactsDir)`.
3. Otherwise the IPFS path: `IpfsCircuitArtifacts({ ipfsGatewayUrls, circuitManifest, httpClient }, { cacheStore: overrides.circuitCacheStore, logger })`. Gateway URLs default to `DEFAULT_IPFS_GATEWAY_URLS` when `circuitGatewayUrls` is omitted. `circuitManifest` has no default (audit M-11): when it is omitted, construction throws `InvalidBuilderConfig` with migration instructions — integrators opt in to the SDK-shipped pins by passing `DEFAULT_CIRCUIT_MANIFEST` explicitly. An all-empty manifest also throws `InvalidBuilderConfig`.

# Supporting Interfaces

### ICacheStore

Generic persistent byte-blob cache. Consumed by `IpfsCircuitArtifacts` as its second cache layer, and reusable anywhere else in the SDK that needs durable binary caching.

```ts
interface ICacheStore {
    get(key: string): Promise<Uint8Array | null>;
    set(key: string, value: Uint8Array): Promise<void>;
}
```

Implementations may target IndexedDB (browser), the filesystem (Node), or any other byte store. The SDK ships `InMemoryCacheStore` (a `Map<string, Uint8Array>` wrapper, exported via `external.ts`) as the default when no cache is supplied; integrators may also bring their own.

# Methods

---

**`proveDeposit(witness) → Promise<DepositProof>`**

Generates a ZK proof for the deposit circuit.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `witness` | `CircuitInputs` | The structured witness from WitnessPreparationService.buildDepositWitness(). Contains all private inputs the circuit needs. |

**Returns: `DepositProof`**

| Field | Type | Description |
| --- | --- | --- |
| `proof` | `Proof` | The generated ZK proof (π). Contains the cryptographic data the on-chain verifier needs. |
| `publicSignals` | `bigint[]` | The public inputs extracted during proof generation: commitment, merkleRoot, etc. |

---

**`proveTransact(witness, nInputs, mOutputs) → Promise<TransactProof>`**

Generates a ZK proof for a transact circuit variant (transfer or withdrawal). There are 25 variants (`transact_1x1` through `transact_5x5`) determined by the number of input and output notes.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `witness` | `CircuitInputs` | The structured witness from WitnessPreparationService.buildTransactWitness(). |
| `nInputs` | `number` | Number of input notes (1-5). Determines which transact circuit variant to use. |
| `mOutputs` | `number` | Number of output notes (1-5). Determines which transact circuit variant to use. |

**Returns: `TransactProof`**

| Field | Type | Description |
| --- | --- | --- |
| `proof` | `Proof` | The generated ZK proof. |
| `publicSignals` | `bigint[]` | Public inputs: merkleRoot, keyRegistryRoot, associationSetRoot, nullifiers, outputCommitments, amountOut, tokenIdOut, recipientAddress, fee, encryptedPayloadHash. |

---

**`proveRagequit(witness) → Promise<RagequitProof>`**

Generates a ZK proof for the ragequit circuit.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `witness` | `CircuitInputs` | The structured witness from WitnessPreparationService.buildRagequitWitness(). |

**Returns: `RagequitProof`**

| Field | Type | Description |
| --- | --- | --- |
| `proof` | `Proof` | The generated ZK proof. |
| `publicSignals` | `bigint[]` | Public inputs: merkleRoot, keyRegistryRoot, nullifierHash, withdrawalAmount, recipientAddress. |

---

**`verifyDeposit(proof) → Promise<boolean>`**

Locally verifies a deposit proof against the verification key. Used for sanity checking before on-chain submission.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `proof` | `DepositProof` | The proof and public signals to verify. |

**Returns:** `boolean` — True if the proof is valid.

---

**`verifyTransact(proof, nInputs, mOutputs) → Promise<boolean>`**

Locally verifies a transact proof. The circuit variant must match the one used during proof generation.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `proof` | `TransactProof` | The proof and public signals to verify. |
| `nInputs` | `number` | Number of input notes (1-5). Must match the circuit variant used for proof generation. |
| `mOutputs` | `number` | Number of output notes (1-5). Must match the circuit variant used for proof generation. |

**Returns:** `boolean` — True if the proof is valid.

---

**`verifyRagequit(proof) → Promise<boolean>`**

Locally verifies a ragequit proof.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `proof` | `RagequitProof` | The proof and public signals to verify. |

**Returns:** `boolean` — True if the proof is valid.

---

**`loadCircuit(circuitName) → Promise<void>`**

Pre-loads circuit artifacts (WASM + proving key) into memory. Optional optimization to avoid loading delays during proof generation.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `circuitName` | `string` | The circuit to pre-load: `"deposit"`, `"transact_NxM"` (where N=1-5 inputs, M=1-5 outputs), or `"ragequit"`. |

**Returns:** void

---

# **Version History**

| Version | Date | Description |
| --- | --- | --- |
| 1.0 | — | Initial version. |
| 1.1 | 2026-04-23 | Document `IpfsCircuitArtifacts` alongside `LocalCircuitArtifacts`, add `ICacheStore` supporting interface, and describe `DEFAULT_CIRCUIT_MANIFEST` (27 entries, empty-CID placeholders until artifacts are pinned). |
| 1.2 | 2026-04-24 | `IpfsCircuitArtifacts`: replace `ipfsGatewayUrl: string` with `ipfsGatewayUrls: string[]` (multi-gateway fallback, `z.url()` validation); add concurrent fetch coalescing keyed by CID; treat 200-with-0-bytes as gateway failure; make cache writes best-effort (logged + swallowed); deep-clone `circuitManifest` and mark `CircuitManifest` / `CircuitArtifactCIDs` as `Readonly<>`; move `cacheStore` from config into `IpfsCircuitArtifactsDependencies` with a new `InMemoryCacheStore` default. |
| 1.3 | 2026-04-27 | Document `PoolSessionBuilder` integration for `ICircuitArtifacts`: new `circuitGatewayUrls` / `circuitManifest` config fields with XOR vs. `circuitArtifactsDir` (schema-enforced via `superRefine`, `z.array(HttpUrlSchema).min(1)`); new `.withCircuitCacheStore()` builder method (IPFS-only, runtime conflict otherwise); `.withCircuitArtifacts()` type-level conflict now rejects either circuit-config field; `resolveCircuitArtifacts` precedence (override → IPFS → local → throw). Mirrored in `PoolSessionSimpleConfig` as type-level XOR. |
| 1.4 | 2026-05-22 | `IpfsCircuitArtifacts`: add always-on multihash integrity check. CIDs are now parsed via `multiformats` at construction (malformed pins fail immediately) and SHA-256-verified against fetched and cached bytes before reaching snarkjs. The existing optional `wasmSha256` / `provingKeySha256` / `verificationKeySha256` fields stay as opt-in belt-and-suspenders. New `CircuitArtifactMultihashMismatch` error (subclass of `CircuitArtifactLoadFailed`) for poisoned cache hits; all-gateway failures still surface as `CircuitArtifactLoadFailed` with the underlying mismatch in the message. |
| 1.5 | 2026-06-05 | `DEFAULT_CIRCUIT_MANIFEST` now ships real pinned CIDs (bundle `circuit-artifacts-a99f5ed`) for all 27 circuits instead of empty-string placeholders, plus the `wasmSha256` / `provingKeySha256` / `verificationKeySha256` digest of each artifact. The explicit-manifest requirement from audit M-11 stays: `resolveCircuitArtifacts` still throws when `circuitManifest` is omitted on the IPFS path, and `PoolSessionSimpleConfig` now requires `circuitManifest` at the type level on the gateway arm. The empty-CID guard still throws `InvalidBuilderConfig` for an all-empty manifest. |
| 1.6 | 2026-06-05 | `IpfsCircuitArtifacts` integrity check is now codec-aware (checksum-manifest approach). Raw CIDs keep the multihash-vs-bytes check; dag-pb CIDs (which the pinned bundle uses) are verified against the manifest `*Sha256` digest instead, since a dag-pb multihash covers a UnixFS block rather than the file bytes. Construction rejects dag-pb entries without a valid digest, CIDs with codecs other than raw/dag-pb, and any digest equal to the SHA-256 of empty input (a never-computed digest). `DEFAULT_CIRCUIT_MANIFEST` digests are regenerated by `pnpm generate:circuit-manifest`, which derives each CID and digest from the same downloaded bytes with a second-gateway cross-check. |
| 1.7 | 2026-10-20 | `DEFAULT_CIRCUIT_MANIFEST` regenerated from bundle `circuit-artifacts-ceremony` (root `QmWPCQmvkJMtFEyQ94MU2CFniH6u1sbq1AQYDjj4HFpWDX`): the proving and verification keys of all 27 circuits are now the trusted-setup ceremony keys, replacing the single-contributor dev keys of bundle `circuit-artifacts-a99f5ed`. The `.wasm` artifacts are unchanged (same CIDs and digests). Proofs built from the old bundle's keys no longer verify against the rotated on-chain verifiers. |
