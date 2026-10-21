# LexBG MCP server (stdio). The weekly prebuilt database is downloaded on first start
# into the /data volume, so restarts are instant.
#
#   docker run -i --rm -v lexbg-data:/data ghcr.io/stank1/lexbg
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src src
COPY scripts scripts
RUN npx tsc -p tsconfig.json

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production LEXBG_HOME=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist/src dist/src
COPY sources sources
COPY skills skills
VOLUME /data
LABEL org.opencontainers.image.source="https://github.com/StanK1/lexbg-mcp" \
      org.opencontainers.image.description="LexBG — MCP server for Bulgarian legal & compliance research" \
      org.opencontainers.image.licenses="MIT"
ENTRYPOINT ["node", "dist/src/index.js"]
