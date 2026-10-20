FROM node:22-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/relayer/e2e/package.json packages/relayer/e2e/
COPY packages/core-sdk/package.json packages/core-sdk/
COPY packages/evm-sdk/package.json packages/evm-sdk/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter e2e... --ignore-scripts

COPY packages/core-sdk/ packages/core-sdk/
RUN pnpm --filter @privacy-pools-v2/core-sdk build

COPY packages/evm-sdk/ packages/evm-sdk/
RUN pnpm --filter @privacy-pools-v2/evm-sdk build

COPY packages/relayer/e2e/ packages/relayer/e2e/

WORKDIR /app/packages/relayer/e2e
CMD ["sh", "-c", "pnpm vitest run ${VITEST_FILE:+$VITEST_FILE} ${VITEST_TEST:+-t \"$VITEST_TEST\"}"]
