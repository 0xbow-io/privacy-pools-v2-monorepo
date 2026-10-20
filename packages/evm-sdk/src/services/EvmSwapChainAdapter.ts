import { decodeAbiParameters, decodeFunctionData, encodeFunctionData } from "viem";

import type {
    Address,
    Hex,
    IRPCInteractor,
    ISwapChainAdapter,
    ParsedApprovalTx,
    PreparedTransaction,
    SwapRouting,
    SwapThenCallParams,
} from "../internal.js";
import {
    CALLDATA_VERIFICATION_EXTRACT_MAIN_ABI,
    CALLDATA_VERIFICATION_EXTRACT_SWAP_ABI,
    canonicalTokenAddress,
    decodeLiFiDestinationCallAmount,
    decodeStargateDestBudget,
    ERC20_ABI,
    ERC20_APPROVE_ABI,
    InvalidTransactParams,
    isSameToken,
    isLiFiExecutor,
    isLiFiExecutorCall,
    LIFI_EXECUTOR_SCREENING_ABI,
    LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
    planApprovals,
    RELAY_SWAP_ROUTING_ABI,
    RELAY_SWAP_ROUTING_TYPEHASH,
    RELAY_SWAPS_APPROVED_ROUTERS_ABI,
    RELAY_SWAPS_APPROVED_ZAPS_ABI,
    RELAY_SWAPS_ROUTING_TYPEHASH_ABI,
    RelaySwapsLayoutMismatch,
} from "../internal.js";

/** Configuration for EvmSwapChainAdapter construction. */
export interface EvmSwapChainAdapterConfig {
    /** RPC interactor for on-chain reads (router allowlist, calldata verification, allowance). */
    rpcInteractor: IRPCInteractor;
}

/**
 * EVM implementation of core-sdk's {@link ISwapChainAdapter}, backed by viem ABI encode/decode
 * against the RelaySwaps/LiFi-Diamond/ERC-20 ABI fragments. The one concrete implementation of
 * this interface today — see the interface's own doc for why core-sdk keeps it chain-agnostic
 * regardless.
 */
export class EvmSwapChainAdapter implements ISwapChainAdapter<PreparedTransaction, Address> {
    private readonly rpcInteractor: IRPCInteractor;
    private readonly routerAllowlist = new Map<string, boolean>();
    private readonly zapAllowlist = new Map<string, boolean>();
    private readonly routingLayoutVerified = new Set<string>();
    private readonly executorProbe = new Map<string, boolean>();

    constructor(config: EvmSwapChainAdapterConfig) {
        this.rpcInteractor = config.rpcInteractor;
    }

