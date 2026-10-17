# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run license:check && npm run typecheck && npm test && npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json LICENSE README.md ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /workspace /data && chown -R node:node /workspace /data
ENV SOFIA_WORKSPACE=/workspace
ENV SOFIA_STATE_DIR=/data
ENV SOFIA_API_HOST=0.0.0.0
ENV SOFIA_API_PORT=3000
VOLUME ["/workspace", "/data"]
EXPOSE 3000
USER node
CMD ["node", "/app/dist/api/standalone.js"]
