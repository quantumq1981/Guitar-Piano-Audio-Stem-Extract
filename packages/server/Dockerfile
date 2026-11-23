# Tier 1 container: onnxruntime-node + FFmpeg (with libsoxr), one ORT session per container.
# Build from the repo root:  docker build -f packages/server/Dockerfile -t stemsplit-server .
# (Docker Hub rate limits? --build-arg BASE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim)
# Memory: provision ≥ 4 GiB (measured peak RSS 2.4 GiB per session), 6 GiB recommended.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --workspace @stemsplit/server --include-workspace-root=false

COPY packages/core/src packages/core/src
COPY packages/server/src packages/server/src

# Bake the sha256-pinned model into the image: no cold-start download, no drift.
ENV STEMSPLIT_MODELS_DIR=/app/models
RUN node packages/server/src/cli.ts models fetch

ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
CMD ["node", "packages/server/src/cli.ts", "serve", "--data", "/tmp/stemsplit-jobs", "--threads", "4"]
