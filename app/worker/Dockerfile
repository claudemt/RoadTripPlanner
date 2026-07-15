FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/app

COPY package.json package-lock.json ./
COPY video/package.json ./video/package.json
RUN npm ci

COPY . .

ENV NODE_ENV=production
ENV AMAP_BROWSER_PATH=/usr/bin/chromium
ENV ROUTE_RENDER_CONCURRENCY=2
ENV ROUTE_RENDER_CRF=20

CMD ["node", "worker/render-worker.js"]
