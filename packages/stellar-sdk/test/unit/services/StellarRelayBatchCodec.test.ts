import { Keypair, scValToNative, StrKey } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import type { IStellarRPCInteractor, RelayBatchEncodeItem, StellarAddress, StellarProof } from "../../../src/internal.js";
import { StellarPayoutRoutingCodec, StellarRelayBatchCodec } from "../../../src/internal.js";

const RELAY = StrKey.encodeContract(Buffer.alloc(32, 1));
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 2));
const OWNER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();

const proof: StellarProof = {
    a: `0x${"11".repeat(64)}`,
    b: `0x${"22".repeat(128)}`,
    c: `0x${"33".repeat(64)}`,
    pubSignals: [],
} as unknown as StellarProof;

function item(amountOut: bigint, fee: bigint): RelayBatchEncodeItem<StellarAddress, StellarProof> {
    return {
        proof,
        pubSignals: [[1n], [2n, 3n], [4n], [5n], [6n], [amountOut], [7n], [8n]],
        transactParams: {
            processor: RELAY,
            data: new StellarPayoutRoutingCodec().encode({
                recipient: RECIPIENT,
                feeRecipient: OWNER,
                feeAmount: fee,
                nativeGas: 0n,
            }),
        },
        noteData: [{ hint: `0x${"aa".repeat(32)}`, data: "0x0102" }],
    };
}

function capture() {
    const buildTransaction = vi.fn(async (..._args: unknown[]) => "XDR");
    const rpcInteractor = { buildTransaction } as unknown as IStellarRPCInteractor;
    return { codec: new StellarRelayBatchCodec({ rpcInteractor, sourceAddress: OWNER }), buildTransaction };
}

describe("StellarRelayBatchCodec", () => {
    it("build relay_batch on the relay contract, submitted and authorized by the owner", async () => {
        const { codec, buildTransaction } = capture();

        await expect(codec.encodeRelayBatch(RELAY, [item(100n, 0n)], ASSET)).resolves.toBe("XDR");

        const [contract, method, args, source] = buildTransaction.mock.calls[0]!;
        expect(contract).toBe(RELAY);
        expect(method).toBe("relay_batch");
        expect(source).toBe(OWNER);
        const [relayer, asset] = (args as xdr.ScVal[]).map((a) => scValToNative(a));
        expect(relayer).toBe(OWNER);
        expect(asset).toBe(ASSET);
    });

    it("encode each item as the contract's BatchItem, with the routing its proof committed to", async () => {
        const { codec, buildTransaction } = capture();

        await codec.encodeRelayBatch(RELAY, [item(100n, 5n), item(200n, 7n)], ASSET);

        const items = scValToNative((buildTransaction.mock.calls[0]![2] as xdr.ScVal[])[2]!) as Record<string, unknown>[];
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({
            n: 1,
            m: 2,
            state_root: 4n,
            keystore_root: 5n,
            asp_root: 6n,
            amount_out: 100n,
            token_id_out: 7n,
            nullifier_hashes: [1n],
            output_commitments: [2n, 3n],
            routing: { recipient: RECIPIENT, fee_recipient: OWNER, fee_amount: 5n },
        });
        expect((items[1]!.routing as { fee_amount: bigint }).fee_amount).toBe(7n);
    });
});
