# Source: gameye-skills v1.6.1, skills/gameye-web-server/SKILL.md, Container specifics (MIT License, Copyright (c) 2026 Gameye B.V.).
# Copied verbatim below this header as a golden clean case.
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./server/
USER node
EXPOSE 8080/tcp
ENTRYPOINT ["node", "server/server.js"]
