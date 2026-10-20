import {
    BaseError,
    ContractFunctionExecutionError,
    ContractFunctionRevertedError,
    ExecutionRevertedError,
    HttpRequestError,
    RpcRequestError,
    TimeoutError,
    WaitForTransactionReceiptTimeoutError,
} from "viem";

/// http(s) and ws(s), case-insensitive. JSON-escaped slashes (one or two
/// backslashes) are normalised first, so `https:\/\/…` is one candidate. The
/// candidate runs to whitespace, a double quote or an angle bracket; internal
/// `(`, `)`, `[`, `]`, `'` are legal URL characters and stay in. Trailing
/// PROSE delimiters are split off afterwards. A candidate that does not parse
/// is replaced whole (fail closed), never left in place.
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"<>]+/gi;
const ESCAPED_SLASH_RE = /\\{1,2}\//g;
const TRAILING_PROSE_RE = /[.,;:!?)\]}'`]+$/;

/// Upstream failure phrases the client is allowed to LEARN ABOUT, as fixed
/// public labels. The upstream text itself is never forwarded: a provider can
/// echo its own key ("rate limit exceeded for API key …"), a node its request
/// (codex on #399). The website classifies relayer failures by these words.
/// Specific phrases first; "execution reverted" is the catch-all of a revert.
const CLASSIFICATIONS: readonly (readonly [RegExp, string])[] = [
    [/out of gas/i, "out of gas"],
    [/insufficient funds/i, "insufficient funds"],
    [/intrinsic gas too low|gas required exceeds allowance|gas too low/i, "gas too low"],
    [/nonce too low/i, "nonce too low"],
    [/nonce too high/i, "nonce too high"],
    [/already known|already imported/i, "transaction already known"],
    [/underpriced/i, "transaction underpriced"],
    [/rate limit|too many requests|quota/i, "rate limited"],
    [/timeout|timed out/i, "timed out"],
    [/execution reverted/i, "execution reverted"],
];

/// The fixed public label for an upstream detail, or undefined when none applies.
export function classifyDetail(detail: string | undefined | null): string | undefined {
    if (!detail) return undefined;
    return CLASSIFICATIONS.find(([re]) => re.test(detail))?.[1];
}

// ---------------------------------------------------------------------------
// Hosts. A configured hostname is not necessarily public (QuickNode-style
// per-customer subdomains, or a key someone put in a label), so only the
// provider's registrable part is shown, plus a leading network label when it
// is a well-known network slug: "bnb-mainnet.<…>.alchemy.com". IP literals
// pass through.
// ---------------------------------------------------------------------------
const NETWORK_LABEL_RE = /^(?:[a-z0-9]+-)?(?:mainnet|testnet|sepolia|holesky|amoy|goerli|rpc|api|node|www)$/i;
const IP_HOST_RE = /^(?:\[[^\]]*\]|\d{1,3}(?:\.\d{1,3}){3}|localhost)(?::\d+)?$/i;

export function publicHostLabel(host: string): string {
    if (IP_HOST_RE.test(host)) return host;
    const [hostname, port] = host.split(":");
    const labels = hostname.split(".");
    if (labels.length <= 2) return host;
    const tail = labels.slice(-2).join(".");
    const head = NETWORK_LABEL_RE.test(labels[0]) ? `${labels[0]}.` : "";
    const hidden = labels.length - 2 - (head ? 1 : 0) > 0 ? "<…>." : "";
    return `${head}${hidden}${tail}${port ? `:${port}` : ""}`;
}

function publicUrlLabel(parsed: URL): string {
    return `${parsed.protocol.toLowerCase()}//${publicHostLabel(parsed.host)}/…`;
}

// ---------------------------------------------------------------------------
// Known secrets: the configured RPC endpoints. Whatever shape an upstream
// message takes (a key echoed bare, percent-encoded or decoded, a URL with a
// quote in its path, escaped slashes), the configured URL in each of its
// spellings is replaced by its public label, and its path segments, query
// values and userinfo are scrubbed from every outgoing string.
// ---------------------------------------------------------------------------
const STOP_TOKENS = new Set(["v1", "v2", "v3", "rpc", "api", "eth", "evm", "json", "http", "https", "mainnet", "testnet", "public"]);
let knownUrls: readonly { text: string; label: string }[] = [];
let knownTokens: readonly string[] = [];

