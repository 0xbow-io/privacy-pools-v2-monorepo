import { BadRequestException } from "@nestjs/common";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, ExecutionRevertedError, HttpRequestError, RpcRequestError, WaitForTransactionReceiptTimeoutError } from "viem";
import { classifyDetail, clientSafeErrorMessage, publicHostLabel, redactText, redactUrls, registerKnownSecrets, secretTokensFromUrl } from "./redact";

const KEY = "alch_SECRETKEY0123456789";
const RPC = `https://bsc-mainnet.g.alchemy.com/v2/${KEY}`;

describe("redactUrls", () => {
    it("keeps the host and drops the path where the API key lives", () => {
        expect(redactUrls(`failed against ${RPC} twice`)).toBe(
            "failed against https://bsc-mainnet.<…>.alchemy.com/… twice"
        );
        expect(redactUrls(`a ${RPC} and ${RPC}?x=1`)).not.toContain(KEY);
    });

    it("leaves text without URLs alone", () => {
        expect(redactUrls("Relay fee (12) exceeds withdrawal amount (10).")).toBe(
            "Relay fee (12) exceeds withdrawal amount (10)."
        );
    });
});

describe("clientSafeErrorMessage", () => {
    it("reduces a viem transport failure to its short message plus the RPC host", () => {
        // The real producer: viem's HttpRequestError message embeds the URL and the request body.
        const err = new HttpRequestError({
            url: RPC,
            body: { method: "eth_call", params: [{ to: "0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869", data: "0x883bdbfd" }] },
            details: "fetch failed",
        });
        expect(err.message).toContain(KEY);
        const safe = clientSafeErrorMessage(err);
        expect(safe).toBe("HTTP request failed (RPC bsc-mainnet.<…>.alchemy.com).");
        expect(safe).not.toContain(KEY);
        expect(safe).not.toContain("0x883bdbfd");
    });

    it("finds the transport error under a contract-call wrapper", () => {
        const inner = new HttpRequestError({ url: RPC, body: { method: "eth_call" }, details: "fetch failed" });
        const wrapped = new ContractFunctionExecutionError(inner, {
            abi: [{ type: "function", name: "observe", stateMutability: "view", inputs: [], outputs: [] }],
            functionName: "observe",
            contractAddress: "0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869",
        });
        expect(wrapped.message).toContain(KEY);
        const safe = clientSafeErrorMessage(wrapped);
        expect(safe).not.toContain(KEY);
        expect(safe).toContain("bsc-mainnet.<…>.alchemy.com");
    });

    it("redacts a plain Error that embeds a viem-style message", () => {
        const err = new Error(`HTTP request failed.\n\nURL: ${RPC}\nRequest body: {"method":"eth_call"}\n\nVersion: viem@2.0.0`);
        expect(clientSafeErrorMessage(err)).toBe("HTTP request failed.");
    });

    it("passes an ordinary message through unchanged", () => {
        expect(clientSafeErrorMessage(new Error("CowSwap does not support chainId=56"))).toBe(
            "CowSwap does not support chainId=56"
        );
        expect(clientSafeErrorMessage("plain string")).toBe("plain string");
    });

    it("is what a BadRequestException built from it carries", () => {
        const err = new HttpRequestError({ url: RPC, body: { method: "eth_call" }, details: "fetch failed" });
        const http = new BadRequestException(clientSafeErrorMessage(err));
        expect(JSON.stringify(http.getResponse())).not.toContain(KEY);
    });
});

describe("redactText", () => {
    it("cuts every verbose viem section and keeps the first line", () => {
        const text = `Quote failed: HTTP request failed.\nURL: ${RPC}\nRaw Call Arguments:\n  to: 0xabc\nContract Call:\n  address: 0xabc\nDocs: https://viem.sh/docs\nVersion: viem@2`;
        expect(redactText(text)).toBe("Quote failed: HTTP request failed.");
    });

    it("reduces URLs that are not in a verbose section", () => {
        expect(redactText(`withdrawal failed: HTTP request failed (${RPC}).`)).toBe(
            "withdrawal failed: HTTP request failed (https://bsc-mainnet.<…>.alchemy.com/…)."
        );
    });
});

