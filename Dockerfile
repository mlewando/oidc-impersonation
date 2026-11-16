# Production dependencies are installed in a full Node image; the runtime is distroless (no shell,
# no package manager), runs as the `nonroot` user (65532) and needs no writable path, so it works
# with a read-only root filesystem.
FROM docker.io/library/node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS deps
WORKDIR /app
RUN npm install -g pnpm@10.18.3
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:6abfcb367ebc291572c774c1592a986be2ab26a2486f73093401327495a5962a
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# The entrypoint is node; `node` is not on PATH, hence the full path in the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["/nodejs/bin/node", "src/healthcheck.ts"]
CMD ["src/main.ts"]