function decoded(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

/// Every spelling a string may take on the wire: as is, percent-decoded,
/// JSON-escaped ("\/") and double-escaped.
function spellings(text: string): string[] {
    const base = [text, decoded(text)];
    return [...new Set(base.flatMap((t) => [t, t.replace(/\//g, "\\/"), t.replace(/\//g, "\\\\/")]))];
}

/// The strings inside an RPC URL that must never leave the server: path
/// segments and query values that are not ordinary words, userinfo; each in
/// its raw and decoded form.
export function secretTokensFromUrl(url: string): string[] {
    const tokens: string[] = [];
    const add = (raw: string, min: number) => {
        for (const t of [raw, decoded(raw)]) if (t.length >= min && !STOP_TOKENS.has(t.toLowerCase())) tokens.push(t);
    };
    try {
        const parsed = new URL(url);
        for (const segment of parsed.pathname.split("/")) add(segment, 6);
        for (const [, value] of parsed.searchParams) add(value, 6);
        for (const part of [parsed.username, parsed.password]) add(part, 4);
    } catch {
        if (url.length >= 12) tokens.push(url);
    }
    return [...new Set(tokens)];
}

/// Register the configured endpoints (called once at boot by the response
/// filter with the relayer config; tests register directly, [] to clear).
export function registerKnownSecrets(urls: readonly string[]): void {
    const urlEntries = new Map<string, string>();
    const tokens = new Set<string>();
    for (const url of urls) {
        let label = "<url>";
        try {
            label = publicUrlLabel(new URL(url));
        } catch {
            // unparsable: every spelling is still replaced, by the fallback label
        }
        for (const spelling of spellings(url)) urlEntries.set(spelling, label);
        for (const token of secretTokensFromUrl(url)) for (const spelling of spellings(token)) tokens.add(spelling);
    }
    // Longest first, so a full URL is replaced before its own key would be.
    knownUrls = [...urlEntries.entries()].map(([text, label]) => ({ text, label })).sort((a, b) => b.text.length - a.text.length);
    knownTokens = [...tokens].sort((a, b) => b.length - a.length);
}

export function scrubKnownSecrets(text: string): string {
    let out = text;
    for (const { text: url, label } of knownUrls) if (out.includes(url)) out = out.split(url).join(label);
    for (const token of knownTokens) if (out.includes(token)) out = out.split(token).join("<redacted>");
    return out;
}

/// `https://host/path?apikey=…` -> `https://<public host label>/…`: the path
/// and query are where provider keys live; the host is reduced to what is
/// known to be public (publicHostLabel).
export function redactUrls(text: string): string {
    return text.replace(ESCAPED_SLASH_RE, "/").replace(URL_RE, (match) => {
        const tail = TRAILING_PROSE_RE.exec(match)?.[0] ?? "";
        const candidate = match.slice(0, match.length - tail.length);
        try {
            const parsed = new URL(candidate);
            if (!parsed.host) throw new Error("no host");
            return `${publicUrlLabel(parsed)}${tail}`;
        } catch {
            return `<url>${tail}`;
        }
    });
}

interface Walked {
    call?: ContractFunctionExecutionError;
    revert?: ContractFunctionRevertedError;
    exec?: ExecutionRevertedError;
    http?: HttpRequestError;
    rpc?: RpcRequestError;
    receiptTimeout?: WaitForTransactionReceiptTimeoutError;
    timeout?: TimeoutError;
}

function walkViem(error: BaseError): Walked {
    const pick = <T>(ctor: new (...args: never[]) => T): T | undefined => {
        const found = error.walk((e) => e instanceof ctor);
        return found instanceof ctor ? found : undefined;
    };
    return {
        call: pick(ContractFunctionExecutionError),
        revert: pick(ContractFunctionRevertedError),
        exec: pick(ExecutionRevertedError),
        http: pick(HttpRequestError),
        rpc: pick(RpcRequestError),
        receiptTimeout: pick(WaitForTransactionReceiptTimeoutError),
        timeout: pick(TimeoutError),
    };
}

function hostLabelOf(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
        return publicHostLabel(new URL(url).host);
    } catch {
        return undefined;
    }
}

function firstLine(text: string): string {
    return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/// A one-line, key-free description of an error for an HTTP response body.
///
/// viem errors are NOT trusted text: ExecutionRevertedError puts the node's
/// reason on its first line, and a node (or a provider) can echo anything
/// there, an API key included (codex on #399). The public message is built
/// from fixed templates plus trusted structure only: the function name and
/// custom-error name decoded from OUR abi, the public host label, the HTTP
/// status, and a fixed classification of the upstream detail or revert reason:
///     "HTTP request failed (RPC bnb-mainnet.<…>.alchemy.com) (HTTP 429): rate limited."
///     "The contract function \"observe\" reverted (OracleRateUnavailable)."
///     "RPC request failed: out of gas."
/// A plain Error that WRAPS a viem error (`cause`) keeps its own first line up
/// to where the wrapped text begins, then the wrapped error's fixed form.
/// Anything else: the first line of the message, known secrets scrubbed and
/// URLs reduced to their public label.
export function clientSafeErrorMessage(error: unknown): string {
    if (error instanceof BaseError) return scrubKnownSecrets(viemTemplate(error));
    if (error instanceof Error) {
        const cause = (error as { cause?: unknown }).cause;
        if (cause instanceof BaseError) {
            const own = firstLine(error.message);
            const markers = [firstLine(cause.message), firstLine(cause.shortMessage), cause.details].filter((m) => m.length > 0);
            const cut = markers.map((m) => own.indexOf(m)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
            const head = (cut !== undefined ? own.slice(0, cut) : own).replace(/[\s:.,-]+$/, "");
            const wrapped = scrubKnownSecrets(viemTemplate(cause));
            return head ? `${redactText(head)}: ${wrapped}` : wrapped;
        }
        return redactText(error.message);
    }
    return redactText(String(error));
}

function viemTemplate(error: BaseError): string {
    const { call, revert, exec, http, rpc, receiptTimeout, timeout } = walkViem(error);
    const reverted = revert !== undefined || exec !== undefined;
    let out: string;
    if (receiptTimeout) {
        out = "Waiting for the transaction receipt timed out";
    } else if (call?.functionName) {
        out = reverted ? `The contract function "${call.functionName}" reverted` : `The contract call "${call.functionName}" failed`;
    } else if (reverted) {
        out = "Execution reverted";
    } else if (http) {
        out = "HTTP request failed";
    } else if (timeout) {
        out = "RPC request timed out";
    } else if (rpc) {
        out = "RPC request failed";
    } else {
        out = "Request failed";
    }
    const errorName = revert?.data?.errorName;
    if (errorName) out += ` (${errorName})`;
    const host = hostLabelOf(http?.url);
    if (host) out += ` (RPC ${host})`;
    if (http?.status) out += ` (HTTP ${http.status})`;
    const label =
        (http?.status === 429 ? "rate limited" : undefined) ??
        (receiptTimeout || timeout ? "timed out" : undefined) ??
        classifyDetail(revert?.reason) ??
        classifyDetail(exec?.details) ??
        classifyDetail(rpc?.details) ??
        classifyDetail(error.details);
    if (label && !out.toLowerCase().includes(label)) out += `: ${label}`;
    return `${out}.`;
}

/// Redact free text that may embed a viem message: keep the first non-empty
/// line only (anything after it is a section the client is not meant to see,
/// labelled or not), replace the configured endpoints in every spelling, reduce
/// other URLs to their public label, scrub the configured secrets wherever
/// they hide, and append the fixed classification of a "Details:" line when
/// one applies.
const MARK = String.fromCharCode(1); // a control character: never part of an error message
const PLACEHOLDER_RE = new RegExp(`${MARK}(\\d+)${MARK}`, "g");
const MARK_RE = new RegExp(MARK, "g");

export function redactText(text: string): string {
    // Configured endpoints go first, BEFORE the lossy URL reduction (a quote
    // inside a configured path would otherwise split the candidate and leave
    // the secret suffix behind). They are parked as placeholders so the URL
    // pass cannot re-parse their labels, then put back.
    const labels: string[] = [];
    let out = firstLine(text).replace(MARK_RE, "");
    for (const { text: url, label } of knownUrls) {
        if (!out.includes(url)) continue;
        const index = labels.push(label) - 1;
        out = out.split(url).join(`${MARK}${index}${MARK}`);
    }
    out = redactUrls(out).replace(PLACEHOLDER_RE, (_m: string, i: string) => labels[Number(i)] ?? "<url>");
    for (const token of knownTokens) if (out.includes(token)) out = out.split(token).join("<redacted>");
    const label = classifyDetail(/\n\s*Details:\s*([^\n]+)/.exec(text)?.[1]);
    if (label && !out.toLowerCase().includes(label)) out += ` (${label})`;
    return out;
}
