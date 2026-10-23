FROM node:22.23.4-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/relayer/dust-rescue-service/package.json packages/relayer/dust-rescue-service/
COPY packages/relayer/dust-rescue-prover/package.json packages/relayer/dust-rescue-prover/
COPY packages/core-sdk/package.json packages/core-sdk/
COPY packages/evm-sdk/package.json packages/evm-sdk/
COPY packages/circuits/package.json packages/circuits/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @privacy-pools-v2/dust-rescue-service... --ignore-scripts

COPY packages/core-sdk/ packages/core-sdk/
RUN pnpm --filter @privacy-pools-v2/core-sdk build

COPY packages/evm-sdk/ packages/evm-sdk/
RUN pnpm --filter @privacy-pools-v2/evm-sdk build

COPY packages/relayer/dust-rescue-prover/ packages/relayer/dust-rescue-prover/
RUN pnpm --filter @privacy-pools-v2/dust-rescue-prover build

COPY packages/relayer/dust-rescue-service/ packages/relayer/dust-rescue-service/
RUN pnpm --filter @privacy-pools-v2/dust-rescue-service build

FROM node:22.23.4-slim
WORKDIR /app/packages/relayer/dust-rescue-service
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/core-sdk/package.json /app/packages/core-sdk/package.json
COPY --from=build /app/packages/core-sdk/dist /app/packages/core-sdk/dist
COPY --from=build /app/packages/evm-sdk/package.json /app/packages/evm-sdk/package.json
COPY --from=build /app/packages/evm-sdk/dist /app/packages/evm-sdk/dist
# This service consumes core-sdk/evm-sdk UNBUNDLED (no webpack inlining), so their own runtime
# deps must resolve from their own directories too — same reasoning as the relayer's Dockerfile.staging.
COPY --from=build /app/packages/core-sdk/node_modules /app/packages/core-sdk/node_modules
COPY --from=build /app/packages/evm-sdk/node_modules /app/packages/evm-sdk/node_modules
COPY --from=build /app/packages/relayer/dust-rescue-prover/package.json /app/packages/relayer/dust-rescue-prover/package.json
COPY --from=build /app/packages/relayer/dust-rescue-prover/dist /app/packages/relayer/dust-rescue-prover/dist
# The prover's require('@privacy-pools-v2/evm-sdk') resolves from its own directory, so its
# pnpm-symlinked node_modules must exist at runtime too.
COPY --from=build /app/packages/relayer/dust-rescue-prover/node_modules /app/packages/relayer/dust-rescue-prover/node_modules
COPY --from=build /app/packages/relayer/dust-rescue-service/node_modules ./node_modules
COPY --from=build /app/packages/relayer/dust-rescue-service/dist ./dist
COPY --from=build /app/packages/relayer/dust-rescue-service/dust-rescue-service.config.example.json ./dust-rescue-service.config.json

# Circuit artifacts baked into the image (dust_collection_service_detailed_design.org
# §8) — circuitArtifactsDir is a filesystem path dust-rescue-prover reads directly, so
# this avoids a network fetch on every cold start. Path here must match
# `circuitArtifactsDir` in the deployed config. packages/circuits/build/deposit is the
# existing built-artifacts location (deposit.r1cs, deposit_js/, proving/verification
# keys) — not copied from `build` above since that stage never builds circuits; this
# assumes CI has already produced them (same assumption dust-rescue-prover's own
# integration tests already make).
COPY packages/circuits/build/deposit /app/circuit-artifacts

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/packages/relayer/dust-rescue-service/dust-rescue-service.config.json
EXPOSE 8080
CMD ["node", "dist/main.js"]
