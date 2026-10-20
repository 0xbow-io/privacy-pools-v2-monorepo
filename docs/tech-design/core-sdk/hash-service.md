# HashService

### PoseidonHashService (implements IHashService)

PoseidonHashService wraps the Poseidon hash function. It is the lowest-level cryptographic primitive in the SDK, with every protocol hash computation ultimately calling `hashService.hash()`. It exists as a separate service so that the Poseidon implementation can be swapped (e.g. WASM vs native vs JS) without touching any business logic.

PoseidonHashService is stateless with no dependencies.

# Dependencies

None.

# Methods

---

**`hash(inputs) → Hex`**

Computes a Poseidon hash over the given inputs. Poseidon is the ZK-friendly hash function used throughout the protocol for commitments, nullifiers, labels, key digests, and merkle tree nodes.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `inputs` | `Hex[]` | Array of 0x-prefixed hex strings representing field elements. Poseidon accepts variable-length inputs (the protocol uses 2-4 inputs depending on the computation). |

**Returns:** `Hex` — The Poseidon hash output as a 0x-prefixed hex string.