# Hugging Face Space (Docker SDK) for the stemsplit processing server.
# It clones the public GitHub repo at REF, installs only the server workspace,
# and bakes the sha256-pinned model into the image (no download at cold start).
# Free "CPU basic" hardware (2 vCPU, 16 GB RAM) fits one 2.4 GiB ORT session comfortably.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG REPO=https://github.com/quantumq1981/Guitar-Piano-Audio-Stem-Extract.git
ARG REF=main
RUN git clone --depth 1 --branch "${REF}" "${REPO}" /app
WORKDIR /app

RUN npm ci --omit=dev --no-audit --no-fund --workspace @stemsplit/server --include-workspace-root=false

ENV STEMSPLIT_MODELS_DIR=/app/models
RUN node packages/server/src/cli.ts models fetch

# Spaces run containers as uid 1000; job data lives in /tmp (ephemeral: lost on restart, fine for 7-day links).
RUN chown -R 1000:1000 /app
USER 1000
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["node", "packages/server/src/cli.ts", "serve", "--data", "/tmp/stemsplit-jobs", "--threads", "2", "--rtf", "1.2"]
