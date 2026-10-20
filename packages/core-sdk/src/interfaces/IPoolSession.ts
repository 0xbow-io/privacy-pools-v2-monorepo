import type {
    Address,
    DeriveFromSignatureConfig,
    EVMProof,
    LeafCacheSeed,
    PreparedTransaction,
    TxLog,
} from "../internal.js";
import type { IPoolSessionBatchWithdraw } from "./IPoolSessionBatchWithdraw.js";
import type { IPoolSessionDeposit } from "./IPoolSessionDeposit.js";
import type { IPoolSessionExport } from "./IPoolSessionExport.js";
import type { IPoolSessionKeystore } from "./IPoolSessionKeystore.js";
import type { IPoolSessionNoteDiscovery } from "./IPoolSessionNoteDiscovery.js";
import type { IPoolSessionNoteManager } from "./IPoolSessionNoteManager.js";
import type { IPoolSessionRagequit } from "./IPoolSessionRagequit.js";
import type { IPoolSessionReshield } from "./IPoolSessionReshield.js";
import type { IPoolSessionReshieldCrosschain } from "./IPoolSessionReshieldCrosschain.js";
import type { IPoolSessionReshieldTransfer } from "./IPoolSessionReshieldTransfer.js";
import type { IPoolSessionReshieldTransferCrosschain } from "./IPoolSessionReshieldTransferCrosschain.js";
import type { IPoolSessionSwapDeposit } from "./IPoolSessionSwapDeposit.js";
import type { IPoolSessionTransfer } from "./IPoolSessionTransfer.js";
import type { IPoolSessionWithdraw } from "./IPoolSessionWithdraw.js";
import type { IPoolSessionWithdrawAndSwap } from "./IPoolSessionWithdrawAndSwap.js";
import type { ISwapProvider } from "./ISwapProvider.js";

/**
 * Unified pool session interface — the sole public-facing entry point of the SDK. Generic over
 * the chain's prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type
 * `TProof`, raw receipt-log type `TLog`, and signature-derivation config type `TDeriveConfig`
 * (all default to their EVM shapes).
 *
 * Combines all pool session capabilities (deposit, transfer, withdraw, batch withdraw, swap,
 * swap-and-deposit, reshield, keystore registration, ragequit, note discovery, account
 * export/import, and externally-broadcast note registration) into a single facade.
 *
 * `IPoolSessionWithdrawAndSwap`/`IPoolSessionSwapDeposit`/`IPoolSessionReshield`/
 * `IPoolSessionReshieldCrosschain` are fully generic — the operations themselves aren't
 * chain-specific — but their concrete classes need a `TTx` shape (`{to, data}`, a contract-call
 * tuple) that not every chain's prepared-transaction type satisfies (Stellar's is a plain XDR
 * envelope string), so `PoolSessionFactory` builds three of the four (all but
 * `withdrawAndSwap`) via a caller-supplied hook rather than unconditionally — see
 * `PoolSessionConfig.buildChainExtensions`. Yield (Aave-backed ppUSDC) is a genuinely
 * chain-specific EVM smart-contract product feature, not exposed on this base interface at all —
 * evm-sdk's `EvmPoolSession` extends `PoolSession` to add it. `IPoolSessionNoteDiscovery<TAddress>`
 * is generic except for its optional stealth-deposit scan path, which stays chain-specific
 * (ERC-5564/secp256k1 on EVM) — see `INoteDiscoveryService.scanStealthDeposits`.
 */
export interface IPoolSession<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
    TDeriveConfig = DeriveFromSignatureConfig,
>
    extends
        IPoolSessionDeposit<TTx, TAddress, TProof, TLog>,
        IPoolSessionTransfer<TTx, TAddress, TProof, TLog>,
        IPoolSessionWithdraw<TTx, TAddress, TProof, TLog>,
        IPoolSessionBatchWithdraw<TTx, TAddress, TLog>,
        IPoolSessionWithdrawAndSwap<TAddress, TLog>,
        IPoolSessionSwapDeposit<TTx, TAddress>,
        IPoolSessionReshield<TTx, TAddress, TLog>,
        IPoolSessionReshieldCrosschain<TTx, TAddress, TLog>,
        IPoolSessionReshieldTransfer<TTx, TAddress, TLog>,
        IPoolSessionReshieldTransferCrosschain<TTx, TAddress, TLog>,
        ISwapProvider,
        IPoolSessionKeystore<TTx, TAddress, TLog, TDeriveConfig>,
        IPoolSessionRagequit<TTx, TAddress, TProof, TLog>,
        IPoolSessionNoteDiscovery<TAddress>,
        IPoolSessionNoteManager<TAddress>,
        IPoolSessionExport<TAddress> {
    /** The chain ID this session operates on (matches the entrypoint/pool contract chain). */
    readonly chainId: number;

    /**
     * Returns the session's keystore leaf-scan cache for external persistence
     * (disk between test runs, browser storage across dApp sessions), or
     * `undefined` if nothing has triggered a keystore leaf fetch yet. Feed
     * the result back in as `keystoreLeafCacheSeed` on a future session's
     * builder config to skip re-scanning the leaves it already covers.
     */
    exportKeystoreLeafCache(): LeafCacheSeed | undefined;

    /**
     * Same as {@link exportKeystoreLeafCache}, for the state-tree leaf cache.
     *
     * @throws {PoolSessionLeafCacheBaseError} When `poolVaultInteractor` was not configured.
     */
    exportStateLeafCache(): LeafCacheSeed | undefined;
}
