FROM node:22-slim AS base

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files first for layer caching
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Copy application code
COPY src ./src

# Create data directories and set ownership
RUN mkdir -p /data/videos /data/sessions && chown -R node:node /data /app

USER node

ENV NODE_ENV=production \
    PORT=4070 \
    DATA_DIR=/data \
    MAX_CACHE_GB=10 \
    MAX_CONCURRENT_DOWNLOADS=2 \
    HOST=0.0.0.0

EXPOSE 4070

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:4070/api/health || exit 1

CMD ["node", "src/server.js"]
