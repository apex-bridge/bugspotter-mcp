# Multi-stage build for bugspotter-mcp HTTP server.
# Image runs `bugspotter-mcp-http` on port 8080 by default.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV LOG_DIR=/var/log/bugspotter-mcp

# Production deps only — no devDeps in the runtime image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && mkdir -p /var/log/bugspotter-mcp \
 && chown -R node:node /app /var/log/bugspotter-mcp

COPY --from=build /app/dist ./dist

USER node

EXPOSE 8080

# Health check uses the public /health endpoint (no auth).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server-http.js"]
