export function getQuoteEndpoint(version: string, chainType: string, chainId: string): string {
    return `/${version}/quote/${chainType}/${chainId}`;
}

export function getRelayEndpoint(version: string, chainType: string, chainId: string): string {
    return `/${version}/relay/${chainType}/${chainId}`;
}

export function getDetailsEndpoint(version: string, chain?: { type: string; id: string }): string {
    if (chain !== undefined) {
        return `/${version}/details/${chain.type}/${chain.id}`;
    } else {
        return `/${version}/details`;
    }
}

/**
 * fetch with retries for transient socket errors. Node's fetch (undici) keeps
 * idle sockets alive longer than the relayer's HTTP server does; after a long
 * gap (e.g. proof generation) the first reuse of a stale socket fails with
 * "other side closed" / "fetch failed". A fresh attempt opens a new socket.
 */
export async function fetchWithRetry(url: string, init?: RequestInit, attempts = 3): Promise<Response> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fetch(url, init);
        } catch (error) {
            lastError = error;
            await new Promise((r) => setTimeout(r, 250 * (i + 1)));
        }
    }
    throw lastError;
}
