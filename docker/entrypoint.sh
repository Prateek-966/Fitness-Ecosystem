#!/bin/sh
# Substitute exactly one variable — ${PORT} — into the nginx config.
# Naming it explicitly means nginx's own $uri, $host and $http_* survive
# untouched no matter what the host injects into the environment.
set -eu
envsubst '${PORT}' \
  < /etc/nginx/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf
