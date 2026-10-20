import { encodeFunctionData } from "viem";

import type {
    Address,
    AssetConfig,
    ContractInteractorConfig,
    ContractInteractorWriteDependencies,
    EVMProof,
    Hex,
    IEntrypointChainAdapter,
    IRPCInteractor,
    IWalletInteractor,
    NoteData,
    PreparedTransaction,
} from "../../internal.js";
import {
    AddressSchema,
    AssetConfigSchema,
    BigIntSchema,
    bigintToHex,
    ContractCallError,
    ContractInteractorBaseError,
    ContractInteractorConfigSchema,
    ENTRYPOINT_ABI,
    ENTRYPOINT_DEPOSIT_ABI,
    EntrypointInteractor,
    ERC20_ABI,
    ERC20_APPROVE_ABI,
    InvalidContractResult,
    InvalidInteractorAddress,
    WalletNotAvailable,
} from "../../internal.js";

/**
 * EVM implementation of {@link IEntrypointChainAdapter} — viem-backed reads and ABI calldata
 * encoding for the Entrypoint contract. Extracted verbatim from the pre-genericization
 * `EntrypointInteractor`; behavior is unchanged, only relocated.
 */
export class EvmEntrypointChainAdapter implements IEntrypointChainAdapter<PreparedTransaction> {
    private readonly rpcInteractor: IRPCInteractor;
    private readonly contractAddress: Address;
    private readonly walletInteractor?: IWalletInteractor;

    /**
     * @throws {InvalidInteractorAddress} When the contract address is invalid.
     */
    constructor(config: ContractInteractorConfig, deps?: ContractInteractorWriteDependencies) {
        const validated = ContractInteractorConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidInteractorAddress(validated.error.issues[0].message);
        }

        this.rpcInteractor = config.rpcInteractor;
        this.contractAddress = config.contractAddress;
        this.walletInteractor = deps?.walletInteractor;
    }

    getAddress(): Address {
        return this.contractAddress;
    }

    async getPoolVaultAddressRaw(): Promise<Address> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: ENTRYPOINT_ABI,
                functionName: "poolVault",
            });
            const safeResult = AddressSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }
            return safeResult.data;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async getASPRegistryAddressRaw(): Promise<Address> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: ENTRYPOINT_ABI,
                functionName: "aspRegistry",
            });
            const safeResult = AddressSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }
            return safeResult.data;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async getAssetConfigRaw(asset: Address): Promise<AssetConfig> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: ENTRYPOINT_ABI,
                functionName: "assets",
                args: [asset],
            });

            const safeResult = AssetConfigSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }

            return {
                enabled: safeResult.data.enabled,
                vettingFeeBPS: bigintToHex(safeResult.data.vettingFeeBPS),
                minAmount: bigintToHex(safeResult.data.minAmount),
                maxRelayFee: bigintToHex(safeResult.data.maxRelayFee),
            };
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async getAllowanceRaw(token: Address, owner: Address, spender: Address): Promise<bigint> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: token,
                abi: ERC20_ABI,
                functionName: "allowance",
                args: [owner, spender],
            });

            const safeResult = BigIntSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }
            return safeResult.data;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async encodeDeposit(
        proof: EVMProof,
        noteData: NoteData,
        aspCiphertext: Hex,
        msgValue: Hex,
        _asset: Address,
    ): Promise<PreparedTransaction> {
        return {
            to: this.contractAddress,
            data: encodeFunctionData({
                abi: ENTRYPOINT_DEPOSIT_ABI,
                functionName: "deposit",
                args: [
                    {
                        pA: proof.pA,
                        pB: proof.pB,
                        pC: proof.pC,
                        pubSignals: proof.pubSignals as unknown as readonly [
                            bigint,
                            bigint,
                            bigint,
                            bigint,
                        ],
                    },
                    { hint: noteData.hint, data: noteData.data },
                    aspCiphertext,
                ],
            }) as Hex,
            value: msgValue,
        };
    }

    async encodeApprove(token: Address, amount: Hex): Promise<PreparedTransaction> {
        return {
            to: token,
            data: encodeFunctionData({
                abi: ERC20_APPROVE_ABI,
                functionName: "approve",
                args: [this.contractAddress, BigInt(amount)],
            }) as Hex,
            value: "0x0" as Hex,
        };
    }

    /**
     * @throws {WalletNotAvailable} When walletInteractor is not configured.
     */
    async submit(tx: PreparedTransaction): Promise<Hex> {
        if (!this.walletInteractor) {
            throw new WalletNotAvailable(
                "EntrypointInteractor requires a walletInteractor for write operations",
            );
        }
        return this.walletInteractor.sendTransaction(tx);
    }
}

/**
 * Constructs an `EntrypointInteractor` bound to the EVM Entrypoint contract — wraps
 * {@link EvmEntrypointChainAdapter} around today's `ContractInteractorConfig`/
 * `ContractInteractorWriteDependencies` shape, so existing callers only rename their construction
 * call (`new EntrypointInteractor(cfg, deps)` → `createEvmEntrypointInteractor(cfg, deps)`).
 *
 * Standalone function, not a static method on `EntrypointInteractor` — see
 * `createEvmPoolVaultInteractor`'s doc comment for why (keeps a Stellar-only bundle free of viem).
 *
 * @throws {InvalidInteractorAddress} When the contract address is invalid.
 */
export function createEvmEntrypointInteractor(
    config: ContractInteractorConfig,
    deps?: ContractInteractorWriteDependencies,
): EntrypointInteractor<PreparedTransaction> {
    const adapter = new EvmEntrypointChainAdapter(config, deps);
    return new EntrypointInteractor({ adapter, addressSchema: AddressSchema });
}