describe("redactUrls: schemes and authorities (codex + cubic on #399)", () => {
    it("matches ws/wss and uppercase schemes", () => {
        expect(redactUrls(`ws ${"wss://rpc.example/v2/" + KEY} done`)).toBe("ws wss://rpc.example/… done");
        expect(redactUrls(`HTTPS://RPC.EXAMPLE/v2/${KEY}`)).toBe("https://rpc.example/…");
    });

    it("keeps a bracketed IPv6 authority whole and drops its path", () => {
        expect(redactUrls(`node https://[::1]:8545/v2/${KEY} down`)).toBe("node https://[::1]:8545/… down");
    });

    it("leaves brackets and parentheses around a URL to the prose", () => {
        expect(redactUrls(`(see ${RPC}) [${RPC}] "${RPC}"`)).toBe(
            "(see https://bsc-mainnet.<…>.alchemy.com/…) [https://bsc-mainnet.<…>.alchemy.com/…] \"https://bsc-mainnet.<…>.alchemy.com/…\""
        );
    });
});

describe("clientSafeErrorMessage: what is kept (codex on #399)", () => {
    const abi = [{ type: "error", name: "OracleRateUnavailable", inputs: [] }] as const;

    it("keeps the decoded custom-error name of a revert", () => {
        const revert = new ContractFunctionRevertedError({ abi, functionName: "observe", data: "0x9a7b4f2a" as `0x${string}` });
        // viem decodes the name from the selector only when it is in the abi; use the real encoder.
        const { encodeErrorResult } = jest.requireActual<typeof import("viem")>("viem");
        const data = encodeErrorResult({ abi, errorName: "OracleRateUnavailable" });
        const decoded = new ContractFunctionRevertedError({ abi, functionName: "observe", data });
        const wrapped = new ContractFunctionExecutionError(decoded, {
            abi,
            functionName: "observe",
            contractAddress: "0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869",
        });
        expect(clientSafeErrorMessage(wrapped)).toContain("(OracleRateUnavailable)");
        expect(clientSafeErrorMessage(revert)).not.toContain(KEY);
    });

    it("keeps an allowlisted node detail and drops the rest", () => {
        const rpc = new RpcRequestError({
            body: { method: "eth_estimateGas" },
            url: RPC,
            error: { code: -32000, message: "out of gas" },
        });
        const safe = clientSafeErrorMessage(rpc);
        expect(safe).toContain("out of gas");
        expect(safe).not.toContain(KEY);
        const other = new RpcRequestError({ body: { method: "eth_call" }, url: RPC, error: { code: -32000, message: `see ${RPC}/internal` } });
        expect(clientSafeErrorMessage(other)).not.toContain(KEY);
        expect(clientSafeErrorMessage(other)).not.toContain("internal");
    });

    it("keeps only the first line of a multi-line plain error (cubic P2)", () => {
        expect(clientSafeErrorMessage(new Error(`Quote failed\ninternal: ${RPC}\nstack…`))).toBe("Quote failed");
    });
});