    /**
     * @inheritdoc ISwapChainAdapter.decodeSwapRouting
     * @throws {InvalidTransactParams} If the blob cannot be decoded.
     */
    decodeSwapRouting(data: Hex): SwapRouting<Address> {
        try {
            const [tuple] = decodeAbiParameters(RELAY_SWAP_ROUTING_ABI, data);
            return tuple as SwapRouting<Address>;
        } catch (error) {
            throw new InvalidTransactParams(
                `Failed to decode relayer swapCommitment.data: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /** @inheritdoc ISwapChainAdapter.isApprovedRouter */
    async isApprovedRouter(address: Address, relaySwapsAddress: Address): Promise<boolean> {
        const key = `${relaySwapsAddress.toLowerCase()}:${address.toLowerCase()}`;
        if (!this.routerAllowlist.has(key)) {
            const approved = await this.rpcInteractor.readContract({
                address: relaySwapsAddress,
                abi: RELAY_SWAPS_APPROVED_ROUTERS_ABI,
                functionName: "approvedRouters",
                args: [address],
            });
            this.routerAllowlist.set(key, approved as boolean);
        }
        return this.routerAllowlist.get(key)!;
    }

    /**
     * @inheritdoc ISwapChainAdapter.assertRoutingLayoutMatches
     * @throws {RelaySwapsLayoutMismatch} If the deployed contract's ROUTING_TYPEHASH disagrees with RELAY_SWAP_ROUTING_TYPEHASH.
     */
    async assertRoutingLayoutMatches(relaySwapsAddress: Address, chainId: number): Promise<void> {
        const key = relaySwapsAddress.toLowerCase();
        if (this.routingLayoutVerified.has(key)) return;

        const onChainTypehash = (await this.rpcInteractor.readContract({
            address: relaySwapsAddress,
            abi: RELAY_SWAPS_ROUTING_TYPEHASH_ABI,
            functionName: "ROUTING_TYPEHASH",
        })) as Hex;
        if (onChainTypehash.toLowerCase() !== RELAY_SWAP_ROUTING_TYPEHASH.toLowerCase()) {
            throw new RelaySwapsLayoutMismatch(
                relaySwapsAddress,
                RELAY_SWAP_ROUTING_TYPEHASH,
                onChainTypehash,
                chainId,
            );
        }
        this.routingLayoutVerified.add(key);
    }

    /** @inheritdoc ISwapChainAdapter.isApprovedZap */
    async isApprovedZap(zap: Address, relaySwapsAddress: Address): Promise<boolean> {
        const key = `${relaySwapsAddress.toLowerCase()}:${zap.toLowerCase()}`;
        if (!this.zapAllowlist.has(key)) {
            const approved = await this.rpcInteractor.readContract({
                address: relaySwapsAddress,
                abi: RELAY_SWAPS_APPROVED_ZAPS_ABI,
                functionName: "approvedZaps",
                args: [zap],
            });
            this.zapAllowlist.set(key, approved as boolean);
        }
        return this.zapAllowlist.get(key)!;
    }

    /**
     * @inheritdoc ISwapChainAdapter.extractEmbeddedRecipient
     *
     * Queries the LiFi Diamond's CalldataVerificationFacet: `extractMainParameters` (reads
     * `BridgeData.receiver`) for cross-chain paths, `extractGenericSwapParameters` (reads the
     * GenericSwapFacet receiver param) for same-chain paths. Both return a tuple where the
     * receiver address is at index 2.
     */
    async extractEmbeddedRecipient(
        transactionData: Hex,
        transactionTo: Address,
        isCrossChain: boolean,
    ): Promise<Address> {
        const decoded = await this.rpcInteractor.readContract({
            address: transactionTo,
            abi: isCrossChain
                ? CALLDATA_VERIFICATION_EXTRACT_MAIN_ABI
                : CALLDATA_VERIFICATION_EXTRACT_SWAP_ABI,
            functionName: isCrossChain ? "extractMainParameters" : "extractGenericSwapParameters",
            args: [transactionData],
        });
        return (decoded as [unknown, unknown, Address])[2];
    }

    /** @inheritdoc ISwapChainAdapter.buildTokenApprovalTxs */
    async buildTokenApprovalTxs(params: {
        token: Address;
        owner: Address;
        spender: Address;
        amount: Hex;
    }): Promise<PreparedTransaction[]> {
        const { token, owner, spender, amount } = params;
        const currentAllowance = (await this.rpcInteractor.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [owner, spender],
        })) as bigint;

        // Zero reset first on a residual allowance (mainnet USDT reverts otherwise), vuln-mining #28.
        return planApprovals(BigInt(currentAllowance), BigInt(amount), (value) => ({
            to: token,
            data: encodeFunctionData({
                abi: ERC20_APPROVE_ABI,
                functionName: "approve",
                args: [spender, value],
            }) as Hex,
            value: "0x0" as Hex,
        }));
    }

    /** @inheritdoc ISwapChainAdapter.parseApprovalTx */
    parseApprovalTx(tx: PreparedTransaction): ParsedApprovalTx<Address> {
        const { args } = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: tx.data });
        return {
            target: tx.to,
            spender: args[0] as Address,
            amount: args[1] as bigint,
        };
    }

    /** @inheritdoc ISwapChainAdapter.isSameToken */
    isSameToken(a: Address, b: Address): boolean {
        return isSameToken(a, b);
    }

    /**
     * @inheritdoc ISwapChainAdapter.isAddressEmbeddedInCalldata
     *
     * Solidity's `abi.encode(address)` left-pads a 20-byte address with 12 zero bytes to a
     * 32-byte word — this is how LiFi embeds `toContractAddress` inside the ABI-encoded
     * `contractCalls` struct. Checking for the padded form (not just the raw address bytes)
     * confirms the correct contract is targeted rather than a coincidental byte match elsewhere.
     */
    isAddressEmbeddedInCalldata(transactionData: Hex, address: Address): boolean {
        const paddedAddress = address.toLowerCase().slice(2).padStart(64, "0");
        return transactionData.toLowerCase().slice(2).includes(paddedAddress);
    }

    /** @inheritdoc ISwapChainAdapter.getDestinationDeliveryBudget */
    getDestinationDeliveryBudget(transactionData: Hex): bigint | undefined {
        return decodeStargateDestBudget(transactionData);
    }

    /** @inheritdoc ISwapChainAdapter.getDestinationCallAmount */
    getDestinationCallAmount(transactionData: Hex, depositCallData: Hex): bigint | undefined {
        return decodeLiFiDestinationCallAmount(transactionData, depositCallData);
    }

    /**
     * @inheritdoc ISwapChainAdapter.encodeSwapThenCall
     *
     * `swapAndExecute` takes `inputAmount` of the input: an ERC-20 through the Executor's
     * ERC20Proxy (the user's approval), the native coin as the transaction's value (LibSwap then
     * forwards it to the swap). The first call swaps it into `outputToken`; the second is handed
     * exactly `callValue` of it, as its value for the native coin or as an Executor approval to
     * `callTarget` for an ERC-20. The second call names the native coin as its output, so the
     * Executor returns leftover native coin, leftover input token and, through `noLeftovers`,
     * leftover output token to `receiver`. Native is LiFi's `address(0)` in every slot; with a
     * native output and an ERC-20 input this is byte-identical to the original two-step layout.
     */
    encodeSwapThenCall(params: SwapThenCallParams<Address>): Hex {
        const inputAsset = toLiFiAsset(params.inputToken);
        const outputAsset = toLiFiAsset(params.outputToken);
        return encodeFunctionData({
            abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
            functionName: "swapAndExecute",
            args: [
                LIFI_NATIVE_ZERO_BYTES32,
                [
                    {
                        callTo: params.swapTarget,
                        approveTo: params.swapApprovalAddress,
                        sendingAssetId: inputAsset,
                        receivingAssetId: outputAsset,
                        fromAmount: params.inputAmount,
                        callData: params.swapCallData,
                        requiresDeposit: false,
                    },
                    {
                        callTo: params.callTarget,
                        approveTo: params.callTarget,
                        sendingAssetId: outputAsset,
                        receivingAssetId: LIFI_NATIVE_ASSET,
                        fromAmount: params.callValue,
                        callData: params.callData,
                        requiresDeposit: false,
                    },
                ],
                inputAsset,
                params.receiver,
                params.inputAmount,
            ],
        });
    }

    /** @inheritdoc ISwapChainAdapter.decodeSwapThenCall */
    decodeSwapThenCall(transactionData: Hex): SwapThenCallParams<Address> | undefined {
        try {
            const { args } = decodeFunctionData({
                abi: LIFI_EXECUTOR_SWAP_AND_EXECUTE_ABI,
                data: transactionData,
            });
            const [, swaps, inputToken, receiver, inputAmount] = args;
            if (swaps.length !== 2) return undefined;
            // Native comes back in the SDK's own spelling, so callers compare it like any token.
            // Re-encoding below maps it to address(0) again, so calldata that spelled native any
            // other way does not round-trip and is refused.
            const params: SwapThenCallParams<Address> = {
                swapTarget: swaps[0].callTo,
                swapApprovalAddress: swaps[0].approveTo,
                swapCallData: swaps[0].callData,
                inputToken: canonicalTokenAddress(inputToken),
                inputAmount,
                outputToken: canonicalTokenAddress(swaps[0].receivingAssetId),
                callTarget: swaps[1].callTo,
                callData: swaps[1].callData,
                callValue: swaps[1].fromAmount,
                receiver,
            };
            return this.encodeSwapThenCall(params).toLowerCase() === transactionData.toLowerCase()
                ? params
                : undefined;
        } catch {
            return undefined;
        }
    }

    /** @inheritdoc ISwapChainAdapter.isSwapExecutorCall */
    isSwapExecutorCall(transactionData: Hex): boolean {
        return isLiFiExecutorCall(transactionData);
    }

    /**
     * @inheritdoc ISwapChainAdapter.isSwapExecutor
     *
     * See {@link isLiFiExecutor}; the `erc20Proxy()` probe result is cached per address;
     * a probe that fails (see above) throws and is not cached.
     */
    async isSwapExecutor(address: Address): Promise<boolean> {
        const key = address.toLowerCase();
        if (!this.executorProbe.has(key)) {
            const isExecutor = await isLiFiExecutor(address, (target) =>
                this.rpcInteractor.readContract({
                    address: target,
                    abi: LIFI_EXECUTOR_SCREENING_ABI,
                    functionName: "erc20Proxy",
                }),
            );
            this.executorProbe.set(key, isExecutor);
        }
        return this.executorProbe.get(key)!;
    }
}

/** LiFi's spelling of the native coin in `LibSwap.SwapData`. */
const LIFI_NATIVE_ASSET = "0x0000000000000000000000000000000000000000" as Address;

/** An asset id as LiFi's Executor reads it: either spelling of native becomes `address(0)`. */
function toLiFiAsset(token: Address): Address {
    return isSameToken(token, LIFI_NATIVE_ASSET) ? LIFI_NATIVE_ASSET : token;
}
const LIFI_NATIVE_ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
