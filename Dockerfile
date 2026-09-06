FROM node:22-alpine AS base
WORKDIR /app
# concurrently uses GNU ps to find and signal the complete child process tree.
RUN apk add --no-cache tini procps
ENTRYPOINT ["/sbin/tini", "--"]

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS development
COPY tsconfig.json tsconfig.build.json vitest.config.ts eslint.config.js ./
COPY src ./src
CMD ["./node_modules/.bin/concurrently", "--kill-others", "--kill-signal", "SIGTERM", "--kill-timeout", "25000", "--names", "bot,worker", "./node_modules/.bin/tsx watch src/app.ts", "./node_modules/.bin/tsx watch src/worker.ts"]

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM base AS production
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
CMD ["./node_modules/.bin/concurrently", "--kill-others", "--kill-signal", "SIGTERM", "--kill-timeout", "25000", "--names", "bot,worker", "node dist/app.js", "node dist/worker.js"]
