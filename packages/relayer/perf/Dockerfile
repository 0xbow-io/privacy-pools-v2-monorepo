FROM node:22-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/relayer/perf/package.json packages/relayer/perf/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter perf... --ignore-scripts

COPY packages/relayer/perf/ packages/relayer/perf/

WORKDIR /app/packages/relayer/perf
CMD ["pnpm", "vitest", "run"]
