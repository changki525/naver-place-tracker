FROM mcr.microsoft.com/playwright:v1.42.0-jammy

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
