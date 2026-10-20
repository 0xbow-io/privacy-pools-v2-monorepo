import { Account, BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";

import {
    addressScVal,
    AssetConfig,
    bigintToHex,
    bytesScVal,
    ContractCallError,
    ContractInteractorBaseError,
    EntrypointInteractor,
    groth16ProofScVal,
    Hex,
    IEntrypointChainAdapter,
    InvalidContractResult,
    IStellarRPCInteractor,
    IStellarWalletInteractor,
    NoteData,
    noteDataScVal,
    StellarAddress,
    StellarAddressSchema,
    StellarEntrypointInteractorConfig,
    stellarErrorMessage,
    StellarProof,
    u128ScVal,
    u256ScVal,
    WalletNotAvailable,
} from "../../internal.js";

/**
 * Stellar implementation of {@link IEntrypointChainAdapter}. Unlike EVM (a separate Entrypoint
 * contract fronting a single-asset PoolVault), Stellar's pool contract handles `deposit` and
 * asset configuration directly — no Entrypoint contract was ported (see the reference
 * implementation's design-decisions notes, "doubles CPU with no security benefit"), so this
 * adapter's `contractId` is the same pool contract {@link StellarPoolVaultChainAdapter} is bound
 * to, and `getPoolVaultAddressRaw` is self-referential (no RPC read needed).
 *
 * Stellar has no allowance/approve concept at all — SEP-41 tokens transfer under
 * invocation-scoped Soroban auth (the depositor's signature on the `deposit` call itself
 * authorizes the token transfer), not a separate pre-approval step. `getAllowanceRaw` reports an
 * effectively-unlimited allowance so the deposit orchestrator's "is allowance sufficient" check
 * always short-circuits past the (EVM-only) approval step; `encodeApprove` throws — there is
 * nothing to encode.
 */
export class StellarEntrypointChainAdapter implements IEntrypointChainAdapter<
    string,
    StellarAddress,
    StellarProof
> {
    private readonly rpcInteractor: IStellarRPCInteractor;
    private readonly contractId: string;
    private readonly aspRegistryContractId: string;
    private readonly readSourcePublicKey: string;
    private readonly simulateDeposits: boolean;
    private readonly networkPassphrase?: string;
    private readonly walletInteractor?: IStellarWalletInteractor;

    constructor(
        config: StellarEntrypointInteractorConfig,
        deps?: { walletInteractor?: IStellarWalletInteractor },
    ) {
        this.rpcInteractor = config.rpcInteractor;
        this.contractId = config.contractId;
        this.aspRegistryContractId = config.aspRegistryContractId;
        this.readSourcePublicKey = config.readSourcePublicKey;
        this.simulateDeposits = config.simulateDeposits ?? true;
        this.networkPassphrase = config.networkPassphrase;
        if (!this.simulateDeposits && !this.networkPassphrase) {
            throw new InvalidContractResult(
                "StellarEntrypointChainAdapter: simulateDeposits=false needs networkPassphrase to build the envelope locally",
            );
        }
        this.walletInteractor = deps?.walletInteractor;
    }

    getAddress(): StellarAddress {
        return this.contractId;
    }

    /** @inheritdoc IEntrypointChainAdapter.getPoolVaultAddressRaw */
    async getPoolVaultAddressRaw(): Promise<StellarAddress> {
        return this.contractId;
    }

    /**
     * @inheritdoc IEntrypointChainAdapter.getASPRegistryAddressRaw
     *
     * Not an on-chain read — the Stellar pool contract has no ASP-registry accessor at all
     * (confirmed: no such `pub fn` on `PoolContract`). Supplied from deployment config instead.
     */
    async getASPRegistryAddressRaw(): Promise<StellarAddress> {
        return this.aspRegistryContractId;
    }

    async getAssetConfigRaw(asset: StellarAddress): Promise<AssetConfig> {
        try {
            const result = await this.rpcInteractor.simulateRead(
                this.contractId,
                "get_asset_config",
                [addressScVal(asset)],
                this.readSourcePublicKey,
            );
            const config = result as {
                enabled: boolean;
                min_deposit_amount: bigint;
                vetting_fee_bps: number;
                max_relay_fee: bigint;
            };
            if (typeof config?.enabled !== "boolean") {
                throw new InvalidContractResult("Expected an AssetConfig struct from get_asset_config");
            }
            return {
                enabled: config.enabled,
                minAmount: bigintToHex(config.min_deposit_amount),
                vettingFeeBPS: bigintToHex(BigInt(config.vetting_fee_bps)),
                maxRelayFee: bigintToHex(config.max_relay_fee),
            };
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            // The pool contract's own `get_asset_config` errors with `Error::AssetNotEnabled`
            // (contract error code 10) for an asset that was never configured at all — unlike a
            // Solidity `mapping`, Soroban's `persistent().get()` has no zero-valued default to
            // fall back to. Map that specific contract error to the same graceful
            // `{enabled: false}` result EVM's equivalent read returns for an unconfigured asset,
            // rather than letting the simulation failure propagate as a generic ContractCallError
            // — `PoolSessionDeposit.validateAssetConfig` depends on this to throw `AssetNotEnabled`
            // instead of `InvalidDepositParams`.
            if (/Error\(Contract,\s*#10\)/.test(stellarErrorMessage(error))) {
                return { enabled: false, minAmount: "0x0" as Hex, vettingFeeBPS: "0x0" as Hex, maxRelayFee: "0x0" as Hex };
            }
            throw new ContractCallError(stellarErrorMessage(error));
        }
    }

    /**
     * Stellar has no allowance concept — reports an effectively-unlimited amount so the deposit
     * orchestrator's "is allowance sufficient" check always passes without an approval step.
     */
    async getAllowanceRaw(
        _token: StellarAddress,
        _owner: StellarAddress,
        _spender: StellarAddress,
    ): Promise<bigint> {
        return (1n << 128n) - 1n;
    }

    /**
     * @param aspCiphertext - The ASP label ciphertext. Non-empty selects the pool's
     *   `deposit_with_label`, which registers the label with the pool's own ASP registry in the
     *   same invocation (Soroban allows one contract call per transaction, so a separate
     *   `register_label` could half-succeed); empty selects plain `deposit`.
     * @param asset - The asset being deposited (Stellar's pool contract is multi-asset; EVM's
     *   Entrypoint ignores this parameter).
     * @throws {WalletNotAvailable} When no wallet is configured — `deposit`'s `depositor`
     *   argument is the signer's own StrKey address, resolved here rather than passed in.
     */
    async encodeDeposit(
        proof: StellarProof,
        noteData: NoteData,
        aspCiphertext: Hex,
        _msgValue: Hex,
        asset: StellarAddress,
    ): Promise<string> {
        if (!this.walletInteractor) {
            throw new WalletNotAvailable(
                "EntrypointInteractor requires a walletInteractor to encode a write transaction",
            );
        }
        const [depositor] = await this.walletInteractor.getAccounts();
        // pubSignals = [outputCommitment, tokenId, value, context] (Deposit.circom's public
        // signal order — see contracts/pool/src/lib.rs's deposit(): tokenId/context are
        // recomputed on-chain from `asset`/`note_data`, so only outputCommitment/value are
        // needed as explicit call arguments here.
        const [outputCommitment, , value] = proof.pubSignals;
        const withLabel = aspCiphertext.length > 2;
        const args: xdr.ScVal[] = [
            addressScVal(depositor),
            addressScVal(asset),
            u128ScVal(value),
            u256ScVal(outputCommitment),
            groth16ProofScVal(proof),
            noteDataScVal(noteData),
            ...(withLabel ? [bytesScVal(aspCiphertext)] : []),
        ];
        const method = withLabel ? "deposit_with_label" : "deposit";

        if (!this.simulateDeposits) {
            return this.buildUnsimulated(method, args, depositor);
        }
        return this.rpcInteractor.buildTransaction(this.contractId, method, args, depositor);
    }

    /**
     * @throws {ContractCallError} Always — Stellar has no ERC-20-style approve step (SEP-41
     *   transfers happen under invocation-scoped auth on the `deposit` call itself).
     */
    async encodeApprove(_token: StellarAddress, _amount: Hex): Promise<string> {
        throw new ContractCallError(
            "encodeApprove is not applicable on Stellar: SEP-41 tokens transfer under " +
                "invocation-scoped auth on the deposit call itself, with no separate approve step",
        );
    }

    /** @throws {WalletNotAvailable} When no wallet interactor is configured. */
    async submit(tx: string): Promise<Hex> {
        if (!this.walletInteractor) {
            throw new WalletNotAvailable(
                "EntrypointInteractor requires a walletInteractor for write operations",
            );
        }
        return this.walletInteractor.sendTransaction(tx);
    }

    /**
     * Builds the deposit envelope WITHOUT simulating it: no footprint, no resource fee, sequence 0.
     * Only ever handed to a codec that lifts its arguments out (the yield router's exact-shares
     * deposit, which mints the very shares a simulation of this call would find missing) — never
     * submitted as is.
     */
    private buildUnsimulated(method: string, args: xdr.ScVal[], source: string): string {
        return new TransactionBuilder(new Account(source, "0"), {
            fee: BASE_FEE,
            networkPassphrase: this.networkPassphrase as string,
        })
            .addOperation(Operation.invokeContractFunction({ contract: this.contractId, function: method, args }))
            .setTimeout(0)
            .build()
            .toXDR();
    }
}

/**
 * Constructs an `EntrypointInteractor` bound to the Stellar pool contract — wraps
 * {@link StellarEntrypointChainAdapter} around `StellarEntrypointInteractorConfig`, mirroring
 * `createEvmEntrypointInteractor`'s role.
 */
export function createStellarEntrypointInteractor(
    config: StellarEntrypointInteractorConfig,
    deps?: { walletInteractor?: IStellarWalletInteractor },
): EntrypointInteractor<string, StellarAddress, StellarProof> {
    const adapter = new StellarEntrypointChainAdapter(config, deps);
    return new EntrypointInteractor({ adapter, addressSchema: StellarAddressSchema });
}
