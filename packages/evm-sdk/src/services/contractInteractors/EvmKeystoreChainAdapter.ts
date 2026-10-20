import { encodeFunctionData } from "viem";

import type {
    Address,
    ContractInteractorConfig,
    Eip712TypedData,
    Hash,
    Hex,
    IKeystoreChainAdapter,
    IRPCInteractor,
    IWalletInteractor,
    KeystoreInteractorDependencies,
    PreparedTransaction,
    RelayedRegistrationAuthorization,
} from "../../internal.js";
import {
    AddressSchema,
    BigIntSchema,
    bigintToHex,
    BooleanSchema,
    buildSetAuthPolicyTypedData,
    ContractCallError,
    ContractInteractorBaseError,
    ContractInteractorConfigSchema,
    HexSchema,
    InvalidAddressArgument,
    InvalidContractResult,
    InvalidInteractorAddress,
    KEYSTORE_ABI,
    KEYSTORE_AUTH_EVENTS_ABI,
    KEYSTORE_EVENTS_ABI,
    KEYSTORE_WRITE_ABI,
    KeystoreAuthEventLogArgsSchema,
    KeystoreEventLogArgsSchema,
    KeystoreInteractor,
    WalletNotAvailable,
} from "../../internal.js";

/**
 * EVM implementation of {@link IKeystoreChainAdapter} — viem-backed reads, ABI calldata
 * encoding, and event log decoding for the Keystore contract. Extracted verbatim from the
 * pre-genericization `KeystoreInteractor`; behavior is unchanged, only relocated.
 */
export class EvmKeystoreChainAdapter implements IKeystoreChainAdapter<PreparedTransaction> {
    private readonly rpcInteractor: IRPCInteractor;
    private readonly contractAddress: Address;
    private readonly deploymentBlock?: bigint;
    private readonly walletInteractor?: IWalletInteractor;

    /**
     * @throws {InvalidInteractorAddress} When the contract address is invalid.
     */
    constructor(config: ContractInteractorConfig, deps?: KeystoreInteractorDependencies) {
        const validated = ContractInteractorConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidInteractorAddress(validated.error.issues[0].message);
        }

