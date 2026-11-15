# Minimal image for the walking skeleton. Issue 06 replaces it with a distroless, read-only build.
FROM node:24-alpine
WORKDIR /app
RUN npm install -g pnpm@10.18.3
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY src ./src
USER node
CMD ["node", "src/main.ts"]
