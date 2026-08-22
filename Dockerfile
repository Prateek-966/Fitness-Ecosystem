# Serves the built static site from a container.
#
# NOTE: a Render *Static Site* is the better fit for this app — free, CDN
# backed, and it never spins down. A free-tier web service sleeps after
# ~15 minutes idle and cold-starts in ~50 s, which is a poor match for
# something whose whole thesis is "logged in under three seconds".
# This exists so a Docker web service (or any container host, or a NAS at
# home) can serve it correctly, with the same headers render.yaml sets.

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app

# NODE_ENV=production would skip devDependencies, and vite/typescript live
# there. Copy manifests first so this layer caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

# ---- serve ----
FROM nginx:1.27-alpine AS serve

# The nginx entrypoint runs envsubst over /etc/nginx/templates/*.template,
# substituting only names that exist in the environment — so ${PORT} is
# replaced while nginx's own $uri and $http_* are left alone.
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# Render injects PORT; this default keeps `docker run` working locally.
ENV PORT=10000
EXPOSE 10000
