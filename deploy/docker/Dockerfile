# Almagest service image — inbox, remote MCP, ingest runner in one process.
#
# The brain is NOT baked into the image. At start the entrypoint clones
# $ALMAGEST_GIT_URL into /data/repo (or reuses a mounted repo there), so one
# image serves any brain and the knowledge stays in git, not in a container
# layer. State (sqlite, worktrees, snapshots) lives under /data/repo/.almagest.
#
#   docker build -f deploy/docker/Dockerfile -t almagest .
#   docker run -p 4747:4747 -e ALMAGEST_GIT_URL=… -e ALMAGEST_TOKENS=… -e ALMAGEST_LOGINS=… -v almagest:/data almagest
FROM node:22-bookworm-slim

# git: the store. poppler-utils: pdftotext for binary-source sidecars.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates poppler-utils tini \
 && rm -rf /var/lib/apt/lists/*

# The headless ingest agent. Swap for another harness CLI and set ingest.driver.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /opt/almagest
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --omit=dev
COPY tools tools
COPY server server
COPY deploy/docker/entrypoint.sh /usr/local/bin/almagest-entrypoint

RUN useradd --create-home --uid 10001 almagest && mkdir -p /data && chown almagest /data
USER almagest
ENV NODE_ENV=production ALMAGEST_REPO=/data/repo
EXPOSE 4747
VOLUME ["/data"]
ENTRYPOINT ["tini", "--", "almagest-entrypoint"]
CMD ["serve"]
