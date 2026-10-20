FROM node:22-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/relayer/alert-dispatcher/package.json packages/relayer/alert-dispatcher/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @privacy-pools-v2/alert-dispatcher... --ignore-scripts

COPY packages/relayer/alert-dispatcher/ packages/relayer/alert-dispatcher/
RUN pnpm --filter @privacy-pools-v2/alert-dispatcher build

FROM node:22-slim
WORKDIR /app/packages/relayer/alert-dispatcher
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/relayer/alert-dispatcher/node_modules ./node_modules
COPY --from=build /app/packages/relayer/alert-dispatcher/dist ./dist

# No signer key and no config file: everything is env vars (TELEGRAM_BOT_TOKEN from Secret Manager,
# TELEGRAM_CHAT_ID and the optional cooldown settings as plain env vars). See README.md.
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/main.js"]
