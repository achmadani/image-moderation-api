# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: dependencies
#
# Debian (glibc), never Alpine: @tensorflow/tfjs-node links against
# libtensorflow, which is published for glibc only — on musl the native binding
# fails to load at require() time, after the image has already built.
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

# tfjs-node and sharp both ship prebuilt linux-x64 binaries, so these are only
# the fallback toolchain for when node-pre-gyp has to compile from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copied on their own so this layer is only rebuilt when the dependencies change.
COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund

# -----------------------------------------------------------------------------
# Stage 2: verification
#
# A separate stage so `--target deps` can produce a shell for debugging without
# having to satisfy the check first. `runtime` copies node_modules from here
# rather than from `deps`, which is what forces this stage to actually run —
# BuildKit skips any stage nothing depends on.
# -----------------------------------------------------------------------------
FROM deps AS verify

# The check runs the very same resolver the workers use, so it cannot pass here
# and then fail at runtime.
COPY scripts/verify-runtime.js ./scripts/verify-runtime.js
COPY src/utils/tf.js ./src/utils/tf.js
RUN node scripts/verify-runtime.js

# -----------------------------------------------------------------------------
# Stage 3: runtime
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# curl is only here for HEALTHCHECK; it costs ~2MB and, unlike spawning node,
# barely moves memory while the container sits near its mem_limit.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    MODEL_PATH=/app/model \
    TF_CPP_MIN_LOG_LEVEL=2

WORKDIR /app

COPY --from=verify /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Rule #2: the model is baked in. Nothing is downloaded at runtime, so the
# container starts identically with no network and no CDN dependency.
COPY model ./model

# Rule #9: drop to the unprivileged user the base image already provides.
# Everything above stays root-owned, so the app cannot modify its own code.
USER node

EXPOSE 3000

# start-period covers model load and worker warm-up; until /ready answers 200
# the container is starting, not unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/ready" || exit 1

# No npm in front of node: npm would swallow SIGTERM and break the graceful
# shutdown in server.js.
CMD ["node", "src/server.js"]
