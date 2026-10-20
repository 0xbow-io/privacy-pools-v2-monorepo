import { describe, expect, it, vi } from "vitest";

import type { Address, Hex, ILogger, TxReceipt } from "../../../src/internal.js";
import {
  notifyBroadcast,
  PoolSessionReshield,
  PoolSessionReshieldCrosschain,
} from "../../../src/internal.js";

const RELAYER = "0x00000000000000000000000000000000000000aa" as Address;
const TOKEN = "0x00000000000000000000000000000000000000bb" as Address;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

/**
 * Builds a session past its constructor with every relay-time check stubbed, so the test
 * isolates the relay -> onBroadcast -> receipt ordering. `events` records that order.
 */
function makeSession(
  Ctor: typeof PoolSessionReshield | typeof PoolSessionReshieldCrosschain,
) {
  const events: string[] = [];
  let resolveReceipt!: (r: TxReceipt) => void;
  const receipt = {
    status: true,
    txHash: TX_HASH,
    logs: [],
  } as unknown as TxReceipt;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  const session = Object.create(Ctor.prototype) as Record<string, unknown>;
  Object.assign(session, {
    chainId: 1,
    logger,
    yieldDepositTargets: [],
    relaySwapsAddress: RELAYER,
    addressEqualityComparator: {
      equals: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
    },
    swapChainAdapter: {
      decodeSwapRouting: () => ({
        swapTarget: RELAYER,
        approvalAddress: RELAYER,
        swapCalldata: "0x",
      }),
      isSwapExecutor: async () => false,
      isSwapExecutorCall: () => false,
      isSameToken: () => false,
    },
    core: {
      prepareTransact: async () => ({
        proof: {},
        notesData: [],
        changePendingNotes: [],
        spentNotes: [],
        spentNullifiers: [],
      }),
      persistNoteUpdates: vi.fn(async () => undefined),
    },
    relayerInteractor: {
      relaySwap: vi.fn(async () => {
        events.push("relay");
        await Promise.resolve();
        events.push("relayed");
        return TX_HASH;
      }),
    },
    rpcInteractor: {
      waitForTransactionReceipt: vi.fn(
        () =>
          new Promise<TxReceipt>((resolve) => {
            events.push("wait");
            resolveReceipt = (r) => {
              events.push("receipt");
              resolve(r);
            };
          }),
      ),
    },
  });
  for (const name of [
    "yieldTargetFor",
    "assertDestinationChainMatches",
    "assertRelayerChainMatchesPool",
    "assertSwapCalldataMatches",
    "isConfiguredExecutor",
    "assertAmountSentMatchesAmountPlusFee",
    "assertReshieldRouting",
    "assertReshieldCrosschainRouting",
  ]) {
    session[name] = () => undefined;
  }
  const resolve = () => resolveReceipt(receipt);
  return { session, events, logger, resolve, receipt };
}

const baseParams = {
  inputCommitments: [],
  amount: "0x1" as Hex,
  tokenId: TOKEN,
  outputToken: TOKEN,
  toChainId: 10,
  toChainType: "evm",
  fallbackAddress: RELAYER,
  swapCalldata: "0x" as Hex,
  selectedQuote: {
    relayerInfo: {
      address: RELAYER,
      processorAddress: RELAYER,
      chainId: 1,
      chainType: "evm",
    },
    quote: {
      feeAmount: "0",
      feeCommitment: {
        data: "0x",
        asset: TOKEN,
        amountSent: "0x1",
        expiration: Date.now() + 600_000,
      },
    },
  },
};

const cases = [
  { name: "relayReshield", Ctor: PoolSessionReshield, method: "relayReshield" },
  {
    name: "relayReshieldCrosschain",
    Ctor: PoolSessionReshieldCrosschain,
    method: "relayReshieldCrosschain",
  },
] as const;

describe.each(cases)("$name onBroadcast", ({ Ctor, method }) => {
  async function run(onBroadcast?: (txHash: Hex) => unknown) {
    const ctx = makeSession(Ctor);
    const relay = ctx.session[method] as (p: unknown) => Promise<TxReceipt>;
    const pending = relay.call(ctx.session, {
      ...baseParams,
      ...(onBroadcast
        ? {
            onBroadcast: (hash: Hex) => {
              ctx.events.push("broadcast");
              return onBroadcast(hash);
            },
          }
        : {}),
    });
    await vi.waitFor(() => expect(ctx.events).toContain("wait"));
    return { ...ctx, pending };
  }

  it("fires once with the relayed hash before the receipt resolves", async () => {
    const onBroadcast = vi.fn((_hash: Hex) => undefined);
    const ctx = await run(onBroadcast);
    expect(onBroadcast).toHaveBeenCalledTimes(1);
    expect(onBroadcast).toHaveBeenCalledWith(TX_HASH);
    expect(ctx.events).not.toContain("receipt");
    expect(ctx.events).toEqual(["relay", "relayed", "broadcast", "wait"]);
    ctx.resolve();
    await expect(ctx.pending).resolves.toBe(ctx.receipt);
    expect(onBroadcast).toHaveBeenCalledTimes(1);
    // Fired after relaySwap resolved, before the receipt wait began, while the receipt is held open.
    expect(ctx.events).toEqual(["relay", "relayed", "broadcast", "wait", "receipt"]);
  });

  it("swallow a rejecting async callback without failing the relay or leaking a rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const ctx = await run(async () => {
        throw new Error("async ui blew up");
      });
      ctx.resolve();
      await expect(ctx.pending).resolves.toBe(ctx.receipt);
      await new Promise((r) => setTimeout(r, 0));
      expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("swallow a throwing callback without failing the relay", async () => {
    const ctx = await run(() => {
      throw new Error("ui blew up");
    });
    ctx.resolve();
    await expect(ctx.pending).resolves.toBe(ctx.receipt);
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect(
      (ctx.session.core as { persistNoteUpdates: unknown }).persistNoteUpdates,
    ).toHaveBeenCalledTimes(1);
  });

  it("leave the relay unchanged and reach the relayer with nothing extra when no callback is given", async () => {
    const ctx = await run();
    ctx.resolve();
    await expect(ctx.pending).resolves.toBe(ctx.receipt);
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    const relaySwap = (
      ctx.session.relayerInteractor as { relaySwap: ReturnType<typeof vi.fn> }
    ).relaySwap;
    expect(Object.keys(relaySwap.mock.calls[0][1] as object)).not.toContain(
      "onBroadcast",
    );
  });
});

describe("notifyBroadcast", () => {
  it("swallows a throwing logger too", () => {
    const logger: ILogger = {
      child: vi.fn(),
      level: "debug",
      fatal: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(() => {
        throw new Error("logger down");
      }),
    } as unknown as ILogger;
    expect(() =>
      notifyBroadcast(
        () => {
          throw new Error("ui blew up");
        },
        TX_HASH,
        logger,
      ),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
