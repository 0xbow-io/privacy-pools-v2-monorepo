# DataService

### DataService

DataService is the SDK's read-only interface to the blockchain. It fetches on-chain events and state by querying the RPC provider. It does not interpret, decrypt, or transform the data—it returns raw event logs and chain state for other services to process.

DataService exists as a separate class (rather than being inline in NoteDiscoveryService) because event fetching involves RPC-specific concerns: pagination of large log ranges, retry logic for unreliable providers, block range chunking, and ABI decoding of event topics and data. Isolating these concerns keeps NoteDiscoveryService focused on discovery logic.

DataService is stateless. Each call is independent.

# Dependencies

| Dependency | Why |
| --- | --- |
| **IRPCProvider** | The injected RPC interface used for all chain reads. DataService calls `getLogs()` for event fetching, `getBlockNumber()` for sync cursors, and `call()` for contract state reads. The interface abstraction allows any RPC provider (ethers, viem, raw HTTP) to be used. |

# Methods

---

**`getDepositEvents(poolAddress, fromBlock?) → Promise<DepositEvent[]>`**

Fetches Deposit events from the privacy pool contract.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `poolAddress` | `Address` | The privacy pool contract address to query. |
| `fromBlock` | `bigint?` | Start block for the log query. If omitted, fetches from contract deployment block. |

**Returns: `DepositEvent[]`**

Array of decoded Deposit events. Each contains: `commitment`, `tokenId`, `value`, `blockNumber`, `txHash`.

---

**`getTransactEvents(poolAddress, fromBlock?) → Promise<TransactEvent[]>`**

Fetches Transact events from the privacy pool contract.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `poolAddress` | `Address` | The privacy pool contract address to query. |
| `fromBlock` | `bigint?` | Start block for the log query. |

**Returns: `TransactEvent[]`**

Array of decoded Transact events. Each contains: `nullifiers`, `outputCommitments`, `tag`, `ephemeralPubKey`, `encryptedPayload`, `blockNumber`, `txHash`.

---

**`getRagequitEvents(poolAddress, fromBlock?) → Promise<RagequitEvent[]>`**

Fetches Ragequit events from the privacy pool contract.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `poolAddress` | `Address` | The privacy pool contract address to query. |
| `fromBlock` | `bigint?` | Start block for the log query. |

**Returns: `RagequitEvent[]`**

Array of decoded Ragequit events. Each contains: `nullifierHash`, `recipientAddress`, `value`, `blockNumber`, `txHash`.

---

**`getLabelRegisteredEvents(registry, fromBlock?) → Promise<LabelRegisteredEvent[]>`**

Fetches LabelRegistered events from the label registry contract.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `registry` | `Address` | The label registry contract address. |
| `fromBlock` | `bigint?` | Start block for the log query. |

**Returns: `LabelRegisteredEvent[]`**

Array of decoded LabelRegistered events. Each contains: `labelHash`, `blockNumber`, `txHash`.

---

**`getBlockNumber() → Promise<bigint>`**

Returns the current block number from the RPC provider. No params.

**Returns:** `bigint` — The latest block number.

---

**`waitForTransaction(txHash) → Promise<TxReceipt>`**

Polls the RPC provider until a transaction is mined and returns its receipt.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `txHash` | `Hex` | The transaction hash to wait for. |

**Returns: `TxReceipt`**

| Field | Type | Description |
| --- | --- | --- |
| `status` | `boolean` | Whether the transaction succeeded. |
| `blockNumber` | `bigint` | Block in which the transaction was mined. |
| `logs` | `Log[]` | Raw event logs emitted by the transaction. |