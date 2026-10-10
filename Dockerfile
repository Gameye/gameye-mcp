# gameye-mcp as a container: an MCP server on stdio, for MCP clients that run
#   docker run -i --rm -e GAMEYE_API_TOKEN ghcr.io/gameye/gameye-mcp
# Never pass -t: a TTY corrupts the JSON-RPC stream on stdout.

ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# Compile once on the build machine's own platform; the output is plain
# JavaScript, so it is the same for every target platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/Gameye/gameye-mcp" \
      org.opencontainers.image.description="MCP server for the Gameye game server orchestration API (stdio)" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.Gameye/gameye-mcp"
# tini forwards SIGTERM to node and reaps it, so `docker stop` ends the server promptly.
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# src/version.ts reads package.json at runtime, so it ships beside dist/.
COPY --from=build /src/dist ./dist
USER node
ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
