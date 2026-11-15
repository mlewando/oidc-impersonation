# Playwright runner for the e2e stack. The image version must match @playwright/test.
FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /e2e
RUN npm install -g pnpm@10.18.3
COPY package.json pnpm-lock.yaml /app/
RUN cd /app && pnpm install --frozen-lockfile --ignore-scripts
ENV NODE_PATH=/app/node_modules
COPY e2e/ /e2e/
RUN ln -s /app/node_modules /e2e/node_modules
# Extra args (for example `pnpm e2e -g PKCE`) are passed on to `playwright test`.
ENTRYPOINT ["/app/node_modules/.bin/playwright", "test"]
