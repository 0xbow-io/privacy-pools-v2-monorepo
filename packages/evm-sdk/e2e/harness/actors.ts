import { createWalletClient, http, keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import type { Address, Hex, ProtocolKeys } from "../../src/internal.js";
import { CryptoService } from "../../src/internal.js";
import { fundAddress } from "../network.js";
import type { E2EContext } from "./context.js";
import { laneRpcUrl } from "./context.js";
import { deriveTestKeys } from "./keys.js";

export const MOCK_ERC20_ABI = [
    {
        name: "mint",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "_to", type: "address" },
            { name: "_amount", type: "uint256" },
        ],
        outputs: [],
    },
    {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
    {
        name: "allowance",
        type: "function",
        stateMutability: "view",
        inputs: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
    },
] as const;

/** A test participant: a fresh EOA plus fresh protocol keys. Nothing is registered on-chain. */
export interface Actor {
    name: string;
    account: ReturnType<typeof privateKeyToAccount>;
    address: Address;
    keys: ProtocolKeys;
    /**
     * Set only for signature-derived actors ({@link createSignedActor}). Revocable-key rotation and
     * index discovery re-derive keys from this signature, so they only work for such actors.
     */
    signature?: Hex;
    /** Ready-made argument for `rotateRevocableKey` / `discoverRevocableKeyIndex` (signature-derived actors only). */
    derivation?: SignatureDerivation;
}

/** The signature-derivation inputs the session's rotation/discovery APIs take. */
export interface SignatureDerivation {
    signature: Hex;
    signerAddress: Address;
    /** `keccak256(signerAddress)` — the SDK verifies it to catch payloads built for another signer. */
    addressHash: Hex;
}

export interface CreateActorOptions {
    /** Give the actor gas money. Defaults to `true`; pass `false` for an unfunded (0 ETH) account. */
    funded?: boolean;
}

/** Creates an actor with random keys; independent of every other actor and every other file. */
export async function createActor(name: string, options: CreateActorOptions = {}): Promise<Actor> {
    const account = privateKeyToAccount(generatePrivateKey());
    const actor: Actor = { name, account, address: account.address as Address, keys: deriveTestKeys() };
    if (options.funded ?? true) await fundAddress(laneRpcUrl(), actor.address);
    return actor;
}

export function walletFor(ctx: E2EContext, actor: Actor) {
    return createWalletClient({ account: actor.account, chain: sepolia, transport: http(ctx.network.rpcUrl) });
}

/** `MockERC20.mint` is unrestricted, so an actor can mint to any address. Sequential per actor. */
export async function mintErc20(
    ctx: E2EContext,
    actor: Actor,
    token: Address,
    amount: bigint,
    to: Address = actor.address,
): Promise<void> {
    const hash = await walletFor(ctx, actor).writeContract({
        address: token,
        abi: MOCK_ERC20_ABI,
        functionName: "mint",
        args: [to, amount],
    });
    await ctx.publicClient.waitForTransactionReceipt({ hash });
}

const DERIVATION_MESSAGE = "privacy-pools e2e key derivation";

/** Protocol keys for `signature`/`signerAddress` at a given revocable-key rotation index. */
export function keysAtIndex(signature: Hex, signerAddress: Address, revocableKeyIndex: Hex): ProtocolKeys {
    const addressHash = keccak256(toBytes(signerAddress)) as Hex;
    const derived = new CryptoService().deriveKeysFromSignature({
        signature,
        signerAddress,
        revocableKeyIndex,
        addressHash,
    });
    return { ...derived, revocableKeyIndex };
}

/**
 * An actor whose protocol keys are derived from a wallet signature, like a real integrator's — the
 * only kind for which revocable-key rotation and index discovery work (they re-derive from the
 * signature). Any 65-byte signature by the account is a valid root secret.
 */
export async function createSignedActor(name: string, options: CreateActorOptions = {}): Promise<Actor> {
    const account = privateKeyToAccount(generatePrivateKey());
    const address = account.address as Address;
    const signature = (await account.signMessage({ message: DERIVATION_MESSAGE })) as Hex;
    const actor: Actor = {
        name,
        account,
        address,
        signature,
        derivation: { signature, signerAddress: address, addressHash: keccak256(toBytes(address)) as Hex },
        keys: keysAtIndex(signature, address, "0x0" as Hex),
    };
    if (options.funded ?? true) await fundAddress(laneRpcUrl(), address);
    return actor;
}
