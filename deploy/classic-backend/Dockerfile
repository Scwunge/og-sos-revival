# OG SOS Revival backend (server/server.js), for both the main and the Classic client.
# Build from the repo root:  docker compose -f deploy/classic-backend/compose.yaml build
# No game files or state are in the image: db.json + secret.key live on /state, logs on /logs.
FROM node:22.11.0-alpine3.20

WORKDIR /app
COPY server/ server/
COPY data/kv/ data/kv/
COPY data/kv-classic/ data/kv-classic/
COPY data/cosmetics.json data/cosmetics.json

RUN mkdir -p /state /logs && chown node:node /state /logs
ENV NODE_ENV=production OGSOS_STATE_DIR=/state OGSOS_LOG_DIR=/logs
VOLUME ["/state", "/logs"]

USER node
EXPOSE 7781
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:7781/kv/live-rev.txt || exit 1
CMD ["node", "server/server.js", "--port", "7781"]
