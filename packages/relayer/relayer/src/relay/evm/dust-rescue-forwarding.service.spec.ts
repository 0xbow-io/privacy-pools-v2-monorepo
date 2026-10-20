import { LIFI_EXECUTOR_SCREENING_ABI } from "@privacy-pools-v2/evm-sdk";
import { mock } from "jest-mock-extended";
import { ContractFunctionRevertedError, encodeEventTopics, getAddress, pad, toHex, type Address, type Hex, type Log } from "viem";
import { DustRescueForwardingService, type ForwardDustParams } from "./dust-rescue-forwarding.service";
import { EVMChainService } from "../../chain.service/evm.chain.service";
import { RelayerConfig } from "../../config/relayer-config";
import { createMockLogger } from "../../test/mocks";

const getSwapQuote = jest.fn();
jest.mock("@privacy-pools-v2/evm-sdk", () => ({
    ...jest.requireActual("@privacy-pools-v2/evm-sdk"),
    LiFiSwapQuoteProvider: jest.fn().mockImplementation(() => ({ getSwapQuote })),
}));

const TRANSFER_EVENT_ABI = [
    {
        type: "event",
        name: "Transfer",
        inputs: [
            { name: "from", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
        ],
    },
] as const;

const addr = (n: number): Address => getAddress(pad(toHex(n), { size: 20 }));
const ASSET: Address = addr(1);
const SOME_SENDER: Address = addr(3);
const UNIFIED_WALLET: Address = addr(4);
const RELAY_SWAPS = "0x00000000000000000000000000000000000012aa" as Address;
const SIGNER: Address = addr(5);
const APPROVAL_ADDRESS: Address = addr(6);
const SWAP_TARGET: Address = addr(7);
const TOKEN_ID: Address = addr(8);

// 1.5 USDC — above the 1 USDC MIN_FORWARD_AMOUNT so forwarding tests proceed to the quote step.
const DUST_AMOUNT = 1_500_000n;

function transferLog(address: Address, from: Address, to: Address, value: bigint): Log {
    return {
        address,
        topics: encodeEventTopics({ abi: TRANSFER_EVENT_ABI, eventName: "Transfer", args: { from, to } }),
        data: pad(toHex(value)),
    } as unknown as Log;
}

function baseParams(overrides: Partial<ForwardDustParams> = {}): ForwardDustParams {
    return {
        sourceTxHash: "0xsource" as Hex,
        proofAsset: ASSET,
        // The honest shape: dustRecipient equals the relayer's own signer address
        // (SIGNER), which is what actually gates the forward — see the
        // "ignores a hostile dustRecipient" test below for the dishonest shape.
        dustRecipient: SIGNER,
        destinationChainId: 8453,
        tokenId: TOKEN_ID,
        relayFeeAmount: 0n, // fee-subtraction tested separately
        feeRecipient: SIGNER, // same as the signer wallet so fee IS included when non-zero
        ...overrides,
    };
}


function validQuote(overrides: Record<string, unknown> = {}) {
    return {
        approvalAddress: APPROVAL_ADDRESS,
        transactionTo: SWAP_TARGET,
        transactionData: "0xcalldata",
        fromTokenAddress: ASSET,
        toTokenAddress: TOKEN_ID,
        fromChainId: 42161,
        toChainId: 8453,
        ...overrides,
    };
}

/** readContract serves two reads: the ERC-20 allowance and RelaySwaps.approvedRouters. */
let stubReads: (opts: { allowance: bigint; approved?: (router: string) => boolean }) => void;

describe("DustRescueForwardingService", () => {
    let chainService: ReturnType<typeof mock<EVMChainService>>;
    let relayerConfig: ReturnType<typeof mock<RelayerConfig>>;
    let service: DustRescueForwardingService;

    beforeEach(() => {
        jest.clearAllMocks();
        chainService = mock<EVMChainService>();
        stubReads = ({ allowance, approved = () => true }) =>
            chainService.readContract.mockImplementation((async (call: { functionName: string; args?: readonly unknown[] }) =>
                call.functionName === "approvedRouters" ? approved(String(call.args?.[0])) : allowance) as never);
        relayerConfig = mock<RelayerConfig>();
        relayerConfig.chain.mockReturnValue({
            config: () => ({
                dust_rescue_recipient_address: UNIFIED_WALLET,
                relay_swaps_contract: RELAY_SWAPS,
            }),
        } as never);
        chainService.signerAddress.mockResolvedValue(SIGNER);
        stubReads({ allowance: 0n }); // no existing allowance by default; both LiFi addresses allowlisted
        chainService.sendRawTransaction.mockResolvedValue("0xforwardtx" as Hex);
        getSwapQuote.mockResolvedValue(validQuote());
        service = new DustRescueForwardingService(createMockLogger() as never, chainService, relayerConfig);
    });

    it("forwards dust #1: parses the Transfer log, quotes, approves, and sends.", async () => {
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [transferLog(ASSET, SOME_SENDER, SIGNER, DUST_AMOUNT)],
        } as never);

        const result = await service.forward(42161, baseParams());

        expect(result).toBe("0xforwardtx");
        expect(getSwapQuote).toHaveBeenCalledWith(
            expect.objectContaining({
                fromChainId: 42161,
                toChainId: 8453,
                fromToken: ASSET,
                toToken: TOKEN_ID,
                fromAddress: SIGNER,
                toAddress: UNIFIED_WALLET,
                amount: DUST_AMOUNT.toString(),
                amountType: "from",
            }),
        );
        // Allowance insufficient (mocked 0n) -> one approve send, then the swap send.
        expect(chainService.sendRawTransaction).toHaveBeenCalledTimes(2);
        expect(chainService.sendRawTransaction).toHaveBeenLastCalledWith({
            to: SWAP_TARGET,
            data: "0xcalldata",
            value: 0n,
        });
    });

    it("forwards a same-chain job identically — fromChainId equals destinationChainId.", async () => {
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [transferLog(ASSET, SOME_SENDER, SIGNER, DUST_AMOUNT)],
        } as never);
        getSwapQuote.mockResolvedValue(validQuote({ fromChainId: 8453, toChainId: 8453 }));

        const result = await service.forward(8453, baseParams({ destinationChainId: 8453 }));

        expect(result).toBe("0xforwardtx");
        expect(getSwapQuote).toHaveBeenCalledWith(
            expect.objectContaining({ fromChainId: 8453, toChainId: 8453 }),
        );
        expect(chainService.sendRawTransaction).toHaveBeenLastCalledWith({
            to: SWAP_TARGET,
            data: "0xcalldata",
            value: 0n,
        });
    });

    it("resets a non-zero, insufficient allowance to zero before re-approving (mainnet USDT), then swaps.", async () => {
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [transferLog(ASSET, SOME_SENDER, SIGNER, DUST_AMOUNT)],
        } as never);
        stubReads({ allowance: DUST_AMOUNT / 2n });

        const result = await service.forward(42161, baseParams());

        expect(result).toBe("0xforwardtx");
        // approve(0), approve(DUST_AMOUNT), then the swap.
        expect(chainService.sendRawTransaction).toHaveBeenCalledTimes(3);
        const calls = (chainService.sendRawTransaction as jest.Mock).mock.calls.map((c) => c[0] as { to: string; data: string });
        expect(calls[0]?.to).toBe(ASSET);
        expect(calls[0]?.data).toMatch(/^0x095ea7b3.*0{64}$/); // approve(spender, 0)
        expect(calls[1]?.to).toBe(ASSET);
        expect(calls[1]?.data.endsWith(DUST_AMOUNT.toString(16).padStart(64, "0"))).toBe(true);
        expect(calls[2]?.to).toBe(SWAP_TARGET);
    });

    it("skips the approval send when allowance is already sufficient.", async () => {
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [transferLog(ASSET, SOME_SENDER, SIGNER, DUST_AMOUNT)],
        } as never);
        stubReads({ allowance: DUST_AMOUNT });

        await service.forward(42161, baseParams());

        expect(chainService.sendRawTransaction).toHaveBeenCalledTimes(1);
    });

    it("sums multiple matching Transfer logs to the relayer's own signer wallet.", async () => {
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [
                transferLog(ASSET, SOME_SENDER, SIGNER, 1_000_000n),
                transferLog(ASSET, SOME_SENDER, SIGNER, 500_000n),
            ],
        } as never);

        await service.forward(42161, baseParams());

        expect(getSwapQuote).toHaveBeenCalledWith(expect.objectContaining({ amount: "1500000" }));
    });

    it("returns undefined and skips everything when no matching Transfer log exists.", async () => {
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [transferLog(ASSET, SOME_SENDER, SOME_SENDER, 100n)], // wrong recipient
        } as never);

        const result = await service.forward(42161, baseParams());

        expect(result).toBeUndefined();
        expect(getSwapQuote).not.toHaveBeenCalled();
        expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
    });

    // RC-03: sizing must never trust the caller-supplied dustRecipient — only what
    // actually lands in the relayer's own signer wallet counts as swept dust.
    it("ignores a hostile dustRecipient: a transfer to an attacker-chosen address is not counted, even at the full withdrawal amount.", async () => {
        const ATTACKER: Address = addr(9);
        chainService.waitForTransactionReceipt.mockResolvedValue({
            // Variant 1 from the finding: dustRecipient pointed at an address that
            // received the *entire* withdrawal (e.g. RelaySwaps' own payout), not a
            // crumb — and it's still ignored, because it never reached SIGNER.
            logs: [transferLog(ASSET, SOME_SENDER, ATTACKER, 50_000_000_000n)],
        } as never);

        const result = await service.forward(42161, baseParams({ dustRecipient: ATTACKER, feeRecipient: ATTACKER }));

        expect(result).toBeUndefined();
        expect(getSwapQuote).not.toHaveBeenCalled();
        expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
    });

    it("does not let a hostile dustRecipient's transfer inflate a genuine, smaller sweep to the signer wallet.", async () => {
        const ATTACKER: Address = addr(9);
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [
                // Genuine dust, correctly swept to the relayer's own wallet.
                transferLog(ASSET, SOME_SENDER, SIGNER, DUST_AMOUNT),
                // An unrelated, attacker-named transfer in the same receipt — must not
                // be added to the genuine sweep just because dustRecipient claims it.
                transferLog(ASSET, SOME_SENDER, ATTACKER, 50_000_000_000n),
            ],
        } as never);

        await service.forward(42161, baseParams({ dustRecipient: ATTACKER }));

        expect(getSwapQuote).toHaveBeenCalledWith(expect.objectContaining({ amount: DUST_AMOUNT.toString() }));
    });

    it("returns undefined when the destination chain has no dust_rescue_recipient_address configured.", async () => {
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [transferLog(ASSET, SOME_SENDER, SIGNER, DUST_AMOUNT)],
        } as never);
        relayerConfig.chain.mockReturnValue({
            config: () => ({ dust_rescue_recipient_address: undefined }),
        } as never);

        const result = await service.forward(42161, baseParams());

        expect(result).toBeUndefined();
        expect(getSwapQuote).not.toHaveBeenCalled();
    });

    it("returns undefined (not throw) when the LiFi quote fails.", async () => {
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [transferLog(ASSET, SOME_SENDER, SIGNER, DUST_AMOUNT)],
        } as never);
        getSwapQuote.mockRejectedValue(new Error("no route"));

        const result = await service.forward(42161, baseParams());

        expect(result).toBeUndefined();
    });

    it("returns undefined (not throw) when broadcasting the swap fails.", async () => {
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [transferLog(ASSET, SOME_SENDER, SIGNER, DUST_AMOUNT)],
        } as never);
        stubReads({ allowance: DUST_AMOUNT });
        chainService.sendRawTransaction.mockRejectedValue(new Error("insufficient funds"));

        const result = await service.forward(42161, baseParams());

        expect(result).toBeUndefined();
    });

    it("returns undefined (not throw) when waiting for the source receipt fails.", async () => {
        chainService.waitForTransactionReceipt.mockRejectedValue(new Error("rpc timeout"));

        const result = await service.forward(42161, baseParams());

        expect(result).toBeUndefined();
        expect(getSwapQuote).not.toHaveBeenCalled();
    });

    it("returns undefined and skips bridging when actual swept dust (after fee subtraction) is below the minimum.", async () => {
        // 70_000 total transfers, 21_000 fee → actual swept dust = 49_000 < 50_000 minimum.
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [transferLog(ASSET, SOME_SENDER, SIGNER, 70_000n)],
        } as never);

        const result = await service.forward(42161, baseParams({ relayFeeAmount: 21_000n }));

        expect(result).toBeUndefined();
        expect(getSwapQuote).not.toHaveBeenCalled();
    });

    it("subtracts relay fee from total transfers before quoting.", async () => {
        // 1_521_000 total transfers − 21_000 relay fee = 1_500_000 actual dust quoted.
        chainService.waitForTransactionReceipt.mockResolvedValue({
            logs: [transferLog(ASSET, SOME_SENDER, SIGNER, 1_521_000n)],
        } as never);

        await service.forward(42161, baseParams({ relayFeeAmount: 21_000n }));

        expect(getSwapQuote).toHaveBeenCalledWith(expect.objectContaining({ amount: "1500000" }));
    });

    describe("the LiFi quote is third-party data — the signer only acts on it if RelaySwaps would (minr #12)", () => {
        beforeEach(() => {
            chainService.waitForTransactionReceipt.mockResolvedValue({
                logs: [transferLog(ASSET, SOME_SENDER, SIGNER, DUST_AMOUNT)],
            } as never);
        });

        it("checks both transactionTo and approvalAddress against RelaySwaps.approvedRouters before approving or sending.", async () => {
            await service.forward(42161, baseParams());

            for (const router of [SWAP_TARGET, APPROVAL_ADDRESS]) {
                expect(chainService.readContract).toHaveBeenCalledWith(
                    expect.objectContaining({ address: RELAY_SWAPS, functionName: "approvedRouters", args: [router] }),
                );
            }
            expect(chainService.sendRawTransaction).toHaveBeenCalledTimes(2);
        });

        it("refuses a transactionTo that is not allowlisted: no approve, no send, dust stays put.", async () => {
            stubReads({ allowance: 0n, approved: (r) => r.toLowerCase() !== SWAP_TARGET.toLowerCase() });

            const result = await service.forward(42161, baseParams());

            expect(result).toBeUndefined();
            expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
        });

        it("refuses an approvalAddress that is not allowlisted, even when transactionTo is.", async () => {
            stubReads({ allowance: 0n, approved: (r) => r.toLowerCase() !== APPROVAL_ADDRESS.toLowerCase() });

            const result = await service.forward(42161, baseParams());

            expect(result).toBeUndefined();
            expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
        });

        it("refuses a quote whose transactionTo is the token contract itself (a transfer() payload would drain the signer).", async () => {
            getSwapQuote.mockResolvedValue(validQuote({ transactionTo: ASSET }));

            const result = await service.forward(42161, baseParams());

            expect(result).toBeUndefined();
            expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
        });

        // LiFi's Executor is on approvedRouters but runs arbitrary calls for anyone: as the spender
        // anyone could drain the signer's approval if the forward reverts; as the target it could
        // send the signer's dust anywhere.
        const LIFI_EXECUTOR = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;

        it("refuses LiFi's Executor as the approval spender, even though it is allowlisted.", async () => {
            getSwapQuote.mockResolvedValue(validQuote({ approvalAddress: LIFI_EXECUTOR }));

            const result = await service.forward(42161, baseParams());

            expect(result).toBeUndefined();
            expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
        });

        it("refuses LiFi's Executor as the transaction target, even though it is allowlisted.", async () => {
            getSwapQuote.mockResolvedValue(validQuote({ transactionTo: LIFI_EXECUTOR }));

            const result = await service.forward(42161, baseParams());

            expect(result).toBeUndefined();
            expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
        });

        it("refuses a call into an Executor entry point (swapAndExecute) whatever the target.", async () => {
            getSwapQuote.mockResolvedValue(validQuote({ transactionData: "0xa83cbaa3" + "00".repeat(64) }));

            const result = await service.forward(42161, baseParams());

            expect(result).toBeUndefined();
            expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
        });

        it("refuses an unlisted spender that identifies as an Executor on-chain (erc20Proxy()).", async () => {
            chainService.readContract.mockImplementation((async (call: { functionName: string; address: string }) => {
                if (call.functionName === "approvedRouters") return true;
                if (call.functionName === "erc20Proxy") {
                    if (call.address === APPROVAL_ADDRESS) return "0x68E1Acfa805dcA813116Ed6507E01c38D44318f0";
                    throw new ContractFunctionRevertedError({
                        abi: LIFI_EXECUTOR_SCREENING_ABI,
                        functionName: "erc20Proxy",
                        message: "execution reverted",
                    });
                }
                return 0n;
            }) as never);

            const result = await service.forward(42161, baseParams());

            expect(result).toBeUndefined();
            expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
        });

        it("forwards when every erc20Proxy() read reverts: a revert means not an Executor.", async () => {
            chainService.readContract.mockImplementation((async (call: { functionName: string }) => {
                if (call.functionName === "approvedRouters") return true;
                if (call.functionName === "erc20Proxy") {
                    throw new ContractFunctionRevertedError({
                        abi: LIFI_EXECUTOR_SCREENING_ABI,
                        functionName: "erc20Proxy",
                        message: "execution reverted",
                    });
                }
                return 0n;
            }) as never);

            const result = await service.forward(42161, baseParams());

            expect(result).toBe("0xforwardtx");
            expect(chainService.sendRawTransaction).toHaveBeenCalledTimes(2);
            expect(chainService.sendRawTransaction).toHaveBeenLastCalledWith({
                to: SWAP_TARGET,
                data: "0xcalldata",
                value: 0n,
            });
        });

        it("leaves the dust in place when an erc20Proxy() read fails without reverting.", async () => {
            chainService.readContract.mockImplementation((async (call: { functionName: string }) => {
                if (call.functionName === "approvedRouters") return true;
                if (call.functionName === "erc20Proxy") throw new Error("fetch failed");
                return 0n;
            }) as never);

            const result = await service.forward(42161, baseParams());

            expect(result).toBeUndefined();
            expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
        });

        it("refuses a quote that echoes a different token or chain than requested.", async () => {
            for (const bad of [
                { toTokenAddress: "0x000000000000000000000000000000000000beef" },
                { fromTokenAddress: "0x000000000000000000000000000000000000beef" },
                { toChainId: 1 },
                { fromChainId: 1 },
            ]) {
                chainService.sendRawTransaction.mockClear();
                getSwapQuote.mockResolvedValue(validQuote(bad));

                const result = await service.forward(42161, baseParams());

                expect(result).toBeUndefined();
                expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
            }
        });

        it("skips forwarding on a chain with no relay_swaps_contract — nothing to validate the quote against.", async () => {
            relayerConfig.chain.mockReturnValue({
                config: () => ({ dust_rescue_recipient_address: UNIFIED_WALLET, relay_swaps_contract: undefined }),
            } as never);

            const result = await service.forward(42161, baseParams());

            expect(result).toBeUndefined();
            expect(chainService.sendRawTransaction).not.toHaveBeenCalled();
        });
    });
});
