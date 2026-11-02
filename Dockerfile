# Serveur Agent Hotel (+ bots) pour Fly.io ou tout hôte Docker.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.32.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/bots/package.json packages/bots/
RUN pnpm install --frozen-lockfile --filter @hotel/shared --filter @hotel/server --filter @hotel/bots
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/bots packages/bots
RUN pnpm --filter @hotel/shared --filter @hotel/server --filter @hotel/bots build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@10.32.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/bots/package.json packages/bots/
RUN pnpm install --frozen-lockfile --prod --filter @hotel/shared --filter @hotel/server --filter @hotel/bots
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/bots/dist packages/bots/dist
COPY scripts/start.sh scripts/start.sh
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=4000 HOST=0.0.0.0 HOTEL_DB=/data/hotel.db BOTS_STATE=/data/bots.json RUN_BOTS=1
EXPOSE 4000
CMD ["sh", "scripts/start.sh"]
