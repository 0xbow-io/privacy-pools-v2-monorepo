//! Keeps secrets out of logs. RPC URLs carry provider API keys in their path or query
//! (`https://eth-mainnet.g.alchemy.com/v2/<key>`), and HTTP clients put the full URL into their
//! errors (`error sending request for url (...)`), so every error that reaches a log goes through
//! [`error`]: each `http(s)://host/...` keeps its host and loses everything after it.

/// `{e:#}` (the whole context chain) with URLs redacted.
pub fn error(e: &anyhow::Error) -> String {
    text(&format!("{e:#}"))
}

/// Redacts every URL in `s` down to `scheme://host/<redacted>`.
pub fn text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = find_scheme(rest) {
        let (head, tail) = rest.split_at(i);
        out.push_str(head);
        let scheme_len = if tail.starts_with("https://") { 8 } else { 7 };
        let after = &tail[scheme_len..];
        let host_end = after.find(|c: char| c == '/' || c == '?' || c == '#' || is_url_end(c)).unwrap_or(after.len());
        // userinfo (`user:pass@host`) is a secret too.
        let host = &after[..host_end];
        let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
        out.push_str(&tail[..scheme_len]);
        out.push_str(host);
        let url_end = after.find(is_url_end).unwrap_or(after.len());
        if url_end > host_end {
            out.push_str("/<redacted>");
        }
        rest = &after[url_end..];
    }
    out.push_str(rest);
    out
}

fn find_scheme(s: &str) -> Option<usize> {
    match (s.find("http://"), s.find("https://")) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

fn is_url_end(c: char) -> bool {
    c.is_whitespace() || matches!(c, ')' | '"' | '\'' | ',' | '>' | ']' | '}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_paths_queries_and_userinfo() {
        let e = "RPC unreachable: error sending request for url (https://eth-mainnet.g.alchemy.com/v2/SECRETKEY): conn refused";
        assert_eq!(text(e), "RPC unreachable: error sending request for url (https://eth-mainnet.g.alchemy.com/<redacted>): conn refused");
        assert_eq!(text("http://127.0.0.1:1/v2/K and https://x.io?key=K"), "http://127.0.0.1:1/<redacted> and https://x.io/<redacted>");
        assert_eq!(text("https://user:pass@rpc.example.com/x"), "https://rpc.example.com/<redacted>");
        assert_eq!(text("{\"url\":\"https://a.b/c\"}"), "{\"url\":\"https://a.b/<redacted>\"}");
        // Host-only URLs and text without URLs are untouched.
        assert_eq!(text("see https://li.quest now"), "see https://li.quest now");
        assert_eq!(text("plain"), "plain");
    }

    #[test]
    fn error_chain_is_redacted() {
        let e = anyhow::anyhow!("for url (http://127.0.0.1:1/v2/SECRET)").context("RPC unreachable");
        let s = error(&e);
        assert!(!s.contains("SECRET") && s.contains("RPC unreachable"), "{s}");
    }
}
