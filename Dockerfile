# Builds the PWA and serves it together with the Garmin sync API from one
# origin.
#
# One origin is the point. A separate API host would need CORS and a
# widened connect-src, and every widening of a CSP on a page holding
# months of health data is a door someone has to remember to keep shut.
# Same origin, same policy, nothing to widen.
#
# This is a WEB SERVICE, not a static site: auto-pull needs somewhere to
# hold an OAuth credential and receive a schedule, and a browser can hold
# neither.

# ---- build the app ----
FROM node:22-alpine AS build
WORKDIR /app

# NODE_ENV=production would skip devDependencies, and vite/typescript live
# there. Manifests first so this layer caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

# ---- serve ----
FROM node:22-alpine AS serve
WORKDIR /app

# The server has no dependencies at all: node:sqlite and node:http are
# built in, and Node 22 strips the TypeScript annotations itself. Nothing
# to install means nothing to audit.
COPY server/ ./server/
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production \
    STATIC_DIR=/app/dist \
    SYNC_DB=/app/data/sync.sqlite3 \
    PORT=10000

# Not root. The process holds a Garmin credential; it does not also need
# the run of the filesystem.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 10000
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "server/src/index.ts"]