describe("round 3 (codex on #399, second report)", () => {
    const { encodeErrorResult } = jest.requireActual<typeof import("viem")>("viem");

    it("never forwards an upstream detail line, only its fixed label", () => {
        const rpc = new RpcRequestError({
            body: { method: "eth_call" },
            url: RPC,
            error: { code: -32005, message: `rate limit exceeded for API key ${KEY}` },
        });
        expect(clientSafeErrorMessage(rpc)).toBe("RPC request failed: rate limited.");
        expect(clientSafeErrorMessage(rpc)).not.toContain(KEY);
        expect(redactText(`HTTP request failed.\nDetails: rate limit exceeded for API key ${KEY}`)).toBe("HTTP request failed. (rate limited)");
        expect(classifyDetail(`your key ${KEY} is out of gas`)).toBe("out of gas");
        expect(classifyDetail("something else")).toBeUndefined();
    });

    it("keeps a decoded revert reason as a label and the message on one line", () => {
        const abi = [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }] as const;
        const data = encodeErrorResult({ abi, errorName: "Error", args: ["out of gas"] });
        const reverted = new ContractFunctionRevertedError({ abi, functionName: "get_aggregated_rate", data });
        const wrapped = new ContractFunctionExecutionError(reverted, {
            abi,
            functionName: "get_aggregated_rate",
            contractAddress: "0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869",
        });
        expect(wrapped.shortMessage).toContain("\n");
        const safe = clientSafeErrorMessage(wrapped);
        expect(safe).not.toContain("\n");
        expect(safe).toContain("out of gas");
        expect(safe).toMatch(/^The contract function "get_aggregated_rate" reverted/);
    });

    it("tokenizes URLs with internal delimiters, escaped slashes and apostrophes", () => {
        expect(redactUrls(`https://rpc.example/rpc(chain)/${KEY}`)).toBe("https://rpc.example/…");
        expect(redactUrls(`https://rpc.example/?chain[id]=56&apiKey=${KEY}`)).toBe("https://rpc.example/…");
        expect(redactUrls(`{"url":"https:\\/\\/rpc.example\\/v2\\/${KEY}"}`)).toBe('{"url":"https://rpc.example/…"}');
        expect(redactUrls(`'https://rpc.example/v2/it's-${KEY}'`)).toBe("'https://rpc.example/…'");
        expect(redactUrls(`(see https://rpc.example/v2/${KEY}).`)).toBe("(see https://rpc.example/…).");
    });

    it("fails closed on a candidate that does not parse", () => {
        const zoned = `https://[fe80::1%25eth0]:8545/v2/${KEY}`;
        const out = redactUrls(`node ${zoned} down`);
        expect(out).not.toContain(KEY);
        expect(out).toBe("node <url> down");
    });
});

describe("round 4 (codex on #399, third report): viem text is not trusted", () => {
    afterAll(() => registerKnownSecrets([]));

    it("never forwards a node reason that viem put on the first line (code -32000 path)", () => {
        const rpc = new RpcRequestError({
            body: { method: "eth_call" },
            url: RPC,
            error: { code: -32000, message: `execution reverted: rate limit exceeded for API key ${KEY}` },
        });
        const exec = new ExecutionRevertedError({ cause: rpc, message: `execution reverted: rate limit exceeded for API key ${KEY}` });
        expect(exec.shortMessage).toContain(KEY); // the real producer puts it on line one
        const wrapped = new ContractFunctionExecutionError(exec, {
            abi: [{ type: "function", name: "get_aggregated_rate", stateMutability: "view", inputs: [], outputs: [] }],
            functionName: "get_aggregated_rate",
            contractAddress: "0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869",
        });
        for (const err of [exec, wrapped]) {
            const safe = clientSafeErrorMessage(err);
            expect(safe).not.toContain(KEY);
            expect(safe).not.toContain("API key");
            expect(safe).toContain("rate limited");
        }
        expect(clientSafeErrorMessage(wrapped)).toMatch(/^The contract function "get_aggregated_rate" reverted/);
    });

    it("reads a 429 from the transport status and does not invent one from digits", () => {
        const http = new HttpRequestError({ url: RPC, status: 429, body: { method: "eth_call" }, details: "quota exhausted" });
        expect(clientSafeErrorMessage(http)).toBe("HTTP request failed (RPC bsc-mainnet.<…>.alchemy.com) (HTTP 429): rate limited.");
        const gas = new RpcRequestError({ body: { method: "eth_estimateGas" }, url: RPC, error: { code: -32000, message: "gas required exceeds allowance (1429000)" } });
        expect(clientSafeErrorMessage(gas)).toBe("RPC request failed: gas too low.");
        expect(classifyDetail("nonce too high")).toBe("nonce too high");
        expect(classifyDetail("transaction already known")).toBe("transaction already known");
    });

    it("scrubs the configured endpoint's secrets wherever they appear", () => {
        registerKnownSecrets([RPC, `https://user:${KEY}pw@node.example/`]);
        expect(secretTokensFromUrl(RPC)).toEqual([KEY]);
        expect(redactText(`bad key ${KEY} here`)).toBe("bad key <redacted> here");
        expect(redactText(`https://rpc.example/"/${KEY}`)).not.toContain(KEY);
        // userinfo of 4+ characters is a credential too: both parts go
        expect(redactText(`user ${KEY}pw failed`)).toBe("<redacted> <redacted> failed");
        expect(clientSafeErrorMessage(new Error(`RPC ${RPC} said no`))).toBe("RPC https://bsc-mainnet.<…>.alchemy.com/… said no");
    });

    it("handles double-escaped slashes", () => {
        expect(redactUrls(`{"url":"https:\\\\/\\\\/rpc.example\\\\/v2\\\\/${KEY}"}`)).not.toContain(KEY);
    });
});

