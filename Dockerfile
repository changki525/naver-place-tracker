FROM mcr.microsoft.com/playwright:v1.42.0-jammy

# 공유 메모리 확대 (Chromium 안정성)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# /dev/shm 크기 부족 대응: --disable-dev-shm-usage 로 해결
CMD ["node", "server.js"]
