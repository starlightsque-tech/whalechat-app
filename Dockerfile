FROM node:20-alpine
ENV NODE_ENV=production WORKDIR=/app
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY market.js ./
COPY scripts ./scripts
COPY public ./public
RUN node scripts/prepare-assets.js
ENV PORT=8090 DATA_DIR=/data
RUN mkdir -p /data/backups
VOLUME ["/data"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8090/api/health || exit 1
CMD ["node", "server.js"]
