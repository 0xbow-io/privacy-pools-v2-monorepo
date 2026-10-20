import { Account, BASE_FEE, Contract, Keypair, Networks, scValToNative, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import type { IStellarRPCInteractor, StellarYieldDeployment } from "../../../src/internal.js";
import {
    addressScVal,
    boolScVal,
    bytesScVal,
    groth16ProofScVal,
    InvalidYieldAmount,
    noteDataScVal,
    StellarPayoutRoutingCodec,
    StellarYieldRouterCodec,
    StellarYieldRouterInteractor,
    StellarYieldTokenInteractor,
    u128ScVal,
    u256ScVal,
    u32ScVal,
    UnexpectedDepositCalldata,
    UnexpectedWithdrawCalldata,
    vecScVal,
} from "../../../src/internal.js";

const PASSPHRASE = Networks.STANDALONE;
const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const POOL = contract(1);
const ROUTER = contract(2);
const SHARE = contract(3);
const UNDERLYING = contract(4);
const ADAPTER = contract(5);
const USER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();

const DEPLOYMENT: StellarYieldDeployment = {
    router: ROUTER,
    shareToken: SHARE,
    shareDecimals: 18,
    underlying: UNDERLYING,
    underlyingDecimals: 7,
    underlyingSymbol: "XLM",
};

const PROOF = groth16ProofScVal({
    a: `0x${"11".repeat(64)}`,
    b: `0x${"22".repeat(128)}`,
    c: `0x${"33".repeat(64)}`,
    pubSignals: [],
} as never);
const NOTE = noteDataScVal({ hint: `0x${"aa".repeat(32)}`, data: "0x0102" });

/** An unsimulated single-call envelope, the shape the yield entrypoint and pool adapter produce. */
function envelope(target: string, method: string, args: xdr.ScVal[]): string {
    return new TransactionBuilder(new Account(USER, "0"), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
        .addOperation(new Contract(target).call(method, ...args))
        .setTimeout(0)
        .build()
        .toXDR();
}

function rpcCapturing() {
    const buildTransaction = vi.fn(async (..._args: unknown[]) => "BUILT");
    const simulateRead = vi.fn();
    const rpcInteractor = { buildTransaction, simulateRead } as unknown as IStellarRPCInteractor;
    return { rpcInteractor, buildTransaction, simulateRead };
}

describe("StellarYieldRouterInteractor", () => {
    function setup(reads: Record<string, unknown>) {
        const { rpcInteractor, simulateRead } = rpcCapturing();
        simulateRead.mockImplementation(async (_id: string, method: string) => reads[method]);
        const token = new StellarYieldTokenInteractor({ rpcInteractor, contractId: SHARE, readSourcePublicKey: USER });
        const router = new StellarYieldRouterInteractor({
            rpcInteractor,
            contractId: ROUTER,
            readSourcePublicKey: USER,
            poolContractId: POOL,
            yieldToken: token,
        });
        return { router, simulateRead };
    }

    it("quote the router's own mint: value plus the truncated vetting-fee shares, priced at preview_mint", async () => {
        const { router, simulateRead } = setup({ get_asset_config: { vetting_fee_bps: 100 }, preview_mint: 12_345n });

        const quote = await router.quote(1_999n);

        // floor(1999 * 100 / 10000) = 19 fee shares.
        expect(quote).toEqual({ total: 2_018n, underlyingNeeded: 12_345n });
        const mintCall = simulateRead.mock.calls.find((c) => c[1] === "preview_mint")!;
        expect(scValToNative((mintCall[2] as xdr.ScVal[])[0]!)).toBe(2_018n);
    });

    it("read the supply buffer from the wrapper's adapter", async () => {
        const { router, simulateRead } = setup({ adapter_address: ADAPTER, supply_buffer: 3n });

        await expect(router.supplyBufferUnits()).resolves.toBe(3n);
        expect(simulateRead.mock.calls.find((c) => c[1] === "supply_buffer")![0]).toBe(ADAPTER);
    });
});

describe("StellarYieldRouterCodec", () => {
    const codec = (rpcInteractor: IStellarRPCInteractor) =>
        new StellarYieldRouterCodec({ rpcInteractor, networkPassphrase: PASSPHRASE });

    describe("encodeDepositExactShares", () => {
        const deposit = (asset: string, value: bigint, withLabel: boolean) =>
            envelope(POOL, withLabel ? "deposit_with_label" : "deposit", [
                addressScVal(USER),
                addressScVal(asset),
                u128ScVal(value),
                u256ScVal(7n),
                PROOF,
                NOTE,
                ...(withLabel ? [bytesScVal("0xc0ffee")] : []),
            ]);
        const args = { deployment: DEPLOYMENT, sharesValue: 500n, maxUnderlyingIn: 9_000n };

        it("re-target the share deposit at deposit_exact_shares with the proof, label and spend cap", async () => {
            const { rpcInteractor, buildTransaction } = rpcCapturing();

            await codec(rpcInteractor).encodeDepositExactShares(deposit(SHARE, 500n, true), args);

            const [target, method, callArgs, source] = buildTransaction.mock.calls[0]!;
            expect([target, method, source]).toEqual([ROUTER, "deposit_exact_shares", USER]);
            const native = (callArgs as xdr.ScVal[]).map((a) => scValToNative(a));
            expect(native.slice(0, 3)).toEqual([USER, 500n, 7n]);
            expect(Buffer.from(native[5] as Uint8Array).toString("hex")).toBe("c0ffee");
            expect(native[6]).toBe(9_000n);
        });

        it("pass an empty ciphertext through for a plain deposit, skipping label registration", async () => {
            const { rpcInteractor, buildTransaction } = rpcCapturing();

            await codec(rpcInteractor).encodeDepositExactShares(deposit(SHARE, 500n, false), args);

            const ciphertext = scValToNative((buildTransaction.mock.calls[0]![2] as xdr.ScVal[])[5]!) as Uint8Array;
            expect(ciphertext).toHaveLength(0);
        });

        it("refuse a deposit of another asset, or of other shares, with UnexpectedDepositCalldata", async () => {
            const { rpcInteractor } = rpcCapturing();

            await expect(codec(rpcInteractor).encodeDepositExactShares(deposit(UNDERLYING, 500n, true), args)).rejects.toThrow(
                UnexpectedDepositCalldata,
            );
            await expect(codec(rpcInteractor).encodeDepositExactShares(deposit(SHARE, 499n, true), args)).rejects.toThrow(
                UnexpectedDepositCalldata,
            );
        });

        it("fund nothing up front: the depositor's signature on the router call authorizes the pull", async () => {
            await expect(codec(rpcCapturing().rpcInteractor).planDepositFunding()).resolves.toEqual([]);
        });
    });

    describe("encodeWithdrawToUnderlying", () => {
        const routing = new StellarPayoutRoutingCodec().encode({
            recipient: RECIPIENT,
            feeRecipient: USER,
            feeAmount: 11n,
            nativeGas: 0n,
        });
        const transact = (processor: string, asset: string) =>
            envelope(POOL, "transact", [
                addressScVal(processor),
                boolScVal(true),
                u32ScVal(1),
                u32ScVal(1),
                PROOF,
                u256ScVal(1n),
                u256ScVal(2n),
                u256ScVal(3n),
                u128ScVal(100n),
                u256ScVal(4n),
                vecScVal([u256ScVal(5n)]),
                vecScVal([u256ScVal(6n)]),
                addressScVal(asset),
                vecScVal([NOTE]),
                bytesScVal(routing),
            ]);

        it("re-target the transact at withdraw_to_underlying with the routing it committed to and the floor", async () => {
            const { rpcInteractor, buildTransaction } = rpcCapturing();

            await codec(rpcInteractor).encodeWithdrawToUnderlying(transact(ROUTER, SHARE), {
                deployment: DEPLOYMENT,
                minUnderlyingOut: 77n,
                nativeGas: 0n,
            });

            const [target, method, callArgs] = buildTransaction.mock.calls[0]!;
            expect([target, method]).toEqual([ROUTER, "withdraw_to_underlying"]);
            const native = (callArgs as xdr.ScVal[]).map((a) => scValToNative(a));
            expect(native).toHaveLength(13);
            expect(native.slice(0, 2)).toEqual([1, 1]);
            expect(native[6]).toBe(100n);
            expect(native[11]).toEqual({ recipient: RECIPIENT, fee_recipient: USER, fee_amount: 11n });
            expect(native[12]).toBe(77n);
        });

        it("refuse a transact the router does not process, with UnexpectedWithdrawCalldata", async () => {
            await expect(
                codec(rpcCapturing().rpcInteractor).encodeWithdrawToUnderlying(transact(contract(9), SHARE), {
                    deployment: DEPLOYMENT,
                    minUnderlyingOut: 0n,
                    nativeGas: 0n,
                }),
            ).rejects.toThrow(UnexpectedWithdrawCalldata);
        });

        it("refuse a native-gas leg with InvalidYieldAmount, since Stellar's routing has none", async () => {
            await expect(
                codec(rpcCapturing().rpcInteractor).encodeWithdrawToUnderlying(transact(ROUTER, SHARE), {
                    deployment: DEPLOYMENT,
                    minUnderlyingOut: 0n,
                    nativeGas: 1n,
                }),
            ).rejects.toThrow(InvalidYieldAmount);
        });
    });
});
