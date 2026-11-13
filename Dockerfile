FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /app
RUN npm install --global pnpm@11.25.0 --ignore-scripts
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY tests ./tests
RUN pnpm build && pnpm prune --prod --ignore-scripts && node --test dist/tests/extraction.test.js

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:767ffb7e2ffa9f4280f1af7b99f7f0a1cafb79d0dcc0e0d3aba43843748008a5
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/package.json ./package.json
COPY --from=build --chown=65532:65532 /app/dist/src ./dist/src
COPY --from=build --chown=65532:65532 /app/dist/web ./dist/web
COPY --chown=65532:65532 migrations ./migrations
COPY --chown=65532:65532 web/index.html web/liff.css ./web/
USER 65532:65532
EXPOSE 3000
ENTRYPOINT []
CMD ["node","dist/src/index.js"]
