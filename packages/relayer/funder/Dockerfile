# syntax=docker/dockerfile:1.7
#
# funder: one-shot job image (Cloud Run Job / any cron runner). Runs once, sweeps every selected
# chain, exits 0/1. Build for Cloud Run with:
#
#   docker build --platform linux/amd64 -t funder .
#
# Runtime contract (nothing is baked in; see README):
#   CONFIG_PATH        the relayer config JSON, mounted from a secret
#   PRIVATE_KEY        fee-wallet key, from a secret
#   RPC_URL_EVM_<id>   per-chain RPC (provider keys: also a secret)
#   RECIPIENT, CHAINS, DRY_RUN=false, ...

# --- build -------------------------------------------------------------------------------------
# Pinned toolchain: alloy 1.x needs >= 1.88; alloy 2.x would need >= 1.94.1.
FROM rust:1.90-bookworm AS build
WORKDIR /src

# Only what the build needs (see .dockerignore). `tests/` is included because Cargo.toml declares
# the fork test target and cargo validates target paths even for `cargo build`.
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY src src
COPY tests tests

# Registry + target dir as BuildKit caches: dependency builds survive source-only changes.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked \
 && cp target/release/funder /funder

# --- test (opt-in: `docker build --target test .`) ------------------------------------------------
# Unit tests + lints on the exact toolchain the image ships with. Fork tests need RPCs and anvil;
# run them on the host against the built image instead (FUNDER_IMAGE=..., see README).
FROM build AS test
RUN rustup component add clippy
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target-test \
    CARGO_TARGET_DIR=/src/target-test cargo test --locked \
 && CARGO_TARGET_DIR=/src/target-test cargo clippy --all-targets --locked -- -D warnings \
 && CARGO_TARGET_DIR=/src/target-test cargo clippy --all-targets --no-default-features --locked -- -D warnings

# --- runtime -----------------------------------------------------------------------------------
# glibc + libgcc only (TLS is rustls with bundled roots): distroless/cc, matching bookworm's glibc.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /funder /usr/local/bin/funder
USER nonroot
# Cloud Logging reads severity from JSON lines; override with LOG_FORMAT=text locally.
ENV LOG_FORMAT=json
ENTRYPOINT ["/usr/local/bin/funder"]
