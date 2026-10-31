# Local (stdio) Transcript Dock MCP server. Needs TRANSCRIPTDOCK_API_KEY and
# TRANSCRIPTDOCK_BASE_URL (https://www.transcriptdock.com) at run time.
# Most clients can skip this and use the hosted server at
# https://www.transcriptdock.com/mcp instead.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]