        this.rpcInteractor = config.rpcInteractor;
        this.contractAddress = config.contractAddress;
        this.deploymentBlock = config.deploymentBlock;
        this.walletInteractor = deps?.walletInteractor;
    }

    getAddress(): Address {
        return this.contractAddress;
    }

    async getNullifyingKeyHashRaw(account: Address): Promise<Hash> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: KEYSTORE_ABI,
                functionName: "nullifyingKeys",
                args: [account],
            });
            const safeResult = BigIntSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }
            return bigintToHex(safeResult.data);
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async getViewingKeyRaw(account: Address): Promise<Hash> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: KEYSTORE_ABI,
                functionName: "viewingKeys",
                args: [account],
            });
            const safeResult = HexSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }
            return safeResult.data;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async isKnownRootRaw(root: Hash): Promise<boolean> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: KEYSTORE_ABI,
                functionName: "isKnownRoot",
                args: [BigInt(root)],
            });
            const safeResult = BooleanSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }
            return safeResult.data;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async getCurrentCursor(): Promise<bigint> {
        return BigInt(await this.rpcInteractor.getBlockNumber());
    }

    async fetchLeafDeltas(
        fromCursor: bigint | undefined,
        toCursor: bigint,
    ): Promise<{
        inserted: { leafIndex: number; newLeaf: Hash }[];
        updated: { leafIndex: number; newLeaf: Hash }[];
    }> {
        try {
            const logs = await this.rpcInteractor.getLogsPaginated({
                address: this.contractAddress,
                events: KEYSTORE_EVENTS_ABI,
                fromBlock: fromCursor,
                toBlock: toCursor,
            });

            const inserted: { leafIndex: number; newLeaf: Hash }[] = [];
            for (const log of logs) {
                if (log.eventName !== "LeafInserted") continue;
                const validatedArgs = KeystoreEventLogArgsSchema.safeParse(log.args);
                if (!validatedArgs.success) {
                    throw new InvalidContractResult(validatedArgs.error.issues[0].message);
                }
                inserted.push({
                    leafIndex: validatedArgs.data._leafIndex,
                    newLeaf: bigintToHex(validatedArgs.data._newLeaf),
                });
            }

            const updated: { leafIndex: number; newLeaf: Hash }[] = [];
            for (const log of logs) {
                if (log.eventName !== "LeafUpdated") continue;
                const validatedArgs = KeystoreEventLogArgsSchema.safeParse(log.args);
                if (!validatedArgs.success) {
                    throw new InvalidContractResult(validatedArgs.error.issues[0].message);
                }
                updated.push({
                    leafIndex: validatedArgs.data._leafIndex,
                    newLeaf: bigintToHex(validatedArgs.data._newLeaf),
                });
            }

            return { inserted, updated };
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async getCurrentAuthorizerDigestRaw(account: Address): Promise<Hash | null> {
        const normalizedAccount = account.toLowerCase();

        try {
            const logs = await this.rpcInteractor.getLogsPaginated({
                address: this.contractAddress,
                events: KEYSTORE_AUTH_EVENTS_ABI,
                fromBlock: this.deploymentBlock,
            });

            let latestDigest: Hash | null = null;
            for (const log of logs) {
                const validated = KeystoreAuthEventLogArgsSchema.safeParse(log.args);
                if (!validated.success) {
                    throw new InvalidContractResult(validated.error.issues[0].message);
                }
                if (validated.data._account.toLowerCase() !== normalizedAccount) continue;
                latestDigest = bigintToHex(validated.data._authDigest);
            }

            return latestDigest;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async encodeSetAuthPolicy(
        authDigest: Hash,
        nullifyingKeyHash: Hash,
    ): Promise<PreparedTransaction> {
        return {
            to: this.contractAddress,
            data: encodeFunctionData({
                abi: KEYSTORE_WRITE_ABI,
                functionName: "setAuthPolicy",
                args: [BigInt(authDigest), BigInt(nullifyingKeyHash)],
            }) as Hex,
            value: "0x0" as Hex,
        };
    }

    async encodeUpdateAuthPolicy(
        oldAuthDigest: Hash,
        newAuthDigest: Hash,
        siblingNodes: Hash[],
    ): Promise<PreparedTransaction> {
        return {
            to: this.contractAddress,
            data: encodeFunctionData({
                abi: KEYSTORE_WRITE_ABI,
                functionName: "updateAuthPolicy",
                args: [
                    BigInt(oldAuthDigest),
                    BigInt(newAuthDigest),
                    siblingNodes.map((s) => BigInt(s)),
                ],
            }) as Hex,
            value: "0x0" as Hex,
        };
    }

    /**
     * @throws {InvalidHashArgument} When the viewing key is not a valid 32-byte X25519 public key.
     */
    async encodeSetViewingKey(viewingKey: Hex): Promise<PreparedTransaction> {
        return {
            to: this.contractAddress,
            data: encodeFunctionData({
                abi: KEYSTORE_WRITE_ABI,
                functionName: "setViewingKey",
                args: [viewingKey],
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
                "KeystoreInteractor requires a walletInteractor for write operations",
            );
        }
        return this.walletInteractor.sendTransaction(tx);
    }

    /**
     * @throws {WalletNotAvailable} When walletInteractor is not configured.
     */
    async signTypedData(typedData: Eip712TypedData): Promise<Hex> {
        if (!this.walletInteractor) {
            throw new WalletNotAvailable(
                "KeystoreInteractor requires a walletInteractor to sign typed data",
            );
        }
        return this.walletInteractor.signTypedData(typedData);
    }

    /**
     * @inheritdoc IKeystoreChainAdapter.buildRegistrationAuthorization
     *
     * The EIP-712 `SetAuthPolicy` payload `Keystore.setAuthPolicyWithSig` and
     * `PrivacyPoolRelay.registerAndRelay` verify, bound to this keystore and chain.
     */
    async buildRegistrationAuthorization(args: {
        account: Address;
        nullifyingKeyHash: Hash;
        authDigest: Hash;
        deadline: Hex;
        chainId: number;
    }): Promise<RelayedRegistrationAuthorization> {
        return buildSetAuthPolicyTypedData({
            keystoreAddress: this.getAddress(),
            chainId: args.chainId,
            account: args.account,
            authDigest: args.authDigest,
            nullifyingKeyHash: args.nullifyingKeyHash,
            deadline: args.deadline,
        });
    }

    /**
     * @inheritdoc IKeystoreChainAdapter.signRegistrationAuthorization
     * @throws {WalletNotAvailable} When walletInteractor is not configured.
     * @throws {InvalidAddressArgument} When handed a non-EIP-712 (Soroban) authorization.
     */
    async signRegistrationAuthorization(authorization: RelayedRegistrationAuthorization): Promise<Hex> {
        if ("kind" in authorization) {
            throw new InvalidAddressArgument("an EVM keystore signs EIP-712 typed data, not a Soroban auth entry");
        }
        return this.signTypedData(authorization);
    }
}

/**
 * Constructs a `KeystoreInteractor` bound to the EVM Keystore contract — wraps
 * {@link EvmKeystoreChainAdapter} around today's `ContractInteractorConfig`/
 * `KeystoreInteractorDependencies` shape, so existing callers only rename their construction call
 * (`new KeystoreInteractor(cfg, deps)` → `createEvmKeystoreInteractor(cfg, deps)`).
 *
 * Standalone function, not a static method on `KeystoreInteractor` — see
 * `createEvmPoolVaultInteractor`'s doc comment for why (keeps a Stellar-only bundle free of viem).
 *
 * @throws {InvalidInteractorAddress} When the contract address is invalid.
 */
export function createEvmKeystoreInteractor(
    config: ContractInteractorConfig,
    deps?: KeystoreInteractorDependencies,
): KeystoreInteractor<PreparedTransaction> {
    const adapter = new EvmKeystoreChainAdapter(config, deps);
    return new KeystoreInteractor(
        { adapter, deploymentBlock: config.deploymentBlock, addressSchema: AddressSchema },
        { seed: deps?.seed },
    );
}
