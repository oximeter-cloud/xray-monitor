FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source and static frontend
COPY src/ ./src/
COPY static/ ./static/
COPY tsconfig.json ./

# Persistent storage for SQLite database
VOLUME ["/app/data"]

ENV PORT=9922 \
    DATA_DIR=/app/data \
    NODE_ENV=production

EXPOSE 9922

CMD ["npx", "tsx", "src/index.ts"]
