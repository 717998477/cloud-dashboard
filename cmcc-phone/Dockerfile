FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8680
ENV DATA_DIR=/app/data

VOLUME ["/app/data"]
EXPOSE 8680

CMD ["node", "src/server.js"]