describe("round 5 (codex on #399, fourth report): hosts, encodings, wrapped causes", () => {
    afterAll(() => registerKnownSecrets([]));

    it("shows only the public part of a host", () => {
        expect(publicHostLabel("bnb-mainnet.g.alchemy.com")).toBe("bnb-mainnet.<…>.alchemy.com");
        expect(publicHostLabel("synthetic-secret-key-399.rpc.example")).toBe("<…>.rpc.example");
        expect(publicHostLabel("abc-123.bsc.quiknode.pro")).toBe("<…>.quiknode.pro");
        expect(publicHostLabel("rpc.example")).toBe("rpc.example");
        expect(publicHostLabel("[::1]:8545")).toBe("[::1]:8545");
        expect(publicHostLabel("127.0.0.1:8545")).toBe("127.0.0.1:8545");
        const http = new HttpRequestError({ url: `https://${KEY}.rpc.example/`, status: 403, body: { method: "eth_call" }, details: "forbidden" });
        expect(clientSafeErrorMessage(http)).toBe("HTTP request failed (RPC <…>.rpc.example) (HTTP 403).");
    });

    it("scrubs encoded, decoded and short configured credentials", () => {
        registerKnownSecrets(["https://rpc.example/v2/SYNTHETIC%2BSECRET%2FKEY_399", "https://rpc.example/v2/key399test", `https://rpc.example/v2/prefix"${KEY}`]);
        expect(redactText("failed for API key SYNTHETIC+SECRET/KEY_399.")).toBe("failed for API key <redacted>.");
        expect(redactText("failed for API key SYNTHETIC%2BSECRET%2FKEY_399.")).toBe("failed for API key <redacted>.");
        expect(redactText("failed for API key key399test.")).toBe("failed for API key <redacted>.");
        expect(redactText(`at https://rpc.example/v2/prefix"${KEY} now`)).not.toContain(KEY);
        expect(redactText("fetch https://rpc.example/v2/key399test failed")).toBe("fetch https://rpc.example/… failed");
    });

    it("keeps its own context but formats a wrapped viem cause from structure", () => {
        const rpc = new RpcRequestError({ body: { method: "eth_call" }, url: RPC, error: { code: -32000, message: `execution reverted: UPSTREAM_PRIVATE_TEXT for API key ${KEY}` } });
        const exec = new ExecutionRevertedError({ cause: rpc, message: `execution reverted: UPSTREAM_PRIVATE_TEXT for API key ${KEY}` });
        const wrapped = new Error(`Historic rate read at block 1048526 failed for USDT on chainId=1: ${exec.message}. The RPC must serve state 1000 blocks back.`, { cause: exec });
        const safe = clientSafeErrorMessage(wrapped);
        expect(safe).not.toContain(KEY);
        expect(safe).not.toContain("UPSTREAM_PRIVATE_TEXT");
        expect(safe).toMatch(/^Historic rate read at block 1048526 failed for USDT on chainId=1: Execution reverted/);
    });

    it("classifies a receipt timeout from its class", () => {
        const err = new WaitForTransactionReceiptTimeoutError({ hash: "0x1234" });
        expect(clientSafeErrorMessage(err)).toBe("Waiting for the transaction receipt timed out.");
    });
});
